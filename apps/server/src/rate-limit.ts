/**
 * Bounded in-memory fixed-window rate limiting for the controlled device-session
 * and image-question routes.
 *
 * The limiter is deliberately dependency-free and process-local: it bounds abuse
 * and provider cost on a single server process. It is not a distributed quota and
 * it resets on restart; both limits are documented in
 * docs/implementation/android-model-access.md.
 */

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): RateLimitDecision;
}

export interface RateLimiterOptions {
  now?: () => number;
  maximumKeys?: number;
}

interface WindowRecord {
  count: number;
  resetAt: number;
}

export const defaultMaximumRateLimitKeys = 10_000;
const maximumKeyCharacters = 256;

export function createFixedWindowRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const maximumKeys = options.maximumKeys ?? defaultMaximumRateLimitKeys;
  if (!Number.isSafeInteger(maximumKeys) || maximumKeys < 1) throw new Error('maximumKeys must be a positive safe integer');
  const windows = new Map<string, WindowRecord>();
  return {
    consume(key: string, limit: number, windowMs: number): RateLimitDecision {
      if (typeof key !== 'string' || key.length === 0 || key.length > maximumKeyCharacters) {
        throw new Error('Rate limit key must be a bounded non-empty string');
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
        throw new Error('Rate limit policy must use positive safe integers');
      }
      const instant = now();
      const existing = windows.get(key);
      if (existing && existing.resetAt > instant) {
        if (existing.count >= limit) {
          return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - instant) / 1000)) };
        }
        existing.count += 1;
        return { allowed: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
      }
      if (!existing && windows.size >= maximumKeys) {
        for (const [candidate, record] of windows) {
          if (record.resetAt <= instant) windows.delete(candidate);
        }
        // Fail closed: an unknown key is refused rather than dropping another
        // caller's window, so a key flood cannot reset real limits.
        if (windows.size >= maximumKeys) return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)) };
      }
      windows.set(key, { count: 1, resetAt: instant + windowMs });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
    },
  };
}