import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { PRODUCT_ICON_PATH } = require('../../apps/desktop/brand.cjs');
const { createPetToolWindow } = require('../../apps/desktop/pet-tool-window.cjs');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

function fixture(load: () => Promise<unknown> = async () => undefined, options: Record<string, unknown> = {}) {
  const windows: TestWindow[] = [];
  class TestWindow extends EventEmitter {
    destroyed = false;
    minimized = false;
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn(), executeJavaScript: vi.fn(async (_source: string, _gesture: boolean): Promise<void> => undefined) });
    setContentProtection = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    restore = vi.fn(() => { this.minimized = false; });
    hide = vi.fn();
    loadFile = vi.fn(load);
    destroy = vi.fn(() => { this.destroyed = true; this.emit('closed'); });
    isDestroyed = () => this.destroyed;
    isMinimized = () => this.minimized;
    constructor(readonly options: Record<string, unknown>) { super(); windows.push(this); }
  }
  const onLifecycle = vi.fn();
  const onClosed = vi.fn();
  const tools = createPetToolWindow({ BrowserWindow: TestWindow, getIndexPath: () => 'local-client/index.html', preloadPath: 'local-client/preload.cjs', onLifecycle, onClosed, ...options });
  return { windows, tools, onLifecycle, onClosed };
}

describe('桌宠独立工具窗口，不复用或修改客户端主窗口', () => {
  it('按需创建工具并保持隔离、沙箱、可截图录屏与本地加载限制', async () => {
    const current = fixture();
    expect(current.tools.getWindow()).toBeUndefined();
    expect(current.windows).toHaveLength(0);
    await expect(current.tools.show('/pets/draw')).resolves.toBe(true);
    const window = current.windows[0]!;
    expect(window.options).toMatchObject({ title: '微光指引桌宠 · 工具小屋', icon: PRODUCT_ICON_PATH, show: false, webPreferences: { preload: 'local-client/preload.cjs', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
    expect(window.loadFile).toHaveBeenCalledExactlyOnceWith('local-client/index.html');
    expect(window.setContentProtection).toHaveBeenCalledWith(false);
    expect(window.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' });
    const preventTitleDefault = vi.fn();
    window.emit('page-title-updated', { preventDefault: preventTitleDefault });
    expect(preventTitleDefault).toHaveBeenCalledTimes(1);
    const preventDefault = vi.fn();
    window.webContents.emit('will-navigate', { preventDefault });
    window.webContents.emit('will-attach-webview', { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(window.webContents.executeJavaScript).toHaveBeenCalledWith('window.location.hash = "/pets/draw";', true);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it('显式保护参数下仍把工具窗口排除出截图与录屏', async () => {
    const current = fixture(undefined, { contentProtected: true });
    await expect(current.tools.show('/pets/draw')).resolves.toBe(true);
    expect(current.windows[0]!.setContentProtection).toHaveBeenCalledWith(true);
  });

  it('并发打开多个功能只创建一个独立工具，以最后选择的页面为准', async () => {
    const waiting = deferred();
    const current = fixture(() => waiting.promise);
    const drawing = current.tools.show('/pets/draw');
    const notes = current.tools.show('/notes');
    expect(current.windows).toHaveLength(1);
    expect(current.windows[0]!.show).not.toHaveBeenCalled();
    waiting.resolve();
    await Promise.all([drawing, notes]);
    expect(current.windows[0]!.webContents.executeJavaScript).toHaveBeenCalledExactlyOnceWith('window.location.hash = "/notes";', true);
    expect(current.tools.getRevision()).toBe(2);
  });

  it('再次进入恢复原工具而非重载，保留草稿且不占用客户端窗口', async () => {
    const current = fixture();
    await current.tools.show('/chat/new');
    const window = current.windows[0]!;
    window.hide();
    window.minimized = true;
    await current.tools.show('/pets');
    expect(current.windows).toHaveLength(1);
    expect(window.loadFile).toHaveBeenCalledTimes(1);
    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.webContents.executeJavaScript).toHaveBeenLastCalledWith('window.location.hash = "/pets";', true);
  });

  it('生命周期事件只指向所属工具，关闭后可独立重建', async () => {
    const current = fixture();
    await current.tools.show('/notes');
    const window = current.windows[0]!;
    window.emit('move');
    window.webContents.emit('render-process-gone');
    window.emit('close');
    expect(current.onLifecycle.mock.calls).toEqual([
      ['nuanban:host-window-moved', window], ['nuanban:host-renderer-gone', window], ['nuanban:host-before-quit', window],
    ]);
    window.destroy();
    expect(current.onClosed).toHaveBeenCalledTimes(1);
    expect(current.tools.getWindow()).toBeUndefined();
    await current.tools.show('/settings');
    expect(current.windows).toHaveLength(2);
    expect(current.tools.getWindow()).not.toBe(window);
  });

  it('加载失败销毁空窗，后续重试可重新创建，不显示失效页面', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('synthetic load failure')).mockResolvedValue(undefined);
    const current = fixture(load);
    await expect(current.tools.show('/notes')).rejects.toThrow('synthetic load failure');
    expect(current.windows[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(current.windows[0]!.show).not.toHaveBeenCalled();
    await current.tools.show('/notes');
    expect(current.windows).toHaveLength(2);
    expect(current.windows[1]!.show).toHaveBeenCalledTimes(1);
  });

  it('切页期间关闭工具不重新弹出已关闭窗口', async () => {
    const current = fixture();
    await current.tools.show('/notes');
    const window = current.windows[0]!;
    const waiting = deferred();
    window.webContents.executeJavaScript.mockImplementationOnce(() => waiting.promise);
    const opening = current.tools.show('/pets/draw');
    await vi.waitFor(() => expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(2));
    window.destroy();
    waiting.resolve();
    await expect(opening).rejects.toThrow('已关闭');
    expect(window.show).toHaveBeenCalledTimes(1);
  });

  it('拒绝非本地路由；主进程分别绑定桌宠工具与客户端入口', async () => {
    const current = fixture();
    await expect(current.tools.show('javascript:alert(1)')).rejects.toThrow('页面无效');
    expect(current.windows).toHaveLength(0);
    const main = readFileSync(join(import.meta.dirname, '../../apps/desktop/main.cjs'), 'utf8');
    expect(main).toContain('showManagement: showMainWindow');
    expect(main).toContain('showPetTool: route => petTools.show(route)');
    expect(main).not.toContain('workspaceBridge?.setMode');
    expect(main).not.toContain("showMainWindow(route, 'pet-tool')");
  });
});
