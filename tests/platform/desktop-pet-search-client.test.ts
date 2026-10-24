import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createPetSearchClient } = require('../../apps/desktop/pet-search-client.cjs');

const item = { title: '北京天气', url: 'https://weather.cma.cn/web/weather/54511.html', snippet: '晴，16℃' };

function anySearch(configured: boolean, results: unknown[] = [item]) {
  return {
    status: () => ({ provider: 'AnySearch', configured }),
    search: vi.fn(async () => results),
  };
}

function model(available: boolean, answer = '合成模型回答') {
  return {
    status: () => ({ provider: 'ConfiguredModel', configured: available }),
    search: vi.fn(async () => ({ kind: 'model-answer', webSearch: false, answer, results: [] })),
  };
}

describe('桌宠智能查询供应选择（合成供应，不调用真实接口）', () => {
  it('配置了 AnySearch 密钥时优先实时检索，状态如实标注已联网', async () => {
    const live = anySearch(true);
    const fallback = model(true);
    const client = createPetSearchClient({ anySearch: live, model: fallback });
    expect(client.status()).toEqual({ provider: 'AnySearch', configured: true, webSearch: true });
    await expect(client.search('今天北京天气')).resolves.toEqual([item]);
    expect(live.search).toHaveBeenCalledOnce();
    expect(fallback.search).not.toHaveBeenCalled();
  });

  it('没有密钥时回退本机模型，并标注未联网核验', async () => {
    const live = anySearch(false);
    const fallback = model(true);
    const client = createPetSearchClient({ anySearch: live, model: fallback });
    expect(client.status()).toEqual({ provider: 'ConfiguredModel', configured: true, webSearch: false });
    await expect(client.search('怎样保存文件')).resolves.toMatchObject({ kind: 'model-answer', webSearch: false });
    expect(fallback.search).toHaveBeenCalledOnce();
    expect(live.search).not.toHaveBeenCalled();
  });

  it('两者都未就绪时明确报未配置，不发匿名请求也不返回演示内容', async () => {
    const live = anySearch(false);
    const fallback = model(false);
    const client = createPetSearchClient({ anySearch: live, model: fallback });
    expect(client.status()).toEqual({ provider: 'ConfiguredModel', configured: false, webSearch: false });
    await expect(client.search('怎样保存文件')).rejects.toMatchObject({ code: 'SEARCH_NOT_CONFIGURED' });
    expect(live.search).not.toHaveBeenCalled();
    expect(fallback.search).not.toHaveBeenCalled();
  });

  it('实时检索失败直接报错，不静默改走模型冒充检索结果', async () => {
    const live = { status: () => ({ provider: 'AnySearch', configured: true }), search: vi.fn(async () => { throw Object.assign(new Error('auth'), { code: 'SEARCH_AUTH_FAILED' }); }) };
    const fallback = model(true);
    const client = createPetSearchClient({ anySearch: live, model: fallback });
    await expect(client.search('今天北京天气')).rejects.toMatchObject({ code: 'SEARCH_AUTH_FAILED' });
    expect(fallback.search).not.toHaveBeenCalled();
  });

  it('密钥后配置无需重启：状态与调用都按当次读取结果决定', async () => {
    let storedKey: string | undefined;
    const live = { status: () => ({ provider: 'AnySearch', configured: storedKey !== undefined }), search: vi.fn(async () => [item]) };
    const client = createPetSearchClient({ anySearch: live, model: model(true) });
    expect(client.status().provider).toBe('ConfiguredModel');
    storedKey = 'synthetic-later-key';
    expect(client.status()).toEqual({ provider: 'AnySearch', configured: true, webSearch: true });
  });

  it('缺少供应实现时保持封闭，不抛未处理异常', async () => {
    const client = createPetSearchClient({});
    expect(client.status()).toEqual({ provider: 'ConfiguredModel', configured: false, webSearch: false });
    await expect(client.search('怎样保存文件')).rejects.toMatchObject({ code: 'SEARCH_NOT_CONFIGURED' });
  });
});
