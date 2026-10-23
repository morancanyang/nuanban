import { useEffect, useRef, useState } from 'react';
import { Box, Leaf, Monitor, RotateCcw } from 'lucide-react';
import { Badge, Modal } from '../components';
import { localModelBridge } from '../local-model';
import { showBrowserCompanion } from '../browser-companion';
import { liliModel } from './builtin-models';
import { createLiliModel } from './lili-model';
import type { createModelView } from './viewer';
import './lili-card.css';

export function LiliCard() {
  const bridge = localModelBridge();
  const stage = useRef<HTMLDivElement>(null);
  const view = useRef<Awaited<ReturnType<typeof createModelView>> | undefined>(undefined);
  const [preview, setPreview] = useState(false);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    let revision = 0;
    const update = (model: Awaited<ReturnType<typeof bridge.read>>) => {
      if (!disposed) setActive(model.kind === 'model' && model.id === liliModel.sha256);
    };
    const unsubscribe = bridge.onChanged(model => { revision++; update(model); });
    const initialRevision = revision;
    void bridge.read().then(model => { if (revision === initialRevision) update(model); })
      .catch(() => { if (!disposed) setError('当前桌宠状态读取失败；你仍可预览，稍后再试调用。'); });
    return () => { disposed = true; unsubscribe(); };
  }, [bridge]);

  useEffect(() => {
    setReady(false);
    if (!preview) return;
    let disposed = false;
    setError('');
    const fail = (message: string) => { if (!disposed) { setReady(false); setError(message); } };
    void import('./viewer').then(async ({ createModelView }) => {
      if (disposed || !stage.current) return;
      const created = await createModelView(stage.current, createLiliModel(), { interactive: true, onError: fail });
      if (disposed) { created.dispose(); return; }
      view.current = created;
      setReady(true);
    }).catch(failure => fail(failure instanceof Error ? failure.message : '小鹿预览未能打开，请重试。'));
    return () => { disposed = true; view.current?.dispose(); view.current = undefined; };
  }, [preview]);

  async function summon() {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (!bridge?.applyBuiltin) {
        showBrowserCompanion({ kind: 'lili', label: '栗栗', imageUrl: liliModel.posterUrl });
        setConfirm(false);
        setNotice('栗栗已显示在当前页面；这里使用透明立绘，系统 3D 桌宠仍需使用桌面客户端。');
        return;
      }
      const model = await bridge.applyBuiltin('lili');
      if (model.kind !== 'model' || model.id !== liliModel.sha256) throw new Error('小鹿资源状态未确认，请重试。');
      setActive(true); setConfirm(false);
      setNotice('客户端建模小鹿已保存并调用到桌面。重启后会恢复，也可在这里再次召唤。');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '栗栗未能显示，原桌宠未替换。请重试。');
    } finally { setBusy(false); }
  }

  return <section className="panel lili-companion" aria-labelledby="lili-title">
    <div className="lili-companion-stage">
      <span className="companion-number"><Leaf size={15} aria-hidden="true" />本机伙伴 · 栗栗</span>
      <div ref={stage} className="lili-model-surface" aria-label="栗栗小鹿 3D 预览区域" />
      {!ready && <img className="lili-model-poster" src={liliModel.posterUrl} alt="栗栗小鹿三维参考立绘：琥珀大眼、分叉鹿角与橙黄条纹围巾" width="1000" height="1250" />}
      <span className="lili-stage-caption">{ready ? '拖动转一转 · 滚轮缩放' : preview && !error ? '正在生成客户端 3D 模型…' : '围一条暖围巾，陪你慢慢来'}</span>
    </div>
    <div className="lili-companion-details">
      <span className="eyebrow">森林里的小伙伴 / LITTLE DEER</span>
      <h2 id="lili-title">栗栗 <span>Lili</span></h2>
      <p className="lili-companion-description">琥珀色大眼睛、奶油色小肚子，围着橙黄条纹围巾。栗栗的新形象由客户端实时生成，不需要打开 Blender。</p>
      <Badge tone="sage">{active ? '当前 3D 桌宠' : '已内置 · 本地 3D 模型'}</Badge>
      <dl className="lili-companion-facts">
        <div><dt>建模方式</dt><dd>客户端实时建模 · 可旋转</dd></div>
        <div><dt>角色类型</dt><dd>静态 3D 模型 · 无内置动画</dd></div>
        <div><dt>细节刻画</dt><dd>分层眼睛 · 分叉鹿角 · 针织围巾</dd></div>
        <div><dt>运行方式</dt><dd>本机生成 · 无需上传</dd></div>
      </dl>
      <p className="companion-boundary">只包含小鹿本体，没有背景或地面。此版支持三维旋转，不包含动作动画；预览不会替换当前桌宠。</p>
      <div className="lili-model-buttons">
        <button className="button secondary" type="button" disabled={busy} onClick={() => setPreview(value => !value)}>{preview ? <RotateCcw size={18} aria-hidden="true" /> : <Box size={18} aria-hidden="true" />}{preview ? '收起 3D 预览' : '预览小鹿 3D 模型'}</button>
        <button className="button primary" type="button" disabled={busy} onClick={() => { setError(''); setConfirm(true); }}><Monitor size={19} aria-hidden="true" />{busy ? '正在请栗栗陪伴…' : bridge?.applyBuiltin ? active ? '再次召唤栗栗' : '请栗栗到桌面' : '在本页显示栗栗'}</button>
      </div>
      {!bridge?.applyBuiltin && <p className="small-note">浏览器可旋转预览三维模型，页面陪伴使用透明立绘；替换系统悬浮桌宠请使用更新后的电脑客户端。</p>}
      {notice && <p className="companion-notice" role="status">{notice}</p>}
      {error && !confirm && <p className="inline-error" role="alert">{error}</p>}
    </div>
    <Modal open={confirm} onOpenChange={open => { if (!busy) setConfirm(open); }} title={bridge?.applyBuiltin ? '确认将栗栗请到桌面？' : '在当前页面显示栗栗？'} description={bridge?.applyBuiltin ? '确认后校验并保存本机小鹿资源，切换为客户端实时生成的 3D 桌宠。现有原画不会删除，不会上传资源或启动屏幕、麦克风采集。' : '浏览器不能替换系统桌宠；确认后在当前页面显示栗栗透明立绘。不会上传角色资源，也不会启动屏幕或麦克风采集。'}>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="modal-actions"><button className="button secondary" type="button" disabled={busy} onClick={() => setConfirm(false)}>先不更换</button><button className="button primary" type="button" disabled={busy} onClick={() => void summon()}>{busy ? '正在检查并保存…' : bridge?.applyBuiltin ? '确认切换并显示栗栗' : '确认在本页显示栗栗'}</button></div>
    </Modal>
  </section>;
}
