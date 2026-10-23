const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { _electron, expect } = require('@playwright/test');
const root = path.resolve(__dirname, '..');
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const cache = path.join(root, '.cache', `lumi-electron-${Date.now()}`);
const userData = path.join(cache, 'profile');
const hash = '4cee02df06e168eb99612ab5d807a3efe6025d14c7dfec516616ff8825b0e9b3';
mkdirSync(cache, { recursive: true });
const evidence = { nativePreview: false, nativeApply: false, switchedFromLili: false, defaultIdle: false, persistedAfterRestart: false, recalled: false, screenRequests: 0, errors: [] };

async function launch() {
  const environment = { ...process.env, NUANBAN_LUMI_TEST_USER_DATA: userData };
  delete environment.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ executablePath: desktopRequire('electron'),
    args: [path.join(root, 'tests/helpers/lumi-electron-smoke.cjs'), '--management', '--pet-display-compatible', '--client-display-compatible'],
    env: environment, timeout: 30000 });
  try {
    await expect.poll(() => application.windows().some(page => page.url().includes('/web/dist/index.html')), { timeout: 30000 }).toBe(true);
    const management = application.windows().find(page => page.url().includes('/web/dist/index.html'));
    management.on('pageerror', error => evidence.errors.push(error.message));
    await management.waitForLoadState('networkidle');
    await management.evaluate(() => {
      localStorage.setItem('nuanban.entry.v1', JSON.stringify({ mode: 'guest', at: new Date().toISOString() }));
      location.hash = '/pets/lumi';
    });
    await expect(management.getByRole('region', { name: '露米 Lumi' })).toBeVisible();
    await expect.poll(() => application.windows().some(page => page.url().endsWith('/pet.html')), { timeout: 20000 }).toBe(true);
    const pet = application.windows().find(page => page.url().endsWith('/pet.html'));
    pet.on('pageerror', error => evidence.errors.push(error.message));
    return { application, management, pet };
  } catch (error) {
    await application.close();
    throw error;
  }
}

async function run() {
  let context;
  try {
    context = await launch();
    const { application, management, pet } = context;
    const card = management.getByRole('region', { name: '露米 Lumi' });
    await card.getByRole('button', { name: '预览 3D 与动作' }).click();
    await expect(card.locator('canvas')).toHaveAttribute('data-animation', 'idle', { timeout: 20000 });
    await expect(card.locator('canvas')).toHaveAttribute('data-render-source', 'glb');
    await expect(card.locator('canvas')).toHaveAttribute('data-appearance-profile', 'lumi-original-detail-v2.1');
    await card.getByRole('button', { name: '陪伴', exact: true }).click();
    assert.deepEqual(await management.evaluate(() => window.nuanbanModel.read()), { kind: 'none' });
    evidence.nativePreview = true;
    await application.evaluate(async () => { await global.__lumiSmoke.host.selectLili(true); });
    await expect(pet.locator('#pet-window')).toHaveClass(/is-lili/);
    await card.getByRole('button', { name: '设为桌面小伙伴' }).click();
    await management.getByRole('button', { name: '确认保存并调用小猫' }).click();
    await expect(card.getByRole('status')).toContainText('小猫已保存并调用到桌面', { timeout: 30000 });
    await expect(pet.locator('#model-pet')).toHaveAttribute('data-model-id', hash, { timeout: 20000 });
    await expect(pet.locator('#model-pet canvas')).toHaveAttribute('data-animation', 'idle');
    await expect(pet.locator('#model-pet canvas')).toHaveAttribute('data-render-source', 'glb');
    await expect(pet.locator('#model-pet canvas')).toHaveAttribute('data-appearance-profile', 'lumi-original-detail-v2.1');
    await expect(pet.locator('#model-pet')).toBeVisible();
    await expect(pet.locator('#pet-window')).not.toHaveClass(/is-lili/);
    evidence.nativeApply = true; evidence.switchedFromLili = true; evidence.defaultIdle = true;
    await card.screenshot({ path: path.join(cache, 'lumi-native-card.png') });
    await management.screenshot({ path: path.join(cache, 'lumi-management.png'), fullPage: true });
    await pet.screenshot({ path: path.join(cache, 'lumi-desktop-pet.png') });
    await management.setViewportSize({ width: 1080, height: 1200 });
    await management.evaluate(() => {
      const surface = document.querySelector('.lumi-model-surface');
      if (!(surface instanceof HTMLElement)) throw new Error('原版小猫预览未就绪');
      document.body.replaceChildren(surface);
      document.documentElement.style.setProperty('background', 'transparent', 'important');
      document.body.style.cssText = 'margin:0;background:transparent!important;';
      surface.style.cssText = 'position:fixed;inset:0;width:1080px;height:1200px;background:transparent;';
    });
    await expect.poll(() => management.locator('.lumi-model-surface canvas').evaluate(canvas => canvas.width), { timeout: 10000 }).toBeGreaterThanOrEqual(1080);
    await management.locator('.lumi-model-surface canvas').screenshot({ path: path.join(cache, 'lumi-runtime-transparent.png'), omitBackground: true });
    evidence.screenRequests += await application.evaluate(() => global.__lumiSmoke.screenRequests);
    await application.close(); context = undefined;
    context = await launch();
    const secondCard = context.management.getByRole('region', { name: '露米 Lumi' });
    await expect(secondCard.getByRole('button', { name: '再次召唤桌宠' })).toBeVisible();
    await expect(context.pet.locator('#model-pet canvas')).toHaveAttribute('data-animation', 'idle', { timeout: 20000 });
    const persisted = await context.management.evaluate(async () => { const model = await window.nuanbanModel.read(); return model.kind === 'model' ? { id: model.id, byteLength: model.bytes.byteLength } : model; });
    assert.deepEqual(persisted, { id: hash, byteLength: 10887504 });
    evidence.persistedAfterRestart = true;
    await secondCard.getByRole('button', { name: '再次召唤桌宠' }).click();
    await expect(secondCard.getByRole('status')).toContainText('小猫已保存并调用到桌面', { timeout: 30000 });
    evidence.recalled = true;
    evidence.screenRequests += await context.application.evaluate(() => global.__lumiSmoke.screenRequests);
    assert.equal(evidence.screenRequests, 0);
    assert.deepEqual(evidence.errors, []);
  } finally {
    if (context) await context.application.close();
    writeFileSync(path.join(cache, 'results.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ cache, ...evidence }, null, 2));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
