export type ModelFormat = 'glb' | 'vrm' | 'fbx';
export type BuiltinModelId = 'lumi' | 'lili' | 'lili-natural-v4';
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
declare global {
  interface Window {
    nuanbanModel?: LocalModelBridge;
    nuanbanModelValidator?: { read(): Promise<ModelSource>; complete(result: { summary?: ModelSummary; error?: string }): Promise<boolean> };
  }
}
export function localModelBridge(): LocalModelBridge | undefined {
  const bridge = window.nuanbanModel;
  return bridge && ['read', 'choose', 'apply', 'clear', 'discard', 'onChanged'].every(key => typeof bridge[key as keyof LocalModelBridge] === 'function') ? bridge : undefined;
}
