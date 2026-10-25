import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createForegroundTargetTracker, parseForegroundLine, FOREGROUND_LIMITS } from '../../apps/desktop/observation/foreground-target.cjs';
import { createUiaGuidanceSession, reasonInfo } from '../../apps/desktop/observation/uia-guidance.cjs';
import { checkedControlItems, UIA_LIMITS } from '../../apps/desktop/observation/uia-inventory.cjs';

// task-15：无截屏指引的目标窗口 = 最近一次出现在前台的**第三方**窗口。
// 全部用假前台窗口序列 + 假 UIA 清单：不读真实桌面、不抓屏、不碰网络。

const source = (name: string) => readFileSync(new URL(`../../apps/desktop/observation/${name}`, import.meta.url), 'utf8');

function rawControl(index: number, overrides: Record<string, unknown> = {}) {
  return { index, name: `控件${index}`, controlType: 'ControlType.Button', enabled: true, offscreen: false, focus: false, depth: 2,
    x: 10 * index, y: 20, width: 80, height: 30, ...overrides };
}
const controlsOf = (items: unknown[]) => checkedControlItems(items, { ...UIA_LIMITS });
const complete = (controls: unknown[], overrides: Record<string, unknown> = {}) => ({ status: 'complete', windowKey: 'window-target', focusedIndex: 0,
  foreground: true, targetHwnd: 42, truncated: false, counts: { total: controls.length, limit: 400 }, controls, ...overrides });
const unavailable = (reason: string) => ({ status: 'unavailable', reason, windowKey: null, truncated: false, counts: { total: 0, limit: 400 }, controls: [] });

// 假 watcher 进程：把脚本化的 NDJSON 行推给跟踪器，记录写入 stdin 的请求。
function fakeWatcher(lines: string[]) {
  const listeners: Record<string, ((value: unknown) => void)[]> = {};
  const stdout = {
    setEncoding: vi.fn(),
    on: (event: string, handler: (value: unknown) => void) => { (listeners[event] ??= []).push(handler); },
  };
  const stdin = { on: vi.fn(), end: vi.fn((payload: string) => { requests.push(JSON.parse(payload)); }), destroy: vi.fn() };
  const requests: Record<string, unknown>[] = [];
  let closed = false;
  const child = { stdout, stdin, kill: vi.fn(() => { closed = true; }), on: vi.fn((event: string, handler: (value: unknown) => void) => { (listeners[event] ??= []).push(handler); }) };
  const spawn = vi.fn(() => child);
  return {
    spawn, requests, child,
    emit: (line: string) => { for (const handler of listeners.data ?? []) handler(line); },
    line: (value: Record<string, unknown>) => JSON.stringify({ protocol: 1, kind: 'foreground', ...value }),
    isClosed: () => closed,
  };
}

const SELF = { hwnd: 900, processId: 777, processName: 'nuanban', title: '微光指引', isSelf: true };
const NOTEPAD = { hwnd: 42, processId: 1001, processName: 'notepad', title: '无标题 - 记事本', isSelf: false };
const CHROME = { hwnd: 43, processId: 1002, processName: 'chrome', title: '设置 - Google Chrome', isSelf: false };

function trackerHarness(lines: string[], options: { selfProcessIds?: number[] } = {}) {
  const watcher = fakeWatcher(lines);
  const selfProcessIds = options.selfProcessIds ?? [777];
  const targets: unknown[] = [];
  const tracker = createForegroundTargetTracker({ spawn: watcher.spawn, platform: 'win32', intervalMs: 750,
    ownProcessIds: () => selfProcessIds, isSelfProcessId: id => selfProcessIds.includes(id), now: () => 5000,
    onTarget: value => targets.push(value) });
  return { tracker, watcher, targets };
}

describe('目标窗口跟踪：最近的非自身前台窗口', () => {
  it('自身窗口（桌宠/管理窗/球窗）一律不作目标，只记住第三方窗口', () => {
    const { tracker, watcher, targets } = trackerHarness([]);
    tracker.start();
    watcher.emit(watcher.line(SELF) + '\n');
    watcher.emit(watcher.line({ ...SELF, hwnd: 901, title: '微光指引 · 管理' }) + '\n');
    expect(tracker.target()).toBeNull();
    expect(targets).toEqual([]);
    watcher.emit(watcher.line(NOTEPAD) + '\n');
    expect(tracker.target()).toMatchObject({ hwnd: 42, title: '无标题 - 记事本', processName: 'notepad', at: 5000 });
    // Node 侧不信任脚本的 isSelf：即使脚本说不是自身，进程号在本应用里也照样排除。
    watcher.emit(watcher.line({ ...NOTEPAD, hwnd: 902, isSelf: false, processId: 777 }) + '\n');
    expect(tracker.target()).toMatchObject({ hwnd: 42 });
  });

  it('提问瞬间前台是自身窗口时，目标仍是最近记录的第三方窗口', () => {
    const { tracker, watcher } = trackerHarness([]);
    tracker.start();
    watcher.emit(watcher.line(NOTEPAD) + '\n');
    // 用户点桌宠输入框 → 前台变成我们自己的球窗/面板（脚本会报 isSelf）。
    watcher.emit(watcher.line({ ...SELF, hwnd: 903, title: '微光指引' }) + '\n');
    expect(tracker.target()).toMatchObject({ hwnd: 42, title: '无标题 - 记事本' });
  });

  it('中途切换软件时以最近一次记录为准，并保留标题与进程名', () => {
    const { tracker, watcher } = trackerHarness([]);
    tracker.start();
    watcher.emit(watcher.line(NOTEPAD) + '\n');
    watcher.emit(watcher.line(CHROME) + '\n');
    expect(tracker.target()).toMatchObject({ hwnd: 43, title: '设置 - Google Chrome', processName: 'chrome' });
    // 同一窗口重复出现只刷新时间，不产生新目标事件。
    const before = tracker.target();
    watcher.emit(watcher.line(CHROME) + '\n');
    expect(tracker.target()).toMatchObject({ hwnd: before!.hwnd, title: before!.title });
  });

  it('撤回同意/会话结束即清空目标并停止 watcher 进程', () => {
    const { tracker, watcher } = trackerHarness([]);
    tracker.start();
    watcher.emit(watcher.line(NOTEPAD) + '\n');
    expect(tracker.target()).not.toBeNull();
    tracker.clear();
    expect(tracker.target()).toBeNull();
    tracker.stop();
    expect(watcher.isClosed()).toBe(true);
    expect(tracker.snapshot()).toMatchObject({ tracking: false });
  });

  it('只接受形状严格的 NDJSON 行：坏行、超长标题、非法进程名一律丢弃', () => {
    expect(parseForegroundLine('not json')).toBeNull();
    expect(parseForegroundLine(JSON.stringify({ protocol: 1, kind: 'foreground', hwnd: 0, processId: 5 }))).toBeNull();
    expect(parseForegroundLine(JSON.stringify({ protocol: 1, kind: 'foreground', hwnd: 42, processId: -1 }))).toBeNull();
    expect(parseForegroundLine(JSON.stringify({ protocol: 2, kind: 'foreground', hwnd: 42, processId: 5 }))).toBeNull();
    expect(parseForegroundLine(JSON.stringify({ protocol: 1, kind: 'other', hwnd: 42, processId: 5 }))).toBeNull();
    expect(parseForegroundLine('x'.repeat(FOREGROUND_LIMITS.maxLineBytes + 1))).toBeNull();
    const long = parseForegroundLine(JSON.stringify({ protocol: 1, kind: 'foreground', hwnd: 42, processId: 5, title: 'x'.repeat(400), processName: 'notepad' }));
    expect(long).toBeNull();
    const badName = parseForegroundLine(JSON.stringify({ protocol: 1, kind: 'foreground', hwnd: 42, processId: 5, title: 'ok', processName: '../evil cmd' }));
    expect(badName?.processName).toBe('');
    const good = parseForegroundLine(JSON.stringify({ protocol: 1, kind: 'foreground', hwnd: 42, processId: 5, title: 'ok', processName: 'notepad', isSelf: true }));
    expect(good).toMatchObject({ hwnd: 42, processId: 5, title: 'ok', processName: 'notepad', scriptIsSelf: true });
  });

  it('start() 把排除自身进程与间隔写进请求，非 Windows 平台不启动', () => {
    const { tracker, watcher } = trackerHarness([], { selfProcessIds: [777, 778] });
    expect(tracker.start()).toBe(true);
    expect(watcher.requests[0]).toMatchObject({ protocol: 1, operation: 'watch-foreground', intervalMs: 750, excludedProcessIds: [777, 778] });
    const other = createForegroundTargetTracker({ spawn: vi.fn(), platform: 'linux' });
    expect(other.start()).toBe(false);
    expect(other.snapshot().unavailable).toBe(true);
  });
});

// 假 UIA 端口：记录每次读取用没用 hwnd，用于断言"绝不读自身窗口/绝不安卓旧行为"。
function guidanceFixture(options: { readings?: unknown[]; trackerTarget?: { hwnd: number; title: string; processName: string; at: number } | null; withTracker?: boolean } = {}) {
  const readings = [...(options.readings ?? [complete(controlsOf([rawControl(1), rawControl(2)]))])];
  const readArgs: Record<string, unknown>[] = [];
  const inventoryPort = {
    async read(input: Record<string, unknown> = {}) {
      readArgs.push(input);
      const next = readings.length > 1 ? readings.shift()! : readings[0];
      if (next instanceof Error) throw next;
      return next;
    },
    async stop() {},
  };
  const chooser = vi.fn(async () => ({ text: '{"kind":"control","control":1,"instruction":"请亲手单击第一个按钮。"}' }));
  const tracker = { target: () => options.trackerTarget ?? null };
  const session = createUiaGuidanceSession({ inventory: inventoryPort, chooser, hasConsent: () => true, now: () => 1234,
    ...(options.withTracker === false ? {} : { targetWindow: tracker }) });
  return { session, readArgs, chooser };
}

describe('无截屏指引只读目标窗口的控件清单', () => {
  it('用跟踪到的目标窗口 hwnd 读取清单（不读提问瞬间的前台窗口）', async () => {
    const setup = guidanceFixture({ readings: [complete(controlsOf([rawControl(1), rawControl(2)])), complete(controlsOf([rawControl(1), rawControl(2)]))],
      trackerTarget: { hwnd: 42, title: '无标题 - 记事本', processName: 'notepad', at: 5000 } });
    const result = await setup.session.ask('帮我找到设置按钮');
    expect(result).toMatchObject({ status: 'ready', code: 'ok' });
    expect(setup.readArgs.every(args => args.hwnd === 42)).toBe(true);
    expect(setup.readArgs).toHaveLength(2);
    expect(result.targetWindow).toMatchObject({ hwnd: 42, title: '无标题 - 记事本', foreground: true });
    expect(setup.session.snapshot().target).toMatchObject({ hwnd: 42, label: '无标题 - 记事本' });
  });

  it('还没有目标窗口时明确失败：提示先点一下目标软件，不发送也不给箭头', async () => {
    const setup = guidanceFixture({ trackerTarget: null });
    const result = await setup.session.ask('帮我找到设置按钮');
    expect(result).toMatchObject({ status: 'blocked', code: 'target_window_missing', suggestSingleFrame: false });
    expect(result.message).toBe(reasonInfo('target_window_missing').message);
    expect(setup.readArgs).toHaveLength(0);
    expect(setup.chooser).not.toHaveBeenCalled();
  });

  it('目标窗口已关闭：明确失败、不画箭头、不改成读别的窗口', async () => {
    const setup = guidanceFixture({ readings: [unavailable('target_window_gone')],
      trackerTarget: { hwnd: 42, title: '无标题 - 记事本', processName: 'notepad', at: 5000 } });
    const result = await setup.session.ask('帮我找到设置按钮');
    expect(result).toMatchObject({ status: 'blocked', code: 'target_window_gone', suggestSingleFrame: false });
    expect(result.message).toContain('上次操作的窗口已关闭');
    expect(result.target).toBeUndefined();
    expect(result.targetWindow).toMatchObject({ hwnd: 42, foreground: false });
    expect(setup.readArgs).toEqual([{ hwnd: 42 }]);
    expect(setup.chooser).not.toHaveBeenCalled();
  });

  it('画箭头前窗口被关掉：同样按"窗口已关闭"失败，不给箭头', async () => {
    const setup = guidanceFixture({ readings: [complete(controlsOf([rawControl(1), rawControl(2)])), unavailable('target_window_gone')],
      trackerTarget: { hwnd: 42, title: '无标题 - 记事本', processName: 'notepad', at: 5000 } });
    const result = await setup.session.ask('帮我找到设置按钮');
    expect(result).toMatchObject({ status: 'blocked', code: 'target_window_gone' });
    expect(result.target).toBeUndefined();
  });

  it('目标窗口存在但控件清单为 0：沿用"这次需要你允许截一帧"', async () => {
    const setup = guidanceFixture({ readings: [complete([])], trackerTarget: { hwnd: 42, title: '游戏', processName: 'game', at: 5000 } });
    const result = await setup.session.ask('帮我找到开始按钮');
    expect(result).toMatchObject({ status: 'blocked', code: 'no_uia_controls', suggestSingleFrame: true });
    expect(result.targetWindow).toMatchObject({ hwnd: 42 });
  });

  it('目标窗口不在前台时仍按最近记录指引，并在快照里标出 foreground=false', async () => {
    const setup = guidanceFixture({ readings: [complete(controlsOf([rawControl(1)]), { foreground: false }), complete(controlsOf([rawControl(1)]), { foreground: false })],
      trackerTarget: { hwnd: 43, title: '设置 - Google Chrome', processName: 'chrome', at: 5000 } });
    const result = await setup.session.ask('帮我找到设置按钮');
    expect(result).toMatchObject({ status: 'ready' });
    expect(result.targetWindow).toMatchObject({ hwnd: 43, foreground: false });
    expect(setup.session.snapshot()).toMatchObject({ target: { hwnd: 43, foreground: false } });
  });

  it('没有注入跟踪器的旧调用方仍读当前前台窗口（兼容路径）', async () => {
    const setup = guidanceFixture({ readings: [complete(controlsOf([rawControl(1)])), complete(controlsOf([rawControl(1)]))], withTracker: false });
    const result = await setup.session.ask('帮我找到设置按钮');
    expect(result).toMatchObject({ status: 'ready' });
    expect(setup.readArgs).toEqual([{}, {}]);
  });
});

describe('目标窗口的隐私与静态边界', () => {
  it('跟踪脚本与跟踪模块只有窗口元数据，没有任何截屏/像素 API', () => {
    for (const file of ['windows-foreground-watch.ps1', 'foreground-target.cjs']) {
      const text = source(file);
      expect(text).not.toMatch(/CopyFromScreen|BitBlt|System\.Drawing|Graphics|screenshot|PNG|pngBase64|base64|Bitmap/i);
      expect(text).not.toMatch(/desktopCapturer|capturePage|toPNG|sanitizedPng/);
    }
    const watch = source('windows-foreground-watch.ps1');
    expect(watch).not.toMatch(/[^\x00-\x7f]/u); // 与既有原生脚本一致：纯 ASCII，避免 PowerShell 编码问题
    expect(watch).toContain('GetForegroundWindow');
    expect(watch).toContain('GetWindowTextW');
    expect(watch).not.toContain('AutomationElement');
    expect(watch).toContain('watch-foreground');
  });

  it('控件清单脚本支持按 hwnd 读目标窗口，窗口失效即 target_window_gone', () => {
    const script = source('windows-uia-inventory.ps1');
    expect(script).toContain('targetHwnd');
    expect(script).toContain('target_window_gone');
    expect(script).toContain('IsWindow');
  });

  it('宿主把跟踪器接进无截屏会话，并在撤回同意/退出时停止', () => {
    const host = readFileSync(new URL('../../apps/desktop/standalone-host.cjs', import.meta.url), 'utf8');
    expect(host).toContain("require('./observation/foreground-target.cjs')");
    expect(host).toContain('targetWindow: foregroundTarget');
    expect(host).toMatch(/foregroundTarget\.stop\(\);\n    foregroundTarget\.clear\(\);/);
    expect(host).toContain('if (guidanceMode === GUIDANCE_MODES.screenshotFree) foregroundTarget.start();');
  });

  it('界面与 preload 只透出窗口元数据，不透出控件名原文', () => {
    const preload = readFileSync(new URL('../../apps/desktop/pet-preload.cjs', import.meta.url), 'utf8');
    expect(preload).toContain("const target = projectRecord(rawGuidance.target, { hwnd: 'number', title: 'string', processName: 'string', label: 'string', at: 'number', foreground: 'boolean' });");
    expect(preload).not.toContain('controlNames');
    const pet = readFileSync(new URL('../../apps/desktop/pet.js', import.meta.url), 'utf8');
    expect(pet).toContain('正在按：');
    expect(pet).toContain('如果不对，点一下你要操作的软件窗口再回来提问');
    expect(pet).toContain('还没有记录到目标窗口');
  });
});