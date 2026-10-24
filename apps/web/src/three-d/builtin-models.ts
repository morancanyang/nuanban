import type { BuiltinModelId, ModelSource } from '../local-model';
import { localModelBridge } from '../local-model';

const root = `${import.meta.env.BASE_URL}models/lumi/`;

export const lumiModel = {
  id: 'lumi',
  name: '露米 Lumi',
  version: '2.1.0',
  fileName: 'Lumi_Magical_Kitten.glb',
  sha256: '4cee02df06e168eb99612ab5d807a3efe6025d14c7dfec516616ff8825b0e9b3',
  previousSha256s: [
    '7fbe808f7de41e0e15181a0094038f79d6168ea99888dc8947846a2f70cf019b',
    '3ec165a265d28d00bec78c6262d4909542d9d5e8759759cc00cdb07fd7f95f90',
  ],
  modelUrl: `${root}Lumi_Magical_Kitten.glb`,
  posterUrl: `${root}poster.png`,
  manifestUrl: `${root}character_manifest.json`,
  actions: [
    { name: 'idle', label: '陪伴' },
  ],
} as const;

export const lumiAnimatedModel = {
  id: 'lumi-animated-v4',
  name: '露米 Lumi · 自然动作版',
  version: '4.1.0',
  fileName: 'Lumi_Natural_v4_Animated.glb',
  sha256: '14c6ac8e79fb51a1c4c7be44b63a4e78fdbf77599b93b7f90695f4d8fa782ead',
  modelUrl: `${import.meta.env.BASE_URL}models/lumi-animated-v4/Lumi_Natural_v4_Animated.glb`,
  posterUrl: `${import.meta.env.BASE_URL}models/lumi-animated-v4/poster.png`,
  manifestUrl: `${import.meta.env.BASE_URL}models/lumi-animated-v4/character_manifest.json`,
  capabilities: { static: false, rigged: true, animations: true, mobileTested: false },
  actions: [
    { name: 'Idle_Breathe', label: '呼吸陪伴', durationMs: 4000, loop: true },
    { name: 'Blink_Soft', label: '轻柔眨眼', durationMs: 300, loop: false },
    { name: 'Listen_Curious', label: '好奇倾听', durationMs: 3000, loop: false },
    { name: 'Wave_Gentle', label: '轻轻招手', durationMs: 2500, loop: false },
    { name: 'Nod_Encourage', label: '点头回应', durationMs: 2000, loop: false },
    { name: 'Guide_Point', label: '温柔指引', durationMs: 3000, loop: false },
    { name: 'Step_InPlace', label: '原地轻踏', durationMs: 2000, loop: true },
  ],
} as const;

export function isBuiltinLumi(id: string): boolean {
  return id === lumiModel.sha256 || id === lumiAnimatedModel.sha256 || lumiModel.previousSha256s.some(hash => hash === id);
}

export const liliModel = {
  id: 'lili',
  name: '栗栗 Lili',
  version: '2.0.0',
  fileName: 'Lili_Independent_Deer.glb',
  sha256: '8b5b3adce1d8995a0c754aed5d89360ec56fb35f7cf6d570052594de508fb35c',
  previousSha256: '35c40f0c66b08fab749f7b711e97dc12dfd911003f375b9a77445c16928d7327',
  modelUrl: `${import.meta.env.BASE_URL}models/lili/Lili_Independent_Deer.glb`,
  posterUrl: `${import.meta.env.BASE_URL}models/lili/poster.png`,
  manifestUrl: `${import.meta.env.BASE_URL}models/lili/character_manifest.json`,
} as const;

export const liliNaturalModel = {
  id: 'lili-natural-v4',
  name: '栗栗 Lili · 自然精修 v4',
  version: '4.0.0-preview.2',
  fileName: 'Lili_Natural_v4.glb',
  sha256: '331f66f6748bf78a390f60a2092c8ce884113698418087d0881cbe1f6feacd8f',
  sourceSha256: '02a69fd97777769544955586eec861396438444e2a17fc89d67ab702d5d3351b',
  modelUrl: `${import.meta.env.BASE_URL}models/lili-natural-v4/Lili_Natural_v4.glb`,
  posterUrl: `${import.meta.env.BASE_URL}models/lili-natural-v4/poster.png`,
  manifestUrl: `${import.meta.env.BASE_URL}models/lili-natural-v4/character_manifest.json`,
  capabilities: { static: false, rigged: true, animations: true, mobileTested: false },
  actions: [
    { name: 'idle', label: '自然待机' },
    { name: 'blink', label: '轻轻眨眼' },
    { name: 'look', label: '左右看看' },
    { name: 'wave', label: '轻轻招手' },
    { name: 'nod', label: '点头回应' },
  ],
} as const;

async function loadBuiltinModel(model: { id: BuiltinModelId; sha256: string; modelUrl: string }, signal?: AbortSignal): Promise<ModelSource> {
  signal?.throwIfAborted();
  const bridge = localModelBridge();
  const label = model.id.startsWith('lumi') ? '小猫' : '小鹿';
  let bytes: Uint8Array<ArrayBuffer>;
  if (bridge?.readBuiltin) {
    const source = await bridge.readBuiltin(model.id);
    if (source.format !== 'glb') throw new Error(`${label}模型格式不正确，请更新客户端。`);
    bytes = new Uint8Array(source.bytes);
  } else {
    const response = await fetch(model.modelUrl, { signal, credentials: 'omit' });
    if (!response.ok) throw new Error(`${label}模型未能读取，请检查客户端资源后重试。`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  signal?.throwIfAborted();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  signal?.throwIfAborted();
  const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== model.sha256) throw new Error(`${label}资源校验失败，请重新构建或安装客户端。`);
  return { format: 'glb', bytes };
}

export const loadLumiModel = (signal?: AbortSignal): Promise<ModelSource> => loadBuiltinModel(lumiModel, signal);
export const loadLumiAnimatedModel = (signal?: AbortSignal): Promise<ModelSource> => loadBuiltinModel(lumiAnimatedModel, signal);
export const loadLiliModel = (signal?: AbortSignal): Promise<ModelSource> => loadBuiltinModel(liliModel, signal);
export const loadLiliNaturalModel = (signal?: AbortSignal): Promise<ModelSource> => loadBuiltinModel(liliNaturalModel, signal);
