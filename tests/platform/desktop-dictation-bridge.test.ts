import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkedDictationResult } from '../../apps/web/src/local-voice';

const { registerDictationBridge } = createRequire(import.meta.url)('../../apps/desktop/wake/dictation-bridge.cjs');
type Handler = (event: unknown, ...argumentsList: unknown[]) => unknown;
const bridges: Array<{ dispose(): void }> = [];
const complete = { status: 'complete', text: '教我收藏网页', localOnly: true, microphoneActive: false, recognition: 'local' };
const settle = async () => { for (let count = 0; count < 8; count += 1) await Promise.resolve(); };

function fixture() {
  const handlers = new Map<string, Handler>();
  const event = { sender: new EventEmitter(), senderFrame: {} };
  const trusted = new Set<unknown>([event]);
  const host = { hasPetWindow: vi.fn(() => true), requestVoiceDictation: vi.fn(async (_input: { signal: AbortSignal; purpose?: string; observationGeneration?: number }): Promise<unknown> => complete) };
  const bridge = registerDictationBridge({ ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) },
    prefix: 'nuanban:test:voice', isTrusted: (candidate: unknown) => trusted.has(candidate), getHost: () => host });
  bridges.push(bridge);
  const invoke = (action: string, candidate: unknown = event, ...argumentsList: unknown[]) => handlers.get(`nuanban:test:voice:${action}`)!(candidate, ...argumentsList);
  return { handlers, event, trusted, host, bridge, invoke };
}

afterEach(() => { for (const bridge of bridges.splice(0)) bridge.dispose(); });

describe('本次本地听写的可信 IPC 与发起窗口生命周期（不启用真实麦克风）', () => {
  it('只返回给调用方的文字和停止确认，不广播或透传其他字段', async () => {
    const current = fixture();
    expect(current.host.requestVoiceDictation).not.toHaveBeenCalled();
    current.host.requestVoiceDictation.mockResolvedValueOnce({ ...complete, text: '  教我收藏网页  ', rawAudio: 'not exposed' });
    expect(await current.invoke('dictate')).toEqual(complete);
    expect(current.host.requestVoiceDictation).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect(current.event.sender.eventNames()).toEqual([]);
  });

  it('屏幕语音查找只接受正整数观察代次，并将固定用途交给宿主二次核验', async () => {
    const current = fixture();
    expect(await current.invoke('dictate', current.event, { purpose: 'screen-guidance', observationGeneration: 3 })).toEqual(complete);
    expect(current.host.requestVoiceDictation).toHaveBeenCalledWith({ signal: expect.any(AbortSignal), purpose: 'screen-guidance', observationGeneration: 3 });
    expect(() => current.invoke('dictate', current.event, { purpose: 'screen-guidance', observationGeneration: 0 })).toThrow('本人');
    expect(() => current.invoke('dictate', current.event, { purpose: 'other', observationGeneration: 3 })).toThrow('本人');
  });

  it('云端听写结果如实标记为已上传音频，只透传文字与来源', async () => {
    const current = fixture();
    current.host.requestVoiceDictation.mockResolvedValueOnce({ status: 'complete', text: '把字体调大', localOnly: false,
      recognition: 'cloud', microphoneActive: false, wavBytes: 'not exposed', seconds: 4.2 });
    expect(await current.invoke('dictate')).toEqual({ status: 'complete', text: '把字体调大', localOnly: false, recognition: 'cloud', microphoneActive: false });
  });

  it('缺少来源标记或来源与 localOnly 不一致时拒绝结果', async () => {
    const inconsistent = [
      { status: 'complete', text: '把字体调大', localOnly: false, microphoneActive: false },
      { status: 'complete', text: '把字体调大', localOnly: false, recognition: 'local', microphoneActive: false },
      { status: 'complete', text: '把字体调大', localOnly: true, recognition: 'cloud', microphoneActive: false },
      { status: 'uncertain', localOnly: false, recognition: 'cloud', microphoneActive: false },
    ];
    for (const result of inconsistent) {
      const current = fixture();
      current.host.requestVoiceDictation.mockResolvedValueOnce(result);
      await expect(current.invoke('dictate')).rejects.toThrow('未确认');
    }
  });

  it('低置信听写只返回无文字状态，不能把猜测内容投递给网页', async () => {
    const current = fixture();
    current.host.requestVoiceDictation.mockResolvedValueOnce({ status: 'uncertain', localOnly: true, microphoneActive: false, text: '猜测的文字' });
    await expect(current.invoke('dictate')).resolves.toEqual({ status: 'uncertain', localOnly: true, microphoneActive: false });
  });

  it('拒绝不可信窗口、附加授权参数和缺失宿主', async () => {
    const current = fixture();
    expect(() => current.invoke('dictate', {})).toThrow('不可信');
    expect(() => current.invoke('dictate', current.event, { confirmed: true })).toThrow('本人');
    await expect(current.invoke('cancel-dictation', {})).rejects.toThrow('不可信');
    current.host.hasPetWindow.mockReturnValue(false);
    expect(() => current.invoke('dictate')).toThrow('尚未就绪');
    expect(current.host.requestVoiceDictation).not.toHaveBeenCalled();
  });

  it('取消只影响本窗口请求，并等待宿主清理后丢弃迟到的文字', async () => {
    const current = fixture();
    let finish!: (result: unknown) => void;
    current.host.requestVoiceDictation.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    const pending = current.invoke('dictate');
    await settle();
    const signal = current.host.requestVoiceDictation.mock.calls[0][0].signal;
    const other = { sender: new EventEmitter() };
    current.trusted.add(other);
    expect(await current.invoke('cancel-dictation', other)).toBe(false);
    expect(signal.aborted).toBe(false);
    expect(() => current.invoke('dictate')).toThrow('尚未结束');
    const cancelled = current.invoke('cancel-dictation');
    expect(signal.aborted).toBe(true);
    finish({ ...complete, text: '迟到结果不能回填' });
    await expect(pending).resolves.toEqual({ status: 'cancelled', localOnly: true });
    await expect(cancelled).resolves.toBe(true);
    expect(current.event.sender.eventNames()).toEqual([]);
  });

  it.each(['destroyed', 'render-process-gone', 'did-start-navigation'])('发起页面 %s 后取消请求且不投递文本', async name => {
    const current = fixture();
    let finish!: (result: unknown) => void;
    current.host.requestVoiceDictation.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    const pending = current.invoke('dictate');
    await settle();
    current.event.sender.emit(name, {}, 'file:///changed', false, true);
    expect(current.host.requestVoiceDictation.mock.calls[0][0].signal.aborted).toBe(true);
    finish(complete);
    await expect(pending).resolves.toEqual({ status: 'cancelled', localOnly: true });
  });

  it.each([{ ...complete, microphoneActive: true }, { ...complete, localOnly: false }, { ...complete, text: '' }, { ...complete, text: '字'.repeat(501) }, null])('拒绝无效或未停止的结果 %j', async result => {
    const current = fixture();
    current.host.requestVoiceDictation.mockResolvedValueOnce(result);
    await expect(current.invoke('dictate')).rejects.toThrow('未确认');
  });

  it('注销入口会使进行中的听写失效，并移除处理器', async () => {
    const current = fixture();
    let finish!: (result: unknown) => void;
    current.host.requestVoiceDictation.mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    const pending = current.invoke('dictate');
    await settle();
    current.bridge.dispose();
    expect(current.handlers.size).toBe(0);
    expect(current.host.requestVoiceDictation.mock.calls[0][0].signal.aborted).toBe(true);
    finish(complete);
    await expect(pending).resolves.toEqual({ status: 'cancelled', localOnly: true });
  });
});

describe('前端听写结果校验', () => {
  it('剔除额外字段，不把取消后的文本当作输入', () => {
    expect(checkedDictationResult({ ...complete, audio: 'discard' })).toEqual(complete);
    expect(checkedDictationResult({ ...complete, status: 'cancelled' })).toEqual({ status: 'cancelled', localOnly: true });
    expect(checkedDictationResult({ status: 'uncertain', localOnly: true, microphoneActive: false, text: 'discard' })).toEqual({ status: 'uncertain', localOnly: true, microphoneActive: false });
  });
  it.each([null, {}, { ...complete, microphoneActive: true }, { status: 'uncertain', localOnly: true, microphoneActive: true }, { ...complete, localOnly: false }, { ...complete, text: ' ' }, { ...complete, text: '字'.repeat(501) }])('拒绝未确认结果 %j', result => {
    expect(() => checkedDictationResult(result)).toThrow('未确认');
  });
});
