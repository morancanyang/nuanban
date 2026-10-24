import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AnimationMixer, Bone, Camera, Light, LoopOnce, Mesh, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBuiltinLumi, loadLumiAnimatedModel, lumiAnimatedModel, lumiModel } from '../../apps/web/src/three-d/builtin-models';
import { inspectRenderedModel } from '../../apps/web/src/three-d/viewer';

const { inspectModelContainer } = createRequire(import.meta.url)('../../apps/desktop/local-model.cjs');
const directory = join(process.cwd(), 'apps/web/public/models/lumi-animated-v4');
const bytes = readFileSync(join(directory, lumiAnimatedModel.fileName));
const manifest = JSON.parse(readFileSync(join(directory, 'character_manifest.json'), 'utf8'));
const jsonLength = bytes.readUInt32LE(12);
const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));

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

afterEach(() => { vi.unstubAllGlobals(); });

describe('露米自然动作版真实资产', () => {
  it('以独立版本交付七个真实片段，不覆盖原版或丢失资源身份', () => {
    expect(lumiAnimatedModel.id).not.toBe(lumiModel.id);
    expect(lumiAnimatedModel.posterUrl).not.toBe(lumiModel.posterUrl);
    expect(isBuiltinLumi(lumiAnimatedModel.sha256)).toBe(true);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(lumiAnimatedModel.sha256);
    expect(manifest.runtime).toMatchObject({ sha256: lumiAnimatedModel.sha256, fileBytes: bytes.length, triangleCount: 99496,
      skeleton: { boneCount: 33 }, morphTargets: ['Blink_L', 'Blink_R'], groom: { lossless: false } });
    expect(manifest.character).toMatchObject({ id: lumiAnimatedModel.id, assetVersion: lumiAnimatedModel.version });
    expect(inspectModelContainer(bytes, 'glb')).toEqual({ format: 'glb' });
    expect(document.animations.map((animation: { name: string }) => animation.name).sort()).toEqual(lumiAnimatedModel.actions.map(action => action.name).sort());
    expect(document.cameras).toBeUndefined();
    expect(document.extensions?.KHR_lights_punctual).toBeUndefined();
    for (const resource of [...document.buffers, ...document.images]) expect(resource.uri).toBeUndefined();
    const identity = document.nodes.find((node: { name: string }) => node.name === 'Lumi_Natural_v4_Rigged');
    expect(identity.extras).toMatchObject({ character_id: lumiAnimatedModel.id, source_blend_sha256: manifest.source.sha256 });
  });

  it('全部实时网格有规范蒙皮、有限数据，仍在产品十万三角形预算内', async () => {
    const model = await decodeGeometry();
    const summary = inspectRenderedModel(model.scene, model.animations);
    expect(summary).toMatchObject({ triangles: 99496, animations: 7, bones: 33 });
    expect(summary.decodedBytes).toBeLessThan(32 * 1024 * 1024);
    let skinned = 0;
    let invalid = 0;
    model.scene.traverse(object => {
      expect(object instanceof Camera || object instanceof Light).toBe(false);
      if (!(object instanceof SkinnedMesh)) return;
      skinned++;
      const weights = object.geometry.getAttribute('skinWeight');
      const joints = object.geometry.getAttribute('skinIndex');
      for (let vertex = 0; vertex < weights.count; vertex++) {
        const values = [weights.getX(vertex), weights.getY(vertex), weights.getZ(vertex), weights.getW(vertex)];
        if (values.some(value => !Number.isFinite(value) || value < 0) || Math.abs(values.reduce((total, value) => total + value, 0) - 1) > 0.0001) invalid++;
        for (const component of [joints.getX(vertex), joints.getY(vertex), joints.getZ(vertex), joints.getW(vertex)]) {
          if (!Number.isInteger(component) || component < 0 || component >= object.skeleton.bones.length) invalid++;
        }
      }
      expect(object.geometry.getAttribute('normal')).toBeDefined();
    });
    expect(skinned).toBe(summary.meshes);
    expect(invalid).toBe(0);
  });

  it('眨眼只有眼睑形态键，闭合后归零，不覆盖身体动作', async () => {
    const model = await decodeGeometry();
    const blink = model.animations.find(clip => clip.name === 'Blink_Soft')!;
    const lids: Mesh[] = [];
    model.scene.traverse(object => { if (object instanceof Mesh && object.name.startsWith('LUMI_LID_')) lids.push(object); });
    expect(lids).toHaveLength(4);
    expect(blink.duration).toBeCloseTo(0.3);
    expect(blink.tracks.every(track => track.name.includes('morphTargetInfluences'))).toBe(true);
    expect(lids.every(lid => lid.morphTargetInfluences?.[0] === 0)).toBe(true);
    const mixer = new AnimationMixer(model.scene);
    mixer.clipAction(blink).setLoop(LoopOnce, 1).play();
    mixer.setTime(0.1);
    expect(lids.every(lid => lid.morphTargetInfluences![0] > 0.99)).toBe(true);
    mixer.setTime(0.299);
    expect(lids.every(lid => lid.morphTargetInfluences![0] < 0.01)).toBe(true);
    mixer.stopAllAction();
    expect(lids.every(lid => lid.morphTargetInfluences![0] === 0)).toBe(true);
  });

  it('片段时长匹配接口，循环无接缝，根骨不使用整体漂浮冒充呼吸', async () => {
    const model = await decodeGeometry();
    for (const action of lumiAnimatedModel.actions) {
      const clip = model.animations.find(item => item.name === action.name)!;
      expect(clip.duration * 1000).toBeCloseTo(action.durationMs, 2);
      for (const track of clip.tracks) {
        expect(Array.from(track.values).every(Number.isFinite)).toBe(true);
        if (action.loop) {
          const width = track.getValueSize();
          for (let component = 0; component < width; component++) expect(track.values[component]).toBeCloseTo(track.values[track.values.length - width + component], 5);
        }
      }
    }
    const root = model.scene.getObjectByName('root') as Bone;
    expect(root).toBeInstanceOf(Bone);
    const mixer = new AnimationMixer(model.scene);
    const idle = model.animations.find(clip => clip.name === 'Idle_Breathe')!;
    mixer.clipAction(idle).play();
    const initial = root.position.clone();
    mixer.setTime(1.6);
    model.scene.updateMatrixWorld(true);
    expect(root.position.distanceTo(initial)).toBeLessThan(0.000001);
    const chest = model.scene.getObjectByName('chest')!;
    expect(chest.getWorldScale(new Vector3()).x).toBeGreaterThan(1.001);
    mixer.stopAllAction();
  });

  it('招手用空闲右爪，魔杖始终与左爪同骨；脚步有真实抬脚与锁定支撑脚', async () => {
    const model = await decodeGeometry();
    const holding = model.scene.getObjectByName('handL')!;
    const waving = model.scene.getObjectByName('handR')!;
    const leftFoot = model.scene.getObjectByName('footL')!;
    const rightFoot = model.scene.getObjectByName('footR')!;
    expect(holding).toBeInstanceOf(Bone);
    model.scene.updateMatrixWorld(true);
    const initialHand = holding.getWorldPosition(new Vector3());
    const initialWave = waving.getWorldPosition(new Vector3());
    const initialLeft = leftFoot.getWorldPosition(new Vector3());
    const initialRight = rightFoot.getWorldPosition(new Vector3());
    const mixer = new AnimationMixer(model.scene);
    mixer.clipAction(model.animations.find(clip => clip.name === 'Wave_Gentle')!).play();
    mixer.setTime(1);
    model.scene.updateMatrixWorld(true);
    expect(holding.getWorldPosition(new Vector3()).distanceTo(initialHand)).toBeLessThan(0.0001);
    expect(waving.getWorldPosition(new Vector3()).y - initialWave.y).toBeGreaterThan(0.6);
    let wandMeshes = 0;
    model.scene.traverse(object => {
      if (!(object instanceof SkinnedMesh) || !object.name.startsWith('CAT_WAND')) return;
      wandMeshes++;
      const index = object.skeleton.bones.findIndex(bone => bone === holding);
      const joints = object.geometry.getAttribute('skinIndex');
      const weights = object.geometry.getAttribute('skinWeight');
      for (let vertex = 0; vertex < joints.count; vertex++) {
        expect(joints.getX(vertex)).toBe(index);
        expect(weights.getX(vertex)).toBeCloseTo(1);
      }
    });
    expect(wandMeshes).toBeGreaterThan(0);
    mixer.stopAllAction();
    mixer.clipAction(model.animations.find(clip => clip.name === 'Step_InPlace')!).play();
    mixer.setTime(0.5);
    model.scene.updateMatrixWorld(true);
    expect(leftFoot.getWorldPosition(new Vector3()).y - initialLeft.y).toBeCloseTo(0.045, 3);
    expect(rightFoot.getWorldPosition(new Vector3()).distanceTo(initialRight)).toBeLessThan(0.0001);
    mixer.stopAllAction();
  });

  it('浏览器和原生资源同样校验摘要，损坏资源不进入渲染', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
    const source = await loadLumiAnimatedModel();
    expect(source.bytes.byteLength).toBe(bytes.length);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
    await expect(loadLumiAnimatedModel()).rejects.toThrow('校验失败');
    const controller = new AbortController();
    controller.abort();
    await expect(loadLumiAnimatedModel(controller.signal)).rejects.toThrow();
  });
});
