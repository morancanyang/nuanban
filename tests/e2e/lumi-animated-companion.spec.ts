import { expect, test } from '@playwright/test';

test('自然动作版七个动作可预览，版本切换销毁旧视图，不自动替换本机伙伴', async ({ page }) => {
  const errors: string[] = [];
  const posts: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.goto('/#/pets/lumi');
  const card = page.getByRole('region', { name: '露米 Lumi' });
  await card.getByRole('button', { name: '自然动作版', exact: true }).click();
  await expect(card.getByRole('img', { name: /露米魔法小猫/ })).toHaveAttribute('src', /lumi-animated-v4\/poster.png/);
  await card.getByRole('button', { name: '预览 3D 与动作' }).click();
  const canvas = card.locator('canvas');
  await expect(canvas).toHaveAttribute('data-appearance-profile', 'lumi-natural-v4-animated', { timeout: 20000 });
  await expect(canvas).toHaveAttribute('data-animation', 'Idle_Breathe');
  for (const [label, name] of [
    ['好奇倾听', 'Listen_Curious'], ['轻轻招手', 'Wave_Gentle'], ['点头回应', 'Nod_Encourage'],
    ['温柔指引', 'Guide_Point'], ['原地轻踏', 'Step_InPlace'], ['呼吸陪伴', 'Idle_Breathe'],
  ]) {
    await card.getByRole('button', { name: label, exact: true }).click();
    await expect(canvas).toHaveAttribute('data-animation', name);
  }
  await card.getByRole('button', { name: '轻柔眨眼', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-animation', 'Idle_Breathe');
  await card.getByRole('button', { name: '点头回应', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-animation', 'Nod_Encourage');
  await expect(canvas).toHaveAttribute('data-animation', 'Idle_Breathe', { timeout: 10000 });
  await card.screenshot({ path: test.info().outputPath('lumi-natural-actions.png') });
  await card.getByRole('button', { name: '原版', exact: true }).click();
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toHaveAttribute('data-appearance-profile', 'lumi-original-detail-v2.1', { timeout: 20000 });
  await expect(canvas).toHaveAttribute('data-animation', 'idle');
  await card.getByRole('button', { name: '收起 3D 预览' }).click();
  await expect(canvas).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(posts).toEqual([]);
});

test('自然动作版资源损坏明确报错，原版仍可独立加载', async ({ page }) => {
  await page.route('**/models/lumi-animated-v4/*.glb', route => route.fulfill({ body: Buffer.from([1, 2, 3]), contentType: 'model/gltf-binary' }));
  await page.goto('/#/pets/lumi');
  const card = page.getByRole('region', { name: '露米 Lumi' });
  await card.getByRole('button', { name: '自然动作版', exact: true }).click();
  await card.getByRole('button', { name: '预览 3D 与动作' }).click();
  await expect(card.getByRole('alert')).toContainText('校验失败');
  await expect(card.getByRole('button', { name: '轻轻招手', exact: true })).toBeDisabled();
  await expect(card.locator('canvas')).toHaveCount(0);
  await card.getByRole('button', { name: '原版', exact: true }).click();
  await expect(card.locator('canvas')).toHaveAttribute('data-animation', 'idle', { timeout: 20000 });
  await expect(card.getByRole('alert')).toHaveCount(0);
});
