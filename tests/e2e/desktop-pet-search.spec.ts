import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

async function petSearchFixture(page: Page, configured = false, delayed = false, authFailure = false, modelAnswer = false, invalidAnswer = false) {
  await page.route('http://nuanban.test/**', async route => {
    const filename = new URL(route.request().url()).pathname.slice(1);
    if (!['pet.html', 'pet.css', 'pet.js', 'pet-artwork.js', 'pet-search.js'].includes(filename)) return route.abort();
    await route.fulfill({ body: readFileSync(new URL(`../../apps/desktop/${filename}`, import.meta.url)),
      contentType: filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.css') ? 'text/css' : 'text/javascript' });
  });
  await page.addInitScript(({ configured, delayed, authFailure, modelAnswer, invalidAnswer }) => {
    let panelListener: ((value: { expanded: boolean; focusInput: boolean }) => void) | undefined;
    let searchListener: (() => void) | undefined;
    const audit = { searches: [] as string[], opened: [] as string[], cancelled: 0 };
    Object.defineProperty(window, 'syntheticSearchAudit', { value: audit });
    Object.defineProperty(window, 'nuanbanPet', { value: {
      snapshot: async () => ({ observation: { state: 'off', generation: 1, captureActive: false }, task: { state: 'idle', generation: 1 },
        analysis: { state: 'idle' }, captions: { enabled: false }, wake: { state: 'disabled' } }),
      onState: () => () => {}, onPanel: (callback: typeof panelListener) => { panelListener = callback; return () => {}; },
      command: async () => ({ ok: true }), ask: async () => ({ ok: true }), showMenu: async () => true,
    } });
    Object.defineProperty(window, 'nuanbanSearch', { value: {
      status: async () => ({ provider: 'ConfiguredModel', configured }),
      open: async () => { panelListener?.({ expanded: true, focusInput: false }); searchListener?.(); return { ok: true }; },
      onOpen: (callback: () => void) => { searchListener = callback; return () => {}; },
      search: async (query: string, consent: boolean) => {
        if (!consent) throw new Error('confirmation missing');
        audit.searches.push(query);
        if (authFailure) return { ok: false, code: 'SEARCH_AUTH_FAILED', message: '智能服务鉴权失败，请检查本机模型密钥或账号权限。' };
        if (delayed) await new Promise(resolve => window.setTimeout(resolve, 500));
        if (modelAnswer) return { ok: true, query, kind: 'model-answer', webSearch: invalidAnswer,
          answer: '<img src=x onerror=alert(1)> 合成模型回答，仅用于界面测试。', results: [] };
        return { ok: true, query, results: [{ id: 'synthetic-source', title: '<img src=x onerror=alert(1)> 合成花卉来源',
          url: 'https://example.org/garden', source: 'example.org', snippet: '合成搜索摘要，仅用于界面测试。' }] };
      },
      cancel: async () => { audit.cancelled++; return { ok: true }; },
      openSource: async (id: string) => { audit.opened.push(id); return { ok: true }; },
    } });
  }, { configured, delayed, authFailure, modelAnswer, invalidAnswer });
  await page.goto('http://nuanban.test/pet.html');
  await page.locator('#pet-toggle').click();
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByRole('heading', { name: '帮你查一查' })).toBeVisible();
  await expect(page.locator('#search-query')).toBeFocused();
}

test('没有已有模型时仍可打开查询入口，但不发送请求或填充假结果', async ({ page }) => {
  await petSearchFixture(page);
  await expect(page.getByText(/本机模型尚未就绪/)).toBeVisible();
  await page.getByLabel('你想查什么问题？').fill('如何养茉莉');
  await page.getByLabel('我同意将这里输入的问题发送给已配置的模型').check();
  await expect(page.getByRole('button', { name: '请模型回答', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { syntheticSearchAudit: { searches: string[] } }).syntheticSearchAudit.searches)).toEqual([]);
  await expect(page.getByRole('list', { name: '搜索结果' })).toBeHidden();
});

test('直接复用已有模型，无需 AnySearch 密钥；本人确认后回答且不伪造来源或执行HTML', async ({ page }) => {
  await petSearchFixture(page, true, false, false, true);
  await expect(page.locator('#search-configuration')).toContainText('已复用现有模型');
  await expect(page.locator('#search-configuration')).toContainText('无需 AnySearch 密钥');
  await page.locator('#search-query').fill('怎样保存文件');
  await expect(page.locator('#submit-search')).toBeDisabled();
  await page.locator('#search-consent').check();
  await page.locator('#submit-search').click();
  await expect(page.locator('#search-answer')).toBeVisible();
  await expect(page.getByRole('heading', { name: '模型回答 · 未联网核验' })).toBeVisible();
  await expect(page.locator('#search-answer-content')).toHaveText('<img src=x onerror=alert(1)> 合成模型回答，仅用于界面测试。');
  await expect(page.locator('#search-answer img')).toHaveCount(0);
  await expect(page.locator('#search-answer a')).toHaveCount(0);
  await expect(page.locator('#search-results')).toBeHidden();
  await expect(page.locator('#search-progress')).toContainText('未进行网页检索或实时核验');
  expect(await page.evaluate(() => (window as unknown as { syntheticSearchAudit: { searches: string[]; opened: string[] } }).syntheticSearchAudit)).toMatchObject({ searches: ['怎样保存文件'], opened: [] });
});

test('停止查询和跨页会隔离迟到模型回答，重新打开不自动发送', async ({ page }) => {
  await petSearchFixture(page, true, true, false, true);
  await page.locator('#search-query').fill('怎样保存文件');
  await page.locator('#search-consent').check();
  await page.locator('#submit-search').click();
  await page.locator('#cancel-search').click();
  await page.waitForTimeout(600);
  await expect(page.locator('#search-answer')).toBeHidden();
  await expect(page.locator('#search-answer-content')).toBeEmpty();
  await page.locator('#submit-search').click();
  await page.locator('#view-features').click();
  await page.waitForTimeout(600);
  await page.locator('#feature-search').click();
  await expect(page.locator('#search-answer')).toBeHidden();
  await expect(page.locator('#search-consent')).not.toBeChecked();
  expect(await page.evaluate(() => (window as unknown as { syntheticSearchAudit: { searches: string[] } }).syntheticSearchAudit.searches)).toEqual(['怎样保存文件', '怎样保存文件']);
});

test('模型回答不能自行宣称网页已核验，异常回包不会展示', async ({ page }) => {
  await petSearchFixture(page, true, false, false, true, true);
  await page.locator('#search-query').fill('怎样保存文件');
  await page.locator('#search-consent').check();
  await page.locator('#submit-search').click();
  await expect(page.locator('#search-error')).toBeVisible();
  await expect(page.locator('#search-answer')).toBeHidden();
  await expect(page.locator('#search-results')).toBeHidden();
});

test('兼容来源结果：本人确认后才搜索，来源点击才打开，外部标题只作为文字渲染', async ({ page }) => {
  await petSearchFixture(page, true);
  await page.getByLabel('你想查什么问题？').fill('如何养茉莉');
  await expect(page.getByRole('button', { name: '请模型回答', exact: true })).toBeDisabled();
  await page.getByLabel('我同意将这里输入的问题发送给已配置的模型').check();
  await page.getByRole('button', { name: '请模型回答', exact: true }).click();
  await expect(page.getByRole('list', { name: '搜索结果' })).toContainText('合成搜索摘要');
  expect(await page.evaluate(() => (window as unknown as { syntheticSearchAudit: { opened: string[] } }).syntheticSearchAudit.opened)).toEqual([]);
  await expect(page.locator('#search-results img')).toHaveCount(0);
  await page.locator('#search-results button').click();
  expect(await page.evaluate(() => (window as unknown as { syntheticSearchAudit: { opened: string[] } }).syntheticSearchAudit.opened)).toEqual(['synthetic-source']);
});

test('密钥已加载不代表鉴权通过，401 错误不展示模拟结果或自动重试', async ({ page }) => {
  await petSearchFixture(page, true, false, true);
  await expect(page.getByText(/已复用现有模型/)).toBeVisible();
  await page.getByLabel('你想查什么问题？').fill('如何养茉莉');
  await page.getByLabel('我同意将这里输入的问题发送给已配置的模型').check();
  await page.getByRole('button', { name: '请模型回答', exact: true }).click();
  await expect(page.getByText('智能服务鉴权失败，请检查本机模型密钥或账号权限。')).toBeVisible();
  await expect(page.getByRole('list', { name: '搜索结果' })).toBeHidden();
  await expect(page.locator('#search-query')).toHaveValue('如何养茉莉');
  await expect(page.locator('#search-query')).toBeFocused();
  await expect(page.locator('#search-query')).toBeEditable();
  expect(await page.evaluate(() => (window as unknown as { syntheticSearchAudit: { searches: string[] } }).syntheticSearchAudit.searches)).toEqual(['如何养茉莉']);
});

test('查询中保留可见插入点，取消后可继续输入且迟到结果不能抢焦点', async ({ page }) => {
  await petSearchFixture(page, true, true);
  await page.locator('#search-query').fill('如何养茉莉');
  await page.locator('#search-consent').check();
  await page.locator('#search-query').focus();
  await page.locator('#search-query').press('Enter');
  await expect(page.locator('#search-query')).toBeEnabled();
  await expect(page.locator('#search-query')).not.toBeEditable();
  await expect(page.locator('#search-query')).toBeFocused();
  await expect(page.locator('#search-query')).toHaveCSS('caret-color', 'rgb(69, 49, 38)');
  await page.locator('#cancel-search').click();
  await expect(page.locator('#search-query')).toBeEditable();
  await expect(page.locator('#search-query')).toBeFocused();
  await page.locator('#search-query').fill('继续整理的问题');
  await page.locator('#search-consent').focus();
  await page.waitForTimeout(600);
  await expect(page.locator('#search-query')).toHaveValue('继续整理的问题');
  await expect(page.locator('#search-consent')).toBeFocused();
  await expect(page.locator('#search-results')).toBeHidden();
});

test('取消后迟到搜索结果不能重新出现', async ({ page }) => {
  await petSearchFixture(page, true, true);
  await page.getByLabel('你想查什么问题？').fill('如何养茉莉');
  await page.getByLabel('我同意将这里输入的问题发送给已配置的模型').check();
  await page.getByRole('button', { name: '请模型回答', exact: true }).click();
  await page.getByRole('button', { name: '停止查询', exact: true }).click();
  await page.waitForTimeout(600);
  await expect(page.getByRole('list', { name: '搜索结果' })).toBeHidden();
  await expect(page.getByText('查询已停止，不会自动重新发送。')).toBeVisible();
});

test('收起搜索会撤销本次发送确认，重开不自动搜索', async ({ page }) => {
  await petSearchFixture(page, true);
  await page.getByLabel('我同意将这里输入的问题发送给已配置的模型').check();
  await page.getByRole('button', { name: '收起搜索', exact: true }).click();
  await expect(page.getByRole('heading', { name: '帮你查一查' })).toBeHidden();
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.getByLabel('我同意将这里输入的问题发送给已配置的模型')).not.toBeChecked();
  expect(await page.evaluate(() => (window as unknown as { syntheticSearchAudit: { searches: string[] } }).syntheticSearchAudit.searches)).toEqual([]);
});

test('搜索途中返回首页会停止请求，迟到结果不跨页显示，重开仍需本人确认', async ({ page }) => {
  await petSearchFixture(page, true, true);
  await page.locator('#search-query').fill('如何养茉莉');
  await page.locator('#search-consent').check();
  await page.locator('#submit-search').click();
  await page.locator('#view-features').click();
  await expect(page.locator('#feature-home')).toBeVisible();
  await expect(page.locator('#search-panel')).toBeHidden();
  await page.waitForTimeout(600);
  await expect(page.locator('#search-results')).toBeHidden();
  await page.locator('#feature-search').click();
  await expect(page.locator('#feature-home')).toBeHidden();
  await expect(page.locator('#search-panel')).toBeVisible();
  await expect(page.locator('#search-query')).toHaveValue('如何养茉莉');
  await expect(page.locator('#search-consent')).not.toBeChecked();
  expect(await page.evaluate(() => (window as unknown as { syntheticSearchAudit: { searches: string[] } }).syntheticSearchAudit.searches)).toEqual(['如何养茉莉']);
});
