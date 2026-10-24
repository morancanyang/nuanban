import { useEffect, useRef, useState } from 'react';
import { Box, Leaf, Monitor, RotateCcw } from 'lucide-react';
import { Badge, Modal } from '../components';
import { localModelBridge } from '../local-model';
import { showBrowserCompanion } from '../browser-companion';
import { liliModel, liliNaturalModel, loadLiliModel, loadLiliNaturalModel } from './builtin-models';
import type { createModelView } from './viewer';
import './lili-card.css';

export function LiliCard() {
  const bridge = localModelBridge();
  const stage = useRef<HTMLDivElement>(null);
  const view = useRef<Awaited<ReturnType<typeof createModelView>> | undefined>(undefined);
  const [preview, setPreview] = useState(false);
  const [ready, setReady] = useState(false);
  const [action, setAction] = useState('');
  const [activeModelId, setActiveModelId] = useState('');
  const [variant, setVariant] = useState('original');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const natural = variant === 'natural-v4';
  const selectedModel = natural ? liliNaturalModel : liliModel;
  const active = activeModelId === selectedModel.sha256 || !natural && activeModelId === liliModel.previousSha256;

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    let revision = 0;
    const update = (model: Awaited<ReturnType<typeof bridge.read>>) => {
      if (!disposed) setActiveModelId(model.kind === 'model' ? model.id : '');
    };
    const unsubscribe = bridge.onChanged(model => { revision++; update(model); });
    const initialRevision = revision;
    void bridge.read().then(model => { if (revision === initialRevision) update(model); })
      .catch(() => { if (!disposed) setError('当前桌宠状态读取失败；你仍可预览，稍后再试调用。'); });
    return () => { disposed = true; unsubscribe(); };
  }, [bridge]);

  useEffect(() => {
    setReady(false); setAction('');
    if (!preview) return;
    const controller = new AbortController();
    let disposed = false;
    setError('');
    const fail = (message: string) => { if (!disposed) { setReady(false); setError(message); } };
    void import('./viewer').then(async ({ createModelView }) => {
      if (disposed || !stage.current) return;
      const source = natural ? await loadLiliNaturalModel(controller.signal) : await loadLiliModel(controller.signal);
      if (disposed || !stage.current) return;
      const created = await createModelView(stage.current, source, {
        interactive: true, onError: fail,
        onAnimationChange: name => { if (!disposed) setAction(name); },
      });
      if (disposed) { created.dispose(); return; }
      view.current = created;
      setReady(true);
    }).catch(failure => fail(failure instanceof Error ? failure.message : '小鹿预览未能打开，请重试。'));
    return () => { disposed = true; controller.abort(); view.current?.dispose(); view.current = undefined; };
  }, [preview, natural]);

  async function summon() {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (!bridge?.applyBuiltin) {
        showBrowserCompanion({ kind: 'lili', label: '栗栗', imageUrl: selectedModel.posterUrl });
        setConfirm(false);
        setNotice('栗栗已显示在当前页面；这里使用透明立绘，系统 3D 桌宠仍需使用桌面客户端。');
        return;
      }
      const model = await bridge.applyBuiltin(selectedModel.id);
      if (model.kind !== 'model' || model.id !== selectedModel.sha256) throw new Error('小鹿资源状态未确认，请重试。');
      setActiveModelId(model.id); setConfirm(false);
      setNotice(`${natural ? '自然精修 v4 候选版' : '原版小鹿'} 3D 模型已保存并调用到桌面。重启后会恢复，也可在这里再次召唤。`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '栗栗未能显示，原桌宠未替换。请重试。');
    } finally { setBusy(false); }
  }

  return <section className="panel lili-companion" aria-labelledby="lili-title">
    <div className="lili-companion-stage">
      <span className="companion-number"><Leaf size={15} aria-hidden="true" />本机伙伴 · 栗栗</span>
      <div ref={stage} className="lili-model-surface" aria-label="栗栗小鹿 3D 预览区域" />
      {!ready && <img className="lili-model-poster" src={selectedModel.posterUrl} alt={natural ? '栗栗小鹿自然精修 v4 参考立绘：柔和五官、针织围巾与手提灯笼' : '栗栗小鹿三维参考立绘：琥珀大眼、分叉鹿角与橙黄条纹围巾'} width="1000" height="1250" />}
      <span className="lili-stage-caption">{ready ? '拖动转一转 · 滚轮缩放' : preview && !error ? `正在加载${natural ? '自然精修 v4' : '原版'} 3D 模型…` : '围一条暖围巾，陪你慢慢来'}</span>
    </div>
    <div className="lili-companion-details">
      <span className="eyebrow">森林里的小伙伴 / LITTLE DEER</span>
      <h2 id="lili-title">栗栗 <span>Lili</span></h2>
      <p className="lili-companion-description">{natural ? '自然精修候选版：更柔和的五官、厚实耳朵、蓬松围巾与手提灯笼。从已审阅的 Blender v4 模型转换为独立 GLB，运行时不需要打开 Blender。' : '琥珀色大眼睛、奶油色小肚子，围着橙黄条纹围巾。直接加载参考图对应的 Blender 原版模型，保留圆润比例和细密针脚，运行时不需要打开 Blender。'}</p>
      <label className="lili-model-variant">模型版本<select value={variant} disabled={busy} onChange={event => { setVariant(event.target.value); setConfirm(false); setNotice(''); setError(''); }}>
        <option value="original">原版 · 默认 / 可切回</option>
        <option value="natural-v4">自然精修 v4 · 候选版</option>
      </select></label>
      <Badge tone="sage">{active ? '当前 3D 桌宠' : natural ? '候选版 · 不自动替换' : '已内置 · 本地 3D 模型'}</Badge>
      <dl className="lili-companion-facts">
        <div><dt>建模方式</dt><dd>{natural ? 'Blender v4 精修 · 本机 3D 渲染' : 'Blender 原版 · 本机 3D 渲染'}</dd></div>
        <div><dt>角色类型</dt><dd>{natural ? '骨骼与眼睑形变 · 5 段基础动作' : '静态 3D 模型 · 无内置动画'}</dd></div>
        <div><dt>细节刻画</dt><dd>琥珀虹膜 · 短绒毛 · 细密针织</dd></div>
        <div><dt>运行方式</dt><dd>本地加载 · 无需上传</dd></div>
      </dl>
      <p className="companion-boundary">只包含小鹿本体，没有背景或地面。{natural ? '已绑定自然待机、眨眼、转头、招手和点头，围巾与灯笼做轻微跟随摆动；' : '此版支持三维旋转，不包含动作动画；'}预览不会替换当前桌宠。短绒与材质已适配实时渲染，细腻度与离线参考图仍有差别。</p>
      {natural && <>
        <fieldset className="lili-action-picker"><legend>和栗栗打个招呼</legend><div>{liliNaturalModel.actions.map(item => <button type="button" key={item.name} disabled={!ready} aria-pressed={action === item.name} onClick={() => view.current?.playAnimation(item.name)}>{item.label}</button>)}</div></fieldset>
        <p className="small-note">v4 已绑定 18 根骨骼与独立眼睑眨眼；未验证手机性能与 Android 系统悬浮桌宠接入。电影级离线打光不随 GLB 导出；旧版电脑客户端需要更新后才能调用此候选模型，失败时可选择原版。</p>
      </>}
      <div className="lili-model-buttons">
        <button className="button secondary" type="button" disabled={busy} onClick={() => setPreview(value => !value)}>{preview ? <RotateCcw size={18} aria-hidden="true" /> : <Box size={18} aria-hidden="true" />}{preview ? '收起 3D 预览' : '预览小鹿 3D 模型'}</button>
        <button className="button primary" type="button" disabled={busy} onClick={() => { setError(''); setConfirm(true); }}><Monitor size={19} aria-hidden="true" />{busy ? '正在请栗栗陪伴…' : bridge?.applyBuiltin ? active ? '再次召唤栗栗' : '请栗栗到桌面' : '在本页显示栗栗'}</button>
      </div>
      {!bridge?.applyBuiltin && <p className="small-note">浏览器可旋转预览三维模型，页面陪伴使用透明立绘；替换系统悬浮桌宠请使用更新后的电脑客户端。</p>}
      {notice && <p className="companion-notice" role="status">{notice}</p>}
      {error && !confirm && <p className="inline-error" role="alert">{error}</p>}
    </div>
    <Modal open={confirm} onOpenChange={open => { if (!busy) setConfirm(open); }} title={bridge?.applyBuiltin ? '确认将栗栗请到桌面？' : '在当前页面显示栗栗？'} description={bridge?.applyBuiltin ? `确认后校验并保存${natural ? '自然精修 v4 候选版' : '参考图对应的原版'}小鹿模型，切换为本机渲染的 3D 桌宠。现有原画不会删除，不会上传资源或启动屏幕、麦克风采集。` : '浏览器不能替换系统桌宠；确认后在当前页面显示栗栗透明立绘。不会上传角色资源，也不会启动屏幕或麦克风采集。'}>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="modal-actions"><button className="button secondary" type="button" disabled={busy} onClick={() => setConfirm(false)}>先不更换</button><button className="button primary" type="button" disabled={busy} onClick={() => void summon()}>{busy ? '正在检查并保存…' : bridge?.applyBuiltin ? '确认切换并显示栗栗' : '确认在本页显示栗栗'}</button></div>
    </Modal>
  </section>;
}
