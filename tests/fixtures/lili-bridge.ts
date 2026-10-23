import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { LocalModel } from '../../apps/web/src/local-model';

export async function installLiliModelBridge(page: Page, options: { failOnce?: string; pending?: boolean } = {}) {
  await page.addInitScript(({ bytes, failOnce, pending }) => {
    const listeners = new Set<(model: LocalModel) => void>();
    const model: LocalModel = {
      kind: 'model', id: '35c40f0c66b08fab749f7b711e97dc12dfd911003f375b9a77445c16928d7327',
      fileName: 'Lili_Independent_Deer.glb', format: 'glb', bytes: new Uint8Array(bytes),
      summary: { triangles: 76752, meshes: 43, bones: 0, animations: 0, decodedBytes: 4000000, textures: [] },
      updatedAt: '2026-10-23T00:00:00.000Z',
    };
    let active: LocalModel = localStorage.getItem('test-lili-active') ? model : { kind: 'none' };
    window.nuanbanModel = {
      read: async () => active,
      choose: async () => null,
      readBuiltin: async id => {
        if (id !== 'lili') throw new Error('未知资源');
        return { format: 'glb', bytes: new Uint8Array(bytes) };
      },
      applyBuiltin: async id => {
        if (id !== 'lili') throw new Error('未知资源');
        const calls = Number(sessionStorage.getItem('lili-detail-calls') ?? '0') + 1;
        sessionStorage.setItem('lili-detail-calls', String(calls));
        if (pending) return new Promise<LocalModel>(() => {});
        if (failOnce && calls === 1) throw new Error(failOnce);
        active = model;
        localStorage.setItem('test-lili-active', 'true');
        for (const listener of listeners) listener(active);
        return active;
      },
      apply: async () => { throw new Error('内置模型不使用导入候选'); },
      clear: async () => {
        active = { kind: 'none' };
        localStorage.removeItem('test-lili-active');
        for (const listener of listeners) listener(active);
        return active;
      },
      discard: async () => true,
      onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
  }, { ...options, bytes: Array.from(readFileSync(join(process.cwd(), 'apps/web/public/models/lili/Lili_Independent_Deer.glb'))) });
}
