import { expect, test } from '@playwright/test';
import { installLiliModelBridge } from '../fixtures/lili-bridge';

test('栗栗透明预览可选择、保存与撤回，固定形象不使用通用微调', async ({ page }, testInfo) => {
  await page.goto('/#/pets');
  const preview = page.getByRole('region', { name: '桌宠微调预览' });
  await page.getByRole('button', { name: '栗栗小鹿', exact: true }).click();
  await expect(preview.getByRole('img').first()).toHaveAttribute('aria-label', '小橘猫暖暖');
  const lili = preview.getByRole('img', { name: '栗栗小鹿三维参考立绘，围着橙黄条纹围巾' });
  await expect(lili).toBeVisible();
  await expect.poll(() => lili.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1000);
  for (const label of ['眼睛', '嘴型', '动作姿态', '伙伴颜色']) await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '在本页显示栗栗', exact: true })).toBeEnabled();
  await expect(page.getByText('静态 3D 模型 · 无内置动画', { exact: true })).toBeVisible();
  await expect(page.getByText('手机浏览器会在当前页面显示栗栗；替换系统悬浮桌宠请使用微光指引桌面客户端。')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('lili-companion.png'), fullPage: true });
  await page.getByRole('button', { name: '预览满意，确认应用' }).click();
  await page.getByRole('button', { name: '确认应用到本机' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: '栗栗小鹿', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(preview.getByRole('img').first()).toHaveAttribute('alt', '栗栗小鹿三维参考立绘，围着橙黄条纹围巾');
  await page.getByRole('button', { name: '撤回上次应用' }).click();
  await page.getByRole('button', { name: '确认撤回', exact: true }).click();
  await expect(preview.getByRole('img').first()).toHaveAttribute('aria-label', '小橘猫暖暖');
  await expect(page.getByLabel('眼睛', { exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('桌面调用单独触发，失败可重试且不自动保存候选角色', async ({ page }) => {
  await installLiliModelBridge(page, { failOnce: '模拟栗栗资源未能加载' });
  await page.goto('/#/pets');
  await page.getByRole('button', { name: '栗栗小鹿', exact: true }).click();
  const call = page.getByRole('button', { name: '调用栗栗 3D 桌宠' });
  await expect(call).toBeEnabled();
  await call.click();
  await expect(page.getByRole('alert')).toContainText('模拟栗栗资源未能加载');
  await expect(page.getByText('客户端建模小鹿已保存并调用到桌面。', { exact: true })).toHaveCount(0);
  await call.click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('客户端建模小鹿已保存并调用到桌面。', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: '桌宠微调预览' }).getByRole('img').first()).toHaveAttribute('aria-label', '小橘猫暖暖');
  await page.reload();
  await expect(page.getByRole('button', { name: '小橘猫', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('等待桌面调用期间不能重复触发或切换候选角色', async ({ page }) => {
  await installLiliModelBridge(page, { pending: true });
  await page.goto('/#/pets');
  await page.getByRole('button', { name: '栗栗小鹿', exact: true }).click();
  await page.getByRole('button', { name: '调用栗栗 3D 桌宠' }).click();
  await expect(page.getByRole('button', { name: '正在请栗栗陪伴…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '小白兔', exact: true })).toBeDisabled();
});

test('内置伙伴先预览确认再应用，刷新可撤回', async ({ page }) => {
  await page.goto('/#/pets');
  const preview = page.getByRole('region', { name: '桌宠微调预览' });
  await expect(page.getByRole('button', { name: '撤回上次应用' })).toBeDisabled();
  await page.getByRole('button', { name: '小白兔', exact: true }).click();
  await page.getByLabel('眼睛', { exact: true }).selectOption('happy');
  await page.getByLabel('嘴型', { exact: true }).selectOption('open');
  await page.getByLabel('动作姿态', { exact: true }).selectOption('greeting');
  await expect(preview.getByRole('img').first()).toHaveAttribute('aria-label', '小橘猫暖暖');
  await expect(preview.getByRole('img').last()).toHaveAttribute('aria-label', '小兔子暖暖');
  await page.getByRole('button', { name: '预览满意，确认应用' }).click();
  await page.getByRole('button', { name: '暂不更改', exact: true }).click();
  await expect(preview.getByRole('img').first()).toHaveAttribute('aria-label', '小橘猫暖暖');
  await page.getByRole('button', { name: '预览满意，确认应用' }).click();
  await page.getByRole('button', { name: '确认应用到本机' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(preview.getByRole('img').first()).toHaveAttribute('aria-label', '小兔子暖暖');
  await expect(preview.getByRole('img').first()).toHaveClass(/action-greeting/);
  await page.reload();
  await expect(page.getByRole('button', { name: '撤回上次应用' })).toBeEnabled();
  await page.getByRole('button', { name: '撤回上次应用' }).click();
  await page.getByRole('button', { name: '确认撤回', exact: true }).click();
  await expect(preview.getByRole('img').first()).toHaveAttribute('aria-label', '小橘猫暖暖');
  await expect(page.getByRole('button', { name: '撤回上次应用' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('未保存微调可放弃，旧冲突参数不再干预本机应用', async ({ page }) => {
  await page.goto('/#/pets?scenario=version-conflict');
  await page.getByLabel('眼睛', { exact: true }).selectOption('happy');
  await page.getByRole('button', { name: '放弃预览，读取当前设置' }).click();
  await expect(page.getByLabel('眼睛', { exact: true })).toHaveValue('round');
  await page.getByRole('button', { name: '小白兔', exact: true }).click();
  await page.getByRole('button', { name: '预览满意，确认应用' }).click();
  const dialog = page.getByRole('dialog', { name: '确认应用内置桌宠微调？' });
  await dialog.getByRole('button', { name: '确认应用到本机' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: '桌宠微调预览' }).getByRole('img').first()).toHaveAttribute('aria-label', '小兔子暖暖');
  await expect(page.getByRole('button', { name: '小白兔', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
