import { expect, test } from '@playwright/test';

const routes: ReadonlyArray<readonly [string, string]> = [
  ['/#/', 'home'],
  ['/#/chat/new', 'chat'],
  ['/#/notes', 'notes'],
  ['/#/todos', 'todos'],
  ['/#/pets', 'pets'],
  ['/#/pets/lili', 'lili'],
  ['/#/pets/lumi', 'lumi'],
  ['/#/pets/draw', 'draw'],
  ['/#/settings', 'settings'],
  ['/#/onboarding/mode', 'onboarding'],
  ['/#/onboarding/login', 'account'],
  ['/#/sync/conflicts', 'conflicts'],
  ['/#/overlay/guide', 'guide'],
];

test('每个模块都挂上动效入口与路由转场', async ({ page }) => {
  for (const [url, key] of routes) {
    await page.goto(url);
    const main = page.locator('#main-content');
    await expect(main, url).toHaveAttribute('data-page', key);
    await expect(main, url).toHaveClass(/route-enter/);
    const animation = await main.evaluate(element => getComputedStyle(element).animationName);
    expect(animation, url).toBe('mf-route');
    const titleAnimation = await page.locator('.page-title').first().evaluate(element => getComputedStyle(element).animationName);
    expect(titleAnimation, url).toBe('mf-rise');
  }
});

test('首页入场按卡片顺序错峰', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.locator('.home-card')).toHaveCount(3);
  const delays = await page
    .locator('.home-card')
    .evaluateAll((nodes: Element[]) => nodes.map(node => Number.parseFloat(getComputedStyle(node).animationDelay)));
  expect(delays).toHaveLength(3);
  expect(delays[0]).toBeLessThan(delays[1]);
  expect(delays[1]).toBeLessThan(delays[2]);
});

test('设置里的减少动画会即时关闭全站动效', async ({ page }) => {
  await page.goto('/#/settings');
  await page.getByText('减少动画').locator('..').getByRole('checkbox').check();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('reduce-motion')))
    .toBe(true);
  await page.goto('/#/');
  const card = page.locator('.home-card').first();
  await expect(card).toHaveCSS('opacity', '1');
  const duration = await card.evaluate(element => Number.parseFloat(getComputedStyle(element).animationDuration));
  expect(duration).toBeLessThan(0.01);
});

test('系统减少动态偏好无需应用内开关也生效', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/');
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('reduce-motion')))
    .toBe(true);
  const ambient = await page
    .locator('.ambient')
    .first()
    .evaluate(element => getComputedStyle(element, '::after').animationName);
  expect(ambient).toBe('none');
});

test('路由切换会重放转场并保持主内容可聚焦', async ({ page }) => {
  await page.goto('/#/');
  await page.locator('.home-card[href="#/notes"]').click();
  await expect(page).toHaveURL(/#\/notes$/);
  const main = page.locator('#main-content');
  await expect(main).toHaveAttribute('data-page', 'notes');
  await expect(main).toHaveClass(/route-enter/);
  await expect(main).toBeFocused();
});

test('弹窗开合有动效且关闭后不残留', async ({ page }) => {
  await page.goto('/#/chat/new');
  await page.getByRole('button', { name: '屏幕' }).click();
  const dialog = page.getByRole('dialog', { name: '真实屏幕观察' });
  await expect(dialog).toBeVisible();
  const animation = await dialog.evaluate(element => getComputedStyle(element).animationName);
  expect(animation).toBe('mf-modal-in');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('窗口失焦时循环动画暂停', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.locator('#main-content')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('motion-paused')))
    .toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('motion-paused')))
    .toBe(false);
});
