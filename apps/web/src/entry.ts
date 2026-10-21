export type EntryMode = 'guest';

export type EntryRecord = { mode: EntryMode; at: string };

const STORAGE_KEY = 'nuanban.entry.v1';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 读取本机入口记录；存储不可用、内容损坏或版本不符时都视为「还没选择过」。 */
export function readEntry(): EntryRecord | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Partial<EntryRecord>;
    return record.mode === 'guest' && typeof record.at === 'string'
      ? { mode: 'guest', at: record.at }
      : null;
  } catch {
    return null;
  }
}

/** 记录本机入口选择；写入失败时本次仍可进入，但不会假装已经保存。 */
export function writeEntry(mode: EntryMode): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ mode, at: new Date().toISOString() }));
  } catch {
    // 存储被禁用时保持静默：下次启动会再次看到入口页，而不是写入假记录。
  }
}
