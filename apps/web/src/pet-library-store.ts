import { createLocalId, ServiceFailure, markReviewed, setMastery, type LocalSnapshot, type Repository } from '@nuanban/application';
import { validInstant, validTimezone } from '@nuanban/contracts';
import { recurrenceNext, redactSecrets, type Note, type Todo } from '@nuanban/domain';
import { emptyLocalSnapshot } from './local-snapshot';

export interface PetNoteInput { id?: string; version?: number; question: string; summary: string; }
export interface PetTodoInput { id?: string; version?: number; title: string; dueAt: string; timezone: string; repeat: Todo['repeat']; noteId: string | null; }
type PetLibraryRepository = Pick<Repository, 'load'> & Required<Pick<Repository, 'commitIfUnchanged'>>;

export class PetLibraryStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly repository: PetLibraryRepository,
    private readonly ownerId = 'local-owner',
    private readonly clock = () => new Date(),
  ) {}

  async load(): Promise<LocalSnapshot> {
    const snapshot = await this.repository.load(this.ownerId) ?? emptyLocalSnapshot();
    this.validate(snapshot);
    return snapshot;
  }

  saveNote(input: PetNoteInput): Promise<LocalSnapshot> {
    const question = redactSecrets(input.question.trim());
    const summary = redactSecrets(input.summary.trim());
    if (!question || question.length > 500 || !summary || summary.length > 6000) return Promise.reject(new Error('请填写 1～500 字的标题和 1～6000 字的学习要点。'));
    return this.change(snapshot => {
      const now = this.clock().toISOString();
      if (input.id) {
        const note = this.note(snapshot, input.id, input.version);
        Object.assign(note, { question, topic: this.topic(question), summary, updatedAt: now, version: note.version + 1 });
        this.track(snapshot, note, 'note', now);
      } else {
        const note: Note = { id: createLocalId(), ownerId: this.ownerId, question, topic: this.topic(question), summary, mastery: 'unmastered', masterySource: null, reviewedAt: null, source: 'conversation', createdAt: now, updatedAt: now, version: 1, deletedAt: null };
        snapshot.notes.unshift(note);
        this.track(snapshot, note, 'note', now);
      }
    });
  }

  mastery(id: string, version: number, mastered: boolean): Promise<LocalSnapshot> {
    return this.change(snapshot => {
      const note = this.note(snapshot, id, version);
      const now = this.clock().toISOString();
      Object.assign(note, setMastery(note, mastered ? 'mastered' : 'unmastered'), { updatedAt: now });
      this.track(snapshot, note, 'note', now);
    });
  }

  review(id: string, version: number): Promise<LocalSnapshot> {
    return this.change(snapshot => {
      const note = this.note(snapshot, id, version);
      const now = this.clock().toISOString();
      Object.assign(note, markReviewed(note, now));
      this.track(snapshot, note, 'note', now);
    });
  }

  remove(kind: 'note' | 'todo', id: string, version: number): Promise<LocalSnapshot> {
    return this.change(snapshot => {
      const entity = kind === 'note' ? this.note(snapshot, id, version) : this.todo(snapshot, id, version);
      const now = this.clock().toISOString();
      Object.assign(entity, { deletedAt: now, updatedAt: now, version: entity.version + 1 });
      this.track(snapshot, entity, kind, now);
    });
  }

  saveTodo(input: PetTodoInput): Promise<LocalSnapshot> {
    const title = redactSecrets(input.title.trim());
    if (!title || title.length > 120 || !validInstant(input.dueAt) || !validTimezone(input.timezone) || !['none', 'daily', 'weekly'].includes(input.repeat)) return Promise.reject(new Error('请填写有效标题、提醒时间、时区和重复方式。'));
    return this.change(snapshot => {
      const now = this.clock();
      if (Date.parse(input.dueAt) <= now.getTime()) throw new Error('提醒时间需要在现在之后，请重新核对。');
      if (input.noteId) this.note(snapshot, input.noteId);
      const timestamp = now.toISOString();
      const fields = { title, dueAt: input.dueAt, timezone: input.timezone, repeat: input.repeat, noteId: input.noteId, source: input.noteId ? 'review' as const : 'self' as const, updatedAt: timestamp };
      if (input.id) {
        const todo = this.todo(snapshot, input.id, input.version);
        if (todo.completedAt) throw new Error('这项待办已完成，不能修改原来的提醒。');
        Object.assign(todo, fields, { version: todo.version + 1 });
        this.track(snapshot, todo, 'todo', timestamp);
      } else {
        const todo: Todo = { ...fields, id: createLocalId(), ownerId: this.ownerId, completedAt: null, createdAt: timestamp, version: 1, deletedAt: null };
        snapshot.todos.unshift(todo);
        this.track(snapshot, todo, 'todo', timestamp);
      }
    });
  }

  complete(id: string, version: number, recordReview = false): Promise<LocalSnapshot> {
    return this.change(snapshot => {
      const todo = this.todo(snapshot, id, version);
      if (todo.completedAt) throw new Error('这项待办已经完成，请刷新列表。');
      const now = this.clock();
      const timestamp = now.toISOString();
      if (recordReview) {
        if (!todo.noteId) throw new Error('这项待办没有关联学习笔记。');
        const note = this.note(snapshot, todo.noteId);
        Object.assign(note, markReviewed(note, timestamp));
        this.track(snapshot, note, 'note', timestamp);
      }
      Object.assign(todo, { completedAt: timestamp, updatedAt: timestamp, version: todo.version + 1 });
      this.track(snapshot, todo, 'todo', timestamp);
      const nextTime = recurrenceNext(todo, now);
      if (nextTime) {
        const next: Todo = { ...todo, id: createLocalId(), dueAt: nextTime, completedAt: null, createdAt: timestamp, updatedAt: timestamp, version: 1 };
        snapshot.todos.unshift(next);
        this.track(snapshot, next, 'todo', timestamp);
      }
    });
  }

  private change(change: (snapshot: LocalSnapshot) => void): Promise<LocalSnapshot> {
    const operation = this.queue.then(async () => {
      const expected = await this.repository.load(this.ownerId);
      const next = structuredClone(expected ?? emptyLocalSnapshot());
      this.validate(next);
      change(next);
      await this.repository.commitIfUnchanged(this.ownerId, expected, next);
      return next;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private validate(snapshot: LocalSnapshot): void {
    if (!snapshot || !Array.isArray(snapshot.notes) || !Array.isArray(snapshot.todos) || !Array.isArray(snapshot.outbox) || !snapshot.preferences) throw new Error('本机资料格式不完整，已停止写入，不会覆盖原资料。');
  }

  private note(snapshot: LocalSnapshot, id: string, version?: number): Note {
    const note = snapshot.notes.find(item => item.id === id && item.ownerId === this.ownerId && !item.deletedAt);
    if (!note) throw new Error('这条笔记已移除或不可用，请刷新资料。');
    this.checkVersion(note.version, version);
    return note;
  }

  private todo(snapshot: LocalSnapshot, id: string, version?: number): Todo {
    const todo = snapshot.todos.find(item => item.id === id && item.ownerId === this.ownerId && !item.deletedAt);
    if (!todo) throw new Error('这项待办已移除或不可用，请刷新资料。');
    this.checkVersion(todo.version, version);
    return todo;
  }

  private checkVersion(actual: number, expected?: number): void {
    if (expected !== undefined && expected !== actual) throw new ServiceFailure('VERSION_CONFLICT', '这条资料已在其他窗口变化；未覆盖较新资料。请刷新后重新选择，编辑草稿仍保留。');
  }

  private topic(question: string): string { return question.length > 20 ? question.slice(0, 20) + '…' : question; }

  private track(snapshot: LocalSnapshot, entity: Note | Todo, kind: 'note' | 'todo', now: string): void {
    snapshot.outbox.push({ id: createLocalId(), ownerId: this.ownerId, entityId: entity.id, entityType: kind, version: entity.version, status: 'pending', createdAt: now });
  }
}
