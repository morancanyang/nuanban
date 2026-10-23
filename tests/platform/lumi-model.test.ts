import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnimationClip, AnimationMixer, Group, NumberKeyframeTrack } from 'three';
import type { Mesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';
import { createModelAnimationController } from '../../apps/web/src/three-d/animation-controller';
import { inspectRenderedModel } from '../../apps/web/src/three-d/viewer';
import { createLumiModel } from '../../apps/web/src/three-d/lumi-model';

const { inspectModelContainer } = createRequire(import.meta.url)('../../apps/desktop/local-model.cjs');
const assetPath = join(process.cwd(), 'apps/web/public/models/lumi/Lumi_Magical_Kitten.glb');

describe('露米随包模型与动作', () => {
  it('客户端程序化模型保留小猫本体、服装和配饰，并提供完整动作集', () => {
    const model = createLumiModel();
    const summary = inspectRenderedModel(model.root, model.animations);
    expect(model.format).toBe('procedural-lumi');
    expect(model.id).toBe('lumi');
    expect(summary).toMatchObject({ animations: 16, textures: [] });
    expect(summary.meshes).toBeGreaterThan(40);
    expect(summary.triangles).toBeGreaterThan(1000);
    expect(model.animations.map(animation => animation.name)).toEqual(expect.arrayContaining([
      'idle', 'walk', 'wave', 'happy', 'think', 'cast', 'surprise', 'sleep', 'tap_react', 'blink',
      'face_cast', 'face_happy', 'face_sleep', 'face_surprise', 'face_tap_react', 'face_think',
    ]));
    const names = new Set<string>();
    model.root.traverse(object => names.add(object.name));
    expect([...names]).toEqual(expect.arrayContaining(['LumiHead', 'Body', 'Cape_Back', 'Gem', 'Staff', 'ShoulderBag', 'Tail', 'Eye_L', 'Eye_R']));
    const mixer = new AnimationMixer(model.root);
    const controller = createModelAnimationController(mixer, model.animations);
    for (const name of ['idle', 'walk', 'wave', 'happy', 'think', 'cast', 'surprise', 'sleep', 'tap_react']) {
      expect(controller.play(name)).toBe(true);
      mixer.update(0.25);
      model.root.updateMatrixWorld(true);
      model.root.traverse(object => expect(object.matrixWorld.elements.every(Number.isFinite)).toBe(true));
    }
    controller.dispose();
    mixer.stopAllAction();
    mixer.uncacheRoot(model.root);
  });

  it('真实 GLB 通过原生检查与 Three 解析，带有全部身体、表情和骨骼', async () => {
    const bytes = readFileSync(assetPath);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('7fbe808f7de41e0e15181a0094038f79d6168ea99888dc8947846a2f70cf019b');
    expect(inspectModelContainer(bytes, 'glb')).toEqual({ format: 'glb' });
    const model = await new GLTFLoader().parseAsync(new Uint8Array(bytes).buffer, '');
    expect(inspectRenderedModel(model.scene, model.animations)).toMatchObject({ triangles: 29900, bones: 30, animations: 16, textures: [] });
    const names = model.animations.map(clip => clip.name);
    expect(names[0]).not.toBe('idle');
    expect(names).toEqual(expect.arrayContaining(['idle', 'walk', 'wave', 'happy', 'think', 'cast', 'surprise', 'sleep', 'tap_react', 'blink', 'face_cast', 'face_happy', 'face_sleep', 'face_surprise', 'face_tap_react', 'face_think']));
    const morphs = new Set<string>();
    model.scene.traverse(object => { for (const name of Object.keys((object as Mesh).morphTargetDictionary ?? {})) morphs.add(name); });
    expect([...morphs]).toEqual(expect.arrayContaining(['blink_L', 'blink_R', 'brow_up', 'mouth_open', 'smile']));
    const mixer = new AnimationMixer(model.scene);
    const controller = createModelAnimationController(mixer, model.animations);
    expect(controller.defaultName).toBe('idle');
    for (const name of ['idle', 'wave', 'happy', 'cast', 'sleep', 'tap_react']) {
      expect(controller.play(name)).toBe(true);
      mixer.update(0.25);
      model.scene.updateMatrixWorld(true);
      model.scene.traverse(object => {
        expect(object.matrixWorld.elements.every(Number.isFinite)).toBe(true);
        expect(((object as Mesh).morphTargetInfluences ?? []).every(Number.isFinite)).toBe(true);
      });
    }
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
