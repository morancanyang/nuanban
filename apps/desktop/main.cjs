const electron = require('electron');
const { app, BrowserWindow, ipcMain, safeStorage, session, Notification, dialog } = electron;
const { createLifecycleController } = require('./lifecycle.cjs');
const { createStandaloneHost } = require('./standalone-host.cjs');
const { createPetWorkspace } = require('./pet-workspace.cjs');
const { createPetToolWindow } = require('./pet-tool-window.cjs');
const { createManagementWindowVisibility } = require('./management-window-visibility.cjs');
const { registerManagementObservationBridge } = require('./management-observation-bridge.cjs');
const { registerManagementCompanionBridge } = require('./management-companion-bridge.cjs');
const { registerManagementVoiceBridge } = require('./management-voice-bridge.cjs');
const { createImageQuestionService, registerManagementImageQuestionBridge } = require('./image-question.cjs');
const { loadConfiguredProvider } = require('./ai-provider.cjs');
const { createProviderAnalysisClient } = require('./provider-analysis.cjs');
const { registerManagementTextQuestionBridge } = require('./text-question.cjs');
const { createLocalArtworkStore, registerLocalArtworkBridge } = require('./local-artwork.cjs');
const { createLocalModelStore, registerLocalModelBridge } = require('./local-model.cjs');
const { createLocalModelValidator } = require('./model-validator.cjs');
const { createDesktopReminderStore, createSafeStoragePayloadCodec } = require('./reminder-store.cjs');
const { createDesktopReminderNotificationBridge } = require('./reminder-notification-bridge.cjs');
const { createWindowsCapabilityPolicy } = require('./native-runtime.cjs');
const { PET_AVATAR_CSP } = require('./xingyun-avatar.cjs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const { PRODUCT_ICON_PATH } = require('./brand.cjs');
const indexPath = path.join(__dirname, 'ui', 'index.html');
const developmentIndex = path.join(__dirname, '..', 'web', 'dist', 'index.html');
const managementIndex = () => !app.isPackaged && fs.existsSync(developmentIndex) ? developmentIndex : indexPath;
let mainWindow;
let mainWindowLoading;
let standaloneHost;
let quitAfterLifecycle = false;
let shutdownPromise;
let reminderStore;
let reminderNotifications;
let artworkBridge;
let modelBridge;
let modelValidator;
let imageQuestionBridge;
let textQuestionBridge;
let aiProvider;
let workspaceBridge;
const managementVisibility = createManagementWindowVisibility({ displayCompatible: process.argv.includes('--client-display-compatible') });
const petTools = createPetToolWindow({ BrowserWindow, getIndexPath: managementIndex, preloadPath: path.join(__dirname, 'preload.cjs'),
  onLifecycle: (name, window) => {
    if (name !== 'nuanban:host-window-moved') { imageQuestionBridge?.stop(); textQuestionBridge?.stop(); }
    notifyLifecycle(name, window);
  }, onClosed: quitIfNoVisibleWindows });
function notifyLifecycle(name, origin) {
  for (const window of origin ? [origin] : [mainWindow, petTools.getWindow()]) {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('nuanban:lifecycle', name);
  }
}
function hasVisibleClientWindow() {
  return [mainWindow, petTools.getWindow()].some(window => window && !window.isDestroyed() && (window.isVisible() || window.isMinimized()));
}
function quitIfNoVisibleWindows() {
  if (!quitAfterLifecycle && !hasVisibleClientWindow() && standaloneHost?.getPetWindow()?.isVisible() === false) app.quit();
}
function trusted(event) {
  const expected = pathToFileURL(managementIndex()).href;
  const window = [mainWindow, petTools.getWindow()].find(candidate => candidate && !candidate.isDestroyed() && event.sender === candidate.webContents);
  return Boolean(window && !window.webContents.isDestroyed() && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url.split('#')[0] === expected);
}
async function showMainWindow(route = '/') {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!mainWindowLoading) mainWindowLoading = createWindow().finally(() => { mainWindowLoading = undefined; });
  }
  return managementVisibility.show(mainWindow, { route, ready: mainWindowLoading });
}
function registerBridge() {
  const requireTrusted = event => { if (!trusted(event)) throw new Error('不可信桥接来源'); };
  workspaceBridge = createPetWorkspace({ ipcMain, isTrusted: trusted, getWindow: () => mainWindow,
    getToolWindow: petTools.getWindow, getToolRevision: petTools.getRevision,
    showPet: () => { if (!standaloneHost) throw new Error('桌宠尚未就绪'); return standaloneHost.showPetPanel({ section: 'features' }); } });
  registerManagementObservationBridge({ ipcMain, isTrusted: trusted, getHost: () => standaloneHost });
  registerManagementCompanionBridge({ ipcMain, isTrusted: trusted, getHost: () => standaloneHost });
  registerManagementVoiceBridge({ ipcMain, isTrusted: trusted, getHost: () => standaloneHost,
    openMicrophoneSettings: () => electron.shell.openExternal('ms-settings:privacy-microphone') });
  imageQuestionBridge = registerManagementImageQuestionBridge({ ipcMain, isTrusted: trusted,
    service: createImageQuestionService({ nativeImage: electron.nativeImage, provider: aiProvider, timeoutMs: 60000 }) });
  textQuestionBridge = registerManagementTextQuestionBridge({ ipcMain, isTrusted: trusted, provider: aiProvider });
  modelValidator = createLocalModelValidator({ BrowserWindow, ipcMain });
  modelBridge = registerLocalModelBridge({ ipcMain, dialog,
    store: createLocalModelStore({ databasePath: path.join(app.getPath('userData'), 'nuanban-local-model.sqlite') }),
    builtinModelsPath: path.join(path.dirname(managementIndex()), 'models'),
    activate: () => { if (!standaloneHost) throw new Error('独立桌宠尚未就绪，请重新打开客户端。'); return standaloneHost.showLocalModel(); },
    validate: modelValidator.validate, isManagementTrusted: trusted, getManagementWindow: () => mainWindow, getToolWindow: petTools.getWindow, getPetWindow: () => standaloneHost?.getPetWindow() });
  artworkBridge = registerLocalArtworkBridge({ ipcMain, onChange: () => modelBridge.deactivate(),
    store: createLocalArtworkStore({ filePath: path.join(app.getPath('userData'), 'nuanban-original-pet.png'), nativeImage: electron.nativeImage }),
    isManagementTrusted: trusted, getManagementWindow: () => mainWindow, getToolWindow: petTools.getWindow, getPetWindow: () => standaloneHost?.getPetWindow() });
  ipcMain.handle('nuanban:capabilities', event => {
    requireTrusted(event);
     return { ...createWindowsCapabilityPolicy({ safeStorage, Notification }), externalCapture:false, encryptedReminderPayload:Boolean(reminderStore?.encryptedReminderPayload), persistentReminderStore:Boolean(reminderStore) };
  });
  ipcMain.handle('nuanban:stop', event => {
    requireTrusted(event);
    imageQuestionBridge?.stop();
    textQuestionBridge?.stop();
    if (!standaloneHost) throw new Error('独立运行核心尚未就绪');
    return standaloneHost.stop('user');
  });
  ipcMain.handle('nuanban:reminders:schedule', (event, input) => { requireTrusted(event); if (!reminderStore) throw new Error('本地提醒仓储不可用'); return reminderStore.schedule(input); });
  ipcMain.handle('nuanban:reminders:read', (event, accountId, reminderId) => { requireTrusted(event); if (!reminderStore) throw new Error('本地提醒仓储不可用'); return reminderStore.read(accountId, reminderId); });
  ipcMain.handle('nuanban:reminders:list', (event, accountId) => { requireTrusted(event); if (!reminderStore) throw new Error('本地提醒仓储不可用'); return reminderStore.list(accountId); });
  ipcMain.handle('nuanban:reminders:cancel', (event, input) => { requireTrusted(event); if (!reminderStore) throw new Error('本地提醒仓储不可用'); return reminderStore.cancel(input); });
  ipcMain.handle('nuanban:reminders:submit-due', (event, input) => { requireTrusted(event); if (!reminderStore) throw new Error('本地提醒仓储不可用'); return reminderStore.submitDue(input); });
  ipcMain.handle('nuanban:reminders:receipt', (event, input) => { requireTrusted(event); if (!reminderStore) throw new Error('本地提醒仓储不可用'); return reminderStore.recordReceipt(input); });
  ipcMain.handle('nuanban:reminders:complete', (event, input) => { requireTrusted(event); if (!reminderStore) throw new Error('本地提醒仓储不可用'); return reminderStore.complete(input); });
  ipcMain.handle('nuanban:reminders:notify-due', (event, input) => { requireTrusted(event); if (!reminderNotifications) return { status:'unsupported', reason:'桌面通知适配器不可用' }; return reminderNotifications.notifyDue(input); });
}
async function createWindow() {
  const startPage = managementIndex();
  mainWindow = new BrowserWindow({ width:1360,height:920,minWidth:420,minHeight:640,title:'微光指引 · 管理中心',icon:PRODUCT_ICON_PATH,backgroundColor:'#FFF8EF',show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true} });
  managementVisibility.syncProtection(mainWindow);
  mainWindow.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', () => {
    textQuestionBridge?.stop();
    imageQuestionBridge?.stop();
    notifyLifecycle('nuanban:host-renderer-gone', mainWindow);
  });
  mainWindow.on('close', () => { imageQuestionBridge?.stop(); textQuestionBridge?.stop(); notifyLifecycle('nuanban:host-before-quit', mainWindow); });
  mainWindow.on('move', () => notifyLifecycle('nuanban:host-window-moved', mainWindow));
  mainWindow.on('closed', () => {
    mainWindow = undefined;
    quitIfNoVisibleWindows();
  });
  await mainWindow.loadFile(startPage);
}
app.on('before-quit', event => {
  textQuestionBridge?.stop();
  imageQuestionBridge?.stop();
  if (quitAfterLifecycle) return;
  event.preventDefault();
  if (shutdownPromise) return;
  notifyLifecycle('nuanban:host-before-quit');
  const lifecycle = createLifecycleController(reason => standaloneHost ? standaloneHost.dispose(reason) : Promise.resolve({ stopped: true, captureActive: false, mediaActive: false, reason }));
  shutdownPromise = lifecycle.requestStop('process-terminated').then(() => {
    quitAfterLifecycle = true;
    app.quit();
  }, () => {
    shutdownPromise = undefined;
    dialog.showErrorBox('采集或形象停止尚未确认', '已关闭发送，但尚未确认所有本地采集或星云形象会话退出。请再次退出桌宠，并检查星云后台会话；不会假报清理成功。');
  });
});
app.on('will-quit', () => {
  workspaceBridge?.dispose();
  textQuestionBridge?.dispose();
  modelValidator?.dispose();
  modelBridge?.dispose();
  imageQuestionBridge?.dispose();
  artworkBridge?.dispose();
  reminderNotifications?.dispose();
  reminderNotifications = undefined;
  reminderStore?.close();
  reminderStore = undefined;
});
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', (_event, argumentsList) => {
  if (argumentsList.includes('--pet-lili')) void standaloneHost?.selectLili(true);
  if (argumentsList.includes('--pet-default')) void standaloneHost?.selectLili(false);
  if (argumentsList.includes('--pet-display-compatible')) standaloneHost?.setPetDisplayCompatibility(true);
  if (argumentsList.includes('--management')) {
    if (argumentsList.includes('--client-display-compatible')) managementVisibility.enableCompatibility(mainWindow);
    void app.whenReady().then(() => showMainWindow('/')).catch(() => dialog.showErrorBox('管理窗口未打开', '请从桌宠重新打开管理窗口。'));
  }
  else standaloneHost?.showPetPanel();
});
if (ownsInstance) app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  session.defaultSession.webRequest.onHeadersReceived((details,callback)=>callback({responseHeaders:{...details.responseHeaders,'Content-Security-Policy':[details.webContentsId === standaloneHost?.getPetWindow()?.webContents.id ? PET_AVATAR_CSP : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src blob: data:; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'"]}}));
  try {
    reminderStore = createDesktopReminderStore({ databasePath: path.join(app.getPath('userData'), 'nuanban-reminders.sqlite'), payloadCodec: createSafeStoragePayloadCodec(safeStorage) });
    reminderNotifications = createDesktopReminderNotificationBridge({
      store: reminderStore,
      Notification,
      getPermission: () => 'unknown',
      sendOpen: event => {
        if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('nuanban:reminder-open', { deepLink: event.deepLink });
      },
    });
  } catch { reminderStore = undefined; reminderNotifications = undefined; }
  try { aiProvider = await loadConfiguredProvider({ fetch: (input, init) => electron.net.fetch(input, { ...init, credentials: 'omit' }) }); } catch { aiProvider = undefined; }
  registerBridge();
  standaloneHost = createStandaloneHost({ electron, userDataPath: app.getPath('userData'), showManagement: showMainWindow,
    liliEnabled: process.argv.includes('--pet-lili') || (!process.argv.includes('--pet-default') && process.env.NUANBAN_DESKTOP_PET === 'lili'),
    petDisplayCompatible: process.argv.includes('--pet-display-compatible'),
    showPetTool: route => petTools.show(route),
    onObservationState: observation => managementVisibility.updateObservation(observation, mainWindow),
    analyzer: aiProvider ? createProviderAnalysisClient({ provider: aiProvider }) : undefined,
    questioner: aiProvider,
    reminderStore, reminderNotifications, isQuitting: () => quitAfterLifecycle, hasManagementWindow: hasVisibleClientWindow, onExit: () => app.quit() });
  await Promise.all([standaloneHost.initialize(), process.argv.includes('--management') ? showMainWindow('/') : Promise.resolve()]);
}).catch(() => {
  dialog.showErrorBox('微光指引启动未完成', '独立桌宠加载失败，未自动开启屏幕或麦克风采集。请检查本地启动日志与依赖后重试。');
  app.quit();
});
app.on('window-all-closed',()=>app.quit());
