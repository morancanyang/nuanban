import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createModelSearchClient } = require('../../apps/desktop/model-search-client.cjs');
const { createOpenAiCompatibleProvider, ProviderFailure } = require('../../apps/desktop/ai-provider.cjs');
const { registerPetSearchBridge } = require('../../apps/desktop/pet-search-bridge.cjs');
const { projectModelAnswer } = require('../../apps/desktop/pet-search-common.cjs');

function modelFixture() {
  const provider = { status: vi.fn(() => ({ available: true })),
    answer: vi.fn(async (_input: { question: string; signal?: AbortSignal; instructions?: string }) => ({ text: '这是隔离测试回答。' })) };
  return { provider, client: createModelSearchClient({ provider }) };
}

function bridgeFixture(client: ReturnType<typeof createModelSearchClient>) {
  const handlers = new Map<string, (event: unknown, ...argumentsList: unknown[]) => unknown>();
  const trusted = {};
  const showSearch = vi.fn();
  const openExternal = vi.fn();
  const bridge = registerPetSearchBridge({ client, showSearch, openExternal, isTrusted: (event: unknown) => event === trusted,
    ipcMain: { handle: (channel: string, handler: (event: unknown, ...argumentsList: unknown[]) => unknown) => handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel) } });
  const invoke = (name: string, ...argumentsList: unknown[]) => handlers.get('nuanban:pet-search:' + name)!(trusted, ...argumentsList);
  return { bridge, handlers, invoke, showSearch, openExternal };
}

describe('桌宠查询复用已配置模型（合成供应，不请求真实网络）', () => {
  it('无需 AnySearch 密钥；没有模型时如实关闭，不回退演示或搜索供应', async () => {
    const client = createModelSearchClient();
    expect(client.status()).toEqual({ provider: 'ConfiguredModel', configured: false });
    await expect(client.search('怎样保存文件')).rejects.toMatchObject({ code: 'SEARCH_NOT_CONFIGURED' });
    const unavailable = createModelSearchClient({ provider: { answer: vi.fn(), status: () => { throw new Error('private configuration'); } } });
    expect(unavailable.status().configured).toBe(false);
  });

  it('只发送手动问题及固定指令，不附带图片、历史、凭证或其他参数', async () => {
    const current = modelFixture();
    const controller = new AbortController();
    expect(current.client.status()).toEqual({ provider: 'ConfiguredModel', configured: true });
    await expect(current.client.search('  怎样保存文件  ', { signal: controller.signal, image: 'private-screen' })).resolves.toEqual({
      kind: 'model-answer', webSearch: false, answer: '这是隔离测试回答。', results: [],
    });
    const input = current.provider.answer.mock.calls[0][0];
    expect(Object.keys(input).sort()).toEqual(['instructions', 'question', 'signal']);
    expect(input.question).toBe('怎样保存文件');
    expect(input.signal).toBe(controller.signal);
    expect(input.instructions).toContain('不得声称已联网搜索');
    expect(current.provider.answer).toHaveBeenCalledOnce();
  });

  it('使用原有网关、模型和鉴权，不发送 AnySearch 请求或额外工具调用', async () => {
    const configuration = { baseUrl: 'https://model.example.net/v1', model: 'configured-test-model', apiKey: 'synthetic-model-key-not-real' };
    const fetchRequest = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '合成模型回答' } }] })));
    const provider = createOpenAiCompatibleProvider({ ...configuration, fetch: fetchRequest });
    const client = createModelSearchClient({ provider });
    await expect(client.search('怎样保存文件')).resolves.toMatchObject({ answer: '合成模型回答', webSearch: false, results: [] });
    expect(fetchRequest).toHaveBeenCalledOnce();
    expect(fetchRequest.mock.calls[0][0]).toBe('https://model.example.net/v1/chat/completions');
    const options = fetchRequest.mock.calls[0][1]!;
    expect(new Headers(options.headers).get('authorization')).toBe('Bearer ' + configuration.apiKey);
    expect(JSON.parse(String(options.body))).toMatchObject({ model: configuration.model, stream: false });
    expect(JSON.parse(String(options.body))).not.toHaveProperty('tools');
    expect(JSON.stringify(client.status())).not.toContain(configuration.apiKey);
    expect(JSON.stringify(client.status())).not.toContain(configuration.baseUrl);
  });

  it.each(['', '字'.repeat(501), '手机号 13800138000', 'api_key=synthetic-private-secret'])('非法或敏感问题在本机阻断：%s', async query => {
    const current = modelFixture();
    await expect(current.client.search(query)).rejects.toBeInstanceOf(Error);
    expect(current.provider.answer).not.toHaveBeenCalled();
  });

  it.each([undefined, null, { text: '' }, { text: ' ' }, { text: 42 }, { text: '字'.repeat(24001) }, { text: '\u0000\u202e' }])('拒绝空白或畸形模型回答：%s', async reply => {
    const client = createModelSearchClient({ provider: { status: () => ({ available: true }), answer: async () => reply } });
    await expect(client.search('怎样保存文件')).rejects.toMatchObject({ code: 'SEARCH_INVALID_RESPONSE' });
  });

  it.each([['AUTH_FAILED', 'SEARCH_AUTH_FAILED'], ['RATE_LIMITED', 'SEARCH_QUOTA'], ['TIMEOUT', 'SEARCH_TIMEOUT'],
    ['CANCELLED', 'SEARCH_CANCELLED'], ['STREAM_INTERRUPTED', 'SEARCH_INVALID_RESPONSE'], ['PROVIDER_UNAVAILABLE', 'SEARCH_FAILED']])('供应错误 %s 固定映射且不重试', async (providerCode, code) => {
    const current = modelFixture();
    current.provider.answer.mockRejectedValueOnce(new ProviderFailure(providerCode));
    await expect(current.client.search('怎样保存文件')).rejects.toMatchObject({ code });
    expect(current.provider.answer).toHaveBeenCalledOnce();
  });

  it('未知异常不泄露供应正文或密钥', async () => {
    const current = modelFixture();
    current.provider.answer.mockRejectedValueOnce(new Error('private-provider-key-and-error'));
    await expect(current.client.search('怎样保存文件')).rejects.toMatchObject({ code: 'SEARCH_FAILED' });
    expect(current.provider.answer).toHaveBeenCalledOnce();
  });

  it('取消前不发送，取消后的迟到回答也不可展示', async () => {
    const current = modelFixture();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(current.client.search('怎样保存文件', { signal: cancelled.signal })).rejects.toMatchObject({ code: 'SEARCH_CANCELLED' });
    expect(current.provider.answer).not.toHaveBeenCalled();
    const late = new AbortController();
    current.provider.answer.mockImplementationOnce(async () => { late.abort(); return { text: '迟到回答' }; });
    await expect(current.client.search('怎样保存文件', { signal: late.signal })).rejects.toMatchObject({ code: 'SEARCH_CANCELLED' });
  });

  it('归一化后丢弃额外字段，不把模型文字当作网页来源', () => {
    const result = projectModelAnswer({ kind: 'model-answer', answer: '  合成回答\u202e  ', webSearch: false, results: [], apiKey: 'private-key', raw: {} });
    expect(result).toEqual({ kind: 'model-answer', answer: '合成回答', webSearch: false, results: [] });
    expect(() => projectModelAnswer({ ...result, webSearch: true })).toThrow();
    expect(() => projectModelAnswer({ ...result, results: [{ url: 'https://example.org/fabricated' }] })).toThrow();
  });

  it('IPC 只在本人确认后请求模型，返回回答而不是伪造来源，不自动打开浏览器', async () => {
    const current = modelFixture();
    const bridge = bridgeFixture(current.client);
    expect(bridge.invoke('status')).toEqual({ provider: 'ConfiguredModel', configured: true, webSearch: false });
    bridge.invoke('show');
    expect(current.provider.answer).not.toHaveBeenCalled();
    await expect(bridge.invoke('run', { query: '怎样保存文件', consent: false })).resolves.toMatchObject({ ok: false, code: 'SEARCH_CONSENT_REQUIRED' });
    await expect(bridge.invoke('run', { query: '怎样保存文件', consent: true, screen: 'private-screen' })).resolves.toMatchObject({ ok: false });
    expect(current.provider.answer).not.toHaveBeenCalled();
    await expect(bridge.invoke('run', { query: '怎样保存文件', consent: true })).resolves.toMatchObject({ ok: true, kind: 'model-answer', answer: '这是隔离测试回答。', webSearch: false, results: [] });
    expect(bridge.openExternal).not.toHaveBeenCalled();
    await expect(bridge.invoke('open-source', { id: 'fabricated-source' })).rejects.toThrow('失效');
    bridge.bridge.dispose();
    expect(bridge.handlers.size).toBe(0);
  });

  it('IPC 取消将信号传给模型，迟到回答不会返回成功', async () => {
    const current = modelFixture();
    let finish!: (reply: { text: string }) => void;
    current.provider.answer.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const bridge = bridgeFixture(current.client);
    const pending = bridge.invoke('run', { query: '怎样保存文件', consent: true });
    bridge.invoke('cancel');
    expect(current.provider.answer.mock.calls[0][0].signal?.aborted).toBe(true);
    finish({ text: '迟到回答' });
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'SEARCH_CANCELLED' });
    bridge.bridge.dispose();
  });
});
