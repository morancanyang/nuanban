import { createServer as createNodeServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { schemaVersion as contractVersion } from '../../../packages/contracts/src/spec/primitives.ts';
import type { Scope } from '@nuanban/contracts';
import { AuthService, type AuthenticatedSession, type AuthOptions, type Clock } from './auth.ts';
import { DeviceSessionService, type DeviceSessionServiceOptions } from './device-session.ts';
import { DomainError, authenticationFailed, invalidRequest } from './errors.ts';
import { FamilyService, type FamilyOptions } from './family.ts';
import { createInMemoryRepositories, type ServerRepositories } from './repositories.ts';
import { createSqliteRepositories, defaultSqlitePath } from './sqlite.ts';
import { dispatchServiceRoute, type ServerServiceModules } from './service-modules.ts';
import { readIfMatch as ifMatch } from './versioning.ts';
import { createStandaloneGuidanceService, StandaloneGuidanceError, type StandaloneGuidanceService } from './standalone-guidance.ts';
import { createDesktopVoiceService, type DesktopVoiceService } from './desktop-voice.ts';
import { createTextConversationService, type TextConversationService } from './text-conversation.ts';

export type ServerStorageOptions =
  | { kind: 'memory' }
  | { kind: 'sqlite'; path?: string; environment?: string };

export interface RequestHookContext {
  requestId: string;
  method: string;
  url: string;
  path: string[];
  body: Record<string, unknown>;
  request: IncomingMessage;
  actor?: AuthenticatedSession;
  extensions: Record<string, unknown>;
}

export interface AuthActorHookContext extends RequestHookContext {
  bearerToken: string;
  authenticate: () => AuthenticatedSession;
}

export interface ResponseHookContext {
  request: IncomingMessage;
  response: ServerResponse;
  requestId: string;
  status: number;
  body: unknown;
  actor?: AuthenticatedSession;
  extensions: Record<string, unknown>;
}

export interface RouteHookContext extends RequestHookContext {
  getActor: () => Promise<AuthenticatedSession>;
  respond: (status: number, data: unknown) => Promise<void>;
}

export type RouteHookResult = void | true | { status: number; data: unknown };

export interface ServerHooks {
  onRequest?: (context: RequestHookContext) => void | Promise<void>;
  resolveActor?: (context: AuthActorHookContext) => AuthenticatedSession | Promise<AuthenticatedSession>;
  onRoute?: (context: RouteHookContext) => RouteHookResult | Promise<RouteHookResult>;
  onResponse?: (context: ResponseHookContext) => void | Promise<void>;
}

export interface ServerOptions {
  repositories?: ServerRepositories;
  storage?: ServerStorageOptions;
  clock?: Clock;
  auth?: Omit<AuthOptions, 'now'>;
  family?: Omit<FamilyOptions, 'now'>;
  hooks?: ServerHooks;
  modules?: ServerServiceModules;
  standaloneGuidance?: StandaloneGuidanceService;
  desktopVoice?: DesktopVoiceService;
  textConversation?: TextConversationService;
  deviceSessions?: DeviceSessionService;
  deviceSession?: Omit<DeviceSessionServiceOptions, 'now'>;
  webOrigins?: readonly string[];
  /**
   * Only enable behind a reverse proxy that overwrites X-Forwarded-For.
   * Otherwise rate limiting keys on the socket address.
   */
  trustProxyHeaders?: boolean;
}

export interface ServerApplication {
  server: Server;
  auth: AuthService;
  family: FamilyService;
  repositories: ServerRepositories;
  modules?: ServerServiceModules;
  textConversation: TextConversationService;
  deviceSessions: DeviceSessionService;
}

const maxBodyBytes = 1024 * 1024;
const imageQuestionBodyBytes = 3 * 1024 * 1024;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const corsAllowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const corsAllowedHeaders = ['Authorization', 'Content-Type', 'Accept', 'X-Request-ID', 'Idempotency-Key', 'If-Match'] as const;
const corsAllowedHeaderNames = new Set(corsAllowedHeaders.map(header => header.toLowerCase()));

function normalizeWebOrigins(origins: readonly string[] | undefined): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const rawOrigin of origins ?? []) {
    const value = rawOrigin.trim();
    if (!value) continue;
    if (value === '*') throw new Error('NUANBAN_WEB_ORIGINS does not allow the wildcard origin');
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error(`Invalid web origin: ${value}`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error(`Invalid web origin: ${value}`);
    }
    normalized.add(parsed.origin);
  }
  return normalized;
}

function allowedOrigin(request: IncomingMessage, origins: ReadonlySet<string>): string | null {
  const value = request.headers.origin;
  if (typeof value !== 'string' || value === 'null') return null;
  try {
    const origin = new URL(value).origin;
    return origins.has(origin) ? origin : null;
  } catch {
    return null;
  }
}

function applyCors(response: ServerResponse, origin: string | null): void {
  if (!origin) return;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Methods', corsAllowedMethods.join(', '));
  response.setHeader('Access-Control-Allow-Headers', corsAllowedHeaders.join(', '));
  response.setHeader('Access-Control-Expose-Headers', 'X-Request-ID, ETag');
  response.setHeader('Access-Control-Max-Age', '600');
  response.setHeader('Vary', 'Origin');
}

function validPreflight(request: IncomingMessage): boolean {
  const method = request.headers['access-control-request-method'];
  if (typeof method === 'string' && !corsAllowedMethods.includes(method.toUpperCase() as typeof corsAllowedMethods[number])) return false;
  const headers = request.headers['access-control-request-headers'];
  if (typeof headers !== 'string') return true;
  return headers.split(',').map(header => header.trim().toLowerCase()).filter(Boolean).every(header => corsAllowedHeaderNames.has(header));
}

function requestId(request: IncomingMessage): string {
  const candidate = request.headers['x-request-id'];
  return typeof candidate === 'string' && requestIdPattern.test(candidate) ? candidate : randomUUID();
}

function send(response: ServerResponse, status: number, requestIdValue: string, data: unknown, version?: number): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('x-request-id', requestIdValue);
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const currentVersion = version ?? record.version ?? record.grant_revision;
  if (typeof currentVersion === 'number' && Number.isSafeInteger(currentVersion) && currentVersion > 0) response.setHeader('ETag', `"${currentVersion}"`);
  response.end(JSON.stringify({ data, request_id: requestIdValue, schema_version: contractVersion }));
}

function errorPayload(error: DomainError | StandaloneGuidanceError): { error: { code: string; message: string; retryable: boolean; details?: DomainError['details'] } } {
  const errorBody: { code: string; message: string; retryable: boolean; details?: DomainError['details'] } = { code: error.code, message: error.message, retryable: error.retryable };
  if ('details' in error && error.details) errorBody.details = error.details;
  return { error: errorBody };
}

function sendError(response: ServerResponse, status: number, requestIdValue: string, error: DomainError | StandaloneGuidanceError): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('x-request-id', requestIdValue);
  if ('details' in error && error.details?.retry_after_seconds) response.setHeader('retry-after', String(error.details.retry_after_seconds));
  response.end(JSON.stringify({ ...errorPayload(error), request_id: requestIdValue, schema_version: contractVersion }));
}

async function notifyResponse(hooks: ServerHooks | undefined, context: RequestHookContext, response: ServerResponse, status: number, body: unknown): Promise<void> {
  try {
    await hooks?.onResponse?.({ request: context.request, response, requestId: context.requestId, status, body, actor: context.actor, extensions: context.extensions });
  } catch {
  }
}

async function readBody(request: IncomingMessage, limit = maxBodyBytes): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) throw invalidRequest('Request body is too large');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw invalidRequest('Request body must be valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest('Request body must be an object');
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) throw invalidRequest(`${name} must be a non-empty string`);
  return value;
}

function scopesField(body: Record<string, unknown>, name: string): Scope[] {
  const value = body[name];
  if (!Array.isArray(value) || value.some(scope => typeof scope !== 'string')) throw invalidRequest(`${name} must be an array of scopes`);
  return value as Scope[];
}

function bearer(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) throw authenticationFailed('Bearer access token is required');
  const token = value.slice('Bearer '.length);
  if (!token) throw authenticationFailed('Bearer access token is required');
  return token;
}

function pathParts(url: string): string[] {
  return url.split('?')[0].split('/').filter(Boolean);
}

/**
 * Rate-limit scope for unauthenticated routes. The socket address is used by
 * default; X-Forwarded-For is honoured only when the deployment explicitly
 * declares a trusted reverse proxy, and only for a bare IP value.
 */
function clientKey(request: IncomingMessage, trustProxyHeaders: boolean): string {
  if (trustProxyHeaders) {
    const forwarded = request.headers['x-forwarded-for'];
    const candidate = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;
    if (candidate && isIP(candidate) !== 0) return candidate;
  }
  const address = request.socket.remoteAddress;
  return typeof address === 'string' && address.length > 0 ? address : 'unknown';
}

export function createApplication(options: ServerOptions = {}): ServerApplication {
  const repositories = options.repositories ?? (options.storage?.kind === 'sqlite'
    ? createSqliteRepositories({
      path: options.storage.path ?? defaultSqlitePath(options.storage.environment ?? process.env.NUANBAN_SERVER_ENV ?? process.env.NODE_ENV ?? 'development'),
      environment: options.storage.environment ?? process.env.NUANBAN_SERVER_ENV ?? process.env.NODE_ENV ?? 'development',
    })
    : createInMemoryRepositories());
  const now = options.clock;
  const auth = new AuthService(repositories, { ...options.auth, now });
  const family = new FamilyService(repositories, { ...options.family, now });
  const standaloneGuidance = options.standaloneGuidance ?? createStandaloneGuidanceService();
  const desktopVoice = options.desktopVoice ?? createDesktopVoiceService();
  const textConversation = options.textConversation ?? createTextConversationService();
  const deviceSessions = options.deviceSessions ?? new DeviceSessionService(auth, { ...options.deviceSession, now });
  const webOrigins = normalizeWebOrigins(options.webOrigins);
  const trustProxyHeaders = options.trustProxyHeaders ?? (process.env.NUANBAN_TRUST_PROXY_HEADERS === 'true');

  const server = createNodeServer(async (request, response) => {
    const correlationId = requestId(request);
    const method = request.method ?? 'GET';
    const url = request.url ?? '/';
    const origin = allowedOrigin(request, webOrigins);
    applyCors(response, origin);
    response.setHeader('x-request-id', correlationId);
    if (method === 'OPTIONS') {
      if (request.headers.origin && !origin) {
        response.statusCode = 403;
        response.end();
        return;
      }
      if (!validPreflight(request)) {
        response.statusCode = 400;
        response.end();
        return;
      }
      response.statusCode = 204;
      response.end();
      return;
    }
    const parts = pathParts(url);
    const isStandaloneGuidance = method === 'POST' && parts.join('/') === 'v1/standalone/guidance/analyze';
    const isVoiceStatus = method === 'GET' && parts.join('/') === 'internal/desktop/voice/status';
    const isVoiceCall = method === 'POST' && parts.join('/') === 'internal/desktop/voice/call';
    const isDesktopVoice = isVoiceStatus || isVoiceCall;
    const isImageResponse = method === 'POST' && parts[0] === 'v1' && parts[1] === 'conversations' && !!parts[2] && parts[3] === 'image-responses';
    const isDeviceSession = method === 'POST' && parts[0] === 'v1' && parts[1] === 'device-sessions';
    const context: RequestHookContext = { requestId: correlationId, method, url, path: parts, body: {}, request, extensions: {} };
    const hookContext = isStandaloneGuidance ? { ...context, body: { standalone_guidance: true } }
      : isDesktopVoice ? { ...context, body: { desktop_voice: true } }
        : isImageResponse ? { ...context, body: { image_response: true } }
          : isDeviceSession ? { ...context, body: { device_session: true } } : context;
    try {
      context.body = method === 'GET' || method === 'DELETE' ? {}
        : await readBody(request, isStandaloneGuidance ? 3 * 1024 * 1024 : isImageResponse ? imageQuestionBodyBytes : isVoiceCall ? 96 * 1024 : maxBodyBytes);
      await options.hooks?.onRequest?.(hookContext);
      const emit = async (status: number, data: unknown, version?: number): Promise<void> => {
        const envelope = { data, request_id: hookContext.requestId, schema_version: contractVersion };
        // Sessions, image bytes and desktop voice payloads stay out of generic
        // hooks so deployment instrumentation cannot log credentials.
        const hooked = isDesktopVoice ? { desktop_voice: true, request_id: hookContext.requestId }
          : isDeviceSession ? { device_session: true, request_id: hookContext.requestId } : envelope;
        await notifyResponse(options.hooks, hookContext, response, status, hooked);
        send(response, status, context.requestId, data, version);
      };
      const actor = async (): Promise<AuthenticatedSession> => {
        if (context.actor) return context.actor;
        const token = bearer(request);
        const authenticate = () => auth.authenticateAccessToken(token);
        const resolved = options.hooks?.resolveActor
          ? await options.hooks.resolveActor({ ...hookContext, bearerToken: token, authenticate })
          : authenticate();
        if (!resolved) throw authenticationFailed('Authenticated actor is required');
        context.actor = resolved;
        hookContext.actor = resolved;
        return resolved;
      };
      const routeResult = await options.hooks?.onRoute?.({ ...hookContext, getActor: actor, respond: emit });
      if (routeResult === true) return;
      if (routeResult && typeof routeResult === 'object') {
        await emit(routeResult.status, routeResult.data);
        return;
      }

      if (isDesktopVoice) {
        const session = await actor();
        response.setHeader('cache-control', 'no-store');
        if (isVoiceStatus) {
          await emit(200, desktopVoice.status());
          return;
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once('aborted', abort);
        response.once('close', abort);
        if (request.aborted || response.destroyed) controller.abort();
        try {
          const result = await desktopVoice.connect(context.body, session, { signal: controller.signal });
          if (!controller.signal.aborted && !response.destroyed) await emit(200, result);
        } finally {
          request.removeListener('aborted', abort);
          response.removeListener('close', abort);
        }
        return;
      }

      if (isStandaloneGuidance) {
        const session = await actor();
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once('aborted', abort);
        response.once('close', abort);
        if (request.aborted || response.destroyed) controller.abort();
        try {
          const result = await standaloneGuidance.analyze(context.body, session, { signal: controller.signal });
          if (!controller.signal.aborted && !response.destroyed) await emit(200, result);
        } finally {
          request.removeListener('aborted', abort);
          response.removeListener('close', abort);
        }
        return;
      }

      if (method === 'GET' && parts[0] === 'v1' && parts[1] === 'requests' && parts[2] && parts[3] === 'events') {
        const session = await actor();
        textConversation.assertRequest(session, parts[2]);
        const controller = new AbortController();
        const abort = () => controller.abort();
        request.once('aborted', abort);
        response.once('close', abort);
        if (request.aborted || response.destroyed) controller.abort();
        response.statusCode = 200;
        response.setHeader('content-type', 'text/event-stream; charset=utf-8');
        response.setHeader('cache-control', 'no-cache, no-store');
        response.setHeader('connection', 'keep-alive');
        response.setHeader('x-request-id', context.requestId);
        try {
          for await (const event of textConversation.readEvents(session, parts[2], controller.signal)) {
            if (controller.signal.aborted || response.destroyed) break;
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          if (!controller.signal.aborted && !response.destroyed) response.end();
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          request.removeListener('aborted', abort);
          response.removeListener('close', abort);
        }
        return;
      }

      if (method === 'POST' && parts.join('/') === 'v1/conversations') {
        await emit(201, textConversation.create(await actor(), context.body.mode));
        return;
      }
      if (method === 'GET' && parts[0] === 'v1' && parts[1] === 'conversations' && parts[2] && parts[3] === 'messages') {
        await emit(200, textConversation.messages(await actor(), parts[2]));
        return;
      }
      if (method === 'POST' && parts[0] === 'v1' && parts[1] === 'conversations' && parts[2] && parts[3] === 'responses') {
        await emit(201, textConversation.respond(await actor(), parts[2], context.body));
        return;
      }
      if (method === 'POST' && parts[0] === 'v1' && parts[1] === 'conversations' && parts[2] && parts[3] === 'image-responses') {
        await emit(201, textConversation.respondImage(await actor(), parts[2], context.body));
        return;
      }
      if (method === 'POST' && parts[0] === 'v1' && parts[1] === 'requests' && parts[2] && parts[3] === 'cancel') {
        await emit(200, textConversation.cancel(await actor(), parts[2]));
        return;
      }

      if (await dispatchServiceRoute({ method, url, parts, body: context.body, request, modules: options.modules, getActor: actor, emit })) return;

      if (method === 'GET' && url.split('?')[0] === '/healthz') {
        await emit(200, { status: 'ok', service: 'nuanban-server', storage: repositories instanceof Object && 'storage' in repositories ? repositories.storage : 'memory' });
        return;
      }

      if (method === 'POST' && parts.join('/') === 'v1/device-sessions/challenges') {
        await emit(201, deviceSessions.issueChallenge(context.body, clientKey(request, trustProxyHeaders)));
        return;
      }
      if (method === 'POST' && parts.join('/') === 'v1/device-sessions') {
        await emit(201, deviceSessions.createSession(context.body, clientKey(request, trustProxyHeaders)));
        return;
      }
      if (method === 'POST' && parts.join('/') === 'v1/device-sessions/refresh') {
        await emit(201, deviceSessions.refreshSession(context.body, clientKey(request, trustProxyHeaders)));
        return;
      }
      if (method === 'POST' && parts.join('/') === 'v1/device-sessions/revoke') {
        await emit(200, deviceSessions.revokeSession(context.body, clientKey(request, trustProxyHeaders)));
        return;
      }
      if (method === 'POST' && parts.join('/') === 'v1/auth/device-challenges') {
        await emit(201, auth.issueDeviceChallenge(stringField(context.body, 'binding_id')));
        return;
      }
      if (method === 'POST' && parts.join('/') === 'v1/auth/device-exchange') {
        await emit(201, auth.exchangeDeviceChallenge(stringField(context.body, 'challenge_id'), stringField(context.body, 'signature')));
        return;
      }
      if (method === 'POST' && parts.join('/') === 'v1/auth/refresh') {
        await emit(201, auth.refreshSession(stringField(context.body, 'refresh_token')));
        return;
      }

      if (method === 'DELETE' && parts[0] === 'v1' && parts[1] === 'devices' && parts[2]) {
        await emit(200, auth.revokeDevice((await actor()).account_id, parts[2]));
        return;
      }
      if (method === 'POST' && parts.join('/') === 'v1/relations/invitations') {
        const session = await actor();
        await emit(201, family.invite(session.account_id, { helper_ref: stringField(context.body, 'helper_ref'), requested_scopes: scopesField(context.body, 'requested_scopes') }));
        return;
      }
      if (method === 'POST' && parts[0] === 'v1' && parts[1] === 'relations' && parts[2] && parts[3] === 'accept') {
        const session = await actor();
        await emit(201, family.accept(session.account_id, parts[2], { consent_id: stringField(context.body, 'consent_id'), scopes: scopesField(context.body, 'scopes') }));
        return;
      }
      if (method === 'GET' && parts.join('/') === 'v1/relations') {
        await emit(200, { items: family.list((await actor()).account_id), next_cursor: null });
        return;
      }
      if (method === 'PATCH' && parts[0] === 'v1' && parts[1] === 'relations' && parts[2] && parts[3] === 'grants') {
        const session = await actor();
        await emit(200, family.updateGrants(session.account_id, parts[2], scopesField(context.body, 'scopes'), stringField(context.body, 'consent_id'), ifMatch(request)));
        return;
      }
      if (method === 'DELETE' && parts[0] === 'v1' && parts[1] === 'relations' && parts[2]) {
        const session = await actor();
        await emit(200, family.revoke(session.account_id, parts[2]));
        return;
      }
      if (method === 'POST' && parts.join('/') === 'v1/consents') {
        const session = await actor();
        const purpose = stringField(context.body, 'purpose') as Parameters<FamilyService['createConsent']>[1]['purpose'];
        await emit(201, family.createConsent(session.account_id, { purpose, scopes: scopesField(context.body, 'scopes'), notice_version: stringField(context.body, 'notice_version'), subject_id: stringField(context.body, 'subject_id') }));
        return;
      }
      if (method === 'POST' && parts[0] === 'v1' && parts[1] === 'consents' && parts[2] && parts[3] === 'withdraw') {
        await emit(201, family.withdrawConsent((await actor()).account_id, parts[2]));
        return;
      }
      throw new DomainError(404, 'INVALID_REQUEST', 'Route not found');
    } catch (error) {
      const normalized = error instanceof DomainError || error instanceof StandaloneGuidanceError ? error : new DomainError(500, 'PARTIAL_FAILURE', 'Internal server error', true);
      const envelope = { ...errorPayload(normalized), request_id: context.requestId, schema_version: contractVersion };
      await notifyResponse(options.hooks, context, response, normalized.status, envelope);
      sendError(response, normalized.status, correlationId, normalized);
    }
  });

  return { server, auth, family, repositories, modules: options.modules, textConversation, deviceSessions };
}

export function createServer(options: ServerOptions = {}): Server {
  return createApplication(options).server;
}
