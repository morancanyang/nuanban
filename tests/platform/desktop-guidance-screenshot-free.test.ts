import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = (name: string) => readFileSync(new URL(`../../apps/desktop/${name}`, import.meta.url), 'utf8');
type StateListener = (state: unknown) => void;

class UiElement extends EventTarget {
  hidden = false;
  disabled = false;
  checked = false;
  value = '';
  textContent = '';
  className = '';
  title = '';
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
  removeAttribute(name: string) { this.attributes.delete(name); if (name === 'style') this.style = {}; }
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
const settle = async (rounds = 6) => { for (let round = 0; round < rounds; round += 1) { for (let count = 0; count < 24; count += 1) await Promise.resolve(); } };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function guidanceState(overrides: Record<string, unknown> = {}) {
  return { screenshotFree: true, modeLabel: '无截屏（默认）', active: false, reasonCode: null, reasonMessage: null,
    severity: 'info', suggestSingleFrame: false, textConsent: false, counts: { count: 0, limit: 400, truncated: false }, ...overrides };
}
function snapshot(observation: Record<string, unknown> = {}, task: Record<string, unknown> = {}, analysis: Record<string, unknown> = {}) {
  return {
    observation: { state: 'off', captureActive: false, generation: 1, cloudConsent: false, guidance: guidanceState(), ...observation },
    task: { state: 'idle', generation: 1, observationGeneration: 1, ...task },
    analysis: { state: 'idle', ...analysis },
    captions: { enabled: false, text: '' },
    wake: { state: 'disabled', phase: '' },
    voice: { active: false },
    messages: [],
  };
}

// 假 bridge：只记录调用；文本发送同意命令按 approveTextConsent 决定是否落到快照（模拟原生确认框结果）。
function petHarness(initial: unknown, options: { approveTextConsent?: boolean } = {}) {
  let current = initial;
  let listener: StateListener | undefined;
  const document = new UiDocument(source('pet.html'));
  const bridge = {
    snapshot: vi.fn(async (): Promise<unknown> => current),
    focusInput: vi.fn(async () => true),
    drag: vi.fn(async () => true),
    onState: vi.fn((callback: StateListener) => { listener = callback; return () => { listener = undefined; }; }),
    onPanel: vi.fn(() => () => {}),
    command: vi.fn(async (payload: { type?: string }) => {
      if (payload?.type === 'guidance.authorize-text' && options.approveTextConsent !== false) {
        const state = current as { observation: { guidance: Record<string, unknown> } };
        current = { ...(current as object), observation: { ...state.observation, guidance: { ...state.observation.guidance, textConsent: true } } };
      }
      return { ok: true };
    }),
    ask: vi.fn(async (): Promise<unknown> => ({ ok: true })),
    dictate: vi.fn(async (): Promise<unknown> => ({ status: 'cancelled', localOnly: true, microphoneActive: false })),
    cancelDictation: vi.fn(async () => true),
    openMain: vi.fn(async () => true),
    openTool: vi.fn(async () => true),
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
  const commandTypes = () => bridge.command.mock.calls.map(([payload]) => (payload as { type?: string })?.type);
  return {
    window, document, bridge, element, commandTypes,
    state: () => current,
    emit: (state: unknown) => { current = state; listener?.(state); },
    // 切页只调用 renderView；再推一次状态才会跑完整的 render（按钮可用性与文案都在那里更新）。
    openGuidance: async () => { dispatch(element('feature-guidance'), 'click'); listener?.(current); await settle(); },
    click: (name: string) => dispatch(element(name), 'click'),
    input: (value: string) => { element('question').value = value; dispatch(element('question'), 'input'); },
  };
}

describe('无截屏模式（默认）下的指引入口可用性', () => {
  it('语音查找可用且只走文本路径：文本同意 → 听写（不带观察代次）→ ask(text, undefined, true)', async () => {
    const harness = petHarness(snapshot({ guidance: guidanceState({ counts: { count: 12, limit: 400, truncated: false } }) }));
    await settle();
    await harness.openGuidance();
    expect(harness.element('screen-voice-find').disabled).toBe(false);
    expect(harness.element('guidance-text-find').disabled).toBe(false);
    harness.bridge.dictate.mockResolvedValueOnce({ status: 'complete', text: '帮我找到设置', localOnly: true, microphoneActive: false });
    harness.bridge.ask.mockResolvedValueOnce({ ok: true, snapshot: snapshot({}, { id: 'guide-1', kind: 'guidance', state: 'awaiting_action', instruction: '请亲手双击设置图标' }) });
    harness.click('screen-voice-find');
    await settle();
    expect(harness.bridge.command).toHaveBeenCalledWith({ type: 'guidance.authorize-text' });
    expect(harness.bridge.dictate).toHaveBeenCalledWith();
    expect(harness.bridge.ask).toHaveBeenCalledWith('帮我找到设置', undefined, true);
    // 全程没有选屏、没有画面授权、没有任何截帧入口。
    expect(harness.commandTypes()).not.toContain('observation.start');
    expect(harness.commandTypes()).not.toContain('observation.authorize-cloud');
    expect(harness.commandTypes()).not.toContain('observation.reselect');
    expect(harness.commandTypes().some(type => typeof type === 'string' && type.includes('single-frame'))).toBe(false);
    expect(harness.element('dictation-status').textContent).toContain('已按无截屏模式给出箭头');
  });

  it('本人未同意发送控件文本时立刻停住：不听写、不发送、不读控件清单', async () => {
    const harness = petHarness(snapshot(), { approveTextConsent: false });
    await settle();
    await harness.openGuidance();
    harness.click('screen-voice-find');
    await settle();
    expect(harness.bridge.command).toHaveBeenCalledWith({ type: 'guidance.authorize-text' });
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.element('dictation-status').textContent).toContain('没有读取控件清单，也没有外发任何内容');
  });

  it('“直接查找并指引”是显式入口：空草稿提示先输入，有文字时只走文本查找', async () => {
    const harness = petHarness(snapshot());
    await settle();
    await harness.openGuidance();
    expect(harness.element('guidance-text-find').disabled).toBe(false);
    harness.click('guidance-text-find');
    await settle();
    expect(harness.bridge.ask).not.toHaveBeenCalled();
    expect(harness.element('dictation-status').textContent).toContain('请先在下方输入要查找的目标');
    harness.input('帮我找到设置');
    harness.click('guidance-text-find');
    await settle();
    expect(harness.bridge.ask).toHaveBeenCalledWith('帮我找到设置', undefined, true);
    expect(harness.bridge.dictate).not.toHaveBeenCalled();
    expect(harness.commandTypes()).not.toContain('observation.authorize-cloud');
  });
});

describe('单帧/持续观察模式的按钮门槛保持不变', () => {
  it('未观察时两个新入口都不可用，语音查找仍要求屏幕共享', async () => {
    const harness = petHarness(snapshot({ guidance: guidanceState({ screenshotFree: false }) }));
    await settle();
    await harness.openGuidance();
    expect(harness.element('screen-voice-find').disabled).toBe(true);
    expect(harness.element('guidance-text-find').disabled).toBe(true);
  });

  it('观察中就绪后语音查找仍走原路径（dictate 与 ask 都带观察代次）', async () => {
    const active = { state: 'observing', captureActive: true, cloudConsent: true, generation: 7, guidance: guidanceState({ screenshotFree: false }) };
    const harness = petHarness(snapshot(active));
    await settle();
    await harness.openGuidance();
    expect(harness.element('screen-voice-find').disabled).toBe(false);
    expect(harness.element('guidance-text-find').disabled).toBe(true);
    harness.bridge.dictate.mockResolvedValueOnce({ status: 'complete', text: '帮我找到设置', localOnly: true, microphoneActive: false });
    harness.click('screen-voice-find');
    await settle();
    expect(harness.bridge.dictate).toHaveBeenCalledWith(7);
    expect(harness.bridge.ask).toHaveBeenCalledWith('帮我找到设置', 7);
  });
});

describe('无截屏模式的文案与切换入口', () => {
  it('顶部写明用法与模式，无截屏时隐藏选屏流程并标明①只用于单帧/持续观察', async () => {
    const harness = petHarness(snapshot({ guidance: guidanceState() }));
    await settle();
    await harness.openGuidance();
    expect(harness.element('guidance-status').textContent).toContain('无需选择屏幕或开启共享');
    expect(harness.element('guidance-status').textContent).toContain('无截屏（默认）');
    expect(harness.element('guidance-workflow').hidden).toBe(true);
    expect(harness.element('guidance-workflow-screenshot-free').hidden).toBe(false);
    expect(harness.element('guidance-start-observation').textContent).toContain('仅在需要单帧或持续观察时使用');
    expect(harness.element('guidance-screenshot-only-note').hidden).toBe(false);
    expect(harness.element('question-hint').textContent).toContain('无需选择屏幕或开启共享');
  });

  it('非无截屏模式恢复原流程提示与①文案，不残留无截屏专属说明', async () => {
    const harness = petHarness(snapshot({ guidance: guidanceState({ screenshotFree: false }) }));
    await settle();
    await harness.openGuidance();
    expect(harness.element('guidance-workflow').hidden).toBe(false);
    expect(harness.element('guidance-workflow-screenshot-free').hidden).toBe(true);
    expect(harness.element('guidance-screenshot-only-note').hidden).toBe(true);
    expect(harness.element('guidance-start-observation').textContent).toBe('① 选择屏幕与授权');
  });

  it('无控件树时提示这次需要允许截一帧，并保留可切换的单帧/持续观察入口', async () => {
    const harness = petHarness(snapshot({ guidance: guidanceState({ reasonCode: 'no_uia_controls', reasonMessage: '当前软件没有可读控件树。',
      suggestSingleFrame: true, counts: { count: 0, limit: 400, truncated: false } }) }));
    await settle();
    await harness.openGuidance();
    expect(harness.element('guidance-status').textContent).toContain('这次需要你允许截一帧');
    expect(harness.element('guidance-start-observation').disabled).toBe(false);
    expect(harness.element('screen-voice-find').disabled).toBe(false);
    expect(harness.element('guidance-text-find').disabled).toBe(false);
  });

  it('截断信息按既有规则显示（已读取 N 个控件、上限 M、是否截断）', async () => {
    const harness = petHarness(snapshot({ guidance: guidanceState({ counts: { count: 137, limit: 400, truncated: true } }) }));
    await settle();
    await harness.openGuidance();
    const status = harness.element('guidance-status').textContent;
    expect(status).toContain('已读取 137 个控件');
    expect(status).toContain('前台上限 400');
    expect(status).toContain('清单已截断');
  });
});

describe('无截屏路径源码守卫', () => {
  const petSource = source('pet.js');
  const html = source('pet.html');
  const screenshotFreePath = petSource.slice(petSource.indexOf('async function sendScreenshotFreeFind'), petSource.indexOf('async function startVoiceFind('));

  it('无截屏语音/文本路径只调用文本接口，不出现截帧、观察或画面授权', () => {
    expect(screenshotFreePath).toContain('await bridge.dictate();');
    expect(screenshotFreePath).toContain('bridge.ask(question, undefined, true)');
    expect(screenshotFreePath).not.toContain('observation.authorize-cloud');
    expect(screenshotFreePath).not.toContain('single-frame');
    expect(screenshotFreePath).not.toContain('getDisplayMedia');
    expect(screenshotFreePath).not.toContain('sanitizedPng');
    expect(petSource).not.toContain('getDisplayMedia');
  });

  it('无截屏门槛只加在 screenshotFree 分支，且按钮在页面上存在', () => {
    expect(petSource).toContain('canTextFind: ready && screenshotFree && guidanceUsable');
    expect(petSource).toContain('(screenshotFree ? guidanceUsable');
    expect(petSource).toContain("bind(element('guidance-text-find'), 'click', () => { directTextFind(); });");
    expect(html).toContain('id="guidance-text-find"');
    expect(html).toMatch(/id="guidance-text-find"[^>]+disabled/);
    expect(html).toContain('id="guidance-workflow-screenshot-free"');
    expect(html).toContain('id="guidance-screenshot-only-note"');
    expect(html).not.toContain('请先选择屏幕并允许按需脱敏分析');
  });
});