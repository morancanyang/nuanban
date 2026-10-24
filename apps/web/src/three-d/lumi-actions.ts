import type { CompanionActionName, CompanionActionResult } from '../local-model';
import { lumiAnimatedModel } from './builtin-models';

export type LumiSemantic = 'idle' | 'listening' | 'greeting' | 'encouraging' | 'guiding' | 'walking' | 'blink';
const semantics: Record<LumiSemantic, CompanionActionName> = {
  idle: 'Idle_Breathe', listening: 'Listen_Curious', greeting: 'Wave_Gentle', encouraging: 'Nod_Encourage',
  guiding: 'Guide_Point', walking: 'Step_InPlace', blink: 'Blink_Soft',
};
export interface LumiActionTarget {
  readonly animationNames: string[];
  readonly currentAnimation: string;
  playAnimation(name: string): boolean;
  stopAnimation(): void;
}

export function createLumiActions(target: LumiActionTarget) {
  let disposed = false;
  const available = new Set(target.animationNames);
  function play(name: CompanionActionName): CompanionActionResult {
    if (disposed) return { ok: false, code: 'unavailable', message: '露米动作接口已销毁' };
    const action = lumiAnimatedModel.actions.find(item => item.name === name);
    if (!action) return { ok: false, code: 'invalid', message: '未知露米动作' };
    if (!available.has(name) || !target.playAnimation(name)) return { ok: false, code: 'unsupported', message: '当前模型没有绑定这个动作' };
    return { ok: true, action: name, durationMs: action.durationMs, loop: action.loop };
  }
  return {
    list: () => lumiAnimatedModel.actions.filter(item => available.has(item.name)).map(item => ({ ...item })),
    play,
    semantic(name: LumiSemantic): CompanionActionResult {
      return Object.hasOwn(semantics, name) ? play(semantics[name]) : { ok: false, code: 'invalid', message: '未知露米语义' };
    },
    stop() { if (!disposed) target.stopAnimation(); },
    get state() { return { disposed, action: disposed ? '' : target.currentAnimation }; },
    dispose() { if (!disposed) { target.stopAnimation(); disposed = true; } },
  };
}
