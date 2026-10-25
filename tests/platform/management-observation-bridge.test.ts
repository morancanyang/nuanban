import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkedGuidanceStatus, checkedObservationStatus, guidanceSummary, localObservationBridge } from '../../apps/web/src/local-observation';

const { registerManagementObservationBridge } = createRequire(import.meta.url)('../../apps/desktop/management-observation-bridge.cjs');

const validGuidance = Object.freeze({ available: true, mode: 'screenshot-free', modeLabel: '无截屏（默认）', screenshotFree: true,
  active: true, textConsent: true, reasonCode: 'list_truncated', reasonMessage: '前台窗口控件较多，清单已按上限截断。', severity: 'info',
  suggestSingleFrame: false, counts: Object.freeze({ count: 42, limit: 400, truncated: true }), review: Object.freeze({ verdict: 'unchanged', code: 'review_unchanged', detail: 'no_change' }) });

function fixture() {
  const handlers = new Map<string, (event: unknown, ...argumentsList: unknown[]) => unknown>();
  const trustedEvent = {};
  const snapshot = { observation: { state: 'off', captureActive: false, sourceName: '', generation: 3, guidance: null as unknown },
    capabilities: { cloudAnalysis: false }, task: { question: 'synthetic-private-question' }, rawFrame: 'synthetic-private-frame' };
  const host = { hasPetWindow: () => true, snapshot: () => snapshot, showPetPanel: vi.fn(), requestObservation: vi.fn(async (_resume: boolean) => undefined),
    stop: vi.fn(async (_reason: string) => { snapshot.observation.state = 'stopped'; return { stopped: true }; }) };
  const bridge = registerManagementObservationBridge({ ipcMain: { handle: (name: string, handler: (event: unknown, ...argumentsList: unknown[]) => unknown) => handlers.set(name, handler),
    removeHandler: (name: string) => handlers.delete(name) }, isTrusted: (event: unknown) => event === trustedEvent, getHost: () => host });
  const invoke = (action: string, ...argumentsList: unknown[]) => handlers.get(`nuanban:observation:${action}`)!(trustedEvent, ...argumentsList);
  return { handlers, host, snapshot, bridge, invoke };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('管理窗口连接真实桌宠观察（合成桥接测试，不捕获用户屏幕）', () => {
  it('读取状态与打开桌宠均不开始采集，也不返回帧、教学文本或秘密', async () => {
    const current = fixture();
    expect(current.invoke('status')).toMatchObject({ state: 'off', captureActive: false, sourceName: '', cloudConfigured: false,
      guidance: { available: false, reason: 'unavailable' } });
    await current.invoke('show-pet');
    expect(current.host.showPetPanel).toHaveBeenCalledOnce();
    expect(current.host.requestObservation).not.toHaveBeenCalled();
    expect(JSON.stringify(current.invoke('status'))).not.toContain('synthetic-private');
  });

  it('打开桌宠等待窗口恢复完成，失败时不返回打开成功', async () => {
    const current = fixture();
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    current.host.showPetPanel.mockImplementationOnce(() => waiting);
    let opened = false;
    const opening = Promise.resolve(current.invoke('show-pet')).then(() => { opened = true; });
    await Promise.resolve();
    expect(opened).toBe(false);
    finish();
    await opening;
    expect(opened).toBe(true);
    current.host.showPetPanel.mockImplementationOnce(() => { throw new Error('窗口恢复失败'); });
    await expect(current.invoke('show-pet')).rejects.toThrow('窗口恢复失败');
    expect(current.host.requestObservation).not.toHaveBeenCalled();
  });

  it('开启和隐私恢复都委托原生本人选屏与用途确认，管理 renderer 不能代选', async () => {
    const current = fixture();
    await current.invoke('start');
    await current.invoke('resume');
    expect(current.host.requestObservation.mock.calls).toEqual([[false], [true]]);
    expect(current.host.showPetPanel).toHaveBeenCalledTimes(2);
    expect(() => current.invoke('start', { sourceId: 'screen:1', confirmed: true, cloudConsent: true })).toThrow('本人');
    expect(current.host.requestObservation).toHaveBeenCalledTimes(2);
  });

  it('拒绝其他窗口与 iframe，连只读状态也不能绕过来源检查', () => {
    const current = fixture();
    for (const handler of current.handlers.values()) expect(() => handler({})).toThrow('不可信');
    expect(current.host.requestObservation).not.toHaveBeenCalled();
    expect(current.host.stop).not.toHaveBeenCalled();
  });

  it('用户取消原生确认后保持关闭，不能把 IPC 成功当作采集开启', async () => {
    const current = fixture();
    await expect(current.invoke('start')).resolves.toMatchObject({ state: 'off', captureActive: false });
  });

  it('停止等待实际核心清理结果；清理未确认时不能返回已停止', async () => {
    const current = fixture();
    current.snapshot.observation.state = 'observing';
    current.snapshot.observation.captureActive = true;
    let complete!: () => void;
    const waiting = new Promise<void>(resolve => { complete = resolve; });
    current.host.stop.mockImplementationOnce(async () => {
      await waiting;
      current.snapshot.observation.state = 'cleanup_failed';
      return { stopped: false };
    });
    let settled = false;
    const stopping = Promise.resolve(current.invoke('stop')).then(value => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    complete();
    await expect(stopping).resolves.toMatchObject({ state: 'cleanup_failed', captureActive: true });
    expect(current.host.stop).toHaveBeenCalledWith('user');
  });

  it('尚无桌宠窗口或核心状态异常时失败，不回退成模拟观察', () => {
    const current = fixture();
    current.host.hasPetWindow = () => false;
    expect(() => current.invoke('status')).toThrow('尚未就绪');
    current.host.hasPetWindow = () => true;
    current.snapshot.observation.state = 'synthetic-unknown';
    expect(() => current.invoke('status')).toThrow('未确认');
  });

  it('独立桥接可完整注销', () => {
    const current = fixture();
    expect(current.handlers.size).toBe(5);
    current.bridge.dispose();
    expect(current.handlers.size).toBe(0);
  });

  it('停止过程仍占用采集时不显示已停止', () => {
    const current = fixture();
    current.snapshot.observation.state = 'stopped';
    current.snapshot.observation.captureActive = true;
    expect(current.invoke('status')).toMatchObject({ state: 'cleanup_failed', captureActive: true });
  });

  it('preload 只提供固定无参数命令，不把 renderer 权限声明透传给原生', async () => {
    const exposed = new Map<string, Record<string, (...argumentsList: unknown[]) => unknown>>();
    const invoke = vi.fn(async () => undefined);
    runInNewContext(readFileSync(new URL('../../apps/desktop/preload.cjs', import.meta.url), 'utf8'), {
      require: () => ({ contextBridge: { exposeInMainWorld: (name: string, value: Record<string, (...argumentsList: unknown[]) => unknown>) => exposed.set(name, value) },
        ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() } }),
    });
    const api = exposed.get('nuanbanObservation')!;
    for (const method of ['status', 'start', 'resume', 'stop', 'showPet']) await api[method]({ actor: 'owner', confirmed: true });
    expect(invoke.mock.calls.map(call => call.length)).toEqual([1, 1, 1, 1, 1]);
  });
});

describe('管理窗口透传指引模式（只允许文本元数据，校验后 fail-closed）', () => {
  it('合法 guidance 块原样透传，既有四个字段语义不变', () => {
    const current = fixture();
    current.snapshot.observation.guidance = validGuidance;
    const status = current.invoke('status') as Record<string, unknown>;
    expect(status).toMatchObject({ state: 'off', captureActive: false, sourceName: '', cloudConfigured: false });
    expect(status.guidance).toEqual({ available: true, mode: 'screenshot-free', modeLabel: '无截屏（默认）', screenshotFree: true,
      active: true, textConsent: true, reasonCode: 'list_truncated', reasonMessage: '前台窗口控件较多，清单已按上限截断。', severity: 'info',
      suggestSingleFrame: false, counts: { count: 42, limit: 400, truncated: true }, review: { verdict: 'unchanged', code: 'review_unchanged', detail: 'no_change' } });
  });

  it.each([
    ['mode', { mode: 'raw-pixels' }],
    ['modeLabel', { modeLabel: '' }],
    ['reasonCode', { reasonCode: 'not_a_reason' }],
    ['reasonMessage', { reasonMessage: 42 }],
    ['severity', { severity: 'critical' }],
    ['textConsent', { textConsent: 'yes' }],
    ['count', { counts: { count: -1, limit: 400, truncated: false } }],
    ['limit', { counts: { count: 1, limit: 99999, truncated: false } }],
    ['truncated', { counts: { count: 1, limit: 400, truncated: 'no' } }],
    ['review', { review: { verdict: 'maybe', code: 'x', detail: 'y' } }],
    ['extra', { available: false }],
  ] as const)('不合格指引块%s一律只回"未接入"，旧字段与原状态不受影响', (_field, patch) => {
    const current = fixture();
    current.snapshot.observation.guidance = { ...validGuidance, ...patch };
    const status = current.invoke('status') as Record<string, unknown>;
    expect(status.guidance).toEqual({ available: false, reason: 'unavailable' });
    expect(status).toMatchObject({ state: 'off', captureActive: false, sourceName: '', cloudConfigured: false });
    expect(JSON.stringify(status)).not.toContain('无截屏');
  });

  it('缺字段、旧宿主与私有数据都不会过桥', () => {
    const current = fixture();
    expect((current.invoke('status') as Record<string, unknown>).guidance).toEqual({ available: false, reason: 'unavailable' });
    current.snapshot.observation.guidance = { ...validGuidance, controlNames: ['私密文件名.txt'], rect: { x: 1, y: 2, width: 3, height: 4 }, path: 'C:\\private\\app.exe' };
    const status = current.invoke('status') as Record<string, unknown>;
    expect(status.guidance).toEqual({ available: true, mode: 'screenshot-free', modeLabel: '无截屏（默认）', screenshotFree: true,
      active: true, textConsent: true, reasonCode: 'list_truncated', reasonMessage: '前台窗口控件较多，清单已按上限截断。', severity: 'info',
      suggestSingleFrame: false, counts: { count: 42, limit: 400, truncated: true }, review: { verdict: 'unchanged', code: 'review_unchanged', detail: 'no_change' } });
    expect(JSON.stringify(status)).not.toContain('私密');
    expect(JSON.stringify(status)).not.toContain('private');
  });

  it('桥接本身没有取帧/取图能力（静态检查）', () => {
    const source = readFileSync(new URL('../../apps/desktop/management-observation-bridge.cjs', import.meta.url), 'utf8');
    for (const forbidden of ['desktopCapturer', 'nativeImage', 'capturePage', 'sanitizedPng', 'getSources', 'thumbnail']) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe('管理页指引模式适配与文案', () => {
  it('合法指引块被校验并渲染为模式/原因/计数/同意四行文案', () => {
    const checked = checkedGuidanceStatus({ ...validGuidance });
    expect(checked).toMatchObject({ available: true, mode: 'screenshot-free', textConsent: true, counts: { count: 42, limit: 400, truncated: true } });
    const summary = guidanceSummary(checked);
    expect(summary.mode).toContain('无截屏（默认）');
    expect(summary.reason).toContain('截断');
    expect(summary.controls).toBe('已读取 42 个可指引控件（前台窗口上限 400，清单已截断）');
    expect(summary.consent).toContain('已同意');
  });

  it('缺字段/类型错/枚举越界/多余私有数据都退回"模式信息未接入"，不渲染未校验文案', () => {
    for (const value of [undefined, null, {}, { available: false }, { ...validGuidance, mode: 'x' }, { ...validGuidance, textConsent: 1 },
      { ...validGuidance, counts: { count: 1.5, limit: 400, truncated: false } }, { ...validGuidance, review: { verdict: 'maybe' } }]) {
      const checked = checkedGuidanceStatus(value);
      expect(checked).toMatchObject({ available: false, mode: null });
      const summary = guidanceSummary(checked);
      expect(summary.mode).toContain('模式信息未接入');
      expect(summary.reason).toContain('不会因为没有模式信息就改用截屏');
      expect(summary.consent).toContain('未知');
    }
  });

  it('未同意与单帧模式给出不同的同意文案，未截断时文案明确', () => {
    const noConsent = checkedGuidanceStatus({ ...validGuidance, textConsent: false, counts: { count: 3, limit: 400, truncated: false } });
    expect(guidanceSummary(noConsent)).toMatchObject({ controls: '已读取 3 个可指引控件（前台窗口上限 400，未截断）' });
    expect(guidanceSummary(noConsent).consent).toContain('未同意');
    const singleFrame = checkedGuidanceStatus({ ...validGuidance, mode: 'single-frame', screenshotFree: false, modeLabel: '单帧截屏（需本人当次允许）' });
    expect(guidanceSummary(singleFrame).consent).toContain('不适用于当前模式');
  });
});

describe('管理页观察状态适配', () => {
  it('无原生接口或接口残缺时不声称支持真实采集', () => {
    vi.stubGlobal('window', {});
    expect(localObservationBridge()).toBeUndefined();
    vi.stubGlobal('window', { nuanbanObservation: { status: vi.fn() } });
    expect(localObservationBridge()).toBeUndefined();
  });

  it('只接收可核对状态，额外原始数据不进入 UI', () => {
    const value = { state: 'observing', captureActive: true, sourceName: '合成屏幕', cloudConfigured: false, rawFrame: 'not-exposed' };
    expect(checkedObservationStatus(value)).not.toHaveProperty('rawFrame');
    expect(() => checkedObservationStatus({ ...value, captureActive: 'true' })).toThrow('未确认');
    expect(() => checkedObservationStatus({ ...value, state: 'success' })).toThrow('未确认');
    expect(() => checkedObservationStatus(null)).toThrow('未确认');
  });
});
