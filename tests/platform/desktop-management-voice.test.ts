import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkedVoiceStatus, localVoiceBridge } from '../../apps/web/src/local-voice';

const { registerManagementVoiceBridge } = createRequire(import.meta.url)('../../apps/desktop/management-voice-bridge.cjs');
type Handler = (event: unknown, ...argumentsList: unknown[]) => unknown;
const read = (file: string) => readFileSync(new URL(`../../apps/desktop/${file}`, import.meta.url), 'utf8');
const cloudDictation = { enabled: false, available: false };
const disabled = { phase: 'disabled' as const, enabled: false, microphoneActive: false, dictationAvailable: true, localOnly: true as const, message: '本地语音未开启', cloudDictation };

function fixture() {
  const event = {};
  const handlers = new Map<string, Handler>();
  let wake = { ...disabled, phase: 'disabled', reason: disabled.message };
  const host = { hasPetWindow: vi.fn(() => true), showPetPanel: vi.fn(), snapshot: () => ({ wake }),
    cloudDictationStatus: vi.fn(() => cloudDictation), setCloudDictation: vi.fn(async (enabled: boolean) => ({ enabled })),
    requestLocalVoice: vi.fn(async () => { wake = { ...wake, phase: 'listening', enabled: true, microphoneActive: true }; }),
    stopLocalVoice: vi.fn(async () => { wake = { ...wake, phase: 'disabled', enabled: false, microphoneActive: false }; }) };
  const openMicrophoneSettings = vi.fn(async () => undefined);
  const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) };
  const bridge = registerManagementVoiceBridge({ ipcMain, isTrusted: (candidate: unknown) => candidate === event, getHost: () => host, openMicrophoneSettings });
  const invoke = (action: string, ...argumentsList: unknown[]) => handlers.get(`nuanban:voice:${action}`)!(event, ...argumentsList);
  return { host, event, handlers, bridge, invoke, openMicrophoneSettings, setWake: (value: Partial<typeof wake>) => { wake = { ...wake, ...value }; } };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('管理端语音入口：仅桥接独立桌宠，默认不启麦（合成依赖）', () => {
  it('云端听写开关只按原生返回值刷新，用户取消时保持关闭', async () => {
    const current = fixture();
    expect(await current.invoke('status')).toMatchObject({ cloudDictation: { enabled: false, available: false } });
    current.host.setCloudDictation.mockResolvedValueOnce({ enabled: true });
    await expect(current.invoke('set-cloud-dictation', true)).resolves.toEqual({ enabled: true });
    expect(current.host.setCloudDictation).toHaveBeenCalledWith(true);
    current.host.setCloudDictation.mockResolvedValueOnce({ enabled: false });
    await expect(current.invoke('set-cloud-dictation', true)).resolves.toEqual({ enabled: false });
    await expect(current.invoke('set-cloud-dictation', 'yes')).resolves.toEqual({ enabled: false });
    expect(current.host.setCloudDictation).toHaveBeenLastCalledWith(false);
  });

  it('未配置网关或宿主未就绪时拒绝开启云端听写', async () => {
    const current = fixture();
    current.host.setCloudDictation.mockRejectedValueOnce(new Error('本机尚未配置可用的模型网关，云端听写不可用'));
    await expect(current.invoke('set-cloud-dictation', true)).rejects.toThrow('模型网关');
    const missing = fixture();
    delete (missing.host as { setCloudDictation?: unknown }).setCloudDictation;
    await expect(missing.invoke('set-cloud-dictation', true)).rejects.toThrow('尚未就绪');
  });

  it('读取状态不探测、不申请权限、不打开系统设置，也不泄露额外运行时字段', () => {
    const current = fixture();
    const status = current.invoke('status');
    expect(status).toEqual(disabled);
    expect(Object.isFrozen(status)).toBe(true);
    expect(current.host.requestLocalVoice).not.toHaveBeenCalled();
    expect(current.host.showPetPanel).not.toHaveBeenCalled();
    expect(current.openMicrophoneSettings).not.toHaveBeenCalled();
  });

  it('只有显式开启才交由桌宠原生本人确认流程，停止只停止本地语音', async () => {
    const current = fixture();
    expect(await current.invoke('enable')).toMatchObject({ phase: 'listening', enabled: true, microphoneActive: true });
    expect(current.host.showPetPanel).toHaveBeenCalledOnce();
    expect(current.host.requestLocalVoice).toHaveBeenCalledExactlyOnceWith();
    expect(await current.invoke('disable')).toMatchObject({ phase: 'disabled', enabled: false, microphoneActive: false });
    expect(current.host.stopLocalVoice).toHaveBeenCalledExactlyOnceWith();
  });

  it('取消本人确认不显示成功，原生开启失败不伪装成监听中', async () => {
    const current = fixture();
    current.host.requestLocalVoice.mockImplementationOnce(async () => undefined);
    expect(await current.invoke('enable')).toEqual(disabled);
    current.host.requestLocalVoice.mockRejectedValueOnce(new Error('local engine unavailable'));
    await expect(current.invoke('enable')).rejects.toThrow('local engine unavailable');
    expect(current.invoke('status')).toEqual(disabled);
  });

  it('停止尚未确认时保留真实活动状态，而非提前报告麦克风已关闭', async () => {
    const current = fixture();
    current.setWake({ phase: 'stopping', enabled: true, microphoneActive: true });
    current.host.stopLocalVoice.mockImplementationOnce(async () => undefined);
    expect(await current.invoke('disable')).toMatchObject({ phase: 'stopping', enabled: true, microphoneActive: true });
  });

  it('所有入口拒绝其他窗口、子框架或附加授权参数', () => {
    const current = fixture();
    for (const action of ['status', 'enable', 'disable', 'open-settings']) {
      const handler = current.handlers.get(`nuanban:voice:${action}`)!;
      expect(() => handler({})).toThrow('不可信');
      expect(() => handler(current.event, { actor: 'owner', confirmed: true })).toThrow('本人');
    }
    expect(current.host.requestLocalVoice).not.toHaveBeenCalled();
    expect(current.openMicrophoneSettings).not.toHaveBeenCalled();
  });

  it('缺独立桌宠或状态不明时拒绝，不冒充已获得本机权限', () => {
    const current = fixture();
    current.host.hasPetWindow.mockReturnValueOnce(false);
    expect(() => current.invoke('enable')).toThrow('尚未就绪');
    current.setWake({ phase: 'unknown' });
    expect(() => current.invoke('status')).toThrow('未确认');
    current.setWake({ phase: 'disabled', localOnly: false as true });
    expect(() => current.invoke('status')).toThrow('未确认');
  });

  it('系统设置只由显式点击打开固定页面，注销会移除所有处理器', async () => {
    const current = fixture();
    expect(await current.invoke('open-settings')).toBe(true);
    expect(current.openMicrophoneSettings).toHaveBeenCalledExactlyOnceWith();
    expect(current.host.requestLocalVoice).not.toHaveBeenCalled();
    current.bridge.dispose();
    expect(current.handlers.size).toBe(0);
  });

  it('preload 不传 renderer 自带的参数，且主进程保持全局拒绝权限', async () => {
    const exposed = new Map<string, Record<string, (...argumentsList: unknown[]) => Promise<unknown>>>();
    const invoke = vi.fn(async (_channel: string) => disabled);
    runInNewContext(read('preload.cjs'), {
      require: () => ({ contextBridge: { exposeInMainWorld: (name: string, bridge: Record<string, (...argumentsList: unknown[]) => Promise<unknown>>) => exposed.set(name, bridge) },
        ipcRenderer: { invoke, on: vi.fn() } }),
    });
    const bridge = exposed.get('nuanbanVoice')!;
    expect(Object.isFrozen(bridge)).toBe(true);
    for (const [method, channel] of [['status', 'status'], ['dictate', 'dictate'], ['cancelDictation', 'cancel-dictation'], ['enable', 'enable'], ['disable', 'disable'], ['openSettings', 'open-settings']]) {
      await bridge[method]({ confirmed: true, url: 'https://not-permitted.invalid' });
      expect(invoke).toHaveBeenLastCalledWith(`nuanban:voice:${channel}`);
    }
    const main = read('main.cjs');
    expect(main).toContain('setPermissionRequestHandler((_contents,_permission,callback)=>callback(false))');
    expect(main).toContain('setPermissionCheckHandler(()=>false)');
    expect(main).toContain("electron.shell.openExternal('ms-settings:privacy-microphone')");
    expect(read('standalone-host.cjs')).toContain('requestLocalVoice: enableWake, stopLocalVoice: disableWake');
  });
});

describe('语音状态边界', () => {
  it('缺桥或旧桥不调用浏览器采集，也不声称本机引擎可用', () => {
    vi.stubGlobal('window', {});
    expect(localVoiceBridge()).toBeUndefined();
    vi.stubGlobal('window', { nuanbanVoice: { status: vi.fn() } });
    expect(localVoiceBridge()).toBeUndefined();
  });

  it('验证已知本地状态，并剔除其他字段', () => {
    expect(checkedVoiceStatus({ ...disabled, transcript: 'do not project' })).toEqual(disabled);
    expect(checkedVoiceStatus({ ...disabled, phase: 'error', enabled: true, microphoneActive: true })).toMatchObject({ phase: 'error', microphoneActive: true });
  });

  it.each([null, {}, { ...disabled, phase: 'unknown' }, { ...disabled, localOnly: false },
    { ...disabled, microphoneActive: 'false' }, { ...disabled, enabled: true }, { ...disabled, message: 'x'.repeat(501) }])('拒绝缺失或矛盾状态 %j', value => {
    expect(() => checkedVoiceStatus(value)).toThrow('未确认');
  });
});
