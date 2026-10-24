import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../apps/desktop/${name}`, import.meta.url), 'utf8');
type StateListener = (state: unknown) => void;

class UiElement extends EventTarget {
  hidden = false;
  disabled = false;
  value = '';
  textContent = '';
  className = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: UiElement[] = [];
  isFragment = false;
  open = false;
  offsetHeight = 146;
  focus = vi.fn();
  setPointerCapture = vi.fn();
  releasePointerCapture = vi.fn();
  scrollIntoView = vi.fn();
  classList = { toggle: vi.fn() };
  get firstElementChild() { return this.children[0]; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === 'style') this.style = {};
    if (name === 'data-presentation') delete this.dataset.presentation;
  }
  append(...children: UiElement[]) { this.children.push(...children.flatMap(child => child.isFragment ? child.children : [child])); }
  replaceChildren(...children: UiElement[]) { this.children = children.flatMap(child => child.isFragment ? child.children : [child]); }
}

class UiDocument extends EventTarget {
  elements = new Map<string, UiElement>();
  activeElement: UiElement | undefined;
  routes: UiElement[] = [];
  tools: UiElement[] = [];
  constructor(html: string) {
    super();
    for (const match of html.matchAll(/<[a-z][\w-]*\b([^<>]*)>/gi)) {
      const attributes = match[1];
      const identifier = attributes.match(/\bid="([^"]+)"/)?.[1];
      const route = attributes.match(/\bdata-route="([^"]+)"/)?.[1];
      const tool = attributes.match(/\bdata-tool="([^"]+)"/)?.[1];
      if (!identifier && !route && !tool) continue;
      const element = new UiElement();
      element.focus.mockImplementation(() => { this.activeElement = element; });
      element.hidden = /\bhidden\b/.test(attributes);
      element.disabled = /\bdisabled\b/.test(attributes);
      if (identifier) this.elements.set(identifier, element);
      if (route) { element.dataset.route = route; this.routes.push(element); }
      if (tool) { element.dataset.tool = tool; this.tools.push(element); }
    }
  }
  getElementById(name: string) {
    const element = this.elements.get(name);
    if (!element) throw new Error(`Missing fixture element: ${name}`);
    return element;
  }
  querySelectorAll(selector: string) { return selector === '[data-route]' ? this.routes : selector === '[data-tool]' ? this.tools : []; }
  createElement() { return new UiElement(); }
  createDocumentFragment() { const fragment = new UiElement(); fragment.isFragment = true; return fragment; }
}

const dispatch = (target: EventTarget, name: string, fields: Record<string, unknown> = {}) => {
  const event = new Event(name, { cancelable: true });
  for (const [key, value] of Object.entries(fields)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
  return event;
};
const settle = async () => { for (let count = 0; count < 16; count += 1) await Promise.resolve(); };
const cleanups: Array<() => void> = [];

function snapshot(observation: Record<string, unknown> = {}, task: Record<string, unknown> = {}, analysis: Record<string, unknown> = {}) {
  return {
    observation: { state: 'off', captureActive: false, generation: 1, ...observation },
    task: { state: 'idle', generation: 1, observationGeneration: 1, ...task },
    analysis: { state: 'idle', ...analysis },
    captions: { enabled: false, text: '' },
    wake: { state: 'disabled' },
  };
}

function petHarness(initial: unknown = snapshot()) {
  let current = initial;
  let listener: StateListener | undefined;
  let panelListener: StateListener | undefined;
  const document = new UiDocument(source('pet.html'));
  const unsubscribe = vi.fn(() => { listener = undefined; });
  const unsubscribePanel = vi.fn(() => { panelListener = undefined; });
  const bridge = {
    snapshot: vi.fn(async (): Promise<unknown> => current),
    focusInput: vi.fn(async () => true),
    drag: vi.fn(async (_action: string, _point?: { x: number; y: number }) => true),
    onState: vi.fn((callback: StateListener) => { listener = callback; return unsubscribe; }),
    onPanel: vi.fn((callback: StateListener) => { panelListener = callback; return unsubscribePanel; }),
    command: vi.fn(async (_payload: unknown): Promise<unknown> => ({ ok: true })),
    ask: vi.fn(async (_question: string, _observationGeneration?: number): Promise<unknown> => ({ ok: true })),
    dictate: vi.fn(async (_observationGeneration?: number): Promise<unknown> => ({ status: 'cancelled', localOnly: true })),
    cancelDictation: vi.fn(async () => true),
    openMain: vi.fn(async (_route: string) => true),
    openTool: vi.fn(async (_route: string) => true),
    showMenu: vi.fn(async () => true),
    activity: vi.fn(async () => true),
    expand: vi.fn(async () => true),
    collapse: vi.fn(async () => true),
    close: vi.fn(async () => true),
  };
  const window = Object.assign(new EventTarget(), { nuanbanPet: bridge, setInterval: vi.fn(), setTimeout: vi.fn() });
  runInNewContext(source('pet.js'), { window, document, console, Date, CustomEvent });
  cleanups.push(() => dispatch(window, 'pagehide'));
  const element = (name: string) => document.getElementById(name);
  return {
    window, document, bridge, unsubscribe, unsubscribePanel, element,
    emit: (state: unknown) => { current = state; listener?.(state); },
    emitPanel: (panel: unknown) => panelListener?.(panel),
    click: (name: string) => dispatch(element(name), 'click'),
    input: (value: string) => { element('question').value = value; dispatch(element('question'), 'input'); },
    submit: () => dispatch(document.getElementById('question-form'), 'submit'),
  };
}

function preloadHarness(name: string) {
  const exposed: Record<string, Record<string, (...args: unknown[]) => unknown>> = {};
  const handlers = new Map<string, (event: unknown, state: unknown) => void>();
  const ipcRenderer = {
    invoke: vi.fn(async (_channel: string, ..._payload: unknown[]): Promise<unknown> => true),
    on: vi.fn((channel: string, handler: (event: unknown, state: unknown) => void) => handlers.set(channel, handler)),
    removeListener: vi.fn((channel: string) => handlers.delete(channel)),
  };
  runInNewContext(source(name), {
    require: (moduleName: string) => {
      if (moduleName !== 'electron') throw new Error(`Unexpected dependency ${moduleName}`);
      return { contextBridge: { exposeInMainWorld: (key: string, value: Record<string, (...args: unknown[]) => unknown>) => { exposed[key] = value; } }, ipcRenderer };
    },
  });
  return { exposed, ipcRenderer, handlers };
}

function guideHarness() {
  let listener: StateListener | undefined;
  const document = new UiDocument(source('guide.html'));
  const unsubscribe = vi.fn(() => { listener = undefined; });
  const onState = vi.fn((callback: StateListener) => { listener = callback; return unsubscribe; });
  const window = Object.assign(new EventTarget(), { nuanbanGuide: { onState }, innerWidth: 1000, innerHeight: 700, setTimeout: vi.fn(setTimeout), clearTimeout: vi.fn(clearTimeout) });
  runInNewContext(source('guide.js'), { window, document, console, Date });
  cleanups.push(() => dispatch(window, 'pagehide'));
  return { window, unsubscribe, onState, element: (name: string) => document.getElementById(name), emit: (state: unknown) => listener?.(state) };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe('桌宠指引追问的独立回答入口', () => {
  const clarification = (generation = 4) => snapshot({ state: 'observing', captureActive: true, cloudConsent: true, generation: 7 },
    { id: 'guide-wechat', kind: 'guidance', state: 'needs_help', generation, observationGeneration: 7, question: '帮我找到微信',
      explanation: '请核对当前观察范围。', awaitingReply: true }, { state: 'ready' });

  async function openClarification() {
    const harness = petHarness(clarification());
    await settle();
    harness.click('pet-toggle');
    harness.click('feature-guidance');
    harness.input('帮我找到微信');
    return harness;
  }

  it('原问题草稿保留，回答走带追问身份的指令而不是新问题', async () => {
    const harness = await openClarification();
    expect(harness.element('question-form').hidden).toBe(true);
    expect(harness.element('guidance-reply-form').hidden).toBe(false);
    expect(harness.element('guidance-original-question').textContent).toContain('帮我找到微信');
    expect(harness.element('screen-voice-find').textContent).toContain('语音回答并继续');
    harness.element('guidance-answer').value = '微信在电脑左上方';
    dispatch(harness.element('guidance-answer'), 'input');
    expect(harness.element('guidance-send-answer').disabled).toBe(false);
    dispatch(harness.element('guidance-reply-form'), 'submit');
    await settle();
    expect(harness.bridge.command).toHaveBeenCalledWith({ type: 'guidance.reply', text: '微信在电脑左上方', guideId: 'guide-wechat', taskGeneration: 4, observationGeneration: 7 });
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.element('question').value).toBe('帮我找到微信');
    expect(harness.element('caption-line').hidden).toBe(true);
  });

  it('回答失败保留草稿，重识别不把草稿当作新问题发送', async () => {
    const harness = await openClarification();
    harness.element('guidance-answer').value = '电脑左上方';
    harness.bridge.command.mockRejectedValueOnce(new Error('补充未被接受'));
    dispatch(harness.element('guidance-reply-form'), 'submit');
    await settle();
    expect(harness.element('guidance-answer').value).toBe('电脑左上方');
    expect(harness.element('error-text').textContent).toContain('补充未被接受');
    harness.click('guidance-rescan');
    await settle();
    expect(harness.bridge.command).toHaveBeenCalledWith({ type: 'guidance.rescan', guideId: 'guide-wechat', taskGeneration: 4, observationGeneration: 7 });
    expect(harness.bridge.ask).not.toHaveBeenCalled();
  });

  it('改问其他问题恢复原草稿，晚到语音不覆盖新追问的回答', async () => {
    const harness = await openClarification();
    let resolveDictation!: (value: unknown) => void;
    harness.bridge.dictate.mockImplementationOnce(() => new Promise(resolve => { resolveDictation = resolve; }));
    harness.click('screen-voice-find');
    await settle();
    harness.emit(clarification(5));
    harness.element('guidance-answer').value = '新问题的回答草稿';
    resolveDictation({ status: 'complete', text: '旧语音回答', localOnly: true, microphoneActive: false });
    await settle();
    expect(harness.bridge.command.mock.calls.some(([payload]) => (payload as { type: string }).type === 'guidance.reply')).toBe(false);
    expect(harness.element('guidance-answer').value).toBe('新问题的回答草稿');
    expect(harness.element('error-text').textContent).toContain('追问已经变化');
    harness.click('guidance-new-question');
    expect(harness.element('guidance-reply-form').hidden).toBe(true);
    expect(harness.element('question-form').hidden).toBe(false);
    expect(harness.element('question').value).toBe('帮我找到微信');
  });

  it('preload仅投影允许的追问状态和参数，拒绝缺失或无效身份', async () => {
    const harness = preloadHarness('pet-preload.cjs');
    const api = harness.exposed.nuanbanPet;
    harness.ipcRenderer.invoke.mockResolvedValueOnce({ task: { awaitingReply: true, privatePayload: 'discard' } });
    expect(await api.snapshot()).toEqual({ task: { awaitingReply: true } });
    const identity = { guideId: 'guide-wechat', taskGeneration: 4, observationGeneration: 7 };
    await api.command({ type: 'guidance.reply', ...identity, text: '微信', rawFrame: 'discard' });
    expect(harness.ipcRenderer.invoke).toHaveBeenLastCalledWith('nuanban:pet:command', { type: 'guidance.reply', ...identity, text: '微信' });
    await api.command({ type: 'guidance.rescan', ...identity, text: 'discard' });
    expect(harness.ipcRenderer.invoke).toHaveBeenLastCalledWith('nuanban:pet:command', { type: 'guidance.rescan', ...identity });
    for (const invalid of [{ guideId: '' }, { taskGeneration: 0 }, { observationGeneration: NaN }]) {
      expect(() => api.command({ type: 'guidance.reply', ...identity, text: '微信', ...invalid })).toThrow('无效');
    }
    for (const text of ['', ' ', '字'.repeat(501)]) expect(() => api.command({ type: 'guidance.reply', ...identity, text })).toThrow('500');
  });
});

describe('直接按住桌宠拖动', () => {
  const actions = (harness: ReturnType<typeof petHarness>) => harness.bridge.drag.mock.calls.map(([action]) => [action]);
  const press = (harness: ReturnType<typeof petHarness>, fields = {}) => dispatch(harness.element('pet-toggle'), 'pointerdown', { pointerId: 1, button: 0, isPrimary: true, screenX: 100, screenY: 100, ...fields });
  const move = (harness: ReturnType<typeof petHarness>, fields = {}) => dispatch(harness.element('pet-toggle'), 'pointermove', { pointerId: 1, buttons: 1, screenX: 140, screenY: 130, ...fields });
  const release = (harness: ReturnType<typeof petHarness>, fields = {}) => dispatch(harness.element('pet-toggle'), 'pointerup', { pointerId: 1, button: 0, screenX: 100, screenY: 100, ...fields });

  it('小幅抖动仍是单击，按住身体不必再点击移动把手', async () => {
    const harness = petHarness();
    await settle();
    press(harness);
    move(harness, { screenX: 101, screenY: 101 });
    release(harness);
    dispatch(harness.element('pet-toggle'), 'click', { detail: 1 });
    await settle();
    expect(actions(harness)).toEqual([['start'], ['end']]);
    expect(harness.bridge.drag).toHaveBeenCalledWith('start', { x: 100, y: 100 });
    expect(harness.element('pet-panel').hidden).toBe(false);
    expect(harness.element('pet-toggle').setPointerCapture).toHaveBeenCalledWith(1);
    expect(harness.element('pet-toggle').releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it('拖动和释放不误开功能页，下次单击仍可正常打开', async () => {
    const harness = petHarness();
    await settle();
    press(harness);
    expect(move(harness).defaultPrevented).toBe(true);
    release(harness);
    dispatch(harness.element('pet-toggle'), 'click', { detail: 1 });
    await settle();
    expect(harness.element('pet-panel').hidden).toBe(true);
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(actions(harness)).toEqual([['start'], ['move'], ['move'], ['end']]);
    expect(harness.bridge.drag).toHaveBeenCalledWith('move', { x: 140, y: 130 });
    press(harness);
    release(harness);
    dispatch(harness.element('pet-toggle'), 'click', { detail: 1 });
    await settle();
    expect(harness.element('pet-panel').hidden).toBe(false);
    expect(harness.bridge.openMain).not.toHaveBeenCalled();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
  });

  it('指针捕获失败时仍能通过窗口级事件完成拖动', async () => {
    const harness = petHarness();
    await settle();
    harness.element('pet-toggle').setPointerCapture.mockImplementationOnce(() => { throw new Error('capture unavailable'); });
    press(harness);
    dispatch(harness.window, 'pointermove', { pointerId: 1, buttons: 1, screenX: 140, screenY: 130 });
    dispatch(harness.window, 'pointerup', { pointerId: 1, button: 0, screenX: 140, screenY: 130 });
    dispatch(harness.element('pet-toggle'), 'click', { detail: 1 });
    await settle();
    expect(actions(harness)).toEqual([['start'], ['move'], ['move'], ['end']]);
    expect(harness.element('pet-panel').hidden).toBe(true);
  });

  it('快速拖动未收到中间移动事件时，释放位移仍阻止误展开', async () => {
    const harness = petHarness();
    await settle();
    press(harness);
    release(harness, { screenX: 140, screenY: 130 });
    dispatch(harness.element('pet-toggle'), 'click', { detail: 1 });
    await settle();
    expect(actions(harness)).toEqual([['start'], ['move'], ['end']]);
    expect(harness.element('pet-panel').hidden).toBe(true);
  });

  it.each(['pointercancel', 'pointerup'])('窗口级 %s 清理拖动，连续移动不会排队发送 IPC', async eventName => {
    const harness = petHarness();
    await settle();
    press(harness);
    for (let index = 0; index < 80; index += 1) {
      dispatch(harness.window, 'pointermove', { pointerId: 1, buttons: 1, screenX: 140 + index, screenY: 130 });
    }
    dispatch(harness.window, eventName, { pointerId: 1, button: 0, screenX: 220, screenY: 130 });
    move(harness);
    await settle();
    expect(actions(harness)).toEqual(eventName === 'pointerup'
      ? [['start'], ['move'], ['move'], ['end']] : [['start'], ['move'], ['end']]);
    expect(harness.element('pet-toggle').classList.toggle).toHaveBeenLastCalledWith('is-dragging', false);
  });

  it('右键和非主指针不开始移动，其他指针不能接管当前拖动', async () => {
    const harness = petHarness();
    await settle();
    press(harness, { button: 2 });
    press(harness, { isPrimary: false });
    move(harness);
    expect(harness.bridge.drag).not.toHaveBeenCalled();
    dispatch(harness.element('pet-toggle'), 'contextmenu');
    await settle();
    expect(harness.bridge.showMenu).toHaveBeenCalledOnce();
    press(harness);
    move(harness, { pointerId: 2 });
    dispatch(harness.element('pet-toggle'), 'pointerup', { pointerId: 2 });
    expect(actions(harness)).toEqual([['start']]);
    release(harness);
    expect(actions(harness)).toEqual([['start'], ['end']]);
  });

  it.each(['pointercancel', 'lostpointercapture', 'blur', 'buttons-released', 'pagehide'])('%s 结束拖动，迟到移动不再移动窗口', async eventName => {
    const harness = petHarness();
    await settle();
    press(harness);
    move(harness);
    if (eventName === 'buttons-released') move(harness, { buttons: 0 });
    else if (eventName === 'blur' || eventName === 'pagehide') dispatch(harness.window, eventName);
    else dispatch(harness.element('pet-toggle'), eventName, { pointerId: 1 });
    move(harness);
    release(harness);
    await settle();
    expect(actions(harness)).toEqual([['start'], ['move'], ['end']]);
  });

  it('拖动后仍能用键盘打开功能页', async () => {
    const harness = petHarness();
    await settle();
    press(harness);
    move(harness);
    release(harness);
    dispatch(harness.element('pet-toggle'), 'click', { detail: 0 });
    await settle();
    expect(harness.element('pet-panel').hidden).toBe(false);
  });

  it('面对面语音中可拖动形象，但不误开小屋或打断会话', async () => {
    const harness = petHarness({ ...snapshot(), voice: { presentation: 'pet', state: 'listening', active: true, microphoneActive: true } });
    await settle();
    expect(harness.element('pet-toggle').disabled).toBe(false);
    press(harness);
    move(harness);
    release(harness);
    dispatch(harness.element('pet-toggle'), 'click', { detail: 1 });
    await settle();
    expect(harness.element('pet-panel').hidden).toBe(true);
    expect(harness.element('pet-voice-controls').hidden).toBe(false);
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(harness.bridge.drag).toHaveBeenCalledWith('move', { x: 140, y: 130 });
  });

  it('远程指针按帧合并位置，释放发送最终点并取消迟到帧', async () => {
    const harness = petHarness();
    const frames: FrameRequestCallback[] = [];
    const cancelAnimationFrame = vi.fn();
    Object.assign(harness.window, { requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }, cancelAnimationFrame });
    await settle();
    press(harness);
    move(harness);
    for (let index = 0; index < 100; index++) move(harness, { screenX: 150 + index, screenY: 140 + index });
    expect(frames).toHaveLength(1);
    expect(actions(harness)).toEqual([['start'], ['move']]);
    frames[0](0);
    expect(harness.bridge.drag).toHaveBeenLastCalledWith('move', { x: 249, y: 239 });
    move(harness, { screenX: 260, screenY: 250 });
    release(harness, { screenX: 270, screenY: 260 });
    expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
    expect(harness.bridge.drag.mock.calls.at(-2)).toEqual(['move', { x: 270, y: 260 }]);
    const count = harness.bridge.drag.mock.calls.length;
    frames[1](1);
    expect(harness.bridge.drag).toHaveBeenCalledTimes(count);
  });

  it('移动失败会结束本次拖动而不自动重试', async () => {
    const harness = petHarness();
    await settle();
    harness.bridge.drag.mockRejectedValueOnce(new Error('窗口暂不可用'));
    press(harness);
    await settle();
    move(harness);
    expect(actions(harness)).toEqual([['start'], ['end']]);
    expect(harness.element('error-text').textContent).toContain('桌宠移动未完成');
    expect(harness.bridge.command).not.toHaveBeenCalled();
  });
});

describe('桌宠输入焦点与问答失败恢复', () => {
  it('初始连接和状态更新不抢焦点，打开输入页及点击输入框才请求原生焦点', async () => {
    const harness = petHarness();
    await settle();
    harness.emit(snapshot());
    expect(harness.bridge.focusInput).not.toHaveBeenCalled();
    harness.emitPanel({ expanded: true, section: 'question' });
    await settle();
    expect(harness.bridge.focusInput).toHaveBeenCalledOnce();
    expect(harness.document.activeElement).toBe(harness.element('question'));
    harness.bridge.focusInput.mockClear();
    dispatch(harness.element('question'), 'pointerdown', { button: 0 });
    await settle();
    expect(harness.bridge.focusInput).toHaveBeenCalledOnce();
    expect(harness.element('question').disabled).toBe(false);
  });

  it.each(['navigate', 'collapse', 'other-control', 'dispose'])('迟到的原生焦点确认在 %s 后不重新聚焦输入框', async action => {
    const harness = petHarness();
    await settle();
    harness.emitPanel({ expanded: true, section: 'question' });
    await settle();
    let resolveFocus!: (focused: boolean) => void;
    harness.bridge.focusInput.mockImplementationOnce(() => new Promise(resolve => { resolveFocus = resolve; }));
    dispatch(harness.element('question'), 'pointerdown', { button: 0 });
    harness.element('question').focus.mockClear();
    if (action === 'navigate') {
      harness.click('view-features');
      harness.emitPanel({ expanded: true, section: 'question' });
      await settle();
      harness.element('question').focus.mockClear();
    } else if (action === 'collapse') harness.emitPanel({ expanded: false });
    else if (action === 'other-control') harness.element('collapse-panel').focus();
    else dispatch(harness.window, 'pagehide');
    resolveFocus(true);
    await settle();
    expect(harness.element('question').focus).not.toHaveBeenCalled();
  });

  it('模型接口不可用时仍能编辑草稿，但不能发送问题', async () => {
    const harness = petHarness();
    delete (harness.bridge as Partial<typeof harness.bridge>).ask;
    await settle();
    harness.emitPanel({ expanded: true, section: 'question' });
    harness.input('接口恢复后再发送的问题');
    expect(harness.element('question').disabled).toBe(false);
    expect(harness.element('send-question').disabled).toBe(true);
    harness.emit(snapshot());
    expect(harness.element('question').value).toBe('接口恢复后再发送的问题');
  });

  it('真实 preload 投影后的失败回答保留问题，不显示提交成功提示', async () => {
    const preload = preloadHarness('pet-preload.cjs');
    const failure = snapshot({}, {
      kind: 'text', state: 'ended', result: 'failed', explanation: '模型凭证或模型权限无效，未使用模拟答案。',
    });
    preload.ipcRenderer.invoke.mockResolvedValue({ ok: true, snapshot: failure });
    const harness = petHarness();
    await settle();
    harness.bridge.ask.mockImplementationOnce(question => preload.exposed.nuanbanPet.ask(question) as Promise<unknown>);
    harness.bridge.snapshot.mockResolvedValueOnce(failure);
    harness.input('怎样保存文件');
    harness.submit();
    await settle();
    expect(harness.element('question').value).toBe('怎样保存文件');
    expect(harness.element('task-status').textContent).toBe('文字回答未完成');
    expect(harness.element('dictation-status').textContent).not.toContain('问题已提交');
    expect(harness.element('send-question').disabled).toBe(false);
  });
});

describe('桌宠安静未读提示', () => {
  it('启动不把历史消息当未读，普通状态和用户消息不点亮圆点', async () => {
    const history = { id: 'history', role: 'assistant', text: '之前的回答' };
    const harness = petHarness({ ...snapshot(), messages: [history] });
    await settle();
    expect(harness.element('pet-notification').hidden).toBe(true);
    harness.emit({ ...snapshot(), message: '右键查看功能', messages: [history, { id: 'user', role: 'user', text: '我的问题' }] });
    expect(harness.element('pet-notification').hidden).toBe(true);
    expect(harness.element('pet-panel').hidden).toBe(true);
    expect(harness.bridge.command).not.toHaveBeenCalled();
  });

  it('新消息只点亮一个圆点，点击在桌宠内查看，重复快照不再提醒', async () => {
    const harness = petHarness();
    await settle();
    const state = { ...snapshot(), messages: [
      { id: 'answer', role: 'assistant', text: '请在真实软件里亲手点击。' },
      { id: 'notice', role: 'system', text: '本次结果已保存。' },
    ] };
    harness.emit(state);
    expect(harness.element('pet-notification').hidden).toBe(false);
    expect(harness.element('pet-panel').hidden).toBe(true);
    expect(harness.bridge.command).not.toHaveBeenCalled();
    harness.click('pet-notification');
    await settle();
    expect(harness.element('pet-panel').dataset.view).toBe('question');
    expect(harness.element('conversation-view').hidden).toBe(false);
    expect(harness.element('pet-notification').hidden).toBe(true);
    harness.click('collapse-panel');
    await settle();
    harness.emit(state);
    expect(harness.element('pet-notification').hidden).toBe(true);
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.bridge.openMain).not.toHaveBeenCalled();
    expect(harness.bridge.openTool).not.toHaveBeenCalled();
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
    expect(harness.bridge.command.mock.calls.every(([payload]) => (payload as { type: string }).type === 'panel.set-expanded')).toBe(true);
  });

  it('只在相关详情页消除未读，正在阅读问答时不积累新提示', async () => {
    const harness = petHarness();
    await settle();
    harness.click('pet-toggle');
    await settle();
    harness.emit({ ...snapshot(), messages: [{ id: 'answer', role: 'assistant', text: '一条新回答' }] });
    harness.click('collapse-panel');
    await settle();
    expect(harness.element('pet-notification').hidden).toBe(false);
    harness.click('pet-notification');
    await settle();
    const state = { ...snapshot(), messages: [{ id: 'next-answer', role: 'assistant', text: '阅读时到达的回答' }] };
    harness.emit(state);
    harness.click('collapse-panel');
    await settle();
    harness.emit(state);
    expect(harness.element('pet-notification').hidden).toBe(true);
  });

  it('到期待办合并到同一个圆点，查看后不反复提醒，撤销的提醒会移除', async () => {
    const harness = petHarness();
    const showDue = vi.fn();
    harness.window.addEventListener('nuanban:pet:show-due-todos', showDue);
    await settle();
    dispatch(harness.window, 'nuanban:pet:due-todos', { detail: { keys: ['todo-1', 'todo-2'] } });
    expect(harness.element('pet-notification').hidden).toBe(false);
    harness.click('pet-notification');
    await settle();
    expect(harness.element('pet-panel').dataset.view).toBe('todos');
    expect(showDue).toHaveBeenCalledTimes(1);
    harness.click('collapse-panel');
    await settle();
    dispatch(harness.window, 'nuanban:pet:due-todos', { detail: { keys: ['todo-1', 'todo-2'] } });
    expect(harness.element('pet-notification').hidden).toBe(true);
    dispatch(harness.window, 'nuanban:pet:due-todos', { detail: { keys: ['todo-1', 'todo-2', 'todo-3'] } });
    expect(harness.element('pet-notification').hidden).toBe(false);
    dispatch(harness.window, 'nuanban:pet:due-todos', { detail: { keys: [] } });
    expect(harness.element('pet-notification').hidden).toBe(true);
    expect(harness.bridge.openMain).not.toHaveBeenCalled();
  });

  it('未读问答和待办各自确认，但始终只使用同一个圆点', async () => {
    const harness = petHarness();
    await settle();
    harness.emit({ ...snapshot(), messages: [{ id: 'answer', role: 'assistant', text: '一条新回答' }] });
    dispatch(harness.window, 'nuanban:pet:due-todos', { detail: { keys: ['todo-1'] } });
    harness.click('pet-notification');
    await settle();
    expect(harness.element('pet-panel').dataset.view).toBe('question');
    harness.click('collapse-panel');
    await settle();
    expect(harness.element('pet-notification').hidden).toBe(false);
    harness.click('pet-notification');
    await settle();
    expect(harness.element('pet-panel').dataset.view).toBe('todos');
    harness.click('collapse-panel');
    await settle();
    expect(harness.element('pet-notification').hidden).toBe(true);
  });

  it('安全提醒优先打开隐私详情，但不自行恢复采集', async () => {
    const harness = petHarness();
    await settle();
    harness.emit({ ...snapshot({ state: 'privacy_paused', reason: 'sensitive_content' }), messages: [{ id: 'answer', role: 'assistant', text: '一条新回答' }] });
    expect(harness.element('pet-notification').hidden).toBe(false);
    harness.click('pet-notification');
    await settle();
    expect(harness.element('pet-panel').dataset.view).toBe('observation');
    expect(harness.element('privacy-notice').hidden).toBe(false);
    expect(harness.bridge.command.mock.calls.every(([payload]) => (payload as { type: string }).type === 'panel.set-expanded')).toBe(true);
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
  });

  it('面对面语音期间不堆未读圆点，仍保留静音与结束入口', async () => {
    const harness = petHarness();
    await settle();
    const voice = { presentation: 'pet', state: 'listening', active: true, microphoneActive: true };
    harness.emit({ ...snapshot(), voice, messages: [{ id: 'voice-answer', role: 'assistant', text: '面对面回答' }] });
    expect(harness.element('pet-notification').hidden).toBe(true);
    expect(harness.element('pet-voice-controls').hidden).toBe(false);
    expect(harness.element('pet-voice-bubble').hidden).toBe(false);
    harness.emit({ ...snapshot(), voice: { ...voice, active: false, microphoneActive: false }, messages: [{ id: 'voice-answer', role: 'assistant', text: '面对面回答' }] });
    expect(harness.element('pet-notification').hidden).toBe(true);
  });
});

describe('桌宠面对面语音入口', () => {
  const faceSnapshot = (voice: Record<string, unknown> = {}) => ({ ...snapshot(), voice: {
    presentation: 'pet', mode: 'local', state: 'listening', active: true, microphoneActive: true,
    configured: true, bubble: { user: '', assistant: '' }, ...voice,
  } });

  it('功能卡片直接收起小屋并显示桌宠气泡，不打开聊天窗口', async () => {
    const current = petHarness();
    await settle();
    current.click('pet-toggle');
    await settle();
    expect(current.element('pet-panel').hidden).toBe(false);
    current.bridge.command.mockClear();
    current.bridge.command.mockResolvedValueOnce({ ok: true, snapshot: faceSnapshot() });
    current.click('feature-voice');
    expect(current.element('pet-panel').hidden).toBe(true);
    current.emit(faceSnapshot());
    await settle();
    expect(current.element('pet-voice-bubble').hidden).toBe(false);
    expect(current.element('pet-voice-controls').hidden).toBe(false);
    expect(current.element('pet-voice-text').textContent).toBe('我在听，你慢慢说。');
    expect(current.element('pet-voice-end').focus).toHaveBeenCalled();
    expect(current.bridge.command.mock.calls).toEqual([[{ type: 'voice.open' }]]);
    expect(current.bridge.openMain).not.toHaveBeenCalled();
    expect(current.bridge.openTool).not.toHaveBeenCalled();
    expect(current.bridge.ask).not.toHaveBeenCalled();
    expect(current.bridge.dictate).not.toHaveBeenCalled();
  });

  it('对话只用安全文本显示，期间宿主面板事件不能重新展开小屋', async () => {
    const current = petHarness(faceSnapshot({ state: 'speaking', bubble: {
      user: '<img src=x onerror=alert(1)>', assistant: '<script>合成回答</script>',
    } }));
    await settle();
    expect(current.element('pet-voice-you').textContent).toBe('你说：<img src=x onerror=alert(1)>');
    expect(current.element('pet-voice-text').textContent).toBe('<script>合成回答</script>');
    expect(current.element('pet-voice-text').children).toHaveLength(0);
    expect(current.element('pet-toggle').disabled).toBe(false);
    current.emitPanel({ expanded: true, section: 'features' });
    expect(current.element('pet-panel').hidden).toBe(true);
    expect(current.element('pet-voice-interrupt').disabled).toBe(false);
    current.click('pet-voice-interrupt');
    await settle();
    expect(current.bridge.command).toHaveBeenCalledWith({ type: 'voice.interrupt' });
    current.emit(faceSnapshot());
    current.click('pet-voice-mute');
    await settle();
    expect(current.bridge.command).toHaveBeenCalledWith({ type: 'voice.mute' });
    current.emit(faceSnapshot({ state: 'muted', microphoneActive: false }));
    expect(current.element('pet-voice-mute').textContent).toBe('恢复麦克风');
    expect(current.element('pet-voice-mute').attributes.get('aria-pressed')).toBe('true');
    current.click('pet-voice-mute');
    await settle();
    expect(current.bridge.command).toHaveBeenCalledWith({ type: 'voice.unmute' });
  });

  it('停止失败仍保留结束入口，真实停止后清除字幕且不自动展开', async () => {
    const current = petHarness(faceSnapshot({ bubble: { user: '合成问题', assistant: '合成回答' } }));
    await settle();
    current.bridge.command.mockRejectedValueOnce(new Error('麦克风停止尚未确认'));
    current.click('pet-voice-end');
    await settle();
    current.emit(faceSnapshot({ state: 'error', message: '麦克风停止尚未确认，请重试结束语音' }));
    expect(current.element('pet-voice-bubble').hidden).toBe(false);
    expect(current.element('pet-voice-end').disabled).toBe(false);
    expect(current.element('pet-voice-text').textContent).toContain('停止尚未确认');
    current.bridge.command.mockResolvedValueOnce({ ok: true, snapshot: faceSnapshot({ state: 'off', active: false, microphoneActive: false }) });
    current.click('pet-voice-end');
    current.emit(faceSnapshot({ state: 'off', active: false, microphoneActive: false }));
    await settle();
    expect(current.bridge.command).toHaveBeenCalledWith({ type: 'voice.stop' });
    expect(current.element('pet-voice-bubble').hidden).toBe(true);
    expect(current.element('pet-voice-controls').hidden).toBe(true);
    expect(current.element('pet-voice-text').textContent).toBe('');
    expect(current.element('pet-voice-you').textContent).toBe('');
    expect(current.element('pet-panel').hidden).toBe(true);
    expect(current.element('pet-toggle').disabled).toBe(false);
  });

  it('直接发出独立语音指令，不先提问、不打开管理、不开启观察', async () => {
    const current = petHarness();
    await settle();
    expect(current.element('start-voice-chat').disabled).toBe(false);
    current.click('pet-voice');
    await settle();
    expect(current.bridge.command).toHaveBeenCalledWith({ type: 'voice.open' });
    expect(current.bridge.ask).not.toHaveBeenCalled();
    expect(current.bridge.openMain).not.toHaveBeenCalled();
    expect(current.bridge.command.mock.calls.every(call => (call[0] as { type: string }).type === 'voice.open')).toBe(true);
  });

  it('未配置真实服务时显示配置说明，不误报为等待麦克风确认', async () => {
    let release!: (value: unknown) => void;
    const current = petHarness({ ...snapshot(), voice: { state: 'off', active: false, microphoneActive: false, configured: false,
      message: '面对面语音待配置真实服务；麦克风未开启，不使用模拟回答。' } });
    current.bridge.command.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await settle();
    current.click('pet-voice');
    await settle();
    expect(current.element('start-voice-chat').textContent).toBe('正在显示配置说明…');
    expect(current.element('voice-chat-status').textContent).toContain('待配置真实服务');
    release({ ok: true });
    await settle();
    expect(current.element('start-voice-chat').textContent).toBe('和暖暖面对面语音');
  });

  it('仅语音开启时全局停止仍可用，并禁止同时开启本地唤醒/听写', async () => {
    const current = petHarness({ ...snapshot(), voice: { state: 'listening', active: true, microphoneActive: true, message: '实时语音中' } });
    await settle();
    expect(current.element('stop-observation').disabled).toBe(false);
    expect(current.element('stop-observation').textContent).toBe('停止共享与语音');
    expect(current.element('toggle-wake').disabled).toBe(true);
    expect(current.element('start-dictation').disabled).toBe(true);
    expect(current.element('start-voice-chat').textContent).toBe('回到面对面语音');
    current.click('stop-observation');
    await settle();
    expect(current.bridge.command).toHaveBeenCalledWith({ type: 'observation.stop' });
  });
});

describe('桌宠 preload 的最小 IPC 合约', () => {
  it('保留文字问答类型，聚焦接口不转发调用方载荷或暴露私有状态', async () => {
    const harness = preloadHarness('pet-preload.cjs');
    const api = harness.exposed.nuanbanPet;
    const state = snapshot({}, { kind: 'text', state: 'ended', result: 'failed', secret: 'discard' });
    harness.ipcRenderer.invoke.mockResolvedValue(state);
    expect((await api.snapshot() as { task: Record<string, unknown> }).task.kind).toBe('text');
    const listener = vi.fn();
    api.onState(listener);
    harness.handlers.get('nuanban:pet:state')?.({}, state);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ task: expect.objectContaining({ kind: 'text', result: 'failed' }) }));
    expect(JSON.stringify(listener.mock.calls)).not.toContain('discard');
    await api.focusInput({ rawFrame: 'discard', windowId: 99 });
    expect(harness.ipcRenderer.invoke).toHaveBeenLastCalledWith('nuanban:pet:focus-input');
  });

  it('仅活动桌宠语音向气泡投影有限文字，停止或非桌宠模式不泄露旧字幕', async () => {
    const harness = preloadHarness('pet-preload.cjs');
    const api = harness.exposed.nuanbanPet;
    const voice = { state: 'listening', mode: 'local', presentation: 'pet', active: true, microphoneActive: true,
      bubble: { user: '合成提问', assistant: '合成回答', audio: 'discard' }, audio: 'discard', secret: 'discard' };
    harness.ipcRenderer.invoke.mockResolvedValue({ ...snapshot(), voice });
    const result = await api.snapshot() as { voice: Record<string, unknown> };
    expect(result.voice).toEqual({ state: 'listening', mode: 'local', presentation: 'pet', active: true, microphoneActive: true,
      bubble: { user: '合成提问', assistant: '合成回答' } });
    for (const overrides of [
      { active: false, microphoneActive: false }, { presentation: 'window' },
      { bubble: { user: 'x'.repeat(6001), assistant: '拒绝超长载荷' } },
    ]) {
      harness.ipcRenderer.invoke.mockResolvedValue({ ...snapshot(), voice: { ...voice, ...overrides } });
      expect((await api.snapshot() as { voice: Record<string, unknown> }).voice.bubble).toBeUndefined();
    }
    const listener = vi.fn();
    api.onState(listener);
    harness.handlers.get('nuanban:pet:state')?.({}, { ...snapshot(), voice });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ voice: result.voice }));
    expect(JSON.stringify(listener.mock.calls)).not.toContain('discard');
  });

  it('暴露冻结 API，传递内部路由、文字问题和白名单指令', async () => {
    const harness = preloadHarness('pet-preload.cjs');
    const api = harness.exposed.nuanbanPet;
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api).sort()).toEqual(['activity', 'ask', 'cancelDictation', 'close', 'collapse', 'command', 'dictate', 'drag', 'expand', 'focusInput', 'onPanel', 'onState', 'openMain', 'openTool', 'showMenu', 'snapshot']);
    await api.openMain();
    await api.openMain('/notes');
    await api.ask('如何收藏网页');
    await api.dictate();
    expect(() => api.dictate({ rawFrame: 'discard' })).toThrow('代次无效');
    await api.cancelDictation({ rawFrame: 'discard' });
    for (const type of ['observation.start', 'observation.stop', 'observation.resume', 'guidance.verify', 'guidance.finish', 'guidance.repeat', 'captions.toggle', 'wake.enable', 'wake.disable', 'voice.open', 'voice.stop', 'voice.mute', 'voice.unmute', 'voice.interrupt']) await api.command({ type, rawFrame: 'discard', click: { x: 1 } });
    await api.command({ type: 'panel.set-expanded', expanded: true, rawFrame: 'discard' });
    await api.showMenu();
    await api.close();
    expect(harness.ipcRenderer.invoke).toHaveBeenCalledWith('nuanban:pet:open-main', '/');
    expect(harness.ipcRenderer.invoke).toHaveBeenCalledWith('nuanban:pet:open-main', '/notes');
    expect(harness.ipcRenderer.invoke).toHaveBeenCalledWith('nuanban:pet:ask', { text: '如何收藏网页' });
    expect(harness.ipcRenderer.invoke).toHaveBeenCalledWith('nuanban:pet:voice:dictate');
    expect(harness.ipcRenderer.invoke).toHaveBeenCalledWith('nuanban:pet:voice:cancel-dictation');
    expect(harness.ipcRenderer.invoke).toHaveBeenCalledWith('nuanban:pet:command', { type: 'guidance.verify' });
    expect(harness.ipcRenderer.invoke).toHaveBeenCalledWith('nuanban:pet:command', { type: 'panel.set-expanded', expanded: true });
    expect(JSON.stringify(harness.ipcRenderer.invoke.mock.calls)).not.toContain('rawFrame');
  });

  it('移动接口只接受三个动作，受信指针仅转发有限的坐标而非窗口边界', async () => {
    const { exposed, ipcRenderer } = preloadHarness('pet-preload.cjs');
    for (const action of ['start', 'move', 'end']) {
      await exposed.nuanbanPet.drag(action);
      expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('nuanban:pet:drag', action);
    }
    await exposed.nuanbanPet.drag('start', { x: 120.5, y: -30.5 });
    expect(ipcRenderer.invoke).toHaveBeenLastCalledWith('nuanban:pet:drag', 'start', { x: 120.5, y: -30.5 });
    ipcRenderer.invoke.mockClear();
    for (const point of [null, { x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: 1000001, y: 0 }, { x: 0, y: 0, width: 1000 }]) expect(() => exposed.nuanbanPet.drag('move', point)).toThrow('指针坐标');
    for (const action of ['input.click', 'resize', null, { x: 100, y: 200 }, ['move']]) expect(() => exposed.nuanbanPet.drag(action)).toThrow();
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('拒绝输入自动化、外部 URL、空问题和错误的展开参数', () => {
    const { exposed, ipcRenderer } = preloadHarness('pet-preload.cjs');
    const api = exposed.nuanbanPet;
    for (const route of ['https://example.com', '//example.com', '/notes?script=1', '/\\outside']) expect(() => api.openMain(route)).toThrow();
    for (const question of ['', '  ', '字'.repeat(501), { text: 'question' }]) expect(() => api.ask(question)).toThrow();
    expect(() => api.command({ type: 'input.click' })).toThrow();
    expect(() => api.command({ type: 'panel.set-expanded', expanded: 1 })).toThrow();
    expect(() => api.onState(null)).toThrow();
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('补充画面授权只透传当前观察代次，不允许渲染层提供自动同意', async () => {
    const { exposed, ipcRenderer } = preloadHarness('pet-preload.cjs');
    for (const observationGeneration of [undefined, 0, -1, 1.5, '7', NaN]) {
      expect(() => exposed.nuanbanPet.command({ type: 'observation.authorize-cloud', observationGeneration })).toThrow('屏幕观察代次无效');
    }
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    await exposed.nuanbanPet.command({ type: 'observation.authorize-cloud', observationGeneration: 7, confirmed: true, cloudConsent: true });
    expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith('nuanban:pet:command', { type: 'observation.authorize-cloud', observationGeneration: 7 });
  });

  it('快照、事件及操作回复只暴露声明字段，不转发原始帧和 OCR', async () => {
    const harness = preloadHarness('pet-preload.cjs');
    const api = harness.exposed.nuanbanPet;
    const state = { ...snapshot({ cloudConsent: true }, { instruction: '点收藏', result: { ocr: 'private' } }), rawFrame: 'private', ocr: 'private', source: { thumbnail: 'private' } };
    harness.ipcRenderer.invoke.mockResolvedValueOnce(state);
    const result = await api.snapshot();
    expect(result).toMatchObject({ observation: { cloudConsent: true }, task: { generation: 1, instruction: '点收藏' } });
    expect(JSON.stringify(result)).not.toMatch(/private|rawFrame|ocr|thumbnail/);
    const listener = vi.fn();
    const unsubscribe = api.onState(listener) as () => void;
    harness.handlers.get('nuanban:pet:state')?.({ secret: true }, state);
    expect(listener).toHaveBeenCalledWith(result);
    unsubscribe();
    unsubscribe();
    expect(harness.ipcRenderer.removeListener).toHaveBeenCalledTimes(1);
    harness.ipcRenderer.invoke.mockResolvedValueOnce({ ok: false, ...state, snapshot: state, error: 'denied' });
    const reply = await api.command({ type: 'guidance.verify' });
    expect(reply).toMatchObject({ ok: false, error: 'denied', snapshot: { task: { generation: 1 } } });
    expect(JSON.stringify(reply)).not.toMatch(/private|rawFrame|ocr|thumbnail/);
    harness.ipcRenderer.invoke.mockRejectedValueOnce(new Error('IPC unavailable'));
    await expect(api.snapshot()).rejects.toThrow('IPC unavailable');
  });

  it('guide bridge 只有只读订阅，过滤多余数据并支持幂等释放', () => {
    const harness = preloadHarness('guide-preload.cjs');
    const api = harness.exposed.nuanbanGuide;
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api)).toEqual(['onState']);
    const listener = vi.fn();
    const unsubscribe = api.onState(listener) as () => void;
    harness.handlers.get('nuanban:guide:state')?.({}, { visible: true, rect: { x: 12, y: 15, width: 30, height: 40, ocr: 'private' }, label: '收藏', instruction: '请自己点击', presentation: 'confirmed', expiresAt: 123, rawFrame: 'private' });
    expect(listener).toHaveBeenCalledWith({ visible: true, rect: { x: 12, y: 15, width: 30, height: 40 }, label: '收藏', instruction: '请自己点击', presentation: 'confirmed', expiresAt: 123 });
    unsubscribe();
    unsubscribe();
    expect(harness.ipcRenderer.removeListener).toHaveBeenCalledTimes(1);
    expect(harness.ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('兼容 snapshot 信封，预留 learning 白名单但不增加任何操作 IPC', async () => {
    const harness = preloadHarness('pet-preload.cjs');
    const api = harness.exposed.nuanbanPet;
    harness.ipcRenderer.invoke.mockResolvedValueOnce({ ok: true, snapshot: { ...snapshot(), learning: { note: { id: 'note-1', question: '问题', summary: '本次总结', result: 'ended', mastery: false, rawFrame: 'private' }, proposal: { id: 'proposal-1', remindAt: '2026-10-19T10:00:00+08:00', timezone: 'Asia/Shanghai', state: 'awaiting_confirmation', reason: '待本人确认', ocr: 'private' } } } });
    const state = await api.snapshot();
    expect(state).toMatchObject({ observation: { state: 'off' }, learning: { note: { mastery: false }, proposal: { state: 'awaiting_confirmation', timezone: 'Asia/Shanghai' } } });
    expect(JSON.stringify(state)).not.toContain('private');
    expect(harness.ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith('nuanban:pet:snapshot');
    await api.ask('字'.repeat(500));
    expect(harness.ipcRenderer.invoke).toHaveBeenLastCalledWith('nuanban:pet:ask', { text: '字'.repeat(500) });
  });
});

describe('桌宠直接语音输入草稿（合成识别，不开启麦克风）', () => {
  const result = { status: 'complete', text: '教我收藏网页', localOnly: true, microphoneActive: false };

  it('仅点击后调用听写，结果填入草稿而非直接提交', async () => {
    const harness = petHarness();
    await settle();
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
    harness.bridge.dictate.mockResolvedValueOnce(result);
    harness.click('start-dictation');
    await settle();
    expect(harness.element('question').value).toBe('教我收藏网页');
    expect(harness.element('dictation-status').textContent).toContain('请检查后');
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.bridge.command).not.toHaveBeenCalled();
  });

  it('低置信听写不填入草稿、不发送，并明确提示重说', async () => {
    const harness = petHarness();
    await settle();
    harness.input('保留的手写草稿');
    harness.bridge.dictate.mockResolvedValueOnce({ status: 'uncertain', localOnly: true, microphoneActive: false });
    harness.click('start-dictation');
    await settle();
    expect(harness.element('question').value).toBe('保留的手写草稿');
    expect(harness.element('dictation-result').hidden).toBe(true);
    expect(harness.element('dictation-status').textContent).toContain('没有听清');
    expect(harness.bridge.ask).not.toHaveBeenCalled();
  });

  it('未确认停麦的低置信结果不显示重说提示', async () => {
    const harness = petHarness();
    await settle();
    harness.bridge.dictate.mockResolvedValueOnce({ status: 'uncertain', localOnly: true, microphoneActive: true });
    harness.click('start-dictation');
    await settle();
    expect(harness.element('question').value).toBe('');
    expect(harness.element('dictation-status').textContent).not.toContain('没有听清');
    expect(harness.element('error-text').textContent).toContain('未确认');
    expect(harness.bridge.ask).not.toHaveBeenCalled();
  });

  it('发送听写草稿后不再提示待发送，并可定位到真实最近问答', async () => {
    const harness = petHarness();
    await settle();
    harness.bridge.dictate.mockResolvedValueOnce(result);
    harness.click('start-dictation');
    await settle();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    harness.bridge.ask.mockImplementationOnce(async question => {
      harness.emit({ ...snapshot(), messages: [
        { id: 'voice-question', role: 'user', text: question },
        { id: 'voice-answer', role: 'assistant', text: '请先打开需要收藏的网页。' },
      ] });
      return { ok: true };
    });
    harness.submit();
    await settle();
    expect(harness.bridge.ask).toHaveBeenCalledExactlyOnceWith(result.text);
    expect(harness.element('question').value).toBe('');
    expect(harness.element('dictation-status').textContent).toContain('问题已提交给桌宠');
    expect(harness.element('dictation-status').textContent).not.toContain('已填入输入框');
    expect(harness.element('conversation').hidden).toBe(false);
    expect(harness.element('message-list').children.map(item => item.children[1].textContent)).toEqual([result.text, '请先打开需要收藏的网页。']);
    expect(harness.element('view-conversation').hidden).toBe(false);
    harness.click('view-conversation');
    expect(harness.element('conversation').scrollIntoView).toHaveBeenCalled();
    expect(harness.element('conversation').focus).toHaveBeenCalled();
    expect(harness.bridge.ask).toHaveBeenCalledTimes(1);
    expect(harness.bridge.openMain).not.toHaveBeenCalled();
  });

  it('仅有提交回执但没有问答快照时，不声称问题已显示或模型已回答', async () => {
    const harness = petHarness();
    await settle();
    harness.bridge.dictate.mockResolvedValueOnce(result);
    harness.click('start-dictation');
    await settle();
    harness.submit();
    await settle();
    expect(harness.element('dictation-status').textContent).toContain('问题已提交给桌宠');
    expect(harness.element('dictation-status').textContent).not.toMatch(/已显示|已回答/);
    expect(harness.element('view-conversation').hidden).toBe(true);
  });

  it('手动清空听写草稿会撤销已填入提示，不会自动发送', async () => {
    const harness = petHarness();
    await settle();
    harness.bridge.dictate.mockResolvedValueOnce(result);
    harness.click('start-dictation');
    await settle();
    harness.input('');
    expect(harness.element('dictation-status').textContent).not.toContain('已填入输入框');
    expect(harness.element('dictation-status').textContent).not.toContain('已提交');
    expect(harness.element('send-question').disabled).toBe(true);
    expect(harness.bridge.ask).not.toHaveBeenCalled();
  });

  it('发送听写失败会保留文字，不误报已提交', async () => {
    const harness = petHarness();
    await settle();
    harness.bridge.dictate.mockResolvedValueOnce(result);
    harness.click('start-dictation');
    await settle();
    harness.bridge.ask.mockRejectedValueOnce(new Error('本次提问未被接受'));
    harness.submit();
    await settle();
    expect(harness.element('question').value).toBe(result.text);
    expect(harness.element('error-text').textContent).toContain('本次提问未被接受');
    expect(harness.element('dictation-status').textContent).not.toContain('已提交');
  });

  it('整理超长草稿并发送时，未填入的识别文字仍保留且不冒充已发送', async () => {
    const harness = petHarness();
    await settle();
    harness.input('字'.repeat(500));
    harness.bridge.dictate.mockResolvedValueOnce(result);
    harness.click('start-dictation');
    await settle();
    harness.input('只发送这条手写草稿');
    expect(harness.element('dictation-result').textContent).toContain(result.text);
    harness.submit();
    await settle();
    expect(harness.bridge.ask).toHaveBeenCalledExactlyOnceWith('只发送这条手写草稿');
    expect(harness.element('question').value).toBe('');
    expect(harness.element('dictation-result').hidden).toBe(false);
    expect(harness.element('dictation-result').textContent).toContain(result.text);
    expect(harness.element('dictation-status').textContent).toContain('识别文字未自动发送');
  });

  it('回填时使用最新草稿，不覆盖识别期间亲手写入的文字', async () => {
    const harness = petHarness();
    await settle();
    let finish!: (value: unknown) => void;
    harness.bridge.dictate.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    harness.input('旧草稿');
    harness.click('start-dictation');
    expect(harness.element('send-question').disabled).toBe(true);
    harness.input('最新草稿');
    harness.submit();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    finish(result);
    await settle();
    expect(harness.element('question').value).toBe('最新草稿\n教我收藏网页');
  });

  it('超出字数时显示识别文字供整理，不截断或覆盖旧草稿', async () => {
    const harness = petHarness();
    await settle();
    harness.input('字'.repeat(500));
    harness.bridge.dictate.mockResolvedValueOnce(result);
    harness.click('start-dictation');
    await settle();
    expect(harness.element('question').value).toBe('字'.repeat(500));
    expect(harness.element('dictation-result').hidden).toBe(false);
    expect(harness.element('dictation-result').textContent).toContain('教我收藏网页');
    expect(harness.bridge.ask).not.toHaveBeenCalled();
  });

  it.each(['cancel-dictation', 'collapse-panel'])('点击 %s 会取消本次输入并忽略迟到结果', async control => {
    const harness = petHarness();
    await settle();
    harness.click('pet-toggle');
    await settle();
    let finish!: (value: unknown) => void;
    harness.bridge.dictate.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    harness.click('start-dictation');
    harness.click(control);
    finish(result);
    await settle();
    expect(harness.bridge.cancelDictation).toHaveBeenCalledOnce();
    expect(harness.element('question').value).toBe('');
    expect(harness.bridge.ask).not.toHaveBeenCalled();
  });

  it('页面销毁会取消尚未结束的听写', async () => {
    const harness = petHarness();
    await settle();
    let finish!: (value: unknown) => void;
    harness.bridge.dictate.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    harness.click('start-dictation');
    dispatch(harness.window, 'pagehide');
    finish(result);
    await settle();
    expect(harness.bridge.cancelDictation).toHaveBeenCalledOnce();
    expect(harness.element('question').value).toBe('');
  });

  it('取消失败时保留重试入口，不谎报麦克风已停止', async () => {
    const harness = petHarness();
    await settle();
    let finish!: (value: unknown) => void;
    harness.bridge.dictate.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    harness.bridge.cancelDictation.mockRejectedValueOnce(new Error('合成停止故障'));
    harness.click('start-dictation');
    harness.click('cancel-dictation');
    await settle();
    expect(harness.element('error-text').textContent).toContain('停止尚未确认');
    expect(harness.element('cancel-dictation').hidden).toBe(false);
    harness.click('retry-action');
    await settle();
    finish(result);
    await settle();
    expect(harness.bridge.cancelDictation).toHaveBeenCalledTimes(2);
    expect(harness.element('question').value).toBe('');
  });

  it('未确认停麦的结果不能回填或发送', async () => {
    const harness = petHarness();
    await settle();
    harness.bridge.dictate.mockResolvedValueOnce({ ...result, microphoneActive: true });
    harness.click('start-dictation');
    await settle();
    expect(harness.element('error-text').textContent).toContain('本地听写结果未确认');
    expect(harness.element('question').value).toBe('');
    expect(harness.bridge.ask).not.toHaveBeenCalled();
  });
});

describe('已授权屏幕上的语音查找（合成识别，不读取真实屏幕或麦克风）', () => {
  it('收到分析中回执即结束发送态；失败后保留草稿并重新开放语音查找', async () => {
    const active = { state: 'observing', captureActive: true, cloudConsent: true, generation: 7 };
    const harness = petHarness(snapshot(active));
    await settle();
    harness.click('feature-guidance');
    expect(harness.element('screen-voice-find').disabled).toBe(false);
    harness.input('帮我找到设置');
    harness.bridge.ask.mockImplementationOnce(async () => {
      const accepted = snapshot(active, { id: 'guide-1', kind: 'guidance', state: 'analyzing', observationGeneration: 7 }, { state: 'analyzing' });
      harness.emit(accepted);
      return { ok: true, snapshot: accepted };
    });
    harness.submit();
    await settle();
    expect(harness.element('send-question').textContent).toBe('正在分析画面…');
    expect(harness.element('question').value).toBe('帮我找到设置');
    expect(harness.element('finish-lesson').disabled).toBe(false);
    expect(harness.element('guidance-status').textContent).toContain('结束教学');
    harness.emit(snapshot(active, { id: 'guide-1', kind: 'guidance', state: 'needs_help', observationGeneration: 7 }, { state: 'error', message: '本次屏幕分析超时，已取消请求。' }));
    expect(harness.element('send-question').disabled).toBe(false);
    expect(harness.element('screen-voice-find').disabled).toBe(false);
    expect(harness.element('question').value).toBe('帮我找到设置');
    expect(harness.element('guidance-status').textContent).toContain('超时');
    expect(harness.bridge.ask).toHaveBeenCalledOnce();
  });

  it('语音查找受理后通过状态流更新进度，不误报没有结果', async () => {
    const active = { state: 'observing', captureActive: true, cloudConsent: true, generation: 7 };
    const harness = petHarness(snapshot(active));
    await settle();
    harness.click('feature-guidance');
    harness.bridge.dictate.mockResolvedValueOnce({ status: 'complete', text: '帮我找到设置', localOnly: true, microphoneActive: false });
    harness.bridge.ask.mockImplementationOnce(async () => {
      const accepted = snapshot(active, { id: 'guide-1', kind: 'guidance', state: 'analyzing', observationGeneration: 7 }, { state: 'analyzing' });
      harness.emit(accepted);
      return { ok: true, snapshot: accepted };
    });
    harness.click('screen-voice-find');
    await settle();
    expect(harness.element('dictation-status').textContent).toContain('查找请求已受理');
    expect(harness.element('dictation-status').textContent).not.toContain('没有获得');
    expect(harness.element('screen-voice-find').textContent).toBe('正在分析当前画面…');
    harness.emit(snapshot(active, { id: 'guide-1', kind: 'guidance', state: 'awaiting_action', instruction: '请看箭头并亲手点击设置。', observationGeneration: 7 }, { state: 'ready' }));
    expect(harness.element('guidance-status').textContent).toContain('已找到');
    expect(harness.element('screen-voice-find').disabled).toBe(false);
    expect(harness.bridge.ask).toHaveBeenCalledExactlyOnceWith('帮我找到设置', 7);
  });

  it('本地观察已开启即可点击查找，等待单独上云同意前不发送、不录音', async () => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, cloudConsent: false, generation: 4 }));
    await settle();
    harness.click('feature-guidance');
    await settle();
    expect(harness.element('screen-voice-find').disabled).toBe(false);
    expect(harness.element('guidance-status').textContent).toContain('无需重新选择屏幕');
    harness.input('如何打开微信朋友圈');
    expect(harness.element('send-question').disabled).toBe(false);
    let confirm!: (value: unknown) => void;
    harness.bridge.command.mockClear();
    harness.bridge.command.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    harness.submit();
    await settle();
    expect(harness.element('send-question').textContent).toBe('正在等待分析授权…');
    expect(harness.element('screen-voice-find').disabled).toBe(true);
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.bridge.command).toHaveBeenCalledExactlyOnceWith({ type: 'observation.authorize-cloud', observationGeneration: 4 });
    harness.emit(snapshot({ state: 'observing', captureActive: true, cloudConsent: true, generation: 4 }));
    confirm({ ok: true });
    await settle();
    expect(harness.bridge.ask).toHaveBeenCalledExactlyOnceWith('如何打开微信朋友圈', 4);
    expect(harness.element('question').value).toBe('如何打开微信朋友圈');
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
    expect(harness.bridge.command).not.toHaveBeenCalledWith({ type: 'observation.reselect' });
  });

  it('先确认当前画面分析，再开启单次语音查找；不复用旧识别结果', async () => {
    const active = { state: 'observing', captureActive: true, cloudConsent: false, generation: 4 };
    const harness = petHarness(snapshot(active));
    await settle();
    harness.click('feature-guidance');
    await settle();
    let confirm!: (value: unknown) => void;
    harness.bridge.command.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    harness.bridge.dictate.mockResolvedValueOnce({ status: 'complete', text: '帮我找到设置', localOnly: true, microphoneActive: false });
    harness.click('screen-voice-find');
    await settle();
    expect(harness.element('screen-voice-find').textContent).toBe('正在等待分析授权…');
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
    harness.emit(snapshot({ ...active, cloudConsent: true }));
    confirm({ ok: true });
    await settle();
    expect(harness.bridge.dictate).toHaveBeenCalledExactlyOnceWith(4);
    expect(harness.bridge.ask).toHaveBeenCalledExactlyOnceWith('帮我找到设置', 4);
  });

  it.each(['text', 'voice'])('未收到暂停推送时，%s 查找先核对真实状态，不提交旧授权', async mode => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, cloudConsent: false, generation: 4 }));
    await settle();
    harness.click('feature-guidance');
    harness.input('帮我找到微信');
    harness.bridge.snapshot.mockResolvedValue(snapshot({ state: 'privacy_paused', captureActive: false, cloudConsent: false, generation: 5, reason: 'sensitive_screen' }, {},
      { state: 'error', message: '本地检测发现敏感文字，已停止采集和发送。' }));
    harness.bridge.command.mockClear();
    if (mode === 'text') harness.submit();
    else harness.click('screen-voice-find');
    await settle();
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
    expect(harness.element('error-notice').hidden).toBe(true);
    expect(harness.element('question').value).toBe('帮我找到微信');
    expect(harness.element('guidance-analysis').textContent).toContain('敏感文字');
    expect(harness.element('privacy-detail').textContent).toContain('本地检测发现敏感文字');
    expect(harness.element('privacy-notice').scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(harness.element('guidance-start-observation').disabled).toBe(false);
    expect(harness.element('guidance-start-observation').textContent).toContain('本人继续共享');
    expect(harness.element('send-question').disabled).toBe(true);
    harness.click('guidance-start-observation');
    await settle();
    expect(harness.bridge.command).toHaveBeenCalledExactlyOnceWith({ type: 'observation.resume' });
    expect(harness.bridge.ask).not.toHaveBeenCalled();
  });

  it.each(['text', 'voice'])('旧宿主拒绝 %s 授权后重新同步暂停状态，不反复显示 IPC 错误', async mode => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, cloudConsent: false, generation: 4 }));
    await settle();
    harness.click('feature-guidance');
    harness.input('帮我找到微信');
    harness.bridge.command.mockImplementationOnce(async () => {
      harness.bridge.snapshot.mockResolvedValue(snapshot({ state: 'privacy_paused', captureActive: false, cloudConsent: false, generation: 5, reason: 'capture_failed' }, {},
        { state: 'error', message: '本地采集失败，已停止采集和发送。' }));
      throw new Error("Error invoking remote method 'nuanban:pet:command': 请先开启屏幕观察");
    });
    if (mode === 'text') harness.submit();
    else harness.click('screen-voice-find');
    await settle();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
    expect(harness.element('error-notice').hidden).toBe(true);
    expect(harness.element('question').value).toBe('帮我找到微信');
    expect(harness.element('guidance-analysis').textContent).toContain('本地采集失败');
    expect(harness.element('guidance-start-observation').disabled).toBe(false);
    expect(harness.element('send-question').disabled).toBe(true);
  });

  it.each(['text', 'voice'])('核对时观察范围已换代，不能将旧 %s 查找自动发送到新范围', async mode => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, cloudConsent: true, generation: 4 }));
    await settle();
    harness.click('feature-guidance');
    harness.input('保留原问题');
    harness.bridge.snapshot.mockResolvedValue(snapshot({ state: 'observing', captureActive: true, cloudConsent: true, generation: 6 }));
    harness.bridge.command.mockClear();
    if (mode === 'text') harness.submit();
    else harness.click('screen-voice-find');
    await settle();
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
    expect(harness.element('dictation-status').textContent).toContain('本次查找没有发送');
    expect(harness.element('question').value).toBe('保留原问题');
  });

  it.each(['text', 'voice'])('核对 %s 查找状态失败时不录音或发送，重试只恢复状态连接', async mode => {
    const active = snapshot({ state: 'observing', captureActive: true, cloudConsent: true, generation: 4 });
    const harness = petHarness(active);
    await settle();
    harness.click('feature-guidance');
    harness.input('保留原问题');
    harness.bridge.command.mockClear();
    harness.bridge.snapshot.mockRejectedValueOnce(new Error('合成状态读取失败'));
    if (mode === 'text') harness.submit();
    else harness.click('screen-voice-find');
    await settle();
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
    expect(harness.element('question').value).toBe('保留原问题');
    expect(harness.element('send-question').disabled).toBe(true);
    const reads = harness.bridge.snapshot.mock.calls.length;
    harness.click('retry-action');
    await settle();
    expect(harness.bridge.snapshot).toHaveBeenCalledTimes(reads + 1);
    expect(harness.element('error-notice').hidden).toBe(true);
    expect(harness.element('send-question').disabled).toBe(false);
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
  });

  it('等待核对时重复点击不并发授权，停止推送优先于迟到的观察快照', async () => {
    const active = snapshot({ state: 'observing', captureActive: true, cloudConsent: true, generation: 4 });
    const harness = petHarness(active);
    await settle();
    harness.click('feature-guidance');
    let finish!: (value: unknown) => void;
    harness.bridge.snapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    harness.bridge.command.mockClear();
    harness.click('screen-voice-find');
    harness.click('screen-voice-find');
    expect(harness.bridge.snapshot).toHaveBeenCalledTimes(2);
    harness.emit(snapshot({ state: 'stopped', captureActive: false, cloudConsent: false, generation: 5 }));
    finish(active);
    await settle();
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
    expect(harness.element('error-notice').hidden).toBe(true);
    expect(harness.element('send-question').disabled).toBe(true);
  });

  it.each(['text', 'voice'])('取消 %s 查找的画面授权后仍可再次点击，原草稿保留', async mode => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, cloudConsent: false, generation: 4 }));
    await settle();
    harness.click('feature-guidance');
    await settle();
    harness.input('保留的手写问题');
    harness.bridge.command.mockResolvedValueOnce({ ok: true, status: 'cancelled' });
    if (mode === 'text') harness.submit();
    else harness.click('screen-voice-find');
    await settle();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
    expect(harness.element('question').value).toBe('保留的手写问题');
    expect(harness.element('dictation-status').textContent).toContain('本次未同意画面分析');
    expect(harness.element('screen-voice-find').disabled).toBe(false);
    expect(harness.element('send-question').disabled).toBe(false);
  });

  it.each(['text', 'voice'])('授权期间范围变化不能把 %s 查找发送给新屏幕', async mode => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, cloudConsent: false, generation: 4 }));
    await settle();
    harness.click('feature-guidance');
    await settle();
    harness.input('保留的问题');
    harness.bridge.command.mockImplementationOnce(async () => {
      harness.emit(snapshot({ state: 'observing', captureActive: true, cloudConsent: true, generation: 6 }));
      return { ok: true };
    });
    if (mode === 'text') harness.submit();
    else harness.click('screen-voice-find');
    await settle();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
    expect(harness.element('dictation-status').textContent).toContain('本次查找没有发送');
    expect(harness.element('question').value).toBe('保留的问题');
  });

  it('等待确认时修改草稿不发送旧问题；授权改变后清除旧受理提示', async () => {
    const active = { state: 'observing', captureActive: true, cloudConsent: false, generation: 4 };
    const harness = petHarness(snapshot(active));
    await settle();
    harness.click('feature-guidance');
    await settle();
    harness.input('旧问题');
    harness.bridge.command.mockImplementationOnce(async () => {
      harness.input('新的问题');
      harness.emit(snapshot({ ...active, cloudConsent: true }));
      return { ok: true };
    });
    harness.submit();
    await settle();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.element('question').value).toBe('新的问题');
    harness.submit();
    await settle();
    expect(harness.bridge.ask).toHaveBeenCalledExactlyOnceWith('新的问题', 4);
    expect(harness.element('dictation-status').textContent).toContain('查找请求已受理');
    harness.emit(snapshot({ state: 'stopped', captureActive: false, cloudConsent: false, generation: 5 }));
    expect(harness.element('dictation-status').textContent).not.toContain('查找请求已受理');
    expect(harness.element('dictation-status').textContent).toContain('旧查找已失效');
    expect(harness.element('send-question').disabled).toBe(true);
  });

  it.each(['text', 'voice'])('停止观察后迟到的 %s 受理回执不能重新显示正在查找', async mode => {
    const active = { state: 'observing', captureActive: true, cloudConsent: true, generation: 4 };
    const harness = petHarness(snapshot(active));
    await settle();
    harness.click('feature-guidance');
    harness.input('保留的草稿');
    harness.bridge.dictate.mockResolvedValueOnce({ status: 'complete', text: '帮我找到设置', localOnly: true, microphoneActive: false });
    let acknowledge!: (value: unknown) => void;
    harness.bridge.ask.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
    if (mode === 'text') harness.submit();
    else harness.click('screen-voice-find');
    await settle();
    expect(harness.bridge.ask).toHaveBeenCalledOnce();
    harness.emit(snapshot({ state: 'stopped', captureActive: false, cloudConsent: false, generation: 5 }));
    acknowledge({ ok: true, snapshot: snapshot(active, { kind: 'guidance', state: 'analyzing' }) });
    await settle();
    expect(harness.element('dictation-status').textContent).toContain('旧查找已失效');
    expect(harness.element('dictation-status').textContent).not.toContain('查找请求已受理');
    expect(harness.element('question').value).toBe('保留的草稿');
  });

  it('本机听写结束时画面授权被撤回，即使同一代次也不发送查找', async () => {
    const active = { state: 'observing', captureActive: true, cloudConsent: true, generation: 4 };
    const harness = petHarness(snapshot(active));
    await settle();
    harness.click('feature-guidance');
    harness.bridge.dictate.mockImplementationOnce(async () => {
      harness.emit(snapshot({ ...active, cloudConsent: false }));
      return { status: 'complete', text: '帮我找到设置', localOnly: true, microphoneActive: false };
    });
    harness.click('screen-voice-find');
    await settle();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.element('dictation-result').textContent).toContain('帮我找到设置');
    expect(harness.element('dictation-status').textContent).toContain('没有发送画面或问题');
  });

  it('本机停麦后只提交识别句和同一观察代次，保留已有手写草稿并显示箭头结果', async () => {
    const active = snapshot({ state: 'observing', captureActive: true, cloudConsent: true, generation: 7 });
    const harness = petHarness(active);
    await settle();
    harness.click('feature-guidance');
    harness.input('保留的手写草稿');
    harness.bridge.dictate.mockResolvedValueOnce({ status: 'complete', text: '帮我找到设置', localOnly: true, microphoneActive: false });
    harness.bridge.ask.mockResolvedValueOnce({ ok: true, snapshot: snapshot({ state: 'observing', captureActive: true, cloudConsent: true, generation: 7 },
      { state: 'awaiting_action', presentation: 'confirmed', instruction: '请看箭头并亲手点击设置。' }, { state: 'ready', message: '请按当前一步亲手操作。' }) });
    harness.click('screen-voice-find');
    await settle();
    expect(harness.bridge.dictate).toHaveBeenCalledExactlyOnceWith(7);
    expect(harness.bridge.ask).toHaveBeenCalledExactlyOnceWith('帮我找到设置', 7);
    expect(harness.element('question').value).toBe('保留的手写草稿');
    expect(harness.element('dictation-result').textContent).toContain('帮我找到设置');
    expect(harness.element('dictation-status').textContent).toContain('目标已高亮');
  });

  it('听写后观察代次改变时保留识别文字但不发送', async () => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, cloudConsent: true, generation: 7 }));
    await settle();
    harness.click('feature-guidance');
    harness.bridge.dictate.mockImplementationOnce(async () => {
      harness.emit(snapshot({ state: 'stopped', captureActive: false, cloudConsent: false, generation: 8 }));
      return { status: 'complete', text: '帮我找到设置', localOnly: true, microphoneActive: false };
    });
    harness.click('screen-voice-find');
    await settle();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.element('dictation-result').textContent).toContain('帮我找到设置');
    expect(harness.element('dictation-status').textContent).toContain('没有发送');
  });

  it('取消语音查找不会向模型发送文字或画面', async () => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, cloudConsent: true, generation: 2 }));
    await settle();
    harness.click('feature-guidance');
    harness.bridge.dictate.mockResolvedValueOnce({ status: 'cancelled', localOnly: true });
    harness.click('screen-voice-find');
    await settle();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.element('dictation-status').textContent).toContain('没有发送文字或屏幕画面');
  });

  it('低置信语音查找不发送问题或屏幕画面', async () => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, cloudConsent: true, generation: 2 }));
    await settle();
    harness.click('feature-guidance');
    harness.bridge.dictate.mockResolvedValueOnce({ status: 'uncertain', localOnly: true, microphoneActive: false });
    harness.click('screen-voice-find');
    await settle();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.element('dictation-result').hidden).toBe(true);
    expect(harness.element('dictation-status').textContent).toContain('没有听清');
  });
});

describe('合成 snapshot 的桌宠 DOM 隔离测试，不代表真实跨应用验收', () => {
  it('启动只读取状态一次，不开启观察、麦克风或定时轮询', async () => {
    const harness = petHarness();
    await settle();
    expect(harness.bridge.snapshot).toHaveBeenCalledTimes(1);
    expect(harness.bridge.onState).toHaveBeenCalledTimes(1);
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.window.setInterval).not.toHaveBeenCalled();
    expect(harness.element('pet-panel').hidden).toBe(true);
    expect(harness.element('start-observation').disabled).toBe(false);
    expect(harness.element('verify-step').disabled).toBe(true);
  });

  it('缺少初始字段时显示未知，不显示假观察、假成功或可继续状态', async () => {
    const harness = petHarness({});
    await settle();
    expect(harness.element('observation-status').textContent).toContain('待确认');
    expect(harness.element('analysis-status').textContent).toContain('待确认');
    for (const name of ['start-observation', 'resume-sharing', 'verify-step', 'send-question', 'toggle-wake', 'toggle-captions']) expect(harness.element(name).disabled).toBe(true);
  });

  it('UI 同样支持裸快照与信封，500 字以外不会发送', async () => {
    const harness = petHarness({ ok: true, snapshot: snapshot() });
    await settle();
    expect(harness.element('start-observation').disabled).toBe(false);
    harness.input('字'.repeat(501));
    harness.submit();
    await settle();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.element('error-text').textContent).toContain('500');
    expect(source('pet.html')).toContain('maxlength="500"');
    expect(harness.element('learning-summary').hidden).toBe(true);
  });

  it('猫按钮展开、Escape 收起只同步面板，不退出或打开主客户端', async () => {
    const harness = petHarness();
    await settle();
    harness.click('pet-toggle');
    await settle();
    expect(harness.element('pet-panel').hidden).toBe(false);
    expect(harness.element('pet-toggle').attributes.get('aria-expanded')).toBe('true');
    dispatch(harness.document, 'keydown', { key: 'Escape' });
    await settle();
    expect(harness.element('pet-panel').hidden).toBe(true);
    expect(harness.bridge.command.mock.calls).toEqual([[{ type: 'panel.set-expanded', expanded: true }], [{ type: 'panel.set-expanded', expanded: false }]]);
    expect(harness.bridge.close).not.toHaveBeenCalled();
    expect(harness.bridge.openMain).not.toHaveBeenCalled();
  });

  it('从客户端重新显示桌宠时清除上一次关闭确认', async () => {
    const harness = petHarness();
    await settle();
    harness.click('close-pet');
    expect(harness.element('exit-confirmation').hidden).toBe(false);
    harness.emitPanel({ expanded: true, focusInput: true });
    expect(harness.element('exit-confirmation').hidden).toBe(true);
    expect(harness.element('pet-panel').hidden).toBe(false);
    expect(harness.bridge.close).not.toHaveBeenCalled();
  });

  it('猫身体右键和 Shift+F10 都调用原生菜单，不触发面板拖拽', async () => {
    const harness = petHarness();
    await settle();
    expect(dispatch(harness.element('pet-toggle'), 'contextmenu').defaultPrevented).toBe(true);
    await settle();
    dispatch(harness.element('pet-toggle'), 'keydown', { key: 'F10', shiftKey: true });
    await settle();
    expect(harness.bridge.showMenu).toHaveBeenCalledTimes(2);
    expect(harness.bridge.command).not.toHaveBeenCalled();
  });

  it('新状态不重写草稿，Enter 直接提问，状态来自运行核心而非按钮', async () => {
    const harness = petHarness();
    await settle();
    harness.input('教我收藏网页');
    harness.emit(snapshot({}, { explanation: '我会陪你操作' }));
    expect(harness.element('question').value).toBe('教我收藏网页');
    dispatch(harness.element('question'), 'keydown', { key: 'Enter', shiftKey: true });
    dispatch(harness.element('question'), 'keydown', { key: 'Enter', isComposing: true });
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    dispatch(harness.element('question'), 'keydown', { key: 'Enter' });
    await settle();
    expect(harness.bridge.ask).toHaveBeenCalledExactlyOnceWith('教我收藏网页');
    expect(harness.element('question').value).toBe('');
    expect(harness.bridge.openMain).not.toHaveBeenCalled();
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(harness.element('task-status').textContent).toBe('等待你的问题');
  });

  it('提问在途时允许改写草稿，即使改回同文也不清空', async () => {
    const harness = petHarness();
    await settle();
    let resolveAsk: (reply: unknown) => void = () => undefined;
    harness.bridge.ask.mockImplementationOnce(() => new Promise(resolve => { resolveAsk = resolve; }));
    harness.input('原问题');
    harness.submit();
    harness.input('新问题');
    harness.emit(snapshot({}, { state: 'analyzing' }));
    harness.input('原问题');
    resolveAsk({ accepted: true });
    await settle();
    expect(harness.element('question').value).toBe('原问题');
  });

  it('我点好了只发核验命令，不把请求接受伪装成教学完成', async () => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true }, { state: 'awaiting_action', instruction: '请点击收藏星标', presentation: 'uncertain_candidate' }));
    await settle();
    expect(harness.element('presentation-note').hidden).toBe(false);
    expect(harness.element('verify-step').disabled).toBe(false);
    harness.click('verify-step');
    harness.click('verify-step');
    await settle();
    expect(harness.bridge.command).toHaveBeenCalledExactlyOnceWith({ type: 'guidance.verify' });
    expect(harness.element('task-status').textContent).toBe('轮到你亲手操作');
    expect(harness.element('step-result').hidden).toBe(true);
    harness.emit(snapshot({ state: 'observing', captureActive: true }, { state: 'verifying' }));
    expect(harness.element('verify-step').disabled).toBe(true);
  });

  it('教学代次独立增长时仍按关联观察代次核验，不把两种计数误作同一代次', async () => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, generation: 3 },
      { state: 'awaiting_action', generation: 9, observationGeneration: 3, instruction: '请点击显示' }));
    await settle();
    expect(harness.element('verify-step').disabled).toBe(false);
    harness.click('verify-step');
    await settle();
    expect(harness.bridge.command).toHaveBeenCalledExactlyOnceWith({ type: 'guidance.verify' });
    harness.emit(snapshot({ state: 'observing', captureActive: true, generation: 4 },
      { state: 'awaiting_action', generation: 9, observationGeneration: 3, instruction: '旧观察的指引' }));
    expect(harness.element('verify-step').disabled).toBe(true);
  });

  it('隐私暂停只允许本人显式恢复；推送和普通核验不会恢复采集', async () => {
    const state = snapshot({ state: 'privacy_paused', reason: 'sensitive_content' }, { state: 'awaiting_action', instruction: '旧指引' });
    const harness = petHarness(state);
    await settle();
    harness.input('问题草稿');
    harness.emit(state);
    for (const name of ['verify-step', 'repeat-step', 'send-question', 'start-observation']) expect(harness.element(name).disabled).toBe(true);
    expect(harness.element('resume-sharing').disabled).toBe(false);
    expect(harness.bridge.command).not.toHaveBeenCalled();
    harness.click('verify-step');
    expect(harness.bridge.command).not.toHaveBeenCalled();
    harness.click('resume-sharing');
    await settle();
    expect(harness.bridge.command).toHaveBeenCalledExactlyOnceWith({ type: 'observation.resume' });
    expect(harness.element('observation-status').textContent).toBe('隐私暂停');
    expect(harness.element('question').value).toBe('问题草稿');
  });

  it('已授权持续共享显示新策略说明，并保留用户主动停止入口', async () => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, reason: 'authorized_sharing' }));
    await settle();
    expect(harness.element('observation-status').textContent).toBe('正在本地观察');
    expect(harness.element('observation-detail').textContent).toContain('已授权持续实时共享');
    expect(harness.element('observation-detail').textContent).toContain('不再按敏感文字、未知页面或无文字自动暂停');
    expect(harness.element('observation-detail').textContent).toContain('本地仍遮盖文字与人脸');
    expect(harness.element('observation-detail').textContent).not.toContain('控件布局模式');
    expect(harness.element('privacy-notice').hidden).toBe(true);
    expect(harness.element('stop-observation').disabled).toBe(false);
    expect(harness.element('stop-observation').textContent).toBe('停止共享');
    harness.click('stop-observation');
    await settle();
    expect(harness.bridge.command).toHaveBeenCalledExactlyOnceWith({ type: 'observation.stop' });
  });

  it('安全控件布局仍显示持续本地观察，并说明没有原始画面和自动出云', async () => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, reason: 'controls_only' }));
    await settle();
    expect(harness.element('observation-status').textContent).toBe('正在本地观察');
    expect(harness.element('observation-detail').textContent).toContain('安全控件布局模式');
    expect(harness.element('observation-detail').textContent).toContain('不包含原画面');
    expect(harness.element('observation-detail').textContent).toContain('本人另行授权');
    expect(harness.element('privacy-notice').hidden).toBe(true);
    expect(harness.bridge.command).not.toHaveBeenCalled();
  });

  it.each(['unclassified_screen', 'unknown'])('安全原因 %s 允许本人重新授权检查，但不会直接恢复共享', async reason => {
    const paused = snapshot({ state: 'privacy_paused', reason }, { state: 'awaiting_action', instruction: '旧指引' },
      { state: 'error', message: '本地安全检查未放行，已停止采集和发送。' });
    const harness = petHarness(paused);
    await settle();
    harness.input('问题草稿');
    expect(harness.element('resume-sharing').disabled).toBe(false);
    expect(harness.element('observation-detail').textContent).toContain('当前本地分类器尚未识别');
    expect(harness.element('observation-detail').textContent).toContain('框选观察区域');
    expect(harness.element('privacy-title').textContent).toContain('重新检查');
    expect(harness.element('privacy-detail').textContent).toContain('采集已停止');
    expect(harness.element('privacy-detail').textContent).toContain('重新选择屏幕');
    expect(harness.element('privacy-detail').textContent).toContain('仍未分类时继续保持暂停');
    expect(harness.element('analysis-status').textContent).toBe('本地安全检查暂停');
    for (const name of ['start-observation', 'verify-step', 'repeat-step', 'send-question']) {
      expect(harness.element(name).disabled).toBe(true);
      harness.click(name);
    }
    harness.submit();
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    let finish!: (reply: unknown) => void;
    harness.bridge.command.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    harness.click('resume-sharing');
    harness.click('resume-sharing');
    expect(harness.bridge.command).toHaveBeenCalledExactlyOnceWith({ type: 'observation.resume' });
    expect(harness.element('resume-sharing').disabled).toBe(true);
    expect(harness.element('resume-sharing').textContent).toBe('等待选择范围与确认…');
    expect(harness.element('observation-status').textContent).toBe('画面安全类别待确认');
    expect(harness.element('privacy-notice').hidden).toBe(false);
    finish({ ok: true });
    await settle();
    expect(harness.element('observation-status').textContent).toBe('画面安全类别待确认');
    expect(harness.element('resume-sharing').disabled).toBe(false);
    expect(harness.element('question').value).toBe('问题草稿');
    harness.emit({ ...paused, observation: { ...paused.observation, generation: 2 } });
    expect(harness.element('privacy-notice').hidden).toBe(false);
    expect(harness.element('resume-sharing').disabled).toBe(false);
    expect(harness.element('verify-step').disabled).toBe(true);
    harness.emit(snapshot({ state: 'observing', captureActive: true, generation: 3 }));
    expect(harness.element('observation-status').textContent).toBe('正在本地观察');
    expect(harness.element('privacy-notice').hidden).toBe(true);
    expect(harness.bridge.command).toHaveBeenCalledTimes(1);
    expect(harness.bridge.ask).not.toHaveBeenCalled();
  });

  it.each([
    { label: '采集尚未停止', observation: { captureActive: true }, analysis: {} },
    { label: '采集状态缺失', observation: { captureActive: undefined }, analysis: {} },
    { label: '观察代次缺失', observation: { generation: undefined }, analysis: {} },
    { label: '云分析仍在进行', observation: {}, analysis: { state: 'analyzing' } },
    { label: '停止清理失败', observation: { state: 'cleanup_failed' }, analysis: {} },
  ])('未知画面在 $label 时仍禁止继续共享', async ({ observation, analysis }) => {
    const harness = petHarness(snapshot({ state: 'privacy_paused', reason: 'unclassified_screen', ...observation }, {}, analysis));
    await settle();
    expect(harness.element('resume-sharing').disabled).toBe(true);
    expect(harness.element('stop-observation').disabled).toBe(false);
    harness.click('resume-sharing');
    expect(harness.bridge.command).not.toHaveBeenCalled();
    if (analysis.state === 'analyzing') {
      expect(harness.element('analysis-status').textContent).toBe('按需分析中');
      expect(harness.element('privacy-detail').textContent).toContain('冲突');
    }
  });

  it.each(['stopped', 'privacy_paused'])('捕获失败处于 %s 时在本地观察区显示具体恢复提示', async state => {
    const detail = '屏幕实际像素与共享范围不一致，已停止观察。请重新选择屏幕；更改分辨率或缩放后需重新授权。';
    const harness = petHarness(snapshot({ state, reason: 'capture_dimensions_unproven', captureActive: false }, {}, { state: 'error', message: detail }));
    await settle();
    expect(harness.element('observation-detail').textContent).toBe(detail);
    expect(harness.element('analysis-detail').textContent).toBe(detail);
    expect(harness.element(state === 'stopped' ? 'start-observation' : 'resume-sharing').disabled).toBe(false);
  });

  it.each(['no_readable_text', 'local_detection_limit', 'incomplete_local_detection', 'invalid_or_stale_frame'])('本地检测 %s 不误报云端失败，保留原因与本人继续共享入口', async reason => {
    const message = `本地检查未放行，已停止观察且未发送画面。（${reason}）`;
    const harness = petHarness(snapshot({ state: 'privacy_paused', captureActive: false, reason }, {}, { state: 'error', message }));
    await settle();
    expect(harness.element('analysis-status').textContent).toBe('本地安全检查暂停');
    expect(harness.element('observation-detail').textContent).toBe(message);
    expect(harness.element('resume-sharing').disabled).toBe(false);
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
  });

  it('过期帧重采集或等待手动重试时不显示共享暂停', async () => {
    const detail = '本地画面处理超时，未使用过期画面。当前屏幕共享仍保持，请重新点击查找并指引。';
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, cloudConsent: true, reason: 'stale_frame' },
      { kind: 'guidance', state: 'needs_help', observationGeneration: 1, question: '如何打开微信', explanation: detail },
      { state: 'capture_error', message: detail }));
    await settle();
    expect(harness.element('observation-status').textContent).toBe('正在本地观察');
    expect(harness.element('analysis-status').textContent).toBe('本地画面待重试');
    expect(harness.element('observation-detail').textContent).toBe(detail);
    expect(harness.element('privacy-notice').hidden).toBe(true);
    expect(harness.element('resume-sharing').disabled).toBe(true);
    harness.emitPanel({ expanded: true, section: 'guidance' });
    harness.input('如何打开微信');
    expect(harness.element('send-question').disabled).toBe(false);
    expect(harness.element('screen-voice-find').disabled).toBe(false);
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
  });

  it('cleanup_failed 禁止继续、提问与核验，明确提示退出重启', async () => {
    const harness = petHarness(snapshot({ state: 'cleanup_failed', captureActive: true }, { state: 'awaiting_action', instruction: '旧指引' }));
    await settle();
    harness.input('新问题');
    for (const name of ['start-observation', 'resume-sharing', 'verify-step', 'repeat-step', 'send-question', 'toggle-wake']) expect(harness.element(name).disabled).toBe(true);
    expect(harness.element('privacy-title').textContent).toContain('退出桌宠并重新启动');
    expect(harness.element('stop-observation').disabled).toBe(false);
    harness.click('close-pet');
    expect(harness.bridge.close).not.toHaveBeenCalled();
    expect(harness.element('exit-confirmation').hidden).toBe(false);
    harness.click('cancel-exit');
    expect(harness.element('exit-confirmation').hidden).toBe(true);
    harness.click('close-pet');
    harness.click('confirm-exit');
    await settle();
    expect(harness.bridge.close).toHaveBeenCalledTimes(1);
  });

  it('停止状态仍有捕获信号时不宣称安全；观察代际不一致时不展示旧指引', async () => {
    const harness = petHarness(snapshot({ state: 'stopped', captureActive: true }));
    await settle();
    expect(harness.element('observation-status').textContent).toContain('异常');
    expect(harness.element('start-observation').disabled).toBe(true);
    harness.emit(snapshot({ state: 'observing', captureActive: true, generation: 2 }, { state: 'awaiting_action', instruction: '过期位置', generation: 1 }));
    expect(harness.element('verify-step').disabled).toBe(true);
    expect(harness.element('step-title').textContent).not.toBe('过期位置');
    expect(harness.element('step-explanation').textContent).toContain('代际');
  });

  it('隐私状态中仍在云分析时禁止恢复并保留停止入口', async () => {
    const harness = petHarness(snapshot({ state: 'privacy_paused' }, {}, { state: 'analyzing' }));
    await settle();
    expect(harness.element('resume-sharing').disabled).toBe(true);
    expect(harness.element('stop-observation').disabled).toBe(false);
    expect(harness.element('privacy-detail').textContent).toContain('冲突');
  });

  it('新推送优先于晚到的初始快照，旧代际不能覆盖停止状态', async () => {
    let resolveInitial: (state: unknown) => void = () => undefined;
    const initial = new Promise(resolve => { resolveInitial = resolve; });
    const harness = petHarness(initial);
    harness.emit(snapshot({ state: 'stopped', generation: 4 }));
    resolveInitial(snapshot({ state: 'observing', captureActive: true, generation: 1 }));
    await settle();
    expect(harness.element('observation-status').textContent).toBe('观察已停止');
    harness.emit(snapshot({ state: 'observing', captureActive: true, generation: 3 }));
    expect(harness.element('observation-status').textContent).toBe('观察已停止');
  });

  it('IPC 拒绝显示可重试错误并保留问题，不吞错或伪造问答', async () => {
    const harness = petHarness();
    await settle();
    harness.bridge.ask.mockResolvedValueOnce({ ok: false, error: '权限不足' });
    harness.input('教我操作');
    harness.submit();
    await settle();
    expect(harness.element('error-notice').hidden).toBe(false);
    expect(harness.element('error-text').textContent).toContain('权限不足');
    expect(harness.element('question').value).toBe('教我操作');
    harness.click('retry-action');
    await settle();
    expect(harness.bridge.ask).toHaveBeenCalledTimes(2);
    expect(harness.bridge.onState).toHaveBeenCalledTimes(1);
  });

  it('请求已接受但读取状态失败时重试连接，而非重复操作', async () => {
    const harness = petHarness();
    await settle();
    harness.bridge.snapshot.mockRejectedValueOnce(new Error('snapshot offline'));
    harness.click('start-observation');
    await settle();
    expect(harness.element('error-text').textContent).toContain('状态未确认');
    expect(harness.element('start-observation').disabled).toBe(true);
    harness.click('retry-action');
    await settle();
    expect(harness.bridge.command).toHaveBeenCalledTimes(1);
    expect(harness.bridge.onState).toHaveBeenCalledTimes(1);
  });

  it('字幕和语音只由本人点击切换；管理入口保留路由', async () => {
    const harness = petHarness();
    await settle();
    harness.click('toggle-captions');
    await settle();
    harness.click('toggle-wake');
    await settle();
    expect(harness.bridge.command.mock.calls).toEqual([[{ type: 'captions.toggle' }], [{ type: 'wake.enable' }]]);
    harness.emit({ ...snapshot(), captions: { enabled: true, text: '<img src=x onerror=alert(1)>' }, wake: { state: 'enabled' } });
    expect(harness.element('caption-line').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(harness.element('caption-line').hidden).toBe(false);
    harness.click('toggle-wake');
    await settle();
    expect(harness.bridge.command).toHaveBeenLastCalledWith({ type: 'wake.disable' });
    for (const button of harness.document.routes) { dispatch(button, 'click'); await settle(); }
    expect(harness.bridge.openMain.mock.calls.map(argumentsList => argumentsList[0])).toEqual(['/']);
  });

  it('反复展开不重复订阅，销毁释放所有页面事件且不再处理推送', async () => {
    const harness = petHarness();
    await settle();
    for (let count = 0; count < 4; count += 1) { harness.click('pet-toggle'); await settle(); }
    expect(harness.bridge.onState).toHaveBeenCalledTimes(1);
    dispatch(harness.window, 'pagehide');
    dispatch(harness.window, 'beforeunload');
    const calls = harness.bridge.command.mock.calls.length;
    harness.click('pet-toggle');
    harness.emit(snapshot({ state: 'observing', captureActive: true }));
    await settle();
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
    expect(harness.bridge.command).toHaveBeenCalledTimes(calls);
    expect(harness.element('observation-status').textContent).toBe('本地观察未开启');
  });
});

describe('主线程受控面板与学习 IPC 白名单', () => {
  it('onPanel 仅转发 boolean 与 learning section，取消函数幂等，不附带事件或画面', () => {
    const harness = preloadHarness('pet-preload.cjs');
    const listener = vi.fn();
    const unsubscribe = harness.exposed.nuanbanPet.onPanel(listener) as () => void;
    const handler = harness.handlers.get('nuanban:pet:panel');
    handler?.({ secret: 'private' }, { expanded: true, focusInput: true, section: 'learning', blob: 'private', rawFrame: 'private' });
    expect(listener).toHaveBeenLastCalledWith({ expanded: true, focusInput: true, section: 'learning' });
    handler?.({}, { expanded: false, focusInput: 'yes', section: 'https://external' });
    expect(listener).toHaveBeenLastCalledWith({ expanded: false });
    handler?.({}, { expanded: 'true' });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    unsubscribe();
    expect(harness.ipcRenderer.removeListener).toHaveBeenCalledTimes(1);
    expect(harness.ipcRenderer.removeListener).toHaveBeenCalledWith('nuanban:pet:panel', expect.any(Function));
    expect(harness.ipcRenderer.invoke).not.toHaveBeenCalled();
    expect(() => harness.exposed.nuanbanPet.onPanel(null)).toThrow();
  });

  it('学习命令只投影必要参数，不允许调用者伪造 actor 或传 blob', async () => {
    const harness = preloadHarness('pet-preload.cjs');
    const api = harness.exposed.nuanbanPet;
    await api.command({ type: 'learning.set-mastery', noteId: 'note-1', mastered: false, actor: 'family', raw: 'private' });
    await api.command({ type: 'learning.review.confirm', proposalId: 'proposal-1', remindAt: 'override', actor: 'ai' });
    await api.command({ type: 'learning.review.decline', proposalId: 'proposal-1', blob: 'private' });
    expect(harness.ipcRenderer.invoke.mock.calls).toEqual([
      ['nuanban:pet:command', { type: 'learning.set-mastery', noteId: 'note-1', mastered: false }],
      ['nuanban:pet:command', { type: 'learning.review.confirm', proposalId: 'proposal-1' }],
      ['nuanban:pet:command', { type: 'learning.review.decline', proposalId: 'proposal-1' }],
    ]);
    for (const noteId of [undefined, '', '  ', 'note\nprivate', 'x'.repeat(129)]) expect(() => api.command({ type: 'learning.set-mastery', noteId, mastered: true })).toThrow();
    for (const mastered of [undefined, 'true', 1, {}]) expect(() => api.command({ type: 'learning.set-mastery', noteId: 'note-1', mastered })).toThrow();
    expect(() => api.command({ type: 'learning.review.confirm' })).toThrow();
    expect(() => api.command({ type: 'learning.review.decline', proposalId: {} })).toThrow();
    expect(() => api.command({ type: 'learning.auto-master', noteId: 'note-1' })).toThrow();
    expect(harness.ipcRenderer.invoke).toHaveBeenCalledTimes(3);
  });

  it('panel 只在学习区转发合法 noteId，异常标识不阻断面板事件', () => {
    const harness = preloadHarness('pet-preload.cjs');
    const listener = vi.fn();
    harness.exposed.nuanbanPet.onPanel(listener);
    const handler = harness.handlers.get('nuanban:pet:panel');
    handler?.({}, { expanded: true, section: 'learning', noteId: 'note-1', blob: 'private' });
    expect(listener).toHaveBeenLastCalledWith({ expanded: true, section: 'learning', noteId: 'note-1' });
    for (const noteId of ['', ' note-1', 'note\n1', 'x'.repeat(129), {}, undefined]) {
      handler?.({}, { expanded: true, section: 'learning', noteId });
      expect(listener).toHaveBeenLastCalledWith({ expanded: true, section: 'learning' });
    }
    handler?.({}, { expanded: true, focusInput: true, noteId: 'note-1' });
    expect(listener).toHaveBeenLastCalledWith({ expanded: true, focusInput: true });
    expect(harness.ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  it('到期数据只保留安全字段与有限 epoch，快照、事件和命令回复投影一致', async () => {
    const harness = preloadHarness('pet-preload.cjs');
    const api = harness.exposed.nuanbanPet;
    const due = Array.from({ length: 23 }, (_, index) => ({ id: `review-${index}`, noteId: `note-${index}`, dueAt: index === 0 ? 1792303200000 : '2026-10-18T06:00:00Z', summary: '复习收藏网页', raw: 'private', blob: 'private', actor: 'private', ownerId: 'private', ocr: 'private', delivered: true }));
    const state = { ...snapshot(), learning: { due } };
    harness.ipcRenderer.invoke.mockResolvedValueOnce({ ok: true, snapshot: state });
    const projected = await api.snapshot() as { learning: { due: unknown[] } };
    expect(projected.learning.due).toHaveLength(20);
    expect(projected.learning.due[0]).toEqual({ id: 'review-0', noteId: 'note-0', dueAt: 1792303200000, summary: '复习收藏网页' });
    expect(JSON.stringify(projected)).not.toMatch(/private|delivered|raw|blob|ocr|actor|ownerId/);
    const listener = vi.fn();
    api.onState(listener);
    harness.handlers.get('nuanban:pet:state')?.({}, state);
    expect(listener).toHaveBeenCalledWith(projected);
    harness.ipcRenderer.invoke.mockResolvedValueOnce({ ok: true, snapshot: state });
    expect(await api.command({ type: 'captions.toggle' })).toEqual({ ok: true, snapshot: projected });
    harness.ipcRenderer.invoke.mockResolvedValueOnce({ learning: { due: [null, [], { id: 'review-1', noteId: 'note-1', dueAt: Infinity, summary: {} }] } });
    expect(await api.snapshot()).toEqual({ learning: { due: [{ id: 'review-1', noteId: 'note-1' }] } });
  });

  it('悬浮球状态只投影收起、球尺寸与空闲时间，丢弃其他字段', async () => {
    const harness = preloadHarness('pet-preload.cjs');
    harness.ipcRenderer.invoke.mockResolvedValueOnce({ ...snapshot(), pet: { collapsed: true, ballSize: 64, idleHideMs: 5000, rawPointer: 'private', secret: 'private' } });
    const projected = await harness.exposed.nuanbanPet.snapshot() as { pet: unknown };
    expect(projected.pet).toEqual({ collapsed: true, ballSize: 64, idleHideMs: 5000 });
    expect(JSON.stringify(projected)).not.toMatch(/private|rawPointer|secret/);
    harness.ipcRenderer.invoke.mockResolvedValueOnce({ ...snapshot(), pet: { collapsed: 123, ballSize: 'big' } });
    expect((await harness.exposed.nuanbanPet.snapshot() as { pet?: unknown }).pet).toEqual({});
  });

  it('安全归一仓储标识与 epoch，仅取最近 20 条，保留错误而不透传附件', async () => {
    const harness = preloadHarness('pet-preload.cjs');
    const notes = Array.from({ length: 23 }, (_, index) => ({ noteId: `note-${index}`, question: `问题 ${index}`, summary: '简要总结', result: 'completed', mastery: 'unmastered', rawFrame: 'private', blob: 'private', ocr: 'private', ownerId: 'private' }));
    harness.ipcRenderer.invoke.mockResolvedValueOnce({ ...snapshot(), learningUnavailable: true, learningError: '加密仓储不可用', learning: { note: notes[0], notes, proposal: { proposalId: 'proposal-1', remindAt: 1900000000000, timezone: 'Asia/Shanghai', state: 'suggested', blob: 'private' }, raw: 'private' } });
    const state = await harness.exposed.nuanbanPet.snapshot() as { learning: { notes: unknown[] } };
    expect(state).toMatchObject({ learningUnavailable: true, learningError: '加密仓储不可用', learning: { note: { id: 'note-0' }, proposal: { id: 'proposal-1', remindAt: 1900000000000 } } });
    expect(state.learning.notes).toHaveLength(20);
    expect(state.learning.notes[19]).toMatchObject({ id: 'note-19' });
    expect(JSON.stringify(state)).not.toMatch(/private|noteId|proposalId|ownerId|rawFrame|ocr|blob/);
  });
});

describe('合成状态的受控面板与本人学习确认，不代表提醒调度验收', () => {
  const note = { id: 'note-1', question: '如何收藏网页', summary: '由本人找到收藏星标并操作', result: 'completed', mastery: 'unmastered' };
  const proposal = () => ({ id: 'proposal-1', remindAt: new Date(Date.now() + 86400000).toISOString(), timezone: 'Asia/Shanghai', state: 'suggested', reason: '明天可以再练一次' });

  it('受控展开聚焦不回发 command，不重复订阅，不丢问题草稿', async () => {
    const harness = petHarness();
    await settle();
    harness.input('尚未发出的问题');
    for (let count = 0; count < 5; count += 1) harness.emitPanel({ expanded: true, focusInput: true });
    await settle();
    expect(harness.element('pet-panel').hidden).toBe(false);
    expect(harness.element('question').focus).toHaveBeenCalled();
    expect(harness.element('question').value).toBe('尚未发出的问题');
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(harness.bridge.openMain).not.toHaveBeenCalled();
    expect(harness.bridge.onPanel).toHaveBeenCalledTimes(1);
    expect(harness.bridge.onState).toHaveBeenCalledTimes(1);
    harness.emitPanel({ expanded: false });
    expect(harness.element('pet-panel').hidden).toBe(true);
    expect(harness.bridge.close).not.toHaveBeenCalled();
    dispatch(harness.window, 'pagehide');
    dispatch(harness.window, 'beforeunload');
    expect(harness.unsubscribePanel).toHaveBeenCalledTimes(1);
    harness.emitPanel({ expanded: true });
    expect(harness.element('pet-panel').hidden).toBe(true);
  });

  it('主线程新意图覆盖尚未发送的本地收起队列，不产生展开循环', async () => {
    const harness = petHarness();
    await settle();
    let resolveCommand: (reply: unknown) => void = () => undefined;
    harness.bridge.command.mockImplementationOnce(() => new Promise(resolve => { resolveCommand = resolve; }));
    harness.click('pet-toggle');
    harness.click('pet-toggle');
    harness.emitPanel({ expanded: true, focusInput: true });
    resolveCommand({ ok: true });
    await settle();
    expect(harness.element('pet-panel').hidden).toBe(false);
    expect(harness.bridge.command).toHaveBeenCalledExactlyOnceWith({ type: 'panel.set-expanded', expanded: true });
  });

  it('学习 section 无记录时也可定位，既不打开管理窗口也不丢输入', async () => {
    const harness = petHarness();
    await settle();
    harness.input('仍在编辑');
    harness.emitPanel({ expanded: true, section: 'learning', focusInput: false });
    expect(harness.element('learning-summary').hidden).toBe(false);
    expect(harness.element('learning-summary').scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(harness.element('learning-summary').focus).toHaveBeenCalled();
    expect(harness.element('question').value).toBe('仍在编辑');
    expect(harness.element('mark-mastered').disabled).toBe(true);
    expect(harness.bridge.openMain).not.toHaveBeenCalled();
    expect(harness.bridge.command).not.toHaveBeenCalled();
  });

  it('completed 或 AI 声称学会均不会自动标掌握；仅本人按钮发出精确命令', async () => {
    const state = { ...snapshot({}, { state: 'completed' }), learning: { note }, messages: [{ role: 'assistant', text: '你已学会了', id: 'message-1' }] };
    const harness = petHarness(state);
    await settle();
    expect(harness.element('mastery-status').textContent).toBe('尚未掌握');
    expect(harness.bridge.command).not.toHaveBeenCalled();
    harness.click('mark-mastered');
    await settle();
    expect(harness.bridge.command).toHaveBeenLastCalledWith({ type: 'learning.set-mastery', noteId: 'note-1', mastered: true });
    expect(harness.element('mastery-status').textContent).toBe('尚未掌握');
    harness.emit({ ...state, learning: { note: { ...note, mastery: 'mastered' } } });
    expect(harness.element('mastery-status').textContent).toContain('本人标记');
    harness.click('mark-unmastered');
    await settle();
    expect(harness.bridge.command).toHaveBeenLastCalledWith({ type: 'learning.set-mastery', noteId: 'note-1', mastered: false });
  });

  it('掌握更新在途禁止相反命令，保存拒绝显示错误且不改变快照或草稿', async () => {
    const harness = petHarness({ ...snapshot(), learning: { note } });
    await settle();
    let resolveCommand: (reply: unknown) => void = () => undefined;
    harness.bridge.command.mockImplementationOnce(() => new Promise(resolve => { resolveCommand = resolve; }));
    harness.input('待保留的问题');
    harness.click('mark-mastered');
    expect(harness.element('mark-unmastered').disabled).toBe(true);
    harness.click('mark-unmastered');
    resolveCommand({ ok: false, error: '保存失败' });
    await settle();
    expect(harness.bridge.command).toHaveBeenCalledTimes(1);
    expect(harness.element('error-text').textContent).toContain('保存失败');
    expect(harness.element('mastery-status').textContent).toBe('尚未掌握');
    expect(harness.element('question').value).toBe('待保留的问题');
  });

  it('复习建议显示具体日期时点与 IANA 时区，确认不乐观显示送达或自动建提醒', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T06:00:00Z'));
    const suggested = { ...proposal(), remindAt: '2026-10-19T10:30:00+08:00' };
    const state = { ...snapshot(), learning: { note, proposal: suggested } };
    const harness = petHarness(state);
    await settle();
    expect(harness.element('review-time').textContent).toMatch(/2026.*10.*19.*10:30/);
    expect(harness.element('review-timezone').textContent).toBe('IANA 时区：Asia/Shanghai');
    expect(harness.bridge.command).not.toHaveBeenCalled();
    harness.click('confirm-review');
    await settle();
    expect(harness.bridge.command).toHaveBeenCalledExactlyOnceWith({ type: 'learning.review.confirm', proposalId: 'proposal-1' });
    expect(harness.element('review-status').textContent).toContain('等待本人确认');
    harness.emit({ ...state, learning: { note, proposal: { ...suggested, state: 'accepted' } } });
    expect(harness.element('review-status').textContent).toBe('已确认；调度与送达状态尚未核实。');
    expect(harness.element('review-actions').hidden).toBe(true);
    expect(harness.element('review-status').textContent).not.toMatch(/已送达|调度完成/);
  });

  it('拒绝复习只发送 decline，只有快照返回 declined 才显示拒绝结果', async () => {
    const suggested = proposal();
    const state = { ...snapshot(), learning: { note, proposal: suggested } };
    const harness = petHarness(state);
    await settle();
    harness.click('decline-review');
    await settle();
    expect(harness.bridge.command).toHaveBeenCalledExactlyOnceWith({ type: 'learning.review.decline', proposalId: 'proposal-1' });
    expect(harness.element('review-status').textContent).toContain('等待本人确认');
    harness.emit({ ...state, learning: { note, proposal: { ...suggested, state: 'declined' } } });
    expect(harness.element('review-status').textContent).toContain('已拒绝');
    expect(harness.element('confirm-review').disabled).toBe(true);
  });

  it.each([
    { remindAt: '2026-02-30T10:00:00+08:00', timezone: 'Asia/Shanghai' },
    { remindAt: '2030-10-19T10:00:00', timezone: 'Asia/Shanghai' },
    { remindAt: '2030-10-19T10:00:00+08:00', timezone: 'Asia/Not_A_Zone' },
    { remindAt: '2030-10-19T10:00:00+08:00', timezone: '' },
    { remindAt: 0, timezone: 'Asia/Shanghai' },
  ])('日期或时区不完整/过期时禁止确认，但可以拒绝 $remindAt $timezone', async invalid => {
    const harness = petHarness({ ...snapshot(), learning: { proposal: { ...proposal(), ...invalid } } });
    await settle();
    expect(harness.element('confirm-review').disabled).toBe(true);
    expect(harness.element('decline-review').disabled).toBe(false);
    harness.click('confirm-review');
    expect(harness.bridge.command).not.toHaveBeenCalled();
  });

  it('建议在显示后过期，点击时再次核验且不会自动顺延日期', async () => {
    vi.useFakeTimers();
    const suggested = { ...proposal(), remindAt: Date.now() + 1000 };
    const harness = petHarness({ ...snapshot(), learning: { proposal: suggested } });
    await settle();
    expect(harness.element('confirm-review').disabled).toBe(false);
    vi.advanceTimersByTime(1500);
    harness.click('confirm-review');
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(harness.element('confirm-review').disabled).toBe(true);
    expect(harness.element('error-text').textContent).toContain('建议时间已过');
    expect(harness.window.setInterval).not.toHaveBeenCalled();
    expect(harness.window.setTimeout).not.toHaveBeenCalled();
  });

  it('复习确认在途禁止拒绝，失败重试不能误确认新的建议', async () => {
    const suggested = proposal();
    const harness = petHarness({ ...snapshot(), learning: { proposal: suggested } });
    await settle();
    let resolveCommand: (reply: unknown) => void = () => undefined;
    harness.bridge.command.mockImplementationOnce(() => new Promise(resolve => { resolveCommand = resolve; }));
    harness.click('confirm-review');
    expect(harness.element('decline-review').disabled).toBe(true);
    harness.click('decline-review');
    harness.emit({ ...snapshot(), learning: { proposal: { ...suggested, id: 'proposal-2' } } });
    resolveCommand({ ok: false, error: 'storage offline' });
    await settle();
    harness.click('retry-action');
    await settle();
    expect(harness.bridge.command).toHaveBeenCalledTimes(1);
    expect(harness.element('error-text').textContent).toContain('复习建议已更新');
  });

  it.each([
    { learningUnavailable: true, learningError: '' },
    { learningError: '本机加密仓储不可用' },
    { learningError: '磁盘写入失败' },
  ])('学习仓储错误如实显示且禁止保存掌握或复习选择 %j', async failure => {
    const harness = petHarness({ ...snapshot(), ...failure, learning: { note, proposal: proposal() } });
    await settle();
    expect(harness.element('learning-error').hidden).toBe(false);
    expect(harness.element('learning-error').textContent).toMatch(/不可用|失败/);
    for (const name of ['mark-mastered', 'mark-unmastered', 'confirm-review', 'decline-review']) expect(harness.element(name).disabled).toBe(true);
    expect(harness.bridge.command).not.toHaveBeenCalled();
  });

  it('最近 20 条为可展开的只读记录，文本安全、保留展开状态与问题草稿', async () => {
    const notes = Array.from({ length: 24 }, (_, index) => ({ ...note, id: `note-${index}`, question: `<img src=x onerror=alert(1)> ${index}` }));
    const harness = petHarness({ ...snapshot(), learning: { notes } });
    await settle();
    harness.input('不会被学习记录覆盖');
    const list = harness.element('recent-notes-list');
    expect(list.children).toHaveLength(20);
    expect(list.children[0].firstElementChild.firstElementChild.textContent).toContain('<img');
    list.children[0].firstElementChild.open = true;
    harness.emit({ ...snapshot(), learning: { notes: notes.map((entry, index) => index === 1 ? { ...entry, summary: '新总结' } : entry) } });
    expect(list.children[0].firstElementChild.open).toBe(true);
    expect(harness.element('question').value).toBe('不会被学习记录覆盖');
    expect(harness.element('recent-notes-title').textContent).toContain('20');
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(harness.bridge.openMain).not.toHaveBeenCalled();
  });

  it('本地唤醒 disabled 带 reason 可由本人启用，unsupported 禁用且从不自动打开麦克风', async () => {
    const harness = petHarness({ ...snapshot(), wake: { state: 'disabled', reason: '尚未授予本地唤醒用途许可' } });
    await settle();
    expect(harness.element('toggle-wake').disabled).toBe(false);
    expect(harness.bridge.command).not.toHaveBeenCalled();
    harness.click('toggle-wake');
    await settle();
    expect(harness.bridge.command).toHaveBeenCalledExactlyOnceWith({ type: 'wake.enable' });
    harness.emit({ ...snapshot(), wake: { state: 'unsupported', reason: '没有本地唤醒 adapter' } });
    expect(harness.element('toggle-wake').disabled).toBe(true);
    expect(harness.element('wake-status').textContent).toContain('没有本地唤醒');
  });

  it('屏幕关闭但语音仍可能持麦时，总停止入口可用', async () => {
    const harness = petHarness({ ...snapshot(), wake: { state: 'enabled', microphoneActive: true, phase: 'stopping' } });
    await settle();
    expect(harness.element('stop-observation').disabled).toBe(false);
    expect(harness.element('stop-observation').textContent).toContain('语音');
    harness.click('stop-observation');
    await settle();
    expect(harness.bridge.command).toHaveBeenCalledExactlyOnceWith({ type: 'observation.stop' });
  });

  it('panel noteId 定位当前记录或打开最近记录，后续状态不会反复抢焦点', async () => {
    const state = { ...snapshot(), learning: { note, notes: [{ ...note, id: 'note-older', question: '较早的学习问题' }] } };
    const harness = petHarness(state);
    await settle();
    harness.input('继续编辑的问题');
    harness.emitPanel({ expanded: true, section: 'learning', noteId: 'note-1' });
    expect(harness.element('learning-note').scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'start' });
    expect(harness.element('learning-note').focus).toHaveBeenCalledTimes(1);
    harness.emitPanel({ expanded: true, section: 'learning', noteId: 'note-older' });
    const detail = harness.element('recent-notes-list').firstElementChild.firstElementChild;
    expect(harness.element('recent-notes').open).toBe(true);
    expect(detail.open).toBe(true);
    expect(detail.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'start' });
    expect(detail.firstElementChild.focus).toHaveBeenCalledTimes(1);
    harness.emit(state);
    harness.emit(state);
    expect(detail.firstElementChild.focus).toHaveBeenCalledTimes(1);
    expect(harness.element('question').value).toBe('继续编辑的问题');
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(harness.bridge.openMain).not.toHaveBeenCalled();
  });

  it('panel 先于首个快照仍能定位，且同一笔记只定位一次', async () => {
    const harness = petHarness({ ...snapshot(), learning: { notes: [note] } });
    harness.emitPanel({ expanded: true, section: 'learning', noteId: 'note-1' });
    expect(harness.element('learning-navigation').hidden).toBe(false);
    await settle();
    const detail = harness.element('recent-notes-list').firstElementChild.firstElementChild;
    expect(detail.open).toBe(true);
    expect(detail.firstElementChild.focus).toHaveBeenCalledTimes(1);
    expect(harness.element('learning-navigation').hidden).toBe(true);
    harness.emit({ ...snapshot(), learning: { notes: [note] } });
    expect(detail.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(harness.bridge.snapshot).toHaveBeenCalledTimes(1);
    expect(harness.bridge.command).not.toHaveBeenCalled();
  });

  it('缺失笔记仅刷新一次并如实提示，不靠状态推送反复定位或打开管理窗口', async () => {
    const harness = petHarness();
    await settle();
    harness.emitPanel({ expanded: true, section: 'learning', noteId: 'not-in-recent' });
    await settle();
    expect(harness.bridge.snapshot).toHaveBeenCalledTimes(2);
    expect(harness.element('learning-navigation').textContent).toContain('不在本次本机快照或最近 20 条');
    harness.emit({ ...snapshot(), learning: { notes: [{ ...note, id: 'not-in-recent' }] } });
    const detail = harness.element('recent-notes-list').firstElementChild.firstElementChild;
    expect(detail.open).toBe(false);
    expect(detail.scrollIntoView).not.toHaveBeenCalled();
    expect(harness.bridge.snapshot).toHaveBeenCalledTimes(2);
    expect(harness.bridge.openMain).not.toHaveBeenCalled();
    expect(harness.bridge.command).not.toHaveBeenCalled();
  });

  it.each(['input', 'collapse', 'other-panel'])('延迟快照不夺回本人输入或新面板意图：%s', async action => {
    const harness = petHarness();
    await settle();
    let resolveSnapshot: (state: unknown) => void = () => undefined;
    harness.bridge.snapshot.mockImplementationOnce(() => new Promise(resolve => { resolveSnapshot = resolve; }));
    harness.emitPanel({ expanded: true, section: 'learning', noteId: 'note-1' });
    if (action === 'input') harness.input('在等快照时继续打字');
    if (action === 'collapse') harness.emitPanel({ expanded: false });
    if (action === 'other-panel') harness.emitPanel({ expanded: true, focusInput: true });
    resolveSnapshot({ ...snapshot(), learning: { note } });
    await settle();
    expect(harness.element('learning-note').focus).not.toHaveBeenCalled();
    expect(harness.element('learning-note').scrollIntoView).not.toHaveBeenCalled();
    if (action === 'input') expect(harness.element('question').value).toBe('在等快照时继续打字');
    if (action === 'collapse') expect(harness.element('pet-panel').hidden).toBe(true);
    expect(harness.bridge.command).not.toHaveBeenCalled();
  });

  it('到期卡片仅显示有效已到时点，文字安全、最多 20 条、不自动发命令或声称通知送达', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T06:00:00Z'));
    const due = Array.from({ length: 23 }, (_, index) => ({ id: `review-${index}`, noteId: `note-${index}`, dueAt: index === 0 ? Date.now() : '2026-10-17T06:00:00Z', summary: '<img src=x onerror=alert(1)> 复习收藏' }));
    const state = { ...snapshot(), learning: { due } };
    const harness = petHarness(state);
    await settle();
    expect(harness.element('learning-summary').hidden).toBe(false);
    expect(harness.element('learning-empty').hidden).toBe(true);
    expect(harness.element('due-reviews').hidden).toBe(false);
    expect(harness.element('due-reviews-title').textContent).toContain('20');
    const list = harness.element('due-reviews-list');
    const first = list.firstElementChild;
    expect(list.children).toHaveLength(20);
    expect(first.firstElementChild.attributes.get('datetime')).toBe('2026-10-18T06:00:00.000Z');
    expect(first.children[1].textContent).toMatch(/本机时区/);
    expect(first.children[2].textContent).toContain('<img');
    harness.input('草稿不被复习提示覆盖');
    harness.emit(state);
    expect(list.firstElementChild).toBe(first);
    expect(harness.element('question').value).toBe('草稿不被复习提示覆盖');
    expect(source('pet.html')).toContain('不代表系统通知已送达');
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.window.setInterval).not.toHaveBeenCalled();
    expect(harness.window.setTimeout).not.toHaveBeenCalled();
  });

  it('本人继续编辑后刷新失败仍显示可重试错误，重试不重复订阅或丢草稿', async () => {
    const harness = petHarness();
    await settle();
    let rejectSnapshot: (error: Error) => void = () => undefined;
    harness.bridge.snapshot.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSnapshot = reject; }));
    harness.emitPanel({ expanded: true, section: 'learning', noteId: 'note-1' });
    harness.input('继续编辑但不能静默吞掉错误');
    rejectSnapshot(new Error('本机状态接口暂时不可用'));
    await settle();
    expect(harness.element('error-notice').hidden).toBe(false);
    expect(harness.element('error-text').textContent).toContain('笔记状态未刷新');
    expect(harness.element('retry-action').disabled).toBe(false);
    expect(harness.element('question').value).toBe('继续编辑但不能静默吞掉错误');
    harness.click('retry-action');
    await settle();
    expect(harness.element('error-notice').hidden).toBe(true);
    expect(harness.bridge.snapshot).toHaveBeenCalledTimes(3);
    expect(harness.bridge.onState).toHaveBeenCalledTimes(1);
    expect(harness.bridge.onPanel).toHaveBeenCalledTimes(1);
    expect(harness.bridge.command).not.toHaveBeenCalled();
  });

  it.each([
    { dueAt: '2026-02-30T06:00:00Z' },
    { dueAt: '2026-10-18T06:00:00' },
    { dueAt: '2026-10-19T06:00:00Z' },
    { dueAt: NaN },
    { noteId: '' },
    { id: 'review\n1' },
  ])('无效或未来复习不冒充到期：%j', async invalid => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T06:00:00Z'));
    const harness = petHarness({ ...snapshot(), learning: { due: [{ id: 'review-1', noteId: 'note-1', dueAt: Date.now() - 1000, ...invalid }] } });
    await settle();
    expect(harness.element('due-reviews').hidden).toBe(true);
    expect(harness.element('due-reviews-list').children).toHaveLength(0);
    expect(harness.bridge.command).not.toHaveBeenCalled();
  });

  it('学习存储失败时不把旧到期数据当作当前提示，也不使用明文回退', async () => {
    const harness = petHarness({ ...snapshot(), learningUnavailable: true, learning: { due: [{ id: 'review-1', noteId: 'note-1', dueAt: Date.now() - 1000 }] } });
    await settle();
    expect(harness.element('due-reviews').hidden).toBe(true);
    expect(harness.element('learning-error').textContent).toContain('不会降级为明文保存');
    expect(harness.bridge.command).not.toHaveBeenCalled();
  });
});

describe('围绕桌宠展开的功能首页', () => {
  const viewRoots = ['feature-home', 'question-view', 'dictation-view', 'search-view', 'voice-section', 'observation-section', 'lesson-card', 'conversation-view', 'learning-view', 'archive-view', 'todos-view', 'captions-view', 'wake-view', 'accessibility-section'];

  it.each([
    ['view-features', 'features', ['feature-home']],
    ['feature-question', 'question', ['question-view', 'conversation-view']],
    ['feature-dictation', 'dictation', ['dictation-view', 'conversation-view']],
    ['feature-guidance', 'guidance', ['lesson-card', 'conversation-view']],
    ['view-voice', 'voice', ['voice-section']],
    ['feature-observation', 'observation', ['observation-section']],
    ['feature-learning', 'learning', ['learning-view']],
    ['feature-archive', 'archive', ['archive-view']],
    ['feature-todos', 'todos', ['todos-view']],
    ['pet-due-todos', 'todos', ['todos-view']],
    ['feature-captions', 'captions', ['captions-view']],
    ['feature-wake', 'wake', ['wake-view']],
    ['feature-management', 'accessibility', ['accessibility-section']],
  ])('点击 %s 只显示 %s 功能界面，状态更新不重新拼成长页面', async (control, section, visibleRoots) => {
    const harness = petHarness();
    await settle();
    harness.click(control as string);
    harness.emit({ ...snapshot(), messages: [{ id: 'message-1', role: 'user', text: '保留但不跨功能展示的问题' }], learning: { notes: [{ id: 'note-1', question: '后台学习记录' }] } });
    expect(harness.element('pet-panel').dataset.view).toBe(section);
    expect(viewRoots.filter(identifier => !harness.element(identifier).hidden)).toEqual(visibleRoots);
    expect(harness.element('question-form').hidden).toBe(!['question', 'dictation', 'guidance'].includes(section as string));
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
    expect(harness.bridge.openMain).not.toHaveBeenCalled();
    expect(harness.bridge.command.mock.calls.every(([payload]) => (payload as { type: string }).type === 'panel.set-expanded')).toBe(true);
  });

  it('搜索导航与原生入口共用独立页面，返回后仍保留提问草稿', async () => {
    const harness = petHarness();
    await settle();
    harness.click('feature-question');
    harness.input('还没有发送的问题');
    harness.window.dispatchEvent(new CustomEvent('nuanban:pet:navigate', { detail: { section: 'search' } }));
    expect(harness.element('search-view').hidden).toBe(false);
    expect(harness.element('feature-home').hidden).toBe(true);
    expect(harness.element('question-form').hidden).toBe(true);
    harness.click('view-features');
    expect(viewRoots.filter(identifier => !harness.element(identifier).hidden)).toEqual(['feature-home']);
    harness.emitPanel({ expanded: true, focusInput: false, section: 'question' });
    expect(harness.element('question').value).toBe('还没有发送的问题');
    expect(harness.element('question-view').hidden).toBe(false);
    expect(harness.bridge.ask).not.toHaveBeenCalled();
  });

  it('切换到搜索页会取消听写，迟到转写不能写回其他功能', async () => {
    const harness = petHarness();
    await settle();
    let complete!: (value: unknown) => void;
    harness.bridge.dictate.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    harness.click('feature-dictation');
    harness.click('start-dictation');
    await settle();
    harness.emitPanel({ expanded: true, focusInput: false, section: 'search' });
    complete({ status: 'complete', localOnly: true, microphoneActive: false, text: '不应该跨页写入' });
    await settle();
    expect(harness.bridge.cancelDictation).toHaveBeenCalledTimes(1);
    expect(harness.element('search-view').hidden).toBe(false);
    expect(harness.element('question').value).toBe('');
    expect(harness.bridge.ask).not.toHaveBeenCalled();
  });

  it('独立功能页仍保留全局隐私警告和停止入口', async () => {
    const harness = petHarness(snapshot({ state: 'privacy_paused', captureActive: false, reason: 'sensitive_screen' }));
    await settle();
    for (const section of ['features', 'search', 'voice', 'learning', 'archive', 'todos', 'captions', 'wake']) {
      harness.emitPanel({ expanded: true, focusInput: false, section });
      expect(harness.element('privacy-notice').hidden).toBe(false);
      expect(harness.element('stop-observation').disabled).toBe(false);
      expect(harness.element('start-observation').disabled).toBe(true);
    }
    expect(harness.bridge.command).not.toHaveBeenCalled();
  });

  it('光标、观察、语音与学习入口只导航，不自动采集、发送或打开客户端', async () => {
    const harness = petHarness();
    await settle();
    for (const control of ['view-features', 'feature-guidance', 'view-guidance', 'feature-observation', 'view-voice', 'feature-dictation', 'feature-question', 'feature-learning', 'feature-captions', 'feature-wake']) harness.click(control);
    await settle();
    expect(harness.element('pet-panel').hidden).toBe(false);
    expect(harness.element('lesson-card').scrollIntoView).toHaveBeenCalled();
    expect(harness.element('learning-summary').hidden).toBe(false);
    expect(harness.element('wake-view').hidden).toBe(false);
    expect(harness.element('accessibility-section').hidden).toBe(true);
    expect(harness.bridge.command.mock.calls.every(([payload]) => (payload as { type: string }).type === 'panel.set-expanded')).toBe(true);
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
    expect(harness.bridge.openMain).not.toHaveBeenCalled();
    expect(harness.bridge.openTool).not.toHaveBeenCalled();
  });

  it('图片问答、绘画、3D、隐私和能力状态使用独立工具入口，档案与待办不再跳转', async () => {
    const harness = petHarness();
    await settle();
    const routes = harness.document.tools.map(button => button.dataset.tool);
    expect(routes).toEqual(['/chat/new', '/family', '/pets', '/pets/draw', '/pets/import-3d', '/onboarding/mode', '/settings', '/settings/status', '/onboarding/login', '/sync/conflicts']);
    for (const button of harness.document.tools) { dispatch(button, 'click'); await settle(); }
    expect(harness.bridge.openTool.mock.calls.map(([route]) => route)).toEqual(routes);
    expect(harness.bridge.openMain).not.toHaveBeenCalled();
    expect(harness.bridge.command).not.toHaveBeenCalled();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
  });

  it('功能首页不被输入框挤占，进入光标教学或提问后才展开输入，返回首页收起', async () => {
    const harness = petHarness();
    await settle();
    harness.click('pet-toggle');
    expect(harness.element('question-form').hidden).toBe(true);
    harness.click('feature-guidance');
    expect(harness.element('question-form').hidden).toBe(false);
    harness.click('view-features');
    expect(harness.element('question-form').hidden).toBe(true);
    harness.click('feature-question');
    expect(harness.element('question-form').hidden).toBe(false);
    expect(harness.element('question').focus).toHaveBeenCalled();
  });

  it('工具打不开时明确报错，不回退客户端或自动重试', async () => {
    const harness = petHarness();
    await settle();
    harness.bridge.openTool.mockRejectedValue(new Error('合成工具故障'));
    dispatch(harness.document.tools[0], 'click');
    await settle();
    expect(harness.element('error-notice').hidden).toBe(false);
    expect(harness.element('error-text').textContent).toContain('桌宠工具未打开');
    expect(harness.bridge.openTool).toHaveBeenCalledTimes(1);
    expect(harness.bridge.openMain).not.toHaveBeenCalled();
  });

  it('从输入返回功能首页会取消尚未结束的听写，迟到文本不能填入隐藏草稿', async () => {
    const harness = petHarness();
    await settle();
    let complete!: (value: unknown) => void;
    harness.bridge.dictate.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    harness.click('feature-question');
    harness.click('start-dictation');
    await settle();
    harness.click('view-features');
    await settle();
    complete({ status: 'recognized', localOnly: true, text: '不应填入的迟到听写' });
    await settle();
    expect(harness.bridge.cancelDictation).toHaveBeenCalledTimes(1);
    expect(harness.element('question-form').hidden).toBe(true);
    expect(harness.element('question').value).toBe('');
    expect(harness.bridge.ask).not.toHaveBeenCalled();
  });

  it('原生菜单可以直接定位全部功能和光标教学，隐私暂停仍不允许采集', async () => {
    const harness = petHarness(snapshot({ state: 'privacy_paused', captureActive: false, reason: 'sensitive_screen' }));
    await settle();
    harness.emitPanel({ expanded: true, focusInput: false, section: 'features' });
    expect(harness.element('feature-home').focus).toHaveBeenCalled();
    harness.emitPanel({ expanded: true, focusInput: false, section: 'guidance' });
    expect(harness.element('lesson-card').focus).toHaveBeenCalled();
    expect(harness.element('feature-guidance-status').textContent).toContain('共享已暂停');
    expect(harness.element('start-observation').disabled).toBe(true);
    expect(harness.bridge.command).not.toHaveBeenCalled();
  });

  it('preload 只投影固定功能 section 和内部工具路径，不暴露事件或扩大执行权限', async () => {
    const harness = preloadHarness('pet-preload.cjs');
    const listener = vi.fn();
    harness.exposed.nuanbanPet.onPanel(listener);
    for (const section of ['features', 'guidance', 'voice', 'observation', 'accessibility', 'question', 'dictation', 'search', 'archive', 'todos', 'captions', 'wake']) {
      harness.handlers.get('nuanban:pet:panel')?.({}, { expanded: true, section, noteId: 'discard', rawFrame: 'discard' });
      expect(listener).toHaveBeenLastCalledWith({ expanded: true, section });
    }
    await harness.exposed.nuanbanPet.openTool('/pets/import-3d');
    expect(harness.ipcRenderer.invoke).toHaveBeenLastCalledWith('nuanban:pet:open-tool', '/pets/import-3d');
    for (const route of ['https://example.com', '//outside', '/settings?mode=unsafe', '/\\outside']) expect(() => harness.exposed.nuanbanPet.openTool(route)).toThrow();
  });

  it('工具模式 preload 校验原生状态，取消订阅幂等且不转发私有事件', async () => {
    const harness = preloadHarness('preload.cjs');
    const bridge = harness.exposed.nuanbanWorkspace;
    harness.ipcRenderer.invoke.mockResolvedValue('pet-tool');
    expect(await bridge.status()).toBe('pet-tool');
    harness.ipcRenderer.invoke.mockResolvedValue('unsafe');
    await expect(bridge.status()).rejects.toThrow('桌宠工具状态未确认');
    const listener = vi.fn();
    const unsubscribe = bridge.onMode(listener) as () => void;
    harness.handlers.get('nuanban:workspace:mode')?.({ secret: 'discard' }, 'pet-tool');
    harness.handlers.get('nuanban:workspace:mode')?.({}, 'unsafe');
    expect(listener.mock.calls).toEqual([['pet-tool']]);
    unsubscribe();
    unsubscribe();
    expect(harness.ipcRenderer.removeListener).toHaveBeenCalledTimes(1);
    await bridge.returnToPet({ command: 'discard' });
    expect(harness.ipcRenderer.invoke).toHaveBeenLastCalledWith('nuanban:workspace:return-pet');
  });
});

describe('屏幕分析后的教学反馈', () => {
  it('分析结果到达时滚到可见提示，重复安全帧不会反复打断阅读', async () => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, cloudConsent: true }, { kind: 'guidance', state: 'analyzing' }, { state: 'analyzing' }));
    await settle();
    harness.click('feature-guidance');
    await settle();
    const feedback = harness.element('guidance-status');
    feedback.scrollIntoView.mockClear();
    const result = snapshot({ state: 'observing', captureActive: true, cloudConsent: true }, { kind: 'guidance', state: 'needs_help', explanation: '请先亲手打开微信。' }, { state: 'ready' });
    harness.emit(result);
    expect(feedback.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'start' });
    harness.emit(result);
    expect(feedback.scrollIntoView).toHaveBeenCalledTimes(1);
    harness.click('collapse-panel');
    await settle();
    harness.emit({ ...result, task: { ...result.task, explanation: '另一条教学说明。' } });
    expect(feedback.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('预加载保留目标显示状态，供功能页区分可见与失效箭头', async () => {
    const harness = preloadHarness('pet-preload.cjs');
    const state = snapshot({ state: 'observing', captureActive: true }, { kind: 'guidance', state: 'awaiting_action', targetState: 'stale' });
    harness.ipcRenderer.invoke.mockResolvedValueOnce(state);
    const reply = await harness.exposed.nuanbanPet.snapshot();
    expect(reply).toMatchObject({ task: { targetState: 'stale' } });
    const listener = vi.fn();
    harness.exposed.nuanbanPet.onState(listener);
    harness.handlers.get('nuanban:pet:state')?.({}, { ...state, task: { ...state.task, targetState: 'visible' } });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ task: expect.objectContaining({ targetState: 'visible' }) }));
  });

  it('澄清结果在指引页顶部显示原因，不再只显示通用查找说明', async () => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, cloudConsent: true },
      { kind: 'guidance', state: 'needs_help', question: '打开朋友圈', instruction: '', presentation: null, targetState: 'hidden',
        explanation: '当前画面没有朋友圈入口，请先亲手打开微信。' }, { state: 'ready', message: '本次画面分析已结束，未定位到可核验的目标。' }));
    await settle();
    harness.click('feature-guidance');
    await settle();
    expect(harness.element('guidance-status').textContent).toContain('请先亲手打开微信');
    expect(harness.element('guidance-status').textContent).toContain('没有生成箭头');
    expect(harness.element('screen-voice-find').disabled).toBe(false);
    expect(harness.element('presentation-note').hidden).toBe(true);
    expect(harness.element('caption-line').hidden).toBe(true);
  });

  it.each(['unavailable', 'stale'] as const)('目标 %s 时说明箭头未显示，不误报请看箭头', async targetState => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, cloudConsent: true },
      { kind: 'guidance', state: 'awaiting_action', instruction: '请亲手点击设置', targetState,
        explanation: '指引窗口暂不可用，请重新选择观察屏幕。' }, { state: 'ready' }));
    await settle();
    expect(harness.element('guidance-status').textContent).toContain(targetState === 'stale' ? '已隐藏' : '未显示箭头');
    expect(harness.element('guidance-status').textContent).not.toContain('请看箭头');
  });

  it('已定位目标时把当前操作说明一并显示在状态区', async () => {
    const harness = petHarness(snapshot({ state: 'observing', captureActive: true, cloudConsent: true },
      { kind: 'guidance', state: 'awaiting_action', instruction: '请亲手双击微信图标。', presentation: 'uncertain_candidate', targetState: 'visible' }, { state: 'ready' }));
    await settle();
    expect(harness.element('guidance-status').textContent).toContain('请亲手双击微信图标');
    expect(harness.element('guidance-status').textContent).toContain('候选');
  });

  it('收起桌宠时教学结果仅点亮通知圆点，点击直达指引页', async () => {
    const harness = petHarness();
    await settle();
    harness.emit({ ...snapshot({ state: 'observing', captureActive: true, cloudConsent: true },
      { kind: 'guidance', state: 'needs_help', explanation: '请先亲手打开微信。', targetState: 'hidden' }, { state: 'ready' }),
      messages: [{ id: 'guidance-clarification', role: 'assistant', text: '请先亲手打开微信。' }] });
    expect(harness.element('pet-notification').hidden).toBe(false);
    expect(harness.element('pet-panel').hidden).toBe(true);
    harness.click('pet-notification');
    await settle();
    expect(harness.element('pet-panel').dataset.view).toBe('guidance');
    expect(harness.element('guidance-status').textContent).toContain('请先亲手打开微信');
    expect(harness.bridge.ask).not.toHaveBeenCalled();
  });
});

describe('合成 DIP 坐标的只读指引隔离测试', () => {
  it('按相对坐标高亮、明确不确定性，HTML 字符串只作为文本', () => {
    const harness = guideHarness();
    harness.emit({ visible: true, rect: { x: 200, y: 250, width: 90, height: 50 }, label: '<img src=x onerror=alert(1)>', instruction: '请自己核对并点击', presentation: 'uncertain_candidate', expiresAt: Date.now() + 5000 });
    expect(harness.element('guide-root').hidden).toBe(false);
    expect(harness.element('guide-target').style).toMatchObject({ left: '200px', top: '250px', width: '90px', height: '50px' });
    expect(harness.element('guide-certainty').textContent).toContain('可能是这里');
    expect(harness.element('guide-label').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(harness.element('guide-label').children).toHaveLength(0);
  });

  it('过期、非法、屏外或不可见的指引立即清除，不保留旧高亮', () => {
    const harness = guideHarness();
    const valid = { visible: true, rect: { x: 20, y: 50, width: 80, height: 40 }, presentation: 'confirmed', expiresAt: Date.now() + 5000 };
    for (const invalid of [{ ...valid, expiresAt: Date.now() - 1 }, { ...valid, visible: false }, { ...valid, presentation: 'unknown' }, { ...valid, rect: { x: 1200, y: 1, width: 20, height: 30 } }, { ...valid, rect: { x: NaN, y: 1, width: 20, height: 30 } }, { ...valid, rect: { x: 1, y: 1, width: -20, height: 30 } }]) {
      harness.emit(valid);
      harness.emit(invalid);
      expect(harness.element('guide-root').hidden).toBe(true);
      expect(harness.element('guide-target').style).toEqual({});
    }
  });

  it('更新和 resize 只保留一个到期计时器；销毁取消计时与订阅', () => {
    vi.useFakeTimers();
    const harness = guideHarness();
    const valid = { visible: true, rect: { x: -10, y: 50, width: 80, height: 40 }, label: '新目标', presentation: 'confirmed', expiresAt: Date.now() + 1000 };
    harness.emit(valid);
    harness.emit(valid);
    dispatch(harness.window, 'resize');
    expect(harness.element('guide-target').style).toMatchObject({ left: '0px', width: '70px' });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(harness.element('guide-root').hidden).toBe(true);
    expect(harness.element('guide-label').textContent).toBe('');
    harness.emit({ ...valid, expiresAt: Date.now() + 1000 });
    dispatch(harness.window, 'pagehide');
    dispatch(harness.window, 'beforeunload');
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
    expect(harness.onState).toHaveBeenCalledTimes(1);
  });
});

describe('桌宠 UI 源码安全边界', () => {
  it('身体按指针拖动以保留单击右键，原生把手作为备用，保留原来的猫 SVG', () => {
    const css = source('pet.css');
    const dragRules = [...css.matchAll(/([^{}]+)\{([^{}]*-webkit-app-region:\s*drag\s*;[^{}]*)\}/g)];
    expect(dragRules).toHaveLength(1);
    expect(dragRules[0][1].trim()).toBe('.drag-handle');
    expect(css).toMatch(/\.pet-stage\s*\{[^}]*-webkit-app-region:\s*no-drag/);
    expect(css).toMatch(/\.pet-stage\s*\{[^}]*touch-action:\s*none/);
    expect(source('pet.js')).toContain("bind(element('pet-toggle'), 'pointerdown'");
    expect(source('pet.html')).toContain('viewBox="0 0 240 260"');
    expect(source('pet.html')).toContain('M165 204c60 6 43-77 18-52');
    expect(source('pet.html')).toMatch(/<button id="pet-toggle"[^>]*aria-controls="pet-panel"/);
  });

  it('两页禁止服务端 HTML、网络、原始捕获、自动化输入与轮询', () => {
    for (const name of ['pet.js', 'guide.js']) expect(source(name)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|\beval\s*\(|\bfetch\s*\(|XMLHttpRequest|getUserMedia|getDisplayMedia|desktopCapturer|sendInput|setInterval/);
    for (const name of ['pet.html', 'guide.html']) {
      expect(source(name)).toContain("default-src 'none'; script-src 'self'; style-src 'self'");
      expect(source(name)).not.toMatch(/<script[^>]*>\s*[^<\s]|\son(?:click|load|error)=/i);
    }
    expect(source('guide.css')).toContain('pointer-events: none');
    expect(source('guide-preload.cjs')).not.toMatch(/ipcRenderer\.(?:invoke|send)|\bcommand\s*:/);
  });
});

describe('桌宠自动收起为悬浮球的界面状态', () => {
  it('收起时只显示悬浮球，点击悬浮球请求取回桌宠', async () => {
    const harness = petHarness({ ...snapshot(), pet: { collapsed: true, ballSize: 64, idleHideMs: 5000 } });
    await settle();
    expect(harness.element('pet-window').classList.toggle).toHaveBeenCalledWith('is-ball', true);
    expect(harness.element('pet-ball').hidden).toBe(false);
    harness.click('pet-ball');
    await settle();
    expect(harness.bridge.expand).toHaveBeenCalledTimes(1);
  });

  it('展开状态隐藏悬浮球', async () => {
    const harness = petHarness({ ...snapshot(), pet: { collapsed: false, ballSize: 64, idleHideMs: 5000 } });
    await settle();
    expect(harness.element('pet-window').classList.toggle).toHaveBeenCalledWith('is-ball', false);
    expect(harness.element('pet-ball').hidden).toBe(true);
  });

  it('半隐藏状态标记独立类名，拖动悬浮球转发坐标且不误触取回', async () => {
    const harness = petHarness({ ...snapshot(), pet: { collapsed: true, ballSize: 64, idleHideMs: 5000, hidden: true, edge: 'right' } });
    await settle();
    expect(harness.element('pet-window').classList.toggle).toHaveBeenCalledWith('is-ball-hidden', true);
    const ball = harness.element('pet-ball');
    dispatch(ball, 'pointerdown', { pointerId: 3, button: 0, isPrimary: true, screenX: 1400, screenY: 690 });
    dispatch(ball, 'pointermove', { pointerId: 3, buttons: 1, screenX: 1370, screenY: 680 });
    dispatch(ball, 'pointerup', { pointerId: 3, button: 0, screenX: 1370, screenY: 680 });
    await settle();
    expect(harness.bridge.drag).toHaveBeenCalledWith('start', { x: 1400, y: 690 });
    expect(harness.bridge.drag).toHaveBeenCalledWith('move', { x: 1370, y: 680 });
    expect(harness.bridge.drag).toHaveBeenCalledWith('end', { x: 1370, y: 680 });
    harness.click('pet-ball');
    await settle();
    expect(harness.bridge.expand).not.toHaveBeenCalled();
  });
});
