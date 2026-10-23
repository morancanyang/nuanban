import { useEffect, useRef, useState } from 'react';
import { Mic, RefreshCw, Settings, Square } from 'lucide-react';
import { checkedDictationResult, checkedVoiceStatus, localVoiceBridge, micSignalHint, type LocalVoiceStatus } from './local-voice';

export function LocalVoicePanel({ onTranscript }: { onTranscript?: (text: string) => void }) {
  const [bridge] = useState(localVoiceBridge);
  const [status, setStatus] = useState<LocalVoiceStatus | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [transcript, setTranscript] = useState('');
  const [notice, setNotice] = useState('');
  const sequence = useRef(0);
  const statusSequence = useRef(0);
  const active = useRef(false);
  const operation = useRef('');
  const transcriptHandler = useRef(onTranscript);
  transcriptHandler.current = onTranscript;
  const canDictate = typeof bridge?.dictate === 'function' && typeof bridge?.cancelDictation === 'function';

  async function readStatus() {
    if (!bridge) return;
    const request = ++statusSequence.current;
    const action = sequence.current;
    try {
      const result = checkedVoiceStatus(await bridge.status());
      if (active.current && request === statusSequence.current && action === sequence.current) setStatus(result);
    } catch {
      if (active.current && request === statusSequence.current && action === sequence.current) {
        setStatus(null);
        setError('未能读取桌宠语音状态，不能确认麦克风已关闭。请在桌宠中检查或停止。');
      }
    }
  }

  useEffect(() => {
    active.current = true;
    void readStatus();
    const timer = bridge ? window.setInterval(() => { void readStatus(); }, 1500) : undefined;
    return () => {
      active.current = false;
      sequence.current += 1;
      window.clearInterval(timer);
      if (['dictate', 'cancelDictation'].includes(operation.current)) void bridge?.cancelDictation?.().catch(() => {});
    };
  }, [bridge]);

  async function act(action: 'dictate' | 'cancelDictation' | 'enable' | 'disable' | 'openSettings') {
    if (!bridge || (operation.current && !((action === 'disable' && ['enable', 'dictate'].includes(operation.current)) || (action === 'cancelDictation' && operation.current === 'dictate')))) return;
    const request = ++sequence.current;
    operation.current = action;
    setPending(action);
    setError('');
    setNotice('');
    try {
      if (action === 'dictate') {
        if (!canDictate) throw new Error('dictation_bridge_unavailable');
        setTranscript('');
        const result = checkedDictationResult(await bridge.dictate!());
        if (active.current && request === sequence.current) {
          if (result.status === 'complete') {
            setTranscript(result.text);
            try { transcriptHandler.current?.(result.text); } catch {
              setError('语音已识别，但聊天草稿已接近字数上限。请先整理草稿，再使用下方识别文字；没有覆盖原文字。');
            }
          } else if (result.status === 'uncertain') setNotice('这次没有听清，未写入聊天草稿。请靠近麦克风、说慢一点后重试。');
          else setNotice('本次语音输入已取消，没有填入或发送文字。');
        }
      } else if (action === 'cancelDictation') {
        await bridge.cancelDictation?.();
        if (active.current && request === sequence.current) setNotice('本次语音输入已取消，没有填入或发送文字。');
      } else if (action === 'openSettings') {
        if (await bridge.openSettings() !== true) throw new Error('settings_not_opened');
      } else {
        const result = checkedVoiceStatus(await bridge[action]());
        if (active.current && request === sequence.current) setStatus(result);
      }
    } catch {
      if (active.current && request === sequence.current) setError(action === 'openSettings'
        ? '系统设置未能打开，请手动进入 Windows 设置 → 隐私和安全性 → 麦克风。'
        : action === 'disable' || action === 'cancelDictation' ? '停止尚未确认，请在独立桌宠中再次停止；不会把失败显示为已关闭。'
          : action === 'dictate' ? '本次语音输入未完成。请查看本地语音状态，并检查默认麦克风和离线中文语音引擎。'
          : '本地语音未能开启。请查看桌宠状态，并检查离线中文语音引擎、默认输入设备和 Windows 麦克风权限。');
    } finally {
      if (active.current && request === sequence.current) {
        operation.current = '';
        setPending('');
        void readStatus();
      }
    }
  }

  if (!bridge) return <div className="stack">
    <p>当前浏览器或旧版宿主没有独立桌宠语音入口，不会在这里反复请求麦克风权限。</p>
    <p>请使用最新 Windows 独立桌宠，右键选择“本地语音唤醒”。普通网页不能代替桌宠的本机离线语音引擎。</p>
    <p className="small-note">Windows 设置 → 隐私和安全性 → 麦克风：检查麦克风访问及桌面应用访问。此处未开启录音，文字输入仍可用。</p>
  </div>;

  const microphoneMayBeActive = status?.microphoneActive || status?.enabled;
  const showEnableHint = ['enable', 'dictate'].includes(pending) || (status !== null && !microphoneMayBeActive);
  return <div className="stack">
    <p>点击“开始语音输入”，本人确认后直接说一句话，无需先说唤醒词。识别文字会填入聊天框，由你检查后亲手发送。</p>
    <section className="confirmation-box" aria-label="本地语音状态" aria-live="polite">
      <strong>{!status ? '麦克风状态待确认' : pending === 'dictate' && status.phase === 'question' ? '正在本机听写，请直接说话' : microphoneMayBeActive ? '桌宠语音正在运行或等待清理' : '桌宠麦克风未开启'}</strong>
      <p>{status?.message || '正在读取本机状态；打开这个面板不会开启麦克风。'}</p>
    </section>
    {microphoneMayBeActive && <section className="confirmation-box" aria-label="麦克风信号" aria-live="polite">
      <strong>麦克风信号</strong>
      <div role="meter" aria-label="麦克风实时电平" aria-valuemin={0} aria-valuemax={100} aria-valuenow={status?.signal?.level ?? 0}
        style={{ height: '0.6rem', borderRadius: '0.3rem', background: '#eee3d4', overflow: 'hidden' }}>
        <div style={{ width: `${status?.signal?.level ?? 0}%`, height: '100%', background: (status?.signal?.level ?? 0) < 12 ? '#c9863f' : '#5d9c6b' }} />
      </div>
      <p>{micSignalHint(status?.signal)}</p>
    </section>}
    {showEnableHint && <section id="local-voice-enable-hint" className="confirmation-box" aria-label="开启本地语音提示" aria-live="polite">
      <strong>{pending === 'enable' ? '还差一步：请本人确认开启' : pending === 'dictate' ? '请确认本次输入，再等候听写提示' : '想用语音和微光指引说话？'}</strong>
      <p>{pending === 'dictate'
        ? '在原生窗口选择“本人同意本次输入”，看到“正在本机听写”后直接说话。不想继续可以点击“取消本次输入”。'
        : pending === 'enable'
        ? '请查看桌宠弹出的确认窗口，选择“本人同意开启”。如果不想开启，选择“暂不开启”，或点击下方“停止本地语音”。'
        : '点击“开始语音输入”，再在原生窗口选择“本人同意本次输入”。麦克风不会自动开启。'}</p>
    </section>}
    <p className="small-note">本次听写最多 20 秒，识别后关闭麦克风。置信度不足时不会把猜测文字写入草稿，会提示你重新说。已有唤醒监听会先关闭，不会自动恢复；音频仅本机处理，不上传、不保存。屏幕和云分析仍需另外同意。</p>
    {!canDictate && <p role="alert">当前宿主尚无直接听写入口，请保存工作后重新打开客户端。开启唤醒不等于语音输入。</p>}
    {notice && <p role="status">{notice}</p>}
    {transcript && <section className="confirmation-box" aria-label="本次识别文字"><strong>本次识别文字</strong><p>{transcript}</p></section>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="button-row">
      <button type="button" className="button primary" aria-describedby={showEnableHint ? 'local-voice-enable-hint' : undefined} disabled={!status || Boolean(pending) || !canDictate} onClick={() => void act('dictate')}><Mic size={20} />{pending === 'dictate' ? '正在等待本次听写…' : '开始语音输入'}</button>
      {['dictate', 'cancelDictation'].includes(pending) && <button type="button" className="button secondary" disabled={pending === 'cancelDictation'} onClick={() => void act('cancelDictation')}>{pending === 'cancelDictation' ? '正在取消并清理…' : '取消本次输入'}</button>}
      <button type="button" className="button secondary" disabled={Boolean(pending) && !['enable', 'dictate'].includes(pending)} onClick={() => void act('disable')}><Square size={18} />停止本地语音</button>
      <button type="button" className="button secondary" disabled={!status || Boolean(pending) || Boolean(microphoneMayBeActive)} onClick={() => void act('enable')}><Mic size={18} />{pending === 'enable' ? '请在桌宠确认语音授权' : '在桌宠开启本地语音'}</button>
      <button type="button" className="button plain" disabled={Boolean(pending)} onClick={() => void act('openSettings')}><Settings size={18} />打开 Windows 麦克风设置</button>
      <button type="button" className="button plain" disabled={Boolean(pending)} onClick={() => { setError(''); void readStatus(); }}><RefreshCw size={18} />刷新语音状态</button>
    </div>
    <p className="small-note">关闭面板会取消尚未完成的本次听写，但不会退出独立桌宠。唤醒监听是另一项功能，不会回填本聊天框；需停止全部语音时请点击“停止本地语音”。</p>
  </div>;
}
