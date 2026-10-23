import type { DeviceDto } from '@nuanban/contracts';
import type { AuthService, IssuedSession } from './auth.ts';
import { invalidRequest, rateLimited } from './errors.ts';
import { createFixedWindowRateLimiter, type RateLimiter } from './rate-limit.ts';

/**
 * Controlled device-session channel for native hosts (Android / Windows).
 *
 * It is a thin, rate-limited facade over the existing AuthService
 * device-challenge semantics: the same challenge records, the same HMAC-SHA256
 * device signature and the same session records. It adds three things the
 * native channel needs and the legacy routes do not provide:
 *   1. a shorter, explicit session lifetime policy,
 *   2. a refresh that requires a device signature over a fresh challenge,
 *   3. per-client and per-device rate limits with structured 429 responses.
 *
 * Tokens are only ever returned to the caller of these methods; they are never
 * logged, never echoed in errors and never reach the WebView bridge.
 */

export interface DeviceSessionRateLimit {
  limit: number;
  windowMs: number;
}

export interface DeviceSessionLimits {
  accessTtlMs: number;
  refreshTtlMs: number;
  challengePerClient: DeviceSessionRateLimit;
  challengePerDevice: DeviceSessionRateLimit;
  exchangePerClient: DeviceSessionRateLimit;
  refreshPerClient: DeviceSessionRateLimit;
  refreshPerDevice: DeviceSessionRateLimit;
  revokePerClient: DeviceSessionRateLimit;
}

const rateLimit = (limit: number, windowMs: number): DeviceSessionRateLimit => Object.freeze({ limit, windowMs });

export const defaultDeviceSessionLimits: DeviceSessionLimits = Object.freeze({
  accessTtlMs: 10 * 60 * 1000,
  refreshTtlMs: 14 * 24 * 60 * 60 * 1000,
  challengePerClient: rateLimit(30, 60_000),
  challengePerDevice: rateLimit(10, 60_000),
  exchangePerClient: rateLimit(20, 60_000),
  refreshPerClient: rateLimit(20, 60_000),
  refreshPerDevice: rateLimit(10, 60_000),
  revokePerClient: rateLimit(10, 60_000),
});

export interface DeviceSessionDto {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_expires_in: number;
  account_id: string;
  device_id: string;
  platform: DeviceDto['platform'];
}

export interface DeviceChallengeDto {
  challenge_id: string;
  challenge: string;
  expires_at: string;
  signature_algorithm: 'hmac-sha256-hex';
}

export interface DeviceSessionServiceOptions {
  now?: () => number;
  limits?: Partial<DeviceSessionLimits>;
  limiter?: RateLimiter;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const signaturePattern = /^[a-f0-9]{64}$/;
const refreshTokenPattern = /^nb_refresh_[A-Za-z0-9_-]{40,128}$/;
const signatureAlgorithm = 'hmac-sha256-hex' as const;
const maximumClientKeyCharacters = 128;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactBody(value: unknown, required: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!plainRecord(value)) throw invalidRequest(`${label} must be a JSON object`);
  const keys = Object.keys(value);
  const missing = required.filter(key => !Object.hasOwn(value, key));
  if (missing.length > 0) throw invalidRequest(`${label} is missing ${missing.join(', ')}`);
  const unknown = keys.filter(key => !required.includes(key) && !optional.includes(key));
  if (unknown.length > 0) throw invalidRequest(`${label} contains unsupported fields: ${unknown.join(', ')}`);
  return value;
}

function boundedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) throw invalidRequest(`${field} must be a non-empty string`);
  return value;
}

function identifierField(value: unknown, field: string): string {
  const candidate = boundedString(value, field);
  if (!identifierPattern.test(candidate)) throw invalidRequest(`${field} is not a valid identifier`);
  return candidate;
}

function uuidField(value: unknown, field: string): string {
  const candidate = boundedString(value, field);
  if (!uuidPattern.test(candidate)) throw invalidRequest(`${field} must be a UUID`);
  return candidate;
}

function signatureField(value: unknown): string {
  const candidate = boundedString(value, 'signature');
  if (!signaturePattern.test(candidate)) throw invalidRequest('signature must be a lowercase hex HMAC-SHA256 digest');
  return candidate;
}

function refreshTokenField(value: unknown): string {
  const candidate = boundedString(value, 'refresh_token');
  if (!refreshTokenPattern.test(candidate)) throw invalidRequest('refresh_token is not a valid device session token');
  return candidate;
}

function mergedLimits(overrides: Partial<DeviceSessionLimits> | undefined): DeviceSessionLimits {
  const limits = { ...defaultDeviceSessionLimits, ...overrides };
  for (const [name, policy] of Object.entries(limits)) {
    if (name === 'accessTtlMs' || name === 'refreshTtlMs') {
      if (!Number.isSafeInteger(policy) || (policy as number) < 1) throw new Error(`${name} must be a positive safe integer`);
      continue;
    }
    const candidate = policy as DeviceSessionRateLimit;
    if (!candidate || !Number.isSafeInteger(candidate.limit) || candidate.limit < 1
      || !Number.isSafeInteger(candidate.windowMs) || candidate.windowMs < 1) throw new Error(`${name} must be a positive rate limit policy`);
  }
  return limits;
}

function clientScope(clientKey: string): string {
  return typeof clientKey === 'string' && clientKey.length > 0 && clientKey.length <= maximumClientKeyCharacters ? clientKey : 'unknown';
}

export class DeviceSessionService {
  private readonly now: () => number;
  private readonly limits: DeviceSessionLimits;
  private readonly limiter: RateLimiter;

  constructor(
    private readonly auth: AuthService,
    options: DeviceSessionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.limits = mergedLimits(options.limits);
    this.limiter = options.limiter ?? createFixedWindowRateLimiter({ now: this.now });
  }

  /**
   * Issues a single-use challenge. `binding_id` binds it to a fresh sign-in and
   * `refresh_token` binds it to the device of an active session so the client
   * can prove device possession before a refresh.
   */
  issueChallenge(input: unknown, clientKey: string): DeviceChallengeDto {
    const body = exactBody(input, [], 'device challenge request', ['binding_id', 'refresh_token']);
    const hasBinding = Object.hasOwn(body, 'binding_id');
    const hasRefresh = Object.hasOwn(body, 'refresh_token');
    if (hasBinding === hasRefresh) throw invalidRequest('device challenge request requires exactly one of binding_id or refresh_token');
    this.enforce(`challenge:client:${clientScope(clientKey)}`, this.limits.challengePerClient, 'Too many device challenge requests from this client');
    if (hasBinding) {
      const bindingId = identifierField(body.binding_id, 'binding_id');
      this.enforce(`challenge:device:${bindingId}`, this.limits.challengePerDevice, 'Too many device challenge requests for this device');
      const challenge = this.auth.issueDeviceChallenge(bindingId);
      return { challenge_id: challenge.challenge_id, challenge: challenge.challenge, expires_at: challenge.expires_at, signature_algorithm: signatureAlgorithm };
    }
    const refreshToken = refreshTokenField(body.refresh_token);
    const device = this.auth.resolveRefreshSessionDevice(refreshToken);
    this.enforce(`challenge:device:${device.device_id}`, this.limits.challengePerDevice, 'Too many device challenge requests for this device');
    const challenge = this.auth.issueSessionChallenge(refreshToken);
    return { challenge_id: challenge.challenge_id, challenge: challenge.challenge, expires_at: challenge.expires_at, signature_algorithm: signatureAlgorithm };
  }

  /** Exchanges a signed challenge for a short-lived, device-bound session. */
  createSession(input: unknown, clientKey: string): { session: DeviceSessionDto } {
    const body = exactBody(input, ['challenge_id', 'signature'], 'device session request');
    const challengeId = uuidField(body.challenge_id, 'challenge_id');
    const signature = signatureField(body.signature);
    this.enforce(`exchange:client:${clientScope(clientKey)}`, this.limits.exchangePerClient, 'Too many device session exchanges from this client');
    return { session: this.toDto(this.auth.exchangeDeviceSession(challengeId, signature, this.policy())) };
  }

  /** Rotates a session; the presented refresh token is revoked on success. */
  refreshSession(input: unknown, clientKey: string): { session: DeviceSessionDto } {
    const body = exactBody(input, ['refresh_token', 'challenge_id', 'signature'], 'device session refresh request');
    const refreshToken = refreshTokenField(body.refresh_token);
    const challengeId = uuidField(body.challenge_id, 'challenge_id');
    const signature = signatureField(body.signature);
    this.enforce(`refresh:client:${clientScope(clientKey)}`, this.limits.refreshPerClient, 'Too many device session refreshes from this client');
    const device = this.auth.resolveRefreshSessionDevice(refreshToken);
    this.enforce(`refresh:device:${device.device_id}`, this.limits.refreshPerDevice, 'Too many device session refreshes for this device');
    return { session: this.toDto(this.auth.refreshDeviceSession(refreshToken, challengeId, signature, this.policy())) };
  }

  /**
   * Revokes the session behind a refresh token, optionally revoking the whole
   * device binding. Idempotent and deny-only by design.
   */
  revokeSession(input: unknown, clientKey: string): { revoked: true; device_revoked: boolean } {
    const body = exactBody(input, ['refresh_token'], 'device session revocation request', ['revoke_device']);
    const refreshToken = refreshTokenField(body.refresh_token);
    const revokeDevice = body.revoke_device;
    if (revokeDevice !== undefined && typeof revokeDevice !== 'boolean') throw invalidRequest('revoke_device must be a boolean');
    this.enforce(`revoke:client:${clientScope(clientKey)}`, this.limits.revokePerClient, 'Too many device session revocations from this client');
    return this.auth.revokeSessionByRefreshToken(refreshToken, { revokeDevice: revokeDevice === true });
  }

  private policy(): { accessTtlMs: number; refreshTtlMs: number } {
    return { accessTtlMs: this.limits.accessTtlMs, refreshTtlMs: this.limits.refreshTtlMs };
  }

  private toDto(issued: IssuedSession): DeviceSessionDto {
    return {
      access_token: issued.session.access_token,
      refresh_token: issued.session.refresh_token,
      token_type: 'Bearer',
      expires_in: issued.session.expires_in,
      refresh_expires_in: Math.max(0, Math.floor((Date.parse(issued.refresh_expires_at) - this.now()) / 1000)),
      account_id: issued.session.account_id,
      device_id: issued.device_id,
      platform: issued.platform,
    };
  }

  private enforce(key: string, policy: DeviceSessionRateLimit, message: string): void {
    const decision = this.limiter.consume(key, policy.limit, policy.windowMs);
    if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds, message);
  }
}

export function createDeviceSessionService(
  auth: AuthService,
  options: DeviceSessionServiceOptions = {},
): DeviceSessionService {
  return new DeviceSessionService(auth, options);
}