import type { ServiceErrorCode } from '@nuanban/contracts';

export type ServerErrorCode = ServiceErrorCode;

export interface ErrorDetails {
  current_version?: number;
  conflict_id?: string;
  retry_after_seconds?: number;
}

export class DomainError extends Error {
  readonly status: number;
  readonly code: ServerErrorCode;
  readonly retryable: boolean;
  readonly details?: ErrorDetails;

  constructor(status: number, code: ServerErrorCode, message: string, retryable = false, details?: ErrorDetails) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function invalidRequest(message: string): DomainError {
  return new DomainError(400, 'INVALID_REQUEST', message);
}

export function authenticationFailed(message = 'Authentication failed'): DomainError {
  return new DomainError(401, 'AUTH_FAILED', message);
}

export function authenticationExpired(message = 'Authentication expired'): DomainError {
  return new DomainError(401, 'AUTH_EXPIRED', message);
}

export function permissionDenied(message = 'Permission denied'): DomainError {
  return new DomainError(403, 'PERMISSION_DENIED', message);
}

export function scopeDenied(message = 'Requested scope is not granted'): DomainError {
  return new DomainError(403, 'SCOPE_DENIED', message);
}

export function consentRequired(message = 'A current consent is required'): DomainError {
  return new DomainError(403, 'CONSENT_REQUIRED', message);
}

export function riskPaused(message = 'This request is paused by the local safety policy'): DomainError {
  return new DomainError(403, 'RISK_PAUSED', message);
}

export function rateLimited(retryAfterSeconds: number, message = 'Too many requests'): DomainError {
  const seconds = Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds : 1;
  return new DomainError(429, 'RATE_LIMITED', message, true, { retry_after_seconds: seconds });
}

export function providerUnavailable(message = 'The model provider is not configured'): DomainError {
  return new DomainError(503, 'PROVIDER_UNAVAILABLE', message, false);
}

