const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { _electron, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const cache = path.join(root, '.cache', `lili-model-electron-${Date.now()}`);
const userData = path.join(cache, 'profile');
const hash = '35c40f0c66b08fab749f7b711e97dc12dfd911003f375b9a77445c16928d7327';
const evidence = { nativePreview: false, nativeApply: false, switchedFromLegacy: false, staticModel: false, persistedAfterRestart: false, recalled: false, screenRequests: 0, errors: [] };
mkdirSync(cache, { recursive: true });

async function launch() {
  const environment = { ...process.env, NUANBAN_LILI_TEST_USER_DATA: userData };
  delete environment.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({
    executablePath: desktopRequire('electron'),
    args: [path.join(root, 'tests/helpers/lili-electron-smoke.cjs'), '--management', '--pet-display-compatible', '--client-display-compatible'],
    env: environment,
    timeout: 30000,
  });
  try {
    await expect.poll(() => application.windows().some(page => page.url().includes('/web/dist/index.html')), { timeout: 30000 }).toBe(true);
    const management = application.windows().find(page => page.url().includes('/web/dist/index.html'));
    management.on('pageerror', error => evidence.errors.push(error.message));
    await management.waitForLoadState('networkidle');
    await management.evaluate(() => {
      localStorage.setItem('nuanban.entry.v1', JSON.stringify({ mode: 'guest', at: new Date().toISOString() }));
      location.hash = '/pets/lili';
    });
    const card = management.getByRole('region', { name: '栗栗 Lili' });
    await expect(card).toBeVisible();
    await expect.poll(() => application.windows().some(page => page.url().endsWith('/pet.html')), { timeout: 20000 }).toBe(true);
    const pet = application.windows().find(page => page.url().endsWith('/pet.html'));
    pet.on('pageerror', error => evidence.errors.push(error.message));
    return { application, management, card, pet };
  } catch (error) {
    await application.close();
    throw error;
  }
}

async function expectDesktopModel(pet) {
  const model = pet.locator('#model-pet');
  await expect(model).toHaveAttribute('data-model-id', hash, { timeout: 30000 });
  await expect(model).toHaveAttribute('data-render-source', 'procedural-lili');
  await expect(model.locator('canvas')).toBeVisible();
  await expect(model.locator('canvas')).toHaveAttribute('data-render-source', 'procedural-lili');
  assert.equal(await model.locator('canvas').getAttribute('data-animation'), null);
  await expect(pet.locator('#pet-window')).not.toHaveClass(/is-lili/);
}

async function run() {
  let context;
  try {
    context = await launch();
    const { application, management, card, pet } = context;
    assert.deepEqual(await management.evaluate(() => window.nuanbanModel.read()), { kind: 'none' });
    await card.getByRole('button', { name: '预览小鹿 3D 模型' }).click();
    await expect(card.locator('canvas')).toHaveAttribute('data-render-source', 'procedural-lili', { timeout: 20000 });
    assert.equal(await card.locator('canvas').getAttribute('data-animation'), null);
    assert.deepEqual(await management.evaluate(() => window.nuanbanModel.read()), { kind: 'none' });
    evidence.nativePreview = true;
    await application.evaluate(async () => { await global.__liliSmoke.host.selectLili(true); });
    await expect(pet.locator('#pet-window')).toHaveClass(/is-lili/);
    await card.getByRole('button', { name: '请栗栗到桌面' }).click();
    await management.getByRole('button', { name: '确认切换并显示栗栗' }).click();
    await expect(card.getByRole('status')).toContainText('客户端建模小鹿已保存并调用到桌面', { timeout: 30000 });
    await expectDesktopModel(pet);
    evidence.nativeApply = true;
    evidence.switchedFromLegacy = true;
    evidence.staticModel = true;
    await card.screenshot({ path: path.join(cache, 'lili-native-model.png') });
    await pet.screenshot({ path: path.join(cache, 'lili-desktop-pet.png') });
    evidence.screenRequests += await application.evaluate(() => global.__liliSmoke.screenRequests);
    await application.close();
    context = undefined;

    context = await launch();
    await expect(context.card.getByRole('button', { name: '再次召唤栗栗' })).toBeVisible();
    await expectDesktopModel(context.pet);
    const persisted = await context.management.evaluate(async () => {
      const model = await window.nuanbanModel.read();
      return model.kind === 'model' ? { id: model.id, byteLength: model.bytes.byteLength } : model;
    });
    assert.deepEqual(persisted, { id: hash, byteLength: 1601548 });
    evidence.persistedAfterRestart = true;
    await context.card.getByRole('button', { name: '再次召唤栗栗' }).click();
    await context.management.getByRole('button', { name: '确认切换并显示栗栗' }).click();
    await expect(context.card.getByRole('status')).toContainText('客户端建模小鹿已保存并调用到桌面', { timeout: 30000 });
    await expectDesktopModel(context.pet);
    evidence.recalled = true;
    evidence.screenRequests += await context.application.evaluate(() => global.__liliSmoke.screenRequests);
    assert.equal(evidence.screenRequests, 0);
    assert.deepEqual(evidence.errors, []);
  } finally {
    if (context) await context.application.close();
    writeFileSync(path.join(cache, 'results.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ cache, ...evidence }, null, 2));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
