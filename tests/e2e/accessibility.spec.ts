import { expect, test } from '@playwright/test';
import { installTextBridge } from '../helpers/text-bridge';

test.beforeEach(async ({ page }) => { await installTextBridge(page); });

test('键盘可以跳过导航、进入主内容并操作首页入口', async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) < 760, '窄窗侧边栏改为抽屉，键盘路径由 a11y-basics 覆盖');
  await page.goto('/#/');
  await expect(page.locator('.skip-link')).toBeVisible();
  await page.evaluate(() => document.body.focus());
  await page.locator('body').press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await expect(page).toHaveURL(/#\/$/);
  const chatLink = page.getByRole('navigation', { name: '主要导航' }).getByRole('link', { name: '和微光指引说说', exact: true });
  await chatLink.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '和微光指引说说' })).toBeVisible();
});

test('最大字号、减少动画与移动视口不产生横向溢出', async ({ page }) => {
  await page.goto('/#/settings');
  await page.getByText('正文大小').locator('..').getByRole('combobox').selectOption('1.25');
  await page.getByText('字幕字号').locator('..').getByRole('combobox').selectOption('40');
  await page.getByText('减少动画').locator('..').getByRole('checkbox').check();
  await expect.poll(() => page.locator('.app').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThan(20);
  await expect(page.getByText('减少动画').locator('..').getByRole('checkbox')).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto('/#/chat/new');
  await expect(page.getByText('大字字幕', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('静音只关闭声音，文字字幕和重读入口仍可用', async ({ page }) => {
  await page.goto('/#/chat/new');
  const mute = page.getByRole('button', { name: '静音讲解' });
  await mute.click();
  await expect(page.getByRole('button', { name: '打开讲解声音' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('想问微光指引的问题').fill('手机上的字太小，怎么调大？');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.caption')).toContainText('字太小');
  await expect(page.getByRole('button', { name: '再讲一遍' })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole('button', { name: '打开讲解声音' })).toHaveAttribute('aria-pressed', 'true');
});

test('语音不可用时明确降级到字幕，不阻塞讲解完成', async ({ page }) => {
  await page.addInitScript(() => { try { Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined }); } catch { } });
  await page.goto('/#/chat/new');
  await page.getByLabel('想问微光指引的问题').fill('手机上的字太小，怎么调大？');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('系统没有可用的语音播放，已保留大字字幕。', { exact: true })).toBeVisible();
  await expect(page.locator('.caption')).toContainText('字太小');
});

test('模态框具备可访问名称、Escape 关闭与焦点回收', async ({ page }) => {
  await page.goto('/#/chat/new');
  const trigger = page.getByRole('button', { name: '屏幕' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '真实屏幕观察' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '关闭窗口' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
