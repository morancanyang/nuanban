import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Box3, Camera, Light, Mesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectRenderedModel } from '../../apps/web/src/three-d/viewer';
import { liliModel, loadLiliModel } from '../../apps/web/src/three-d/builtin-models';

const { inspectModelContainer } = createRequire(import.meta.url)('../../apps/desktop/local-model.cjs');
const assetPath = join(process.cwd(), 'apps/web/public/models/lili/Lili_Independent_Deer.glb');
const bytes = readFileSync(assetPath);
const manifest = JSON.parse(readFileSync(join(assetPath, '..', 'character_manifest.json'), 'utf8'));
const jsonBytes = bytes.readUInt32LE(12);
const document = JSON.parse(bytes.subarray(20, 20 + jsonBytes).toString('utf8'));
afterEach(() => { vi.unstubAllGlobals(); });

async function decodeGeometry() {
  const binary = bytes.subarray(28 + jsonBytes);
  const geometry = { ...document, materials: document.materials.map((material: { name: string }) => ({ name: material.name })), images: [], textures: [] };
  const json = Buffer.from(JSON.stringify(geometry));
  const padding = Buffer.alloc((4 - json.length % 4) % 4, 32);
  const header = Buffer.from(bytes.subarray(0, 20));
  header.writeUInt32LE(28 + json.length + padding.length + binary.length, 8);
  header.writeUInt32LE(json.length + padding.length, 12);
  return new GLTFLoader().parseAsync(new Uint8Array(Buffer.concat([header, json, padding, bytes.subarray(20 + jsonBytes, 28 + jsonBytes), binary])).buffer, '');
}

describe('栗栗原版 Blender 模型', () => {
  it('预览、管理和桌宠显示原版 GLB，不再覆盖成另一只程序化小鹿', () => {
    const card = readFileSync(join(process.cwd(), 'apps/web/src/three-d/lili-card.tsx'), 'utf8');
    const desktop = readFileSync(join(process.cwd(), 'apps/web/src/three-d/desktop.ts'), 'utf8');
    const panel = readFileSync(join(process.cwd(), 'apps/web/src/three-d/model-panel.tsx'), 'utf8');
    expect(card).toContain('await loadLiliModel(controller.signal)');
    expect(desktop).toContain('model.id === liliModel.previousSha256 ? await loadLiliModel() : model');
    expect(panel).toContain('source.id === liliModel.previousSha256 ? await loadLiliModel(controller.signal) : source');
    for (const source of [card, desktop, panel]) expect(source).not.toContain('createLiliModel');
    expect(card).toContain('与离线参考图仍有差别');
    expect(liliModel.previousSha256).not.toBe(liliModel.sha256);
  });

  it('完整资源身份、来源和静态角色边界与 manifest 一致', () => {
    expect(bytes.byteLength).toBe(manifest.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(liliModel.sha256);
    expect(manifest).toMatchObject({ id: 'lili', version: '2.0.0', sha256: liliModel.sha256, background: false, externalResources: false, bones: 0, animations: 0 });
    expect(inspectModelContainer(bytes, 'glb')).toEqual({ format: 'glb' });
    expect(document.cameras).toBeUndefined();
    expect(document.skins).toBeUndefined();
    expect(document.animations).toBeUndefined();
    expect(document.nodes.find((node: { name: string }) => node.name === 'Lili_Original_Blender_Deer').extras).toMatchObject({ character_id: 'lili-original-v2', source_blend_sha256: manifest.source.sha256 });
    expect(manifest.source.file).toBe('microglow_deer_independent.blend');
    expect(manifest.source.sha256).toMatch(/^[a-f\d]{64}$/);
    expect(manifest.runtime).toMatchObject({ renderer: 'glb', knitStitches: 2112, sourceGroomStrands: 184587 });
    expect(manifest.runtime.groomStrands).toBeGreaterThan(20000);
    for (const resource of [...document.buffers, ...document.images]) expect(resource.uri).toBeUndefined();
    expect(document.images.map((image: { name: string }) => image.name)).toEqual(expect.arrayContaining([
      'Lili short velvet fiber normal', 'Lili wool microfiber normal', 'Lili original amber iris baked',
    ]));
    const binary = bytes.subarray(28 + jsonBytes);
    for (const image of document.images) {
      const view = document.bufferViews[image.bufferView];
      const png = binary.subarray(view.byteOffset, view.byteOffset + view.byteLength);
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(png.readUInt32BE(16)).toBeLessThanOrEqual(2048);
      expect(png.readUInt32BE(20)).toBeLessThanOrEqual(2048);
    }
  });

  it('真实解码的原始头身、眼睛、鹿角和围巾保持在三维预算内', async () => {
    const model = await decodeGeometry();
    const summary = inspectRenderedModel(model.scene, model.animations);
    expect(summary).toMatchObject({ triangles: manifest.triangles, meshes: manifest.decodedMeshes, bones: 0, animations: 0, textures: [] });
    expect(summary.triangles).toBeLessThanOrEqual(100000);
    expect(summary.decodedBytes).toBeLessThan(32 * 1024 * 1024);
    const names: string[] = [];
    model.scene.updateMatrixWorld(true);
    model.scene.traverse(object => {
      names.push(object.name);
      expect(object.matrixWorld.elements.every(Number.isFinite)).toBe(true);
      expect(object instanceof Light || object instanceof Camera).toBe(false);
      if (object instanceof Mesh) expect(object.geometry.getAttribute('normal')).toBeDefined();
    });
    expect(names).toEqual(expect.arrayContaining([
      'DEER_BODY_CONTINUOUS_SCULPT_RT', 'DEER_HEAD_SCULPT_RT', 'DEER_CREAM_MUZZLE_RT',
      'DEER_AMBER_IRIS_-1_RT', 'DEER_ANTLER_ORGANIC_1_RT', 'DEER_SCARF_COLLAR_KNIT_0_RT',
      'DEER_SCARF_TAIL_KNIT_2_RT', 'DEER_HEAD_SCULPT_FILM_FUR_RT',
    ]));
    expect(names.some(name => /background|ground|floor|stage/i.test(name))).toBe(false);
    const size = new Box3().setFromObject(model.scene).getSize(new Vector3());
    expect(size.y).toBeGreaterThan(size.x);
    expect(size.y).toBeLessThan(4);
    const head = new Box3().setFromObject(model.scene.getObjectByName('DEER_HEAD_SCULPT_RT')!).getSize(new Vector3());
    expect(head.x / head.y).toBeGreaterThan(1.1);
    expect(head.x / head.y).toBeLessThan(1.3);
  });

  it('保留围巾真实针脚、颜色与渐隐腮红，而不是删除这些细节', async () => {
    const model = await decodeGeometry();
    model.scene.updateMatrixWorld(true);
    for (const section of ['COLLAR', 'TAIL']) {
      for (const color of [0, 1, 2]) {
        const stitch = model.scene.getObjectByName(`DEER_SCARF_${section}_KNIT_${color}_RT`) as Mesh;
        expect(stitch.geometry.getAttribute('position').count).toBeGreaterThan(500);
      }
    }
    const cheek = model.scene.getObjectByName('DEER_SOFT_CHEEK_TINT_1_RT') as Mesh;
    const colors = cheek.geometry.getAttribute('color');
    expect(colors.itemSize).toBe(4);
    const alpha = Array.from({ length: colors.count }, (_, index) => colors.getW(index));
    expect(Math.min(...alpha)).toBeLessThan(0.02);
    expect(Math.max(...alpha)).toBeGreaterThan(0.4);
    const iris = document.materials.find((material: { name: string }) => material.name.includes('layered amber iris'));
    expect(iris.pbrMetallicRoughness.baseColorTexture).toBeDefined();
  });

  it('两个预览解码为独立实例，关闭预览不破坏其他窗口', async () => {
    const first = await decodeGeometry();
    const second = await decodeGeometry();
    const firstBody = first.scene.getObjectByName('DEER_BODY_CONTINUOUS_SCULPT_RT') as Mesh;
    const secondBody = second.scene.getObjectByName('DEER_BODY_CONTINUOUS_SCULPT_RT') as Mesh;
    expect(firstBody.geometry).not.toBe(secondBody.geometry);
    expect(firstBody.material).not.toBe(secondBody.material);
  });

  it('原生桥仅读取固定小鹿 ID，无网络请求，校验全部字节', async () => {
    const readBuiltin = vi.fn(async () => ({ format: 'glb', bytes: new Uint8Array(bytes) }));
    const fetch = vi.fn();
    vi.stubGlobal('window', { nuanbanModel: { read: vi.fn(), choose: vi.fn(), apply: vi.fn(), clear: vi.fn(), discard: vi.fn(), onChanged: vi.fn(), readBuiltin } });
    vi.stubGlobal('fetch', fetch);
    const model = await loadLiliModel();
    expect(model.format).toBe('glb');
    expect(model.bytes.byteLength).toBe(manifest.bytes);
    expect(readBuiltin).toHaveBeenCalledWith('lili');
    expect(fetch).not.toHaveBeenCalled();
    readBuiltin.mockResolvedValueOnce({ format: 'glb', bytes: new Uint8Array([1, 2, 3]) });
    await expect(loadLiliModel()).rejects.toThrow('校验失败');
    readBuiltin.mockResolvedValueOnce({ format: 'fbx', bytes: new Uint8Array(bytes) });
    await expect(loadLiliModel()).rejects.toThrow('格式不正确');
  });

  it('浏览器仅读取同源随包资源，中止前后不继续加载', async () => {
    vi.stubGlobal('window', {});
    const fetch = vi.fn(async () => new Response(bytes));
    vi.stubGlobal('fetch', fetch);
    expect((await loadLiliModel()).bytes.byteLength).toBe(manifest.bytes);
    expect(fetch).toHaveBeenCalledWith(liliModel.modelUrl, { signal: undefined, credentials: 'omit' });
    const controller = new AbortController();
    controller.abort();
    await expect(loadLiliModel(controller.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    const duringRead = new AbortController();
    fetch.mockImplementationOnce(async () => { duringRead.abort(); return new Response(bytes); });
    await expect(loadLiliModel(duringRead.signal)).rejects.toThrow();
  });
});
