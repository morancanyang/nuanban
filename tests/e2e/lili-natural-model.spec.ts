import { expect, test } from '@playwright/test';

test('自然精修 v4 显式选择并真实渲染，不自动替换默认版本', async ({ page }) => {
  const errors: string[] = [];
  const uploads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST') uploads.push(request.url()); });
  await page.goto('/#/pets/lili');
  const card = page.getByRole('region', { name: '栗栗 Lili' });
  const versions = card.getByRole('combobox', { name: '模型版本' });
  await expect(versions).toHaveValue('original');
  await expect(card.locator('canvas')).toHaveCount(0);
  await versions.selectOption('natural-v4');
  await expect(card).toContainText('候选版 · 不自动替换');
  await expect(card).toContainText('骨骼与眼睑形变 · 5 段基础动作');
  await expect(card).toContainText('未验证手机性能');
  await expect(card.locator('.lili-model-poster')).toHaveAttribute('src', /models\/lili-natural-v4\/poster\.png$/);
  await card.getByRole('button', { name: '预览小鹿 3D 模型' }).click();
  const canvas = card.locator('canvas');
  await expect(canvas).toHaveAttribute('data-render-source', 'glb');
  await expect(canvas).toHaveAttribute('data-appearance-profile', 'lili-natural-v4');
  await expect(canvas).toBeVisible();
  await expect(card.locator('.lili-model-poster')).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-animation', 'idle');
  for (const [label, name] of [['左右看看', 'look'], ['轻轻招手', 'wave'], ['点头回应', 'nod'], ['轻轻眨眼', 'blink']]) {
    await card.getByRole('button', { name: label, exact: true }).click();
    await expect(canvas).toHaveAttribute('data-animation', name);
  }
  await expect(canvas).toHaveAttribute('data-animation', 'idle');
  await card.screenshot({ path: test.info().outputPath('lili-natural-v4-product.png') });
  await versions.selectOption('original');
  await expect(canvas).toHaveCount(1);
  await expect(canvas).not.toHaveAttribute('data-appearance-profile', 'lili-natural-v4');
  await expect(card.locator('.lili-model-poster')).toHaveCount(0);
  await card.getByRole('button', { name: '收起 3D 预览' }).click();
  await expect(canvas).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  expect(uploads).toEqual([]);
});

test('浏览器页面陪伴仅使用所选版本立绘，确认后也可切回原版', async ({ page }) => {
  await page.goto('/#/pets/lili');
  const card = page.getByRole('region', { name: '栗栗 Lili' });
  await card.getByRole('combobox', { name: '模型版本' }).selectOption('natural-v4');
  await card.getByRole('button', { name: '在本页显示栗栗', exact: true }).click();
  await page.getByRole('button', { name: '确认在本页显示栗栗', exact: true }).click();
  const companion = page.locator('[aria-label="网页陪伴：栗栗"]');
  await expect(companion.locator('img')).toHaveAttribute('src', /models\/lili-natural-v4\/poster\.png$/);
  await expect(card.getByRole('status')).toContainText('这里使用透明立绘');
  await card.getByRole('combobox', { name: '模型版本' }).selectOption('original');
  await expect(companion.locator('img')).toHaveAttribute('src', /models\/lili-natural-v4\/poster\.png$/);
  await card.getByRole('button', { name: '在本页显示栗栗', exact: true }).click();
  await page.getByRole('button', { name: '确认在本页显示栗栗', exact: true }).click();
  await expect(companion.locator('img')).toHaveAttribute('src', /models\/lili\/poster\.png$/);
});

test('候选资源损坏时显示错误并保留参考立绘，可选择原版恢复预览', async ({ page }) => {
  await page.route('**/models/lili-natural-v4/Lili_Natural_v4.glb', route => route.fulfill({ body: Buffer.from([1, 2, 3]) }));
  await page.goto('/#/pets/lili');
  const card = page.getByRole('region', { name: '栗栗 Lili' });
  await card.getByRole('combobox', { name: '模型版本' }).selectOption('natural-v4');
  await card.getByRole('button', { name: '预览小鹿 3D 模型' }).click();
  await expect(card.getByRole('alert')).toContainText('校验失败');
  await expect(card.locator('canvas')).toHaveCount(0);
  await expect(card.locator('.lili-model-poster')).toBeVisible();
  await card.getByRole('combobox', { name: '模型版本' }).selectOption('original');
  await expect(card.locator('canvas')).toHaveAttribute('data-render-source', 'glb');
  await expect(card.getByRole('alert')).toHaveCount(0);
  await expect(card.locator('.lili-model-poster')).toHaveCount(0);
});
