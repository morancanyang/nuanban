import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopRuntime, type AnalysisInput, type AnalysisResult, type DesktopRuntime, type RuntimeOptions, type TeachingRecord } from '../../apps/desktop/runtime-coordinator.cjs';
import type { ScreenGeometry } from '../../apps/desktop/observation-policy.cjs';
import { syntheticDetection, syntheticFrame } from '../helpers/standalone-frame';

// 现场缺陷（2026-10-24，用户整屏共享点"我点好了，请核验"后卡在"正在分析画面"）：
// 周期抽帧 tick 每次都用新的 page_changed 分析取消并重发仍在飞行中的请求；一次分析 ~3.5s 长于 3s 的
// tick，于是请求永远拿不到结果。这些用例用假时钟 + 假 provider 固定该行为，不接触真实网络。

const runtimes: DesktopRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
  vi.useRealTimers();
});

function identity(input: AnalysisInput) {
  return { observation_id: input.observationId, guide_id: input.guideId, observation_generation: input.observationGeneration,
    task_generation: input.taskGeneration, trigger_id: input.triggerId, frame_id: input.frame.frameId };
}

function stepResponse(input: AnalysisInput): AnalysisResult {
  return { ...identity(input), kind: 'step', instruction: '请亲手打开显示设置，再观察新页面。', target_id: input.frame.elements[1].id,
    presentation: 'uncertain_candidate', expected_labels: ['字体大小'] };
}

function completedResponse(input: AnalysisInput): AnalysisResult {
  return { ...identity(input), kind: 'completed', instruction: '新画面已显示字体大小设置。',
    evidence_labels: input.previousStep?.expectedLabels ?? ['字体大小'] };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

const defaultGeometry: ScreenGeometry = { x: -800, y: 0, width: 800, height: 600, scaleFactor: 1 };

function fixture(options: { intervalMs?: number } = {}) {
  vi.useFakeTimers();
  const controls = { time: Date.now(), labels: ['设置', '显示', '文本大小', '返回'], geometry: defaultGeometry as ScreenGeometry | null };
  const source = {
    capture: vi.fn(async () => syntheticFrame(controls.geometry, ++controls.time)),
    detect: vi.fn<RuntimeOptions['source']['detect']>(async frame => syntheticDetection(frame, controls.labels)),
    stop: vi.fn(async () => undefined),
  };
  const calls: number[] = [];
  const analyze = vi.fn<(input: AnalysisInput) => Promise<AnalysisResult>>(async input => {
    calls.push(controls.time);
    return stepResponse(input);
  });
  const onTarget = vi.fn();
  const records: TeachingRecord[] = [];
  const runtime = createDesktopRuntime({ source, analyzer: { analyze }, onTarget, intervalMs: options.intervalMs ?? 3000,
    now: () => controls.time, recordTeaching: record => { records.push(record); } });
  runtimes.push(runtime);
  const start = async () => {
    await runtime.startObservation({ actor: 'owner', confirmed: true, sourceId: 'screen:test:0', sourceName: '合成测试屏幕', cloudConsent: true });
    await runtime.whenIdle();
  };
  return { runtime, source, controls, analyze, calls, onTarget, records, start };
}

// 假时钟推进：now() 与定时器一起走，但不等待飞行中的 provider（否则会和假定时器互相等待）。
async function advance(setup: ReturnType<typeof fixture>, duration: number, step = 500) {
  let elapsed = 0;
  while (elapsed < duration) {
    const slice = Math.min(step, duration - elapsed);
    setup.controls.time += slice;
    await vi.advanceTimersByTimeAsync(slice);
    elapsed += slice;
  }
}

// 只用本机词表内的标签，并且保持 12 个以内（合成帧高 600，超出会被本地范围校验拒绝并停止观察）；
// 每次轮换一个标签，保证每一 tick 的控制集合签名真的变化。
const churnPool = ['帮助', '文件', '编辑', '查看', '工具', '选项', '格式', '菜单', '更多', '收藏', '主页', '刷新', '新建', '复制'];
function churnLabels(controls: { labels: string[] }, index: number) {
  controls.labels = ['设置', '显示', '文本大小', '返回',
    ...Array.from({ length: 8 }, (_value, offset) => churnPool[(index + offset) % churnPool.length]!)];
}

describe('周期抽帧 tick 不再取消飞行中的分析（现场活锁回归）', () => {
  it('provider 慢于 tick 间隔时只发一次请求、恰好完成一次并显示箭头', async () => {
    const setup = fixture({ intervalMs: 3000 });
    await setup.start();
    setup.analyze.mockImplementationOnce(async input => {
      setup.calls.push(setup.controls.time);
      await new Promise(resolve => setTimeout(resolve, 4000));
      return stepResponse(input);
    });
    await setup.runtime.ask('请教我调整文字大小');
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
    const input = setup.analyze.mock.calls[0][0];
    expect(input.reason).toBe('question');
    // 4 秒分析期间有 tick（t≈3s / t≈6s），画面持续变化
    setup.controls.labels.push('帮助');
    await advance(setup, 3000);
    expect(input.signal.aborted).toBe(false);
    setup.controls.labels.push('文件');
    await advance(setup, 3000);
    expect(input.signal.aborted).toBe(false);
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.calls).toHaveLength(1);
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    expect(setup.runtime.snapshot().analysis.state).toBe('ready');
    expect(setup.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, label: '显示' }));
  });

  it('本人点核验的分析不被 tick 取消，跑到完成并记录；期间无重复请求', async () => {
    const setup = fixture({ intervalMs: 3000 });
    await setup.start();
    await setup.runtime.ask('请教我调整文字大小');
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });

    setup.analyze.mockImplementationOnce(async input => {
      setup.calls.push(setup.controls.time);
      await new Promise(resolve => setTimeout(resolve, 6500));
      return completedResponse(input);
    });
    setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
    await setup.runtime.verify();
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledTimes(2));
    const input = setup.analyze.mock.calls[1][0];
    expect(input.reason).toBe('verification');
    setup.controls.labels.push('帮助');
    await advance(setup, 3000);
    expect(input.signal.aborted).toBe(false);
    setup.controls.labels.push('文件');
    await advance(setup, 3000);
    expect(input.signal.aborted).toBe(false);
    await advance(setup, 1000);
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledTimes(2);
    expect(setup.runtime.snapshot().task.state).toBe('completed');
    expect(setup.records).toHaveLength(1);
    expect(setup.records[0]!.result).toBe('completed');
  });

  it('核验失败透出真实原因，不再落到"未获得可核验的结果"', async () => {
    const setup = fixture({ intervalMs: 60000 });
    await setup.start();
    await setup.runtime.ask('请教我调整文字大小');
    await setup.runtime.whenIdle();
    setup.analyze.mockImplementationOnce(async input => ({ ...identity(input), kind: 'step', instruction: '请打开下一步。',
      target_id: 'element_not_present', presentation: 'confirmed', expected_labels: [] }));
    setup.controls.labels = ['设置', '显示', '字体大小', '返回'];
    await setup.runtime.verify();
    await setup.runtime.whenIdle();
    const state = setup.runtime.snapshot();
    expect(state.task.state).toBe('needs_help');
    expect(state.analysis.state).toBe('error');
    expect(state.analysis.message).toContain('找不到唯一位置');
    expect(state.analysis.message).not.toContain('本次分析未获得可核验的结果');
    expect(state.analysis.message).not.toContain('正在分析画面');
    expect(setup.onTarget).toHaveBeenLastCalledWith(null);
    expect(setup.records).toEqual([]);
  });

  it('采集范围在分析期间变化时明确作废该次分析，不静默停在"正在分析画面"', async () => {
    const setup = fixture({ intervalMs: 1000 });
    await setup.start();
    const pending = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => pending.promise);
    await setup.runtime.ask('请教我调整文字大小');
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
    const input = setup.analyze.mock.calls[0][0];
    setup.source.capture.mockImplementationOnce(async () => {
      const frame = syntheticFrame(setup.controls.geometry, ++setup.controls.time);
      frame.sourceId = 'screen:other:0';
      return frame;
    });
    await advance(setup, 3000);
    expect(input.signal.aborted).toBe(true);
    const state = setup.runtime.snapshot();
    expect(state.analysis.state).not.toBe('analyzing');
    expect(state.analysis.message).toContain('采集范围');
    expect(state.task.state).toBe('needs_help');
    pending.resolve(stepResponse(input));
    await setup.runtime.whenIdle();
    expect(setup.onTarget.mock.calls.every(([target]) => target === null)).toBe(true);
  });
});

describe('本人动作仍然立即取消并清理', () => {
  it('结束观察立即取消飞行中的分析，迟到结果不安装', async () => {
    const setup = fixture({ intervalMs: 1000 });
    await setup.start();
    const pending = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => pending.promise);
    await setup.runtime.ask('请教我调整文字大小');
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
    const input = setup.analyze.mock.calls[0][0];
    setup.controls.labels.push('变化');
    await advance(setup, 2000);
    expect(input.signal.aborted).toBe(false);
    await setup.runtime.stopObservation('user');
    expect(input.signal.aborted).toBe(true);
    expect(setup.runtime.snapshot().observation.state).toBe('stopped');
    expect(setup.runtime.snapshot().analysis.state).not.toBe('analyzing');
    pending.resolve(stepResponse(input));
    await setup.runtime.whenIdle();
    expect(setup.onTarget.mock.calls.every(([target]) => target === null)).toBe(true);
  });

  it('重新提问立即接管：旧请求取消、新问题马上发出，不被 tick 抢占', async () => {
    const setup = fixture({ intervalMs: 1000 });
    await setup.start();
    const pending = deferred<AnalysisResult>();
    setup.analyze.mockImplementationOnce(() => pending.promise);
    await setup.runtime.ask('第一个问题，调整文字大小');
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
    const first = setup.analyze.mock.calls[0][0];
    setup.controls.labels.push('变化');
    await advance(setup, 2000);
    expect(first.signal.aborted).toBe(false);
    setup.analyze.mockImplementation(async input => {
      setup.calls.push(setup.controls.time);
      return stepResponse(input);
    });
    await setup.runtime.ask('第二个问题，打开显示设置');
    await setup.runtime.whenIdle();
    expect(first.signal.aborted).toBe(true);
    expect(setup.analyze).toHaveBeenCalledTimes(2);
    expect(setup.analyze.mock.calls[1][0]).toMatchObject({ reason: 'question', question: '第二个问题，打开显示设置' });
    expect(setup.runtime.snapshot().task).toMatchObject({ question: '第二个问题，打开显示设置', state: 'awaiting_action' });
    pending.resolve(stepResponse(first));
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().task.question).toBe('第二个问题，打开显示设置');
    expect(setup.records.map(record => record.question)).toEqual(['第一个问题，调整文字大小']);
  });
});

describe('周期补发的最小间隔与慢响应退避', () => {
  it('画面持续变化时周期分析遵守 6 秒最小间隔，不再每个 tick 都发', async () => {
    const setup = fixture({ intervalMs: 1000 });
    await setup.start();
    setup.analyze.mockImplementation(async input => {
      setup.calls.push(setup.controls.time);
      return { ...identity(input), kind: 'unsupported', instruction: '当前不支持该功能。' };
    });
    await setup.runtime.ask('请教我调整文字大小');
    await setup.runtime.whenIdle();
    expect(setup.calls).toHaveLength(1);
    for (let index = 0; index < 14; index += 1) {
      churnLabels(setup.controls, index);
      await advance(setup, 1000, 250);
    }
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().observation.state).toBe('observing');
    const gaps = setup.calls.slice(1).map((at, index) => at - setup.calls[index]!);
    expect(setup.calls.length).toBeGreaterThanOrEqual(2);
    expect(gaps.every(gap => gap >= 6000 && gap <= 7000)).toBe(true);
    expect(setup.calls.length).toBeLessThanOrEqual(4);
  });

  it('连续慢响应把补发间隔退避到 12 秒且期间不取消', async () => {
    const setup = fixture({ intervalMs: 1000 });
    await setup.start();
    let firstCall = true;
    setup.analyze.mockImplementation(async input => {
      setup.calls.push(setup.controls.time);
      if (firstCall) {
        firstCall = false;
        await new Promise(resolve => setTimeout(resolve, 4000));
      }
      return { ...identity(input), kind: 'unsupported', instruction: '当前不支持该功能。' };
    });
    await setup.runtime.ask('请教我调整文字大小');
    await vi.waitFor(() => expect(setup.analyze).toHaveBeenCalledOnce());
    const input = setup.analyze.mock.calls[0][0];
    for (let index = 0; index < 20; index += 1) {
      churnLabels(setup.controls, index);
      await advance(setup, 1000, 250);
    }
    expect(input.signal.aborted).toBe(false);
    await setup.runtime.whenIdle();
    expect(setup.runtime.snapshot().observation.state).toBe('observing');
    // 第一次慢响应（4 秒 > 3 秒阈值）之后，补发间隔应从 6 秒退避到 12 秒。
    const gaps = setup.calls.slice(1).map((at, index) => at - setup.calls[index]!);
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    expect(gaps.every(gap => gap >= 12000)).toBe(true);
    expect(setup.analyze.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe('trace 事件（写入临时目录，不碰用户日志）', () => {
  it('合并 tick 与延后补发都留下可诊断事件', async () => {
    const originalAppData = process.env.APPDATA;
    const directory = await mkdtemp(join(tmpdir(), 'nuanban-guidance-trace-'));
    process.env.APPDATA = directory;
    delete process.env.NUANBAN_GUIDANCE_TRACE;
    try {
      vi.resetModules();
      const { createDesktopRuntime: create } = await import('../../apps/desktop/runtime-coordinator.cjs');
      vi.useFakeTimers();
      const controls = { time: Date.now(), labels: ['设置', '显示', '文本大小', '返回'] };
      const source: RuntimeOptions['source'] = {
        capture: vi.fn(async () => syntheticFrame(defaultGeometry, ++controls.time)),
        detect: vi.fn<RuntimeOptions['source']['detect']>(async frame => syntheticDetection(frame, controls.labels)),
        stop: vi.fn(async () => undefined),
      };
      let call = 0;
      const analyze = vi.fn<(input: AnalysisInput) => Promise<AnalysisResult>>(async input => {
        call += 1;
        if (call === 2) await new Promise(resolve => setTimeout(resolve, 4000));
        return { ...identity(input), kind: 'unsupported', instruction: '当前不支持该功能。' };
      });
      const runtime = create({ source, analyzer: { analyze }, intervalMs: 1000, now: () => controls.time, onTarget: () => undefined });
      runtimes.push(runtime);
      await runtime.startObservation({ actor: 'owner', confirmed: true, sourceId: 'screen:test:0', cloudConsent: true });
      await runtime.whenIdle();
      await runtime.ask('请教我调整文字大小');
      await runtime.whenIdle();
      // 第 1 次已 settle；持续变化的画面先被最小间隔延后，随后发出第 2 次慢请求，飞行期间 tick 只合并。
      for (let index = 0; index < 10; index += 1) {
        churnLabels(controls, index);
        controls.time += 1000;
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(analyze).toHaveBeenCalledTimes(2);
      const log = await readFile(join(directory, '@nuanban', 'desktop', 'guidance-trace.log'), 'utf8');
      expect(log).toContain('"event":"analysis_settled"');
      expect(log).toContain('"event":"analysis_recheck_scheduled"');
      expect(log).toContain('"event":"analysis_deferred"');
      expect(log).not.toContain('token');
      await runtime.stopObservation('user');
    } finally {
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
      vi.resetModules();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('源码约束（静态检查，不替代上面的假时钟行为验证）', () => {
  const script = readFileSync(new URL('../../apps/desktop/runtime-coordinator.cjs', import.meta.url), 'utf8');

  it('周期 tick 只合并/延后并留下可诊断事件，补发有最小间隔与退避', () => {
    expect(script).toContain("traceGuidance('analysis_deferred'");
    expect(script).toContain("traceGuidance('analysis_recheck_scheduled'");
    expect(script).toContain("traceGuidance('analysis_settled'");
    expect(script).toContain("traceGuidance('analysis_preempted'");
    expect(script).toContain("traceGuidance('analysis_skipped'");
    expect(script).toContain("traceGuidance('analysis_abandoned'");
    expect(script).toContain("const ownerAction = reason !== 'page_changed' || dispatch.urgent === true;");
    expect(script).toContain('const analysisRecheckMinMs = 6000;');
    expect(script).toContain('const analysisRecheckMaxMs = 24000;');
    expect(script).toContain('analysisSlowStreak = Math.min(analysisSlowStreak + 1, 3)');
    // 周期分支不再 abort：只有本人动作分支才允许取消飞行中的请求。
    const periodicBranch = script.indexOf('if (!ownerAction) {');
    const preemptBranch = script.indexOf('analysisController?.abort();', periodicBranch);
    expect(periodicBranch).toBeGreaterThan(0);
    expect(preemptBranch).toBeGreaterThan(periodicBranch);
    expect(script.slice(periodicBranch, preemptBranch)).not.toContain('abort()');
  });

  it('核验与安装失败给出真实原因，兜底文案只作最后手段', () => {
    for (const code of ['target_not_in_current_frame', 'completion_not_verified', 'completion_geometry_unverified',
      'previous_step_not_verified', 'stale_analysis_frame', 'stale_analysis', 'invalid_analysis', 'invalid_analysis_labels',
      'invalid_analysis_kind', 'ANALYSIS_CANCELLED']) {
      expect(script).toContain(`${code}:`);
    }
    expect(script).toContain("typeof error?.message === 'string' && Object.hasOwn(analysisFailureMessages, error.message)");
    expect(script).toContain('本次分析未获得可核验的结果');
  });
});