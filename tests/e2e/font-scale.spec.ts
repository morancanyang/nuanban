import { expect, test, type Page } from '@playwright/test';

const guestEntry = {
  cookies: [],
  origins: [{
    origin: 'http://127.0.0.1:5173',
    localStorage: [{ name: 'nuanban.entry.v1', value: JSON.stringify({ mode: 'guest', at: '2026-01-01T00:00:00.000Z' }) }],
  }],
};

const fontSize = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));

test.use({ storageState: guestEntry });

test('顶栏 A+/A− 立即缩放所有文字，刷新后保持', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile-chromium', '移动端隐藏字号快捷按钮');
  await page.goto('/#/');
  const app = await fontSize(page, '.app');
  expect(await fontSize(page, '.nav-item')).toBeCloseTo(16, 1);
  expect(await fontSize(page, '.home-card p')).toBeCloseTo(13, 1);

  await page.getByRole('button', { name: '放大文字' }).click();
  await expect.poll(() => fontSize(page, '.app')).toBeCloseTo(app * 1.1, 1);
  await expect.poll(() => fontSize(page, '.nav-item')).toBeCloseTo(17.6, 1);
  await expect.poll(() => fontSize(page, '.home-card p')).toBeCloseTo(14.3, 1);

  await page.getByRole('button', { name: '放大文字' }).click();
  await expect.poll(() => fontSize(page, '.app')).toBeCloseTo(app * 1.25, 1);
  await expect(page.getByRole('button', { name: '放大文字' })).toBeDisabled();

  await page.reload();
  await expect.poll(() => fontSize(page, '.app')).toBeCloseTo(app * 1.25, 1);

  await page.getByRole('button', { name: '缩小文字' }).click();
  await page.getByRole('button', { name: '缩小文字' }).click();
  await expect.poll(() => fontSize(page, '.app')).toBeCloseTo(app, 1);
  await expect(page.getByRole('button', { name: '缩小文字' })).toBeDisabled();
});

test('125% 下各页面无横向溢出，欢迎页也跟随字号', async ({ page }) => {
  await page.goto('/#/settings');
  await page.getByText('正文大小').locator('..').getByRole('combobox').selectOption('1.25');
  await expect.poll(() => fontSize(page, '.app')).toBeGreaterThan(20);

  for (const route of ['/#/', '/#/settings', '/#/notes', '/#/chat/new']) {
    await page.goto(route);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  }

  await page.goto('/#/welcome');
  await expect.poll(() => fontSize(page, '.welcome-lead')).toBeCloseTo(20, 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
