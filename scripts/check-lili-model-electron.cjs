const assert = require('node:assert/strict');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { _electron, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const naturalV4 = process.argv.includes('--natural-v4');
const modelId = naturalV4 ? 'lili-natural-v4' : 'lili';
const manifest = JSON.parse(readFileSync(path.join(root, 'apps/web/public/models', modelId, 'character_manifest.json'), 'utf8'));
const cache = path.join(root, '.cache', `${modelId}-model-electron-${Date.now()}`);
const userData = path.join(cache, 'profile');
const hash = manifest.sha256;
const appliedNotice = `${naturalV4 ? '自然精修 v4 候选版' : '原版小鹿'} 3D 模型已保存并调用到桌面`;
const evidence = { modelId, nativePreview: false, nativeApply: false, switchedFromLegacy: false, staticModel: false, nativeActions: false, persistedAfterRestart: false, recalled: false, restoredOriginal: false, screenRequests: 0, errors: [] };
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
    if (naturalV4) await card.getByRole('combobox', { name: '模型版本' }).selectOption('natural-v4');
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
  await expect(model).toHaveAttribute('data-render-source', 'glb');
  await expect(model.locator('canvas')).toBeVisible();
  await expect(model.locator('canvas')).toHaveAttribute('data-render-source', 'glb');
  if (naturalV4) await expect(model.locator('canvas')).toHaveAttribute('data-appearance-profile', 'lili-natural-v4');
  assert.equal(await model.locator('canvas').getAttribute('data-animation'), naturalV4 ? 'idle' : null);
  await expect(pet.locator('#pet-window')).not.toHaveClass(/is-lili/);
}

async function run() {
  let context;
  try {
    context = await launch();
    const { application, management, card, pet } = context;
    assert.deepEqual(await management.evaluate(() => window.nuanbanModel.read()), { kind: 'none' });
    await card.getByRole('button', { name: '预览小鹿 3D 模型' }).click();
    await expect(card.locator('canvas')).toHaveAttribute('data-render-source', 'glb', { timeout: 20000 });
    await expect(card.locator('.lili-model-poster')).toHaveCount(0);
    assert.equal(await card.locator('canvas').getAttribute('data-animation'), naturalV4 ? 'idle' : null);
    if (naturalV4) {
      await card.getByRole('button', { name: '轻轻招手', exact: true }).click();
      await expect(card.locator('canvas')).toHaveAttribute('data-animation', 'wave');
      await expect(card.locator('canvas')).toHaveAttribute('data-animation', 'idle');
    }
    assert.deepEqual(await management.evaluate(() => window.nuanbanModel.read()), { kind: 'none' });
    evidence.nativePreview = true;
    await application.evaluate(async () => { await global.__liliSmoke.host.selectLili(true); });
    await expect(pet.locator('#pet-window')).toHaveClass(/is-lili/);
    await card.getByRole('button', { name: '请栗栗到桌面' }).click();
    await management.getByRole('button', { name: '确认切换并显示栗栗' }).click();
    await expect(card.getByRole('status')).toContainText(appliedNotice, { timeout: 30000 });
    await expectDesktopModel(pet);
    evidence.nativeApply = true;
    const summary = await management.evaluate(async () => {
      const model = await window.nuanbanModel.read();
      return model.kind === 'model' ? model.summary : undefined;
    });
    assert.equal(summary.triangles, manifest.triangles);
    assert.equal(summary.meshes, manifest.decodedMeshes);
    assert.equal(summary.bones, manifest.bones);
    assert.equal(summary.animations, manifest.animations);
    assert.ok(summary.textures.length >= 6);
    evidence.switchedFromLegacy = true;
    evidence.staticModel = summary.animations === 0;
    if (naturalV4) {
      for (const action of ['look', 'wave', 'nod', 'blink']) {
        await pet.evaluate(action => window.dispatchEvent(new CustomEvent('nuanban:model-action', { detail: { action } })), action);
        await expect(pet.locator('#model-pet canvas')).toHaveAttribute('data-animation', action);
      }
      await expect(pet.locator('#model-pet canvas')).toHaveAttribute('data-animation', 'idle');
      await pet.evaluate(() => window.dispatchEvent(new CustomEvent('nuanban:model-action', { detail: { action: 'not-an-action' } })));
      await expect(pet.locator('#model-pet canvas')).toHaveAttribute('data-animation', 'idle');
      await pet.evaluate(() => window.dispatchEvent(new CustomEvent('nuanban:avatar-interaction')));
      await expect(pet.locator('#model-pet canvas')).toHaveAttribute('data-animation', 'wave');
      await expect(pet.locator('#model-pet canvas')).toHaveAttribute('data-animation', 'idle');
      evidence.nativeActions = true;
    }
    await card.screenshot({ path: path.join(cache, 'lili-native-model.png') });
    await pet.evaluate(() => window.nuanbanPet.expand());
    await expect(pet.locator('#pet-window')).not.toHaveClass(/is-ball/);
    await expect(pet.locator('#model-pet canvas')).toBeVisible();
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
    assert.deepEqual(persisted, { id: hash, byteLength: manifest.bytes });
    evidence.persistedAfterRestart = true;
    await context.card.getByRole('button', { name: '再次召唤栗栗' }).click();
    await context.management.getByRole('button', { name: '确认切换并显示栗栗' }).click();
    await expect(context.card.getByRole('status')).toContainText(appliedNotice, { timeout: 30000 });
    await expectDesktopModel(context.pet);
    evidence.recalled = true;
    if (naturalV4) {
      await context.card.getByRole('combobox', { name: '模型版本' }).selectOption('original');
      await context.card.getByRole('button', { name: '请栗栗到桌面' }).click();
      await context.management.getByRole('button', { name: '确认切换并显示栗栗' }).click();
      await expect(context.card.getByRole('status')).toContainText('原版小鹿 3D 模型已保存并调用到桌面', { timeout: 30000 });
      const original = JSON.parse(readFileSync(path.join(root, 'apps/web/public/models/lili/character_manifest.json'), 'utf8'));
      await expect(context.pet.locator('#model-pet')).toHaveAttribute('data-model-id', original.sha256, { timeout: 30000 });
      await expect(context.pet.locator('#model-pet canvas')).toBeVisible();
      evidence.restoredOriginal = true;
    }
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
