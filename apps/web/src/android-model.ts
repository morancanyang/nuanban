import {
  ServiceFailure,
  type ConversationPort,
  type ImageQuestionInput,
  type ImageQuestionMime,
  type ImageQuestionPort,
  type ImageQuestionStatus,
} from '@nuanban/application';
import type { ConversationEvent, ServiceErrorCode } from '@nuanban/contracts';

/**
 * Android 专用模型适配器：只在 Android WebView 宿主注入 `window.nuanbanAndroidModel` 时启用。
 *
 * 边界（与 docs/implementation/android-model-and-3d-plan.md 1.2 一致）：
 * - 设备会话/令牌只存在 Android 原生加密存储，Web 侧只能调用桥接的提问/取消/状态/图片问答；
 * - 未配置、已失效、拒绝、超时一律 fail-closed，文案明确，不回退演示数据；
 * - 图片必须由原生层在本机脱敏/门控后才上传；原生拒绝时返回 REDACTION_UNAVAILABLE，Web 不重试、不改走其他上传路径。
 */

export type AndroidModelReplyCode =
  | 'INVALID_REQUEST'
  | 'CONSENT_REQUIRED'
  | 'REDACTION_UNAVAILABLE'
  | 'AUTH_FAILED'
  | 'AUTH_EXPIRED'
  | 'PERMISSION_DENIED'
  | 'RISK_PAUSED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'STREAM_INTERRUPTED'
  | 'TIMEOUT'
  | 'CANCELLED';

export interface AndroidModelStatus {
  available: boolean;
  reason: string;
  message: string;
}

export interface AndroidModelReply {
  ok: boolean;
  requestId: string;
  text?: string;
  code?: AndroidModelReplyCode;
  retryable?: boolean;
}

export interface AndroidModelBridge {
  protocolVersion?: number;
  status(): Promise<unknown>;
  answerText(input: { requestId: string; question: string }): Promise<unknown>;
  answerImage(input: { requestId: string; question: string; mime: string; base64: string; confirmed: boolean }): Promise<unknown>;
  cancel(requestId: string): Promise<boolean>;
}

declare global {
  interface Window {
    nuanbanAndroidModel?: AndroidModelBridge;
  }
}

const MESSAGES: Record<AndroidModelReplyCode, string> = {
  INVALID_REQUEST: '问题或图片不符合要求（文字 1～1500 字；图片不超过 10MB 且为 PNG/JPEG/WebP）。本次没有发送。',
  CONSENT_REQUIRED: '请先确认仅本次允许发送检查通过的脱敏图片。',
  REDACTION_UNAVAILABLE: '本机图片脱敏/门控尚未就绪，图片没有上传。请改用文字提问。',
  AUTH_FAILED: '设备会话未配置或已失效，本次没有发送。请在客户端重新完成设备绑定，不会回退演示回答。',
  AUTH_EXPIRED: '设备会话已过期，本次没有发送。客户端会尝试原生刷新；仍失败时请重新完成设备绑定。',
  PERMISSION_DENIED: '当前设备会话无权访问该会话，本次没有发送。',
  RISK_PAUSED: '问题涉及支付、密码、验证码或远程控制等高风险内容，已暂停；不会继续发送。',
  RATE_LIMITED: '请求过于频繁，请稍后手动重试；本次没有发送。',
  PROVIDER_UNAVAILABLE: 'Android 模型通道暂不可用（未接入或服务不可达），本次没有发送，不会使用演示回答。',
  STREAM_INTERRUPTED: '模型未完整返回回答，请重试；不会使用演示回答。',
  TIMEOUT: '等待模型超时，已停止请求，问题已保留。',
  CANCELLED: '本次讲解已停止。',
};

const IMAGE_MIMES: ReadonlyArray<ImageQuestionMime> = ['image/png', 'image/jpeg', 'image/webp'];
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const QUESTION_MAX_CHARS = 1500;
const REPLY_MAX_CHARS = 24000;
const STATUS_TIMEOUT_MS = 3000;
const TEXT_TIMEOUT_MS = 55000;
const IMAGE_TIMEOUT_MS = 65000;

export function androidModelBridge(
  target: Pick<Window, 'nuanbanAndroidModel'> | undefined = typeof window === 'undefined' ? undefined : window,
): AndroidModelBridge | undefined {
  const bridge = target?.nuanbanAndroidModel;
  return bridge && ['status', 'answerText', 'answerImage', 'cancel'].every(method => typeof bridge[method as keyof AndroidModelBridge] === 'function')
    ? bridge
    : undefined;
}

export function androidModelHostAvailable(): boolean {
  return androidModelBridge() !== undefined;
}

export function checkedAndroidModelStatus(value: unknown): AndroidModelStatus {
  if (!value || typeof value !== 'object') throw new ServiceFailure('PROVIDER_UNAVAILABLE', MESSAGES.PROVIDER_UNAVAILABLE, true);
  const status = value as Record<string, unknown>;
  if (typeof status.available !== 'boolean' || typeof status.reason !== 'string' || status.reason.length > 64
    || typeof status.message !== 'string' || status.message.length > 300) {
    throw new ServiceFailure('PROVIDER_UNAVAILABLE', MESSAGES.PROVIDER_UNAVAILABLE, true);
  }
  return { available: status.available, reason: status.reason, message: status.message };
}

function checkedAndroidReply(value: unknown, requestId: string): AndroidModelReply {
  if (!value || typeof value !== 'object') throw new ServiceFailure('PROVIDER_UNAVAILABLE', MESSAGES.PROVIDER_UNAVAILABLE, true);
  const reply = value as Record<string, unknown>;
  if (typeof reply.ok !== 'boolean' || reply.requestId !== requestId) {
    throw new ServiceFailure('STREAM_INTERRUPTED', MESSAGES.STREAM_INTERRUPTED, true);
  }
  if (reply.ok) {
    if (typeof reply.text !== 'string' || !reply.text.trim() || reply.text.length > REPLY_MAX_CHARS) {
      throw new ServiceFailure('STREAM_INTERRUPTED', MESSAGES.STREAM_INTERRUPTED, true);
    }
    return { ok: true, requestId, text: reply.text.trim() };
  }
  const code = typeof reply.code === 'string' && reply.code in MESSAGES ? reply.code as AndroidModelReplyCode : 'PROVIDER_UNAVAILABLE';
  return { ok: false, requestId, code, retryable: reply.retryable === true };
}

function failureFromReply(reply: AndroidModelReply): ServiceFailure {
  const code = reply.ok ? 'PROVIDER_UNAVAILABLE' : reply.code ?? 'PROVIDER_UNAVAILABLE';
  // 桥接错误码比公共契约多一个 REDACTION_UNAVAILABLE；Web 层按 fail-closed 映射为公共错误码，
  // 但保留“本机脱敏未就绪、图片未上传”的明确文案。
  const redactionBlocked = code === 'REDACTION_UNAVAILABLE';
  const mapped: ServiceErrorCode = redactionBlocked ? 'PROVIDER_UNAVAILABLE' : code;
  return new ServiceFailure(mapped, MESSAGES[code], reply.retryable === true && !redactionBlocked);
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, onTimeout: () => void, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      onTimeout();
      reject(new ServiceFailure('TIMEOUT', MESSAGES.TIMEOUT, true));
    }, timeoutMs);
    const abort = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new DOMException('已停止', 'AbortError'));
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    task.then(value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

async function readStatus(bridge: AndroidModelBridge): Promise<AndroidModelStatus> {
  try {
    return checkedAndroidModelStatus(await withTimeout(Promise.resolve().then(() => bridge.status()), STATUS_TIMEOUT_MS, () => undefined));
  } catch {
    return { available: false, reason: 'host_unavailable', message: '模型通道状态未确认，本次不会发送问题，也不会使用演示回答。' };
  }
}

/** 让共享聊天页在 Android 宿主上使用原生受限通道；不冒充 Windows 桌面 IPC。 */
export class AndroidModelConversation implements ConversationPort {
  constructor(private readonly bridge: AndroidModelBridge) {}

  async *stream(text: string, signal: AbortSignal): AsyncIterable<ConversationEvent> {
    if (signal.aborted) throw new DOMException('已停止', 'AbortError');
    if (text.trim().length < 1 || text.length > QUESTION_MAX_CHARS) {
      throw new ServiceFailure('INVALID_REQUEST', MESSAGES.INVALID_REQUEST, false);
    }
    const status = await readStatus(this.bridge);
    if (!status.available) throw new ServiceFailure('PROVIDER_UNAVAILABLE', status.message, false);
    if (signal.aborted) throw new DOMException('已停止', 'AbortError');
    const requestId = crypto.randomUUID();
    yield { type: 'started', request_id: requestId, sequence: 0 };
    let reply: AndroidModelReply;
    try {
      const raw = await withTimeout(
        Promise.resolve().then(() => this.bridge.answerText({ requestId, question: text })),
        TEXT_TIMEOUT_MS,
        () => { void this.bridge.cancel(requestId).catch(() => undefined); },
        signal,
      );
      reply = checkedAndroidReply(raw, requestId);
    } catch (error) {
      if (error instanceof ServiceFailure) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        void this.bridge.cancel(requestId).catch(() => undefined);
        throw error;
      }
      throw new ServiceFailure('PROVIDER_UNAVAILABLE', MESSAGES.PROVIDER_UNAVAILABLE, true);
    }
    if (!reply.ok || !reply.text) throw failureFromReply(reply);
    for (let offset = 0, sequence = 1; offset < reply.text.length; offset += 4000, sequence++) {
      if (signal.aborted) throw new DOMException('已停止', 'AbortError');
      yield { type: 'delta', request_id: requestId, sequence, text: reply.text.slice(offset, offset + 4000) };
    }
    yield { type: 'completed', request_id: requestId, sequence: Math.ceil(reply.text.length / 4000) + 1 };
  }
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)));
  }
  return btoa(binary);
}

/** 图片问答：发送前先取原生状态；原生门控未就绪时返回 REDACTION_UNAVAILABLE，绝不重试或改走其他上传路径。 */
export class AndroidImageQuestion implements ImageQuestionPort {
  constructor(private readonly bridge: AndroidModelBridge) {}

  async status(): Promise<ImageQuestionStatus> {
    const status = await readStatus(this.bridge);
    if (status.available) return { available: true, reason: 'ready' };
    if (status.reason === 'unconfigured' || status.reason === 'session_expired') return { available: false, reason: 'model_not_configured' };
    return { available: false, reason: 'host_unavailable' };
  }

  async answer(input: ImageQuestionInput, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new DOMException('已停止', 'AbortError');
    if (!IMAGE_MIMES.includes(input.image.type as ImageQuestionMime) || !input.image.size || input.image.size > IMAGE_MAX_BYTES) {
      throw new ServiceFailure('INVALID_REQUEST', MESSAGES.INVALID_REQUEST, false);
    }
    const status = await readStatus(this.bridge);
    if (!status.available) throw new ServiceFailure('PROVIDER_UNAVAILABLE', status.message, false);
    if (!input.confirmed) throw new ServiceFailure('CONSENT_REQUIRED', MESSAGES.CONSENT_REQUIRED, false);
    const requestId = crypto.randomUUID();
    let bytes = new Uint8Array(0);
    let base64: string;
    try {
      bytes = new Uint8Array(await withTimeout(input.image.arrayBuffer(), 5000, () => undefined, signal));
      base64 = base64FromBytes(bytes);
    } catch (error) {
      if (error instanceof ServiceFailure || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      throw new ServiceFailure('INVALID_REQUEST', MESSAGES.INVALID_REQUEST, false);
    }
    try {
      const raw = await withTimeout(
        Promise.resolve().then(() => this.bridge.answerImage({
          requestId,
          question: input.question.trim() || '请帮我看看这张图片。',
          mime: input.image.type,
          base64,
          confirmed: true,
        })),
        IMAGE_TIMEOUT_MS,
        () => { void this.bridge.cancel(requestId).catch(() => undefined); },
        signal,
      );
      const reply = checkedAndroidReply(raw, requestId);
      if (!reply.ok || !reply.text) throw failureFromReply(reply);
      return reply.text;
    } catch (error) {
      if (error instanceof ServiceFailure) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        void this.bridge.cancel(requestId).catch(() => undefined);
        throw error;
      }
      throw new ServiceFailure('PROVIDER_UNAVAILABLE', MESSAGES.PROVIDER_UNAVAILABLE, true);
    } finally {
      bytes.fill(0);
    }
  }
}
