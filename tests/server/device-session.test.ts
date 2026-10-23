import { describe, expect, it } from 'vitest';
import { AuthService, signDeviceChallenge } from '../../apps/server/src/auth.ts';
import { DeviceSessionService, type DeviceSessionLimits } from '../../apps/server/src/device-session.ts';
import { createInMemoryRepositories } from '../../apps/server/src/repositories.ts';

const instant = Date.parse('2026-10-23T00:00:00.000Z');

function setup(options: { challengeTtlMs?: number; limits?: Partial<DeviceSessionLimits> } = {}) {
  let now = instant;
  const repositories = createInMemoryRepositories();
  const auth = new AuthService(repositories, { now: () => now, challengeTtlMs: options.challengeTtlMs ?? 1_000, accessTtlMs: 500, refreshTtlMs: 5_000 });
  const sessions = new DeviceSessionService(auth, { now: () => now, limits: options.limits });
  const account = auth.createAccount({ account_id: 'account-android' });
  const device = auth.bindDevice({ account_id: account.account_id, device_id: 'device-android', device_secret: 'synthetic-android-device-secret', platform: 'android' });
  return { auth, sessions, repositories, account, device, advance: (milliseconds: number) => { now += milliseconds; } };
}

function signIn(sessions: DeviceSessionService, deviceSecret: string, deviceId: string, clientKey = '198.51.100.7') {
  const challenge = sessions.issueChallenge({ binding_id: deviceId }, clientKey);
  return sessions.createSession({ challenge_id: challenge.challenge_id, signature: signDeviceChallenge(deviceSecret, challenge.challenge) }, clientKey);
}

function signedRefresh(sessions: DeviceSessionService, deviceSecret: string, refreshToken: string, clientKey = '198.51.100.7') {
  const challenge = sessions.issueChallenge({ refresh_token: refreshToken }, clientKey);
  return sessions.refreshSession({ refresh_token: refreshToken, challenge_id: challenge.challenge_id, signature: signDeviceChallenge(deviceSecret, challenge.challenge) }, clientKey);
}

describe('DeviceSessionService issuance', () => {
  it('issues a short-lived, device-bound session with explicit expiries', () => {
    const { sessions, device } = setup();
    const issued = signIn(sessions, device.device_secret, device.device_id).session;
    expect(issued).toMatchObject({ token_type: 'Bearer', expires_in: 600, refresh_expires_in: 14 * 24 * 60 * 60, account_id: 'account-android', device_id: 'device-android', platform: 'android' });
    expect(issued.access_token).toMatch(/^nb_access_/u);
    expect(issued.refresh_token).toMatch(/^nb_refresh_/u);
    expect(JSON.stringify(issued)).not.toContain(device.device_secret);
  });

  it('consumes each challenge exactly once and rejects a wrong device signature', () => {
    const { sessions, device } = setup();
    const challenge = sessions.issueChallenge({ binding_id: device.device_id }, '198.51.100.7');
    expect(() => sessions.createSession({ challenge_id: challenge.challenge_id, signature: 'a'.repeat(64) }, '198.51.100.7')).toThrow('Invalid device signature');
    expect(() => sessions.createSession({ challenge_id: challenge.challenge_id, signature: signDeviceChallenge(device.device_secret, challenge.challenge) }, '198.51.100.7')).toThrow('already used');
  });

  it('rejects an expired challenge without issuing a session', () => {
    const { sessions, device, advance } = setup();
    const challenge = sessions.issueChallenge({ binding_id: device.device_id }, '198.51.100.7');
    advance(1_000);
    expect(() => sessions.createSession({ challenge_id: challenge.challenge_id, signature: signDeviceChallenge(device.device_secret, challenge.challenge) }, '198.51.100.7')).toThrow('expired');
  });

  it('refuses a revoked device binding', () => {
    const { sessions, auth, device } = setup();
    const issued = signIn(sessions, device.device_secret, device.device_id).session;
    auth.revokeDevice('account-android', device.device_id);
    expect(() => auth.authenticateAccessToken(issued.access_token)).toThrow();
    expect(() => sessions.issueChallenge({ refresh_token: issued.refresh_token }, '198.51.100.7')).toThrow('not active');
  });
});

describe('DeviceSessionService signed refresh', () => {
  it('rotates the session and revokes the presented refresh token', () => {
    const { sessions, device } = setup();
    const first = signIn(sessions, device.device_secret, device.device_id).session;
    const second = signedRefresh(sessions, device.device_secret, first.refresh_token).session;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.account_id).toBe(first.account_id);
    expect(() => signedRefresh(sessions, device.device_secret, first.refresh_token)).toThrow('not active');
  });

  it('requires a device signature and keeps the live token usable after a bad attempt', () => {
    const { sessions, device } = setup();
    const issued = signIn(sessions, device.device_secret, device.device_id).session;
    const challenge = sessions.issueChallenge({ refresh_token: issued.refresh_token }, '198.51.100.7');
    expect(() => sessions.refreshSession({ refresh_token: issued.refresh_token, challenge_id: challenge.challenge_id, signature: 'b'.repeat(64) }, '198.51.100.7')).toThrow('Invalid device signature');
    expect(signedRefresh(sessions, device.device_secret, issued.refresh_token).session.account_id).toBe('account-android');
  });

  it('rejects a challenge that belongs to another device', () => {
    const { sessions, auth, device } = setup();
    const issued = signIn(sessions, device.device_secret, device.device_id).session;
    const other = auth.bindDevice({ account_id: 'account-android', device_id: 'device-other', device_secret: 'synthetic-other-device-secret', platform: 'android' });
    const foreign = sessions.issueChallenge({ binding_id: other.device_id }, '198.51.100.8');
    expect(() => sessions.refreshSession({
      refresh_token: issued.refresh_token,
      challenge_id: foreign.challenge_id,
      signature: signDeviceChallenge(other.device_secret, foreign.challenge),
    }, '198.51.100.7')).toThrow('Unknown device challenge');
  });

  it('refuses signed refresh once the refresh token expired', () => {
    const { sessions, device, advance } = setup({ limits: { refreshTtlMs: 1_000 } });
    const issued = signIn(sessions, device.device_secret, device.device_id).session;
    advance(1_500);
    expect(() => sessions.issueChallenge({ refresh_token: issued.refresh_token }, '198.51.100.7')).toThrow('expired');
  });
});

describe('DeviceSessionService revocation', () => {
  it('invalidates the access token immediately and stays idempotent', () => {
    const { sessions, auth, device } = setup();
    const issued = signIn(sessions, device.device_secret, device.device_id).session;
    expect(auth.authenticateAccessToken(issued.access_token).device_id).toBe('device-android');
    expect(sessions.revokeSession({ refresh_token: issued.refresh_token }, '198.51.100.7')).toEqual({ revoked: true, device_revoked: false });
    expect(() => auth.authenticateAccessToken(issued.access_token)).toThrow();
    expect(sessions.revokeSession({ refresh_token: issued.refresh_token }, '198.51.100.7')).toEqual({ revoked: true, device_revoked: false });
  });

  it('can revoke the whole device binding while the session is active', () => {
    const { sessions, auth, device, repositories } = setup();
    const issued = signIn(sessions, device.device_secret, device.device_id).session;
    expect(sessions.revokeSession({ refresh_token: issued.refresh_token, revoke_device: true }, '198.51.100.7')).toEqual({ revoked: true, device_revoked: true });
    expect(repositories.devices.get('device-android')?.status).toBe('revoked');
    expect(() => auth.authenticateAccessToken(issued.access_token)).toThrow();
  });

  it('refuses device-binding revocation from an already revoked session', () => {
    const { sessions, device } = setup();
    const issued = signIn(sessions, device.device_secret, device.device_id).session;
    sessions.revokeSession({ refresh_token: issued.refresh_token }, '198.51.100.7');
    expect(() => sessions.revokeSession({ refresh_token: issued.refresh_token, revoke_device: true }, '198.51.100.7')).toThrow('active device session');
  });

  it('never echoes an unknown token back in the error', () => {
    const { sessions } = setup();
    const unknown = `nb_refresh_${'z'.repeat(64)}`;
    try {
      sessions.revokeSession({ refresh_token: unknown }, '198.51.100.7');
      throw new Error('Expected revocation to fail');
    } catch (error) {
      expect(error).toMatchObject({ status: 401, code: 'AUTH_FAILED' });
      expect(JSON.stringify(error)).not.toContain(unknown);
    }
  });
});

describe('DeviceSessionService rate limits', () => {
  it('limits challenges per device and reports a retry window', () => {
    const { sessions, device } = setup({ limits: { challengePerDevice: { limit: 2, windowMs: 60_000 } } });
    sessions.issueChallenge({ binding_id: device.device_id }, '198.51.100.7');
    sessions.issueChallenge({ binding_id: device.device_id }, '198.51.100.7');
    try {
      sessions.issueChallenge({ binding_id: device.device_id }, '198.51.100.7');
      throw new Error('Expected the third challenge to be rate limited');
    } catch (error) {
      expect(error).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryable: true, details: { retry_after_seconds: 60 } });
    }
  });

  it('limits exchanges per client key', () => {
    const { sessions, device } = setup({ limits: { exchangePerClient: { limit: 1, windowMs: 60_000 } } });
    const challenge = sessions.issueChallenge({ binding_id: device.device_id }, '198.51.100.9');
    sessions.createSession({ challenge_id: challenge.challenge_id, signature: signDeviceChallenge(device.device_secret, challenge.challenge) }, '198.51.100.9');
    const second = sessions.issueChallenge({ binding_id: device.device_id }, '198.51.100.9');
    expect(() => sessions.createSession({ challenge_id: second.challenge_id, signature: signDeviceChallenge(device.device_secret, second.challenge) }, '198.51.100.9')).toThrow('Too many device session exchanges');
  });

  it('throttles refreshes without burning the live refresh token', () => {
    const { sessions, device, advance } = setup({ limits: { refreshPerDevice: { limit: 1, windowMs: 1_000 } } });
    const first = signIn(sessions, device.device_secret, device.device_id).session;
    const second = signedRefresh(sessions, device.device_secret, first.refresh_token).session;
    expect(() => signedRefresh(sessions, device.device_secret, second.refresh_token)).toThrow('Too many device session refreshes');
    advance(1_000);
    expect(signedRefresh(sessions, device.device_secret, second.refresh_token).session.device_id).toBe('device-android');
  });
});

describe('DeviceSessionService request validation', () => {
  it.each([
    ['no field', {}, 'exactly one'],
    ['both fields', { binding_id: 'device-android', refresh_token: `nb_refresh_${'a'.repeat(64)}` }, 'exactly one'],
    ['unknown field', { binding_id: 'device-android', extra: true }, 'unsupported fields'],
    ['invalid device id', { binding_id: 'device android' }, 'not a valid identifier'],
    ['invalid refresh token', { refresh_token: 'synthetic-token' }, 'not a valid device session token'],
  ])('rejects a challenge request with %s', (_name, body, message) => {
    const { sessions } = setup();
    expect(() => sessions.issueChallenge(body, '198.51.100.7')).toThrow(message as string);
  });

  it.each([
    ['non uuid challenge', { challenge_id: 'challenge-1', signature: 'a'.repeat(64) }, 'must be a UUID'],
    ['non hex signature', { challenge_id: '00000000-0000-4000-8000-000000000001', signature: 'NOT-HEX' }, 'lowercase hex'],
    ['unknown field', { challenge_id: '00000000-0000-4000-8000-000000000001', signature: 'a'.repeat(64), mode: 'elder' }, 'unsupported fields'],
  ])('rejects a session request with %s', (_name, body, message) => {
    const { sessions } = setup();
    expect(() => sessions.createSession(body, '198.51.100.7')).toThrow(message as string);
  });

  it('rejects a non-boolean revoke_device flag', () => {
    const { sessions, device } = setup();
    const issued = signIn(sessions, device.device_secret, device.device_id).session;
    expect(() => sessions.revokeSession({ refresh_token: issued.refresh_token, revoke_device: 'yes' }, '198.51.100.7')).toThrow('must be a boolean');
  });

  it('rejects invalid server-side lifetime configuration', () => {
    const repositories = createInMemoryRepositories();
    const auth = new AuthService(repositories);
    expect(() => new DeviceSessionService(auth, { limits: { accessTtlMs: 0 } })).toThrow('accessTtlMs must be a positive safe integer');
    expect(() => new DeviceSessionService(auth, { limits: { refreshPerDevice: { limit: 0, windowMs: 1 } } })).toThrow('refreshPerDevice must be a positive rate limit policy');
  });
});