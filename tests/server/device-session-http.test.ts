import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApplication, type ServerOptions } from '../../apps/server/src/http.ts';
import { signDeviceChallenge } from '../../apps/server/src/auth.ts';

const applications: ReturnType<typeof createApplication>[] = [];

async function start(options: ServerOptions = {}) {
  const application = createApplication(options);
  applications.push(application);
  await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address() as AddressInfo;
  return { application, baseUrl: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map(({ server }) => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

function bindAndroidDevice(application: ReturnType<typeof createApplication>) {
  const account = application.auth.createAccount({ account_id: 'android-http-account' });
  return application.auth.bindDevice({ account_id: account.account_id, device_id: 'android-http-device', device_secret: 'synthetic-android-http-secret', platform: 'android' });
}

type SessionEnvelope = { data: { session: { access_token: string; refresh_token: string; expires_in: number; refresh_expires_in: number; token_type: string; device_id: string; platform: string } } };

async function signIn(baseUrl: string, deviceId: string, deviceSecret: string): Promise<SessionEnvelope['data']['session']> {
  const challengeResponse = await post(baseUrl, '/v1/device-sessions/challenges', { binding_id: deviceId });
  expect(challengeResponse.status).toBe(201);
  const challenge = await challengeResponse.json() as { data: { challenge_id: string; challenge: string; signature_algorithm: string } };
  expect(challenge.data.signature_algorithm).toBe('hmac-sha256-hex');
  const sessionResponse = await post(baseUrl, '/v1/device-sessions', {
    challenge_id: challenge.data.challenge_id,
    signature: signDeviceChallenge(deviceSecret, challenge.data.challenge),
  });
  expect(sessionResponse.status).toBe(201);
  return ((await sessionResponse.json()) as SessionEnvelope).data.session;
}

describe('device session HTTP routes', () => {
  it('signs in, refreshes with a device signature and revokes over the real surface', async () => {
    const { application, baseUrl } = await start();
    const device = bindAndroidDevice(application);
    const session = await signIn(baseUrl, device.device_id, device.device_secret);
    expect(session).toMatchObject({ token_type: 'Bearer', expires_in: 600, device_id: 'android-http-device', platform: 'android' });
    expect(session.refresh_expires_in).toBeGreaterThan(0);

    const authorized = await fetch(baseUrl + '/v1/relations', { headers: { authorization: `Bearer ${session.access_token}` } });
    expect(authorized.status).toBe(200);

    const refreshChallengeResponse = await post(baseUrl, '/v1/device-sessions/challenges', { refresh_token: session.refresh_token });
    expect(refreshChallengeResponse.status).toBe(201);
    const refreshChallenge = await refreshChallengeResponse.json() as { data: { challenge_id: string; challenge: string } };
    const refreshedResponse = await post(baseUrl, '/v1/device-sessions/refresh', {
      refresh_token: session.refresh_token,
      challenge_id: refreshChallenge.data.challenge_id,
      signature: signDeviceChallenge(device.device_secret, refreshChallenge.data.challenge),
    });
    expect(refreshedResponse.status).toBe(201);
    const refreshed = ((await refreshedResponse.json()) as SessionEnvelope).data.session;
    expect(refreshed.refresh_token).not.toBe(session.refresh_token);

    const rotatedOut = await fetch(baseUrl + '/v1/relations', { headers: { authorization: `Bearer ${session.access_token}` } });
    expect(rotatedOut.status).toBe(401);
    expect(await rotatedOut.json()).toMatchObject({ error: { code: 'AUTH_FAILED' } });
    const live = await fetch(baseUrl + '/v1/relations', { headers: { authorization: `Bearer ${refreshed.access_token}` } });
    expect(live.status).toBe(200);

    const revokeResponse = await post(baseUrl, '/v1/device-sessions/revoke', { refresh_token: refreshed.refresh_token });
    expect(revokeResponse.status).toBe(200);
    expect(await revokeResponse.json()).toMatchObject({ data: { revoked: true, device_revoked: false }, schema_version: '0.2.0' });
    const revokedAccess = await fetch(baseUrl + '/v1/relations', { headers: { authorization: `Bearer ${refreshed.access_token}` } });
    expect(revokedAccess.status).toBe(401);
  });

  it('expires the short access token and restores access only through a signed refresh', async () => {
    let now = Date.parse('2026-10-23T00:00:00.000Z');
    const { application, baseUrl } = await start({ clock: () => now, deviceSession: { limits: { accessTtlMs: 300 } } });
    const device = bindAndroidDevice(application);
    const session = await signIn(baseUrl, device.device_id, device.device_secret);
    now += 400;

    const expired = await fetch(baseUrl + '/v1/relations', { headers: { authorization: `Bearer ${session.access_token}` } });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ error: { code: 'AUTH_EXPIRED' } });

    const challengeResponse = await post(baseUrl, '/v1/device-sessions/challenges', { refresh_token: session.refresh_token });
    const challenge = await challengeResponse.json() as { data: { challenge_id: string; challenge: string } };
    const refreshedResponse = await post(baseUrl, '/v1/device-sessions/refresh', {
      refresh_token: session.refresh_token,
      challenge_id: challenge.data.challenge_id,
      signature: signDeviceChallenge(device.device_secret, challenge.data.challenge),
    });
    expect(refreshedResponse.status).toBe(201);
    const refreshed = ((await refreshedResponse.json()) as SessionEnvelope).data.session;
    const live = await fetch(baseUrl + '/v1/relations', { headers: { authorization: `Bearer ${refreshed.access_token}` } });
    expect(live.status).toBe(200);
  });

  it('keeps device secrets and tokens out of request and response hooks', async () => {
    const seen: unknown[] = [];
    const { application, baseUrl } = await start({ hooks: {
      onRequest: context => { seen.push(context.body); },
      onRoute: context => { seen.push(context.body); },
      resolveActor: context => { seen.push(context.body); return context.authenticate(); },
      onResponse: context => { seen.push(context.body); },
    } });
    const device = bindAndroidDevice(application);
    const session = await signIn(baseUrl, device.device_id, device.device_secret);
    const refreshChallenge = await post(baseUrl, '/v1/device-sessions/challenges', { refresh_token: session.refresh_token });
    const captured = JSON.stringify(seen);
    expect(captured).not.toContain(device.device_secret);
    expect(captured).not.toContain(session.access_token);
    expect(captured).not.toContain(session.refresh_token);
    expect(seen).toContainEqual({ device_session: true });
    expect(seen).toContainEqual(expect.objectContaining({ device_session: true, request_id: expect.any(String) }));
    expect(refreshChallenge.status).toBe(201);
  });

  it('rate limits with a structured envelope and a Retry-After header', async () => {
    const { application, baseUrl } = await start({ deviceSession: { limits: { challengePerDevice: { limit: 1, windowMs: 60_000 } } } });
    const device = bindAndroidDevice(application);
    expect((await post(baseUrl, '/v1/device-sessions/challenges', { binding_id: device.device_id })).status).toBe(201);
    const limited = await post(baseUrl, '/v1/device-sessions/challenges', { binding_id: device.device_id });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(await limited.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', retryable: true, details: { retry_after_seconds: 60 } },
      request_id: expect.any(String),
      schema_version: '0.2.0',
    });
  });

  it('returns structured validation and authentication failures without leaking details', async () => {
    const { application, baseUrl } = await start();
    const device = bindAndroidDevice(application);
    const malformed = await post(baseUrl, '/v1/device-sessions/challenges', '{');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'INVALID_REQUEST', retryable: false } });
    const unknownField = await post(baseUrl, '/v1/device-sessions/challenges', { binding_id: device.device_id, raw_device_secret: 'synthetic-secret-value' });
    expect(unknownField.status).toBe(400);
    expect(await unknownField.text()).not.toContain('synthetic-secret-value');
    const unknownChallenge = await post(baseUrl, '/v1/device-sessions', { challenge_id: '00000000-0000-4000-8000-000000000000', signature: 'a'.repeat(64) });
    expect(unknownChallenge.status).toBe(401);
    expect(await unknownChallenge.json()).toMatchObject({ error: { code: 'AUTH_FAILED', message: 'Unknown device challenge' } });
    const challengeResponse = await post(baseUrl, '/v1/device-sessions/challenges', { binding_id: device.device_id });
    const challenge = await challengeResponse.json() as { data: { challenge_id: string; challenge: string } };
    const wrongSignature = await post(baseUrl, '/v1/device-sessions', { challenge_id: challenge.data.challenge_id, signature: 'f'.repeat(64) });
    expect(wrongSignature.status).toBe(401);
    expect(await wrongSignature.json()).toMatchObject({ error: { code: 'AUTH_FAILED', message: 'Invalid device signature' } });
    const reused = await post(baseUrl, '/v1/device-sessions', { challenge_id: challenge.data.challenge_id, signature: signDeviceChallenge(device.device_secret, challenge.data.challenge) });
    expect(reused.status).toBe(401);
    expect(await reused.json()).toMatchObject({ error: { code: 'AUTH_FAILED', message: 'Device challenge was already used' } });
  });
});