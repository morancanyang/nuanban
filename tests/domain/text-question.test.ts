import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConversation, type TextQuestionBridge, type TextQuestionReply } from '@nuanban/application';
import { RemoteConversation } from '@nuanban/api-client';
import { createConversation } from '../../apps/web/src/conversation';
import { DesktopConversation } from '../../apps/web/src/text-question';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function bridgeFixture(answer: TextQuestionBridge['answer'] = async input => ({ ok: true, requestId: input.requestId, text: '真实端口的合成测试回答' })) {
  const bridge: TextQuestionBridge = { status: async () => ({ available: true }), answer: vi.fn(answer), cancel: vi.fn(async () => true) };
  vi.stubGlobal('window', { nuanbanTextQuestion: bridge });
  return bridge;
}
const ask = (signal = new AbortController().signal) => readConversation(new DesktopConversation(), '字体怎么调大？', signal, vi.fn());

describe('前端真实文字适配', () => {
  it('通过受限端口消费响应，保持事件关联和完成协议', async () => {
    const bridge = bridgeFixture();
    expect(await ask()).toBe('真实端口的合成测试回答');
    expect(bridge.answer).toHaveBeenCalledOnce();
    expect(bridge.cancel).not.toHaveBeenCalled();
  });
  it('长回答拆成合法事件，保持完整内容', async () => {
    const text = '字'.repeat(24000);
    bridgeFixture(async input => ({ ok: true, requestId: input.requestId, text }));
    expect(await ask()).toBe(text);
  });
  it('没有桌面端口不返回固定回答，也不尝试网络', async () => {
    vi.stubGlobal('window', {});
    const fetchRequest = vi.fn();
    vi.stubGlobal('fetch', fetchRequest);
    await expect(ask()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(fetchRequest).not.toHaveBeenCalled();
  });
  it.each(['AUTH_FAILED', 'RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'RISK_PAUSED'] as const)('安全显示 %s，不生成笔记内容', async code => {
    bridgeFixture(async input => ({ ok: false, requestId: input.requestId, code, retryable: true }));
    await expect(ask()).rejects.toMatchObject({ code });
  });
  it('拒绝错请求、空白、超长和畸形结果', async () => {
    for (const result of [{ ok: true, requestId: 'wrong', text: '不采用' }, { ok: false, code: 'unknown', retryable: true }]) {
      bridgeFixture(async input => ({ requestId: input.requestId, ...result }) as TextQuestionReply);
      await expect(ask()).rejects.toBeInstanceOf(Error);
    }
    for (const text of ['', '字'.repeat(24001)]) {
      bridgeFixture(async input => ({ ok: true, requestId: input.requestId, text }));
      await expect(ask()).rejects.toMatchObject({ code: 'STREAM_INTERRUPTED' });
    }
  });
  it('取消立即返回，不接受迟到模型结果', async () => {
    let finish!: (value: TextQuestionReply) => void;
    const bridge = bridgeFixture(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const task = ask(controller.signal);
    const assertion = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(bridge.answer).toHaveBeenCalledOnce());
    controller.abort();
    await assertion;
    expect(bridge.cancel).toHaveBeenCalledOnce();
    finish({ ok: true, requestId: 'late', text: '不能采用' });
  });
  it('超时主动取消主进程请求，网络异常不泄漏正文', async () => {
    vi.useFakeTimers();
    const bridge = bridgeFixture(() => new Promise(() => undefined));
    const task = ask();
    const assertion = expect(task).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(50001);
    await assertion;
    expect(bridge.cancel).toHaveBeenCalledOnce();
    bridgeFixture(async () => { throw new Error('private-gateway-body'); });
    await expect(ask()).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('前端会话选择', () => {
  it('浏览器和 Android 使用远程会话，Windows 保留桌面端口', () => {
    const remoteClient = {} as ConstructorParameters<typeof RemoteConversation>[0];
    expect(createConversation('browser', remoteClient)).toBeInstanceOf(RemoteConversation);
    expect(createConversation('android', remoteClient)).toBeInstanceOf(RemoteConversation);
    expect(createConversation('windows', remoteClient)).toBeInstanceOf(DesktopConversation);
    expect(createConversation('browser', null)).toBeInstanceOf(DesktopConversation);
  });
});
