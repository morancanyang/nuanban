import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AnimationMixer, Box3, Camera, Light, Mesh, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { liliModel, liliNaturalModel, loadLiliNaturalModel } from '../../apps/web/src/three-d/builtin-models';
import { inspectRenderedModel } from '../../apps/web/src/three-d/viewer';
import { createModelAnimationController } from '../../apps/web/src/three-d/animation-controller';

const { inspectModelContainer } = createRequire(import.meta.url)('../../apps/desktop/local-model.cjs');
const directory = join(process.cwd(), 'apps/web/public/models/lili-natural-v4');
const bytes = readFileSync(join(directory, liliNaturalModel.fileName));
const manifest = JSON.parse(readFileSync(join(directory, 'character_manifest.json'), 'utf8'));
const jsonLength = bytes.readUInt32LE(12);
const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));

afterEach(() => { vi.unstubAllGlobals(); });

async function decodeGeometry() {
  const geometry = { ...document, materials: document.materials.map((material: { name: string }) => ({ name: material.name })), images: [], textures: [] };
  const json = Buffer.from(JSON.stringify(geometry));
  const padding = Buffer.alloc((4 - json.length % 4) % 4, 32);
  const binaryChunk = bytes.subarray(20 + jsonLength);
  const header = Buffer.from(bytes.subarray(0, 20));
  header.writeUInt32LE(20 + json.length + padding.length + binaryChunk.length, 8);
  header.writeUInt32LE(json.length + padding.length, 12);
  return new GLTFLoader().parseAsync(new Uint8Array(Buffer.concat([header, json, padding, binaryChunk])).buffer, '');
}

describe('栗栗自然精修 v4 产品接口', () => {
  it('独立登记候选版，不覆盖原版，能力说明与真实资源一致', () => {
    expect(liliNaturalModel.id).not.toBe(liliModel.id);
    expect(liliNaturalModel.modelUrl).not.toBe(liliModel.modelUrl);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(liliNaturalModel.sha256);
    expect(bytes.byteLength).toBe(manifest.bytes);
    expect(inspectModelContainer(bytes, 'glb')).toEqual({ format: 'glb' });
    expect(manifest).toMatchObject({ id: liliNaturalModel.id, version: liliNaturalModel.version, fileName: liliNaturalModel.fileName,
      sha256: liliNaturalModel.sha256, bones: 18, animations: 5, background: false, externalResources: false, status: 'candidate',
      source: { file: 'lili-natural-v4.blend', sha256: liliNaturalModel.sourceSha256 },
      runtime: { mobileTested: false, sourceGroomStrands: 194719, knitStitches: 3208 } });
    expect(liliNaturalModel.capabilities).toEqual({ static: false, rigged: true, animations: true, mobileTested: false });
    expect(document.skins.length).toBeGreaterThan(0);
    expect(document.animations.map((animation: { name: string }) => animation.name).sort()).toEqual(liliNaturalModel.actions.map(action => action.name).sort());
    expect(document.cameras).toBeUndefined();
    for (const resource of [...document.buffers, ...document.images]) expect(resource.uri).toBeUndefined();
    const root = document.nodes.find((node: { name: string }) => node.name === 'Lili_Natural_v4_Deer');
    expect(root.extras).toMatchObject({ character_id: liliNaturalModel.id, asset_version: liliNaturalModel.version, source_blend_sha256: liliNaturalModel.sourceSha256 });
  });

  it('真实网格保留灯笼、双围巾、针脚与毛发，满足产品解码预算', async () => {
    const model = await decodeGeometry();
    const summary = inspectRenderedModel(model.scene, model.animations);
    expect(summary).toMatchObject({ triangles: manifest.triangles, meshes: manifest.decodedMeshes, bones: 18, animations: 5 });
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
    expect(names).toEqual(expect.arrayContaining(['DEER_BODY_CONTINUOUS_SCULPT_RT', 'DEER_LANTERN_SWING_HANDLE_RT',
      'DEER_LANTERN_GLASS_CHIMNEY_RT', 'DEER_LANTERN_GRIP_FINGER_0_RT', 'DEER_SCARF_DRAPED_SECOND_TAIL_RT',
      'DEER_SCARF_COLLAR_TWISTED_WOOL_0_RT', 'DEER_SCARF_SECOND_TAIL_KNIT_0_RT', 'DEER_HEAD_SCULPT_FILM_FUR_RT']));
    expect(names.some(name => /background|ground|floor|stage/i.test(name))).toBe(false);
    const size = new Box3().setFromObject(model.scene).getSize(new Vector3());
    expect(size.y).toBeGreaterThan(size.x);
    expect(size.y).toBeLessThan(4);
  });

  it('骨骼真实绑定蒙皮，动作不移动脚底，头部和空手臂可以独立变形', async () => {
    const model = await decodeGeometry();
    const mixer = new AnimationMixer(model.scene);
    const head = model.scene.getObjectByName('Head')!;
    const foot = model.scene.getObjectByName('DEER_HOOF_1_RT') as SkinnedMesh;
    expect(head.type).toBe('Bone');
    expect(foot.isSkinnedMesh).toBe(true);
    model.scene.updateMatrixWorld(true);
    foot.skeleton.update();
    const initialFoot = foot.getVertexPosition(0, new Vector3()).applyMatrix4(foot.matrixWorld);
    const initialHead = head.quaternion.clone();
    let invalidWeights = 0;
    let skinnedMeshes = 0;
    model.scene.traverse(object => {
      if (!(object instanceof SkinnedMesh)) return;
      skinnedMeshes++;
      const weights = object.geometry.getAttribute('skinWeight');
      for (let vertex = 0; vertex < weights.count; vertex++) {
        const sum = weights.getX(vertex) + weights.getY(vertex) + weights.getZ(vertex) + weights.getW(vertex);
        if (!Number.isFinite(sum) || Math.abs(sum - 1) > 0.0001) invalidWeights++;
      }
    });
    expect(skinnedMeshes).toBe(manifest.decodedMeshes);
    expect(invalidWeights).toBe(0);
    for (const name of ['idle', 'look', 'wave', 'nod']) {
      mixer.stopAllAction();
      const clip = model.animations.find(animation => animation.name === name)!;
      mixer.clipAction(clip).play();
      mixer.setTime(clip.duration * 0.4);
      model.scene.updateMatrixWorld(true);
      foot.skeleton.update();
      expect(foot.getVertexPosition(0, new Vector3()).applyMatrix4(foot.matrixWorld).distanceTo(initialFoot)).toBeLessThan(0.00001);
      expect(head.quaternion.angleTo(initialHead)).toBeGreaterThan(0.001);
      expect(model.scene.position.toArray()).toEqual([0, 0, 0]);
    }
    mixer.stopAllAction();
    const wave = model.animations.find(animation => animation.name === 'wave')!;
    mixer.clipAction(wave).play();
    mixer.setTime(wave.duration / 2);
    const freeArm = foot.skeleton.bones.find(bone => bone.name.replace(/[^a-z]/gi, '') === 'ArmL')!;
    const holdingArm = foot.skeleton.bones.find(bone => bone.name.replace(/[^a-z]/gi, '') === 'ArmR')!;
    expect(freeArm.quaternion.angleTo(holdingArm.quaternion)).toBeGreaterThan(0.5);
    mixer.stopAllAction();
    mixer.uncacheRoot(model.scene);
  });

  it('眼睑独立闭合再睁开，单次动作会回到自然待机', async () => {
    const model = await decodeGeometry();
    const mixer = new AnimationMixer(model.scene);
    const blink = model.animations.find(animation => animation.name === 'blink')!;
    const eyelids: SkinnedMesh[] = [];
    model.scene.traverse(object => { if (object instanceof SkinnedMesh && object.name.startsWith('DEER_BLINK_LID')) eyelids.push(object); });
    expect(eyelids).toHaveLength(4);
    expect(blink.tracks.every(track => track.name.includes('morphTargetInfluences'))).toBe(true);
    mixer.clipAction(blink).play();
    mixer.setTime(0.1);
    for (const eyelid of eyelids) expect(eyelid.morphTargetInfluences![0]).toBeGreaterThan(0.95);
    mixer.setTime(0.29);
    for (const eyelid of eyelids) expect(eyelid.morphTargetInfluences![0]).toBeLessThan(0.1);
    mixer.stopAllAction();
    const controller = createModelAnimationController(mixer, model.animations);
    for (const name of ['look', 'wave', 'nod', 'blink']) {
      expect(controller.play(name)).toBe(true);
      mixer.update(model.animations.find(clip => clip.name === name)!.duration + 0.1);
      expect(controller.current).toBe('idle');
    }
    expect(controller.play('missing')).toBe(false);
    controller.dispose();
    mixer.stopAllAction();
    mixer.uncacheRoot(model.scene);
  });

  it('自动眨眼过程中主动点眨眼，不会把同一形变动作淡出为零', async () => {
    const model = await decodeGeometry();
    const mixer = new AnimationMixer(model.scene);
    const controller = createModelAnimationController(mixer, model.animations);
    const eyelid = model.scene.getObjectByName('DEER_BLINK_LID_1_1') as SkinnedMesh;
    vi.useFakeTimers();
    try {
      controller.play('idle');
      vi.advanceTimersByTime(5000);
      mixer.update(0.05);
      expect(eyelid.morphTargetInfluences![0]).toBeGreaterThan(0.1);
      controller.play('blink');
      mixer.update(0.2);
      expect(eyelid.morphTargetInfluences![0]).toBeGreaterThan(0.25);
      mixer.update(0.11);
      expect(controller.current).toBe('idle');
      mixer.update(0.2);
      expect(eyelid.morphTargetInfluences![0]).toBeLessThan(0.001);
    } finally {
      controller.dispose();
      mixer.stopAllAction();
      mixer.uncacheRoot(model.scene);
      vi.useRealTimers();
    }
  });

  it('浏览器从随包路径读取真实 GLB，并在交付前校验哈希', async () => {
    vi.stubGlobal('window', {});
    const fetch = vi.fn(async () => new Response(bytes));
    vi.stubGlobal('fetch', fetch);
    const source = await loadLiliNaturalModel();
    expect(source.format).toBe('glb');
    expect(source.bytes.byteLength).toBe(bytes.byteLength);
    expect(fetch).toHaveBeenCalledWith(liliNaturalModel.modelUrl, { signal: undefined, credentials: 'omit' });
    fetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    await expect(loadLiliNaturalModel()).rejects.toThrow('校验失败');
    fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(loadLiliNaturalModel()).rejects.toThrow('未能读取');
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const call of [1, 2, 3]) expect(fetch).toHaveBeenNthCalledWith(call, liliNaturalModel.modelUrl, { signal: undefined, credentials: 'omit' });
  });

  it('桌面只通过候选版白名单读取，不上传、不自动应用或退回别的资源', async () => {
    const readBuiltin = vi.fn(async () => ({ format: 'glb', bytes: new Uint8Array(bytes) }));
    const applyBuiltin = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('window', { nuanbanModel: { read: vi.fn(), choose: vi.fn(), apply: vi.fn(), clear: vi.fn(), discard: vi.fn(), onChanged: vi.fn(), readBuiltin, applyBuiltin } });
    vi.stubGlobal('fetch', fetch);
    expect((await loadLiliNaturalModel()).bytes.byteLength).toBe(bytes.byteLength);
    expect(readBuiltin).toHaveBeenCalledWith('lili-natural-v4');
    readBuiltin.mockResolvedValueOnce({ format: 'fbx', bytes: new Uint8Array(bytes) });
    await expect(loadLiliNaturalModel()).rejects.toThrow('格式不正确');
    readBuiltin.mockResolvedValueOnce({ format: 'glb', bytes: new Uint8Array([0]) });
    await expect(loadLiliNaturalModel()).rejects.toThrow('校验失败');
    readBuiltin.mockRejectedValueOnce(new Error('未知的内置三维伙伴'));
    await expect(loadLiliNaturalModel()).rejects.toThrow('未知');
    expect(applyBuiltin).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('切换版本可中止候选版加载，不继续读取或交付已取消的资源', async () => {
    vi.stubGlobal('window', {});
    const controller = new AbortController();
    const fetch = vi.fn(async () => { controller.abort(); return new Response(bytes); });
    vi.stubGlobal('fetch', fetch);
    await expect(loadLiliNaturalModel(controller.signal)).rejects.toThrow();
    await expect(loadLiliNaturalModel(controller.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
