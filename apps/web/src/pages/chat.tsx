import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, ImagePlus, Mic, Monitor, RotateCcw, Send, Square } from 'lucide-react';
import { ServiceFailure, readConversation, type ImageQuestionStatus } from '@nuanban/application';
import { detectTextRisk } from '@nuanban/domain';
import { services, imageQuestionService } from '../composition';
import { announce, useApp } from '../store';
import { Badge, Modal, PageTitle, Pet, useSpeech } from '../components';
import { ScreenObservationPanel } from '../screen-observation';
import { LocalVoicePanel } from '../local-voice-panel';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  state: 'streaming' | 'completed' | 'stopped' | 'failed';
  source?: 'image';
}

export function ChatPage() {
  const [search] = useSearchParams();
  const [input, setInput] = useState(search.get('q') ?? '');
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [caption, setCaption] = useState('');
  const [failure, setFailure] = useState<ServiceFailure | null>(null);
  const [media, setMedia] = useState<{ url: string; name: string; file: File } | null>(null);
  const [imageConfirmed, setImageConfirmed] = useState(false);
  const [imageStatus, setImageStatus] = useState<ImageQuestionStatus | null>(null);
  const [inputModal, setInputModal] = useState<'voice' | 'screen' | null>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const activeDraft = useRef('');
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const speech = useSpeech();
  const preferences = useApp(state => state.snapshot!.preferences);

  function stopMedia() {
    setInputModal(null);
  }

  function stop() {
    stopMedia();
    generation.current++;
    controller.current?.abort();
    const unfinishedDraft = activeDraft.current;
    if (inFlight.current) { setInput(previous => previous || unfinishedDraft); setImageConfirmed(false); }
    inFlight.current = false;
    activeDraft.current = '';
    speech.stop();
    setBusy(false);
    setCaption('已停止，本次讲解不会自动恢复。');
    setMessages(previous => previous.map(message => message.state === 'streaming'
      ? { ...message, text: message.text || '讲解已停止。', state: 'stopped' } : message));
  }

  useEffect(() => {
    window.addEventListener('nuanban:stop', stop);
    return () => {
      window.removeEventListener('nuanban:stop', stop);
      generation.current++;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => () => { if (media) URL.revokeObjectURL(media.url); }, [media]);
  useEffect(() => {
    let mounted = true;
    void imageQuestionService.status().then(status => { if (mounted) setImageStatus(status); });
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: preferences.reducedMotion ? 'instant' : 'smooth', block: 'nearest' });
  }, [messages, preferences.reducedMotion]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const draft = input.trim();
    const attachment = media;
    const question = draft || (attachment ? '请帮我看看这张图片。' : '');
    if (!question || inFlight.current) return;
    if (attachment && imageStatus?.available && !imageConfirmed) { announce('请先确认仅本次允许发送脱敏图片。'); return; }
    stop();
    const current = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    setFailure(null);
    setInput('');
    const answerId = crypto.randomUUID();
    const risk = detectTextRisk(question);
    if (risk === 'private' || risk === 'transaction') {
      const warning = risk === 'transaction'
        ? '这涉及支付、转账或验证码，先停下来。暖伴不会指导这类操作，请用熟悉的电话号码与家人确认。'
        : '这里可能涉及密码或私人信息，先不要发送。请离开敏感页面后重新提问。';
      setMessages(previous => [...previous,
        { id: crypto.randomUUID(), role: 'user', text: '涉及敏感内容的问题（已在本机拦截，未发送）', state: 'completed' },
        { id: answerId, role: 'assistant', text: warning, state: 'completed' },
      ]);
      setCaption(warning);
      speech.speak(warning);
      return;
    }
    setBusy(true);
    inFlight.current = true;
    activeDraft.current = draft;
    setCaption(attachment ? '正在检查图片接口与本机安全状态…' : '暖伴正在整理讲解…');
    setMessages(previous => [...previous,
      { id: crypto.randomUUID(), role: 'user', text: question + (attachment ? '\n[已附 1 张图片]' : ''), state: 'completed' },
      { id: answerId, role: 'assistant', text: '', state: 'streaming', source: attachment ? 'image' : undefined },
    ]);
    try {
      const answer = attachment ? await imageQuestionService.answer({ question, image: attachment.file, confirmed: imageConfirmed }, abort.signal)
        : await readConversation(services.conversation, question, abort.signal, (segment, fullAnswer) => {
        if (current !== generation.current || abort.signal.aborted) return;
        setCaption(segment);
        setMessages(previous => previous.map(message => message.id === answerId ? { ...message, text: fullAnswer } : message));
      });
      if (current !== generation.current || abort.signal.aborted) return;
      setMessages(previous => previous.map(message => message.id === answerId ? { ...message, text: answer, state: 'completed' } : message));
      if (attachment) { setMedia(previous => previous === attachment ? null : previous); setImageConfirmed(false); }
      setCaption(answer);
      speech.speak(answer);
      if (!attachment && risk === 'safe' && /不会|怎么|忘|教|字太小/.test(question)) {
        try { await useApp.getState().addNote(question, answer, 'conversation'); }
        catch { announce('讲解已完成，但学习笔记未保存，请查看保存错误提示。'); }
      }
    } catch (error) {
      if (current !== generation.current || abort.signal.aborted) return;
      speech.stop();
      const problem = error instanceof ServiceFailure ? error : new ServiceFailure('PROVIDER_UNAVAILABLE', '讲解暂时不可用。问题已保留，请稍后重试或做本机练习。', true);
      setFailure(problem);
      setCaption(problem.message);
      setInput(previous => previous || draft);
      setMessages(previous => previous.map(message => message.id === answerId
        ? { ...message, text: message.text || problem.message, state: 'failed' } : message));
    } finally {
      if (current === generation.current) { inFlight.current = false; activeDraft.current = ''; setBusy(false); if (attachment) setImageConfirmed(false); }
    }
  }

  const lastAnswer = [...messages].reverse().find(message => message.role === 'assistant' && message.state === 'completed');
  function selectImage(file: File | undefined) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024) { announce('请选择不超过 10MB 的 PNG、JPEG 或 WebP 图片。'); return; }
    if (inFlight.current) stop();
    setFailure(null);
    setMedia({ url: URL.createObjectURL(file), name: file.name, file });
    setImageConfirmed(false);
    announce('图片已留在本机。发送时先检查接口；未接模型不会上传，也不会返回模拟识别结果。');
  }
  const sendDisabled = busy || (!input.trim() && !media) || (!!media && imageStatus?.available === true && !imageConfirmed);

  return <>
    <PageTitle eyebrow="有什么想学的，慢慢说" title="和暖伴说说" subtitle="可以打字、使用本地语音或选择图片。图片走独立接口，可用状态会如实显示。" />
    <div className="chat-layout">
      <section className="chat-panel" aria-label="讲解对话">
        <div className="chat-panel-head"><div><span className="online-dot" /><strong>暖暖在这里</strong></div><Badge>真实模型接口 · 不提供固定回答</Badge></div>
        <div className="messages" aria-live="off">
          {!messages.length && <div className="chat-welcome"><Pet kind={preferences.pet} color={preferences.petColor} /><h2>不用想好怎么问，<br />说说你遇到的难处就好。</h2><div className="suggestions">{['手机上的字太小，怎么调大？', '怎么给家人拍一张照片？', '我忘了上次学过的步骤'].map(text => <button key={text} onClick={() => setInput(text)}>{text}<ArrowUpRight size={17} /></button>)}</div></div>}
          {messages.map(message => <div className={'message ' + message.role} key={message.id} data-state={message.state}><span className="message-avatar">{message.role === 'user' ? '我' : '暖'}</span><div><small>{message.role === 'user' ? '你' : message.source === 'image' ? '暖伴 · 图片讲解' : '暖伴 · 文字讲解'}</small><p>{message.text || '我在想，一会儿就好…'}</p>{message.state === 'failed' && <small className="message-state">讲解未完成 · 不生成学习笔记</small>}{message.state === 'stopped' && <small className="message-state">已停止 · 不会自动恢复</small>}</div></div>)}
          <div ref={bottom} />
        </div>
        {failure && <section className="conversation-failure" role="alert" aria-label="讲解未完成"><strong>这次讲解还没完成</strong><p>{failure.message}</p><div className="button-row">{failure.retryable && <button className="button secondary" onClick={() => void submit()} disabled={sendDisabled}>重试这个问题</button>}<Link className="button plain" to="/overlay/guide">先做本机练习</Link></div></section>}
        {media && <div className="media-preview"><img src={media.url} alt="本机选择的图片预览" /><div><strong>{media.name}</strong><p role="status">{!imageStatus ? '正在检查图片接口…' : imageStatus.available ? '发送前会在本机检测并遮盖文字与人脸，不能确认安全则不发送。' : imageStatus.reason === 'model_not_configured' ? '图片接口已就绪 · 模型暂未接入，不会上传图片。' : '图片留在本机 · 当前没有可用的桌面图片接口。'}</p><label className="toggle-row"><span>仅本次允许发送检查通过的脱敏图片</span><input type="checkbox" checked={imageConfirmed} disabled={busy} onChange={event => setImageConfirmed(event.target.checked)} /></label><button className="text-button" onClick={() => { if (inFlight.current) stop(); setMedia(null); setImageConfirmed(false); setFailure(null); }}>移除图片</button></div></div>}
        <form className="composer" onSubmit={submit}>
          <label className="sr-only" htmlFor="question">想问暖伴的问题</label>
          <textarea id="question" rows={2} value={input} onChange={event => setInput(event.target.value)} placeholder="比如：手机上的字太小，怎么调大？" maxLength={1500} />
          <div className="composer-bottom"><div><button type="button" className="tool-button" onClick={() => setInputModal('voice')}><Mic size={19} />语音</button><button type="button" className="tool-button" onClick={() => fileInput.current?.click()}><ImagePlus size={19} />选图片</button><button type="button" className="tool-button" onClick={() => setInputModal('screen')}><Monitor size={19} />屏幕</button></div><button className="button primary send-button" disabled={sendDisabled}><Send size={19} />{busy ? '讲解中' : '发送'}</button></div>
        </form>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" capture={search.get('input') === 'image' ? 'environment' : undefined} hidden onChange={event => { selectImage(event.target.files?.[0]); event.target.value = ''; }} />
      </section>
      <aside className="chat-side"><section className="panel caption-panel"><span className="eyebrow">大字字幕</span><p className="caption" aria-live="polite" aria-atomic="true" style={{ fontSize: preferences.captionSize }}>{caption || '暖伴的讲解，会在这里清楚地显示。'}</p>{speech.status === 'unavailable' && <p className="small-note" role="status">系统没有可用的语音播放，已保留大字字幕。</p>}{speech.status === 'error' && <p className="small-note" role="status">语音播放失败，字幕仍然可读。</p>}<div className="stack"><button className="button secondary" disabled={busy || !lastAnswer || !!failure} onClick={() => { if (lastAnswer) { setCaption(lastAnswer.text); speech.speak(lastAnswer.text); } }}><RotateCcw size={19} />再讲一遍</button><button className="button plain" onClick={stop}><Square size={16} />停止讲解</button></div></section><Link className="guide-invitation" to="/overlay/guide">想亲手试一试？<br /><strong>打开真实桌宠教学 <ArrowRight size={18} /></strong></Link><div className="small-note">图片仅在本次确认且通过本机检查后交给模型接口；未接模型时不会上传。不会代替你操作电脑。</div></aside>
    </div>
    <Modal open={inputModal !== null} onOpenChange={open => { if (!open) stopMedia(); }} title={inputModal === 'voice' ? '本地语音输入' : '真实屏幕观察'} description="真实采集需本人选择范围并确认；不会自动开始监控。">
      {inputModal === 'voice' ? <LocalVoicePanel onTranscript={text => {
        const draft = input ? `${input}\n${text}` : text;
        if (draft.length > 1500) throw new Error('voice_draft_limit');
        setInput(draft);
        setInputModal(null);
      }} /> : inputModal === 'screen' ? <ScreenObservationPanel onPractice={stopMedia} /> : null}
    </Modal>
  </>;
}
