import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApplication, type ServerOptions } from '../../apps/server/src/http.ts';
import { signDeviceChallenge } from '../../apps/server/src/auth.ts';
import { createTextConversationService, type TextConversationOptions } from '../../apps/server/src/text-conversation.ts';
import { syntheticPng } from '../helpers/standalone-frame.ts';

const applications: ReturnType<typeof createApplication>[] = [];
const png = syntheticPng();
const pngBase64 = png.toString('base64');
const pngSha256 = createHash('sha256').update(png).digest('hex');

const providerEnv = {
  NUANBAN_AI_BASE_URL: 'https://models.example.com/v1',
  NUANBAN_AI_MODEL: 'synthetic-text-model',
  NUANBAN_AI_VISION_MODEL: 'synthetic-vision-model',
  NUANBAN_AI_API_KEY: 'synthetic-test-provider-key',
};

type StreamEvent = { type: string; payload: Record<string, unknown> };

function answeringProvider(answer = '这是合成测试回答。') {
  return vi.fn<typeof fetch>(async () => Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer } }] }));
}

async function signInAndroid(baseUrl: string, application: ReturnType<typeof createApplication>) {
  const account = application.auth.createAccount({ account_id: `image-owner-${randomUUID()}` });
  const device = application.auth.bindDevice({ account_id: account.account_id, device_id: `image-device-${randomUUID()}`, device_secret: 'synthetic-image-device-secret', platform: 'android' });
  const challengeResponse = await fetch(baseUrl + '/v1/device-sessions/challenges', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ binding_id: device.device_id }) });
  const challenge = await challengeResponse.json() as { data: { challenge_id: string; challenge: string } };
  const sessionResponse = await fetch(baseUrl + '/v1/device-sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge_id: challenge.data.challenge_id, signature: signDeviceChallenge(device.device_secret, challenge.data.challenge) }),
  });
  const session = await sessionResponse.json() as { data: { session: { access_token: string; refresh_token: string } } };
  return { device, tokens: session.data.session };
}

async function start(options: {
  conversation?: TextConversationOptions;
  server?: ServerOptions;
  noConversation?: boolean;
} = {}) {
  const textConversation = createTextConversationService(options.conversation ?? { env: providerEnv, fetch: answeringProvider() });
  const application = createApplication({ textConversation, ...options.server });
  applications.push(application);
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const { device, tokens } = await signInAndroid(baseUrl, application);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${tokens.access_token}` };
  let conversationId = '';
  if (!options.noConversation) {
    const conversationResponse = await fetch(baseUrl + '/v1/conversations', { method: 'POST', headers, body: JSON.stringify({ mode: 'accessible' }) });
    expect(conversationResponse.status).toBe(201);
    conversationId = ((await conversationResponse.json()) as { data: { session_id: string } }).data.session_id;
  }
  return { application, baseUrl, headers, conversationId, device, tokens };
}

function imageBody(overrides: Record<string, unknown> = {}) {
  return {
    input_id: randomUUID(),
    generation: 0,
    question: '这张图片里有什么？',
    image: { mime: 'image/png', base64: pngBase64 },
    sanitized_sha256: pngSha256,
    redaction_attested: true,
    ...overrides,
  };
}

async function postImage(baseUrl: string, conversationId: string, headers: Record<string, string>, body: unknown) {
  return fetch(`${baseUrl}/v1/conversations/${conversationId}/image-responses`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function readEvents(baseUrl: string, streamPath: string, headers: Record<string, string>): Promise<StreamEvent[]> {
  const response = await fetch(baseUrl + streamPath, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const text = await response.text();
  return text.split('\n\n').map(chunk => chunk.trim()).filter(Boolean)
    .map(chunk => JSON.parse(chunk.replace(/^data: /u, '')) as StreamEvent);
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map(({ server }) => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe('image question route with a configured provider', () => {
  it('answers a redacted PNG question through the existing conversation event stream', async () => {
    const provider = answeringProvider('图片里是一张合成的白色画面。');
    const { baseUrl, headers, conversationId } = await start({ conversation: { env: providerEnv, fetch: provider } });
    const response = await postImage(baseUrl, conversationId, headers, imageBody({ question: '这张图片里有什么？' }));
    expect(response.status).toBe(201);
    const accepted = await response.json() as { data: { request_id: string; stream_path: string } };
    expect(accepted.data.stream_path).toBe(`/v1/requests/${accepted.data.request_id}/events`);
    expect(JSON.stringify(accepted)).not.toContain(pngBase64);

    const events = await readEvents(baseUrl, accepted.data.stream_path, headers);
    expect(events.map(event => event.type)).toEqual(['response.started', 'caption.segment', 'response.completed']);
    const answer = events.filter(event => event.type === 'caption.segment').map(event => String(event.payload.text)).join('');
    expect(answer).toBe('图片里是一张合成的白色画面。');
    expect(events.at(-1)?.payload).toMatchObject({ final_segment_count: 1 });
    for (const event of events) expect(JSON.stringify(event)).not.toContain(pngBase64);

    expect(provider).toHaveBeenCalledOnce();
    const body = JSON.parse(String(provider.mock.calls[0][1]?.body)) as { model: string; stream: boolean; store: boolean; messages: Array<{ role: string; content: unknown }> };
    expect(body.model).toBe('synthetic-vision-model');
    expect(body.stream).toBe(false);
    expect(body.store).toBe(false);
    expect(String(body.messages[0].content)).toContain('脱敏');
    const content = body.messages[1].content as Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>;
    expect(content[0]).toMatchObject({ type: 'text', text: '这张图片里有什么？' });
    expect(content[1]).toMatchObject({ type: 'image_url', image_url: { url: `data:image/png;base64,${pngBase64}`, detail: 'high' } });
  });

  it('stores the question text but never the image bytes or the provider answer stream', async () => {
    const { baseUrl, headers, conversationId } = await start({ conversation: { env: providerEnv, fetch: answeringProvider('合成回答内容。') } });
    const accepted = await (await postImage(baseUrl, conversationId, headers, imageBody())).json() as { data: { stream_path: string } };
    await readEvents(baseUrl, accepted.data.stream_path, headers);
    const messages = await fetch(`${baseUrl}/v1/conversations/${conversationId}/messages`, { headers });
    expect(messages.status).toBe(200);
    const page = await messages.json() as { data: { items: Array<{ role: string; text: string; state: string }> } };
    expect(page.data.items.map(item => [item.role, item.text, item.state])).toEqual([
      ['user', '这张图片里有什么？', 'completed'],
      ['assistant', '合成回答内容。', 'completed'],
    ]);
    expect(JSON.stringify(page)).not.toContain(pngBase64.slice(0, 64));
  });

  it('keeps image bytes and questions out of generic request and response hooks', async () => {
    const seen: unknown[] = [];
    const { baseUrl, headers, conversationId } = await start({ server: { hooks: {
      onRequest: context => { seen.push(context.body); },
      onRoute: context => { seen.push(context.body); },
      resolveActor: context => { seen.push(context.body); return context.authenticate(); },
      onResponse: context => { seen.push(context.body); },
    } } });
    const response = await postImage(baseUrl, conversationId, headers, imageBody({ question: 'synthetic-private-image-question' }));
    expect(response.status).toBe(201);
    const captured = JSON.stringify(seen);
    expect(captured).not.toContain('synthetic-private-image-question');
    expect(captured).not.toContain(pngBase64.slice(0, 64));
    expect(seen).toContainEqual({ image_response: true });
  });

  it('replays an identical input id instead of asking the provider twice', async () => {
    const provider = answeringProvider();
    const { baseUrl, headers, conversationId } = await start({ conversation: { env: providerEnv, fetch: provider } });
    const body = imageBody();
    const first = await postImage(baseUrl, conversationId, headers, body);
    const second = await postImage(baseUrl, conversationId, headers, body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(((await second.json()) as { data: { request_id: string } }).data.request_id)
      .toBe(((await first.json()) as { data: { request_id: string } }).data.request_id);
    expect(provider).toHaveBeenCalledOnce();
  });

  it('reports provider failure as a structured stream event without fabricating an answer', async () => {
    const provider = vi.fn<typeof fetch>(async () => { throw new Error('synthetic upstream failure'); });
    const { baseUrl, headers, conversationId } = await start({ conversation: { env: providerEnv, fetch: provider } });
    const accepted = await (await postImage(baseUrl, conversationId, headers, imageBody())).json() as { data: { stream_path: string } };
    const events = await readEvents(baseUrl, accepted.data.stream_path, headers);
    expect(events.map(event => event.type)).toEqual(['response.started', 'response.failed']);
    expect(events.at(-1)?.payload).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(JSON.stringify(events)).not.toContain('synthetic upstream failure');
    expect(JSON.stringify(events)).not.toContain('synthetic-test-provider-key');
    const page = await (await fetch(`${baseUrl}/v1/conversations/${conversationId}/messages`, { headers })).json() as { data: { items: Array<{ role: string; text: string; state: string }> } };
    expect(page.data.items.at(-1)).toMatchObject({ role: 'assistant', text: '', state: 'interrupted' });
  });

  it('cancels a pending image question through the existing cancel route', async () => {
    const conversation: TextConversationOptions = {
      provider: {
        answer: async () => ({ text: 'unused' }),
        answerWithImage: ({ signal }) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      },
    };
    const { baseUrl, headers, conversationId } = await start({ conversation });
    const accepted = await (await postImage(baseUrl, conversationId, headers, imageBody())).json() as { data: { request_id: string; stream_path: string } };
    const cancelResponse = await fetch(`${baseUrl}/v1/requests/${accepted.data.request_id}/cancel`, { method: 'POST', headers, body: '{}' });
    expect(cancelResponse.status).toBe(200);
    const events = await readEvents(baseUrl, accepted.data.stream_path, headers);
    expect(events.map(event => event.type)).toContain('response.cancelled');
    expect(events.some(event => event.type === 'response.completed')).toBe(false);
  });
});

describe('image question refusals', () => {
  it('requires authentication before touching the provider', async () => {
    const provider = answeringProvider();
    const { baseUrl, conversationId } = await start({ conversation: { env: providerEnv, fetch: provider } });
    const response = await postImage(baseUrl, conversationId, { 'content-type': 'application/json' }, imageBody());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'AUTH_FAILED' } });
    expect(provider).not.toHaveBeenCalled();
  });

  it('refuses an expired session with AUTH_EXPIRED and a revoked session with AUTH_FAILED', async () => {
    let now = Date.parse('2026-10-23T00:00:00.000Z');
    const provider = answeringProvider();
    const { baseUrl, headers, conversationId, tokens } = await start({
      conversation: { env: providerEnv, fetch: provider },
      server: { clock: () => now, deviceSession: { limits: { accessTtlMs: 300 } } },
    });
    now += 400;
    const expired = await postImage(baseUrl, conversationId, headers, imageBody());
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ error: { code: 'AUTH_EXPIRED' } });

    const revoke = await fetch(baseUrl + '/v1/device-sessions/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: tokens.refresh_token }) });
    expect(revoke.status).toBe(200);
    const revoked = await postImage(baseUrl, conversationId, headers, imageBody());
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ error: { code: 'AUTH_FAILED' } });
    expect(provider).not.toHaveBeenCalled();
  });

  it('refuses conversations that do not belong to the caller', async () => {
    const provider = answeringProvider();
    const { baseUrl, headers } = await start({ conversation: { env: providerEnv, fetch: provider } });
    const unknown = await postImage(baseUrl, randomUUID(), headers, imageBody());
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
    const malformed = await postImage(baseUrl, 'not-a-uuid', headers, imageBody());
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    ['missing attestation', (body: Record<string, unknown>) => { delete body.redaction_attested; return body; }, 'redaction_attested'],
    ['false attestation', (body: Record<string, unknown>) => ({ ...body, redaction_attested: false }), 'redaction_attested'],
    ['unknown field', (body: Record<string, unknown>) => ({ ...body, original_base64: 'private' }), 'unsupported fields'],
    ['unknown image field', (body: Record<string, unknown>) => ({ ...body, image: { mime: 'image/png', base64: pngBase64, original: 'private' } }), 'image must be a PNG'],
    ['jpeg mime', (body: Record<string, unknown>) => ({ ...body, image: { mime: 'image/jpeg', base64: pngBase64 } }), 'image must be a PNG'],
    ['non uuid input', (body: Record<string, unknown>) => ({ ...body, input_id: 'input-1' }), 'input_id must be a UUID'],
    ['negative generation', (body: Record<string, unknown>) => ({ ...body, generation: -1 }), 'generation must be a non-negative integer'],
    ['empty question', (body: Record<string, unknown>) => ({ ...body, question: '  ' }), 'question must contain'],
    ['oversize question', (body: Record<string, unknown>) => ({ ...body, question: '问'.repeat(1501) }), 'question must contain'],
    ['control characters', (body: Record<string, unknown>) => ({ ...body, question: '看图\u200B片' }), 'control characters'],
    ['uppercase checksum', (body: Record<string, unknown>) => ({ ...body, sanitized_sha256: pngSha256.toUpperCase() }), 'sanitized_sha256'],
    ['checksum mismatch', (body: Record<string, unknown>) => ({ ...body, sanitized_sha256: 'b'.repeat(64) }), 'checksum does not match'],
    ['malformed png', (body: Record<string, unknown>) => ({ ...body, image: { mime: 'image/png', base64: Buffer.from('synthetic-not-a-png-'.repeat(4)).toString('base64') } }), 'valid bounded PNG'],
    ['oversize base64', (body: Record<string, unknown>) => ({ ...body, image: { mime: 'image/png', base64: 'A'.repeat(2_700_004) } }), 'bounded canonical base64'],
    ['oversize bytes', (body: Record<string, unknown>) => ({ ...body, image: { mime: 'image/png', base64: randomBytes(2_010_000).toString('base64') } }), 'valid bounded PNG'],
    ['oversize dimensions', (body: Record<string, unknown>) => ({ ...body, image: { mime: 'image/png', base64: syntheticPng(255, 4100, 10).toString('base64') } }), 'dimensions exceed'],
  ])('rejects %s before any provider call', async (_name, corrupt, message) => {
    const provider = answeringProvider();
    const { baseUrl, headers, conversationId } = await start({ conversation: { env: providerEnv, fetch: provider } });
    const body = corrupt(imageBody()) as Record<string, unknown>;
    if (body.sanitized_sha256 === pngSha256 && typeof (body.image as { base64?: string })?.base64 === 'string' && (body.image as { base64: string }).base64 !== pngBase64) {
      body.sanitized_sha256 = createHash('sha256').update(Buffer.from((body.image as { base64: string }).base64, 'base64')).digest('hex');
    }
    const response = await postImage(baseUrl, conversationId, headers, body);
    expect(response.status).toBe(400);
    const payload = await response.json() as { error: { code: string; message: string } };
    expect(payload.error.code).toBe('INVALID_REQUEST');
    expect(payload.error.message).toContain(message as string);
    expect(provider).not.toHaveBeenCalled();
  });

  it.each(['如何输入密码？', '帮我转账给孙子', 'make a wire transfer', '自动点击这个按钮'])('pauses a risky image question without uploading: %s', async question => {
    const provider = answeringProvider();
    const { baseUrl, headers, conversationId } = await start({ conversation: { env: providerEnv, fetch: provider } });
    const response = await postImage(baseUrl, conversationId, headers, imageBody({ question }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'RISK_PAUSED' } });
    expect(provider).not.toHaveBeenCalled();
  });

  it('refuses with PROVIDER_UNAVAILABLE when the provider is not configured', async () => {
    const provider = vi.fn<typeof fetch>();
    const { baseUrl, headers, conversationId } = await start({ conversation: { env: {}, fetch: provider } });
    const response = await postImage(baseUrl, conversationId, headers, imageBody());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE', retryable: false } });
    expect(provider).not.toHaveBeenCalled();
    const page = await (await fetch(`${baseUrl}/v1/conversations/${conversationId}/messages`, { headers })).json() as { data: { items: unknown[] } };
    expect(page.data.items).toEqual([]);
  });

  it('refuses when the configured provider has no image capability', async () => {
    const { baseUrl, headers, conversationId } = await start({ conversation: { provider: { answer: async () => ({ text: '文本回答。' }) } } });
    const response = await postImage(baseUrl, conversationId, headers, imageBody());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } });
  });

  it('rate limits image questions per device with a structured envelope', async () => {
    const { baseUrl, headers, conversationId } = await start({ conversation: { env: providerEnv, fetch: answeringProvider(), imageQuestionRateLimit: { limit: 1, windowMs: 60_000 } } });
    expect((await postImage(baseUrl, conversationId, headers, imageBody())).status).toBe(201);
    const limited = await postImage(baseUrl, conversationId, headers, imageBody());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(await limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED', retryable: true, details: { retry_after_seconds: 60 } } });
  });

  it('bounds the image route body at three MiB and keeps other routes at one MiB', async () => {
    const provider = answeringProvider();
    const { baseUrl, headers, conversationId } = await start({ conversation: { env: providerEnv, fetch: provider } });
    const padded = await postImage(baseUrl, conversationId, headers, JSON.stringify({ padding: 'x'.repeat(3.2 * 1024 * 1024) }));
    expect(padded.status).toBe(400);
    expect(await padded.json()).toMatchObject({ error: { message: 'Request body is too large' } });
    const conversation = await fetch(baseUrl + '/v1/conversations', { method: 'POST', headers, body: JSON.stringify({ mode: 'accessible', padding: 'x'.repeat(1.1 * 1024 * 1024) }) });
    expect(conversation.status).toBe(400);
    expect(await conversation.json()).toMatchObject({ error: { message: 'Request body is too large' } });
    expect(provider).not.toHaveBeenCalled();
  });

  it('keeps the text response route rejecting media references', async () => {
    const { baseUrl, headers, conversationId } = await start({ conversation: { env: providerEnv, fetch: answeringProvider() } });
    const response = await fetch(`${baseUrl}/v1/conversations/${conversationId}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input_id: randomUUID(), generation: 0, text: '如何调大字体？', media_refs: ['image-1'] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST', message: 'media_refs are not supported by the text conversation route' } });
  });
});