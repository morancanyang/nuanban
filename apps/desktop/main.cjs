const electron = require('electron');
const { app, BrowserWindow, ipcMain, safeStorage, session, Notification, dialog } = electron;
const { spawn } = require('node:child_process');
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
const { createPrivacySettings } = require('./privacy-settings.cjs');
const { loadConfiguredCloudDictation } = require('./voice/cloud-dictation.cjs');
const { createCloudRecorder } = require('./voice/cloud-recorder.cjs');
const { createCloudDictationSettings } = require('./voice/cloud-dictation-settings.cjs');
const { createProviderAnalysisClient } = require('./provider-analysis.cjs');
const { registerManagementTextQuestionBridge } = require('./text-question.cjs');
const { createLocalArtworkStore, registerLocalArtworkBridge } = require('./local-artwork.cjs');
const { createLocalModelStore, registerLocalModelBridge } = require('./local-model.cjs');
const { createLocalModelValidator } = require('./model-validator.cjs');
const { createDesktopReminderStore, createSafeStoragePayloadCodec } = require('./reminder-store.cjs');
const { createDesktopReminderNotificationBridge } = require('./reminder-notification-bridge.cjs');
const { createWindowsCapabilityPolicy } = require('./native-runtime.cjs');
const { PET_AVATAR_CSP } = require('./xingyun-avatar.cjs');
const { createXingyunConversationPermissionGuard } = require('./xingyun-permission-guard.cjs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const { PRODUCT_ICON_PATH } = require('./brand.cjs');
const { createAnySearchKeyStore } = require('./anysearch-settings.cjs');
const { createCaptureVisibility } = require('./capture-visibility.cjs');
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
const captureVisibility = createCaptureVisibility(process.argv);
// 默认会话保持默认拒绝：唯一的例外是“本人已开启对话”的桌宠窗口的音频采集，由该闸门按会话代次放行。
const xingyunPermissions = createXingyunConversationPermissionGuard();
const managementVisibility = createManagementWindowVisibility({ displayCompatible: captureVisibility.clientVisible });
const petTools = createPetToolWindow({ BrowserWindow, getIndexPath: managementIndex, preloadPath: path.join(__dirname, 'preload.cjs'),
  onLifecycle: (name, window) => {
    if (name !== 'nuanban:host-window-moved') { imageQuestionBridge?.stop(); textQuestionBridge?.stop(); }
    notifyLifecycle(name, window);
  }, onClosed: quitIfNoVisibleWindows });
const PROVIDER_DEFAULTS = Object.freeze({ baseUrl: 'https://api.openai-next.com/v1', model: 'gpt-6.1-sol' });
function providerConfigurationPath() { return path.join(process.env.LOCALAPPDATA ?? '', 'Nuanban', 'ai-provider.json'); }
function providerConfigurationStamp() { try { return fs.statSync(providerConfigurationPath()).mtimeMs; } catch { return 0; } }
// One-click cloud setup: open the existing hidden-input script in its own console, then offer a restart
// so the freshly saved DPAPI credential is loaded. Nothing is saved or enabled unless the owner types it.
async function configureAiProvider() {
  const script = path.join(__dirname, '..', '..', 'scripts', 'configure-ai-provider.ps1');
  if (!fs.existsSync(script)) {
    await dialog.showMessageBox({ type: 'warning', title: '无法打开配置窗口', message: '当前运行方式没有包含配置脚本。',
      detail: '请从仓库源码目录启动微光指引，或手动运行 scripts/configure-ai-provider.ps1。未保存任何密钥。', buttons: ['知道了'] });
    return { configured: false };
  }
  await dialog.showMessageBox({ type: 'info', title: '配置云端智能服务', message: '接下来会打开一个输入窗口。',
    detail: `网关默认 ${PROVIDER_DEFAULTS.baseUrl}，模型默认 ${PROVIDER_DEFAULTS.model}；在“API key (hidden)”提示后粘贴你自己的密钥（不会显示）。密钥由 Windows DPAPI 加密保存到仓库外，不会写入项目。`,
    buttons: ['继续'] });
  const stamp = providerConfigurationStamp();
  try {
    spawn('cmd.exe', ['/c', 'start', '""', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-BaseUrl', PROVIDER_DEFAULTS.baseUrl, '-Model', PROVIDER_DEFAULTS.model], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  } catch {
    await dialog.showMessageBox({ type: 'warning', title: '无法打开配置窗口', message: '输入窗口没有启动。', detail: '请手动运行 scripts/configure-ai-provider.ps1。', buttons: ['知道了'] });
    return { configured: false };
  }
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (providerConfigurationStamp() > stamp) {
      const answer = await dialog.showMessageBox({ type: 'question', title: '智能服务配置已保存', message: '现在重启微光指引以启用吗？',
        detail: '重启不会自动开启屏幕观察或麦克风；语音与问答仍需本人每次确认。', buttons: ['立即重启', '稍后'], defaultId: 0, cancelId: 1, noLink: true });
      if (answer.response === 0) { app.relaunch(); app.exit(0); }
      return { configured: true };
    }
  }
  await dialog.showMessageBox({ type: 'warning', title: '未检测到保存', message: '没有检测到新的智能服务配置。',
    detail: '可能取消了输入。可以再从桌宠菜单打开一次；没有保存就不会启用任何模型，也不会用模拟回答代替。', buttons: ['知道了'] });
  return { configured: false };
}
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
  if (argumentsList.includes('--protect-pet')) standaloneHost?.setPetDisplayCompatibility(false);
  if (argumentsList.includes('--management')) {
    if (argumentsList.includes('--client-display-compatible')) managementVisibility.setCompatibility(mainWindow, true);
    if (argumentsList.includes('--protect-client')) managementVisibility.setCompatibility(mainWindow, false);
    void app.whenReady().then(() => showMainWindow('/')).catch(() => dialog.showErrorBox('管理窗口未打开', '请从桌宠重新打开管理窗口。'));
  }
  else standaloneHost?.showPetPanel();
});
if (ownsInstance) app.whenReady().then(async () => {
  xingyunPermissions.install(session.defaultSession);
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
  const desktopFetch = (input, init) => electron.net.fetch(input, { ...init, credentials: 'omit' });
  let cloudDictation;
  let cloudRecorder;
  let cloudSettings;
  try { aiProvider = await loadConfiguredProvider({ fetch: desktopFetch }); } catch { aiProvider = undefined; }
  // Owner-approved cloud dictation: same encrypted credential file, separate client. Missing gateway or
  // missing recorder simply keeps the local-only path; nothing uploads unless the owner turned it on.
  try { cloudDictation = await loadConfiguredCloudDictation({ fetch: desktopFetch }); } catch { cloudDictation = undefined; }
  try {
    cloudSettings = createCloudDictationSettings({ userDataPath: app.getPath('userData') });
    cloudRecorder = createCloudRecorder({ scriptPath: path.join(__dirname, 'voice', 'windows-cloud-dictation.ps1'), tempDir: app.getPath('temp') });
  } catch { cloudSettings = undefined; cloudRecorder = undefined; }
  // Owner-controlled local masking switch (default keeps masking on).
  let privacySettings;
  try { privacySettings = createPrivacySettings({ userDataPath: app.getPath('userData') }); } catch { privacySettings = undefined; }
  registerBridge();
  standaloneHost = createStandaloneHost({ electron, userDataPath: app.getPath('userData'), showManagement: showMainWindow, xingyunPermissions,
    ...(cloudDictation ? { cloudDictation } : {}), ...(cloudRecorder ? { cloudRecorder } : {}), ...(cloudSettings ? { cloudSettings } : {}),
    ...(privacySettings ? { privacySettings } : {}),
    liliEnabled: process.argv.includes('--pet-lili') || (!process.argv.includes('--pet-default') && process.env.NUANBAN_DESKTOP_PET === 'lili'),
    petDisplayCompatible: captureVisibility.petVisible || process.argv.includes('--pet-display-compatible'),
    showPetTool: route => petTools.show(route),
    onObservationState: observation => managementVisibility.updateObservation(observation, mainWindow),
    analyzer: aiProvider ? createProviderAnalysisClient({ provider: aiProvider,
      relaxedSafety: () => privacySettings?.read?.().relaxedSafety === true }) : undefined,
    questioner: aiProvider,
    configureAiProvider,
    anysearchKeyStore: createAnySearchKeyStore({ userDataPath: app.getPath('userData'), safeStorage }),
    reminderStore, reminderNotifications, isQuitting: () => quitAfterLifecycle, hasManagementWindow: hasVisibleClientWindow, onExit: () => app.quit() });
  await Promise.all([standaloneHost.initialize(), process.argv.includes('--management') ? showMainWindow('/') : Promise.resolve()]);
}).catch(() => {
  dialog.showErrorBox('微光指引启动未完成', '独立桌宠加载失败，未自动开启屏幕或麦克风采集。请检查本地启动日志与依赖后重试。');
  app.quit();
});
app.on('window-all-closed',()=>app.quit());
