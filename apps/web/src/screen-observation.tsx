import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Monitor, Square } from 'lucide-react';
import { checkedGuidanceStatus, checkedObservationStatus, guidanceSummary, localObservationBridge, type LocalObservationStatus } from './local-observation';

const descriptions: Record<LocalObservationStatus['state'], string> = {
  off: '尚未开启；不会因打开此窗口而采集屏幕。',
  observing: '观察授权已开启，正在等待本地安全检查。',
  privacy_paused: '隐私保护已暂停采集和发送。请先离开敏感或未知页面，再由本人确认继续。',
  stopped: '观察已停止，不会自动恢复。',
  cleanup_failed: '采集退出尚未确认，发送已关闭。请再次停止或退出桌宠，不能视为已停止。',
};

export function ScreenObservationPanel({ onPractice }: { onPractice: () => void }) {
  const [bridge] = useState(localObservationBridge);
  const [status, setStatus] = useState<LocalObservationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const sequence = useRef(0);

  useEffect(() => {
    mounted.current = true;
    if (!bridge) return () => { mounted.current = false; };
    const refresh = async () => {
      if (inFlight.current) return;
      const current = ++sequence.current;
      try {
        const next = checkedObservationStatus(await bridge.status());
        if (mounted.current && current === sequence.current) { setStatus(next); setStatusError(''); }
      } catch {
        if (mounted.current && current === sequence.current) { setStatus(null); setStatusError('桌宠状态读取失败，不能确认是否正在采集。请从桌宠检查或停止。'); }
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => { mounted.current = false; sequence.current++; window.clearInterval(timer); };
  }, [bridge]);

  async function act(action: 'start' | 'resume' | 'stop' | 'showPet') {
    if (!bridge || inFlight.current) return;
    inFlight.current = true;
    sequence.current++;
    setBusy(true);
    setError('');
    try {
      const next = checkedObservationStatus(await bridge[action]());
      if (mounted.current) { setStatus(next); setStatusError(''); }
    } catch {
      if (mounted.current) setError(action === 'stop'
        ? '停止未确认。请从独立桌宠再次停止或退出，不要认为采集已经结束。'
        : '操作未完成。请查看桌宠及本机权限提示；不会以模拟画面代替真实屏幕。');
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  if (!bridge) return <div className="stack">
    <p>真实屏幕观察由独立 Windows 桌宠提供，不在这个浏览器页面内模拟采集。</p>
    <p>请启动桌面客户端（项目命令：<code>pnpm desktop</code>），右键桌宠选择“开始本地观察…”，亲自选屏并确认用途。若桌面客户端仍显示此说明，请退出后更新启动，旧窗口没有观察接口。</p>
    <p className="small-note">浏览器不提供假屏幕或自动核验。文字问题也可以交给桌面客户端的真实模型端口。</p>
    <Link className="button secondary" to="/chat/new" onClick={onPractice}>返回文字问答 <ArrowRight size={20} /></Link>
  </div>;

  const canStart = !!status && ['off', 'stopped'].includes(status.state);
  const canResume = status?.state === 'privacy_paused' && !status.captureActive;
  const guidance = status ? (status.guidance ?? checkedGuidanceStatus(undefined)) : null;
  const guidanceLines = guidance ? guidanceSummary(guidance) : null;
  return <div className="stack">
    <p>桌宠默认使用<strong>无截屏指引</strong>：本机读前台窗口的控件清单，模型只选第几号控件，箭头坐标由本机给出。截帧只在本人当次允许时使用，不会因为读不到控件树就自动截屏。</p>
    {guidanceLines && <section className="confirmation-box" aria-label="当前指引模式" aria-live="polite">
      <strong>{guidanceLines.mode}</strong>
      <p>{guidanceLines.reason}</p>
      <p>{guidanceLines.controls}</p>
      <p>{guidanceLines.consent}</p>
      {guidance?.review && <p>上次核验：{guidance.review.verdict === 'advanced' ? '界面已变化，给出下一步' : guidance.review.verdict === 'unchanged' ? '界面没有变化，可能没有点到' : '本机无法判断，不猜结果'}（{guidance.review.detail}）</p>}
      {guidance?.suggestSingleFrame && <p role="status">当前软件没有可读控件树。需要截帧时请由你本人在桌宠里选择“允许截一帧”，这里不会自动开启屏幕采集。</p>}
      {!guidance?.available && <p role="status">本机没有返回指引模式信息；不会因此改用截屏。</p>}
    </section>}
    <details>
      <summary>改用截帧方式（仅在本人当次允许时；会采集屏幕）</summary>
      <p>观察真实电脑屏幕，在独立桌宠中教学；文字对话不会冒充真实屏幕分析。</p>
      <section className="confirmation-box" aria-label="真实屏幕观察状态" aria-live="polite">
      <strong>{status?.state === 'observing' && status.captureActive ? '真实屏幕正在本地观察' : '本机观察状态'}</strong>
      <p>{status?.state === 'observing' && status.captureActive ? '所选屏幕正在本机采集并逐帧检查；不会自动点击或输入。'
        : status?.state === 'privacy_paused' && status.captureActive ? '隐私保护已关闭发送，正在等待本地采集退出；尚不能确认停止。'
          : status ? descriptions[status.state] : '正在读取桌宠状态，尚不能确认采集情况。'}</p>
      {status?.sourceName && <p>观察范围：{status.sourceName}</p>}
      {status && <p>云分析服务：{status.cloudConfigured ? '已配置，仍需本人另行同意发送' : '未配置，不会使用模拟答案替代'}</p>}
    </section>
    <p className="small-note">默认仅本机观察。开始时由你选屏、确认用途；按需脱敏上云须单独勾选。敏感、未知或检测故障会停止采集，不自动恢复。所有点击与输入由你亲手完成。</p>
    {(error || statusError) && <p role="alert" className="inline-error">{error || statusError}</p>}
    <div className="button-row">
      <button type="button" className="button primary" disabled={busy || !(canStart || canResume)} onClick={() => void act(canResume ? 'resume' : 'start')}><Monitor size={20} />{busy ? '正在处理，请查看桌宠' : canResume ? '本人确认继续共享' : '选择屏幕并开启真实观察'}</button>
      <button type="button" className="button secondary" disabled={busy} onClick={() => void act('stop')}><Square size={18} />停止真实观察</button>
      <button type="button" className="button plain" disabled={busy} onClick={() => void act('showPet')}>打开独立桌宠 <ArrowRight size={18} /></button>
    </div>
    <p className="small-note">关闭这个说明窗口不等于停止观察。可在此点击停止，或随时右键桌宠停止全部采集。</p>
    </details>
  </div>;
}
