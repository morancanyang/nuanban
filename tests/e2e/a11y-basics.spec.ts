import { expect, test } from '@playwright/test';
import { findContrastViolations } from '../helpers/contrast';

const routes: ReadonlyArray<readonly [string, string]> = [
  ['/#/', 'home'],
  ['/#/chat/new', 'chat'],
  ['/#/settings', 'settings'],
  ['/#/pets', 'pets'],
  ['/#/onboarding/mode', 'onboarding'],
  ['/#/overlay/guide', 'guide'],
  ['/#/notes', 'notes'],
  ['/#/todos', 'todos'],
];

async function open(page: import('@playwright/test').Page, url: string, pageKey: string) {
  await page.goto(url);
  await expect(page.locator('#main-content')).toHaveAttribute('data-page', pageKey);
}

test('各页面可见正文的对比度都达到 4.5:1', async ({ page }) => {
  for (const [url, pageKey] of routes) {
    await open(page, url, pageKey);
    await page.waitForTimeout(320);
    const violations = await findContrastViolations(page);
    expect(violations, `${url} 存在低对比度文本：${JSON.stringify(violations)}`).toEqual([]);
  }
});

test('每条路由的标题跟随页面 H1', async ({ page }) => {
  for (const [url, pageKey] of routes) {
    await open(page, url, pageKey);
    const heading = (await page.locator('h1').first().innerText()).replace(/\s+/g, ' ').trim();
    await expect.poll(() => page.title(), { message: url }).toContain(heading);
  }
});

test('窄窗关闭的侧边栏不进入键盘顺序，打开后可 Esc 关闭并回焦', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 844 });
  await page.goto('/#/');
  const sidebar = page.locator('#app-sidebar');
  const menu = page.getByRole('button', { name: '展开导航' });
  await expect(sidebar).toHaveJSProperty('inert', true);

  for (let step = 0; step < 8; step += 1) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('#app-sidebar')))).toBe(false);
  }

  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar).toHaveJSProperty('inert', false);
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('#app-sidebar')))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(sidebar).toHaveJSProperty('inert', true);
  await expect(menu).toBeFocused();
});

test('渲染异常时显示可恢复兜底且不清空本机资料', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('nuanban.keep', 'keep-me');
    window.matchMedia = () => {
      throw new Error('模拟浏览器能力读取失败');
    };
  });
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: '页面出了点问题' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新加载' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('nuanban.keep'))).toBe('keep-me');
});

test('顶部说明链接与用户菜单达到最小触达尺寸', async ({ page, viewport }) => {
  test.skip((viewport?.width ?? 0) < 1000, '用户菜单在窄屏隐藏，只校验桌面入口');
  await page.goto('/#/');
  const ribbon = await page.locator('.demo-ribbon a').boundingBox();
  const chip = await page.locator('.profile-chip').boundingBox();
  expect(ribbon?.height ?? 0).toBeGreaterThanOrEqual(24);
  expect(chip?.height ?? 0).toBeGreaterThanOrEqual(44);
});
