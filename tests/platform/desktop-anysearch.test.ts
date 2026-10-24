import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createAnySearchClient, validateSearchQuery, publicResultUrl, searchFailure } = require('../../apps/desktop/anysearch-client.cjs');
const { registerPetSearchBridge } = require('../../apps/desktop/pet-search-bridge.cjs');
const env = { NUANBAN_ANYSEARCH_API_KEY: 'synthetic-key-not-a-real-credential' };
const item = { title: '茉莉的养护', url: 'https://example.org/garden', snippet: '保持适当光照与水分。' };
const response = (results: unknown = [item]) => new Response(JSON.stringify({ code: 0, data: { results } }), { headers: { 'content-type': 'application/json' } });

describe('AnySearch 真实接口适配（仅合成响应，不调用真实供应）', () => {
  it('无 API 时诚实显示待配置，不发匿名请求，也不返回演示结果', async () => {
    const fetchSearch = vi.fn();
    const client = createAnySearchClient({ env: {}, fetch: fetchSearch });
    expect(client.status()).toEqual({ provider: 'AnySearch', configured: false });
    await expect(client.search('如何种茉莉')).rejects.toMatchObject({ code: 'SEARCH_NOT_CONFIGURED' });
    expect(fetchSearch).not.toHaveBeenCalled();
  });

  it('只向固定官方 HTTPS 端口发送输入的文本，不附带屏幕、历史或媒体', async () => {
    const fetchSearch = vi.fn(async () => response());
    const client = createAnySearchClient({ env, fetch: fetchSearch });
    expect(client.status()).toEqual({ provider: 'AnySearch', configured: true });
    await expect(client.search('  如何种茉莉  ')).resolves.toEqual([{ ...item, source: 'example.org' }]);
    const [url, options] = fetchSearch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anysearch.com/v1/search');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(options.headers).toMatchObject({ authorization: `Bearer ${env.NUANBAN_ANYSEARCH_API_KEY}` });
    expect(JSON.parse(String(options.body))).toEqual({ query: '如何种茉莉', max_results: 10, language: 'zh-CN' });
  });

  it('支持官方 ANYSEARCH_API_KEY 环境变量，但不回传给界面', async () => {
    const fetchSearch = vi.fn(async (_url: string, _options: RequestInit) => response());
    const client = createAnySearchClient({ env: { ANYSEARCH_API_KEY: env.NUANBAN_ANYSEARCH_API_KEY }, fetch: fetchSearch });
    expect(client.status()).toEqual({ provider: 'AnySearch', configured: true });
    await client.search('花卉养护');
    expect(new Headers(fetchSearch.mock.calls[0][1].headers).get('authorization')).toBe(`Bearer ${env.NUANBAN_ANYSEARCH_API_KEY}`);
    expect(JSON.stringify(client.status())).not.toContain(env.NUANBAN_ANYSEARCH_API_KEY);
  });

  it('主进程按需读取加密密钥，后续安全配置生效不需要重启', async () => {
    let storedKey: string | undefined;
    const fetchSearch = vi.fn(async (_url: string, _options: RequestInit) => response());
    const client = createAnySearchClient({ env: {}, getApiKey: () => storedKey, fetch: fetchSearch });
    expect(client.status().configured).toBe(false);
    storedKey = env.NUANBAN_ANYSEARCH_API_KEY;
    expect(client.status().configured).toBe(true);
    await client.search('花卉养护');
    expect(new Headers(fetchSearch.mock.calls[0][1].headers).get('authorization')).toBe(`Bearer ${storedKey}`);
    storedKey = undefined;
    await expect(client.search('花卉养护')).rejects.toMatchObject({ code: 'SEARCH_NOT_CONFIGURED' });
    expect(fetchSearch).toHaveBeenCalledOnce();
  });

  it('显式环境配置优先于加密配置，无效配置不静默降级', async () => {
    const getApiKey = vi.fn(() => 'synthetic-stored-key');
    const fetchSearch = vi.fn(async (_url: string, _options: RequestInit) => response());
    await createAnySearchClient({ env, getApiKey, fetch: fetchSearch }).search('花卉养护');
    expect(getApiKey).not.toHaveBeenCalled();
    expect(new Headers(fetchSearch.mock.calls[0][1].headers).get('authorization')).toBe(`Bearer ${env.NUANBAN_ANYSEARCH_API_KEY}`);
    await expect(createAnySearchClient({ env: { NUANBAN_ANYSEARCH_API_KEY: '' }, getApiKey, fetch: fetchSearch }).search('花卉养护')).rejects.toMatchObject({ code: 'SEARCH_NOT_CONFIGURED' });
    expect(getApiKey).not.toHaveBeenCalled();
  });

  it('读取密钥异常或含换行时保守关闭，不泄露原始异常', async () => {
    for (const getApiKey of [() => { throw new Error('synthetic-private-secret'); }, () => 'invalid\nheader']) {
      const fetchSearch = vi.fn();
      const client = createAnySearchClient({ env: {}, getApiKey, fetch: fetchSearch });
      expect(client.status().configured).toBe(false);
      await expect(client.search('花卉养护')).rejects.toMatchObject({ code: 'SEARCH_NOT_CONFIGURED' });
      expect(fetchSearch).not.toHaveBeenCalled();
    }
  });

  it.each(['', ' '.repeat(5), '字'.repeat(501), 'bad\u0000query'])('拒绝无效输入 %j', async query => {
    const fetchSearch = vi.fn();
    await expect(createAnySearchClient({ env, fetch: fetchSearch }).search(query)).rejects.toMatchObject({ code: 'SEARCH_INVALID_QUERY' });
    expect(fetchSearch).not.toHaveBeenCalled();
  });

  it.each(['我的手机13812345678', '身份证110101199001011234', 'api_key: synthetic1234567890', 'Bearer synthetic1234567890', 'key_synthetic_secret_1234567890'])('含有个人号码或密钥时在本机拒绝：%s', query => {
    expect(() => validateSearchQuery(query)).toThrow('隐私');
  });

  it('允许常识性密码安全、医疗及法律问题，不以关键词冒充完整隐私识别', () => {
    expect(validateSearchQuery('如何设置安全的密码')).toBe('如何设置安全的密码');
    expect(validateSearchQuery('高血压有哪些常识')).toBe('高血压有哪些常识');
    expect(validateSearchQuery('劳动合同的基本要素')).toBe('劳动合同的基本要素');
  });

  it.each([401, 403, 402, 429, 500])('HTTP %i 不泄露供应错误原文或凭据，不自动重试', async status => {
    const fetchSearch = vi.fn(async () => new Response('private-error-with-api-key', { status }));
    const client = createAnySearchClient({ env, fetch: fetchSearch });
    let failure;
    try { await client.search('花卉养护'); } catch (error) { failure = searchFailure(error); }
    expect(failure.ok).toBe(false);
    expect(JSON.stringify(failure)).not.toContain('private-error-with-api-key');
    expect(JSON.stringify(failure)).not.toContain(env.NUANBAN_ANYSEARCH_API_KEY);
    expect(fetchSearch).toHaveBeenCalledOnce();
  });

  it('超时即结束，即使注入的 transport 不遵守 abort', async () => {
    const fetchSearch = vi.fn(() => new Promise(() => {}));
    await expect(createAnySearchClient({ env, fetch: fetchSearch, timeoutMs: 100 }).search('花卉养护')).rejects.toMatchObject({ code: 'SEARCH_TIMEOUT' });
    expect(fetchSearch).toHaveBeenCalledOnce();
  });

  it('本人取消会中断在途请求，已取消的请求不发送', async () => {
    const controller = new AbortController();
    const fetchSearch = vi.fn(() => new Promise(() => {}));
    const client = createAnySearchClient({ env, fetch: fetchSearch });
    const pending = client.search('花卉养护', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'SEARCH_CANCELLED' });
    await expect(client.search('花卉养护', { signal: controller.signal })).rejects.toMatchObject({ code: 'SEARCH_CANCELLED' });
    expect(fetchSearch).toHaveBeenCalledOnce();
  });

  it.each([null, { code: 0 }, { code: -1, data: { results: [] } }, { code: 0, data: { results: 'invalid' } }])('拒绝损坏的供应响应 %j', async payload => {
    const fetchSearch = vi.fn(async () => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }));
    await expect(createAnySearchClient({ env, fetch: fetchSearch }).search('花卉养护')).rejects.toMatchObject({ code: 'SEARCH_INVALID_RESPONSE' });
  });

  it('拒绝非 JSON、超额声明及流式超额响应', async () => {
    for (const value of [new Response('html', { headers: { 'content-type': 'text/html' } }),
      new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '9000' } }),
      new Response(JSON.stringify({ code: 0, data: { results: [{ ...item, snippet: 'x'.repeat(2000) }] } }), { headers: { 'content-type': 'application/json' } })]) {
      const client = createAnySearchClient({ env, fetch: async () => value, maxResponseBytes: 256 });
      await expect(client.search('花卉养护')).rejects.toMatchObject({ code: 'SEARCH_INVALID_RESPONSE' });
    }
  });

  it('过滤危险地址和重复来源，结果最多十项且丢弃无关字段', async () => {
    const results = [item, { ...item, url: 'javascript:alert(1)' }, item,
      ...Array.from({ length: 15 }, (_, index) => ({ ...item, url: `https://example.org/garden/${index}`, secret: 'do-not-expose' }))];
    const client = createAnySearchClient({ env, fetch: async () => response(results) });
    const projected = await client.search('花卉养护');
    expect(projected).toHaveLength(10);
    expect(projected[0]).not.toHaveProperty('secret');
    expect(JSON.stringify(projected)).not.toContain('javascript:');
  });

  it.each(['javascript:alert(1)', 'file:///C:/private.txt', 'http://example.org/', 'https://127.0.0.1/',
    'https://[::1]/', 'https://local/', 'https://example.local/', 'https://username:password@example.org/', 'https://example.org:8080/'])('禁止将危险来源交给浏览器：%s', url => {
    expect(publicResultUrl(url)).toBeNull();
  });

  it('未知错误只产生固定失败信息，不能透出原始异常', () => {
    expect(searchFailure(new Error('synthetic-sensitive-raw-error'))).toEqual({ ok: false, code: 'SEARCH_FAILED', message: '智能查询暂不可用，请稍后手动重试。' });
  });
});

function bridgeFixture() {
  const handlers = new Map<string, (event: unknown, ...argumentsList: unknown[]) => unknown>();
  const trusted = {};
  const client = { status: () => ({ provider: 'AnySearch', configured: true, webSearch: true }), search: vi.fn(async (_query: string, _options: { signal: AbortSignal }) => [item]) };
  const showSearch = vi.fn();
  const openExternal = vi.fn(async (_url: string) => undefined);
  const bridge = registerPetSearchBridge({ ipcMain: { handle: (channel: string, handler: (event: unknown, ...argumentsList: unknown[]) => unknown) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel) }, isTrusted: (event: unknown) => event === trusted, client, showSearch, openExternal });
  const invoke = (name: string, ...argumentsList: unknown[]) => handlers.get(`nuanban:pet-search:${name}`)!(trusted, ...argumentsList);
  return { bridge, handlers, client, showSearch, openExternal, invoke };
}

describe('桌宠独立搜索桥接', () => {
  it('仅本人受信任窗口能读取、提交、停止或打开来源', () => {
    const current = bridgeFixture();
    for (const handler of current.handlers.values()) expect(() => handler({})).toThrow('不可信');
    expect(current.client.search).not.toHaveBeenCalled();
    expect(current.openExternal).not.toHaveBeenCalled();
  });

  it('打开搜索面板不联网，也不请求屏幕或麦克风', () => {
    const current = bridgeFixture();
    current.invoke('show');
    expect(current.showSearch).toHaveBeenCalledOnce();
    expect(current.invoke('status')).toEqual({ provider: 'AnySearch', configured: true, webSearch: true });
    expect(current.client.search).not.toHaveBeenCalled();
  });

  it('未确认发送或夹带屏幕/密钥参数时拒绝搜索', async () => {
    const current = bridgeFixture();
    await expect(current.invoke('run', { query: '花卉养护', consent: false })).resolves.toMatchObject({ ok: false, code: 'SEARCH_CONSENT_REQUIRED' });
    await expect(current.invoke('run', { query: '花卉养护', consent: true, screen: 'private-screen' })).resolves.toMatchObject({ ok: false, code: 'SEARCH_INVALID_QUERY' });
    expect(current.client.search).not.toHaveBeenCalled();
  });

  it('显示来源但不自动打开，仅支持本次已返回的来源 ID', async () => {
    const current = bridgeFixture();
    const reply = await current.invoke('run', { query: '花卉养护', consent: true }) as { results: { id: string }[] };
    expect(current.openExternal).not.toHaveBeenCalled();
    await current.invoke('open-source', { id: reply.results[0].id });
    expect(current.openExternal).toHaveBeenCalledWith(item.url);
    await expect(current.invoke('open-source', { id: 'untrusted-id' })).rejects.toThrow('失效');
    await expect(current.invoke('open-source', { id: reply.results[0].id, url: 'https://untrusted.org' })).rejects.toThrow('无效');
  });

  it('取消后迟到响应不能显示，旧来源 ID 同时失效', async () => {
    const current = bridgeFixture();
    let finish!: (items: typeof item[]) => void;
    current.client.search.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = current.invoke('run', { query: '花卉养护', consent: true });
    current.invoke('cancel');
    expect(current.client.search.mock.calls[0][1].signal.aborted).toBe(true);
    finish([item]);
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'SEARCH_CANCELLED' });
  });

  it('新搜索替代旧搜索，旧响应不能覆盖新来源', async () => {
    const current = bridgeFixture();
    let finish!: (items: typeof item[]) => void;
    current.client.search.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = current.invoke('run', { query: '第一问', consent: true });
    const second = await current.invoke('run', { query: '第二问', consent: true }) as { results: { id: string }[] };
    finish([item]);
    await expect(first).resolves.toMatchObject({ ok: false, code: 'SEARCH_CANCELLED' });
    await current.invoke('open-source', { id: second.results[0].id });
    expect(current.openExternal).toHaveBeenCalledWith(item.url);
  });

  it('退出销毁搜索 IPC，并中断在途请求', () => {
    const current = bridgeFixture();
    current.bridge.dispose();
    expect(current.handlers.size).toBe(0);
  });

  it('preload 不暴露供应密钥或通用 URL 打开函数', async () => {
    const exposed: Record<string, Record<string, (...argumentsList: unknown[]) => unknown>> = {};
    const invoke = vi.fn(async () => true);
    runInNewContext(readFileSync(new URL('../../apps/desktop/pet-preload.cjs', import.meta.url), 'utf8'), {
      require: () => ({ contextBridge: { exposeInMainWorld: (name: string, value: Record<string, (...argumentsList: unknown[]) => unknown>) => { exposed[name] = value; } },
        ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() } }),
    });
    expect(Object.keys(exposed.nuanbanSearch)).toEqual(['status', 'open', 'search', 'cancel', 'openSource', 'onOpen']);
    await exposed.nuanbanSearch.search('花卉养护', true, { screen: 'private-screen' });
    expect(invoke).toHaveBeenCalledWith('nuanban:pet-search:run', { query: '花卉养护', consent: true });
    expect(() => exposed.nuanbanSearch.openSource('file:///private.txt')).toThrow('无效');
  });
});
