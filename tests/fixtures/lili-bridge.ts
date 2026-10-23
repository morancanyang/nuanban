import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { LocalModel } from '../../apps/web/src/local-model';

export async function installLiliModelBridge(page: Page, options: { failOnce?: string; pending?: boolean } = {}) {
  await page.addInitScript(({ encoded, failOnce, pending }) => {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const listeners = new Set<(model: LocalModel) => void>();
    const model: LocalModel = {
      kind: 'model', id: '8b5b3adce1d8995a0c754aed5d89360ec56fb35f7cf6d570052594de508fb35c',
      fileName: 'Lili_Independent_Deer.glb', format: 'glb', bytes: new Uint8Array(bytes),
      summary: { triangles: 97992, meshes: 63, bones: 0, animations: 0, decodedBytes: 40000000, textures: [{ width: 512, height: 512 }, { width: 1024, height: 512 }] },
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
  }, { ...options, encoded: readFileSync(join(process.cwd(), 'apps/web/public/models/lili/Lili_Independent_Deer.glb')).toString('base64') });
}
