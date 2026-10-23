import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createRealtimeVoiceHost } = createRequire(import.meta.url)('../../apps/desktop/realtime-voice-host.cjs');
const hosts: Array<{ dispose(): void }> = [];
type Handler = (event: unknown, ...argumentsList: unknown[]) => unknown;
const offer = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

function fixture(presentation: 'window' | 'pet' = 'window') {
  const windows: FakeWindow[] = [];
  const handlers = new Map<string, Handler>();
  class FakeWindow extends EventEmitter {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' }, isDestroyed: () => this.destroyed, setWindowOpenHandler: vi.fn(), send: vi.fn() });
    protection = false;
    show = vi.fn();
    focus = vi.fn();
    constructor(readonly settings: Record<string, unknown>) { super(); windows.push(this); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    setContentProtection(value: boolean) { this.protection = value; }
    async loadFile(file: string) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
  }
  const permissions = { check: null as null | ((contents: unknown, permission: string, origin: string, details: Record<string, unknown>) => boolean),
    request: null as null | ((contents: unknown, permission: string, callback: (granted: boolean) => void, details: Record<string, unknown>) => void) };
  const privateSession = { setPermissionCheckHandler: vi.fn(handler => { permissions.check = handler; }),
    setPermissionRequestHandler: vi.fn(handler => { permissions.request = handler; }), setDisplayMediaRequestHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() } };
  const session = { fromPartition: vi.fn((_partition: string, _options: { cache: boolean }) => privateSession) };
  const client = { status: vi.fn(() => ({ configured: true })), check: vi.fn(async (_options: { signal: AbortSignal }) => ({})),
    connect: vi.fn(async (_offer: string, _options: { signal: AbortSignal }) => ({ answer: offer })) };
  const showDialog = vi.fn(async (_options: Record<string, unknown>) => ({ response: 0 }));
  const beforeStart = vi.fn(async () => {});
  const onState = vi.fn();
  const onTranscript = vi.fn();
  const host = createRealtimeVoiceHost({ electron: { BrowserWindow: FakeWindow, session,
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) },
    screen: { getPrimaryDisplay: () => ({ workArea: { width: 1200, height: 900 } }) } }, showDialog, beforeStart, onState, onTranscript, presentation, client });
  hosts.push(host);
  const event = () => ({ sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame });
  const invoke = (name: string, ...argumentsList: unknown[]) => handlers.get('nuanban:voice-chat:' + name)!(event(), ...argumentsList);
  return { host, client, windows, session, privateSession, permissions, showDialog, beforeStart, onState, onTranscript, handlers, event, invoke };
}

afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); });

describe('独立实时语音宿主权限与生命周期（合成窗口）', () => {
  it('桌宠气泡模式隐藏音频宿主，只转发受限字幕和控制，不显示聊天窗', async () => {
    const current = fixture('pet');
    await current.host.open();
    expect(current.windows[0].show).not.toHaveBeenCalled();
    expect(current.windows[0].settings).toMatchObject({ show: false, skipTaskbar: true });
    expect(current.invoke('mode')).toEqual({ mode: 'realtime', presentation: 'pet' });
    await current.invoke('connect', offer);
    current.invoke('state', 'listening');
    current.host.control('mute');
    expect(current.windows[0].webContents.send).toHaveBeenCalledWith('nuanban:voice-chat:control', 'mute');
    current.invoke('transcript', { id: 'assistant:turn-1', role: 'assistant', text: '合成云端字幕', secret: 'not-exposed' });
    expect(current.onTranscript).toHaveBeenCalledExactlyOnceWith({ type: 'transcript', id: 'assistant:turn-1', role: 'assistant', text: '合成云端字幕' });
    expect(() => current.invoke('transcript', { id: 'turn', role: 'system', text: 'invalid' })).toThrow('字幕无效');
    expect(() => current.host.control('record')).toThrow('不可用');
    await current.host.open();
    expect(current.windows[0].show).not.toHaveBeenCalled();
    current.host.stop();
    expect(() => current.host.control('unmute')).toThrow('不可用');
  });

  it('默认关闭，不创建窗口、不触发权限或供应请求', () => {
    const current = fixture();
    expect(current.host.snapshot()).toMatchObject({ state: 'off', active: false, microphoneActive: false });
    expect(current.windows).toHaveLength(0);
    expect(current.session.fromPartition).not.toHaveBeenCalled();
    expect(current.client.check).not.toHaveBeenCalled();
  });

  it('未配置和本人取消都不创建音频上下文', async () => {
    const current = fixture();
    current.client.status.mockReturnValueOnce({ configured: false });
    await current.host.open();
    expect(current.showDialog).toHaveBeenLastCalledWith(expect.objectContaining({ title: '面对面语音待配置' }));
    current.showDialog.mockResolvedValueOnce({ response: 1 });
    await current.host.open();
    expect(current.windows).toHaveLength(0);
    expect(current.client.check).not.toHaveBeenCalled();
    expect(current.host.snapshot().active).toBe(false);
  });

  it('同意后先检查后端并关闭本地唤醒，使用不持久化隔离沙箱窗口', async () => {
    const current = fixture();
    await current.host.open();
    expect(current.showDialog.mock.calls[0][0]).toMatchObject({ defaultId: 1, cancelId: 1 });
    expect(String(current.showDialog.mock.calls[0][0].detail)).toContain('音频不会先做本地脱敏');
    expect(current.client.check).toHaveBeenCalledTimes(1);
    expect(current.beforeStart).toHaveBeenCalledTimes(1);
    expect(current.session.fromPartition.mock.calls[0][0]).toMatch(/^nuanban-voice-/u);
    expect(current.windows[0].settings).toMatchObject({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, session: current.privateSession } });
    expect(current.windows[0].protection).toBe(false);
    expect(current.host.snapshot()).toMatchObject({ active: true, microphoneActive: true });
  });

  it('仅当前主框架能获得麦克风；相机、未知、子框架与其他窗口全部拒绝', async () => {
    const current = fixture();
    await current.host.open();
    const window = current.windows[0];
    const details = { requestingUrl: window.webContents.mainFrame.url, isMainFrame: true, mediaType: 'audio' };
    expect(current.permissions.check!(window.webContents, 'media', 'file://', details)).toBe(true);
    for (const change of [{ mediaType: 'video' }, { mediaType: 'unknown' }, { isMainFrame: false }, { requestingUrl: 'https://evil.example' }]) {
      expect(current.permissions.check!(window.webContents, 'media', 'file://', { ...details, ...change })).toBe(false);
    }
    expect(current.permissions.check!({}, 'media', 'file://', details)).toBe(false);
    const permission = vi.fn();
    current.permissions.request!(window.webContents, 'media', permission, { ...details, mediaTypes: ['audio', 'video'] });
    expect(permission).toHaveBeenCalledWith(false);
    current.permissions.request!(window.webContents, 'media', permission, { ...details, mediaTypes: ['audio'] });
    expect(permission).toHaveBeenLastCalledWith(true);
    current.host.stop();
    expect(current.permissions.check!(window.webContents, 'media', 'file://', details)).toBe(false);
  });

  it('停止使尚未完成的原生确认作废，不会迟到后重新开启', async () => {
    const current = fixture();
    let confirm!: (result: { response: number }) => void;
    current.showDialog.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    const opening = current.host.open();
    expect(current.host.snapshot()).toMatchObject({ state: 'confirming', active: true, microphoneActive: false });
    current.host.stop('lock');
    confirm({ response: 0 });
    await opening;
    expect(current.client.check).not.toHaveBeenCalled();
    expect(current.windows).toHaveLength(0);
  });

  it('握手中关闭销毁音频窗口并取消在途连接，迟到 SDP 不可用', async () => {
    const current = fixture();
    await current.host.open();
    let answer!: (result: { answer: string }) => void;
    current.client.connect.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const pending = current.invoke('connect', offer);
    const requestSignal = current.client.connect.mock.calls[0][1].signal;
    current.host.stop('lock');
    expect(requestSignal.aborted).toBe(true);
    expect(current.windows[0].destroyed).toBe(true);
    answer({ answer: offer });
    await expect(pending).rejects.toThrow('未完成');
    expect(current.host.snapshot()).toMatchObject({ active: false, microphoneActive: false });
  });

  it('IPC 拒绝子框架、重复 SDP 和伪造状态', async () => {
    const current = fixture();
    await current.host.open();
    expect(() => current.handlers.get('nuanban:voice-chat:stop')!({ ...current.event(), senderFrame: { url: current.windows[0].webContents.mainFrame.url } })).toThrow('不可信');
    await current.invoke('connect', offer);
    await expect(current.invoke('connect', offer)).rejects.toThrow('失效');
    expect(() => current.invoke('state', 'off')).toThrow('状态无效');
  });

  it('后端未配置或本地唤醒未停时不创建音频窗口', async () => {
    const current = fixture();
    current.client.check.mockRejectedValueOnce(new Error('server unavailable'));
    await expect(current.host.open()).rejects.toThrow('server unavailable');
    expect(current.windows).toHaveLength(0);
    expect(current.beforeStart).not.toHaveBeenCalled();
    current.beforeStart.mockRejectedValueOnce(new Error('wake still listening'));
    await expect(current.host.open()).rejects.toThrow('wake still listening');
    expect(current.windows).toHaveLength(0);
    expect(current.host.snapshot().microphoneActive).toBe(false);
  });

  it('原生窗口销毁失败不假报停麦，后续停止仍可重试', async () => {
    const current = fixture();
    await current.host.open();
    const window = current.windows[0];
    const destroy = vi.spyOn(window, 'destroy').mockImplementationOnce(() => { throw new Error('synthetic cleanup failure'); });
    expect(current.host.stop()).toEqual({ stopped: false, microphoneActive: true });
    expect(current.host.snapshot()).toMatchObject({ active: true, microphoneActive: true, state: 'error' });
    expect(current.host.snapshot().message).toContain('尚未真实停止');
    expect(current.host.stop()).toEqual({ stopped: true, microphoneActive: false });
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it('重复打开只聚焦；关闭、渲染失败和退出均释放独立会话', async () => {
    const current = fixture();
    await current.host.open();
    await current.host.open();
    expect(current.windows).toHaveLength(1);
    current.windows[0].emit('close');
    expect(current.host.snapshot().microphoneActive).toBe(false);
    await current.host.open();
    current.windows[1].webContents.emit('render-process-gone');
    expect(current.windows[1].destroyed).toBe(true);
    expect(current.host.snapshot()).toMatchObject({ state: 'error', microphoneActive: false });
    current.host.dispose();
    expect(current.handlers.size).toBe(0);
  });
});
