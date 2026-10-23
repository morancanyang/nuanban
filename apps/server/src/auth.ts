import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DeviceChallengeResponse, DeviceDto, Mode, SessionDto } from '@nuanban/contracts';
import { authenticationExpired, authenticationFailed, DomainError, permissionDenied } from './errors.ts';
import type { AccountRecord, ChallengeRecord, DeviceRecord, ServerRepositories, SessionRecord } from './repositories.ts';

export type Clock = () => number;

export interface AuthOptions {
  now?: Clock;
  challengeTtlMs?: number;
  accessTtlMs?: number;
  refreshTtlMs?: number;
}

export interface CreateAccountInput {
  account_id?: string;
  profile_label?: string;
  mode?: Mode;
}

export interface BindDeviceInput {
  account_id: string;
  device_id?: string;
  platform?: DeviceDto['platform'];
  device_secret?: string;
}

export interface AuthenticatedSession {
  account_id: string;
  device_id: string;
  session: SessionRecord;
}

/** Per-issuance lifetime override for the controlled device-session channel. */
export interface DeviceSessionTtlPolicy {
  accessTtlMs?: number;
  refreshTtlMs?: number;
}

export interface IssuedSession {
  session: SessionDto;
  device_id: string;
  platform: DeviceDto['platform'];
  access_expires_at: string;
  refresh_expires_at: string;
}

export interface DeviceChallengeWithDevice extends DeviceChallengeResponse {
  device_id: string;
}

export interface SessionRevocationResult {
  revoked: true;
  device_revoked: boolean;
}

const defaultClock: Clock = () => Date.now();

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function instant(now: Clock, offsetMs = 0): string {
  return new Date(now() + offsetMs).toISOString();
}

export function signDeviceChallenge(deviceSecret: string, challenge: string): string {
  return hmac(deviceSecret, challenge);
}

export class AuthService {
  private readonly now: Clock;
  private readonly challengeTtlMs: number;
  private readonly accessTtlMs: number;
  private readonly refreshTtlMs: number;

  constructor(private readonly repositories: ServerRepositories, options: AuthOptions = {}) {
    this.now = options.now ?? defaultClock;
    this.challengeTtlMs = options.challengeTtlMs ?? 2 * 60 * 1000;
    this.accessTtlMs = options.accessTtlMs ?? 15 * 60 * 1000;
    this.refreshTtlMs = options.refreshTtlMs ?? 30 * 24 * 60 * 60 * 1000;
  }

  createAccount(input: CreateAccountInput = {}): AccountRecord {
    const account: AccountRecord = {
      account_id: input.account_id ?? randomUUID(),
      profile_label: input.profile_label ?? 'Synthetic account',
      mode: input.mode ?? 'accessible',
      version: 1,
    };
    if (this.repositories.accounts.get(account.account_id)) throw new DomainError(409, 'VERSION_CONFLICT', 'Account already exists');
    this.repositories.accounts.save(account);
    return account;
  }

  bindDevice(input: BindDeviceInput): DeviceRecord {
    if (!this.repositories.accounts.get(input.account_id)) throw authenticationFailed('Account binding is not available');
    const device: DeviceRecord = {
      device_id: input.device_id ?? randomUUID(),
      account_id: input.account_id,
      platform: input.platform ?? 'windows',
      status: 'bound',
      device_secret: input.device_secret ?? randomBytes(32).toString('hex'),
      last_seen_at: null,
    };
    if (this.repositories.devices.get(device.device_id)) throw new DomainError(409, 'VERSION_CONFLICT', 'Device already exists');
    this.repositories.devices.save(device);
    return device;
  }

  issueDeviceChallenge(bindingId: string): DeviceChallengeResponse {
    const device = this.repositories.devices.get(bindingId);
    if (!device || device.status !== 'bound' || !this.repositories.accounts.get(device.account_id)) throw authenticationFailed('Active device binding is required');
    const challenge: ChallengeRecord = {
      challenge_id: randomUUID(),
      device_id: device.device_id,
      account_id: device.account_id,
      nonce: randomBytes(32).toString('base64url'),
      expires_at: instant(this.now, this.challengeTtlMs),
      used_at: null,
    };
    this.repositories.challenges.save(challenge);
    return { challenge_id: challenge.challenge_id, challenge: challenge.nonce, expires_at: challenge.expires_at };
  }

  exchangeDeviceChallenge(challengeId: string, signature: string): { session: SessionDto } {
    return { session: this.completeDeviceExchange(challengeId, signature).session };
  }

  /**
   * Controlled-session exchange used by the Android device-session channel. It
   * reuses the exact device-challenge semantics above and additionally reports
   * the issued session's absolute expiries so the caller can apply its own
   * (shorter) lifetime policy.
   */
  exchangeDeviceSession(challengeId: string, signature: string, policy?: DeviceSessionTtlPolicy): IssuedSession {
    return this.completeDeviceExchange(challengeId, signature, policy);
  }

  /**
   * Issues a challenge bound to an existing session's device. The client must
   * sign this nonce with the device secret before a refresh is accepted, so a
   * stolen refresh token alone cannot rotate the controlled session.
   */
  issueSessionChallenge(refreshToken: string): DeviceChallengeWithDevice {
    const current = this.activeSession(refreshToken);
    const device = this.repositories.devices.get(current.device_id);
    if (!device) throw authenticationExpired('Device binding is not active');
    const challenge: ChallengeRecord = {
      challenge_id: randomUUID(),
      device_id: device.device_id,
      account_id: device.account_id,
      nonce: randomBytes(32).toString('base64url'),
      expires_at: instant(this.now, this.challengeTtlMs),
      used_at: null,
    };
    this.repositories.challenges.save(challenge);
    return { challenge_id: challenge.challenge_id, challenge: challenge.nonce, expires_at: challenge.expires_at, device_id: device.device_id };
  }

  /**
   * Device-signed refresh: a single-use challenge that is bound to the same
   * device as the presented refresh token. The presented token is revoked as
   * part of the rotation, exactly like refreshSession().
   */
  refreshDeviceSession(refreshToken: string, challengeId: string, signature: string, policy?: DeviceSessionTtlPolicy): IssuedSession {
    const current = this.activeSession(refreshToken);
    const device = this.repositories.devices.get(current.device_id);
    if (!device || device.status !== 'bound' || device.account_id !== current.account_id) throw authenticationExpired('Device binding is not active');
    const challenge = this.repositories.challenges.get(challengeId);
    if (!challenge || challenge.device_id !== device.device_id || challenge.account_id !== current.account_id) throw authenticationFailed('Unknown device challenge');
    if (challenge.used_at !== null) throw authenticationFailed('Device challenge was already used');
    challenge.used_at = instant(this.now);
    this.repositories.challenges.save(challenge);
    if (Date.parse(challenge.expires_at) <= this.now()) throw authenticationExpired('Device challenge expired');
    if (!secureEqual(signDeviceChallenge(device.device_secret, challenge.nonce), signature)) throw authenticationFailed('Invalid device signature');
    current.revoked_at = instant(this.now);
    this.repositories.sessions.save(current);
    return this.createSession(current.account_id, current.device_id, policy);
  }

  /**
   * Read-only resolution of the device behind an active refresh token. The
   * device-session channel uses it to apply per-device rate limits *before* a
   * rotation, so a throttled refresh never revokes the caller's live token.
   */
  resolveRefreshSessionDevice(refreshToken: string): { account_id: string; device_id: string } {
    const current = this.activeSession(refreshToken);
    return { account_id: current.account_id, device_id: current.device_id };
  }

  /**
   * Deny-only revocation. A known refresh token may always revoke its own
   * session, even after it expired, because revocation only removes access. The
   * stronger device-binding revocation requires a still-active session.
   */
  revokeSessionByRefreshToken(refreshToken: string, options: { revokeDevice?: boolean } = {}): SessionRevocationResult {
    const session = this.repositories.sessions.getByRefreshHash(hashToken(refreshToken));
    if (!session) throw authenticationFailed('Refresh token is not recognized');
    const device = this.repositories.devices.get(session.device_id);
    const active = session.revoked_at === null && Date.parse(session.refresh_expires_at) > this.now()
      && !!device && device.status === 'bound' && device.account_id === session.account_id;
    if (options.revokeDevice === true) {
      if (!active) throw authenticationExpired('An active device session is required to revoke the device binding');
      this.revokeDevice(session.account_id, session.device_id);
      return { revoked: true, device_revoked: true };
    }
    if (session.revoked_at === null) {
      session.revoked_at = instant(this.now);
      this.repositories.sessions.save(session);
    }
    return { revoked: true, device_revoked: false };
  }

  refreshSession(refreshToken: string): { session: SessionDto } {
    const current = this.activeSession(refreshToken);
    current.revoked_at = instant(this.now);
    this.repositories.sessions.save(current);
    return { session: this.createSession(current.account_id, current.device_id).session };
  }

  authenticateAccessToken(accessToken: string): AuthenticatedSession {
    const session = this.repositories.sessions.getByAccessHash(hashToken(accessToken));
    if (!session || session.revoked_at !== null) throw authenticationFailed();
    if (Date.parse(session.access_expires_at) <= this.now()) throw authenticationExpired();
    const device = this.repositories.devices.get(session.device_id);
    if (!device || device.status !== 'bound' || device.account_id !== session.account_id) throw authenticationExpired();
    return { account_id: session.account_id, device_id: session.device_id, session };
  }

  revokeDevice(actorAccountId: string, deviceId: string): { revoked: true } {
    const device = this.repositories.devices.get(deviceId);
    if (!device || device.account_id !== actorAccountId) throw permissionDenied('Only the device owner can revoke this device');
    if (device.status === 'revoked') return { revoked: true };
    device.status = 'revoked';
    this.repositories.devices.save(device);
    const revokedAt = instant(this.now);
    for (const session of this.repositories.sessions.listByDevice(deviceId)) {
      if (session.revoked_at === null) {
        session.revoked_at = revokedAt;
        this.repositories.sessions.save(session);
      }
    }
    return { revoked: true };
  }

  private completeDeviceExchange(challengeId: string, signature: string, policy?: DeviceSessionTtlPolicy): IssuedSession {
    const challenge = this.repositories.challenges.get(challengeId);
    if (!challenge) throw authenticationFailed('Unknown device challenge');
    if (challenge.used_at !== null) throw authenticationFailed('Device challenge was already used');
    challenge.used_at = instant(this.now);
    this.repositories.challenges.save(challenge);
    if (Date.parse(challenge.expires_at) <= this.now()) throw authenticationExpired('Device challenge expired');
    const device = this.repositories.devices.get(challenge.device_id);
    if (!device || device.status !== 'bound' || device.account_id !== challenge.account_id) throw authenticationFailed('Device binding is not active');
    if (!secureEqual(signDeviceChallenge(device.device_secret, challenge.nonce), signature)) throw authenticationFailed('Invalid device signature');
    device.last_seen_at = instant(this.now);
    this.repositories.devices.save(device);
    return this.createSession(device.account_id, device.device_id, policy);
  }

  private activeSession(refreshToken: string): SessionRecord {
    const current = this.repositories.sessions.getByRefreshHash(hashToken(refreshToken));
    if (!current || current.revoked_at !== null) throw authenticationExpired('Refresh token is not active');
    if (Date.parse(current.refresh_expires_at) <= this.now()) {
      current.revoked_at = instant(this.now);
      this.repositories.sessions.save(current);
      throw authenticationExpired('Refresh token expired');
    }
    const device = this.repositories.devices.get(current.device_id);
    if (!device || device.status !== 'bound' || device.account_id !== current.account_id) {
      current.revoked_at = instant(this.now);
      this.repositories.sessions.save(current);
      throw authenticationExpired('Device binding is not active');
    }
    return current;
  }

  private ttl(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  private createSession(accountId: string, deviceId: string, policy?: DeviceSessionTtlPolicy): IssuedSession {
    const device = this.repositories.devices.get(deviceId);
    if (!device || device.status !== 'bound' || device.account_id !== accountId) throw authenticationFailed('Device binding is not active');
    const accessTtlMs = this.ttl(policy?.accessTtlMs, this.accessTtlMs);
    const refreshTtlMs = this.ttl(policy?.refreshTtlMs, this.refreshTtlMs);
    const accessToken = `nb_access_${randomBytes(32).toString('base64url')}`;
    const refreshToken = `nb_refresh_${randomBytes(48).toString('base64url')}`;
    const accessExpiresAt = instant(this.now, accessTtlMs);
    const refreshExpiresAt = instant(this.now, refreshTtlMs);
    const session: SessionRecord = {
      access_token_hash: hashToken(accessToken),
      refresh_token_hash: hashToken(refreshToken),
      account_id: accountId,
      device_id: deviceId,
      access_expires_at: accessExpiresAt,
      refresh_expires_at: refreshExpiresAt,
      revoked_at: null,
    };
    this.repositories.sessions.save(session);
    return {
      session: { access_token: accessToken, refresh_token: refreshToken, expires_in: Math.floor(accessTtlMs / 1000), account_id: accountId },
      device_id: deviceId,
      platform: device.platform,
      access_expires_at: accessExpiresAt,
      refresh_expires_at: refreshExpiresAt,
    };
  }
}

