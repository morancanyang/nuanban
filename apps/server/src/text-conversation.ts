import { randomUUID } from 'node:crypto';
import type { ConversationMessageDto, Mode, ServiceStreamEvent } from '@nuanban/contracts';
import type { AuthenticatedSession } from './auth.ts';
import { invalidRequest, permissionDenied } from './errors.ts';

export type TextProviderFailureCode = 'AUTH_FAILED' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'TIMEOUT' | 'CANCELLED' | 'STREAM_INTERRUPTED';

export class TextProviderFailure extends Error {
  constructor(public readonly code: TextProviderFailureCode, public readonly retryable = false) {
    super(code);
    this.name = 'TextProviderFailure';
  }
}

export interface TextConversationProvider {
  answer(input: { question: string; mode: Mode; signal: AbortSignal }): Promise<{ text: string }>;
}

export interface TextProviderOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface TextConversationOptions {
  provider?: TextConversationProvider;
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  retentionMs?: number;
  now?: () => number;
}

export interface ConversationCreateResult { session_id: string; }
export interface ConversationResponseResult { request_id: string; stream_path: string; }
export interface ConversationMessagePage { items: ConversationMessageDto[]; next_cursor: string | null; }

interface ConversationRecord {
  sessionId: string;
  accountId: string;
  mode: Mode;
  messages: ConversationMessageDto[];
  requestByInput: Map<string, string>;
}

interface RequestRecord {
  requestId: string;
  session: ConversationRecord;
  question: string;
  generation: number;
  events: ServiceStreamEvent[];
  waiters: Set<() => void>;
  controller: AbortController;
  done: boolean;
  cancelled: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u;
const maximumAnswerLength = 24_000;
const maximumResponseBytes = 192 * 1024;
const defaultTimeoutMs = 45_000;
const defaultRetentionMs = 5 * 60_000;

function isMode(value: unknown): value is Mode {
  return value === 'elder' || value === 'child' || value === 'accessible';
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

function providerUnavailable(): TextProviderFailure {
  return new TextProviderFailure('PROVIDER_UNAVAILABLE', true);
}

function checkedProviderConfiguration(options: TextProviderOptions): { endpoint: string; model: string; apiKey: string } {
  if (!options.baseUrl || options.baseUrl.length > 2048 || options.baseUrl !== options.baseUrl.trim()
    || !modelPattern.test(options.model) || !options.apiKey || options.apiKey.length < 10 || options.apiKey.length > 4096
    || /[\s\x00-\x1f]/u.test(options.apiKey)) throw providerUnavailable();
  let endpoint: URL;
  try { endpoint = new URL(options.baseUrl); } catch { throw providerUnavailable(); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.protocol !== 'https:') throw providerUnavailable();
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '');
  if (!endpoint.pathname.endsWith('/chat/completions')) endpoint.pathname += '/chat/completions';
  return { endpoint: endpoint.href, model: options.model, apiKey: options.apiKey };
}

async function readProviderResponse(response: Response, signal: AbortSignal): Promise<{ text: string }> {
  if (!response.body) throw providerUnavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumResponseBytes) throw providerUnavailable();
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))); }
  catch { throw new TextProviderFailure('PROVIDER_UNAVAILABLE', true); }
  const choice = (parsed as { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }> } | null)?.choices?.[0];
  const text = choice?.message?.content;
  if (!choice || choice.finish_reason !== 'stop' || typeof text !== 'string' || !text.trim() || text.length > maximumAnswerLength) throw new TextProviderFailure('STREAM_INTERRUPTED', true);
  return { text: text.trim() };
}

export function createOpenAiCompatibleTextProvider(options: TextProviderOptions): TextConversationProvider {
  const configuration = checkedProviderConfiguration(options);
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (typeof fetchRequest !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw providerUnavailable();
  return Object.freeze({
    async answer(input: { question: string; mode: Mode; signal: AbortSignal }): Promise<{ text: string }> {
      if (!input.question.trim() || input.question.length > 1500) throw new TextProviderFailure('PROVIDER_UNAVAILABLE');
      if (input.signal.aborted) throw new TextProviderFailure('CANCELLED');
      const controller = new AbortController();
      let timedOut = false;
      const abortFromCaller = () => controller.abort();
      input.signal.addEventListener('abort', abortFromCaller, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      const body = JSON.stringify({
        model: configuration.model,
        stream: false,
        store: false,
        n: 1,
        messages: [
          { role: 'system', content: '你是微光指引公益助手，用简洁、温和的中文逐步解释。用户亲手操作，你只能指路，不能声称已执行、已看到屏幕或已完成任务。没有提供图片时不得假装看见画面。不得索取密码、验证码、支付、转账或私人信息，不提供医疗诊断或投资决策。遇到不确定先询问，不编造功能、实时数据或学习结果。' },
          { role: 'user', content: input.question.trim() },
        ],
      });
      try {
        const response = await fetchRequest(configuration.endpoint, {
          method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
          headers: { authorization: `Bearer ${configuration.apiKey}`, 'content-type': 'application/json', accept: 'application/json' }, body,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          if ([401, 403].includes(response.status)) throw new TextProviderFailure('AUTH_FAILED');
          if (response.status === 429) throw new TextProviderFailure('RATE_LIMITED', true);
          throw new TextProviderFailure('PROVIDER_UNAVAILABLE', response.status >= 500);
        }
        return await readProviderResponse(response, controller.signal);
      } catch (error) {
        if (input.signal.aborted) throw new TextProviderFailure('CANCELLED');
        if (timedOut) throw new TextProviderFailure('TIMEOUT', true);
        if (error instanceof TextProviderFailure) throw error;
        throw new TextProviderFailure('PROVIDER_UNAVAILABLE', true);
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener('abort', abortFromCaller);
      }
    },
  });
}

function configuredProvider(options: TextConversationOptions): TextConversationProvider {
  const env = options.env ?? process.env;
  const baseUrl = env.NUANBAN_AI_BASE_URL;
  const model = env.NUANBAN_AI_MODEL;
  const apiKey = env.NUANBAN_AI_API_KEY;
  if (!baseUrl && !model && !apiKey) return { answer: async () => { throw providerUnavailable(); } };
  try {
    return createOpenAiCompatibleTextProvider({ baseUrl: baseUrl ?? '', model: model ?? '', apiKey: apiKey ?? '', fetch: options.fetch, timeoutMs: options.timeoutMs });
  } catch {
    return { answer: async () => { throw providerUnavailable(); } };
  }
}

function failureEventCode(error: unknown): { code: 'TIMEOUT' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE'; retryable: boolean } {
  if (error instanceof TextProviderFailure) {
    if (error.code === 'TIMEOUT') return { code: 'TIMEOUT', retryable: true };
    if (error.code === 'RATE_LIMITED') return { code: 'RATE_LIMITED', retryable: error.retryable };
    return { code: 'PROVIDER_UNAVAILABLE', retryable: error.retryable };
  }
  return { code: 'PROVIDER_UNAVAILABLE', retryable: true };
}

function aborted(signal: AbortSignal): DOMException {
  return new DOMException(signal.reason instanceof Error ? signal.reason.message : '请求已取消', 'AbortError');
}

export class TextConversationService {
  private readonly provider: TextConversationProvider;
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly requests = new Map<string, RequestRecord>();

  constructor(options: TextConversationOptions = {}) {
    this.provider = options.provider ?? configuredProvider(options);
    this.now = options.now ?? (() => Date.now());
    this.retentionMs = options.retentionMs ?? defaultRetentionMs;
  }

  create(actor: AuthenticatedSession, mode: unknown): ConversationCreateResult {
    if (!isMode(mode)) throw invalidRequest('mode must be elder, child, or accessible');
    const sessionId = randomUUID();
    this.conversations.set(sessionId, { sessionId, accountId: actor.account_id, mode, messages: [], requestByInput: new Map() });
    return { session_id: sessionId };
  }

  messages(actor: AuthenticatedSession, sessionId: string): ConversationMessagePage {
    const session = this.getConversation(actor, sessionId);
    return { items: structuredClone(session.messages), next_cursor: null };
  }

  assertRequest(actor: AuthenticatedSession, requestId: string): void {
    this.getRequest(actor, requestId);
  }

  respond(actor: AuthenticatedSession, sessionId: string, input: Record<string, unknown>): ConversationResponseResult {
    const session = this.getConversation(actor, sessionId);
    const inputId = input.input_id;
    const text = input.text;
    const generation = input.generation;
    if (!isIdentifier(inputId)) throw invalidRequest('input_id must be a UUID');
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) throw invalidRequest('generation must be a non-negative integer');
    if (typeof text !== 'string' || !text.trim() || text.length > 1500) throw invalidRequest('text must contain 1 to 1500 characters');
    if (input.media_refs !== undefined) throw invalidRequest('media_refs are not supported by the text conversation route');
    const existingId = session.requestByInput.get(inputId);
    if (existingId) {
      const existing = this.requests.get(existingId);
      if (existing && (existing.question !== text.trim() || existing.generation !== generation)) throw invalidRequest('input_id was already used for a different request');
      if (existing) return { request_id: existing.requestId, stream_path: `/v1/requests/${existing.requestId}/events` };
    }
    const request: RequestRecord = { requestId: randomUUID(), session, question: text.trim(), generation, events: [], waiters: new Set(), controller: new AbortController(), done: false, cancelled: false };
    session.requestByInput.set(inputId, request.requestId);
    session.messages.push({ message_id: randomUUID(), role: 'user', text: request.question, state: 'completed', created_at: this.instant() });
    this.requests.set(request.requestId, request);
    void this.run(request);
    return { request_id: request.requestId, stream_path: `/v1/requests/${request.requestId}/events` };
  }

  cancel(actor: AuthenticatedSession, requestId: string): { status: 'cancelled' } {
    const request = this.getRequest(actor, requestId);
    if (!request.done) {
      request.cancelled = true;
      request.controller.abort();
      request.session.messages.push({ message_id: randomUUID(), role: 'assistant', text: '本次讲解已停止。', state: 'cancelled', created_at: this.instant() });
      this.publish(request, 'response.cancelled', { reason: 'user_stop' });
      this.finish(request);
    }
    return { status: 'cancelled' };
  }

  async *readEvents(actor: AuthenticatedSession, requestId: string, signal: AbortSignal): AsyncIterable<ServiceStreamEvent> {
    const request = this.getRequest(actor, requestId);
    let offset = 0;
    while (true) {
      if (signal.aborted) throw aborted(signal);
      while (offset < request.events.length) yield request.events[offset++];
      if (request.done) return;
      await this.waitForUpdate(request, signal);
    }
  }

  private async run(request: RequestRecord): Promise<void> {
    this.publish(request, 'response.started', {});
    try {
      const result = await this.provider.answer({ question: request.question, mode: request.session.mode, signal: request.controller.signal });
      if (request.cancelled || request.controller.signal.aborted) return;
      if (!result || typeof result.text !== 'string' || !result.text.trim() || result.text.length > maximumAnswerLength) throw new TextProviderFailure('STREAM_INTERRUPTED', true);
      const answer = result.text.trim();
      let index = 0;
      for (let offset = 0; offset < answer.length; offset += 4000) {
        if (request.cancelled || request.controller.signal.aborted) return;
        this.publish(request, 'caption.segment', { segment_id: randomUUID(), index, text: answer.slice(offset, offset + 4000) });
        index++;
      }
      request.session.messages.push({ message_id: randomUUID(), role: 'assistant', text: answer, state: 'completed', created_at: this.instant() });
      this.publish(request, 'response.completed', { final_segment_count: index });
      this.finish(request);
    } catch (error) {
      if (request.cancelled || request.controller.signal.aborted) return;
      request.session.messages.push({ message_id: randomUUID(), role: 'assistant', text: '', state: 'interrupted', created_at: this.instant() });
      this.publish(request, 'response.failed', failureEventCode(error));
      this.finish(request);
    }
  }

  private publish(request: RequestRecord, type: ServiceStreamEvent['type'], payload: ServiceStreamEvent['payload']): void {
    const event = { request_id: request.requestId, session_id: request.session.sessionId, event_id: randomUUID(), seq: request.events.length, generation: request.generation, type, payload } as ServiceStreamEvent;
    request.events.push(event);
    for (const wake of request.waiters) wake();
    request.waiters.clear();
  }

  private finish(request: RequestRecord): void {
    if (request.done) return;
    request.done = true;
    for (const wake of request.waiters) wake();
    request.waiters.clear();
    request.cleanupTimer = setTimeout(() => this.requests.delete(request.requestId), this.retentionMs);
    const timer = request.cleanupTimer as NodeJS.Timeout;
    if (typeof timer.unref === 'function') timer.unref();
  }

  private waitForUpdate(request: RequestRecord, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(aborted(signal));
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const onAbort = () => { request.waiters.delete(wake); cleanup(); reject(aborted(signal)); };
      const wake = () => { request.waiters.delete(wake); cleanup(); resolve(); };
      request.waiters.add(wake);
      signal.addEventListener('abort', onAbort, { once: true });
      if (request.done) wake();
    });
  }

  private getConversation(actor: AuthenticatedSession, sessionId: string): ConversationRecord {
    if (!isIdentifier(sessionId)) throw invalidRequest('conversation id must be a UUID');
    const session = this.conversations.get(sessionId);
    if (!session || session.accountId !== actor.account_id) throw permissionDenied('Conversation is not available to this account');
    return session;
  }

  private getRequest(actor: AuthenticatedSession, requestId: string): RequestRecord {
    if (!isIdentifier(requestId)) throw invalidRequest('request id must be a UUID');
    const request = this.requests.get(requestId);
    if (!request || request.session.accountId !== actor.account_id) throw permissionDenied('Request is not available to this account');
    return request;
  }

  private instant(): string { return new Date(this.now()).toISOString(); }
}

export function createTextConversationService(options: TextConversationOptions = {}): TextConversationService {
  return new TextConversationService(options);
}
