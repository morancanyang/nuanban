import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Monitor, Pencil, RotateCcw } from 'lucide-react';
import { currentPet, samePet } from '@nuanban/pet-engine';
import type { PetAppearance, PetConfiguration } from '@nuanban/domain';
import { useApp } from '../store';
import { Pet, PageTitle, Badge, Modal } from '../components';
import './pet-settings.css';
import { LocalModelPanel } from '../three-d/model-panel';
import { CompanionCatalog } from './companions';
import { localModelBridge } from '../local-model';
import { liliModel } from '../three-d/builtin-models';
import { stagger } from '../motion/stagger';
import { localCompanionBridge, showLiliCompanion } from '../local-companion';
import { showBrowserCompanion } from '../browser-companion';

const pets = [{ id: 'cat', name: '小橘猫', color: '#D98347' }, { id: 'rabbit', name: '小白兔', color: '#D7C5AB' }, { id: 'dog', name: '小暖狗', color: '#C19165' }, { id: 'lili', name: '栗栗小鹿', color: '#A66B4B' }] as const;

export function PetsPage() {
  const preferences = useApp(state => state.snapshot!.preferences);
  const busy = useApp(state => state.busy);
  const [draft, setDraft] = useState<PetConfiguration>(() => currentPet(preferences));
  const [revision, setRevision] = useState(preferences.petRevision ?? 0);
  const [confirmation, setConfirmation] = useState<'apply' | 'undo' | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [calling, setCalling] = useState(false);
  const [callStatus, setCallStatus] = useState('');
  const [callError, setCallError] = useState('');
  const isLili = draft.kind === 'lili';
  const modelBridge = localModelBridge();
  const canCall = Boolean(modelBridge?.applyBuiltin);
  const changed = !samePet(currentPet(preferences), draft);
  function selectPet(pet: typeof pets[number]) {
    setCallStatus(''); setCallError('');
    setDraft(previous => ({ kind: pet.id, appearance: pet.id === 'lili'
      ? { eyes: 'round', mouth: 'smile', action: 'idle', color: pet.color }
      : { ...previous.appearance, color: pet.color } }));
  }
  async function callLili() {
    if (calling) return;
    setCalling(true); setCallStatus(''); setCallError('');
    try {
      if (!modelBridge?.applyBuiltin) {
        showBrowserCompanion({ kind: 'lili', label: '栗栗', imageUrl: liliModel.posterUrl });
        setCallStatus('栗栗已显示在当前页面；系统悬浮桌宠仍需使用桌面客户端。');
        return;
      }
      const model = await modelBridge.applyBuiltin('lili');
      if (model.kind !== 'model' || model.id !== liliModel.sha256) throw new Error('小鹿资源状态未确认，请重试。');
      setCallStatus('原版小鹿 3D 模型已保存并调用到桌面。');
    } catch (error) { setCallError(error instanceof Error ? error.message : '栗栗桌宠调用未完成，请重试。'); }
    finally { setCalling(false); }
  }
  function tune<Key extends keyof PetAppearance>(key: Key, value: PetAppearance[Key]) {
    setDraft(previous => ({ ...previous, appearance: { ...previous.appearance, [key]: value } }));
  }
  function reload() {
    const current = useApp.getState().snapshot!.preferences;
    setDraft(currentPet(current)); setRevision(current.petRevision ?? 0);
    useApp.getState().clearError();
  }
  async function confirm() {
    try {
      if (confirmation === 'undo') await useApp.getState().undoPet(revision);
      else await useApp.getState().applyPet(draft, revision);
      reload(); setConfirmation(null);
    } catch { }
  }
  return <>
    <PageTitle eyebrow="我的伙伴收藏" title="我的小伙伴" subtitle="小鹿栗栗与小猫露米，各有自己的小天地。先认识、再预览，由你决定谁来陪伴。" />
    <CompanionCatalog />
    <div className="pet-editor-grid">
      <section className="panel pet-editor-preview" aria-label="桌宠微调预览">
        <Badge tone="sage">当前陪伴伙伴</Badge><div className="pet-editor-current"><Pet kind={preferences.pet} color={preferences.petColor} /><p>当前设置 · 本机保存</p></div>
        <div className="pet-editor-candidate"><Badge>尚未应用的预览</Badge><Pet kind={draft.kind} color={draft.appearance.color} appearance={draft.appearance} /><p aria-live="polite">{changed ? '只有候选预览改变，当前伙伴未替换。' : '预览与当前设置相同。'}</p></div>
      </section>
      <section className="panel pet-editor-controls" aria-label="内置伙伴微调">
        <h2>让小伙伴，更像你喜欢的样子。</h2><p>选择与微调只改变本页预览，调用桌宠是单独操作。不上传画稿，不调用生成服务。</p>
        <fieldset><legend>选择内置伙伴</legend><div className="pet-kind-options">{pets.map((pet, index) => <button key={pet.id} style={stagger(index)} className={'button ' + (draft.kind === pet.id ? 'primary' : 'secondary')} aria-pressed={draft.kind === pet.id} disabled={calling} onClick={() => selectPet(pet)}>{pet.name}</button>)}</div></fieldset>
        {isLili && <section className="lili-resource-card" aria-label="栗栗角色资源">
          <Badge tone="sage">本机 3D 模型 · 固定角色</Badge>
          <h3>栗栗小鹿 · 围一条暖围巾，陪在身旁。</h3>
          <p>客户端加载参考图对应的原版栗栗模型，运行时无需打开 Blender。这里使用透明参考立绘，独立详情页支持真实三维旋转。</p>
          <div className="lili-resource-tags"><span>资源 ID：<code>lili</code></span><span>静态 3D 模型 · 无内置动画</span></div>
          <p className="small-note">确认应用会在本机记住伙伴；调用会校验并保存本机模型、切换桌面角色，不会替你保存本页候选设置。栗栗的五官、围巾和配色保持统一，不使用下方通用微调。</p>
          <button className="button secondary" disabled={calling || busy} onClick={() => void callLili()}><Monitor size={18} />{calling ? '正在请栗栗陪伴…' : canCall ? '调用栗栗 3D 桌宠' : '在本页显示栗栗'}</button>
          {!canCall && <p className="small-note">手机浏览器会在当前页面显示栗栗；替换系统悬浮桌宠请使用微光指引桌面客户端。</p>}
          <p className="lili-call-status" role="status">{callStatus}</p>
          {callError && <p className="inline-error" role="alert">{callError}</p>}
        </section>}
        <div className="pet-tuning-fields">
          <label>眼睛<select aria-label="眼睛" disabled={isLili} value={draft.appearance.eyes} onChange={event => tune('eyes', event.target.value as PetAppearance['eyes'])}><option value="round">圆圆眼</option><option value="happy">弯弯笑眼</option><option value="sleepy">眯眯眼</option></select></label>
          <label>嘴型<select aria-label="嘴型" disabled={isLili} value={draft.appearance.mouth} onChange={event => tune('mouth', event.target.value as PetAppearance['mouth'])}><option value="smile">微笑</option><option value="small">小嘴</option><option value="open">张嘴</option></select></label>
          <label>动作姿态<select aria-label="动作姿态" disabled={isLili} value={draft.appearance.action} onChange={event => tune('action', event.target.value as PetAppearance['action'])}><option value="idle">安静陪伴</option><option value="greeting">招招手</option><option value="celebrating">一起庆祝</option></select></label>
          <label>伙伴颜色<input type="color" aria-label="伙伴颜色" disabled={isLili} value={draft.appearance.color} onChange={event => tune('color', event.target.value)} /></label>
        </div>
        <p className="small-note">{isLili ? '小鹿使用 Blender 原版模型并在本机渲染，此版为静态模型，不包含动作动画。' : '通用微调只适用于猫、兔、狗的内置 SVG 形象，不代表生成动画。'}</p>
        <div className="stack"><button className="button primary" disabled={!changed || busy} onClick={() => setConfirmation('apply')}><Check size={19} />预览满意，确认应用</button><button className="button secondary" disabled={busy} onClick={reload}>放弃预览，读取当前设置</button><button className="button secondary" disabled={!preferences.previousPet || busy} onClick={() => setConfirmation('undo')}><RotateCcw size={18} />撤回上次应用</button></div>
      </section>
    </div>
    <section className="panel custom-pet-section"><div><span className="eyebrow">儿童模式 · 画一画</span><h2>把想象中的小伙伴，画出来。</h2><p>保存原画后可预览，并亲手确认“直接设为桌宠”。全程本地完成，不需要 AI；仅保存或预览不会替换桌宠。</p></div><Link className="button primary" to="/pets/draw"><Pencil size={20} />去画一画</Link><button className="button secondary" onClick={() => setUnsupported(true)}>查看生成状态</button></section>
    <LocalModelPanel />
    <Modal open={confirmation !== null} onOpenChange={open => { if (!open && !busy) setConfirmation(null); }} title={confirmation === 'undo' ? '撤回到上一套内置桌宠？' : '确认应用内置桌宠微调？'}><p>{confirmation === 'undo' ? '恢复上次替换前的形象、五官、配色和姿态。这次撤回不会删除画稿，也不会改变模式或语音偏好。' : '确认后才替换当前内置伙伴，并在本机保留上一套设置供撤回。它不是 AI 生成资产，不会更改你的画稿。'}</p><div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setConfirmation(null)}>暂不更改</button><button className="button primary" disabled={busy} onClick={() => void confirm()}>{busy ? '正在保存…' : confirmation === 'undo' ? '确认撤回' : '确认应用到本机'}</button></div></Modal>
    <Modal open={unsupported} onOpenChange={setUnsupported} title="真实桌宠生成尚未接入"><p>生成供应、任务队列、资产扫描和动画验收尚未接入。内置微调不等同手绘转可动桌宠。本机原画和已有 3D 模型可直接应用，不需要生成服务。</p><Badge tone="soft">未接入，不代表生成成功</Badge></Modal>
  </>;
}
