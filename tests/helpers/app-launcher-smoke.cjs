// “智能打开软件”的 Electron 冒烟主进程：真实 ipcMain + 真实 preload + 真实页面，
// 但启动器与模型都是合成实现 —— 不打开任何真实软件、不联网。
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createAppLauncherRegistry } = require('../../apps/desktop/app-launcher-registry.cjs');
const { createAppLauncherIntent } = require('../../apps/desktop/app-launcher-intent.cjs');
const { createAppLauncherHistory } = require('../../apps/desktop/app-launcher-history.cjs');
const { createAppInventory } = require('../../apps/desktop/app-inventory.cjs');
const { registerAppLauncherBridge } = require('../../apps/desktop/app-launcher-bridge.cjs');

const userData = process.env.NUANBAN_APP_LAUNCHER_TEST_USER_DATA;
if (!userData) { console.error('缺少隔离 userData'); app.exit(2); }
app.setPath('userData', userData);
app.disableHardwareAcceleration();

const desktop = path.join(__dirname, '..', '..', 'apps', 'desktop');
const calls = [];
const openedShortcuts = [];
let screenRequests = 0;
global.__appLauncherSmoke = {
  get calls() { return calls.map(call => ({ ...call })); },
  get openedShortcuts() { return openedShortcuts.map(entry => ({ ...entry })); },
  get screenRequests() { return screenRequests; },
};

const fakeProvider = {
  status: () => ({ available: true }),
  answer: async ({ question }) => {
    if (!question.includes('浏览器')) {
      return { text: JSON.stringify({ action: 'open_app', appId: 'calculator', appName: '计算器', target: 'default',
        targetDescription: '计算器主界面', parameters: {}, confidence: 0.95, needsConfirmation: true, reason: '合成模型：打开计算器' }) };
    }
    return { text: JSON.stringify({ action: 'open_app', appId: 'browser', appName: '浏览器', target: 'url',
      targetDescription: '指定网页', parameters: { url: 'https://www.example.com/' }, confidence: 0.95, needsConfirmation: true, reason: '合成模型：打开网页' }) };
  },
};

const fakeLauncher = {
  resolveExecutable: (appId, candidates) => candidates[0],
  launch: async spec => {
    calls.push({ appId: spec.appId, target: spec.target, kind: spec.kind, executable: spec.executable,
      args: Array.isArray(spec.args) ? [...spec.args] : [], url: spec.url });
    if (typeof spec.shortcut === 'string') openedShortcuts.push({ appId: spec.appId, shortcut: spec.shortcut });
    return { success: true, appId: spec.appId, target: spec.target,
      message: `已打开${spec.displayName}，仅确认已发送启动请求，无法确认软件内部页面已加载。`, errorCode: null };
  },
};

let bridge;
let petWindow;
let strangerWindow;

app.whenReady().then(async () => {
  // 任何屏幕共享 / 麦克风 / 摄像头请求都会被计数并拒绝：本功能不得触发采集。
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    if (permission === 'media' || permission === 'display-capture') screenRequests += 1;
    callback(false);
  });
  const startMenuRoot = path.join(userData, 'smoke-start-menu');
  fs.mkdirSync(startMenuRoot, { recursive: true });
  fs.writeFileSync(path.join(startMenuRoot, 'Apifox.lnk'), '');
  fs.writeFileSync(path.join(startMenuRoot, 'Blender.lnk'), '');
  fs.writeFileSync(path.join(startMenuRoot, '卸载工具.lnk'), '');
  const inventory = createAppInventory({ roots: [startMenuRoot] });
  const registry = createAppLauncherRegistry({ inventory });
  const history = createAppLauncherHistory({ filePath: path.join(userData, 'app-launcher-history.json') });
  petWindow = new BrowserWindow({ width: 900, height: 760, show: true,
    webPreferences: { preload: path.join(desktop, 'pet-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  bridge = registerAppLauncherBridge({
    ipcMain,
    isTrusted: event => Boolean(petWindow) && !petWindow.isDestroyed() && event.sender === petWindow.webContents,
    registry,
    inventory,
    launcher: fakeLauncher,
    intent: createAppLauncherIntent({ provider: fakeProvider, registry }),
    history,
    pickFolder: async () => path.join(userData, 'Documents'),
    showPage: () => { petWindow.webContents.send('nuanban:pet:section', { section: 'openApp' }); },
  });
  await petWindow.loadFile(path.join(desktop, 'pet.html'));
  strangerWindow = new BrowserWindow({ width: 400, height: 300, show: false,
    webPreferences: { preload: path.join(desktop, 'pet-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  await strangerWindow.loadFile(path.join(desktop, 'pet.html'));
  global.__appLauncherSmoke.ready = true;
  const marker = path.join(userData, 'smoke-ready');
  fs.writeFileSync(marker, 'ready');
}).catch(error => { console.error('冒烟主进程失败：', error?.message ?? error); app.exit(1); });

app.on('window-all-closed', () => { bridge?.dispose(); app.quit(); });
module.exports = { fakeLauncher, fakeProvider };