import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnimationClip, AnimationMixer, Group, NumberKeyframeTrack } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';
import { createModelAnimationController } from '../../apps/web/src/three-d/animation-controller';
import { inspectRenderedModel } from '../../apps/web/src/three-d/viewer';

const { inspectModelContainer } = createRequire(import.meta.url)('../../apps/desktop/local-model.cjs');
const assetPath = join(process.cwd(), 'apps/web/public/models/lumi/Lumi_Magical_Kitten.glb');

describe('露米随包模型与动作', () => {
  it('预览与桌宠加载原版资产，不再用程序化替代猫覆盖上传模型', () => {
    const card = readFileSync(join(process.cwd(), 'apps/web/src/three-d/lumi-card.tsx'), 'utf8');
    const desktop = readFileSync(join(process.cwd(), 'apps/web/src/three-d/desktop.ts'), 'utf8');
    expect(card).toContain('await loadLumiModel(controller.signal)');
    expect(desktop).toContain('model.id === lumiModel.previousSha256 ? await loadLumiModel()');
    expect(card).not.toContain('createLumiModel');
    expect(desktop).not.toContain('createLumiModel');
    expect(card).not.toContain('9 个动作');
  });

  it('原版 GLB 保留角色、配饰、原始来源与实时毛发，符合原生预算', async () => {
    const bytes = readFileSync(assetPath);
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'apps/web/public/models/lumi/character_manifest.json'), 'utf8'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('3ec165a265d28d00bec78c6262d4909542d9d5e8759759cc00cdb07fd7f95f90');
    expect(bytes.length).toBe(manifest.runtime.fileBytes);
    expect(inspectModelContainer(bytes, 'glb')).toEqual({ format: 'glb' });
    const jsonBytes = bytes.readUInt32LE(12);
    const document = JSON.parse(bytes.subarray(20, 20 + jsonBytes).toString('utf8'));
    expect(document.cameras).toBeUndefined();
    expect(document.skins).toBeUndefined();
    expect(document.images.map((image: { name: string }) => image.name)).toEqual(expect.arrayContaining([
      'Microglow short-fur normal', 'Microglow woven cloak normal', 'Microglow original blue iris baked',
    ]));
    expect(document.nodes.find((node: { name: string }) => node.name === 'Microglow_Original_Cat').extras.source_blend_sha256).toBe(manifest.source.sha256);
    expect(manifest.source).toMatchObject({ file: 'microglow_cat.blend', collection: 'MICROGLOW_CAT_ONLY', sourceGroomStrands: 173800 });
    expect(manifest.runtime.groom).toMatchObject({ strands: 12364, lossless: false });
    const binary = bytes.subarray(28 + jsonBytes);
    const geometry = { ...document, materials: document.materials.map((material: { name: string }) => ({ name: material.name })), images: [], textures: [] };
    const json = Buffer.from(JSON.stringify(geometry));
    const padding = Buffer.alloc((4 - json.length % 4) % 4, 32);
    const header = Buffer.from(bytes.subarray(0, 20));
    header.writeUInt32LE(28 + json.length + padding.length + binary.length, 8);
    header.writeUInt32LE(json.length + padding.length, 12);
    const binaryHeader = bytes.subarray(20 + jsonBytes, 28 + jsonBytes);
    const container = Buffer.concat([header, json, padding, binaryHeader, binary]);
    const model = await new GLTFLoader().parseAsync(new Uint8Array(container).buffer, '');
    expect(inspectRenderedModel(model.scene, model.animations)).toMatchObject({ triangles: 97978, meshes: 149, bones: 0, animations: 1, textures: [] });
    expect(model.animations.map(clip => clip.name)).toEqual(['idle']);
    const names = new Set<string>();
    model.scene.traverse(object => names.add(object.name));
    expect([...names]).toEqual(expect.arrayContaining([
      'CAT_HEAD_sculpted_cheeks_RT', 'CAT_CLOAK_tailored_open_front_RT', 'CAT_BROOCH_turquoise_cabochon_RT',
      'CAT_WAND_rounded_gold_star_RT', 'CAT_BAG_soft_leather_body_RT', 'CAT_TAIL_curved_RT', 'CAT_HEAD_sculpted_cheeks_FUR_RT',
    ]));
    const mixer = new AnimationMixer(model.scene);
    const controller = createModelAnimationController(mixer, model.animations);
    expect(controller.defaultName).toBe('idle');
    expect(controller.play('idle')).toBe(true);
    expect(controller.play('cast')).toBe(false);
    mixer.update(0.25);
    model.scene.updateMatrixWorld(true);
    model.scene.traverse(object => expect(object.matrixWorld.elements.every(Number.isFinite)).toBe(true));
    controller.dispose();
    mixer.stopAllAction();
    mixer.uncacheRoot(model.scene);
  });

  it('默认按名称选择待机，同时播放表情，单次动作自动回到待机', () => {
    const root = new Group();
    const blink = new AnimationClip('blink', 1, [new NumberKeyframeTrack('.scale[x]', [0, 1], [1, 1.1])]);
    const idle = new AnimationClip('idle', 1, [new NumberKeyframeTrack('.position[y]', [0, 1], [0, 1])]);
    const wave = new AnimationClip('wave', 0.5, [new NumberKeyframeTrack('.position[y]', [0, 0.5], [1, 2])]);
    const face = new AnimationClip('face_wave', 0.5, [new NumberKeyframeTrack('.scale[x]', [0, 0.5], [1, 1.2])]);
    const mixer = new AnimationMixer(root);
    const controller = createModelAnimationController(mixer, [blink, idle, wave, face]);
    expect(controller.defaultName).toBe('idle');
    controller.play('idle');
    mixer.update(0.25);
    expect(root.position.y).toBeCloseTo(0.25);
    expect(root.scale.x).toBeCloseTo(1);
    controller.play('wave');
    mixer.update(0.25);
    expect(root.position.y).toBeCloseTo(1.5);
    expect(root.scale.x).toBeCloseTo(1.1);
    mixer.update(0.3);
    expect(controller.current).toBe('idle');
    mixer.update(3);
    expect(controller.current).toBe('idle');
    expect(controller.play('missing')).toBe(false);
    controller.dispose();
    expect(controller.play('wave')).toBe(false);
    mixer.stopAllAction();
  });

  it('待机眨眼间隔较长，单次眨眼仍保持原始速度', () => {
    vi.useFakeTimers();
    const root = new Group();
    const blink = new AnimationClip('blink', 0.2, [new NumberKeyframeTrack('.scale[x]', [0, 0.1, 0.2], [1, 0.5, 1])]);
    const idle = new AnimationClip('idle', 1, []);
    const mixer = new AnimationMixer(root);
    const controller = createModelAnimationController(mixer, [blink, idle]);
    try {
      controller.play('idle');
      for (let frame = 0; frame < 20; frame++) mixer.update(0.25);
      expect(root.scale.x).toBeCloseTo(1);

      vi.advanceTimersByTime(5000);
      mixer.update(0.05);
      expect(root.scale.x).toBeCloseTo(0.75);

      mixer.update(0.15);
      mixer.update(0.12);
      expect(root.scale.x).toBeCloseTo(1);
      vi.advanceTimersByTime(5000);
      mixer.update(0.05);
      expect(root.scale.x).toBeCloseTo(0.75);
    } finally {
      controller.dispose();
      mixer.stopAllAction();
      vi.useRealTimers();
    }
  });

  it('普通导入模型没有 idle 时保留第一段动画行为', () => {
    const root = new Group();
    const mixer = new AnimationMixer(root);
    const controller = createModelAnimationController(mixer, [new AnimationClip('custom-loop', 1, [])]);
    expect(controller.defaultName).toBe('custom-loop');
    expect(controller.play('custom-loop')).toBe(true);
    mixer.update(5);
    expect(controller.current).toBe('custom-loop');
    controller.dispose();
    expect(createModelAnimationController(mixer, []).defaultName).toBeUndefined();
  });
});
