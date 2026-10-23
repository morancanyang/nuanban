import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Box3, Camera, Light, Mesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiliModel } from '../../apps/web/src/three-d/lili-model';
import { inspectRenderedModel } from '../../apps/web/src/three-d/viewer';
import { liliModel, loadLiliModel } from '../../apps/web/src/three-d/builtin-models';

const { inspectModelContainer } = createRequire(import.meta.url)('../../apps/desktop/local-model.cjs');
const assetPath = join(process.cwd(), 'apps/web/public/models/lili/Lili_Independent_Deer.glb');
afterEach(() => { vi.unstubAllGlobals(); });

describe('栗栗客户端实时建模', () => {
  it('生成完整、静态、无背景的独立小鹿，三维资源在桌面限制内', () => {
    const model = createLiliModel();
    expect(model.format).toBe('procedural-lili');
    expect(model.id).toBe('lili');
    expect(model.animations).toEqual([]);
    const summary = inspectRenderedModel(model.root, model.animations);
    expect(summary).toMatchObject({ bones: 0, animations: 0, textures: [] });
    expect(summary.meshes).toBeGreaterThan(50);
    expect(summary.meshes).toBeLessThan(150);
    expect(summary.triangles).toBeGreaterThan(20000);
    expect(summary.triangles).toBeLessThanOrEqual(100000);
    expect(summary.decodedBytes).toBeLessThan(16 * 1024 * 1024);
    const names: string[] = [];
    model.root.updateMatrixWorld(true);
    model.root.traverse(object => {
      names.push(object.name);
      expect(object.matrixWorld.elements.every(Number.isFinite)).toBe(true);
      expect(object instanceof Light || object instanceof Camera).toBe(false);
      if (object instanceof Mesh) expect(object.geometry.getAttribute('normal')).toBeDefined();
    });
    expect(names).toEqual(expect.arrayContaining([
      'LiliDeer', 'Body', 'Belly_Cream', 'LiliHead', 'Muzzle_Cream', 'Nose', 'Mouth_Center',
      'Ear_L', 'Ear_R', 'Antler_L', 'Antler_R', 'Eye_L', 'Eye_R', 'Eye_L_Amber_Iris',
      'Eye_R_Iris_Fibers', 'Eye_L_Cornea', 'Eye_R_Soft_Lid', 'Brow_L', 'Cheek_R',
      'Scarf_Collar', 'Scarf_Tail', 'Scarf_Collar_Knit', 'Scarf_Tail_Knit', 'Scarf_Fringe_9',
      'Hand_L', 'Hand_R', 'Hoof_L_Split', 'Hoof_R_Split', 'Tail', 'Tail_Cream_Tip',
    ]));
    expect(names.some(name => /background|ground|floor|stage/i.test(name))).toBe(false);
    const size = new Box3().setFromObject(model.root).getSize(new Vector3());
    expect(size.y).toBeGreaterThan(size.x);
    expect(size.y).toBeLessThan(4);
  });

  it('围巾条纹与针脚在布料外侧，不被倒角遮挡', () => {
    const model = createLiliModel();
    model.root.updateMatrixWorld(true);
    const cloth = new Box3().setFromObject(model.root.getObjectByName('Scarf_Draped_Cloth')!);
    const knit = new Box3().setFromObject(model.root.getObjectByName('Scarf_Tail_Knit')!);
    for (let stripe = 1; stripe <= 3; stripe++) {
      const bounds = new Box3().setFromObject(model.root.getObjectByName(`Scarf_Stripe_${stripe}`)!);
      expect(bounds.min.z).toBeGreaterThan(cloth.max.z);
      expect(knit.min.z).toBeGreaterThan(bounds.max.z);
    }
  });

  it('虹膜纤维正面朝外，在单面材质下可见', () => {
    const model = createLiliModel();
    for (const label of ['L', 'R']) {
      const mesh = model.root.getObjectByName(`Eye_${label}_Iris_Fibers`) as Mesh;
      const normals = mesh.geometry.getAttribute('normal');
      for (let vertex = 0; vertex < normals.count; vertex++) expect(normals.getZ(vertex)).toBeGreaterThan(0);
    }
  });

  it('多次创建不共享几何和材质，关闭一个预览不影响另一个', () => {
    const first = createLiliModel();
    const second = createLiliModel();
    const firstBody = first.root.getObjectByName('Body') as Mesh;
    const secondBody = second.root.getObjectByName('Body') as Mesh;
    expect(first.root).not.toBe(second.root);
    expect(firstBody.geometry).not.toBe(secondBody.geometry);
    expect(firstBody.material).not.toBe(secondBody.material);
    expect(inspectRenderedModel(first.root, [])).toEqual(inspectRenderedModel(second.root, []));
  });

  it('随包 GLB 身份资源和 manifest 一致，继续通过本机容器与真实解码检查', async () => {
    const bytes = readFileSync(assetPath);
    const manifest = JSON.parse(readFileSync(join(assetPath, '..', 'character_manifest.json'), 'utf8'));
    expect(bytes.byteLength).toBe(1601548);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(liliModel.sha256);
    expect(manifest).toMatchObject({ id: 'lili', sha256: liliModel.sha256, bytes: bytes.byteLength, background: false, externalResources: false });
    expect(inspectModelContainer(bytes, 'glb')).toEqual({ format: 'glb' });
    const decoded = await new GLTFLoader().parseAsync(new Uint8Array(bytes).buffer, '');
    expect(inspectRenderedModel(decoded.scene, decoded.animations)).toMatchObject({ triangles: 76752, meshes: manifest.decodedMeshes, bones: 0, animations: 0, textures: [] });
  });

  it('可信内置资源读取使用固定小鹿 ID，不发送网络请求，并校验完整字节', async () => {
    const readBuiltin = vi.fn(async () => ({ format: 'glb', bytes: new Uint8Array(readFileSync(assetPath)) }));
    const fetch = vi.fn();
    vi.stubGlobal('window', { nuanbanModel: { read: vi.fn(), choose: vi.fn(), apply: vi.fn(), clear: vi.fn(), discard: vi.fn(), onChanged: vi.fn(), readBuiltin } });
    vi.stubGlobal('fetch', fetch);
    const model = await loadLiliModel();
    expect(model.format).toBe('glb');
    expect(model.bytes.byteLength).toBe(1601548);
    expect(readBuiltin).toHaveBeenCalledWith('lili');
    expect(fetch).not.toHaveBeenCalled();
    readBuiltin.mockResolvedValueOnce({ format: 'glb', bytes: new Uint8Array([1, 2, 3]) });
    await expect(loadLiliModel()).rejects.toThrow('校验失败');
  });

  it('浏览器仅读取同源随包资源；中止时不会继续读取', async () => {
    vi.stubGlobal('window', {});
    const fetch = vi.fn(async () => new Response(readFileSync(assetPath)));
    vi.stubGlobal('fetch', fetch);
    expect((await loadLiliModel()).bytes.byteLength).toBe(1601548);
    expect(fetch).toHaveBeenCalledWith(liliModel.modelUrl, { signal: undefined, credentials: 'omit' });
    const controller = new AbortController();
    controller.abort();
    await expect(loadLiliModel(controller.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
