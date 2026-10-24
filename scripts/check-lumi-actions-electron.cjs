const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { _electron, expect } = require('@playwright/test');
const { actions, modelHash } = require('../apps/desktop/lumi-actions.cjs');

const root = path.resolve(__dirname, '..');
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'));
const cache = path.join(root, '.cache', `lumi-actions-electron-${Date.now()}`);
const evidence = { nativeApply: false, actions: [], semantic: false, stop: false, hiddenRejected: false, collapsedRejected: false, restart: false, screenRequests: 0, errors: [] };
mkdirSync(cache, { recursive: true });

async function launch() {
  const environment = { ...process.env, NUANBAN_LUMI_TEST_USER_DATA: path.join(cache, 'profile') };
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
    const card = management.getByRole('region', { name: '露米 Lumi' });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: '自然动作版', exact: true }).click();
    await expect.poll(() => application.windows().some(page => page.url().endsWith('/pet.html')), { timeout: 20000 }).toBe(true);
    const pet = application.windows().find(page => page.url().endsWith('/pet.html'));
    pet.on('pageerror', error => evidence.errors.push(error.message));
    return { application, management, card, pet };
  } catch (error) { await application.close(); throw error; }
}

async function showCompanion({ application, pet }) {
  await application.evaluate(() => {
    const window = global.__lumiSmoke.host.getPetWindow();
    window.show();
    window.focus();
  });
  await pet.evaluate(() => window.nuanbanPet.expand());
  await expect(pet.locator('#model-pet canvas')).toBeVisible();
}

async function run() {
  let context;
  try {
    context = await launch();
    const { application, management, pet, card } = context;
    const descriptor = await management.evaluate(() => window.nuanbanLumi.describe());
    assert.equal(descriptor.id, 'lumi-animated-v4');
    assert.deepEqual(descriptor.actions, actions);
    const beforeApply = await management.evaluate(() => window.nuanbanLumi.play('Wave_Gentle'));
    assert.equal(beforeApply.ok, false);
    await card.getByRole('button', { name: '设为桌面小伙伴' }).click();
    await management.getByRole('button', { name: '确认保存并调用小猫' }).click();
    await expect(card.getByRole('status')).toContainText('自然动作版小猫已保存并调用到桌面', { timeout: 30000 });
    const canvas = pet.locator('#model-pet canvas');
    await expect(pet.locator('#model-pet')).toHaveAttribute('data-model-id', modelHash, { timeout: 20000 });
    await expect(canvas).toHaveAttribute('data-appearance-profile', 'lumi-natural-v4-animated');
    await expect(canvas).toHaveAttribute('data-animation', 'Idle_Breathe');
    await showCompanion(context);
    evidence.nativeApply = true;
    await management.evaluate(() => {
      window.__lumiActionEvents = [];
      window.__lumiActionUnsubscribe = window.nuanbanLumi.onAction(event => window.__lumiActionEvents.push(event));
    });
    for (const action of actions.filter(item => item.name !== 'Blink_Soft')) {
      const result = await management.evaluate(name => window.nuanbanLumi.play(name), action.name);
      assert.deepEqual(result, { ok: true, action: action.name, durationMs: action.durationMs, loop: action.loop });
      await expect(canvas).toHaveAttribute('data-animation', action.name);
      evidence.actions.push(action.name);
    }
    const blink = await management.evaluate(() => window.nuanbanLumi.semantic('blink'));
    assert.deepEqual(blink, { ok: true, action: 'Blink_Soft', durationMs: 300, loop: false });
    await expect(canvas).toHaveAttribute('data-animation', 'Step_InPlace');
    evidence.actions.push('Blink_Soft');
    const stop = await management.evaluate(() => window.nuanbanLumi.stop());
    assert.deepEqual(stop, { ok: true, action: 'stop' });
    await expect(canvas).toHaveAttribute('data-animation', '');
    evidence.stop = true;
    const semantic = await pet.evaluate(() => window.nuanbanLumi.semantic('listening'));
    assert.equal(semantic.ok, true); assert.equal(semantic.action, 'Listen_Curious');
    await expect(canvas).toHaveAttribute('data-animation', 'Listen_Curious');
    await expect(canvas).toHaveAttribute('data-animation', 'Idle_Breathe', { timeout: 10000 });
    evidence.semantic = true;
    await expect.poll(() => management.evaluate(() => window.__lumiActionEvents.length)).toBeGreaterThanOrEqual(9);
    await pet.evaluate(() => window.nuanbanPet.collapse());
    await expect(canvas).toBeHidden();
    const collapsed = await management.evaluate(() => window.nuanbanLumi.play('Wave_Gentle'));
    assert.equal(collapsed.ok, false); assert.equal(collapsed.code, 'unavailable');
    evidence.collapsedRejected = true;
    await showCompanion(context);
    await pet.evaluate(() => window.dispatchEvent(new CustomEvent('nuanban:avatar-visibility', { detail: { visible: true } })));
    await expect(pet.locator('#model-pet')).toBeHidden();
    const hidden = await management.evaluate(() => window.nuanbanLumi.play('Wave_Gentle'));
    assert.equal(hidden.ok, false); assert.equal(hidden.code, 'unavailable');
    evidence.hiddenRejected = true;
    await pet.evaluate(() => window.dispatchEvent(new CustomEvent('nuanban:avatar-visibility', { detail: { visible: false } })));
    await expect(canvas).toHaveAttribute('data-animation', 'Idle_Breathe', { timeout: 20000 });
    await management.evaluate(() => window.__lumiActionUnsubscribe());
    await card.screenshot({ path: path.join(cache, 'lumi-animated-card.png') });
    await showCompanion(context);
    await canvas.screenshot({ path: path.join(cache, 'lumi-animated-pet.png'), omitBackground: true });
    evidence.screenRequests += await application.evaluate(() => global.__lumiSmoke.screenRequests);
    await application.close(); context = undefined;
    context = await launch();
    await expect(context.card.getByRole('button', { name: '再次召唤桌宠' })).toBeVisible();
    await expect(context.pet.locator('#model-pet canvas')).toHaveAttribute('data-animation', 'Idle_Breathe', { timeout: 20000 });
    await showCompanion(context);
    const persisted = await context.management.evaluate(async () => { const model = await window.nuanbanModel.read(); return { id: model.id, bytes: model.bytes.byteLength }; });
    assert.deepEqual(persisted, { id: modelHash, bytes: 13171996 });
    const restored = await context.management.evaluate(() => window.nuanbanLumi.semantic('greeting'));
    assert.equal(restored.ok, true); assert.equal(restored.action, 'Wave_Gentle');
    evidence.restart = true;
    evidence.screenRequests += await context.application.evaluate(() => global.__lumiSmoke.screenRequests);
    assert.equal(evidence.screenRequests, 0);
    assert.deepEqual(evidence.errors, []);
    writeFileSync(path.join(cache, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(`LUMI_ACTIONS_ELECTRON_OK ${cache}`);
  } catch (error) {
    writeFileSync(path.join(cache, 'evidence.json'), JSON.stringify({ ...evidence, failure: String(error) }, null, 2));
    throw error;
  } finally { if (context) await context.application.close(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
