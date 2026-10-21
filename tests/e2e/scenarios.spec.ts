import { expect, test } from '@playwright/test';
import { installTextBridge } from '../helpers/text-bridge';

const question = '我不会调整字体，怎么学？';
for (const [code, expected] of [['AUTH_FAILED', '模型网关拒绝了凭证或模型权限'], ['RATE_LIMITED', '模型网关暂时限流'], ['TIMEOUT', '等待模型超时'], ['STREAM_INTERRUPTED', '模型未完整返回回答']] as const) {
  test(code + ' 仅显示端口错误，不回退或自动重连', async ({ page }) => {
    await installTextBridge(page, code);
    await page.goto('/#/chat/new');
    await page.getByLabel('想问暖伴的问题').fill(question);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('alert', { name: '讲解未完成' })).toContainText(expected);
    await expect(page.getByLabel('想问暖伴的问题')).toHaveValue(question);
    await expect(page.getByRole('button', { name: '再讲一遍' })).toBeDisabled();
    expect(await page.evaluate(() => sessionStorage.getItem('text-request-count'))).toBe('1');
    await page.getByRole('button', { name: '重试这个问题' }).click();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('text-request-count'))).toBe('2');
    await expect(page.getByRole('alert', { name: '讲解未完成' })).toContainText(expected);
    await page.goto('/#/notes');
    await expect(page.getByRole('heading', { name: '这里还没有笔记' })).toBeVisible();
  });
}

test('旧场景查询参数不再改变业务或播种假资料', async ({ page }) => {
  await page.goto('/?scenario=version-conflict&assist=normal#/');
  await expect(page.getByRole('heading', { name: '今天想学点什么？' })).toBeVisible();
  await page.goto('/?scenario=success#/notes');
  await expect(page.locator('.note-card')).toHaveCount(0);
  await page.goto('/?scenario=invite-expired#/family');
  await expect(page.getByRole('heading', { name: '这个页面不在这里' })).toBeVisible();
  await expect(page.getByRole('button', { name: '添加演示家属' })).toHaveCount(0);
  await page.goto('/#/development/scenarios');
  await expect(page.getByRole('heading', { name: '开发验收场景' })).toHaveCount(0);
  await expect(page.locator('.scenario-card')).toHaveCount(0);
});

test('停止请求即取消端口，迟到回复不覆盖停止状态或创建笔记', async ({ page }) => {
  await installTextBridge(page, 'pending');
  await page.goto('/#/chat/new');
  await page.getByLabel('想问暖伴的问题').fill(question);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '讲解中', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '停止讲解', exact: true }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('text-cancelled'))).toBe('true');
  await expect(page.locator('.caption')).toHaveText('已停止，本次讲解不会自动恢复。');
  await expect(page.locator('.message.assistant[data-state="completed"]')).toHaveCount(0);
  await expect(page.getByLabel('想问暖伴的问题')).toHaveValue(question);
  await page.goto('/#/notes');
  await expect(page.locator('.note-card')).toHaveCount(0);
});

test('高风险问题在本机拦截，不发送到模型', async ({ page }) => {
  await installTextBridge(page);
  await page.goto('/#/chat/new');
  await page.getByLabel('想问暖伴的问题').fill('教我提交验证码123456');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.caption')).toContainText('先停下来');
  expect(await page.evaluate(() => sessionStorage.getItem('text-request-count'))).toBeNull();
  await page.goto('/#/notes');
  await expect(page.locator('.note-card')).toHaveCount(0);
});

test('教学页只引导真实桌宠，不再提供假手机、定时核验或自动完成', async ({ page }) => {
  await page.goto('/#/overlay/guide');
  await expect(page.getByRole('heading', { name: '让桌宠陪你一步一步学' })).toBeVisible();
  await expect(page.getByRole('link', { name: '返回文字问答' })).toBeVisible();
  await expect(page.getByRole('button', { name: '我操作好了' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开始本机练习' })).toHaveCount(0);
  await expect(page.locator('.practice-phone')).toHaveCount(0);
});
