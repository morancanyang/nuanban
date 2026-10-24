import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createCloudDictation, MAX_AUDIO_BYTES, TRANSCRIBE_MODELS } from '../../apps/desktop/voice/cloud-dictation.cjs';

const configuration = { baseUrl: 'https://gateway.example.net/v1', apiKey: 'synthetic-cloud-dictation-key', retryDelaysMs: [1, 1] };
const wav = Buffer.alloc(2048, 7);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('云端听写客户端（音频仅在本次请求内存留，由宿主决定是否允许上传）', () => {
  it('把录音发给转写端点并返回文字，请求体只含模型/语言/音频', async () => {
    const fetchRequest = vi.fn<typeof fetch>(async (url, options) => {
      expect(String(url)).toBe('https://gateway.example.net/v1/audio/transcriptions');
      const headers = new Headers(options?.headers);
      expect(headers.get('authorization')).toBe('Bearer ' + configuration.apiKey);
      const form = options?.body as FormData;
      expect(form.get('model')).toBe('gpt-4o-transcribe');
      expect(form.get('language')).toBe('zh');
      const file = form.get('file') as File;
      expect(file.type).toBe('audio/wav');
      expect(file.size).toBe(wav.length);
      return jsonResponse({ text: '  你好，帮我把字体调大  ' });
    });
    const client = createCloudDictation({ ...configuration, fetch: fetchRequest });
    await expect(client.transcribe({ wav })).resolves.toMatchObject({ text: '你好，帮我把字体调大', attempts: 1 });
    expect(fetchRequest).toHaveBeenCalledOnce();
    expect(client.status()).toMatchObject({ available: true, model: 'gpt-4o-transcribe', uploadsAudio: true });
  });

  it.each(['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'] as const)('接受受支持的转写模型 %s', async (model) => {
    expect([...TRANSCRIBE_MODELS]).toContain(model);
    const client = createCloudDictation({ ...configuration, model, fetch: async () => jsonResponse({ text: '好' }) });
    await expect(client.transcribe({ wav })).resolves.toMatchObject({ text: '好' });
  });

  it('限流与 5xx 按退避重试，失败后返回安全错误码', async () => {
    const limit = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: 'upstream_rate_limit' } }, 429));
    await expect(createCloudDictation({ ...configuration, fetch: limit }).transcribe({ wav }))
      .rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true, attempts: 3 });
    expect(limit).toHaveBeenCalledTimes(3);

    const unavailable = vi.fn<typeof fetch>(async () => jsonResponse({}, 503));
    await expect(createCloudDictation({ ...configuration, fetch: unavailable }).transcribe({ wav }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(unavailable).toHaveBeenCalledTimes(3);
  });

  it('瞬时限流后重试成功', async () => {
    let calls = 0;
    const fetchRequest = vi.fn<typeof fetch>(async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({}, 429) : jsonResponse({ text: '把字体调大' });
    });
    await expect(createCloudDictation({ ...configuration, fetch: fetchRequest }).transcribe({ wav }))
      .resolves.toMatchObject({ text: '把字体调大', attempts: 2 });
    expect(fetchRequest).toHaveBeenCalledTimes(2);
  });

  it('鉴权与非法请求不重试', async () => {
    for (const [status, code] of [[401, 'AUTH_FAILED'], [403, 'AUTH_FAILED'], [400, 'INVALID_REQUEST'], [413, 'INVALID_REQUEST']] as const) {
      const fetchRequest = vi.fn<typeof fetch>(async () => jsonResponse({ error: 'private-provider-body' }, status));
      const error = await createCloudDictation({ ...configuration, fetch: fetchRequest }).transcribe({ wav }).then(() => null, (failure) => failure);
      expect(error).toMatchObject({ code });
      expect(fetchRequest).toHaveBeenCalledOnce();
      expect(JSON.stringify(error)).not.toContain('private-provider-body');
    }
  });

  it('拒绝畸形、空白或过长的识别结果', async () => {
    for (const body of [{}, { text: '' }, { text: '   ' }, { text: 'x'.repeat(501) }, { text: 42 }, '<html>not json</html>']) {
      const response = typeof body === 'string' ? new Response(body, { status: 200 }) : jsonResponse(body);
      await expect(createCloudDictation({ ...configuration, fetch: async () => response }).transcribe({ wav })).rejects.toBeInstanceOf(Error);
    }
  });

  it('在发请求前拒绝非法音频与非法配置', async () => {
    const fetchRequest = vi.fn<typeof fetch>(async () => jsonResponse({ text: '好' }));
    const client = createCloudDictation({ ...configuration, fetch: fetchRequest });
    await expect(client.transcribe({ wav: Buffer.alloc(10) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.transcribe({ wav: Buffer.alloc(MAX_AUDIO_BYTES + 1) })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.transcribe({ wav: 'not a buffer' as never })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetchRequest).not.toHaveBeenCalled();

    expect(() => createCloudDictation({ ...configuration, model: 'gpt-4' as never })).toThrow('INVALID_REQUEST');
    expect(() => createCloudDictation({ baseUrl: 'http://gateway.example.net/v1', apiKey: configuration.apiKey })).toThrow('INVALID_REQUEST');
    expect(() => createCloudDictation({ baseUrl: configuration.baseUrl, apiKey: 'short' })).toThrow('INVALID_REQUEST');
    expect(() => createCloudDictation({ ...configuration, timeoutMs: 10 })).toThrow('INVALID_REQUEST');
    expect(() => createCloudDictation({ ...configuration, retryAttempts: 9 })).toThrow('INVALID_REQUEST');
  });

  it('取消后不再返回迟到结果', async () => {
    const controller = new AbortController();
    const fetchRequest = vi.fn<typeof fetch>(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('private-network-detail')), { once: true });
    }));
    const pending = createCloudDictation({ ...configuration, fetch: fetchRequest }).transcribe({ wav, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('模块不写盘、不打印音频，也不自行决定上传（由宿主提供是否调用）', () => {
    const source = readFileSync('apps/desktop/voice/cloud-dictation.cjs', 'utf8');
    expect(source).not.toContain("require('node:fs')");
    expect(source).not.toContain('writeFileSync');
    expect(source).not.toContain('console.');
    expect(source).toContain('uploadsAudio: true');

    const helper = readFileSync('apps/desktop/voice/windows-cloud-dictation.ps1', 'utf8');
    expect(helper).toContain('NuanbanCloudRecorder');
    expect(helper).toContain('Assembly]::Load([IO.File]::ReadAllBytes');
    expect(helper).toContain('Normalise');
    expect(helper).toContain("kind = 'recorded'");
    // the recorder must never talk to the network by itself
    for (const forbidden of ['Invoke-WebRequest', 'Invoke-RestMethod', 'System.Net.Http', 'curl', 'fetch(']) {
      expect(helper).not.toContain(forbidden);
    }
    expect(readFileSync('apps/desktop/voice/NAudio-LICENSE.txt', 'utf8')).toContain('MIT');
  });
});