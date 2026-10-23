import { useEffect, useRef, useState } from 'react';
import { Box, Check, Monitor, RotateCcw, Sparkles } from 'lucide-react';
import { Badge, Modal } from '../components';
import { localModelBridge } from '../local-model';
import { showBrowserCompanion } from '../browser-companion';
import { isBuiltinLumi, loadLumiModel, lumiModel } from './builtin-models';
import type { createModelView } from './viewer';
import './lumi-card.css';

export function LumiCard() {
  const bridge = localModelBridge();
  const stage = useRef<HTMLDivElement>(null);
  const view = useRef<Awaited<ReturnType<typeof createModelView>> | undefined>(undefined);
  const [preview, setPreview] = useState(false);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(false);
  const [action, setAction] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    let revision = 0;
    const update = (model: Awaited<ReturnType<typeof bridge.read>>) => {
      if (!disposed) setActive(model.kind === 'model' && isBuiltinLumi(model.id));
    };
    const unsubscribe = bridge.onChanged(model => { revision++; update(model); });
    const initialRevision = revision;
    void bridge.read().then(model => { if (revision === initialRevision) update(model); })
      .catch(() => { if (!disposed) setError('当前桌宠状态读取失败；你仍可预览，稍后再试调用。'); });
    return () => { disposed = true; unsubscribe(); };
  }, [bridge]);

  useEffect(() => {
    setReady(false); setAction('');
    view.current?.dispose();
    view.current = undefined;
    if (!preview) return;
    const controller = new AbortController();
    let disposed = false;
    setError('');
    const fail = (message: string) => { if (!disposed) { setReady(false); setError(message); } };
    void Promise.resolve(import('./viewer')).then(async ({ createModelView }) => {
      if (disposed || !stage.current) return;
      controller.signal.throwIfAborted();
      const source = await loadLumiModel(controller.signal);
      if (disposed || !stage.current) return;
      const created = await createModelView(stage.current, source, {
        interactive: true,
        onError: fail,
        onAnimationChange: name => { if (!disposed) setAction(name); },
      });
      if (disposed) { created.dispose(); return; }
      view.current = created;
      setReady(true);
    }).catch(failure => { if (!disposed) fail(failure instanceof Error ? failure.message : '小猫预览未能打开，请重试。'); });
    return () => { disposed = true; controller.abort(); view.current?.dispose(); view.current = undefined; };
  }, [preview]);

  async function apply() {
    if (busy) return;
    if (!bridge?.applyBuiltin) {
      showBrowserCompanion({ kind: 'lumi', label: '露米', imageUrl: lumiModel.posterUrl });
      setConfirm(false);
      setNotice('露米已显示在当前页面；系统悬浮桌宠仍需使用桌面客户端。');
      return;
    }
    setBusy(true); setError(''); setNotice('正在本机检查并唤醒小猫…');
    try {
      const model = await bridge.applyBuiltin('lumi');
      if (model.kind !== 'model' || model.id !== lumiModel.sha256) throw new Error('小猫资源状态未确认，请重试。');
      setActive(true); setConfirm(false);
      setNotice('原版小猫已保存并调用到桌面。重启后会恢复，以后也可在这里再次召唤。');
    } catch (failure) {
      setNotice(''); setError(failure instanceof Error ? failure.message : '小猫调用未完成，请重试。');
    } finally { setBusy(false); }
  }

  return <section className="panel lumi-card" aria-labelledby="lumi-title">
    <div className="lumi-stage">
      <span className="lumi-stage-tag"><Sparkles size={14} aria-hidden="true" />本机珍藏 · 001</span>
      <div ref={stage} className="lumi-model-surface" aria-label="露米小猫 3D 预览区域" />
      {!ready && <img className="lumi-poster" src={lumiModel.posterUrl} alt="露米魔法小猫：奶油色毛发、紫色披风，手持星星魔杖" width="1000" height="1125" />}
      <span className="lumi-stage-caption">{ready ? '拖动转一转 · 滚轮缩放' : preview && !error ? '正在加载原版小猫 3D 模型…' : '一只把陪伴变成小魔法的猫'}</span>
    </div>
    <div className="lumi-details">
      <div className="lumi-meta"><span className="eyebrow">原创三维伙伴 / MAGICAL KITTEN</span><Badge tone={active ? 'sage' : 'soft'}>{active ? '当前 3D 桌宠' : '已内置 · 无需导入'}</Badge></div>
      <h2 id="lumi-title">露米 <span>Lumi</span><Sparkles size={25} aria-hidden="true" /></h2>
      <p className="lumi-description">带着星星魔杖，陪你慢慢想、轻轻笑。使用原版 Blender 小猫转换的实时模型，保留蓝眼睛、紫金披风和斜挎包，不再使用简化替代造型。</p>
      <div className="lumi-facts"><span><Box size={16} aria-hidden="true" />原版造型 · 可旋转</span><span>轻微待机 · 尚未绑定表情</span><span>无需在线下载 · v{lumiModel.version}</span></div>
      <fieldset className="lumi-action-picker"><legend>和露米打个招呼</legend><div>{lumiModel.actions.map(item => <button type="button" key={item.name} disabled={!ready} aria-pressed={action === item.name} onClick={() => view.current?.playAnimation(item.name)}>{item.label}</button>)}</div></fieldset>
      <div className="lumi-buttons">
        <button type="button" className="button secondary" disabled={busy} onClick={() => setPreview(previous => !previous)}>{preview ? <RotateCcw size={18} /> : <Box size={18} />}{preview ? '收起 3D 预览' : '预览 3D 与动作'}</button>
        <button type="button" className="button primary" disabled={busy} onClick={() => active ? void apply() : setConfirm(true)}><Monitor size={18} />{busy ? '正在唤醒…' : active ? '再次召唤桌宠' : bridge?.applyBuiltin ? '设为桌面小伙伴' : '在本页显示露米'}</button>
      </div>
      <p className="lumi-local-note"><Check size={15} aria-hidden="true" />只在本机保存，不上传模型。预览不会替换当前伙伴。</p>
      {!bridge?.applyBuiltin && <p className="lumi-platform-note">手机浏览器可在当前页面显示露米；保存为系统桌宠请使用更新后的电脑客户端。</p>}
      {notice && <p className="lumi-notice" role="status">{notice}</p>}
      {error && !confirm && <p className="inline-error" role="alert">{error}</p>}
    </div>
    <Modal open={confirm} onOpenChange={open => { if (!busy) setConfirm(open); }} title={bridge?.applyBuiltin ? '让露米来到桌面？' : '在当前页面显示露米？'} description={bridge?.applyBuiltin ? '确认后将小猫模型保存在本机并设为独立桌宠。现有原画不会删除，星云或栗栗形象会暂停；可在下方切回原画 / 内置桌宠。' : '手机浏览器不能替换系统桌宠；确认后会在当前页面显示露米，不会上传模型或启动屏幕、麦克风采集。'}>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setConfirm(false)}>先不更换</button><button type="button" className="button primary" disabled={busy} onClick={() => void apply()}>{busy ? '正在检查并保存…' : bridge?.applyBuiltin ? '确认保存并调用小猫' : '确认在本页显示露米'}</button></div>
    </Modal>
  </section>;
}
