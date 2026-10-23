import type { ModelSource } from '../local-model';
import { localModelBridge } from '../local-model';

const root = `${import.meta.env.BASE_URL}models/lumi/`;

export const lumiModel = {
  id: 'lumi',
  name: '露米 Lumi',
  version: '2.0.0',
  fileName: 'Lumi_Magical_Kitten.glb',
  sha256: '3ec165a265d28d00bec78c6262d4909542d9d5e8759759cc00cdb07fd7f95f90',
  previousSha256: '7fbe808f7de41e0e15181a0094038f79d6168ea99888dc8947846a2f70cf019b',
  modelUrl: `${root}Lumi_Magical_Kitten.glb`,
  posterUrl: `${root}poster.png`,
  manifestUrl: `${root}character_manifest.json`,
  actions: [
    { name: 'idle', label: '陪伴' },
  ],
} as const;

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

async function loadBuiltinModel(model: typeof lumiModel | typeof liliModel, signal?: AbortSignal): Promise<ModelSource> {
  signal?.throwIfAborted();
  const bridge = localModelBridge();
  const label = model.id === 'lili' ? '小鹿' : '小猫';
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
  const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== model.sha256) throw new Error(`${label}资源校验失败，请重新构建或安装客户端。`);
  return { format: 'glb', bytes };
}

export const loadLumiModel = (signal?: AbortSignal): Promise<ModelSource> => loadBuiltinModel(lumiModel, signal);
export const loadLiliModel = (signal?: AbortSignal): Promise<ModelSource> => loadBuiltinModel(liliModel, signal);
