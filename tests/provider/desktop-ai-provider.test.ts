import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { syntheticPng } from '../helpers/standalone-frame';

const { createOpenAiCompatibleProvider, loadConfiguredProvider } = createRequire(import.meta.url)('../../apps/desktop/ai-provider.cjs') as typeof import('../../apps/desktop/ai-provider.cjs');
const configuration = { baseUrl: 'https://gateway.example.test/v1/', model: 'gpt-6.1-sol', apiKey: 'synthetic-credential-only' };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
function completed(text = '这是测试响应。') { return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: text } }] })); }
async function configurationFile(content: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'nuanban-provider-test-'));
  directories.push(directory);
  const file = join(directory, 'ai-provider.json');
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

describe('桌面真实模型端口（仅合成HTTP，不是供应验收）', () => {
  it('保留指定模型，凭证只出现在主进程请求头，禁止重定向', async () => {
    const fetchRequest = vi.fn<typeof fetch>(async () => completed());
    const provider = createOpenAiCompatibleProvider({ ...configuration, fetch: fetchRequest });
    expect(provider.status()).toEqual({ available: true });
    expect(await provider.answer({ question: '  如何调大字体？  ' })).toEqual({ text: '这是测试响应。' });
    const [endpoint, options] = fetchRequest.mock.calls[0];
    expect(endpoint).toBe('https://gateway.example.test/v1/chat/completions');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${configuration.apiKey}` } });
    const body = JSON.parse(String(options?.body));
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', stream: false });
    expect(body.messages[1].content).toEqual([{ type: 'text', text: '如何调大字体？' }]);
    expect(String(options?.body)).not.toContain(configuration.apiKey);
    expect(JSON.stringify(provider.status())).not.toContain(configuration.apiKey);
    expect(JSON.stringify(provider.status())).not.toContain(configuration.model);
    expect(JSON.stringify(provider.status())).not.toContain(new URL(configuration.baseUrl).hostname);
    expect(fetchRequest).toHaveBeenCalledOnce();
  });

  it('图片只编码传入的脱敏PNG，结构化教学提示被保留', async () => {
    const fetchRequest = vi.fn<typeof fetch>(async () => completed());
    const image = syntheticPng(0);
    await createOpenAiCompatibleProvider({ ...configuration, fetch: fetchRequest }).answer({ question: '请指路', image: { mime: 'image/png', bytes: image }, instructions: '只返回JSON。' });
    const body = JSON.parse(String(fetchRequest.mock.calls[0][1]?.body));
    expect(body.messages[0].content).toContain('只返回JSON。');
    expect(body.messages[1].content[1]).toMatchObject({ type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } });
  });

  it.each(['http://gateway.example.test/v1', 'https://user:secret@gateway.example.test/v1', 'https://gateway.example.test/v1?key=secret', 'https://gateway.example.test/v1#secret', 'file:///tmp'])('拒绝不安全地址 %s', baseUrl => {
    expect(() => createOpenAiCompatibleProvider({ ...configuration, baseUrl })).toThrow('PROVIDER_UNAVAILABLE');
  });

  it('无效文字、图片和过长提示不会发起请求', async () => {
    const fetchRequest = vi.fn<typeof fetch>();
    const provider = createOpenAiCompatibleProvider({ ...configuration, fetch: fetchRequest });
    for (const question of ['', ' ', '字'.repeat(1501)]) await expect(provider.answer({ question })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(provider.answer({ question: '图片', image: { mime: 'image/png', bytes: Buffer.alloc(2_000_001) } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(provider.answer({ question: '指路', instructions: '字'.repeat(12001) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it.each([[401, 'AUTH_FAILED', false], [403, 'AUTH_FAILED', false], [429, 'RATE_LIMITED', true], [503, 'PROVIDER_UNAVAILABLE', true]] as const)('HTTP %s 仅返回安全错误码且不自动重试', async (status, code, retryable) => {
    const fetchRequest = vi.fn<typeof fetch>(async () => new Response('sensitive-provider-error-body', { status }));
    const provider = createOpenAiCompatibleProvider({ ...configuration, fetch: fetchRequest });
    await expect(provider.answer({ question: '请解释' })).rejects.toMatchObject({ code, retryable, message: code });
    expect(fetchRequest).toHaveBeenCalledOnce();
  });

  it('拒绝截断、空白、非JSON、过长和超限响应', async () => {
    const responses = [
      () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '未完成' } }] })),
      () => completed(' '), () => completed('字'.repeat(24001)), () => new Response('<html>not json</html>'),
      () => new Response('x'.repeat(192 * 1024 + 1)),
    ];
    for (const response of responses) {
      const provider = createOpenAiCompatibleProvider({ ...configuration, fetch: async () => response() });
      await expect(provider.answer({ question: '请解释' })).rejects.toBeInstanceOf(Error);
    }
  });

  it('取消和超时拒绝迟到结果，不把网络异常正文带入错误', async () => {
    const controller = new AbortController();
    const cancelled = createOpenAiCompatibleProvider({ ...configuration, fetch: async () => { controller.abort(); return completed('迟到'); } });
    await expect(cancelled.answer({ question: '请解释', signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    const fetchRequest = vi.fn<typeof fetch>(async (_endpoint, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('sensitive-network-details')), { once: true });
    }));
    await expect(createOpenAiCompatibleProvider({ ...configuration, fetch: fetchRequest, timeoutMs: 10 }).answer({ question: '请解释' })).rejects.toMatchObject({ code: 'TIMEOUT', message: 'TIMEOUT' });
    expect(fetchRequest).toHaveBeenCalledOnce();
    await expect(createOpenAiCompatibleProvider({ ...configuration, fetch: async () => { throw new Error(configuration.apiKey); } }).answer({ question: '请解释' })).rejects.toMatchObject({ message: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('桌面密钥配置', () => {
  it('正式主进程使用系统网络通道且不附带会话凭证', async () => {
    const main = await readFile(new URL('../../apps/desktop/main.cjs', import.meta.url), 'utf8');
    expect(main).toContain("loadConfiguredProvider({ fetch: (input, init) => electron.net.fetch(input, { ...init, credentials: 'omit' }) })");
    expect(main).not.toContain('loadConfiguredProvider()');
  });

  it('没有配置时关闭，不回退或生成默认密钥', async () => {
    expect(await loadConfiguredProvider({ env: {}, configurationPath: join(tmpdir(), crypto.randomUUID(), 'missing.json') })).toBeUndefined();
    await expect(loadConfiguredProvider({ env: { NUANBAN_AI_MODEL: 'gpt-6.1-sol' } })).rejects.toThrow('PROVIDER_UNAVAILABLE');
  });

  it('外部DPAPI配置只向解密函数传入密文', async () => {
    const encryptedKey = 'Z'.repeat(100);
    const file = await configurationFile({ version: 1, credentialFormat: 'windows-dpapi-v1', encryptedKey, baseUrl: configuration.baseUrl, model: configuration.model });
    const decrypt = vi.fn(async () => configuration.apiKey);
    const provider = await loadConfiguredProvider({ env: {}, configurationPath: file, decrypt, fetch: async () => completed() });
    expect(decrypt).toHaveBeenCalledExactlyOnceWith(encryptedKey);
    expect(provider?.status()).toEqual({ available: true });
    expect(await provider?.answer({ question: '测试' })).toEqual({ text: '这是测试响应。' });
  });

  it('损坏、明文或过大的凭证文件拒绝加载', async () => {
    for (const content of ['not-json', null, { version: 1, apiKey: 'plain-key' }, 'x'.repeat(32769)]) {
      const file = await configurationFile(content);
      const decrypt = vi.fn();
      await expect(loadConfiguredProvider({ env: {}, configurationPath: file, decrypt })).rejects.toBeInstanceOf(Error);
      expect(decrypt).not.toHaveBeenCalled();
    }
  });

  it('完整环境变量覆盖文件配置，不把凭证放进状态', async () => {
    const decrypt = vi.fn();
    const fetchRequest = vi.fn<typeof fetch>(async () => completed());
    const provider = await loadConfiguredProvider({ env: { NUANBAN_AI_BASE_URL: configuration.baseUrl, NUANBAN_AI_MODEL: configuration.model, NUANBAN_AI_API_KEY: configuration.apiKey }, decrypt, fetch: fetchRequest });
    expect(provider?.status()).toEqual({ available: true });
    await provider?.answer({ question: '测试' });
    expect(JSON.parse(String(fetchRequest.mock.calls[0][1]?.body)).model).toBe(configuration.model);
    expect(decrypt).not.toHaveBeenCalled();
  });
});
