import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createUiaGuidanceSession, classifyReview, DEFAULT_GUIDANCE_MODE, GUIDANCE_REASONS, parseControlChoice, reasonInfo } from '../../apps/desktop/observation/uia-guidance.cjs';
import { checkedControlItems, UIA_LIMITS } from '../../apps/desktop/observation/uia-inventory.cjs';

// 无截屏指引：假 UIA 清单 + 假 provider，不碰真实网络、不读真实桌面、不抓屏。

function rawControl(index: number, overrides: Record<string, unknown> = {}) {
  return { index, name: `控件${index}`, controlType: 'ControlType.Button', enabled: true, offscreen: false, focus: false, depth: 2,
    x: 10 * index, y: 20, width: 80, height: 30, ...overrides };
}
const controlsOf = (items: unknown[]) => checkedControlItems(items, { ...UIA_LIMITS });
function inventory(controls: unknown[], overrides: Record<string, unknown> = {}) {
  return { status: 'complete', reason: undefined, windowKey: 'window-a', focusedIndex: 0, truncated: false,
    counts: { total: controls.length, limit: 400 }, controls, ...overrides };
}
function unavailable(reason: string) {
  return { status: 'unavailable', reason, windowKey: null, truncated: false, counts: { total: 0, limit: 400 }, controls: [] };
}

function fixture(options: { readings?: unknown[]; replies?: unknown[]; consent?: boolean; isRestrictedText?: (value: unknown) => boolean } = {}) {
  const readings = [...(options.readings ?? [inventory(controlsOf([rawControl(1), rawControl(2)]))])];
  const readCalls: number[] = [];
  const inventoryPort = {
    async read() {
      readCalls.push(readCalls.length + 1);
      const next = readings.length > 1 ? readings.shift()! : readings[0];
      if (next instanceof Error) throw next;
      return next;
    },
    async stop() {},
  };
  const replies = [...(options.replies ?? ['{"kind":"control","control":1,"instruction":"请亲手单击第一个按钮。"}'])];
  const chooserInputs: Record<string, unknown>[] = [];
  const chooser = vi.fn(async (input: Record<string, unknown>) => { chooserInputs.push(input); return { text: String(replies.length > 1 ? replies.shift()! : replies[0]) }; });
  const events: { event: string; detail: Record<string, unknown> }[] = [];
  const session = createUiaGuidanceSession({ inventory: inventoryPort, chooser,
    isRestrictedText: options.isRestrictedText ?? (value => /密码|银行卡|@/.test(String(value))),
    hasConsent: () => options.consent !== false, trace: (event, detail) => events.push({ event, detail: detail ?? {} }), now: () => 1234 });
  return { session, inventoryPort, readCalls, chooser, chooserInputs, events, replies };
}

describe('无截屏指引：模型只选序号，坐标由本机给出', () => {
  it('模型回答"第 2 号"时用本机 UIA 的矩形画箭头，外发内容只有文本清单', async () => {
    const setup = fixture({ readings: [inventory(controlsOf([rawControl(1), rawControl(2)])), inventory(controlsOf([rawControl(1), rawControl(2)]))],
      replies: ['{"kind":"control","control":2,"instruction":"请亲手单击第二个按钮。"}'] });
    const result = await setup.session.ask('帮我找到设置按钮');
    expect(result).toMatchObject({ status: 'ready', code: 'ok', instruction: '请亲手单击第二个按钮。', counts: { count: 2, limit: 400, truncated: false } });
    expect(result.target).toMatchObject({ number: 2, name: '控件2', label: '按钮', rect: { x: 20, y: 20, width: 80, height: 30 } });
    expect(setup.chooser).toHaveBeenCalledOnce();
    const payload = setup.chooserInputs[0]!;
    expect(Object.keys(payload).sort()).toEqual(['count', 'list', 'question', 'signal', 'truncated'].sort());
    expect(payload.question).toBe('帮我找到设置按钮');
    // 外发内容只有文本行：没有帧、没有图片、没有 sanitizedPng 之类字段。
    expect(JSON.stringify(payload)).not.toContain('sanitizedPng');
    expect(JSON.stringify(payload)).not.toContain('image');
    // 画箭头前再读一次本机清单（第二次读取），并且诊断事件不含控件名或矩形。
    expect(setup.readCalls).toHaveLength(2);
    const traceText = JSON.stringify(setup.events);
    expect(traceText).not.toContain('控件1');
    expect(traceText).not.toContain('"rect"');
    expect(setup.events.map(entry => entry.event)).toEqual(['uia_inventory', 'uia_choice_request', 'uia_choice_reply', 'uia_target']);
    expect(setup.session.snapshot()).toMatchObject({ mode: DEFAULT_GUIDANCE_MODE, modeLabel: '无截屏（默认）', screenshotFree: true, active: true, textConsent: true,
      counts: { count: 2, limit: 400, truncated: false } });
  });

  it('敏感控件名在离开本机前被隐藏，且仍可让模型按类型/位置选择', async () => {
    const controls = controlsOf([rawControl(1, { name: '银行卡密码.txt' }), rawControl(2, { name: '设置' })]);
    const setup = fixture({ readings: [inventory(controls), inventory(controls)], replies: ['{"kind":"control","control":2,"instruction":"请亲手单击设置。"}'] });
    const result = await setup.session.ask('帮我打开设置');
    expect(result).toMatchObject({ status: 'ready', code: 'sensitive_name_redacted' });
    const sent = JSON.stringify(setup.chooserInputs[0]);
    expect(sent).not.toContain('银行卡密码');
    expect(sent).toContain('（名称已隐藏）');
    expect(sent).toContain('设置');
  });

  it('名称全都不可读（自绘界面）时明确提示需要截一帧，不假装指引', async () => {
    const controls = controlsOf([rawControl(1, { name: '···' }), rawControl(2, { name: '---' })]);
    const setup = fixture({ readings: [inventory(controls)] });
    const result = await setup.session.ask('帮我打开设置');
    expect(result).toMatchObject({ status: 'blocked', code: 'names_unreadable', suggestSingleFrame: true });
    expect(result.message).toContain('需要你允许截一帧');
    expect(setup.chooser).not.toHaveBeenCalled();
  });

  it('清单为空或读不到时给出具体原因，不画箭头', async () => {
    const empty = fixture({ readings: [inventory([])] });
    expect(await empty.session.ask('帮我打开设置')).toMatchObject({ status: 'blocked', code: 'no_uia_controls', suggestSingleFrame: true });
    const self = fixture({ readings: [unavailable('foreground_is_self')] });
    expect(await self.session.ask('帮我打开设置')).toMatchObject({ status: 'blocked', code: 'foreground_is_self' });
    const failed = fixture({ readings: [unavailable('uia_inventory_unavailable')] });
    expect(await failed.session.ask('帮我打开设置')).toMatchObject({ status: 'blocked', code: 'inventory_unavailable' });
    expect(empty.session.snapshot()).toMatchObject({ active: false, reasonCode: 'no_uia_controls', severity: 'blocked', suggestSingleFrame: true });
  });

  it('没有本人对"发送控件文本"的同意时，一个字都不外发', async () => {
    const setup = fixture({ consent: false });
    const result = await setup.session.ask('帮我打开设置');
    expect(result).toMatchObject({ status: 'blocked', code: 'consent_required', severity: 'blocked' });
    expect(result.message).toContain('不发送任何画面');
    expect(setup.readCalls).toHaveLength(0);
    expect(setup.chooser).not.toHaveBeenCalled();
    expect(setup.session.snapshot()).toMatchObject({ textConsent: false, reasonCode: 'consent_required' });
  });

  it('问题为空、超长或含隐私词时不读清单、不外发', async () => {
    const setup = fixture({ isRestrictedText: value => String(value).includes('验证码') });
    for (const question of ['', '   ', '字'.repeat(501), '帮我输入验证码123456']) {
      expect(await setup.session.ask(question)).toMatchObject({ status: 'blocked', code: 'question_blocked' });
    }
    expect(setup.readCalls).toHaveLength(0);
    expect(setup.chooser).not.toHaveBeenCalled();
  });

  it.each([
    ['{"kind":"no_match","reason":"清单里没有设置"}', 'model_no_match'],
    ['{"kind":"control","control":9,"instruction":"点它"}', 'choice_out_of_range'],
    ['{"kind":"control","control":1.5,"instruction":"点它"}', 'invalid_choice'],
    ['{"kind":"control","control":1,"instruction":"点它","rect":{"x":1,"y":2,"width":3,"height":4}}', 'coordinates_rejected'],
    ['{"kind":"control","control":1,"instruction":"点它","x":10,"y":20}', 'coordinates_rejected'],
    ['not-json-at-all', 'invalid_choice'],
    ['{"kind":"control","control":1}', 'invalid_choice'],
  ] as const)('模型回答不合格时 fail closed：%s', async (reply, code) => {
    const setup = fixture({ readings: [inventory(controlsOf([rawControl(1)])), inventory(controlsOf([rawControl(1)]))], replies: [reply] });
    const result = await setup.session.ask('帮我打开设置');
    expect(result).toMatchObject({ status: 'blocked', code });
    expect(result).not.toHaveProperty('target');
  });

  it('模型选中的控件在画箭头前消失时放弃，不按旧位置指', async () => {
    const setup = fixture({ readings: [inventory(controlsOf([rawControl(1), rawControl(2)])), inventory(controlsOf([rawControl(3)]))],
      replies: ['{"kind":"control","control":2,"instruction":"点它"}'] });
    expect(await setup.session.ask('帮我打开设置')).toMatchObject({ status: 'blocked', code: 'element_gone' });
    expect(setup.events.map(entry => entry.event)).toContain('uia_target_rejected');
  });

  it('模型调用失败或超时按 provider_failed 处理，不生成假结果', async () => {
    const setup = fixture({ readings: [inventory(controlsOf([rawControl(1)]))] });
    setup.chooser.mockRejectedValueOnce(new Error('network down'));
    expect(await setup.session.ask('帮我打开设置')).toMatchObject({ status: 'blocked', code: 'provider_failed' });
  });

  it('截断的清单在界面与模型侧都标注，不假装完整', async () => {
    const setup = fixture({ readings: [inventory(controlsOf([rawControl(1)]), { truncated: true }), inventory(controlsOf([rawControl(1)]), { truncated: true })],
      replies: ['{"kind":"control","control":1,"instruction":"点它"}'] });
    const result = await setup.session.ask('帮我打开设置');
    expect(result).toMatchObject({ status: 'ready', code: 'list_truncated', counts: { truncated: true } });
    expect(setup.chooserInputs[0]!.truncated).toBe(true);
  });
});

describe('无截屏指引：复核三态只依据本机控件树', () => {
  it('控件树未变化 → unchanged（提示可能没点到）', async () => {
    const controls = controlsOf([rawControl(1), rawControl(2)]);
    const setup = fixture({ readings: [inventory(controls), inventory(controls), inventory(controls)] });
    await setup.session.ask('帮我找到设置');
    const reviewed = await setup.session.review();
    expect(reviewed).toMatchObject({ status: 'unchanged', code: 'review_unchanged', verdict: { verdict: 'unchanged', detail: 'no_change' } });
    expect(setup.chooser).toHaveBeenCalledOnce();
    expect(reviewed.instruction).toBe('请亲手单击第一个按钮。');
  });

  it('前台窗口或控件变化 → advanced，并按新清单给出下一步', async () => {
    const first = controlsOf([rawControl(1), rawControl(2)]);
    const second = controlsOf([rawControl(1, { name: '设置' }), rawControl(2, { name: '显示' })]);
    const setup = fixture({ readings: [inventory(first), inventory(first), inventory(second, { windowKey: 'window-b' }), inventory(second, { windowKey: 'window-b' })],
      replies: ['{"kind":"control","control":1,"instruction":"请亲手单击第一个按钮。"}', '{"kind":"control","control":2,"instruction":"请亲手单击“显示”。"}'] });
    await setup.session.ask('帮我找到设置');
    const reviewed = await setup.session.review();
    expect(reviewed).toMatchObject({ status: 'advanced', code: 'review_advanced', verdict: { verdict: 'advanced', detail: 'window_changed' } });
    expect(reviewed.next).toMatchObject({ status: 'ready', instruction: '请亲手单击“显示”。' });
    expect(reviewed.next!.target).toMatchObject({ number: 2, name: '显示' });
    expect(setup.chooser).toHaveBeenCalledTimes(2);
    expect(setup.session.snapshot()).toMatchObject({ active: true, review: { verdict: 'advanced', detail: 'window_changed' } });
  });

  it('读不到清单时 → unverifiable，不猜结果', async () => {
    const controls = controlsOf([rawControl(1)]);
    const setup = fixture({ readings: [inventory(controls), inventory(controls), unavailable('uia_inventory_unavailable')] });
    await setup.session.ask('帮我找到设置');
    const reviewed = await setup.session.review();
    expect(reviewed).toMatchObject({ status: 'unverifiable', code: 'review_unverifiable' });
    expect(setup.chooser).toHaveBeenCalledOnce();
  });

  it('没有已给出步骤时复核直接说明无法确认', async () => {
    const setup = fixture({});
    expect(await setup.session.review()).toMatchObject({ status: 'unverifiable', code: 'review_unverifiable' });
  });

  it('classifyReview 的三态判定覆盖窗口、目标、位移、焦点与控件数量变化', () => {
    const target = { nameKey: '设置', controlType: 'ControlType.Button', rect: { x: 10, y: 20, width: 80, height: 30 }, focused: false };
    const previous = { windowKey: 'window-a', focusedIndex: 0, candidateCount: 2, target };
    const current = (items: unknown[], overrides: Record<string, unknown> = {}) => inventory(controlsOf(items), overrides);
    expect(classifyReview({ previous, current: current([rawControl(1, { name: '设置' }), rawControl(2)]) })).toMatchObject({ verdict: 'unchanged' });
    expect(classifyReview({ previous, current: current([rawControl(1, { name: '设置' }), rawControl(2)], { windowKey: 'window-b' }) })).toMatchObject({ verdict: 'advanced', detail: 'window_changed' });
    expect(classifyReview({ previous, current: current([rawControl(2), rawControl(3)]) })).toMatchObject({ verdict: 'advanced', detail: 'target_gone' });
    expect(classifyReview({ previous, current: current([rawControl(1, { name: '设置', x: 400 }), rawControl(2)]) })).toMatchObject({ verdict: 'advanced', detail: 'target_moved' });
    expect(classifyReview({ previous, current: current([rawControl(1, { name: '设置' }), rawControl(2)], { focusedIndex: 2 }) })).toMatchObject({ verdict: 'advanced', detail: 'focus_changed' });
    expect(classifyReview({ previous, current: current([rawControl(1, { name: '设置' }), rawControl(2), rawControl(3), rawControl(4), rawControl(5)]) })).toMatchObject({ verdict: 'advanced', detail: 'controls_changed' });
    expect(classifyReview({ previous, current: unavailable('x') })).toMatchObject({ verdict: 'unverifiable' });
    expect(classifyReview({ previous: null, current: current([rawControl(1)]) })).toMatchObject({ verdict: 'unverifiable' });
    expect(classifyReview({})).toMatchObject({ verdict: 'unverifiable' });
  });
});

describe('无截屏指引：序号解析与原因码', () => {
  it('只接受整数序号与"无匹配"，坐标字段一律拒绝', () => {
    expect(parseControlChoice('{"kind":"control","control":3,"instruction":"点它"}', 5)).toEqual({ kind: 'control', number: 3, instruction: '点它' });
    expect(parseControlChoice('```json\n{"kind":"control","control":1,"instruction":"点它"}\n```', 5)).toMatchObject({ kind: 'control', number: 1 });
    expect(parseControlChoice('{"kind":"no_match","reason":"没有"}', 5)).toEqual({ kind: 'no_match', reason: '没有' });
    expect(parseControlChoice('{"kind":"no_match"}', 5)).toEqual({ kind: 'no_match', reason: '' });
    expect(parseControlChoice('{"kind":"control","control":0,"instruction":"点它"}', 5)).toMatchObject({ kind: 'invalid', code: 'choice_out_of_range' });
    expect(parseControlChoice('{"kind":"control","control":6,"instruction":"点它"}', 5)).toMatchObject({ kind: 'invalid', code: 'choice_out_of_range' });
    expect(parseControlChoice('{"kind":"control","control":"2","instruction":"点它"}', 5)).toMatchObject({ kind: 'invalid', code: 'invalid_choice' });
    expect(parseControlChoice('{"kind":"control","control":2,"instruction":"点它","y":1}', 5)).toMatchObject({ kind: 'invalid', code: 'coordinates_rejected' });
    expect(parseControlChoice('{"kind":"step","control":2,"instruction":"点它"}', 5)).toMatchObject({ kind: 'invalid' });
    expect(parseControlChoice('{"kind":"control","control":2,"instruction":"点它","extra":1}', 5)).toMatchObject({ kind: 'invalid' });
    expect(parseControlChoice(null, 5)).toMatchObject({ kind: 'invalid' });
  });

  it('每个原因码都有中文说明，未知名按失败关闭处理', () => {
    for (const [code, info] of Object.entries(GUIDANCE_REASONS)) {
      expect(info.code).toBe(code);
      expect(info.message.length).toBeGreaterThan(8);
      expect(['info', 'blocked']).toContain(info.severity);
    }
    expect(reasonInfo('no_uia_controls').suggestSingleFrame).toBe(true);
    expect(reasonInfo('not_a_real_code')).toMatchObject({ code: 'not_a_real_code', severity: 'blocked' });
    expect(reasonInfo(undefined).code).toBe('unknown');
  });
});

describe('无截屏路径的源码约束（静态检查）', () => {
  const provider = readFileSync(new URL('../../apps/desktop/provider-analysis.cjs', import.meta.url), 'utf8');

  it('选控件客户端只发文本，不传图片、不读帧', () => {
    const start = provider.indexOf('function createControlChoiceAnalysisClient');
    const client = provider.slice(start);
    expect(start).toBeGreaterThan(0);
    expect(client).toContain('provider.answer({ question: input.question, signal: input.signal, instructions })');
    expect(client).not.toContain('image');
    expect(client).not.toContain('sanitizedPng');
    expect(client).not.toContain('nativeImage');
    expect(client).not.toContain('isAdmittedFrame');
    expect(client).toContain('绝对不要输出坐标');
  });
});