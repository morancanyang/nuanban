import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { LocalModel } from '../../apps/web/src/local-model';

const bytes = Array.from(readFileSync(join(process.cwd(), 'apps/web/public/models/lumi/Lumi_Magical_Kitten.glb')));
const hash = '3ec165a265d28d00bec78c6262d4909542d9d5e8759759cc00cdb07fd7f95f90';

test('内置小猫可真实旋转与播放动作，纯预览不调用或上传', async ({ page }) => {
  const errors: string[] = [];
  const uploads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST') uploads.push(request.url()); });
  await page.goto('/#/pets/lumi');
  const card = page.getByRole('region', { name: '露米 Lumi' });
  await expect(card.getByRole('img', { name: /露米魔法小猫/ })).toBeVisible();
  await expect(card.getByRole('button', { name: '在本页显示露米' })).toBeEnabled();
  await card.getByRole('button', { name: '预览 3D 与动作' }).click();
  const canvas = card.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-render-source', 'glb');
  await expect(canvas).toHaveAttribute('data-animation', 'idle');
  await card.getByRole('button', { name: '陪伴', exact: true }).click();
  await expect(card.getByRole('button', { name: '施展魔法', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.nuanbanModel)).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await card.screenshot({ path: test.info().outputPath('lumi-card.png') });
  await card.getByRole('button', { name: '收起 3D 预览' }).click();
  await expect(canvas).toHaveCount(0);
  await expect(card.getByRole('img', { name: /露米魔法小猫/ })).toBeVisible();
  await card.getByRole('button', { name: '在本页显示露米' }).click();
  await page.getByRole('button', { name: '确认在本页显示露米', exact: true }).click();
  await expect(page.locator('[aria-label="网页陪伴：露米"]')).toContainText('露米在这里陪你');
  await page.getByRole('button', { name: '关闭页面陪伴', exact: true }).click();
  await expect(page.locator('[aria-label="网页陪伴：露米"]')).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(uploads).toEqual([]);
});

test('模拟原生桥：取消不替换，确认本机保存，刷新后再次召唤', async ({ page }) => {
  await page.addInitScript(({ modelBytes, id }) => {
    const listeners = new Set<(model: LocalModel) => void>();
    const model: LocalModel = { kind: 'model', id, fileName: 'Lumi_Magical_Kitten.glb', format: 'glb', bytes: new Uint8Array(modelBytes),
      summary: { triangles: 97978, meshes: 149, bones: 0, animations: 1, decodedBytes: 20000000, textures: [{ width: 512, height: 512 }, { width: 512, height: 512 }, { width: 1024, height: 1024 }] }, updatedAt: '2026-10-23T00:00:00.000Z' };
    let active: LocalModel = localStorage.getItem('test-lumi-active') ? model : { kind: 'none' };
    window.nuanbanModel = {
      read: async () => active,
      choose: async () => null,
      readBuiltin: async name => { if (name !== 'lumi') throw new Error('未知资源'); return { format: 'glb', bytes: new Uint8Array(modelBytes) }; },
      applyBuiltin: async name => {
        if (name !== 'lumi') throw new Error('未知资源');
        localStorage.setItem('test-lumi-calls', String(Number(localStorage.getItem('test-lumi-calls') ?? '0') + 1));
        localStorage.setItem('test-lumi-active', 'true'); active = model;
        for (const listener of listeners) listener(active);
        return active;
      },
      apply: async () => { throw new Error('不应使用导入候选'); },
      clear: async () => { active = { kind: 'none' }; localStorage.removeItem('test-lumi-active'); for (const listener of listeners) listener(active); return active; },
      discard: async () => true,
      onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
  }, { modelBytes: bytes, id: hash });
  await page.goto('/#/pets/lumi');
  const card = page.getByRole('region', { name: '露米 Lumi' });
  await card.getByRole('button', { name: '设为桌面小伙伴' }).click();
  await page.getByRole('button', { name: '先不更换', exact: true }).click();
  expect(await page.evaluate(() => window.nuanbanModel!.read())).toEqual({ kind: 'none' });
  await card.getByRole('button', { name: '预览 3D 与动作' }).click();
  await expect(card.locator('canvas')).toBeVisible();
  expect(await page.evaluate(() => window.nuanbanModel!.read())).toEqual({ kind: 'none' });
  await card.getByRole('button', { name: '设为桌面小伙伴' }).click();
  await page.getByRole('button', { name: '确认保存并调用小猫' }).click();
  await expect(card.getByText('当前 3D 桌宠', { exact: true })).toBeVisible();
  await expect(card.getByRole('status')).toContainText('小猫已保存并调用到桌面');
  await page.reload();
  await expect(card.getByRole('button', { name: '再次召唤桌宠' })).toBeVisible();
  await card.getByRole('button', { name: '再次召唤桌宠' }).click();
  await expect(card.getByRole('status')).toContainText('小猫已保存并调用到桌面');
  expect(await page.evaluate(() => localStorage.getItem('test-lumi-calls'))).toBe('2');
  await page.getByRole('link', { name: '管理本机模型与切回原画' }).click();
  const panel = page.getByRole('region', { name: '让你的 3D 伙伴，来到桌面。' });
  await panel.getByRole('button', { name: '切回原画 / 内置桌宠' }).click();
  await page.getByRole('button', { name: '确认切回', exact: true }).click();
  await page.getByRole('region', { name: '小鹿与小猫伙伴收藏' }).getByRole('link', { name: /认识小猫露米/ }).click();
  await expect(card.getByRole('button', { name: '设为桌面小伙伴' })).toBeVisible();
});
