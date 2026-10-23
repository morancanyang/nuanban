const { PRODUCT_ICON_PATH } = require('./brand.cjs');
const { contentProtectionRequired } = require('./capture-visibility.cjs');

function createPetToolWindow({ BrowserWindow, getIndexPath, preloadPath, contentProtected = contentProtectionRequired(process.argv, 'pet'), onLifecycle = () => {}, onClosed = () => {} }) {
  let toolWindow;
  let loading;
  let revision = 0;

  function ensureWindow() {
    if (loading) return loading;
    if (toolWindow && !toolWindow.isDestroyed()) return Promise.resolve(toolWindow);
    const window = new BrowserWindow({ width: 1080, height: 860, minWidth: 420, minHeight: 640, title: '微光指引桌宠 · 工具小屋', icon: PRODUCT_ICON_PATH, backgroundColor: '#FFF8EF', show: false,
      webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    toolWindow = window;
    window.on('page-title-updated', event => event.preventDefault());
    window.setContentProtection(contentProtected === true);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.on('render-process-gone', () => onLifecycle('nuanban:host-renderer-gone', window));
    window.on('close', () => onLifecycle('nuanban:host-before-quit', window));
    window.on('move', () => onLifecycle('nuanban:host-window-moved', window));
    window.on('closed', () => {
      if (toolWindow === window) toolWindow = undefined;
      onClosed();
    });
    const pending = Promise.resolve().then(() => window.loadFile(getIndexPath())).then(() => window).catch(error => {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }).finally(() => { if (loading === pending) loading = undefined; });
    loading = pending;
    return pending;
  }

  async function show(route) {
    if (typeof route !== 'string' || !route.startsWith('/')) throw new Error('桌宠工具页面无效');
    const requestedRevision = ++revision;
    const window = await ensureWindow();
    if (window.isDestroyed()) throw new Error('桌宠工具窗口未就绪');
    if (requestedRevision !== revision) return true;
    await window.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(route)};`, true);
    if (window.isDestroyed()) throw new Error('桌宠工具窗口已关闭');
    if (requestedRevision !== revision) return true;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return true;
  }

  return { show, getWindow: () => toolWindow, getRevision: () => revision };
}

module.exports = { createPetToolWindow };
