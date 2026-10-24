export type ModelFormat = 'glb' | 'vrm' | 'fbx';
export type BuiltinModelId = 'lumi' | 'lumi-animated-v4' | 'lili' | 'lili-natural-v4';
export interface ModelSummary {
  triangles: number;
  meshes: number;
  bones: number;
  animations: number;
  decodedBytes: number;
  textures: { width: number; height: number }[];
}
export interface ModelSource { format: ModelFormat; bytes: Uint8Array; }
export interface ModelCandidate extends ModelSource { token: string; id: string; fileName: string; summary: ModelSummary; }
export type LocalModel = { kind: 'none' } | (Omit<ModelCandidate, 'token'> & { kind: 'model'; updatedAt: string });
export interface LocalModelBridge {
  read(): Promise<LocalModel>;
  choose(): Promise<ModelCandidate | null>;
  readBuiltin?(id: BuiltinModelId): Promise<ModelSource>;
  applyBuiltin?(id: BuiltinModelId): Promise<LocalModel>;
  apply(token: string): Promise<LocalModel>;
  clear(): Promise<LocalModel>;
  discard(): Promise<boolean>;
  onChanged(listener: (model: LocalModel) => void): () => void;
}

export type CompanionActionName = 'Idle_Breathe' | 'Blink_Soft' | 'Listen_Curious' | 'Wave_Gentle' | 'Nod_Encourage' | 'Guide_Point' | 'Step_InPlace';
export type CompanionActionResult = { ok: true; action: CompanionActionName; loop: boolean; durationMs: number } | { ok: false; code: 'unsupported' | 'invalid' | 'unavailable'; message: string };
export interface LumiAnimationBridge {
  describe(): Promise<{ id: string; version: string; actions: { name: CompanionActionName; durationMs: number; loop: boolean }[] }>;
  play(action: CompanionActionName): Promise<CompanionActionResult>;
  semantic(name: 'idle' | 'listening' | 'greeting' | 'encouraging' | 'guiding' | 'walking' | 'blink'): Promise<CompanionActionResult>;
  stop(): Promise<{ ok: true; action: 'stop' } | { ok: false; code: 'unavailable' | 'invalid'; message: string }>;
  onAction(listener: (event: { action: CompanionActionName | 'stop'; at: string }) => void): () => void;
  onRequest?(listener: (request: { id: string; action: CompanionActionName | 'stop'; modelId: string }) => void): () => void;
  complete?(id: string, ok: boolean): Promise<boolean>;
}
declare global {
  interface Window {
    nuanbanModel?: LocalModelBridge;
    nuanbanLumi?: LumiAnimationBridge;
    nuanbanModelValidator?: { read(): Promise<ModelSource>; complete(result: { summary?: ModelSummary; error?: string }): Promise<boolean> };
  }
}
export function localModelBridge(): LocalModelBridge | undefined {
  const bridge = window.nuanbanModel;
  return bridge && ['read', 'choose', 'apply', 'clear', 'discard', 'onChanged'].every(key => typeof bridge[key as keyof LocalModelBridge] === 'function') ? bridge : undefined;
}
