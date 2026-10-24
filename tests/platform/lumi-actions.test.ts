import { createRequire } from 'node:module';
import { AnimationClip, AnimationMixer, Group, NumberKeyframeTrack } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelAnimationController } from '../../apps/web/src/three-d/animation-controller';
import { createLumiActions } from '../../apps/web/src/three-d/lumi-actions';
import { lumiAnimatedModel } from '../../apps/web/src/three-d/builtin-models';

const { registerLumiActions, modelHash, actions } = createRequire(import.meta.url)('../../apps/desktop/lumi-actions.cjs');
const bridges: { dispose(): void }[] = [];
afterEach(() => { bridges.splice(0).forEach(bridge => bridge.dispose()); vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture() {
  const handlers = new Map<string, (...argumentsList: any[]) => any>();
  const management = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn() } };
  const pet = { isDestroyed: () => false, isVisible: () => true, webContents: { isDestroyed: () => false, send: vi.fn() } };
  const managementEvent = { sender: management.webContents };
  const petEvent = { sender: pet.webContents };
  let model = { kind: 'model', id: modelHash };
  const bridge = registerLumiActions({
    ipcMain: { handle: (channel: string, handler: (...argumentsList: any[]) => any) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) },
    isManagementTrusted: (event: unknown) => event === managementEvent,
    trustedPet: (event: unknown) => event === petEvent,
    getPetWindow: () => pet, getManagementWindow: () => management, getToolWindow: () => undefined,
    readModel: () => model, timeoutMs: 100,
  });
  bridges.push(bridge);
  const call = (channel: string, ...parameters: unknown[]) => handlers.get(`nuanban:lumi:${channel}`)!(managementEvent, ...parameters);
  const command = () => pet.webContents.send.mock.calls.at(-1)![1] as { id: string; action: string; modelId: string };
  const complete = (ok: boolean) => handlers.get('nuanban:lumi:complete')!(petEvent, { id: command().id, ok });
  return { bridge, handlers, management, pet, managementEvent, petEvent, call, command, complete, setModel(id: string) { model = { kind: 'model', id }; } };
}

describe('露米页面动作接口与生命周期', () => {
  it('列出真正可播放的动作，映射语义，明确拒绝缺失／无效／已销毁动作', () => {
    const target = { animationNames: ['Idle_Breathe', 'Wave_Gentle'], currentAnimation: 'Idle_Breathe', playAnimation: vi.fn(() => true), stopAnimation: vi.fn() };
    const api = createLumiActions(target);
    expect(api.list().map(action => action.name)).toEqual(['Idle_Breathe', 'Wave_Gentle']);
    expect(api.semantic('greeting')).toMatchObject({ ok: true, action: 'Wave_Gentle', durationMs: 2500, loop: false });
    expect(target.playAnimation).toHaveBeenLastCalledWith('Wave_Gentle');
    expect(api.play('Guide_Point')).toMatchObject({ ok: false, code: 'unsupported' });
    expect(api.play('unknown' as 'Idle_Breathe')).toMatchObject({ ok: false, code: 'invalid' });
    expect(api.semantic('__proto__' as 'idle')).toMatchObject({ ok: false, code: 'invalid' });
    const list = api.list(); list[0].durationMs = 1 as 4000;
    expect(api.list()[0].durationMs).toBe(4000);
    api.stop(); api.dispose(); api.dispose();
    expect(target.stopAnimation).toHaveBeenCalledTimes(2);
    expect(api.state).toEqual({ disposed: true, action: '' });
    expect(api.play('Idle_Breathe')).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('身体单次动作回到呼吸，眨眼独立叠加；停止与销毁清理全部计时器', () => {
    vi.useFakeTimers();
    const root = new Group();
    const clips = [
      new AnimationClip('Idle_Breathe', 4, [new NumberKeyframeTrack('.position[x]', [0, 4], [0, 0])]),
      new AnimationClip('Wave_Gentle', 2.5, [new NumberKeyframeTrack('.position[x]', [0, 1.25, 2.5], [0, 1, 0])]),
      new AnimationClip('Blink_Soft', 0.3, [new NumberKeyframeTrack('.scale[y]', [0, 0.1, 0.3], [1, 0.1, 1])]),
      new AnimationClip('Step_InPlace', 2, [new NumberKeyframeTrack('.position[x]', [0, 1, 2], [0, 0.1, 0])]),
    ];
    const mixer = new AnimationMixer(root);
    const controller = createModelAnimationController(mixer, clips);
    expect(controller.defaultName).toBe('Idle_Breathe');
    controller.play('Wave_Gentle'); mixer.update(1.1);
    const position = root.position.x;
    expect(position).toBeGreaterThan(0.5);
    controller.play('Blink_Soft'); mixer.update(0.1);
    expect(controller.current).toBe('Wave_Gentle');
    expect(root.scale.y).toBeCloseTo(0.1, 4);
    expect(root.position.x).toBeGreaterThan(position);
    mixer.update(1.5); mixer.update(0.2);
    expect(controller.current).toBe('Idle_Breathe');
    expect(root.scale.y).toBeCloseTo(1);
    controller.play('Step_InPlace'); mixer.update(8.5);
    expect(controller.current).toBe('Step_InPlace');
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    controller.stop();
    expect(controller.current).toBe('');
    expect(root.position.x).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    controller.play('Idle_Breathe'); controller.dispose(); controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.play('Wave_Gentle')).toBe(false);
  });

  it('自动眨眼采用自然间隔，播放时不切断身体循环', () => {
    vi.useFakeTimers();
    const root = new Group();
    const mixer = new AnimationMixer(root);
    const controller = createModelAnimationController(mixer, [new AnimationClip('Idle_Breathe', 4, []),
      new AnimationClip('Blink_Soft', 0.3, [new NumberKeyframeTrack('.scale[y]', [0, 0.1, 0.3], [1, 0.1, 1])])]);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    controller.play('Idle_Breathe');
    vi.advanceTimersByTime(3299); mixer.update(0.1); expect(root.scale.y).toBe(1);
    vi.advanceTimersByTime(1); mixer.update(0.1); expect(root.scale.y).toBeCloseTo(0.1, 4);
    expect(controller.current).toBe('Idle_Breathe');
    mixer.update(0.3); mixer.update(0.2);
    expect(root.scale.y).toBeCloseTo(1);
    expect(vi.getTimerCount()).toBe(1);
    controller.dispose();
  });
});

describe('露米原生 IPC 接口', () => {
  it('前后端摘要与动作合同一致，等真实渲染器确认后才报告成功', async () => {
    const current = fixture();
    expect(modelHash).toBe(lumiAnimatedModel.sha256);
    expect(current.call('describe').actions).toEqual(lumiAnimatedModel.actions.map(({ name, durationMs, loop }) => ({ name, durationMs, loop })));
    expect(actions).toHaveLength(7);
    let resolved = false;
    const result = current.call('play', 'Wave_Gentle').then((value: unknown) => { resolved = true; return value; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(current.command()).toMatchObject({ action: 'Wave_Gentle', modelId: modelHash });
    expect(current.complete(true)).toBe(true);
    await expect(result).resolves.toEqual({ ok: true, action: 'Wave_Gentle', durationMs: 2500, loop: false });
    expect(current.management.webContents.send).toHaveBeenCalledWith('nuanban:lumi:played', expect.objectContaining({ action: 'Wave_Gentle' }));
    expect(current.complete(true)).toBe(false);
    const stopped = current.call('stop'); current.complete(true);
    await expect(stopped).resolves.toEqual({ ok: true, action: 'stop' });
    const semantic = current.call('semantic', 'encouraging');
    expect(current.command().action).toBe('Nod_Encourage'); current.complete(true);
    await expect(semantic).resolves.toMatchObject({ ok: true, action: 'Nod_Encourage' });
  });

  it('未知动作、原型键和额外参数不会发到桌宠，不可信来源一律拒绝', () => {
    const current = fixture();
    for (const action of ['missing', 'stop', '__proto__', {}, null]) expect(current.call('play', action)).toMatchObject({ ok: false, code: 'invalid' });
    expect(current.call('play', 'Wave_Gentle', 'extra')).toMatchObject({ ok: false, code: 'invalid' });
    expect(current.call('stop', 'extra')).toMatchObject({ ok: false, code: 'invalid' });
    expect(current.call('semantic', '__proto__')).toMatchObject({ ok: false, code: 'invalid' });
    for (const channel of ['describe', 'play', 'semantic', 'stop']) {
      expect(() => current.handlers.get(`nuanban:lumi:${channel}`)!({}, 'Wave_Gentle', 'extra')).toThrow('不可信');
    }
    expect(() => current.handlers.get('nuanban:lumi:complete')!(current.managementEvent, { id: 'fake', ok: true })).toThrow('仅桌宠');
    expect(current.pet.webContents.send).not.toHaveBeenCalled();
  });

  it('原生窗口隐藏时拒绝动作，确认途中隐藏也不报告成功', async () => {
    const current = fixture();
    const visible = vi.spyOn(current.pet, 'isVisible').mockReturnValue(false);
    expect(current.call('play', 'Wave_Gentle')).toMatchObject({ ok: false, code: 'unavailable' });
    expect(current.pet.webContents.send).not.toHaveBeenCalled();
    visible.mockReturnValue(true);
    const pending = current.call('play', 'Wave_Gentle');
    visible.mockReturnValue(false);
    current.complete(true);
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'unavailable' });
    expect(current.management.webContents.send).not.toHaveBeenCalled();
  });

  it('模型错误、桌宠销毁、拒绝确认、超时均明确失败，不假成功', async () => {
    vi.useFakeTimers();
    const current = fixture();
    current.setModel('personal-model');
    expect(current.call('play', 'Wave_Gentle')).toMatchObject({ ok: false, code: 'unavailable' });
    current.setModel(modelHash);
    const rejected = current.call('play', 'Wave_Gentle'); current.complete(false);
    await expect(rejected).resolves.toMatchObject({ ok: false, code: 'unavailable' });
    const timeout = current.call('play', 'Wave_Gentle');
    await vi.advanceTimersByTimeAsync(101);
    await expect(timeout).resolves.toMatchObject({ ok: false, code: 'unavailable' });
    expect(current.complete(true)).toBe(false);
    vi.spyOn(current.pet, 'isDestroyed').mockReturnValue(true);
    expect(current.call('play', 'Wave_Gentle')).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('切换模型与释放桥会取消等待确认的调用，不遗留计时器或处理器', async () => {
    vi.useFakeTimers();
    const current = fixture();
    const changed = current.call('play', 'Wave_Gentle');
    current.setModel('different'); current.complete(true);
    await expect(changed).resolves.toMatchObject({ ok: false, code: 'unavailable' });
    current.setModel(modelHash);
    const invalidated = current.call('play', 'Idle_Breathe'); current.bridge.invalidate();
    await expect(invalidated).resolves.toMatchObject({ ok: false, code: 'unavailable' });
    const disposed = current.call('play', 'Idle_Breathe'); current.bridge.dispose();
    await expect(disposed).resolves.toMatchObject({ ok: false, code: 'unavailable' });
    expect(vi.getTimerCount()).toBe(0);
    expect(current.handlers.size).toBe(0);
  });
});
