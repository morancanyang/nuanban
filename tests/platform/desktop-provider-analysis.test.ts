import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { AnalysisInput } from '../../apps/desktop/runtime-coordinator.cjs';
import type { AiProvider, ProviderInput } from '../../apps/desktop/ai-provider.cjs';
import { syntheticDetection, syntheticFrame } from '../helpers/standalone-frame';

const requireModule = createRequire(import.meta.url);
const { createProviderAnalysisClient } = requireModule('../../apps/desktop/provider-analysis.cjs') as typeof import('../../apps/desktop/provider-analysis.cjs');
const { evaluateLocalFrame } = requireModule('../../apps/desktop/observation-policy.cjs') as typeof import('../../apps/desktop/observation-policy.cjs');
function requestInput(timestamp = Date.now()): AnalysisInput {
  const raw = syntheticFrame(undefined, timestamp);
  const frame = evaluateLocalFrame(raw, syntheticDetection(raw), { now: timestamp });
  if (frame.decision !== 'allow') throw new Error('测试帧未放行');
  return { frame, question: '教我调整字体', reason: 'question', observationId: 'observation-test', guideId: 'guide-test',
    observationGeneration: 1, taskGeneration: 2, triggerId: 'trigger-test', previousStep: null, signal: new AbortController().signal, canSend: () => true };
}
function provider(answer: AiProvider['answer']) { return { answer: vi.fn(answer) }; }

describe('桌宠分析中的电脑来源和追问上下文', () => {
  it('本机纯文字模型不会假装看到图片，直接给出需要视觉模型的原因', async () => {
    const input = requestInput();
    const endpoint = { vision: false, modelName: 'qwen2.5:3b', answer: vi.fn(async () => ({ text: '{}' })) };
    await expect(createProviderAnalysisClient({ provider: endpoint }).analyze(input)).rejects.toMatchObject({ code: 'ANALYSIS_VISION_REQUIRED' });
    expect(endpoint.answer).not.toHaveBeenCalled();
  });

  it('最大权限模式放行敏感词提问，默认模式仍然阻断', async () => {
    const input = { ...requestInput(), question: '银行卡密码在哪里设置' };
    const blocked = provider(async () => ({ text: JSON.stringify({ kind: 'clarify', instruction: '请说明目标。' }) }));
    await expect(createProviderAnalysisClient({ provider: blocked }).analyze(input)).rejects.toMatchObject({ code: 'OUTBOUND_CLOSED' });
    expect(blocked.answer).not.toHaveBeenCalled();
    const relaxed = provider(async () => ({ text: JSON.stringify({ kind: 'clarify', instruction: '请说明目标。' }) }));
    await expect(createProviderAnalysisClient({ provider: relaxed, relaxedSafety: true }).analyze(input)).resolves.toMatchObject({ kind: 'clarify' });
    expect(relaxed.answer).toHaveBeenCalledOnce();
  });

  it('任务栏图标保留公共来源和像素位置，模型只选择已经核验的入口', async () => {
    const timestamp = Date.now();
    const raw = syntheticFrame(undefined, timestamp);
    const detection = { ...syntheticDetection(raw, []), sourceId: raw.sourceId,
      shellControls: [{ label: '微信', surface: 'taskbar' as const, rect: { x: 220, y: 540, width: 44, height: 44 } }] };
    const frame = evaluateLocalFrame(raw, detection, { now: timestamp });
    if (frame.decision !== 'allow') throw new Error('missing safe native control');
    const input = { ...requestInput(timestamp), frame, question: '如何打开微信' };
    const endpoint = provider(async () => ({ text: JSON.stringify({ kind: 'step', instruction: '请亲手单击任务栏里的微信图标。', target_id: frame.elements[0].id, presentation: 'confirmed', expected_labels: ['发现'] }) }));
    const result = await createProviderAnalysisClient({ provider: endpoint, now: () => timestamp }).analyze(input);
    expect(result).toMatchObject({ kind: 'step', target_id: frame.elements[0].id });
    const sent = endpoint.answer.mock.calls[0][0];
    const context = JSON.parse(sent.instructions!.split('当前最小上下文：')[1]);
    expect(context.elements).toEqual([{ id: frame.elements[0].id, label: '微信', rect: detection.shellControls[0].rect, surface: 'taskbar' }]);
    expect(context.view).toBe('controls_only_layout');
    expect(sent.instructions).toContain('本人单击');
    expect(sent.image!.bytes).not.toEqual(raw.png);
  });

  it('保留原问题并最小化投影追问回答，不再让模型猜电脑还是手机', async () => {
    const input = requestInput();
    input.clarificationReplies = [{ prompt: '请确认应用名称。', answer: '微信' }];
    const endpoint = provider(async () => ({ text: JSON.stringify({ kind: 'clarify', instruction: '请核对观察范围。' }) }));
    await createProviderAnalysisClient({ provider: endpoint }).analyze(input);
    const sent = endpoint.answer.mock.calls[0][0];
    const context = JSON.parse(sent.instructions!.split('当前最小上下文：')[1]);
    expect(sent.question).toBe(input.question);
    expect(context).toMatchObject({ surface: 'computer_screen', clarification_replies: [{ question: '请确认应用名称。', answer: '微信' }] });
    expect(sent.instructions).toContain('不要反问是在手机还是电脑上');
    expect(sent.instructions).toContain('不能断言用户屏幕上没有');
    expect(sent.instructions).not.toContain(input.frame.sourceId);
  });

  it('补充回答也参与相关控件优先级选择，但不会创造画面上没有的控件', async () => {
    const input = crowdedInput();
    input.question = '帮我找到那个软件';
    input.clarificationReplies = [{ prompt: '请确认应用名称。', answer: '微信' }];
    const endpoint = provider(async () => ({ text: JSON.stringify({ kind: 'clarify', instruction: '请核对位置。' }) }));
    await createProviderAnalysisClient({ provider: endpoint }).analyze(input);
    const context = JSON.parse(endpoint.answer.mock.calls[0][0].instructions!.split('当前最小上下文：')[1]);
    expect(context.elements[0].label).toBe('微信');
    expect(context.elements.every((element: { id: string }) => input.frame.elements.some(current => current.id === element.id))).toBe(true);
  });

  it.each([
    [{ prompt: '请选择应用', answer: '帮我输入密码' }],
    [{ prompt: '验证码是什么', answer: '123456' }],
    [{ prompt: '请选择应用', answer: '字'.repeat(501) }],
    [{ prompt: '字'.repeat(601), answer: '微信' }],
    [{ prompt: '', answer: '微信' }],
    [{ prompt: '请选择应用', answer: ' ' }],
    [{ prompt: '应用\u0000名称', answer: '微信' }],
    [{ prompt: '请选择应用', answer: '微\u200B信' }],
    [{ prompt: '请选择应用', answer: '微信', unknown: true }],
    Array.from({ length: 4 }, () => ({ prompt: '请选择应用', answer: '微信' })),
  ].map(replies => [replies]))('无效或敏感补充不调用模型：%j', async replies => {
    const endpoint = provider(async () => ({ text: '{}' }));
    await expect(createProviderAnalysisClient({ provider: endpoint }).analyze({ ...requestInput(), clarificationReplies: replies })).rejects.toMatchObject({ code: 'OUTBOUND_CLOSED' });
    expect(endpoint.answer).not.toHaveBeenCalled();
  });

  it.each([null, {}, ['微信'], [undefined], new Array(1)].map(replies => [replies]))('拒绝畸形追问列表：%j', async replies => {
    const endpoint = provider(async () => ({ text: '{}' }));
    await expect(createProviderAnalysisClient({ provider: endpoint }).analyze({ ...requestInput(),
      clarificationReplies: replies as unknown as AnalysisInput['clarificationReplies'] })).rejects.toMatchObject({ code: 'OUTBOUND_CLOSED' });
    expect(endpoint.answer).not.toHaveBeenCalled();
  });
});

function crowdedInput(entry = '微信'): AnalysisInput {
  const raw = syntheticFrame();
  const detection = syntheticDetection(raw, []);
  detection.words = [...Array.from({ length: 70 }, () => '设置'), entry, '发现', '同事小李', '未公开项目.docx']
    .map((text, index) => ({ text, rect: { x: 10 + index % 8 * 95, y: 10 + Math.floor(index / 8) * 35, width: 80, height: 24 } }));
  const frame = evaluateLocalFrame(raw, detection);
  if (frame.decision !== 'allow') throw new Error('测试帧未放行');
  return { ...requestInput(), frame, question: '如何打开微信朋友圈' };
}

describe('指定模型到桌宠只读教学适配（合成供应测试）', () => {
  it('缺配置时不可用，无默认教学答案', async () => {
    const client = createProviderAnalysisClient();
    expect(client.capabilities().configured).toBe(false);
    await expect(client.analyze(requestInput())).rejects.toMatchObject({ code: 'ANALYSIS_UNAVAILABLE' });
  });

  it('只向模型发送脱敏图和有限通用控件，结果身份由本机绑定', async () => {
    const input = requestInput();
    const endpoint = provider(async () => ({ text: JSON.stringify({ kind: 'step', instruction: '请亲手打开文本大小。', target_id: input.frame.elements[2].id, presentation: 'confirmed', expected_labels: ['缩放'] }) }));
    const result = await createProviderAnalysisClient({ provider: endpoint }).analyze(input);
    expect(result).toMatchObject({ kind: 'step', observation_id: input.observationId, guide_id: input.guideId, observation_generation: 1, task_generation: 2, trigger_id: input.triggerId, frame_id: input.frame.frameId, target_id: input.frame.elements[2].id });
    const sent = endpoint.answer.mock.calls[0][0];
    expect(sent.image?.bytes).toBe(input.frame.sanitizedPng);
    expect(sent.question).toBe(input.question);
    expect(sent.instructions).toContain(input.frame.elements[2].id);
    expect(sent.instructions).toContain('本机仍会独立核验');
    expect(sent).not.toHaveProperty('rawFrame');
    expect(sent).not.toHaveProperty('ocrText');
    expect(sent.instructions).not.toContain(input.frame.sourceName);
  });

  it('安全控件布局明确告诉模型这不是原始截图，未知正文不进入上下文', async () => {
    const raw = syntheticFrame();
    const frame = evaluateLocalFrame(raw, syntheticDetection(raw, ['文件', '编辑', '查看', '练习文档', '普通正文', '第二行内容']));
    if (frame.decision !== 'allow') throw new Error('missing projected frame');
    const input = { ...requestInput(), frame };
    const endpoint = provider(async () => ({ text: JSON.stringify({ kind: 'clarify', instruction: '请说明要使用的菜单功能。' }) }));
    await createProviderAnalysisClient({ provider: endpoint }).analyze(input);
    const sent = endpoint.answer.mock.calls[0][0];
    expect(sent.instructions).toContain(JSON.stringify({ view: 'controls_only_layout' }).slice(1, -1));
    expect(sent.instructions).toContain('布局示意图而非原始截图');
    expect(sent.instructions).not.toContain('普通正文');
    expect(sent.instructions).not.toContain('练习文档');
    expect(sent.image?.bytes).toBe(frame.sanitizedPng);
    expect(sent.image?.bytes).not.toEqual(raw.png);
  });

  it.each(['微信', 'WeChat', 'Weixin'])('控件超过 64 个时保留中文问题相关的 %s 入口，不把内部功能缺失当成入口缺失', async entry => {
    const input = crowdedInput(entry);
    const target = input.frame.elements.find(element => element.label === entry)!;
    expect(input.frame.elements.indexOf(target)).toBeGreaterThan(63);
    const endpoint = provider(async () => ({ text: JSON.stringify({ kind: 'step', instruction: '请亲手双击微信图标，打开后再找朋友圈。',
      target_id: target.id, presentation: 'confirmed', expected_labels: ['发现'] }) }));
    const result = await createProviderAnalysisClient({ provider: endpoint }).analyze(input);
    expect(result).toMatchObject({ kind: 'step', target_id: target.id });
    const sent = endpoint.answer.mock.calls[0][0];
    const context = JSON.parse(sent.instructions!.split('当前最小上下文：')[1]);
    expect(context.elements).toHaveLength(64);
    expect(context.elements[0]).toEqual(target);
    expect(sent.instructions).toContain('先指引本人打开该软件');
    expect(sent.instructions).not.toContain('同事小李');
    expect(sent.instructions).not.toContain('未公开项目.docx');
    expect(context.elements.some((element: { label: string }) => element.label === '朋友圈')).toBe(false);
    expect(sent.image?.bytes).toBe(input.frame.sanitizedPng);
  });

  it('后续页面优先保留上一步待核验标签，仍拒绝未实际发送的目标', async () => {
    const input = crowdedInput();
    input.question = '继续下一步';
    input.reason = 'page_changed';
    input.previousStep = { instruction: '请亲手打开软件。', expectedLabels: ['发现'] };
    const target = input.frame.elements.find(element => element.label === '发现')!;
    const excluded = input.frame.elements.find(element => element.label === '微信')!;
    expect(target).toBeDefined();
    expect(excluded).toBeDefined();
    const endpoint = provider(async () => ({ text: JSON.stringify({ kind: 'step', instruction: '请亲手打开发现。',
      target_id: target.id, presentation: 'confirmed', expected_labels: ['朋友圈'] }) }));
    await expect(createProviderAnalysisClient({ provider: endpoint }).analyze(input)).resolves.toMatchObject({ target_id: target.id });
    const context = JSON.parse(endpoint.answer.mock.calls[0][0].instructions!.split('当前最小上下文：')[1]);
    expect(context.elements).toHaveLength(64);
    expect(context.elements[0]).toEqual(target);
    expect(context.elements.some((element: { id: string }) => element.id === excluded.id)).toBe(false);
    const invalid = provider(async () => ({ text: JSON.stringify({ kind: 'step', instruction: '请打开软件。',
      target_id: excluded.id, presentation: 'confirmed', expected_labels: [] }) }));
    await expect(createProviderAnalysisClient({ provider: invalid }).analyze(input)).rejects.toMatchObject({ code: 'INVALID_ANALYSIS_RESPONSE' });
  });

  it('本地门控关闭、过期、伪造准入与敏感问题在发送前被拒绝', async () => {
    const endpoint = provider(async () => ({ text: '{}' }));
    const client = createProviderAnalysisClient({ provider: endpoint });
    const copied = requestInput();
    copied.frame = { ...copied.frame };
    const old = requestInput(Date.now() - 6000);
    const aborted = new AbortController();
    aborted.abort();
    for (const input of [copied, old, { ...requestInput(), canSend: () => false }, { ...requestInput(), question: '帮我输入密码' }, { ...requestInput(), signal: aborted.signal }]) {
      await expect(client.analyze(input)).rejects.toMatchObject({ code: 'OUTBOUND_CLOSED' });
    }
    let checks = 0;
    await expect(client.analyze({ ...requestInput(), canSend: () => ++checks < 2 })).rejects.toMatchObject({ code: 'OUTBOUND_CLOSED' });
    expect(endpoint.answer).not.toHaveBeenCalled();
  });

  it('停止或篡改脱敏图后，不安装迟到结果', async () => {
    const input = requestInput();
    let open = true;
    input.canSend = () => open;
    const endpoint = provider(async () => { open = false; return { text: '{"kind":"clarify","instruction":"迟到内容"}' }; });
    await expect(createProviderAnalysisClient({ provider: endpoint }).analyze(input)).rejects.toMatchObject({ code: 'OUTBOUND_CLOSED' });
    const changed = requestInput();
    const changedProvider = provider(async () => { changed.frame.sanitizedPng.fill(0); return { text: '{"kind":"clarify","instruction":"不采用"}' }; });
    await expect(createProviderAnalysisClient({ provider: changedProvider }).analyze(changed)).rejects.toMatchObject({ code: 'OUTBOUND_CLOSED' });
  });

  it('拒绝命令、伪造目标、额外身份字段、超长和敏感建议', async () => {
    const input = requestInput();
    const invalid = [
      { kind: 'step', instruction: '下一步', target_id: 'not-in-frame', presentation: 'confirmed', expected_labels: [] },
      { kind: 'clarify', instruction: '说明目标', command: 'click' },
      { kind: 'clarify', instruction: '说明目标', task_generation: 999 },
      { kind: 'clarify', instruction: '字'.repeat(601) },
      { kind: 'step', instruction: '请输入验证码', target_id: input.frame.elements[0].id, presentation: 'confirmed', expected_labels: [] },
      { kind: 'completed', instruction: '已经完成', evidence_labels: ['设置'] },
    ];
    for (const reply of invalid) {
      const endpoint = provider(async () => ({ text: JSON.stringify(reply) }));
      await expect(createProviderAnalysisClient({ provider: endpoint }).analyze(input)).rejects.toMatchObject({ code: 'INVALID_ANALYSIS_RESPONSE' });
    }
    await expect(createProviderAnalysisClient({ provider: provider(async () => ({ text: '```json\n{}\n```' })) }).analyze(input)).rejects.toMatchObject({ code: 'INVALID_ANALYSIS_RESPONSE' });
  });

  it('完成仅是带证据的建议，保留后续运行核心的独立核验', async () => {
    const input = requestInput();
    input.reason = 'verification';
    input.previousStep = { instruction: '打开字体设置', expectedLabels: ['字体大小'] };
    const endpoint = provider(async () => ({ text: JSON.stringify({ kind: 'completed', instruction: '请核对字体大小页面。', evidence_labels: ['字体大小'] }) }));
    const result = await createProviderAnalysisClient({ provider: endpoint }).analyze(input);
    expect(result).toMatchObject({ kind: 'completed', evidence_labels: ['字体大小'], task_generation: input.taskGeneration });
    expect(result).not.toHaveProperty('verified');
    expect(result).not.toHaveProperty('mastered');
  });

  it('异常只暴露安全状态，不传播供应商正文', async () => {
    const endpoint = provider(async (_input: ProviderInput) => { throw new Error('private-provider-body'); });
    await expect(createProviderAnalysisClient({ provider: endpoint }).analyze(requestInput())).rejects.toMatchObject({ code: 'ANALYSIS_FAILED', message: 'ANALYSIS_FAILED' });
  });

  it.each([
    ['AUTH_FAILED', 'ANALYSIS_AUTH_FAILED'], ['PROVIDER_UNAVAILABLE', 'ANALYSIS_UNAVAILABLE'],
    ['RATE_LIMITED', 'ANALYSIS_RATE_LIMITED'], ['TIMEOUT', 'ANALYSIS_TIMEOUT'],
    ['STREAM_INTERRUPTED', 'ANALYSIS_RESPONSE_INCOMPLETE'], ['constructor', 'ANALYSIS_FAILED'],
  ])('已知供应故障仅转为固定状态码：%s', async (code, expected) => {
    const endpoint = provider(async () => { throw Object.assign(new Error('private-provider-body'), { code }); });
    await expect(createProviderAnalysisClient({ provider: endpoint }).analyze(requestInput())).rejects.toMatchObject({ code: expected, message: expected });
  });

  it.each(['closed', 'aborted', 'tampered'] as const)('等待本地核验不能凭回调返回值绕过门控：%s', async condition => {
    const input = requestInput();
    const controller = new AbortController();
    input.signal = controller.signal;
    let open = true;
    input.canSend = () => open;
    input.confirmCurrentFrame = vi.fn(async () => {
      open = condition !== 'closed';
      if (condition === 'aborted') controller.abort();
      if (condition === 'tampered') input.frame.sanitizedPng.fill(0);
      return true;
    });
    const endpoint = provider(async () => { open = false; return { text: '{"kind":"clarify","instruction":"请说明目标。"}' }; });
    await expect(createProviderAnalysisClient({ provider: endpoint }).analyze(input)).rejects.toMatchObject({ code: 'OUTBOUND_CLOSED' });
    expect(input.confirmCurrentFrame).toHaveBeenCalledOnce();
    expect(endpoint.answer).toHaveBeenCalledOnce();
  });
});
