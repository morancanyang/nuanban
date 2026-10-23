import type { Note, Todo, Preferences, Family, OutboxEntry, LocalConflict, ConflictChoice } from '@nuanban/domain';
import { contractVersion, isConversationEvent, type ConversationEvent, type ServiceErrorCode, type ServiceErrorEnvelope } from '@nuanban/contracts';
export type * from './image-question';
export type * from './text-question';
export interface LocalSnapshot { notes: Note[]; todos: Todo[]; preferences: Preferences; family: Family[]; outbox: OutboxEntry[]; initialized: boolean; conflicts?: LocalConflict[]; }
export interface Repository { load(ownerId: string): Promise<LocalSnapshot | null>; commit(ownerId: string, snapshot: LocalSnapshot): Promise<void>; clear(ownerId: string): Promise<void>; commitIfUnchanged?(ownerId: string, expected: LocalSnapshot | null, next: LocalSnapshot): Promise<void>; resolveConflict?(ownerId: string, conflictId: string, choice: ConflictChoice): Promise<LocalSnapshot>; }
export interface ConversationPort { stream(text: string, signal: AbortSignal): AsyncIterable<ConversationEvent>; }
export class ServiceFailure extends Error {
  constructor(public readonly code: ServiceErrorCode, message: string, public readonly retryable = false) {
    super(message);
    this.name = 'ServiceFailure';
  }
  envelope(requestId: string): ServiceErrorEnvelope {
    return { error: { code: this.code, message: this.message, retryable: this.retryable }, request_id: requestId, schema_version: contractVersion };
  }
}
export class LocalConflictFailure extends ServiceFailure {
  constructor(public readonly preserved: LocalSnapshot) {
    super('VERSION_CONFLICT', '版本冲突：修改未保存，本机草稿已保留。请到冲突页逐项比较，不会自动覆盖。');
  }
}
export async function readConversation(port: ConversationPort, text: string, signal: AbortSignal, onDelta: (segment: string, answer: string) => void): Promise<string> {
  if (signal.aborted) throw new DOMException('已停止', 'AbortError');
  if (!text.trim() || text.length > 1500) throw new ServiceFailure('INVALID_REQUEST', '请填写 1～1500 字的问题。');
  let requestId: string | null = null;
  let sequence = 0;
  let completed = false;
  let answer = '';
  for await (const event of port.stream(text, signal)) {
    if (signal.aborted) throw new DOMException('已停止', 'AbortError');
    if (!isConversationEvent(event) || completed || event.sequence !== sequence) throw new ServiceFailure('STREAM_INTERRUPTED', '讲解事件不完整，已暂停，请重新尝试。', true);
    if (requestId === null) {
      if (event.type !== 'started') throw new ServiceFailure('STREAM_INTERRUPTED', '讲解缺少开始确认，已暂停。', true);
      requestId = event.request_id;
    } else {
      if (event.request_id !== requestId || event.type === 'started') throw new ServiceFailure('STREAM_INTERRUPTED', '讲解事件不匹配，已暂停。', true);
      if (event.type === 'delta') {
        answer += event.text;
        if (answer.length > 24000) throw new ServiceFailure('STREAM_INTERRUPTED', '讲解过长，请分成小问题再试。', true);
        onDelta(event.text, answer);
      } else completed = true;
    }
    sequence++;
  }
  if (signal.aborted) throw new DOMException('已停止', 'AbortError');
  if (!completed || !answer.trim()) throw new ServiceFailure('STREAM_INTERRUPTED', '讲解没有完整结束，请重新尝试。', true);
  return answer;
}
export interface AppServices { repository: Repository; conversation: ConversationPort; ownerId: string; }
export function createLocalId(): string {
  const cryptoApi = globalThis.crypto;
  try {
    if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  } catch {}
  const bytes = new Uint8Array(16);
  try {
    if (typeof cryptoApi?.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
    else throw new Error('Web Crypto unavailable');
  } catch {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hexadecimal = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
  return `${hexadecimal.slice(0, 4).join('')}-${hexadecimal.slice(4, 6).join('')}-${hexadecimal.slice(6, 8).join('')}-${hexadecimal.slice(8, 10).join('')}-${hexadecimal.slice(10).join('')}`;
}
export function buildReviewTodo(note: Note, dueAt: string, timezone: string): Todo {
  if (!Number.isFinite(Date.parse(dueAt))) throw new Error('提醒时间无效');
  return { id: createLocalId(), ownerId: note.ownerId, title: '复习：' + note.topic, dueAt, timezone, noteId: note.id, completedAt: null, repeat:'none', source:'review', createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),version:1,deletedAt:null };
}
export function markReviewed(note: Note, now = new Date().toISOString()): Note { return { ...note, reviewedAt: now, updatedAt:now, version:note.version+1 }; }
export function setMastery(note: Note, mastery: Note['mastery']): Note { return { ...note, mastery, masterySource:'user', updatedAt:new Date().toISOString(), version:note.version+1 }; }
export function mayViewLearning(family: Family): boolean { return family.status === 'active' && family.scopes.includes('notes:read'); }
