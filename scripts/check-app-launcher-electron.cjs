const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { _electron, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const cache = path.join(root, '.cache', `app-launcher-electron-${Date.now()}`);
const userData = path.join(cache, 'profile');
mkdirSync(cache, { recursive: true });
const evidence = { cardOpened: false, planConfirmed: false, executed: false, autoExecute: false, inventoryList: false,
  untrustedRejected: false, noNodeInRenderer: false, noCapture: false, confirmText: '', resultText: '', shortcutOpened: '',
  calls: [], screenRequests: 0, errors: [] };

async function launch() {
  const environment = { ...process.env, NUANBAN_APP_LAUNCHER_TEST_USER_DATA: userData };
  delete environment.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ executablePath: desktopRequire('electron'),
    args: [path.join(root, 'tests/helpers/app-launcher-smoke.cjs')], env: environment, timeout: 30000 });
  try {
    await expect.poll(() => application.windows().some(page => page.url().endsWith('/pet.html')), { timeout: 30000 }).toBe(true);
    const pet = application.windows().find(page => page.url().endsWith('/pet.html'));
    pet.on('pageerror', error => evidence.errors.push(error.message));
    await pet.waitForLoadState('domcontentloaded');
    return { application, pet };
  } catch (error) {
    await application.close();
    throw error;
  }
}

async function run() {
  let context;
  try {
    context = await launch();
    const { application, pet } = context;

    // 1. 功能小屋卡片与新页面（面板默认收起，先展开）
    await pet.locator('#pet-toggle').click();
    await expect(pet.locator('#feature-open-app')).toBeVisible();
    await pet.locator('#feature-open-app').click();
    await expect(pet.locator('#open-app-view')).toBeVisible();
    evidence.cardOpened = true;

    // 2. 渲染进程没有 Node 能力
    const nodeSurface = await pet.evaluate(() => ({ require: typeof window.require, process: typeof window.process,
      bridge: typeof window.nuanbanOpenApp, methods: window.nuanbanOpenApp ? Object.keys(window.nuanbanOpenApp).sort() : [] }));
    assert.equal(nodeSurface.require, 'undefined');
    assert.equal(nodeSurface.process, 'undefined');
    assert.equal(nodeSurface.bridge, 'object');
    assert.deepEqual(nodeSurface.methods, ['cancel', 'execute', 'history', 'inventory', 'parse', 'pick', 'pickFolder', 'setAutoExecute', 'status']);
    evidence.noNodeInRenderer = true;

    // 3. 默认确认模式：解析 → 显示确认卡片 → 本人确认后才执行（假启动器不打开真实软件）
    await pet.locator('#open-app-query').fill('打开计算器');
    await pet.locator('#open-app-consent').check();
    await pet.locator('#open-app-submit').click();
    await expect(pet.locator('#open-app-confirm-text')).toContainText('即将打开：计算器', { timeout: 15000 });
    await expect(pet.locator('#open-app-confirm-text')).toContainText('目标界面：主界面');
    await expect(pet.locator('#open-app-confirm-text')).toContainText('是否继续？');
    evidence.confirmText = (await pet.locator('#open-app-confirm-text').innerText()).replace(/\s+/gu, ' ').trim();
    let calls = await application.evaluate(() => global.__appLauncherSmoke.calls);
    assert.equal(calls.length, 0, '确认前不得执行');
    await pet.locator('#open-app-confirm-ok').click();
    await expect(pet.locator('#open-app-result')).toContainText('仅确认已发送启动请求', { timeout: 15000 });
    calls = await application.evaluate(() => global.__appLauncherSmoke.calls);
    assert.deepEqual(calls.map(call => [call.appId, call.target, call.kind]), [['calculator', 'default', 'exe']]);
    assert.deepEqual(calls[0].args, []);
    evidence.planConfirmed = true; evidence.executed = true;
    evidence.resultText = (await pet.locator('#open-app-result').innerText()).replace(/\s+/gu, ' ').trim();

    // 4. 开启自动执行后，已确认过的低风险目标免确认
    await pet.locator('#open-app-auto').check();
    await expect(pet.locator('#open-app-auto-status')).toContainText('自动执行');
    await pet.locator('#open-app-query').fill('打开计算器');
    await pet.locator('#open-app-consent').check();
    await pet.locator('#open-app-submit').click();
    await expect(pet.locator('#open-app-result')).toContainText('仅确认已发送启动请求', { timeout: 15000 });
    calls = await application.evaluate(() => global.__appLauncherSmoke.calls);
    assert.equal(calls.length, 2, '自动执行应直接发出第二次启动请求');
    evidence.autoExecute = true;

    // 5. 从本机清单直接选择（不调用模型，仍要确认）
    await expect(pet.locator('#open-app-inventory-count')).toContainText('2');
    await pet.locator('#open-app-list-toggle').click();
    await expect(pet.locator('#open-app-list')).toBeVisible();
    await pet.locator('#open-app-list button.open-app-item').filter({ hasText: 'Apifox' }).first().click();
    await expect(pet.locator('#open-app-confirm-text')).toContainText('即将打开：Apifox', { timeout: 15000 });
    await pet.locator('#open-app-confirm-ok').click();
    await expect(pet.locator('#open-app-result')).toContainText('仅确认已发送启动请求', { timeout: 15000 });
    const shortcuts = await application.evaluate(() => global.__appLauncherSmoke.openedShortcuts);
    assert.equal(shortcuts.length, 1, '清单项应通过快捷方式打开一次');
    assert.match(String(shortcuts[0].shortcut), /Apifox\.lnk$/u);
    evidence.inventoryList = true;
    evidence.shortcutOpened = shortcuts[0].shortcut.replace(/\\/gu, '/').split('/').pop();

    // 6. 非受信任窗口调用同一通道被拒绝
    const stranger = application.windows().filter(page => page.url().endsWith('/pet.html'))[1];
    if (stranger) {
      const rejected = await stranger.evaluate(async () => {
        try { await window.nuanbanOpenApp.status(); return 'allowed'; } catch (error) { return String(error?.message ?? error); }
      });
      assert.notEqual(rejected, 'allowed');
      assert.match(rejected, /不可信打开来源|Error/u);
      evidence.untrustedRejected = true;
    }

    evidence.screenRequests = await application.evaluate(() => global.__appLauncherSmoke.screenRequests);
    assert.equal(evidence.screenRequests, 0, '本功能不得请求屏幕或麦克风');
    evidence.noCapture = true;
    evidence.calls = calls;
    assert.deepEqual(evidence.errors, []);
    await pet.screenshot({ path: path.join(cache, 'open-app-view.png') });
    await application.close();
    context = undefined;
  } finally {
    if (context) await context.application.close();
    writeFileSync(path.join(cache, 'results.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ cache, ...evidence }, null, 2));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });