import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopRuntime, type AnalysisInput, type AnalysisResult, type DesktopRuntime, type ReviewSuggestion, type RuntimeOptions, type TeachingRecord } from '../../apps/desktop/runtime-coordinator.cjs';
import { createDesktopAnalysisClient } from '../../apps/desktop/analysis-client.cjs';
import { createProviderAnalysisClient } from '../../apps/desktop/provider-analysis.cjs';
import type { ObservationFrame, ScreenGeometry } from '../../apps/desktop/observation-policy.cjs';
import { syntheticDetection, syntheticFrame } from '../helpers/standalone-frame';

const runtimes: DesktopRuntime[] = [];

function responseIdentity(input: AnalysisInput) {
  return { observation_id: input.observationId, guide_id: input.guideId, observation_generation: input.observationGeneration,
    task_generation: input.taskGeneration, trigger_id: input.triggerId, frame_id: input.frame.frameId };
}

function stepResponse(input: AnalysisInput): AnalysisResult {
  return { ...responseIdentity(input), kind: 'step', instruction: '请亲手打开显示设置，再观察新页面。', target_id: input.frame.elements[1].id,
    presentation: 'uncertain_candidate', expected_labels: ['字体大小'] };
}

function clarificationIdentity(runtime: DesktopRuntime) {
  const state = runtime.snapshot();
  return { guideId: state.task.id!, taskGeneration: state.task.generation, observationGeneration: state.observation.generation };
}

describe('桌宠追问回答保留本人原目标', () => {
  async function clarificationSetup() {
    const setup = fixture();
    setup.analyze.mockImplementationOnce(async input => ({ ...responseIdentity(input), kind: 'clarify', instruction: '请确认要找哪个应用？' }));
    await beginTeaching(setup);
    return setup;
  }

  it('回答不新建目标或提前记录结束，重新检查画面后携带原问题与回答', async () => {
    const setup = await clarificationSetup();
    const identity = clarificationIdentity(setup.runtime);
    expect(setup.runtime.snapshot().task.awaitingReply).toBe(true);
    const captures = setup.source.capture.mock.calls.length;
    await setup.runtime.replyToClarification({ ...identity, text: '  微信，电脑左上方  ' });
    await setup.runtime.whenIdle();
    expect(setup.source.capture.mock.calls.length).toBeGreaterThan(captures);
    expect(setup.analyze.mock.calls[1][0]).toMatchObject({ guideId: identity.guideId, taskGeneration: identity.taskGeneration + 1,
      question: '请教我调整文字大小', reason: 'question', previousStep: null,
      clarificationReplies: [{ prompt: '请确认要找哪个应用？', answer: '微信，电脑左上方' }] });
    expect(setup.runtime.snapshot().task).toMatchObject({ id: identity.guideId, question: '请教我调整文字大小', awaitingReply: false, state: 'awaiting_action' });
    expect(setup.recordTeaching).not.toHaveBeenCalled();
    expect(setup.runtime.snapshot().captions.enabled).toBe(false);
    await expect(setup.runtime.replyToClarification({ ...identity, text: '迟到的旧回答' })).rejects.toThrow('追问已变化');
    expect(setup.analyze).toHaveBeenCalledTimes(2);
  });

  it('重新识别不伪造用户回答，也不丢失已有补充上下文', async () => {
    const setup = await clarificationSetup();
    setup.analyze.mockImplementation(async input => ({ ...responseIdentity(input), kind: 'clarify', instruction: '请核对当前授权范围。' }));
    await setup.runtime.replyToClarification({ ...clarificationIdentity(setup.runtime), text: '微信就在桌面左上角' });
    await setup.runtime.whenIdle();
    const before = setup.runtime.snapshot();
    await setup.runtime.rescanClarification(clarificationIdentity(setup.runtime));
    await setup.runtime.whenIdle();
    expect(setup.analyze.mock.lastCall![0]).toMatchObject({ guideId: before.task.id, question: before.task.question,
      clarificationReplies: [{ prompt: '请确认要找哪个应用？', answer: '微信就在桌面左上角' }] });
    expect(setup.runtime.snapshot().messages.filter(message => message.role === 'user')).toEqual(before.messages.filter(message => message.role === 'user'));
    expect(setup.recordTeaching).not.toHaveBeenCalled();
  });

  it('最多携带三组追问回答，新问题清空旧上下文', async () => {
    const setup = await clarificationSetup();
    setup.analyze.mockImplementation(async input => ({ ...responseIdentity(input), kind: 'clarify', instruction: '请核对当前授权范围。' }));
    for (const answer of ['第一组', '第二组', '第三组', '第四组']) {
      await setup.runtime.replyToClarification({ ...clarificationIdentity(setup.runtime), text: answer });
      await setup.runtime.whenIdle();
    }
    expect(setup.analyze.mock.lastCall![0].clarificationReplies?.map(reply => reply.answer)).toEqual(['第二组', '第三组', '第四组']);
    await setup.runtime.ask('新的目标，请找设置');
    await setup.runtime.whenIdle();
    expect(setup.analyze.mock.lastCall![0].clarificationReplies).toEqual([]);
  });

  it.each(['guide', 'task', 'observation', 'stopped', 'ended', 'unsupported'] as const)('旧追问、授权失效或不可回答状态不发起分析：%s', async condition => {
    const setup = await clarificationSetup();
    const identity = clarificationIdentity(setup.runtime);
    if (condition === 'guide') identity.guideId = 'not-current-guide';
    if (condition === 'task') identity.taskGeneration++;
    if (condition === 'observation') identity.observationGeneration++;
    if (condition === 'stopped') await setup.runtime.stopObservation();
    if (condition === 'ended') await setup.runtime.finishTeaching();
    if (condition === 'unsupported') {
      setup.analyze.mockImplementationOnce(async input => ({ ...responseIdentity(input), kind: 'unsupported', instruction: '当前不支持该功能。' }));
      await setup.runtime.rescanClarification(identity);
      await setup.runtime.whenIdle();
      Object.assign(identity, clarificationIdentity(setup.runtime));
    }
    const calls = setup.analyze.mock.calls.length;
    await expect(setup.runtime.replyToClarification({ ...identity, text: '微信' })).rejects.toThrow();
    await expect(setup.runtime.rescanClarification(identity)).rejects.toThrow();
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledTimes(calls);
  });

  it('空回答和超长回答不发送，敏感回答阻断教学且不进模型', async () => {
    const setup = await clarificationSetup();
    const identity = clarificationIdentity(setup.runtime);
    for (const text of ['', '   ', '字'.repeat(501)]) await expect(setup.runtime.replyToClarification({ ...identity, text })).rejects.toThrow('500');
    await setup.runtime.replyToClarification({ ...identity, text: '帮我输入验证码123456' });
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'ended', result: 'risk_blocked' });
  });

  it('等待回答时本地画面变化仍检查隐私，但不自动重复云端追问', async () => {
    const setup = fixture({ intervalMs: 15 });
    setup.analyze.mockImplementation(async input => ({ ...responseIdentity(input), kind: 'clarify', instruction: '请确认应用名称。' }));
    await beginTeaching(setup);
    const captures = setup.source.capture.mock.calls.length;
    setup.controls.labels = ['设置', '显示', '微信', '返回'];
    await vi.waitFor(() => expect(setup.source.detect.mock.calls.length).toBeGreaterThan(captures));
    expect(setup.runtime.snapshot().task.awaitingReply).toBe(true);
    expect(setup.analyze).toHaveBeenCalledOnce();
  });
});

function fixture(callbacks: Pick<RuntimeOptions, 'recordTeaching' | 'suggestReview' | 'intervalMs' | 'questioner' | 'analysisTimeoutMs' | 'onState' | 'resizeAnalysisImage'> = {}) {
  const controls = { time: Date.now(), labels: ['设置', '显示', '文本大小', '返回'], geometry: { x: -800, y: 0, width: 800, height: 600, scaleFactor: 1 } as ScreenGeometry | null, status: 'complete' as 'complete' | 'unavailable' };
  const source = {
    capture: vi.fn(async () => syntheticFrame(controls.geometry, ++controls.time)),
    detect: vi.fn<RuntimeOptions['source']['detect']>(async frame => ({ ...syntheticDetection(frame, controls.labels), status: controls.status })),
    stop: vi.fn(async () => undefined),
  };
  const analyze = vi.fn<(input: AnalysisInput) => Promise<AnalysisResult>>(async input => stepResponse(input));
  const onTarget = vi.fn();
  const records: TeachingRecord[] = [];
  const recordTeaching = vi.fn<(record: TeachingRecord) => unknown | Promise<unknown>>(record => { records.push(record); });
  const suggestReview = vi.fn<(proposal: ReviewSuggestion) => unknown | Promise<unknown>>();
  const runtime = createDesktopRuntime({ source, analyzer: { analyze }, onTarget, intervalMs: 60000,
    now: () => controls.time, recordTeaching, suggestReview, ...callbacks });
  runtimes.push(runtime);
  const start = async (cloudConsent = true) => {
    await runtime.startObservation({ actor: 'owner', confirmed: true, sourceId: 'screen:test:0', sourceName: '合成测试屏幕', cloudConsent });
    await runtime.whenIdle();
  };
  return { runtime, source, controls, analyze, onTarget, records, recordTeaching, suggestReview, start };
}

function completedResponse(input: AnalysisInput): AnalysisResult {
  return { ...responseIdentity(input), kind: 'completed', instruction: '新画面已显示字体大小设置。', evidence_labels: input.previousStep?.expectedLabels ?? ['字体大小'] };
}

function proposedReview(timestamp: number): NonNullable<AnalysisResult['review_proposal']> {
  return { remind_at: new Date(timestamp + 86400000).toISOString(), timezone: 'Asia/Shanghai', reason: '明天亲手复习字体调整。' };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function beginTeaching(setup: ReturnType<typeof fixture>) {
  await setup.start();
  await setup.runtime.ask('请教我调整文字大小');
  await setup.runtime.whenIdle();
}

describe('桌宠大字字幕由本人主动开启', () => {
  it('默认不显示大字，教学、重讲和后续问题不会重新开启', async () => {
    const setup = fixture();
    expect(setup.runtime.snapshot().captions).toEqual({ enabled: false, text: '' });
    expect(setup.source.capture).not.toHaveBeenCalled();
    await beginTeaching(setup);
    const instruction = setup.runtime.snapshot().task.instruction;
    expect(instruction).not.toBe('');
    expect(setup.runtime.snapshot().captions).toEqual({ enabled: false, text: instruction });
    setup.runtime.repeat();
    expect(setup.runtime.snapshot().captions.enabled).toBe(false);
    expect(setup.runtime.toggleCaptions().captions).toEqual({ enabled: true, text: instruction });
    expect(setup.runtime.toggleCaptions().captions.enabled).toBe(false);
    setup.runtime.repeat();
    await setup.runtime.ask('再教我打开显示设置');
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().captions.enabled).toBe(false);
    expect(setup.runtime.snapshot().task.instruction).not.toBe('');
  });
});

describe('屏幕分析结果的可见反馈', () => {
  it.each(['clarify', 'unsupported'] as const)('%s 返回后结束分析态并保留说明，不生成虚假箭头', async kind => {
    const setup = fixture();
    setup.analyze.mockImplementation(async input => ({ ...responseIdentity(input), kind,
      instruction: '当前画面没有可核验的朋友圈入口，请先亲手打开微信。' }));
    await beginTeaching(setup);
    expect(setup.runtime.snapshot()).toMatchObject({
      task: { state: 'needs_help', instruction: '', presentation: null, targetState: 'hidden',
        explanation: '当前画面没有可核验的朋友圈入口，请先亲手打开微信。' },
      analysis: { state: 'ready', message: expect.stringContaining('未定位') }, captions: { enabled: false },
    });
    expect(setup.onTarget.mock.calls.every(([target]) => target === null)).toBe(true);
    expect(setup.runtime.snapshot().messages.at(-1)?.text).toContain('亲手打开微信');
    expect(setup.records).toEqual([]);
  });

  it('模型误将无文字图标标为已确认时，运行时仍强制显示为待核对候选', async () => {
    const setup = fixture();
    setup.source.detect.mockImplementation(async frame => ({ ...syntheticDetection(frame, setup.controls.labels), visualControls: [
      { label: '未标注图标', surface: 'visual', rect: { x: 180, y: 100, width: 24, height: 24 }, appearance: 'c'.repeat(64) },
    ] }));
    setup.analyze.mockImplementationOnce(async input => {
      const target = input.frame.elements.find(element => element.surface === 'visual');
      if (!target) throw new Error('expected visual candidate');
      return { ...responseIdentity(input), kind: 'step', instruction: '请打开朋友圈。', target_id: target.id,
        presentation: 'confirmed', expected_labels: [] };
    });
    await setup.start();
    await setup.runtime.ask('请帮我找到微信朋友圈');
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task).toMatchObject({ presentation: 'uncertain_candidate', explanation: expect.stringContaining('候选'),
      instruction: '请先核对箭头处的图标候选是否为要找的入口，确认后再由本人操作。' });
    expect(setup.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, label: '未标注图标', presentation: 'uncertain_candidate' }));
  });

  it('已有步骤转为澄清时撤销旧箭头与候选标记', async () => {
    const setup = fixture();
    await beginTeaching(setup);
    setup.analyze.mockImplementationOnce(async input => ({ ...responseIdentity(input), kind: 'clarify', instruction: '请先确认需要查找的功能。' }));
    setup.controls.labels.push('帮助');
    await setup.runtime.verify();
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot()).toMatchObject({ task: { state: 'needs_help', presentation: null, targetState: 'hidden', instruction: '' }, analysis: { state: 'ready' } });
    expect(setup.onTarget).toHaveBeenLastCalledWith(null);
  });

  it('箭头保持到当前安全帧失效，不再在两秒半后提前消失', async () => {
    vi.useFakeTimers();
    const setup = fixture();
    await beginTeaching(setup);
    const target = setup.onTarget.mock.calls.at(-1)?.[0];
    expect(target.expiresAt - setup.controls.time).toBe(5000);
    expect(setup.runtime.snapshot().task.targetState).toBe('visible');
    setup.controls.time += 3500;
    await vi.advanceTimersByTimeAsync(3500);
    expect(setup.onTarget).toHaveBeenLastCalledWith(target);
    setup.controls.time += 1501;
    await vi.advanceTimersByTimeAsync(1501);
    expect(setup.onTarget).toHaveBeenLastCalledWith(null);
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'stale' });
    expect(setup.analyze).toHaveBeenCalledOnce();
  });

  it('同一页面的新本地安全帧续期箭头，过期后可恢复而不再次上云', async () => {
    vi.useFakeTimers();
    const setup = fixture({ intervalMs: 6000 });
    await beginTeaching(setup);
    await advanceObservation(setup, 5001);
    expect(setup.runtime.snapshot().task.targetState).toBe('stale');
    await advanceObservation(setup, 999);
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task.targetState).toBe('visible');
    expect(setup.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, expiresAt: setup.controls.time + 5000 }));
    expect(setup.analyze).toHaveBeenCalledOnce();
  });

  it('首次指引分析期间不等待轮询间隔，尽早取得新鲜本地画面以缩短续显空档', async () => {
    vi.useFakeTimers();
    const setup = fixture({ intervalMs: 1500 });
    await setup.start();
    const originalCapture = setup.source.capture.getMockImplementation()!;
    let delayNextCapture = true;
    setup.source.capture.mockImplementation(async (...argumentsList) => {
      const frame = await originalCapture(...argumentsList);
      if (delayNextCapture) {
        delayNextCapture = false;
        setup.controls.time += 2000;
      }
      return frame;
    });
    const response = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => response.promise);

    await setup.runtime.ask('帮我找到显示设置');
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(0);

    expect(setup.source.capture).toHaveBeenCalledTimes(3);
    await setup.runtime.stopObservation('user');
  });

  it('回复落在两次捕获间隙且画面过期时立即重采集核验，不上传第二次也不丢弃箭头', async () => {
    const setup = fixture();
    await setup.start();
    const response = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => response.promise);
    await setup.runtime.ask('帮我找到显示设置');
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
    const input = setup.analyze.mock.calls[0][0];
    setup.controls.time += 5001;
    response.resolve(stepResponse(input));
    await setup.runtime.whenIdle();
    expect(setup.source.capture).toHaveBeenCalledTimes(3);
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    expect(setup.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, label: '显示' }));
  });

  it('回复等待新帧时保留授权共享，不因敏感文字停止，并在新安全帧核验后绘制箭头', async () => {
    const setup = fixture();
    await setup.start();
    const response = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => response.promise);
    setup.analyze.mockImplementation(async input => ({ ...responseIdentity(input), kind: 'unsupported', instruction: '当前新画面没有可核验的目标，请重新提问。' }));
    await setup.runtime.ask('帮我找到显示设置');
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
    const input = setup.analyze.mock.calls[0][0];
    setup.controls.time += 5001;
    setup.controls.labels.push('私人聊天');
    response.resolve(stepResponse(input));
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'observing', captureActive: true, reason: 'authorized_sharing' });
    expect(setup.onTarget.mock.calls.some(([target]) => target?.visible)).toBe(true);
    expect(input.signal.aborted).toBe(false);
    // 新安全帧到达后本地按标签+4px 重新核验目标，不再第二次上云。
    expect(setup.analyze).toHaveBeenCalledTimes(1);
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
  });

  it('指引窗口拒绝显示时明确告知，而不是宣称已有箭头', async () => {
    const setup = fixture();
    setup.onTarget.mockImplementation(target => target ? false : undefined);
    await beginTeaching(setup);
    expect(setup.runtime.snapshot()).toMatchObject({
      task: { state: 'awaiting_action', targetState: 'unavailable', explanation: expect.stringContaining('指引窗口') },
      analysis: { state: 'ready', message: expect.stringContaining('未显示箭头') },
    });
    expect(setup.onTarget).toHaveBeenLastCalledWith(null);
  });

  it('指引窗口恢复后移除旧故障说明，仍只核验本地画面', async () => {
    const setup = fixture();
    setup.onTarget.mockImplementation(target => target ? false : undefined);
    await beginTeaching(setup);
    setup.onTarget.mockImplementation(() => undefined);
    await setup.runtime.verify();
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task).toMatchObject({ targetState: 'visible', explanation: expect.stringContaining('请先核对') });
    expect(setup.runtime.snapshot().task.explanation).not.toContain('指引窗口');
    expect(setup.analyze).toHaveBeenCalledOnce();
  });
});

describe('分析返回与本地检测重叠时的安全续接', () => {
  async function pendingRefresh(transport: 'provider' | 'service' | 'custom', analysisTimeoutMs = 15000) {
    const setup = fixture({ intervalMs: 1500, analysisTimeoutMs });
    await setup.start();
    const response = deferred<void>();
    const sent = vi.fn();
    setup.analyze.mockImplementationOnce(async input => {
      if (transport === 'custom') {
        sent();
        await response.promise;
        return stepResponse(input);
      }
      if (transport === 'provider') return createProviderAnalysisClient({ now: () => setup.controls.time, provider: {
        answer: async () => {
          sent();
          await response.promise;
          return { text: JSON.stringify({ kind: 'step', instruction: '请亲手打开显示设置。', target_id: input.frame.elements[1].id,
            presentation: 'confirmed', expected_labels: ['字体大小'] }) };
        },
      } }).analyze(input);
      return createDesktopAnalysisClient({
        env: { NUANBAN_DESKTOP_API_BASE_URL: 'http://127.0.0.1:3000', NUANBAN_DESKTOP_API_TOKEN: 'synthetic-account-token' },
        now: () => setup.controls.time,
        fetch: async () => { sent(); await response.promise; return new Response(JSON.stringify(stepResponse(input))); },
      }).analyze(input);
    });
    await setup.runtime.ask('帮我找到显示设置');
    await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
    const detection = deferred<ReturnType<typeof syntheticDetection>>();
    let refreshingFrame!: ObservationFrame;
    setup.source.detect.mockImplementationOnce(frame => { refreshingFrame = frame; return detection.promise; });
    await advanceObservation(setup, 1500);
    await advanceObservation(setup, 4000);
    expect(setup.analyze.mock.calls[0][0].canSend()).toBe(false);
    response.resolve();
    await vi.waitFor(() => expect(setup.runtime.snapshot().analysis.message).toContain('等待当前本地画面'));
    expect(setup.onTarget.mock.calls.some(([target]) => target?.visible)).toBe(false);
    return { ...setup, sent, refreshingFrame, detection };
  }

  it.each(['provider', 'service', 'custom'] as const)('新安全帧正在检测时等待核验，不重复上传或丢弃有效结果：%s', async transport => {
    vi.useFakeTimers();
    const setup = await pendingRefresh(transport);
    setup.detection.resolve(syntheticDetection(setup.refreshingFrame, setup.controls.labels));
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    expect(setup.runtime.snapshot().analysis.state).toBe('ready');
    expect(setup.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, label: '显示' }));
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.sent).toHaveBeenCalledOnce();
    expect(setup.source.capture.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it.each(['sensitive', 'stale', 'context', 'timeout', 'stop'] as const)('等待中的回复不能绕过安全、时效、上下文或取消：%s', async condition => {
    vi.useFakeTimers();
    const setup = await pendingRefresh('provider', condition === 'timeout' ? 6000 : 15000);
    if (condition === 'stop') await setup.runtime.stopObservation();
    if (condition === 'timeout') await advanceObservation(setup, 10000);
    if (condition === 'stale') {
      setup.controls.time += 1500;
      setup.source.capture.mockImplementation(async () => syntheticFrame(setup.controls.geometry, setup.controls.time - 6000));
    }
    if (condition === 'context') {
      setup.refreshingFrame.displayId = 'other-display';
      setup.analyze.mockImplementation(async input => ({ ...responseIdentity(input), kind: 'clarify', instruction: '请在新范围重新提问。' }));
    }
    setup.detection.resolve(syntheticDetection(setup.refreshingFrame,
      condition === 'sensitive' ? [...setup.controls.labels, '验证码123456'] : setup.controls.labels));
    await setup.runtime.whenIdle();
    if (condition === 'sensitive') {
      expect(setup.onTarget.mock.calls.some(([target]) => target?.visible)).toBe(true);
      expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    } else {
      expect(setup.onTarget.mock.calls.some(([target]) => target?.visible)).toBe(false);
      expect(setup.runtime.snapshot().task.state).not.toBe('awaiting_action');
    }
    expect(setup.records).toEqual(condition === 'stop' ? [expect.objectContaining({ result: 'interrupted' })] : []);
    expect(setup.sent).toHaveBeenCalledOnce();
  });

  it.each([
    ['OUTBOUND_CLOSED', '画面已过期'], ['INVALID_ANALYSIS_RESPONSE', '格式或目标'],
    ['ANALYSIS_AUTH_FAILED', '认证或权限'], ['ANALYSIS_RATE_LIMITED', '限流'],
    ['ANALYSIS_TIMEOUT', '超时'], ['ANALYSIS_RESPONSE_INCOMPLETE', '未完整返回'],
    ['ANALYSIS_UNAVAILABLE', '暂时不可用'], ['constructor', '未获得可核验的结果'],
  ])('分析失败说明恢复途径，但不暴露原始错误或自动重试：%s', async (code, expected) => {
    const setup = fixture();
    await setup.start();
    setup.analyze.mockRejectedValueOnce(Object.assign(new Error('private-provider-body'), { code }));
    await setup.runtime.ask('帮我找到设置');
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().analysis).toMatchObject({ state: 'error', message: expect.stringContaining(expected) });
    expect(JSON.stringify(setup.runtime.snapshot())).not.toContain('private-provider-body');
    expect(setup.runtime.snapshot().task.state).toBe('needs_help');
    expect(setup.onTarget).toHaveBeenLastCalledWith(null);
    expect(setup.analyze).toHaveBeenCalledOnce();
  });
});

describe('当前观察范围的单独画面分析授权', () => {
  it('无需重启采集；同意不自动发送旧问题，新的查找才分析', async () => {
    const setup = fixture();
    await setup.start(false);
    await setup.runtime.ask('旧问题不能在补授权后自动重发');
    await setup.runtime.whenIdle();
    const observation = setup.runtime.snapshot().observation;
    const captures = setup.source.capture.mock.calls.length;
    await setup.runtime.authorizeCloudAnalysis({ actor: 'owner', confirmed: true, observationGeneration: observation.generation });
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().observation).toMatchObject({ ...observation, cloudConsent: true });
    expect(setup.runtime.snapshot().task.state).toBe('ended');
    expect(setup.source.capture).toHaveBeenCalledTimes(captures);
    expect(setup.source.stop).not.toHaveBeenCalled();
    expect(setup.analyze).not.toHaveBeenCalled();
    await setup.runtime.ask('请教我调整文字大小', observation.generation);
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.runtime.snapshot().task.state).toBe('awaiting_action');
  });

  it('结束旧问题期间又有新问题时，不能把待确认授权自动用于新问题', async () => {
    const setup = fixture();
    await setup.start(false);
    await setup.runtime.ask('旧的本地问题');
    await setup.runtime.whenIdle();
    const saved = deferred<void>();
    setup.recordTeaching.mockImplementationOnce(() => saved.promise);
    const granting = setup.runtime.authorizeCloudAnalysis({ actor: 'owner', confirmed: true, observationGeneration: setup.runtime.snapshot().observation.generation });
    const rejected = expect(granting).rejects.toThrow('问题已变化');
    let asking: ReturnType<DesktopRuntime['ask']> | undefined;
    try {
      await vi.waitFor(() => expect(setup.recordTeaching).toHaveBeenCalledOnce());
      asking = setup.runtime.ask('授权边界上的新本地问题');
    } finally { saved.resolve(); }
    await rejected;
    await asking;
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().observation.cloudConsent).toBe(false);
    expect(setup.analyze).not.toHaveBeenCalled();
  });

  it('没有本人确认、旧代次、停止和隐私暂停都不能授予画面分析权限', async () => {
    const setup = fixture();
    await setup.start(false);
    const generation = setup.runtime.snapshot().observation.generation;
    for (const input of [
      { actor: 'assistant', confirmed: true, observationGeneration: generation },
      { actor: 'owner', confirmed: false, observationGeneration: generation },
      { actor: 'owner', confirmed: true, observationGeneration: generation + 1 },
      { actor: 'owner', confirmed: true, observationGeneration: 0 },
    ]) await expect(setup.runtime.authorizeCloudAnalysis(input)).rejects.toThrow('未获本人确认');
    await setup.runtime.stopObservation();
    await expect(setup.runtime.authorizeCloudAnalysis({ actor: 'owner', confirmed: true, observationGeneration: generation })).rejects.toThrow('已变化');
    setup.controls.labels = ['未知正文', '未知控件'];
    await setup.start(false);
    const unknownGeneration = setup.runtime.snapshot().observation.generation;
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'observing', captureActive: true, reason: 'authorized_sharing', cloudConsent: false });
    await expect(setup.runtime.authorizeCloudAnalysis({ actor: 'owner', confirmed: true, observationGeneration: unknownGeneration })).resolves.toBeDefined();
    expect(setup.runtime.snapshot().observation.cloudConsent).toBe(true);
    expect(setup.analyze).not.toHaveBeenCalled();
  });
});

describe('观察与教学快照的独立代次', () => {
  it('屏幕语音查找必须绑定当前观察代次和单独画面授权，失效时不回退成文字问答', async () => {
    const setup = fixture();
    await setup.start(false);
    const generation = setup.runtime.snapshot().observation.generation;
    expect(setup.runtime.snapshot().observation.cloudConsent).toBe(false);
    await expect(setup.runtime.ask('帮我找到设置', generation)).rejects.toThrow('画面授权已失效');
    expect(setup.analyze).not.toHaveBeenCalled();
    expect(setup.records).toEqual([]);
    await setup.runtime.stopObservation('user');
    await expect(setup.runtime.ask('帮我找到设置', generation)).rejects.toThrow('画面授权已失效');
    expect(setup.runtime.snapshot().observation.cloudConsent).toBe(false);
  });

  it('有效语音查找代次进入同一屏幕分析与目标高亮链路', async () => {
    const setup = fixture();
    await setup.start(true);
    const generation = setup.runtime.snapshot().observation.generation;
    expect(setup.runtime.snapshot().observation.cloudConsent).toBe(true);
    await setup.runtime.ask('帮我找到设置', generation);
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.analyze.mock.calls[0][0]).toMatchObject({ question: '帮我找到设置', reason: 'question' });
    expect(setup.runtime.snapshot().task.state).toBe('awaiting_action');
    expect(setup.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, label: '显示' }));
  });

  it('未授权云分析时仍持续本地共享，敏感文字不再停止且不出云', async () => {
    vi.useFakeTimers();
    const setup = fixture({ intervalMs: 1500 });
    setup.controls.labels = ['文件', '编辑', '查看', '练习文档', '普通正文', '第二行内容'];
    await setup.start(false);
    for (let count = 0; count < 4; count += 1) {
      await vi.advanceTimersByTimeAsync(1600);
      await setup.runtime.whenIdle();
      expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'observing', captureActive: true, reason: 'authorized_sharing' });
    }
    expect(setup.source.stop).not.toHaveBeenCalled();
    expect(setup.analyze).not.toHaveBeenCalled();
    setup.controls.labels = ['文件', '编辑', '查看', '私人聊天'];
    await vi.advanceTimersByTimeAsync(1600);
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'observing', captureActive: true, reason: 'authorized_sharing' });
    expect(setup.analyze).not.toHaveBeenCalled();
  });

  it('本人授权后的教学接收完整脱敏帧，不接收原始屏幕', async () => {
    const setup = fixture();
    setup.controls.labels = ['文件', '编辑', '查看', '练习文档', '普通正文', '第二行内容'];
    await setup.start();
    await setup.runtime.ask('教我使用查看菜单');
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledTimes(1);
    const input = setup.analyze.mock.calls[0][0];
    expect(input.frame.scene).toBe('authorized_sharing');
    expect(input.frame.elements.map(element => element.label)).toEqual(['文件', '编辑', '查看']);
    expect(input.frame.sanitizedPng).not.toEqual(syntheticFrame().png);
    expect(setup.runtime.snapshot().observation.state).toBe('observing');
  });

  it('普通桌面与未知页面持续观察，手动停止后不自动恢复', async () => {
    vi.useFakeTimers();
    const setup = fixture({ intervalMs: 1500 });
    setup.controls.labels = ['此电脑', '回收站', '控制面板', '练习.txt'];
    await setup.start(false);
    for (let count = 0; count < 4; count += 1) {
      await vi.advanceTimersByTimeAsync(1600);
      await setup.runtime.whenIdle();
      expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'observing', captureActive: true });
    }
    setup.controls.labels = ['文件资源管理器', '此电脑', '名称', '修改日期', '类型', '大小', '练习.txt'];
    await vi.advanceTimersByTimeAsync(1600);
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().observation.state).toBe('observing');
    setup.controls.labels = ['未知页面内容', '另一段未经分类的正文'];
    await vi.advanceTimersByTimeAsync(1600);
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'observing', captureActive: true, reason: 'authorized_sharing' });
    const captures = setup.source.capture.mock.calls.length;
    setup.controls.labels = ['设置', '显示', '文本大小', '返回'];
    await setup.runtime.stopObservation('user');
    await vi.advanceTimersByTimeAsync(6000);
    expect(setup.source.capture).toHaveBeenCalledTimes(captures);
    expect(setup.analyze).not.toHaveBeenCalled();
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'stopped', captureActive: false });
  });

  it('每一帧都绑定本人所选区域，不引用可变参数，重新整屏授权后才清除裁剪', async () => {
    const setup = fixture();
    const region = { x: 20, y: 30, width: 320, height: 200 };
    await setup.runtime.startObservation({ actor: 'owner', confirmed: true, sourceId: 'screen:test:0', region });
    region.width = 700;
    await setup.runtime.whenIdle();
    expect(setup.source.capture).toHaveBeenCalledWith(expect.objectContaining({ region: { x: 20, y: 30, width: 320, height: 200 } }));
    await setup.runtime.stopObservation('user');
    setup.source.capture.mockClear();
    await setup.start(false);
    expect(setup.source.capture).toHaveBeenCalledWith({ sourceId: 'screen:test:0', signal: expect.any(AbortSignal) });
  });

  it('多次提问保持正确观察关联，先问后授权会关联新观察而不复用任务计数', async () => {
    const setup = fixture();
    await setup.runtime.ask('请教我调整文字大小');
    await setup.start();
    expect(setup.runtime.snapshot().task.observationGeneration).toBe(setup.runtime.snapshot().observation.generation);
    await setup.runtime.finishTeaching();
    await setup.runtime.ask('请教我找到显示设置');
    await setup.runtime.whenIdle();
    const current = setup.runtime.snapshot();
    expect(current.task.generation).not.toBe(current.observation.generation);
    expect(current.task.observationGeneration).toBe(current.observation.generation);
    expect(current.task.state).toBe('awaiting_action');
  });

  it('桌宠未共享屏幕时使用真实文字模型，不调用屏幕采集或演示回答', async () => {
    const questioner = { answer: vi.fn(async (_input: { question: string; signal: AbortSignal; instructions?: string }) => ({ text: '可以先打开系统设置，再根据当前页面选择显示相关选项。' })) };
    const setup = fixture({ questioner });
    await setup.runtime.ask('如何调整文字大小');
    const current = setup.runtime.snapshot();
    expect(questioner.answer).toHaveBeenCalledOnce();
    expect(questioner.answer.mock.calls[0][0].instructions).toContain('没有提供当前屏幕画面');
    expect(current.task.state).toBe('ended');
    expect(current.task.explanation).toContain('系统设置');
    expect(current.messages.at(-1)).toMatchObject({ role: 'assistant', text: expect.stringContaining('系统设置') });
    expect(setup.source.capture).not.toHaveBeenCalled();
    expect(setup.analyze).not.toHaveBeenCalled();
  });

  it('停止桌宠文字提问会使迟到模型回答失效，且不记录为已完成教学', async () => {
    const response = deferred<{ text: string }>();
    const questioner = { answer: vi.fn(async (_input: { question: string; signal: AbortSignal; instructions?: string }) => response.promise) };
    const setup = fixture({ questioner });
    const asking = setup.runtime.ask('如何调整文字大小');
    await vi.waitFor(() => expect(questioner.answer).toHaveBeenCalledOnce());
    const stopped = setup.runtime.stopObservation('user');
    await stopped;
    response.resolve({ text: '这是一条迟到的回答，不应显示。' });
    await asking;
    await setup.runtime.whenIdle();
    expect(questioner.answer.mock.calls[0][0].signal.aborted).toBe(true);
    expect(setup.runtime.snapshot().task.result).toBe('cancelled');
    expect(setup.runtime.snapshot().messages.at(-1)?.text).not.toContain('迟到的回答');
    expect(setup.records).toEqual([]);
  });
});

async function verifyChanged(setup: ReturnType<typeof fixture>) {
  setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
  await setup.runtime.verify();
  await setup.runtime.whenIdle();
}

async function advanceObservation(setup: ReturnType<typeof fixture>, duration: number) {
  let elapsed = 0;
  while (elapsed < duration) {
    const interval = Math.min(1500, duration - elapsed);
    setup.controls.time += interval;
    await vi.advanceTimersByTimeAsync(interval);
    elapsed += interval;
  }
}

async function beginSlowAnalysis(setup: ReturnType<typeof fixture>, kind: 'step' | 'completed' = 'completed') {
  if (kind === 'completed') await beginTeaching(setup);
  else await setup.start();
  const response = deferred<Response>();
  const fetchRequest = vi.fn<typeof fetch>(() => response.promise);
  const client = createDesktopAnalysisClient({
    env: { NUANBAN_DESKTOP_API_BASE_URL: 'http://127.0.0.1:3000', NUANBAN_DESKTOP_API_TOKEN: 'synthetic-account-token' },
    now: () => setup.controls.time, fetch: fetchRequest,
  });
  setup.analyze.mockImplementationOnce(input => client.analyze(input));
  if (kind === 'completed') {
    setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
    await setup.runtime.verify();
  } else await setup.runtime.ask('请教我调整文字大小');
  await vi.waitFor(() => expect(fetchRequest).toHaveBeenCalledOnce());
  const request = setup.analyze.mock.calls.at(-1)![0];
  const complete = () => response.resolve(new Response(JSON.stringify(kind === 'step' ? stepResponse(request)
    : { ...completedResponse(request), review_proposal: proposedReview(setup.controls.time) })));
  return { request, fetchRequest, complete };
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  vi.useRealTimers();
});

describe('驻留运行核心（合成端口单测，不替代原生/供应验收）', () => {
  it('默认屏幕分析保留模型完整时限及安全收尾时间，并拒绝超时后的迟到结果', async () => {
    vi.useFakeTimers();
    const setup = fixture();
    const response = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => response.promise);
    await setup.start();
    await setup.runtime.ask('帮我找到设置', setup.runtime.snapshot().observation.generation);
    await vi.advanceTimersByTimeAsync(0);
    expect(setup.analyze).toHaveBeenCalledOnce();
    const input = setup.analyze.mock.calls[0][0];

    await vi.advanceTimersByTimeAsync(45000);
    expect(input.signal.aborted).toBe(false);
    expect(setup.runtime.snapshot().task.state).toBe('analyzing');
    await vi.advanceTimersByTimeAsync(4999);
    expect(input.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await setup.runtime.whenIdle();
    expect(input.signal.aborted).toBe(true);
    expect(setup.runtime.snapshot()).toMatchObject({ task: { state: 'needs_help' }, analysis: { state: 'error', message: expect.stringContaining('超时') } });
    response.resolve(stepResponse(input));
    await vi.advanceTimersByTimeAsync(0);
    expect(setup.runtime.snapshot().task.state).toBe('needs_help');
    expect(setup.onTarget.mock.calls.every(([target]) => target === null)).toBe(true);
    expect(setup.analyze).toHaveBeenCalledOnce();
  });

  it.each([16000, 30000, 44000])('直接模型慢响应 %i 毫秒后仍通过新鲜安全帧显示指引，且不重复请求', async delay => {
    vi.useFakeTimers();
    const setup = fixture({ intervalMs: 1500 });
    const response = deferred<{ text: string }>();
    const answer = vi.fn(() => response.promise);
    const analyzer = createProviderAnalysisClient({ provider: { answer }, now: () => setup.controls.time });
    setup.analyze.mockImplementationOnce(input => analyzer.analyze(input));
    await setup.start();
    await setup.runtime.ask('帮我找到显示设置');
    await vi.waitFor(() => expect(answer).toHaveBeenCalledOnce());
    const input = setup.analyze.mock.calls[0][0];

    await advanceObservation(setup, delay);
    expect(input.signal.aborted).toBe(false);
    expect(input.canSend()).toBe(true);
    expect(setup.controls.time - input.frame.capturedAt).toBeGreaterThan(15000);
    response.resolve({ text: JSON.stringify({ kind: 'step', instruction: '请亲手打开显示设置。', target_id: input.frame.elements[1].id,
      presentation: 'confirmed', expected_labels: ['字体大小'] }) });
    await setup.runtime.whenIdle();

    expect(setup.runtime.snapshot()).toMatchObject({ task: { state: 'awaiting_action' }, analysis: { state: 'ready' } });
    expect(setup.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({ expiresAt: expect.any(Number) }));
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(answer).toHaveBeenCalledOnce();
    expect(setup.records).toEqual([]);
  });

  it('挂起的屏幕分析超时会解除忙碌状态、关闭发送资格，并丢弃迟到结果', async () => {
    vi.useFakeTimers();
    const setup = fixture({ analysisTimeoutMs: 100 });
    const response = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => response.promise);
    await setup.start();
    await setup.runtime.ask('帮我找到设置', setup.runtime.snapshot().observation.generation);
    await vi.advanceTimersByTimeAsync(0);
    expect(setup.analyze).toHaveBeenCalledOnce();
    const input = setup.analyze.mock.calls[0][0];
    expect(setup.runtime.snapshot().task.state).toBe('analyzing');
    await vi.advanceTimersByTimeAsync(100);
    await setup.runtime.whenIdle();
    expect(input.signal.aborted).toBe(true);
    expect(input.canSend()).toBe(false);
    expect(setup.runtime.snapshot()).toMatchObject({ task: { state: 'needs_help' }, analysis: { state: 'error', message: expect.stringContaining('超时') } });
    response.resolve(stepResponse(input));
    await vi.advanceTimersByTimeAsync(0);
    expect(setup.runtime.snapshot().task.state).toBe('needs_help');
    expect(setup.onTarget.mock.calls.every(([target]) => target === null)).toBe(true);
    expect(setup.analyze).toHaveBeenCalledOnce();
    await setup.runtime.ask('请重新查找设置', setup.runtime.snapshot().observation.generation);
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task.state).toBe('awaiting_action');
    expect(setup.analyze).toHaveBeenCalledTimes(2);
  });

  it('结束教学不用等待忽略取消的分析器，之后的新问题可以正常分析', async () => {
    const setup = fixture();
    const response = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => response.promise);
    await setup.start();
    await setup.runtime.ask('帮我找到设置');
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
    const input = setup.analyze.mock.calls[0][0];
    await setup.runtime.finishTeaching();
    await setup.runtime.whenIdle();
    expect(input.signal.aborted).toBe(true);
    expect(setup.runtime.snapshot().task.state).toBe('ended');
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'observing', captureActive: true });
    await setup.runtime.ask('请重新查找设置');
    await setup.runtime.whenIdle();
    const current = setup.runtime.snapshot();
    response.resolve(stepResponse(input));
    await Promise.resolve();
    expect(setup.runtime.snapshot()).toEqual(current);
    expect(current.task.state).toBe('awaiting_action');
    expect(setup.analyze).toHaveBeenCalledTimes(2);
  });

  it('默认不观察，不因创建桌宠或恢复管理页面而采集', () => {
    const setup = fixture();
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'off', captureActive: false });
    expect(setup.source.capture).not.toHaveBeenCalled();
    expect(setup.analyze).not.toHaveBeenCalled();
  });

  it('只有本人新动作与明确同意可以开启，家属和云端不能代开', async () => {
    const setup = fixture();
    await expect(setup.runtime.startObservation({ actor: 'family', confirmed: true, sourceId: 'screen:test:0' })).rejects.toThrow('本人');
    await expect(setup.runtime.startObservation({ actor: 'owner', confirmed: false, sourceId: 'screen:test:0' })).rejects.toThrow('本人');
    expect(setup.source.capture).not.toHaveBeenCalled();
  });

  it('持续本地观察不等于持续上传；未同意云分析也不上传', async () => {
    const setup = fixture();
    await setup.start(false);
    expect(setup.source.detect).toHaveBeenCalledOnce();
    expect(setup.analyze).not.toHaveBeenCalled();
    await setup.runtime.ask('请教我调整文字大小');
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().observation.state).toBe('observing');
    expect(setup.runtime.snapshot().analysis.state).toBe('unavailable');
    expect(setup.analyze).not.toHaveBeenCalled();
  });

  it('同一教学结束只记录一次，观察仍在，不以结束教学冒充停止采集', async () => {
    const setup = fixture();
    await setup.start();
    await setup.runtime.ask('请教我调整文字大小');
    await setup.runtime.whenIdle();
    const guideId = setup.runtime.snapshot().task.id;
    await setup.runtime.finishTeaching();
    await setup.runtime.finishTeaching();
    expect(setup.records).toHaveLength(1);
    expect(setup.records[0]).toMatchObject({ sourceGuideId: guideId, mastery: 'unmastered', result: 'unfinished' });
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'observing', captureActive: true });
    expect(setup.source.stop).not.toHaveBeenCalled();
  });

  it('我点好了只重新采集核验；新画面未变化时不推进', async () => {
    const setup = fixture();
    await setup.start();
    await setup.runtime.ask('请教我调整文字大小');
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task.state).toBe('awaiting_action');
    const captures = setup.source.capture.mock.calls.length;
    await setup.runtime.verify();
    await setup.runtime.whenIdle();
    expect(setup.source.capture.mock.calls.length).toBe(captures + 1);
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.runtime.snapshot().task.state).toBe('awaiting_action');
    expect(setup.runtime.snapshot().analysis.message).toContain('不会因为');
  });

  it('预期新标签、当前帧和新核验齐全时才确认完成，并记录笔记', async () => {
    const setup = fixture();
    setup.analyze.mockImplementation(async input => input.previousStep
      ? { ...responseIdentity(input), kind: 'completed', instruction: '新画面已显示字体大小设置。', evidence_labels: ['字体大小'] }
      : stepResponse(input));
    await setup.start();
    await setup.runtime.ask('请教我调整文字大小');
    await setup.runtime.whenIdle();
    setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
    await setup.runtime.verify();
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledTimes(2);
    expect(setup.runtime.snapshot().task.state).toBe('completed');
    expect(setup.records).toHaveLength(1);
    expect(setup.records[0]).toMatchObject({ result: 'completed', mastery: 'unmastered' });
    expect(setup.runtime.snapshot().observation.state).toBe('observing');
  });

  it('模型自称完成但缺预期证据时拒绝，不创建完成记录', async () => {
    const setup = fixture();
    setup.analyze.mockImplementation(async input => ({ ...responseIdentity(input), kind: 'completed', instruction: '已经完成。', evidence_labels: ['显示'] }));
    await setup.start();
    await setup.runtime.ask('请教我调整文字大小');
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task.state).toBe('needs_help');
    expect(setup.records).toHaveLength(0);
    expect(setup.onTarget.mock.calls.every(([target]) => target === null)).toBe(true);
  });

  it('只画当前可定位控件，负屏幕坐标保持正确，不生成输入注入', async () => {
    const setup = fixture();
    await setup.start();
    await setup.runtime.ask('请教我调整文字大小');
    await setup.runtime.whenIdle();
    expect(setup.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({ rect: { x: -780, y: 60, width: 100, height: 30 }, presentation: 'uncertain_candidate' }));
    setup.analyze.mockImplementation(async input => ({ ...stepResponse(input), target_id: 'imagined_button' }));
    await setup.runtime.ask('再教我设置字体');
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task.state).toBe('needs_help');
    expect(setup.onTarget).toHaveBeenLastCalledWith(null);
  });

  it('没有可证明的源坐标时只解释，不把捕获像素猜成桌面坐标', async () => {
    const setup = fixture();
    setup.controls.geometry = null;
    await setup.start();
    await setup.runtime.ask('请教我调整文字大小');
    await setup.runtime.whenIdle();
    expect(setup.onTarget.mock.calls.every(([target]) => target === null)).toBe(true);
    expect(setup.runtime.snapshot().task.explanation).toContain('坐标未验证');
  });

  it.each(['capture_dimensions_unproven', 'capture_permission_denied', 'capture_track_ended', 'timeout'])('采集错误 %s 保留具体代码和恢复提示，不回显异常正文', async code => {
    const setup = fixture();
    setup.source.capture.mockRejectedValueOnce(Object.assign(new Error('private-screen-content'), { code }));
    await setup.start();
    const current = setup.runtime.snapshot();
    expect(current.observation).toMatchObject({ state: 'privacy_paused', captureActive: false, reason: code });
    expect(current.analysis).toMatchObject({ state: 'error', message: expect.stringMatching(/停止观察|观察已停止/) });
    expect(JSON.stringify(current)).not.toContain('private-screen-content');
    expect(setup.analyze).not.toHaveBeenCalled();
    expect(setup.source.capture).toHaveBeenCalledOnce();
  });

  it.each([
    ['no_readable_text', '没有识别到文字'],
    ['local_detection_limit', '框选目标软件'],
    ['invalid_or_stale_frame', '完整性校验失败'],
    ['helper_timeout', '检测超时'],
    ['incomplete_local_detection', '没有完整完成'],
  ])('本地检测暂停 %s 给出具体原因和操作提示，不自动重试或出云', async (code, detail) => {
    const setup = fixture();
    setup.source.detect.mockImplementationOnce(async frame => ({ ...syntheticDetection(frame), status: 'unavailable', reason: code }));
    await setup.start();
    const current = setup.runtime.snapshot();
    expect(current.observation).toMatchObject({ state: 'privacy_paused', captureActive: false, reason: code });
    expect(current.analysis.message).toContain(detail);
    expect(current.analysis.message).toContain(`（${code}）`);
    expect(setup.source.capture).toHaveBeenCalledOnce();
    expect(setup.source.stop).toHaveBeenCalledOnce();
    expect(setup.analyze).not.toHaveBeenCalled();
  });

  it('过期帧在同一授权会话内自动重采集，成功后继续调用模型而不暂停共享', async () => {
    const setup = fixture();
    await setup.start();
    const observation = setup.runtime.snapshot().observation;
    let expiredFrame!: ObservationFrame;
    setup.source.detect.mockImplementationOnce(async frame => {
      expiredFrame = frame;
      const detection = syntheticDetection(frame, setup.controls.labels);
      setup.controls.time += 6000;
      return detection;
    });
    await setup.runtime.ask('请教我调整文字大小');
    await setup.runtime.whenIdle();
    expect(setup.source.capture).toHaveBeenCalledTimes(3);
    expect(setup.source.stop).not.toHaveBeenCalled();
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'observing', captureActive: true, cloudConsent: true });
    expect(setup.runtime.snapshot().observation).toMatchObject({ id: observation.id, generation: observation.generation });
    expect(setup.analyze.mock.calls[0][0].frame.capturedAt).toBeGreaterThan(expiredFrame.capturedAt + 5000);
    expect(expiredFrame.png.every(byte => byte === 0)).toBe(true);
    expect(setup.runtime.snapshot().task.state).toBe('awaiting_action');
  });

  it('过期帧有限次重采集仍失败时保持观察可用，当前查找可手动重试', async () => {
    const setup = fixture();
    setup.source.detect.mockImplementation(async frame => {
      const detection = syntheticDetection(frame, setup.controls.labels);
      setup.controls.time += 6000;
      return detection;
    });
    await setup.start();
    await setup.runtime.ask('如何打开微信');
    await setup.runtime.whenIdle();
    const current = setup.runtime.snapshot();
    expect(setup.source.capture).toHaveBeenCalledTimes(8);
    expect(setup.source.stop).not.toHaveBeenCalled();
    expect(current.observation).toMatchObject({ state: 'observing', captureActive: true, cloudConsent: true });
    expect(current.task).toMatchObject({ state: 'needs_help', explanation: expect.stringContaining('本地画面处理超时') });
    expect(current.analysis).toMatchObject({ state: 'capture_error', message: expect.stringContaining('当前屏幕共享仍保持') });
    expect(current.analysis.message).not.toContain('共享已暂停');
    expect(setup.analyze).not.toHaveBeenCalled();
    setup.source.detect.mockImplementation(async frame => syntheticDetection(frame, setup.controls.labels));
    await setup.runtime.ask('如何打开微信', current.observation.generation);
    await setup.runtime.whenIdle();
    expect(setup.source.capture).toHaveBeenCalledTimes(9);
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.runtime.snapshot().observation).toEqual({ ...current.observation, reason: 'authorized_sharing' });
    expect(setup.runtime.snapshot().task.state).toBe('awaiting_action');
    expect(setup.source.stop).not.toHaveBeenCalled();
  });

  it('重试耗尽后只继续本地安全观察，页面变化不自动重发失败问题', async () => {
    vi.useFakeTimers();
    const setup = fixture({ intervalMs: 1500 });
    await setup.start();
    setup.source.detect.mockImplementation(async frame => {
      const detection = syntheticDetection(frame, setup.controls.labels);
      setup.controls.time += 6000;
      return detection;
    });
    await setup.runtime.ask('帮我找到显示设置');
    await setup.runtime.whenIdle();
    expect(setup.source.capture).toHaveBeenCalledTimes(5);
    expect(setup.runtime.snapshot().analysis.state).toBe('capture_error');
    setup.source.detect.mockImplementation(async frame => syntheticDetection(frame, setup.controls.labels));
    await advanceObservation(setup, 1500);
    setup.controls.labels.push('帮助');
    await advanceObservation(setup, 1500);
    await setup.runtime.whenIdle();
    expect(setup.source.capture).toHaveBeenCalledTimes(7);
    expect(setup.analyze).not.toHaveBeenCalled();
    expect(setup.source.stop).not.toHaveBeenCalled();
    expect(setup.runtime.snapshot()).toMatchObject({ observation: { state: 'observing', captureActive: true }, task: { state: 'needs_help' }, analysis: { state: 'capture_error' } });
  });

  it.each(['sensitive', 'unknown'] as const)('重采集过程中出现 %s 仍保持授权共享并继续分析', async condition => {
    const setup = fixture();
    await setup.start();
    setup.source.capture.mockImplementationOnce(async () => syntheticFrame(setup.controls.geometry, setup.controls.time - 6000));
    setup.source.detect.mockImplementationOnce(async frame => syntheticDetection(frame, setup.controls.labels));
    setup.source.detect.mockImplementationOnce(async frame => ({ ...syntheticDetection(frame,
      condition === 'sensitive' ? [...setup.controls.labels, '验证码123456'] : [...setup.controls.labels, '未知正文']),
      status: 'complete' }));
    await setup.runtime.ask('帮我找到显示设置');
    await setup.runtime.whenIdle();
    expect(setup.source.capture).toHaveBeenCalledTimes(3);
    expect(setup.source.stop).not.toHaveBeenCalled();
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'observing', captureActive: true, cloudConsent: true, reason: 'authorized_sharing' });
    expect(setup.analyze).toHaveBeenCalledOnce();
  });

  it('重采集过程中本地检测不可用仍停止采集，不继续重试', async () => {
    const setup = fixture();
    await setup.start();
    setup.source.capture.mockImplementationOnce(async () => syntheticFrame(setup.controls.geometry, setup.controls.time - 6000));
    setup.source.detect.mockImplementationOnce(async frame => syntheticDetection(frame, setup.controls.labels));
    setup.source.detect.mockImplementationOnce(async frame => ({ ...syntheticDetection(frame, setup.controls.labels), status: 'unavailable' }));
    await setup.runtime.ask('帮我找到显示设置');
    await setup.runtime.whenIdle();
    expect(setup.source.capture).toHaveBeenCalledTimes(3);
    expect(setup.source.stop).toHaveBeenCalledOnce();
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'privacy_paused', captureActive: false, cloudConsent: false, reason: 'local_detector_unavailable' });
    expect(setup.analyze).not.toHaveBeenCalled();
  });

  it('重采集期间停止观察，迟到检测不能恢复共享或发送画面', async () => {
    const setup = fixture();
    await setup.start();
    const detection = deferred<ReturnType<typeof syntheticDetection>>();
    let refreshingFrame!: ObservationFrame;
    setup.source.capture.mockImplementationOnce(async () => syntheticFrame(setup.controls.geometry, setup.controls.time - 6000));
    setup.source.detect.mockImplementationOnce(async frame => syntheticDetection(frame, setup.controls.labels));
    setup.source.detect.mockImplementationOnce(frame => { refreshingFrame = frame; return detection.promise; });
    await setup.runtime.ask('帮我找到显示设置');
    await vi.waitFor(() => expect(setup.source.capture).toHaveBeenCalledTimes(3));
    expect(setup.runtime.snapshot().analysis.state).toBe('capture_retry');
    await setup.runtime.stopObservation('user');
    const stopped = setup.runtime.snapshot();
    detection.resolve(syntheticDetection(refreshingFrame, setup.controls.labels));
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot()).toEqual(stopped);
    expect(setup.source.capture).toHaveBeenCalledTimes(3);
    expect(setup.analyze).not.toHaveBeenCalled();
    expect(refreshingFrame.png.every(byte => byte === 0)).toBe(true);
  });

  it('未知异常只显示固定通用代码，不能把异常字段带入桌宠状态', async () => {
    const setup = fixture();
    setup.source.capture.mockRejectedValueOnce(Object.assign(new Error('private-screen-content'), { code: 'private-screen-code' }));
    await setup.start();
    expect(setup.runtime.snapshot().observation.reason).toBe('capture_or_detector_failed');
    expect(JSON.stringify(setup.runtime.snapshot())).not.toMatch(/private-screen-(?:content|code)/);
  });

  it('主机停止故障采集后，结束教学不能覆盖具体错误或谎报观察仍可继续', async () => {
    const setup = fixture();
    await beginTeaching(setup);
    await setup.runtime.stopObservation('capture_dimensions_unproven');
    await setup.runtime.finishTeaching();
    const current = setup.runtime.snapshot();
    expect(current.observation).toMatchObject({ state: 'stopped', captureActive: false, reason: 'capture_dimensions_unproven' });
    expect(current.analysis).toMatchObject({ state: 'error', message: expect.stringContaining('缩放') });
    expect(current.analysis.message).not.toContain('观察可继续');
  });

  it('敏感文字不会停止已授权共享，用户手动停止后不会自行恢复', async () => {
    const setup = fixture();
    setup.controls.labels = ['设置', '显示', '文本大小', '验证码123456'];
    await setup.start();
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'observing', captureActive: true, reason: 'authorized_sharing' });
    expect(setup.source.stop).not.toHaveBeenCalled();
    expect(setup.analyze).not.toHaveBeenCalled();
    const captures = setup.source.capture.mock.calls.length;
    await setup.runtime.stopObservation('user');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(setup.source.capture).toHaveBeenCalledTimes(captures);
    expect(setup.source.stop).toHaveBeenCalledOnce();
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'stopped', captureActive: false });
  });

  it('本地检测故障仍停止采集，恢复必须由本人重新授权', async () => {
    const setup = fixture();
    setup.controls.status = 'unavailable';
    await setup.start();
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'privacy_paused', captureActive: false, reason: 'local_detector_unavailable' });
    expect(setup.source.stop).toHaveBeenCalledOnce();
    expect(setup.analyze).not.toHaveBeenCalled();
    setup.controls.status = 'complete';
    await expect(setup.runtime.startObservation({ actor: 'owner', confirmed: true, sourceId: 'screen:test:0' })).rejects.toThrow('继续共享');
    await expect(setup.runtime.resumeObservation({ actor: 'family', confirmed: true, sourceId: 'screen:test:0' })).rejects.toThrow('本人');
    await setup.runtime.resumeObservation({ actor: 'owner', confirmed: true, sourceId: 'screen:test:0' });
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'observing', captureActive: true, reason: 'authorized_sharing' });
  });

  it('先失效发送资格和目标，再停本地源；迟到回答不会恢复指引', async () => {
    const setup = fixture();
    let completeAnalysis: ((result: AnalysisResult) => void) | undefined;
    let request: AnalysisInput | undefined;
    setup.analyze.mockImplementation(input => { request = input; return new Promise(resolve => { completeAnalysis = resolve; }); });
    await setup.start();
    await setup.runtime.ask('请教我调整文字大小');
    await vi.waitFor(() => expect(request).toBeDefined());
    expect(request?.canSend()).toBe(true);
    setup.source.stop.mockImplementation(async () => {
      expect(request?.canSend()).toBe(false);
      expect(setup.onTarget).toHaveBeenLastCalledWith(null);
    });
    await setup.runtime.stopObservation('lock');
    completeAnalysis?.(stepResponse(request!));
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'stopped', captureActive: false });
    expect(setup.runtime.snapshot().task.state).toBe('ended');
    expect(setup.onTarget).toHaveBeenLastCalledWith(null);
    expect(setup.records).toHaveLength(1);
  });

  it('风险问题不在随后变页时偷偷继续分析，默认笔记仍未掌握', async () => {
    const setup = fixture();
    await setup.start();
    await setup.runtime.ask('请教我输入验证码123456');
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'ended', result: 'risk_blocked' });
    expect(setup.analyze).not.toHaveBeenCalled();
    expect(setup.records[0]).toMatchObject({ mastery: 'unmastered', result: 'risk_blocked' });
    expect(JSON.stringify(setup.records)).not.toContain('123456');
  });

  it('开始撤销观察即推送新代次，清理完成前不保留可用的旧授权状态', async () => {
    const onState = vi.fn();
    const setup = fixture({ onState });
    await setup.start(false);
    const generation = setup.runtime.snapshot().observation.generation;
    const cleanup = deferred<undefined>();
    setup.source.stop.mockImplementationOnce(() => cleanup.promise);
    const stopping = setup.runtime.stopObservation();
    try {
      expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ observation: expect.objectContaining({
        state: 'stopped', generation: generation + 1, cloudConsent: false, captureActive: true,
      }) }));
      await expect(setup.runtime.authorizeCloudAnalysis({ actor: 'owner', confirmed: true, observationGeneration: generation })).rejects.toThrow('观察已变化');
      expect(setup.analyze).not.toHaveBeenCalled();
    } finally { cleanup.resolve(undefined); await stopping; }
    expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ observation: expect.objectContaining({ state: 'stopped', captureActive: false }) }));
  });

  it('本地源清理失败不能谎报停止，也不能重新开启', async () => {
    const setup = fixture();
    await setup.start();
    setup.source.stop.mockRejectedValue(new Error('synthetic cleanup failure'));
    const result = await setup.runtime.stopObservation();
    expect(result).toMatchObject({ stopped: false, captureActive: true });
    expect(setup.runtime.snapshot().observation.state).toBe('cleanup_failed');
    await expect(setup.runtime.startObservation({ actor: 'owner', confirmed: true, sourceId: 'screen:test:0' })).rejects.toThrow('清理');
    setup.source.stop.mockResolvedValue(undefined);
  });

  it('后台无显著变化时只本地检测，真正变页可自动进入新帧核验', async () => {
    vi.useFakeTimers();
    const setup = fixture();
    setup.analyze.mockImplementation(async input => input.previousStep
      ? { ...responseIdentity(input), kind: 'completed', instruction: '当前新页面已显示字体大小。', evidence_labels: ['字体大小'] }
      : stepResponse(input));
    await setup.start();
    await setup.runtime.ask('请教我调整文字大小');
    await setup.runtime.whenIdle();
    await vi.advanceTimersByTimeAsync(60000);
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.source.capture).toHaveBeenCalledTimes(3);
    setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
    await vi.advanceTimersByTimeAsync(60000);
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledTimes(2);
    expect(setup.analyze.mock.calls[1][0].reason).toBe('page_changed');
    expect(setup.runtime.snapshot().task.state).toBe('completed');
    await setup.runtime.stopObservation();
    const stoppedCaptures = setup.source.capture.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120000);
    expect(setup.source.capture).toHaveBeenCalledTimes(stoppedCaptures);
  });

  it('预期标签基线已存在时，无关 signature 变化不能证明完成', async () => {
    const setup = fixture();
    setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
    setup.analyze.mockImplementation(async input => input.previousStep
      ? { ...completedResponse(input), review_proposal: proposedReview(setup.controls.time) } : stepResponse(input));
    await beginTeaching(setup);
    setup.controls.labels.push('帮助');
    await setup.runtime.verify();
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledTimes(2);
    expect(setup.runtime.snapshot().task.state).toBe('needs_help');
    expect(setup.records).toEqual([]);
    expect(setup.suggestReview).not.toHaveBeenCalled();
  });

  it('基线标签先消失再出现也不能替代上一步没有的操作证据', async () => {
    const setup = fixture();
    setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
    setup.analyze.mockImplementation(async input => input.previousStep ? completedResponse(input) : stepResponse(input));
    await beginTeaching(setup);
    setup.controls.labels = ['设置', '显示', '文本大小', '返回'];
    await setup.runtime.verify();
    await setup.runtime.whenIdle();
    await verifyChanged(setup);
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', result: null });
    expect(setup.analyze).toHaveBeenCalledTimes(2);
    expect(setup.records).toEqual([]);
  });

  it('稳定上下文标签加一个基线没有的新预期标签，可以构成可验证变化', async () => {
    const setup = fixture();
    setup.analyze.mockImplementation(async input => input.previousStep ? completedResponse(input)
      : { ...stepResponse(input), expected_labels: ['显示', '字体大小'] });
    await beginTeaching(setup);
    await verifyChanged(setup);
    expect(setup.runtime.snapshot().task.state).toBe('completed');
    expect(setup.records).toHaveLength(1);
  });

  it('规范化标签后仍检查基线，不能用全角或大小写变体冒充新证据', async () => {
    const setup = fixture();
    setup.controls.labels = ['settings', 'display', 'text size', 'back'];
    setup.analyze.mockImplementation(async input => input.previousStep ? completedResponse(input)
      : { ...stepResponse(input), expected_labels: ['ＴＥＸＴ　ＳＩＺＥ'] });
    await beginTeaching(setup);
    setup.controls.labels.push('help');
    await setup.runtime.verify();
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task.state).toBe('needs_help');
    expect(setup.records).toEqual([]);
  });

  it('模型不能借无关变化跳过旧步骤并安装新目标', async () => {
    const setup = fixture();
    setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
    setup.analyze.mockImplementation(async input => input.previousStep
      ? { ...stepResponse(input), instruction: '请进入下一步辅助功能。', target_id: input.frame.elements[2].id, expected_labels: ['辅助功能'] }
      : stepResponse(input));
    await beginTeaching(setup);
    setup.controls.labels.push('帮助');
    await setup.runtime.verify();
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'needs_help', instruction: '请亲手打开显示设置，再观察新页面。' });
    expect(setup.onTarget).toHaveBeenLastCalledWith(null);
  });

  it('真正推进后重新建立下一步基线，而不是沿用旧任务证据', async () => {
    const setup = fixture();
    setup.analyze.mockImplementation(async input => {
      if (!input.previousStep) return stepResponse(input);
      if (input.previousStep.expectedLabels.includes('字体大小')) return {
        ...stepResponse(input), target_id: input.frame.elements[2].id, instruction: '请亲手打开辅助功能。', expected_labels: ['辅助功能'],
      };
      return completedResponse(input);
    });
    await beginTeaching(setup);
    await verifyChanged(setup);
    expect(setup.runtime.snapshot().task.state).toBe('awaiting_action');
    expect(setup.records).toEqual([]);
    setup.controls.labels = ['设置', '显示', '字体大小', '辅助功能', '返回'];
    await setup.runtime.verify();
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task.state).toBe('completed');
    expect(setup.records).toHaveLength(1);
  });

  it.each([0, -1])('拒绝时间戳相同或倒退的安全帧，即使帧 ID 和标签变化：%i', async offset => {
    const setup = fixture();
    setup.analyze.mockImplementation(async input => input.previousStep ? completedResponse(input) : stepResponse(input));
    await beginTeaching(setup);
    const baseline = setup.analyze.mock.calls[0][0].frame.capturedAt;
    setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
    setup.source.capture.mockImplementationOnce(async () => ({ ...syntheticFrame(setup.controls.geometry, baseline + offset), frameId: 'replayed-frame' }));
    await setup.runtime.verify();
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.runtime.snapshot().analysis.message).toContain('更新');
    expect(setup.runtime.snapshot().task.state).toBe('awaiting_action');
    expect(setup.records).toEqual([]);
  });

  it('完成核验的捕获时刻必须晚于指引展示，不能使用分析期间提前捕获的画面', async () => {
    const setup = fixture();
    setup.analyze.mockImplementation(async input => {
      if (input.previousStep) return completedResponse(input);
      setup.controls.time += 100;
      return stepResponse(input);
    });
    await beginTeaching(setup);
    const baseline = setup.analyze.mock.calls[0][0].frame.capturedAt;
    setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
    setup.source.capture.mockImplementationOnce(async () => syntheticFrame(setup.controls.geometry, baseline + 1));
    await setup.runtime.verify();
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.records).toEqual([]);
    expect(setup.runtime.snapshot().task.state).toBe('awaiting_action');
  });

  it.each(['sensitive', 'unavailable'] as const)('完成验证保留授权共享且仍需本地检测完整：%s', async condition => {
    const setup = fixture();
    setup.analyze.mockImplementation(async input => input.previousStep ? completedResponse(input) : stepResponse(input));
    await beginTeaching(setup);
    setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
    if (condition === 'sensitive') setup.controls.labels.push('验证码123456');
    if (condition === 'unavailable') setup.controls.status = 'unavailable';
    await setup.runtime.verify();
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().observation.state).toBe(condition === 'sensitive' ? 'observing' : 'privacy_paused');
    if (condition === 'sensitive') expect(setup.runtime.snapshot().observation.reason).toBe('authorized_sharing');
    expect(setup.analyze).toHaveBeenCalledTimes(condition === 'sensitive' ? 2 : 1);
    expect(setup.records).toHaveLength(condition === 'sensitive' ? 1 : 0);
    if (condition === 'sensitive') expect(setup.records[0]).toMatchObject({ result: 'completed', mastery: 'unmastered' });
    expect(setup.suggestReview).not.toHaveBeenCalled();
  });

  it('验证遇到过期帧时重采集最新画面，不暂停共享或使用旧位置', async () => {
    const setup = fixture();
    await beginTeaching(setup);
    setup.controls.labels = ['设置', '显示', '字体大小', '返回', '帮助'];
    setup.source.detect.mockImplementationOnce(async frame => {
      const detection = syntheticDetection(frame, setup.controls.labels);
      setup.controls.time += 6000;
      return detection;
    });
    await setup.runtime.verify();
    await setup.runtime.whenIdle();
    expect(setup.source.capture).toHaveBeenCalledTimes(4);
    expect(setup.source.stop).not.toHaveBeenCalled();
    expect(setup.analyze).toHaveBeenCalledTimes(2);
    expect(setup.runtime.snapshot().observation.state).toBe('observing');
    expect(setup.runtime.snapshot().task.state).toBe('awaiting_action');
  });

  it.each([['step', 6000], ['step', 11000], ['completed', 6000], ['completed', 11000]] as const)(
    '原帧发送后允许 %s 慢响应 %i 毫秒，仅依赖同上下文最新完整安全帧', async (kind, delay) => {
      vi.useFakeTimers();
      const setup = fixture({ intervalMs: 1500 });
      const pending = await beginSlowAnalysis(setup, kind);
      try {
        await advanceObservation(setup, delay);
        expect(setup.controls.time - pending.request.frame.capturedAt).toBeGreaterThan(5000);
        expect(pending.request.canSend()).toBe(true);
        expect(pending.fetchRequest).toHaveBeenCalledOnce();
        expect(setup.analyze).toHaveBeenCalledTimes(kind === 'step' ? 1 : 2);
      } finally { pending.complete(); }
      await setup.runtime.whenIdle();
      expect(setup.runtime.snapshot().task.state).toBe(kind === 'step' ? 'awaiting_action' : 'completed');
      expect(setup.records).toHaveLength(kind === 'step' ? 0 : 1);
      expect(setup.suggestReview).toHaveBeenCalledTimes(kind === 'step' ? 0 : 1);
      if (kind === 'step') expect(setup.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({ expiresAt: expect.any(Number) }));
      else expect(setup.records[0]).toMatchObject({ result: 'completed', mastery: 'unmastered' });
    },
  );

  it('慢响应没有更新的安全帧时仍被拒绝', async () => {
    vi.useFakeTimers();
    const setup = fixture();
    const pending = await beginSlowAnalysis(setup);
    try {
      await advanceObservation(setup, 6000);
      expect(setup.source.capture).toHaveBeenCalledTimes(3);
      expect(pending.request.canSend()).toBe(false);
      setup.source.capture.mockImplementation(async () => syntheticFrame(setup.controls.geometry, pending.request.frame.capturedAt));
    } finally { pending.complete(); }
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task.state).toBe('needs_help');
    expect(setup.records).toEqual([]);
    expect(setup.suggestReview).not.toHaveBeenCalled();
  });

  it.each([5000, 5001])('慢响应使用的最新安全帧仍受五秒边界约束：%i', async age => {
    vi.useFakeTimers();
    const setup = fixture({ intervalMs: 1500 });
    const pending = await beginSlowAnalysis(setup);
    try {
      await advanceObservation(setup, 6000);
      setup.controls.time += age;
      expect(pending.request.canSend()).toBe(age <= 5000);
      if (age > 5000) setup.source.capture.mockImplementation(async () => syntheticFrame(setup.controls.geometry, setup.controls.time - age));
    } finally { pending.complete(); }
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task.state).toBe(age <= 5000 ? 'completed' : 'needs_help');
    expect(setup.records).toHaveLength(age <= 5000 ? 1 : 0);
  });

  it.each(['source', 'display', 'geometry', 'signature'] as const)(
    '慢响应不接受上下文曾发生变化的安全帧续接旧分析：%s', async changed => {
      vi.useFakeTimers();
      const setup = fixture({ intervalMs: 1500 });
      const pending = await beginSlowAnalysis(setup);
      try {
        setup.source.capture.mockImplementationOnce(async () => {
          const frame = syntheticFrame(setup.controls.geometry, ++setup.controls.time);
          if (changed === 'source') frame.sourceId = 'screen:other:0';
          if (changed === 'display') frame.displayId = 'other-display';
          if (changed === 'geometry' && frame.geometry) frame.geometry.x += 10;
          return frame;
        });
        if (changed === 'signature') setup.controls.labels.push('帮助');
        await advanceObservation(setup, 6000);
        expect(pending.request.signal.aborted).toBe(true);
        expect(pending.request.canSend()).toBe(false);
      } finally { pending.complete(); }
      await setup.runtime.whenIdle();
      expect(setup.runtime.snapshot().task.state).not.toBe('completed');
      expect(setup.records).toEqual([]);
      expect(setup.suggestReview).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'invalid', 'aspect', 'scale', 'display'] as const)(
    '慢响应不能借相同但未验证的几何或显示信息续接：%s', async invalid => {
      vi.useFakeTimers();
      const setup = fixture({ intervalMs: 1500 });
      if (invalid === 'missing') setup.controls.geometry = null;
      else if (setup.controls.geometry) {
        if (invalid === 'invalid') setup.controls.geometry.x = Number.NaN;
        if (invalid === 'aspect') setup.controls.geometry.height = 500;
        if (invalid === 'scale') setup.controls.geometry.scaleFactor = 0;
      }
      if (invalid === 'display') setup.source.capture.mockImplementation(async () => ({
        ...syntheticFrame(setup.controls.geometry, ++setup.controls.time), displayId: undefined,
      }));
      const pending = await beginSlowAnalysis(setup);
      try {
        await advanceObservation(setup, 6000);
        expect(pending.request.canSend()).toBe(false);
      } finally { pending.complete(); }
      await setup.runtime.whenIdle();
      expect(setup.runtime.snapshot().task.state).toBe('needs_help');
      expect(setup.records).toEqual([]);
      expect(setup.suggestReview).not.toHaveBeenCalled();
    },
  );

  it.each(['sensitive', 'unknown', 'unavailable', 'failed'] as const)(
    '慢响应遇到文字变化不停止共享，但上下文变化或检测故障仍使旧分析失效：%s', async condition => {
      vi.useFakeTimers();
      const setup = fixture({ intervalMs: 1500 });
      const pending = await beginSlowAnalysis(setup);
      try {
        if (condition === 'sensitive') setup.controls.labels.push('验证码123456');
        if (condition === 'unknown') setup.controls.labels = ['无法分类的合成页面'];
        if (condition === 'unavailable') setup.controls.status = 'unavailable';
        if (condition === 'failed') setup.source.detect.mockRejectedValueOnce(new Error('synthetic detection failure'));
        await advanceObservation(setup, 6000);
        if (condition === 'sensitive' || condition === 'unknown') {
          expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'observing', captureActive: true, reason: 'authorized_sharing' });
          expect(setup.source.stop).not.toHaveBeenCalled();
        } else {
          expect(setup.runtime.snapshot().observation.state).toBe('privacy_paused');
        }
        if (condition === 'sensitive') {
          // 授权连续共享下，新增的敏感文字不会取消已在途的脱敏画面分析；上传帧本身已脱敏。
          expect(pending.request.canSend()).toBe(true);
          expect(pending.request.signal.aborted).toBe(false);
        } else {
          expect(pending.request.canSend()).toBe(false);
          expect(pending.request.signal.aborted).toBe(true);
        }
      } finally { pending.complete(); }
      await setup.runtime.whenIdle();
      if (condition === 'sensitive') {
        // 本地已出现上一步没有的“字体大小”证据，脱敏画面分析可以正常完成并记录。
        expect(setup.runtime.snapshot().task.state).toBe('completed');
        expect(setup.records).toHaveLength(1);
      } else {
        expect(setup.runtime.snapshot().task.state).not.toBe('completed');
        expect(setup.records).toEqual([]);
        expect(setup.suggestReview).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['stop', 'new_question'] as const)(
    '慢响应在安全续接后停止或换问题仍不能迟到安装或传递建议：%s', async action => {
      vi.useFakeTimers();
      const setup = fixture({ intervalMs: 1500 });
      const pending = await beginSlowAnalysis(setup);
      try {
        await advanceObservation(setup, 6000);
        expect(pending.request.canSend()).toBe(true);
        if (action === 'stop') await setup.runtime.stopObservation('lock');
        else await setup.runtime.ask('新的问题，打开辅助功能');
        expect(pending.request.canSend()).toBe(false);
      } finally { pending.complete(); }
      await setup.runtime.whenIdle();
      expect(setup.runtime.snapshot().task.state).toBe(action === 'stop' ? 'ended' : 'awaiting_action');
      expect(setup.records).toHaveLength(1);
      expect(setup.records[0].result).toBe('interrupted');
      expect(setup.suggestReview).not.toHaveBeenCalled();
    },
  );

  it('慢响应原始准入帧被篡改时不能靠新安全帧恢复资格', async () => {
    vi.useFakeTimers();
    const setup = fixture({ intervalMs: 1500 });
    const pending = await beginSlowAnalysis(setup);
    try {
      await advanceObservation(setup, 6000);
      pending.request.frame.sanitizedPng.fill(0);
      expect(pending.request.canSend()).toBe(false);
    } finally { pending.complete(); }
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task.state).toBe('needs_help');
    expect(setup.records).toEqual([]);
    expect(setup.suggestReview).not.toHaveBeenCalled();
  });

  it.each(['stale', 'forged'] as const)(
    '发送瞬间仍拒绝过期原帧或 WeakSet 外的复制帧，不因响应续接门控放宽：%s', async condition => {
      vi.useFakeTimers();
      const setup = fixture({ intervalMs: 1500 });
      await beginTeaching(setup);
      const sending = deferred<void>();
      const fetchRequest = vi.fn<typeof fetch>();
      const client = createDesktopAnalysisClient({
        env: { NUANBAN_DESKTOP_API_BASE_URL: 'http://127.0.0.1:3000', NUANBAN_DESKTOP_API_TOKEN: 'synthetic-account-token' },
        now: () => setup.controls.time, fetch: fetchRequest,
      });
      setup.analyze.mockImplementationOnce(async input => {
        await sending.promise;
        return client.analyze(condition === 'forged' ? { ...input, frame: { ...input.frame } } : input);
      });
      setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
      await setup.runtime.verify();
      try {
        await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledTimes(2));
        await advanceObservation(setup, condition === 'stale' ? 6000 : 1500);
        expect(setup.analyze.mock.calls[1][0].canSend()).toBe(true);
      } finally { sending.resolve(); }
      await setup.runtime.whenIdle();
      expect(fetchRequest).not.toHaveBeenCalled();
      expect(setup.runtime.snapshot().task.state).toBe('needs_help');
      expect(setup.records).toEqual([]);
      expect(setup.suggestReview).not.toHaveBeenCalled();
    },
  );

  it.each(['guide_id', 'observation_id', 'observation_generation', 'task_generation', 'frame_id', 'trigger_id'] as const)(
    '完成回应必须绑定当前问题、代次、触发与帧：%s', async field => {
      const setup = fixture();
      setup.analyze.mockImplementation(async input => input.previousStep
        ? { ...completedResponse(input), [field]: field.endsWith('generation') ? -1 : 'stale-identity', review_proposal: proposedReview(setup.controls.time) }
        : stepResponse(input));
      await beginTeaching(setup);
      await verifyChanged(setup);
      expect(setup.runtime.snapshot().task.state).toBe('needs_help');
      expect(setup.records).toEqual([]);
      expect(setup.suggestReview).not.toHaveBeenCalled();
    },
  );

  it('新问题保持独立问题与代次；取消旧分析后不等待迟到结果，新任务可立即处理', async () => {
    const setup = fixture();
    const firstResponse = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => firstResponse.promise);
    await setup.start();
    await setup.runtime.ask('第一个问题，调整文字大小');
    let first: AnalysisInput | undefined;
    try {
      await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
      first = setup.analyze.mock.calls[0][0];
      await setup.runtime.ask('第二个问题，调整显示');
      await vi.waitFor(() => expect(setup.source.capture).toHaveBeenCalledTimes(3));
      await setup.runtime.ask('第三个问题，打开辅助功能');
      await vi.waitFor(() => expect(setup.source.capture).toHaveBeenCalledTimes(4));
      expect(first.signal.aborted).toBe(true);
      expect(first.canSend()).toBe(false);
      expect(setup.analyze).toHaveBeenCalledTimes(3);
    } finally {
      if (first) firstResponse.resolve(stepResponse(first));
      else firstResponse.reject(new Error('unit cleanup'));
    }
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledTimes(3);
    const latest = setup.analyze.mock.calls[2][0];
    expect(latest.question).toBe('第三个问题，打开辅助功能');
    expect(latest.guideId).not.toBe(first?.guideId);
    expect(latest.taskGeneration).toBeGreaterThan(first!.taskGeneration);
    expect(setup.runtime.snapshot().task).toMatchObject({ id: latest.guideId, question: latest.question, state: 'awaiting_action' });
    expect(setup.records.map(record => record.question)).toEqual(['第一个问题，调整文字大小', '第二个问题，调整显示']);
  });

  it.each(['stop', 'new_question'] as const)('有真实变化的 completed 回应迟到也不能完成或传递复习建议：%s', async action => {
    const setup = fixture();
    await beginTeaching(setup);
    const response = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => response.promise);
    setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
    await setup.runtime.verify();
    let request: AnalysisInput | undefined;
    try {
      await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledTimes(2));
      request = setup.analyze.mock.calls[1][0];
      if (action === 'stop') await setup.runtime.stopObservation('lock');
      else await setup.runtime.ask('请教我打开辅助功能');
      expect(request.canSend()).toBe(false);
    } finally {
      const input = request ?? setup.analyze.mock.calls[0][0];
      response.resolve({ ...completedResponse(input), review_proposal: proposedReview(setup.controls.time) });
    }
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task.state).toBe(action === 'stop' ? 'ended' : 'awaiting_action');
    expect(setup.records).toHaveLength(1);
    expect(setup.records[0].result).toBe('interrupted');
    expect(setup.suggestReview).not.toHaveBeenCalled();
  });

  it('禁止外部直接 finishTeaching(completed) 或额外参数绕开实际核验', async () => {
    const setup = fixture();
    await beginTeaching(setup);
    await expect(setup.runtime.finishTeaching('completed')).rejects.toThrow('实际变化');
    await expect(Reflect.apply(setup.runtime.finishTeaching, null, ['completed', { review: proposedReview(setup.controls.time) }]))
      .rejects.toThrow('实际变化');
    expect(setup.records).toEqual([]);
    expect(setup.suggestReview).not.toHaveBeenCalled();
  });

  it('真实 completed 的合法复习建议只能在教学记录成功之后传递，且不确认掌握或自动调度', async () => {
    const setup = fixture();
    const proposal = proposedReview(setup.controls.time);
    const saved = deferred<void>();
    const order: string[] = [];
    setup.analyze.mockImplementation(async input => input.previousStep ? { ...completedResponse(input), review_proposal: proposal } : stepResponse(input));
    setup.recordTeaching.mockImplementation(async record => { order.push('recording'); await saved.promise; setup.records.push(record); order.push('recorded'); });
    setup.suggestReview.mockImplementation(() => { order.push('suggested'); });
    await beginTeaching(setup);
    const guideId = setup.runtime.snapshot().task.id;
    setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
    await setup.runtime.verify();
    try {
      await vi.waitFor(() => expect(setup.recordTeaching).toHaveBeenCalledOnce());
      expect(setup.suggestReview).not.toHaveBeenCalled();
      expect(setup.runtime.snapshot().task.state).toBe('finishing');
    } finally { saved.resolve(); }
    await setup.runtime.whenIdle();
    expect(order).toEqual(['recording', 'recorded', 'suggested']);
    expect(setup.suggestReview).toHaveBeenCalledExactlyOnceWith({
      sourceGuideId: guideId, remindAt: proposal.remind_at, timezone: proposal.timezone, reason: proposal.reason, source: 'ai',
    });
    expect(setup.runtime.snapshot().task.state).toBe('completed');
    expect(setup.records[0]).toMatchObject({ sourceGuideId: guideId, result: 'completed', mastery: 'unmastered' });
  });

  it.each(['absent', 'on_step', 'failed_record', 'no_record_hook'] as const)('不得合成或提前传递复习建议：%s', async condition => {
    const setup = fixture(condition === 'no_record_hook' ? { recordTeaching: undefined } : {});
    const proposal = proposedReview(setup.controls.time);
    setup.analyze.mockImplementation(async input => {
      if (!input.previousStep) return condition === 'on_step' ? { ...stepResponse(input), review_proposal: proposal } : stepResponse(input);
      return ['absent', 'on_step'].includes(condition) ? completedResponse(input) : { ...completedResponse(input), review_proposal: proposal };
    });
    if (condition === 'failed_record') setup.recordTeaching.mockRejectedValue(new Error('unit persistence failure'));
    await beginTeaching(setup);
    await verifyChanged(setup);
    expect(setup.suggestReview).not.toHaveBeenCalled();
    expect(setup.runtime.snapshot().task.state).toBe(condition === 'failed_record' ? 'needs_help' : 'completed');
    if (condition === 'failed_record') expect(setup.runtime.snapshot().analysis).toMatchObject({ state: 'error' });
  });

  it.each([
    'past', 'present', 'no_offset', 'rolled_date', 'offset', 'horizon', 'invalid_timezone', 'offset_timezone',
    'missing_timezone', 'missing_reason', 'long_reason', 'sensitive_reason', 'control_reason', 'extra_fields', 'null', 'array', 'inherited', 'accessor',
  ] as const)('非法复习建议被丢弃，不阻止已经核验且保存的教学完成：%s', async condition => {
    const setup = fixture();
    const proposal: Record<string, unknown> = { ...proposedReview(setup.controls.time) };
    let responseProposal: unknown = proposal;
    if (condition === 'past') proposal.remind_at = new Date(setup.controls.time - 1).toISOString();
    if (condition === 'present') proposal.remind_at = new Date(setup.controls.time).toISOString();
    if (condition === 'no_offset') proposal.remind_at = new Date(setup.controls.time + 86400000).toISOString().slice(0, -1);
    if (condition === 'rolled_date') proposal.remind_at = `${new Date(setup.controls.time).getUTCFullYear() + 1}-02-30T12:00:00Z`;
    if (condition === 'offset') proposal.remind_at = new Date(setup.controls.time + 86400000).toISOString().replace('Z', '+25:00');
    if (condition === 'horizon') proposal.remind_at = new Date(setup.controls.time + 367 * 86400000).toISOString();
    if (condition === 'invalid_timezone') proposal.timezone = 'Mars/Olympus';
    if (condition === 'offset_timezone') proposal.timezone = '+08:00';
    if (condition === 'missing_timezone') delete proposal.timezone;
    if (condition === 'missing_reason') delete proposal.reason;
    if (condition === 'long_reason') proposal.reason = '长'.repeat(241);
    if (condition === 'sensitive_reason') proposal.reason = '请记住验证码123456';
    if (condition === 'control_reason') proposal.reason = '复习\u0000';
    if (condition === 'extra_fields') proposal.screenshot = Buffer.from('not a real screenshot');
    if (condition === 'null') responseProposal = null;
    if (condition === 'array') responseProposal = [proposal];
    if (condition === 'inherited') responseProposal = Object.create(proposal);
    if (condition === 'accessor') Object.defineProperty(proposal, 'timezone', { get() { throw new Error('must not invoke provider getters'); } });
    setup.analyze.mockImplementation(async input => input.previousStep
      ? { ...completedResponse(input), review_proposal: responseProposal as never } : stepResponse(input));
    await beginTeaching(setup);
    await verifyChanged(setup);
    expect(setup.runtime.snapshot().task.state).toBe('completed');
    expect(setup.records).toHaveLength(1);
    expect(setup.suggestReview).not.toHaveBeenCalled();
  });

  it('保存笔记期间复习时间过期就不再传递建议', async () => {
    const setup = fixture();
    const proposal = proposedReview(setup.controls.time);
    const saved = deferred<void>();
    setup.analyze.mockImplementation(async input => input.previousStep ? { ...completedResponse(input), review_proposal: proposal } : stepResponse(input));
    setup.recordTeaching.mockImplementation(async record => { await saved.promise; setup.records.push(record); });
    await beginTeaching(setup);
    setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
    await setup.runtime.verify();
    try {
      await vi.waitFor(() => expect(setup.recordTeaching).toHaveBeenCalledOnce());
      setup.controls.time = Date.parse(proposal.remind_at);
    } finally { saved.resolve(); }
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task.state).toBe('completed');
    expect(setup.suggestReview).not.toHaveBeenCalled();
  });

  it('复习回调失败不撤销真实教学完成，也不泄露底层错误或声称提醒已经创建', async () => {
    const setup = fixture();
    setup.analyze.mockImplementation(async input => input.previousStep
      ? { ...completedResponse(input), review_proposal: proposedReview(setup.controls.time) } : stepResponse(input));
    setup.suggestReview.mockRejectedValue(new Error('PRIVATE_STORE_ERROR'));
    await beginTeaching(setup);
    await verifyChanged(setup);
    expect(setup.runtime.snapshot().task.state).toBe('completed');
    expect(setup.runtime.snapshot().message).toContain('未创建提醒');
    expect(JSON.stringify(setup.runtime.snapshot())).not.toContain('PRIVATE_STORE_ERROR');
    expect(setup.records).toHaveLength(1);
  });

  it('完成记录尚未返回时停止，迟到存储结果不能恢复完成状态或产生建议', async () => {
    const setup = fixture();
    const saved = deferred<void>();
    setup.analyze.mockImplementation(async input => input.previousStep
      ? { ...completedResponse(input), review_proposal: proposedReview(setup.controls.time) } : stepResponse(input));
    setup.recordTeaching.mockImplementation(async record => { await saved.promise; setup.records.push(record); });
    await beginTeaching(setup);
    setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
    await setup.runtime.verify();
    let stopping: ReturnType<DesktopRuntime['stopObservation']> | undefined;
    try {
      await vi.waitFor(() => expect(setup.recordTeaching).toHaveBeenCalledOnce());
      stopping = setup.runtime.stopObservation('lock');
      await vi.waitFor(() => expect(setup.runtime.snapshot().observation.state).toBe('stopped'));
    } finally { saved.resolve(); }
    await stopping;
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'ended', result: 'interrupted' });
    expect(setup.recordTeaching).toHaveBeenCalledOnce();
    expect(setup.suggestReview).not.toHaveBeenCalled();
  });

  it('记录旧问题期间的新问题不会被旧完成回调覆盖，也不会误标为已记录', async () => {
    const setup = fixture();
    const saved = deferred<void>();
    setup.analyze.mockImplementation(async input => input.previousStep
      ? { ...completedResponse(input), review_proposal: proposedReview(setup.controls.time) } : stepResponse(input));
    setup.recordTeaching.mockImplementationOnce(async record => { await saved.promise; setup.records.push(record); });
    await beginTeaching(setup);
    const firstGuideId = setup.runtime.snapshot().task.id;
    setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
    await setup.runtime.verify();
    let asking: ReturnType<DesktopRuntime['ask']> | undefined;
    try {
      await vi.waitFor(() => expect(setup.recordTeaching).toHaveBeenCalledOnce());
      asking = setup.runtime.ask('新的问题，打开辅助功能');
    } finally { saved.resolve(); }
    await asking;
    await setup.runtime.whenIdle();
    const secondGuideId = setup.runtime.snapshot().task.id;
    expect(secondGuideId).not.toBe(firstGuideId);
    expect(setup.runtime.snapshot().task).toMatchObject({ question: '新的问题，打开辅助功能', state: 'awaiting_action' });
    expect(setup.suggestReview).not.toHaveBeenCalled();
    await setup.runtime.finishTeaching();
    expect(setup.records.map(record => [record.sourceGuideId, record.result])).toEqual([[firstGuideId, 'completed'], [secondGuideId, 'unfinished']]);
  });
});

describe('连续共享下的画面抖动不打断指引', () => {
  it('无关文字抖动不中止在途模型请求，返回后按新帧核验并绘制箭头', async () => {
    const setup = fixture({ intervalMs: 15 });
    await setup.start();
    const response = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => response.promise);
    await setup.runtime.ask('帮我找到显示设置');
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
    const input = setup.analyze.mock.calls[0][0];
    const detects = setup.source.detect.mock.calls.length;
    // 真实屏幕上的时钟、光标、正文与 OCR 抖动：不属于可识别控件，不能改变安全帧身份。
    setup.controls.labels.push('今天天气不错');
    await vi.waitFor(() => expect(setup.source.detect.mock.calls.length).toBeGreaterThan(detects + 2));
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(input.signal.aborted).toBe(false);
    response.resolve(stepResponse(input));
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    expect(setup.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, label: '显示' }));
  });

  it('箭头显示后无关文字抖动不隐藏箭头，也不重复上云', async () => {
    const setup = fixture({ intervalMs: 15 });
    await beginTeaching(setup);
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    const analyzeCalls = setup.analyze.mock.calls.length;
    const detects = setup.source.detect.mock.calls.length;
    setup.controls.labels.push('今天天气不错');
    await vi.waitFor(() => expect(setup.source.detect.mock.calls.length).toBeGreaterThan(detects + 2));
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledTimes(analyzeCalls);
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    expect(setup.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, label: '显示' }));
  });

  it('目标从新帧消失时隐藏箭头但不自动重新上云', async () => {
    const setup = fixture({ intervalMs: 15 });
    await beginTeaching(setup);
    const analyzeCalls = setup.analyze.mock.calls.length;
    setup.controls.labels = ['今天天气不错', '返回'];
    await vi.waitFor(() => expect(setup.runtime.snapshot().task.targetState).toBe('stale'));
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledTimes(analyzeCalls);
    expect(setup.onTarget).toHaveBeenLastCalledWith(null);
    expect(setup.runtime.snapshot().task.state).toBe('awaiting_action');
  });
});

describe('箭头过期窗口诊断', () => {
  it('慢响应返回后箭头仍获得接近五秒的显示窗口，而不是按旧帧计算不到一秒', async () => {
    vi.useFakeTimers();
    const setup = fixture({ intervalMs: 1500 });
    await setup.start();
    const response = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => response.promise);
    await setup.runtime.ask('帮我找到显示设置');
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
    const input = setup.analyze.mock.calls[0][0];
    await advanceObservation(setup, 4500);
    response.resolve(stepResponse(input));
    await setup.runtime.whenIdle();
    const target = setup.onTarget.mock.calls.at(-1)?.[0];
    expect(target).toBeTruthy();
    const window = target.expiresAt - setup.controls.time;
    console.log('[diagnose] arrow window ms =', window);
    expect(window).toBeGreaterThanOrEqual(3000);
  });
});

describe('真实屏幕下的箭头显示窗口与单帧识别容错', () => {
  it('慢响应返回且最新帧过旧时先取新鲜帧，箭头保留至少约两秒半的显示窗口', async () => {
    vi.useFakeTimers();
    const setup = fixture({ intervalMs: 60000 });
    await setup.start();
    const response = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => response.promise);
    await setup.runtime.ask('帮我找到显示设置');
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
    const input = setup.analyze.mock.calls[0][0];
    // 轮询间隔很长时不产生新帧：模拟真实 OCR 较慢、最新帧已超过安装新鲜度阈值。
    setup.controls.time += 4500;
    response.resolve(stepResponse(input));
    await setup.runtime.whenIdle();
    const target = setup.onTarget.mock.calls.at(-1)?.[0];
    expect(target).toBeTruthy();
    expect(target.expiresAt - setup.controls.time).toBeGreaterThanOrEqual(2500);
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
  });

  it('单帧识别丢失保留一个轮询间隔，连续两帧丢失才隐藏箭头且不重复上云', async () => {
    vi.useFakeTimers();
    const setup = fixture({ intervalMs: 1500 });
    await beginTeaching(setup);
    expect(setup.runtime.snapshot().task.targetState).toBe('visible');
    const analyzeCalls = setup.analyze.mock.calls.length;
    setup.controls.labels = ['今天天气不错', '返回'];
    await advanceObservation(setup, 1500);
    expect(setup.runtime.snapshot().task.targetState).toBe('visible');
    await advanceObservation(setup, 1500);
    expect(setup.runtime.snapshot().task.targetState).toBe('stale');
    expect(setup.analyze).toHaveBeenCalledTimes(analyzeCalls);
  });
});

describe('模型返回期间真实屏幕控件变化仍能核验安装', () => {
  it('可识别控件集合轻微变化后模型返回仍按新帧重定位目标并绘制箭头，不再误报画面已过期', async () => {
    const setup = fixture({ intervalMs: 15 });
    await setup.start();
    const response = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => response.promise);
    await setup.runtime.ask('帮我找到显示设置');
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
    const input = setup.analyze.mock.calls[0][0];
    // 真实屏幕：模型返回前多出一个可识别控件，旧实现会因签名不同判为"画面已过期"。
    const detects = setup.source.detect.mock.calls.length;
    setup.controls.labels = ['设置', '显示', '文本大小', '返回', '帮助'];
    await vi.waitFor(() => expect(setup.source.detect.mock.calls.length).toBeGreaterThan(detects + 2));
    expect(input.canSend()).toBe(false);
    response.resolve(stepResponse(input));
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    expect(setup.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, label: '显示' }));
    expect(setup.runtime.snapshot().analysis.state).toBe('ready');
  });
});

describe('慢采集链路下的安装与箭头窗口', () => {
  it('约四秒的旧帧仍在安全窗口内时允许安装，箭头按核验时间获得接近五秒窗口', async () => {
    vi.useFakeTimers();
    const setup = fixture({ intervalMs: 60000 });
    await setup.start();
    const response = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => response.promise);
    await setup.runtime.ask('帮我找到显示设置');
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
    const input = setup.analyze.mock.calls[0][0];
    // 本机采集+OCR 一轮约 3.4~4.0 秒：安装时帧龄接近四秒，但仍未超过五秒安全上限。
    setup.controls.time += 4000;
    response.resolve(stepResponse(input));
    await setup.runtime.whenIdle();
    const target = setup.onTarget.mock.calls.at(-1)?.[0];
    expect(target).toBeTruthy();
    expect(target.expiresAt - setup.controls.time).toBeGreaterThanOrEqual(4000);
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    expect(setup.runtime.snapshot().analysis.state).toBe('ready');
  });
});

describe('分析图片超过本地发送上限时的缩放副本', () => {
  it('注入缩放副本后分析请求携带副本而非原始帧 PNG，目标 ID 映射与箭头仍正常', async () => {
    const setup = fixture({
      resizeAnalysisImage: () => ({ image: { mime: 'image/png', bytes: Buffer.alloc(2048), width: 800, height: 500 } }),
    });
    await beginTeaching(setup);
    const input = setup.analyze.mock.calls[0][0];
    // 缩放副本改为分析器通过 prepareImage 惰性获取：先过发送门槛，再做耗时的 PNG 缩放。
    const prepared = input.prepareImage?.();
    expect(prepared?.image).toMatchObject({ mime: 'image/png', width: 800, height: 500 });
    expect(prepared?.image.bytes.length).toBe(2048);
    expect(input.frame.sanitizedPng.length).not.toBe(2048);
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
  });
});

describe('全屏慢链路下的安装边界', () => {
  it('帧龄接近五秒上限时仍按当前已准入画面安装，不再报画面已过期', async () => {
    vi.useFakeTimers();
    const setup = fixture({ intervalMs: 60000 });
    await setup.start();
    const response = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => response.promise);
    await setup.runtime.ask('帮我找到显示设置');
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
    const input = setup.analyze.mock.calls[0][0];
    const capturesBefore = setup.source.capture.mock.calls.length;
    // 全屏实测：模型返回时最新已准入帧龄 4.3~4.7 秒，仍在五秒安全窗口内。
    setup.controls.time += 4700;
    response.resolve(stepResponse(input));
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    expect(setup.runtime.snapshot().analysis.state).toBe('ready');
    expect(setup.source.capture.mock.calls.length).toBe(capturesBefore);
  });

  it('帧龄超过五秒上限时先重新采集再安装，不把过期画面当作当前画面', async () => {
    vi.useFakeTimers();
    const setup = fixture({ intervalMs: 60000 });
    await setup.start();
    const response = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => response.promise);
    await setup.runtime.ask('帮我找到显示设置');
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
    const input = setup.analyze.mock.calls[0][0];
    const capturesBefore = setup.source.capture.mock.calls.length;
    setup.controls.time += 5600;
    response.resolve(stepResponse(input));
    await setup.runtime.whenIdle();
    expect(setup.source.capture.mock.calls.length).toBeGreaterThan(capturesBefore);
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    expect(setup.runtime.snapshot().analysis.state).toBe('ready');
  });
});

describe('光标指引自动步进（合成端口单测，不代表真实验收）', () => {
  it('无需输入问题即可开始：自动截帧、上传并显示第一步', async () => {
    const setup = fixture();
    await setup.start();
    await setup.runtime.startAutoStep('帮我打开显示设置');
    await setup.runtime.whenIdle();
    const state = setup.runtime.snapshot();
    expect(state.task).toMatchObject({ kind: 'guidance', autoStep: true, stepIndex: 1, state: 'awaiting_action', question: '帮我打开显示设置' });
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.analyze.mock.calls[0][0]).toMatchObject({ reason: 'question', question: '帮我打开显示设置' });
    expect(state.task.targetState).toBe('visible');
    expect(setup.recordTeaching).not.toHaveBeenCalled();
  });

  it('没有目标文本时使用默认目标，不新建文字任务', async () => {
    const setup = fixture();
    await setup.start();
    await setup.runtime.startAutoStep();
    await setup.runtime.whenIdle();
    expect(setup.analyze.mock.calls[0][0].question).toContain('下一步');
    expect(setup.runtime.snapshot().task).toMatchObject({ kind: 'guidance', autoStep: true });
  });

  it('点“我点好了，请核验”总会再截一帧上传，并推进到下一步', async () => {
    const setup = fixture();
    await setup.start();
    await setup.runtime.startAutoStep('帮我打开显示设置');
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledOnce();
    const capturesBefore = setup.source.capture.mock.calls.length;
    await setup.runtime.verify();
    await setup.runtime.whenIdle();
    expect(setup.source.capture.mock.calls.length).toBeGreaterThan(capturesBefore);
    expect(setup.analyze).toHaveBeenCalledTimes(2);
    expect(setup.analyze.mock.calls[1][0]).toMatchObject({ reason: 'verification' });
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', stepIndex: 2 });
  });

  it('达到 12 步上限后停止上传并结束教学', async () => {
    const setup = fixture();
    await setup.start();
    await setup.runtime.startAutoStep('一直点下去');
    await setup.runtime.whenIdle();
    for (let index = 0; index < 12; index += 1) {
      await setup.runtime.verify();
      await setup.runtime.whenIdle();
    }
    const state = setup.runtime.snapshot();
    expect(setup.analyze.mock.calls.length).toBeLessThanOrEqual(13);
    expect(['ended', 'completed']).toContain(state.task.state);
  });

  it('自动步进下本机分类失败会重试并跳过该帧，不暂停共享也不报错', async () => {
    const setup = fixture();
    let failing = false;
    setup.source.detect.mockImplementation(async frame => failing
      ? { ...syntheticDetection(frame), status: 'unavailable', reason: 'no_readable_text' }
      : syntheticDetection(frame));
    await setup.start();
    failing = true;
    await setup.runtime.startAutoStep('帮我打开显示设置');
    await setup.runtime.whenIdle();
    const state = setup.runtime.snapshot();
    expect(state.observation).toMatchObject({ state: 'observing', captureActive: true });
    expect(state.analysis.message).toContain('已跳过这一帧');
    expect(setup.analyze).not.toHaveBeenCalled();
    expect(setup.source.stop).not.toHaveBeenCalled();
    expect(setup.source.capture.mock.calls.length).toBeGreaterThan(1);
  });

  it('手动指引保持原来的失败关闭：分类失败立即暂停且不重试', async () => {
    const setup = fixture();
    let failing = false;
    setup.source.detect.mockImplementation(async frame => failing
      ? { ...syntheticDetection(frame), status: 'unavailable', reason: 'no_readable_text' }
      : syntheticDetection(frame));
    await setup.start();
    failing = true;
    await setup.runtime.ask('帮我打开显示设置');
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'privacy_paused', reason: 'no_readable_text' });
    expect(setup.source.capture).toHaveBeenCalledTimes(2);
    expect(setup.source.stop).toHaveBeenCalledOnce();
  });
});
