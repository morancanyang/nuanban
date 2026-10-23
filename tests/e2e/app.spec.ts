import { test, expect } from '@playwright/test';
import { installTextBridge } from '../helpers/text-bridge';

test('首页为空白本机工作区，不预置学习资料或发生水平溢出', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: '今天想学点什么？' })).toBeVisible();
  await expect(page.getByText('还没有学习记录，从一次真实提问开始。', { exact: true })).toBeVisible();
  await expect(page.getByText('没有待办，可按需要亲手创建。', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '真实软件教学', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('手机网页发送栏保持在可视宽度内并与工具按钮同排', async ({ page }) => {
  await page.goto('/#/chat/new');
  const send = page.getByRole('button', { name: '发送', exact: true });
  const tool = page.locator('.composer-bottom .tool-button').first();
  await expect(send).toBeVisible();
  const sendBox = await send.boundingBox();
  const toolBox = await tool.boundingBox();
  const viewport = page.viewportSize();
  expect(sendBox).not.toBeNull();
  expect(toolBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(Math.abs(sendBox!.y - toolBox!.y)).toBeLessThanOrEqual(8);
});

test('只有真实端口完整回复后创建笔记，刷新保留实际学习资料', async ({ page }) => {
  await installTextBridge(page);
  await page.goto('/#/chat/new');
  await page.getByLabel('想问微光指引的问题').fill('手机上的字太小，怎么调大？');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.message.assistant[data-state="completed"]')).toContainText('合成接口回执');
  expect(await page.evaluate(() => sessionStorage.getItem('text-request-count'))).toBe('1');
  await page.goto('/#/notes');
  await expect(page.locator('.note-card')).toHaveCount(1);
  await expect(page.locator('.note-card')).toContainText('手机上的字太小');
  await page.reload();
  await expect(page.locator('.note-card')).toHaveCount(1);
  await page.locator('.note-card').click();
  await expect(page.getByText('还想再练练', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '我确认已经掌握', exact: true }).click();
  await page.getByRole('button', { name: '确认更改状态', exact: true }).click();
  await expect(page.getByText('本人确认已掌握', { exact: true })).toBeVisible();
});

test('没有桌面模型接口时保留问题，不以固定回答创建笔记', async ({ page }) => {
  await page.goto('/#/chat/new');
  await page.getByLabel('想问微光指引的问题').fill('字体怎么调大？');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('alert', { name: '讲解未完成' })).toContainText('当前没有桌面模型接口');
  await expect(page.getByLabel('想问微光指引的问题')).toHaveValue('字体怎么调大？');
  await expect(page.locator('.message.assistant[data-state="completed"]')).toHaveCount(0);
  await page.goto('/#/notes');
  await expect(page.getByRole('heading', { name: '这里还没有笔记' })).toBeVisible();
});

test('本机待办由用户创建，确认时间后才保存，刷新可继续', async ({ page }) => {
  await page.goto('/#/todos');
  await page.getByRole('button', { name: '添加提醒', exact: true }).click();
  await page.getByLabel('提醒标题', { exact: true }).fill('亲手复习字体设置');
  await page.getByLabel('什么时候提醒').fill('2027-12-01T09:00');
  await page.getByRole('button', { name: '下一步：核对提醒时间' }).click();
  await expect(page.getByRole('dialog')).toContainText('亲手复习字体设置');
  await page.getByRole('button', { name: '确认这个时间并保存' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: '亲手复习字体设置' })).toBeVisible();
});

test('清空资料后不会恢复样例', async ({ page }) => {
  await installTextBridge(page);
  await page.goto('/#/chat/new');
  await page.getByLabel('想问微光指引的问题').fill('测试实际笔记');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.message.assistant[data-state="completed"]')).toBeVisible();
  await page.goto('/#/settings');
  await expect(page.getByRole('region', { name: '智能服务状态' })).toContainText('服务已配置');
  await page.getByRole('button', { name: '清空本机学习资料与画稿' }).click();
  await page.getByRole('button', { name: '确认清空', exact: true }).click();
  await page.goto('/#/notes');
  await expect(page.getByRole('heading', { name: '这里还没有笔记' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '这里还没有笔记' })).toBeVisible();
});
