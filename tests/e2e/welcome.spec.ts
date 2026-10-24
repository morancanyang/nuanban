import { expect, test } from '@playwright/test';

const guestEntry = {
  cookies: [],
  origins: [{
    origin: 'http://127.0.0.1:5173',
    localStorage: [{ name: 'nuanban.entry.v1', value: JSON.stringify({ mode: 'guest', at: '2026-01-01T00:00:00.000Z' }) }],
  }],
};

test.describe('第一次进入微光指引', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('首次访问跳转到欢迎页，可游客进入并记住选择', async ({ page }) => {
    await page.goto('/#/');
    await expect(page).toHaveURL(/#\/welcome$/);
    await expect(page).toHaveTitle('微光指引 · 陪你慢慢学会');
    await expect(page.locator('.welcome-brand strong')).toHaveText('微光指引');
    const mark = page.locator('.welcome-mark');
    await expect(mark).toHaveAttribute('src', /brand-mark.*\.svg/);
    await expect.poll(() => mark.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator('body')).not.toContainText(/暖伴|NUANBAN/);
    await expect(page.getByRole('heading', { name: /先坐一会儿/ })).toBeVisible();
    await page.getByRole('button', { name: '游客模式，直接进入' }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByRole('heading', { name: '今天想学点什么？' })).toBeVisible();
    await expect(page.locator('.brand strong')).toHaveText('微光指引');
    await expect(page.locator('body')).not.toContainText(/暖伴|NUANBAN/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('nuanban.entry.v1'))).toContain('guest');
    await page.reload();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByRole('heading', { name: '今天想学点什么？' })).toBeVisible();
  });

  test('登录入口只展示真实账号状态，不收集任何凭证', async ({ page }) => {
    await page.goto('/#/welcome');
    await expect(page.locator('.welcome-status')).toHaveText('资料本机保存 · 模型按需调用');
    await page.getByRole('button', { name: '登录微光指引账号' }).click();
    const panel = page.getByRole('region', { name: '账号服务状态' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('不会生成任何凭证');
    await expect(page.locator('input[type="password"], input[type="text"], input[type="tel"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /模拟|演练|认领/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '查看账号服务状态' })).toHaveAttribute('href', '#/onboarding/login');
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => /token|session|auth/i.test(key)))).toEqual([]);
  });

  test('入口记录保存失败仍可进入，刷新后重新选择游客模式', async ({ page }) => {
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === 'nuanban.entry.v1') throw new DOMException('Quota exceeded', 'QuotaExceededError');
        original.call(this, key, value);
      };
    });
    await page.goto('/#/welcome');
    await page.getByRole('button', { name: '游客模式，直接进入' }).click();
    await expect(page.getByRole('heading', { name: '今天想学点什么？' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('nuanban.entry.v1'))).toBeNull();
    await page.reload();
    await expect(page).toHaveURL(/#\/welcome$/);
  });

  test('背景四层都只是装饰：不拦截点击、无横向溢出', async ({ page }) => {
    await page.goto('/#/welcome');
    const ambient = page.locator('.ambient');
    await expect(ambient).toHaveCount(1);
    await expect(page.locator('.ambient-sun')).toHaveCount(1);
    await expect(page.locator('.ambient-rays')).toHaveCount(1);
    await expect(page.locator('.login-scene')).toHaveCount(1);
    expect(await page.locator('.login-scene').getAttribute('aria-hidden')).toBe('true');
    const style = await ambient.evaluate(element => {
      const computed = getComputedStyle(element);
      return { pointerEvents: computed.pointerEvents, position: computed.position };
    });
    expect(style).toEqual({ pointerEvents: 'none', position: 'fixed' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });

  test('日出暖光确实在动，减少动态时静止', async ({ page }) => {
    await page.goto('/#/welcome');
    const sun = page.locator('.ambient-sun');
    const sample = () => sun.evaluate(element => getComputedStyle(element).transform);
    const first = await sample();
    await page.waitForTimeout(900);
    expect(await sample()).not.toBe(first);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const still = await sample();
    await page.waitForTimeout(600);
    expect(await sample()).toBe(still);
    expect(await sun.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
    expect(await page.locator('.welcome-mark').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  });

  test('小屏只保留暖阳，不显示旋转光束', async ({ page }, testInfo) => {
    await page.goto('/#/welcome');
    const rays = page.locator('.ambient-rays');
    if (testInfo.project.name === 'mobile-chromium') await expect(rays).toBeHidden();
    else await expect(rays).toBeVisible();
  });
});

test.describe('已经选过游客模式', () => {
  test.use({ storageState: guestEntry });

  test('直接访问首页不会被拦截，背景层仍在', async ({ page }) => {
    await page.goto('/#/');
    await expect(page.getByRole('heading', { name: '今天想学点什么？' })).toBeVisible();
    await expect(page.locator('.ambient')).toHaveCount(1);
  });

  test('再次打开欢迎页显示继续进入', async ({ page }) => {
    await page.goto('/#/welcome');
    await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
    await page.getByRole('button', { name: '继续以游客身份进入' }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByRole('heading', { name: '今天想学点什么？' })).toBeVisible();
  });

  test('首页卡片错峰入场，切页时主内容有淡入动效', async ({ page }) => {
    await page.goto('/#/');
    await expect(page.locator('.home-card').first()).toHaveCSS('animation-name', 'mf-rise');
    const animations = await page.evaluate(async () => {
      const link = document.querySelector<HTMLAnchorElement>('a[href="#/notes"]');
      if (!link) return -1;
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      await new Promise(resolve => setTimeout(resolve, 60));
      return document.getElementById('main-content')?.getAnimations().length ?? 0;
    });
    expect(animations).toBeGreaterThan(0);
    await expect(page).toHaveURL(/#\/notes$/);
  });

  test('减少动态时首页直接可见，没有入场动画', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/#/');
    await expect(page.getByRole('heading', { name: '今天想学点什么？' })).toBeVisible();
    expect(await page.locator('.home-card').first().evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  });
});
