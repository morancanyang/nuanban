import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Check, FolderOpen, RotateCcw } from 'lucide-react';
import { Badge, Modal } from '../components';
import { localModelBridge } from '../local-model';
import type { LocalModel, ModelCandidate, ModelSource } from '../local-model';
import { liliModel } from './builtin-models';
import { createLiliModel } from './lili-model';
import './model-panel.css';

function ModelPreview({ source, onReady, onError }: { source: ModelSource; onReady: () => void; onError: (message: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let view: { dispose(): void } | undefined;
    void import('./viewer').then(async ({ createModelView }) => {
      if (disposed || !container.current) return;
      const displaySource = 'id' in source && source.id === liliModel.sha256 ? createLiliModel() : source;
      const created = await createModelView(container.current, displaySource, { interactive: true, onError });
      if (disposed) { created.dispose(); return; }
      view = created;
      onReady();
    }).catch(error => { if (!disposed) onError(error instanceof Error ? error.message : '模型预览失败，请重新选择文件'); });
    return () => { disposed = true; view?.dispose(); };
  }, [source, onReady, onError]);
  return <div ref={container} className="model-preview" aria-label="3D 模型预览区域" />;
}

export function LocalModelPanel() {
  const bridge = localModelBridge();
  const [active, setActive] = useState<LocalModel>({ kind: 'none' });
  const [candidate, setCandidate] = useState<ModelCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const source = candidate ?? (active.kind === 'model' ? active : null);
  const previewReady = useCallback(() => setReady(true), []);
  const previewError = useCallback((message: string) => { setError(message); setReady(false); }, []);
  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    let revision = 0;
    const unsubscribe = bridge.onChanged(model => {
      revision++;
      if (!disposed) { setActive(model); setCandidate(null); setReady(false); setNotice(''); setError(''); }
    });
    const initialRevision = revision;
    void bridge.read().then(model => { if (!disposed && revision === initialRevision) setActive(model); })
      .catch(() => { if (!disposed) setError('本机模型状态读取失败，请重新导入或切回原画 / 内置桌宠'); });
    return () => { disposed = true; unsubscribe(); void bridge.discard().catch(() => {}); };
  }, [bridge]);

  async function choose() {
    if (!bridge || busy) return;
    setBusy(true); setReady(false); setCandidate(null); setError(''); setNotice('正在本机隔离检查模型，请稍候；当前桌宠不会改变。');
    try {
      const selected = await bridge.choose();
      setCandidate(selected);
      setNotice(selected ? '文件检查已通过。请旋转查看，满意后亲手确认，才会替换独立桌宠。' : '已取消选择，当前桌宠未更换。');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '模型导入失败，原桌宠未替换'); setNotice(''); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!bridge || !candidate || !ready || busy) return;
    setBusy(true); setError('');
    try {
      const model = await bridge.apply(candidate.token);
      setActive(model); setCandidate(null); setNotice('已设为独立 3D 桌宠。关闭管理窗口仍会显示，重启后可恢复。');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '模型保存失败，原桌宠未替换'); }
    finally { setBusy(false); }
  }
  async function clear() {
    if (!bridge || busy) return;
    setBusy(true); setError('');
    try {
      setActive(await bridge.clear()); setCandidate(null); setConfirmClear(false);
      await bridge.discard();
      setNotice('已切回之前的原画或内置桌宠，保存的画稿没有删除。');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '切回原画失败，请重试'); }
    finally { setBusy(false); }
  }
  return <section className="panel local-model-panel" aria-labelledby="local-model-title">
    <div className="local-model-heading"><div><span className="eyebrow">本机导入 · 不上传云端</span><h2 id="local-model-title"><Box size={24} aria-hidden="true" />让你的 3D 伙伴，来到桌面。</h2></div><Badge tone={bridge ? 'sage' : 'soft'}>{bridge ? '电脑端本地功能' : '仅电脑客户端可用'}</Badge></div>
    <p className="local-model-intro">选择模型 → 安全检查 → 旋转预览 → 确认设为独立桌宠。支持 GLB、VRM 和 FBX；只播放模型自带动画，不会自动补齐动作。</p>
    <div className="local-model-layout">
      <div className="local-model-stage">{source ? <ModelPreview source={source} onReady={previewReady} onError={previewError} /> : <div className="model-empty"><Box size={56} strokeWidth={1} aria-hidden="true" /><strong>先看看，再决定</strong><p>仅选择和预览，不会更换你的桌宠。</p></div>}<span className="model-stage-label">{candidate ? '尚未应用 · 拖动旋转，滚轮缩放' : active.kind === 'model' ? '当前 3D 模型 · 拖动旋转查看' : '等待你选择本地模型'}</span></div>
      <div className="local-model-details">
        <p className="model-active-label">当前独立桌宠：{active.kind === 'model' ? active.fileName : '原画 / 内置形象'}</p>
        {source && <div className="model-file-details"><strong>{source.fileName}</strong><dl><div><dt>格式</dt><dd>{source.format.toUpperCase()}</dd></div><div><dt>三角面</dt><dd>{source.summary.triangles.toLocaleString()}</dd></div><div><dt>骨骼</dt><dd>{source.summary.bones}</dd></div><div><dt>自带动画</dt><dd>{source.summary.animations} 段</dd></div></dl><p>{source.summary.animations ? '优先播放 idle 待机动画，没有时播放第一段；不代表所有教学动作兼容。' : '此模型只作静态 3D 展示，不会伪装成已生成可动桌宠。'}</p></div>}
        <p className="model-limits">单文件不超过 50 MiB、10 万三角面，纹理不超过 2048 × 2048，且必须内嵌。FBX 支持 7.4 / 7.5，VRM 支持 0.x / 1.0；暂不支持 Draco、Meshopt 或 KTX 压缩。</p>
        {!bridge && <p className="model-local-note">浏览器和 Android 不开放此入口，请在电脑客户端导入。不会收取模型文件或要求上传。</p>}
        <div className="model-actions"><button className="button secondary" disabled={!bridge || busy} onClick={() => void choose()}><FolderOpen size={19} />{busy ? '正在本机处理…' : '选择本地 3D 模型'}</button><button className="button primary" disabled={!candidate || !ready || busy} onClick={() => void apply()}><Check size={19} />确认设为独立桌宠</button>{active.kind === 'model' && <button className="button secondary" disabled={busy} onClick={() => setConfirmClear(true)}><RotateCcw size={18} />切回原画 / 内置桌宠</button>}</div>
        {notice && <p className="model-notice" role="status">{notice}</p>}{error && <p className="inline-error" role="alert">{error}</p>}
      </div>
    </div>
    <Modal open={confirmClear} onOpenChange={open => { if (!busy) setConfirmClear(open); }} title="切回之前的原画或内置桌宠？" description="仅停用当前 3D 模型，不删除保存的画稿或你选取的源模型文件。"><div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setConfirmClear(false)}>暂不更改</button><button className="button primary" disabled={busy} onClick={() => void clear()}>确认切回</button></div></Modal>
  </section>;
}
