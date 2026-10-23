import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createLocalConversation } = createRequire(import.meta.url)('../../apps/desktop/voice/local-conversation.cjs');
const conversations: Array<{ stop(): Promise<unknown> }> = [];
type VoiceEvent = { type: string; state?: string; role?: string; text?: string };
type Result = { status: string; text?: string; localOnly: boolean; microphoneActive: boolean };

function fixture() {
  let microphoneActive = false;
  let onInputState: (state: { state: string }) => void;
  let deliver: ((result: Result) => void) | null = null;
  let rejectInput: ((error: unknown) => void) | null = null;
  const input = {
    snapshot: () => ({ enabled: microphoneActive, microphoneActive }),
    probe: vi.fn(async () => ({ status: 'complete', dictationAvailable: true })),
    dictate: vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<Result>((resolve, reject) => {
      microphoneActive = true;
      onInputState({ state: 'question' });
      const abort = () => { microphoneActive = false; signal.removeEventListener('abort', abort); resolve({ status: 'cancelled', localOnly: true, microphoneActive: false }); };
      deliver = result => { microphoneActive = false; signal.removeEventListener('abort', abort); resolve(result); };
      rejectInput = error => { microphoneActive = false; signal.removeEventListener('abort', abort); reject(error); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })),
    disable: vi.fn(async () => { microphoneActive = false; return { microphoneActive: false, enabled: false }; }),
  };
  const speech = { probe: vi.fn(async () => ({ status: 'complete' })), speak: vi.fn(async (_text: string, _options: { signal: AbortSignal }) => ({})),
    stop: vi.fn(async () => ({})), snapshot: () => ({ active: false }) };
  const provider = { answer: vi.fn(async (_request: { question: string; instructions: string; signal: AbortSignal }) => ({ text: '很高兴听你分享，今天有什么开心的事？' })) };
  const events: VoiceEvent[] = [];
  const onError = vi.fn();
  const conversation = createLocalConversation({ provider, speech, createInput: ({ onState }: { onState: typeof onInputState }) => { onInputState = onState; return input; }, onEvent: (event: VoiceEvent) => events.push(event), onError });
  conversations.push(conversation);
  const start = async () => { await conversation.probe(); await conversation.start({ actor: 'owner', confirmed: true }); };
  const say = (text: string) => deliver!({ status: 'complete', text, localOnly: true, microphoneActive: false });
  const sayUncertain = () => deliver!({ status: 'uncertain', localOnly: true, microphoneActive: false });
  return { conversation, input, speech, provider, events, onError, start, say, sayUncertain, failInput: (error: unknown) => rejectInput!(error) };
}

afterEach(async () => { for (const conversation of conversations.splice(0)) await conversation.stop(); });

describe('无需新增实时语音账号的本地对话（合成识别与声音）', () => {
  it('探测不启麦，不调用模型，缺少本人确认不能开始', async () => {
    const current = fixture();
    await current.conversation.probe();
    expect(current.input.dictate).not.toHaveBeenCalled();
    expect(current.provider.answer).not.toHaveBeenCalled();
    await expect(current.conversation.start()).rejects.toThrow('本人确认');
    expect(current.conversation.snapshot().microphoneActive).toBe(false);
  });

  it('听写后先停麦，只发送文字，真实模型回答后在本机朗读并继续听', async () => {
    const current = fixture();
    await current.start();
    current.say('今天心情很好');
    await vi.waitFor(() => expect(current.input.dictate).toHaveBeenCalledTimes(2));
    expect(current.provider.answer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ question: '今天心情很好', signal: expect.any(AbortSignal) }));
    expect(current.provider.answer.mock.calls[0][0]).not.toHaveProperty('image');
    expect(current.speech.speak).toHaveBeenCalledExactlyOnceWith('很高兴听你分享，今天有什么开心的事？', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(current.input.disable.mock.invocationCallOrder[0]).toBeLessThan(current.provider.answer.mock.invocationCallOrder[0]);
    expect(current.events.filter(event => event.type === 'transcript').map(event => event.role)).toEqual(['user', 'assistant']);
  });

  it('低置信听写不显示猜测文字或请求模型，只在本机提示重说', async () => {
    const current = fixture();
    await current.start();
    current.sayUncertain();
    await vi.waitFor(() => expect(current.input.dictate).toHaveBeenCalledTimes(2));
    expect(current.provider.answer).not.toHaveBeenCalled();
    expect(current.events.filter(event => event.type === 'transcript')).toEqual([
      expect.objectContaining({ role: 'assistant', text: expect.stringContaining('没有听清') }),
    ]);
    expect(current.speech.speak).toHaveBeenCalledWith(expect.stringContaining('没有听清'), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('复用本次少量上下文，但不携带屏幕、学习记录或录音', async () => {
    const current = fixture();
    await current.start();
    current.say('我喜欢听故事');
    await vi.waitFor(() => expect(current.input.dictate).toHaveBeenCalledTimes(2));
    current.say('给我讲一个');
    await vi.waitFor(() => expect(current.provider.answer).toHaveBeenCalledTimes(2));
    expect(current.provider.answer.mock.calls[1][0].instructions).toContain('我喜欢听故事');
    expect(Object.keys(current.provider.answer.mock.calls[1][0]).sort()).toEqual(['instructions', 'question', 'signal']);
  });

  it.each(['我的验证码是123456', '我的邮箱是someone@example.com'])('敏感识别文字不发给模型，也不显示原文：%s', async text => {
    const current = fixture();
    await current.start();
    current.say(text);
    await vi.waitFor(() => expect(current.input.dictate).toHaveBeenCalledTimes(2));
    expect(current.provider.answer).not.toHaveBeenCalled();
    expect(JSON.stringify(current.events)).not.toContain(text);
    expect(current.speech.speak.mock.calls[0][0]).toContain('未发送给模型');
  });

  it('静音结束本次听写；恢复继续当前对话，不重新申请账号', async () => {
    const current = fixture();
    await current.start();
    expect(await current.conversation.setMuted(true)).toEqual({ muted: true });
    expect(current.conversation.snapshot()).toMatchObject({ state: 'muted', microphoneActive: false });
    await Promise.resolve();
    expect(current.input.dictate).toHaveBeenCalledTimes(1);
    await current.conversation.setMuted(false);
    await vi.waitFor(() => expect(current.input.dictate).toHaveBeenCalledTimes(2));
  });

  it('朗读时不重新开麦；点击打断取消朗读后继续听', async () => {
    const current = fixture();
    let speechSignal: AbortSignal;
    current.speech.speak.mockImplementationOnce(async (_text, { signal }) => new Promise((_resolve, reject) => {
      speechSignal = signal;
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    await current.start();
    current.say('讲一个小故事');
    await vi.waitFor(() => expect(current.speech.speak).toHaveBeenCalledTimes(1));
    expect(current.conversation.snapshot()).toMatchObject({ state: 'speaking', microphoneActive: false });
    expect(current.input.dictate).toHaveBeenCalledTimes(1);
    await current.conversation.interrupt();
    expect(speechSignal!.aborted).toBe(true);
    await vi.waitFor(() => expect(current.input.dictate).toHaveBeenCalledTimes(2));
  });

  it('停止取消忽略信号的迟到模型结果，不播放、不恢复听写', async () => {
    const current = fixture();
    let finish!: (reply: { text: string }) => void;
    current.provider.answer.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    await current.start();
    current.say('聊聊天');
    await vi.waitFor(() => expect(current.provider.answer).toHaveBeenCalledTimes(1));
    await current.conversation.stop();
    finish({ text: '不应读出的迟到回答' });
    await Promise.resolve();
    expect(current.speech.speak).not.toHaveBeenCalled();
    expect(current.input.dictate).toHaveBeenCalledTimes(1);
    expect(current.conversation.snapshot()).toMatchObject({ state: 'off', microphoneActive: false });
  });

  it('停麦清理失败仍报告错误，不假报停止，并允许重试清理', async () => {
    const current = fixture();
    current.input.disable.mockRejectedValue(new Error('private-cleanup-error'));
    await current.start();
    current.say('聊聊天');
    await vi.waitFor(() => expect(current.onError).toHaveBeenCalledTimes(1));
    expect(current.provider.answer).not.toHaveBeenCalled();
    expect(current.conversation.snapshot()).toMatchObject({ state: 'error', active: true });
    expect(current.events.some(event => event.state === 'off')).toBe(false);
    await expect(current.conversation.stop()).rejects.toThrow('private-cleanup-error');
    current.input.disable.mockResolvedValue({ microphoneActive: false, enabled: false });
    await expect(current.conversation.stop()).resolves.toEqual({ stopped: true, microphoneActive: false });
  });

  it('安静超时保持本次听写，但网络失败停止，不自动重试模型', async () => {
    const current = fixture();
    await current.start();
    current.failInput(Object.assign(new Error('idle'), { code: 'wake_dictation_timeout' }));
    await vi.waitFor(() => expect(current.input.dictate).toHaveBeenCalledTimes(2));
    current.provider.answer.mockRejectedValueOnce(new Error('private-provider-error'));
    current.say('说个笑话');
    await vi.waitFor(() => expect(current.onError).toHaveBeenCalledTimes(1));
    expect(current.provider.answer).toHaveBeenCalledTimes(1);
    expect(current.speech.speak).not.toHaveBeenCalled();
    expect(String(current.onError.mock.calls[0][0])).not.toContain('private-provider-error');
  });
});
