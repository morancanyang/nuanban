export interface LocalVoiceStatus {
  phase: 'disabled' | 'starting' | 'listening' | 'question' | 'stopping' | 'unavailable' | 'error';
  enabled: boolean;
  microphoneActive: boolean;
  dictationAvailable: boolean;
  localOnly: true;
  message: string;
}

export interface LocalVoiceBridge {
  status(): Promise<LocalVoiceStatus>;
  dictate?(): Promise<LocalDictationResult>;
  cancelDictation?(): Promise<boolean>;
  enable(): Promise<LocalVoiceStatus>;
  disable(): Promise<LocalVoiceStatus>;
  openSettings(): Promise<boolean>;
}

export type LocalDictationResult = { status: 'complete'; text: string; localOnly: true; microphoneActive: false }
  | { status: 'uncertain'; localOnly: true; microphoneActive: false }
  | { status: 'cancelled'; localOnly: true };

export function checkedDictationResult(value: unknown): LocalDictationResult {
  if (!value || typeof value !== 'object') throw new Error('本地听写结果未确认');
  const result = value as Record<string, unknown>;
  if (result.localOnly === true && result.status === 'cancelled') return { status: 'cancelled', localOnly: true };
  if (result.localOnly === true && result.status === 'uncertain' && result.microphoneActive === false) return { status: 'uncertain', localOnly: true, microphoneActive: false };
  if (result.localOnly !== true || result.status !== 'complete' || result.microphoneActive !== false
    || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 500) throw new Error('本地听写结果未确认');
  return { status: 'complete', text: result.text.trim(), localOnly: true, microphoneActive: false };
}

declare global {
  interface Window { nuanbanVoice?: LocalVoiceBridge; }
}

export function localVoiceBridge(): LocalVoiceBridge | undefined {
  const bridge = window.nuanbanVoice;
  return bridge && ['status', 'enable', 'disable', 'openSettings'].every(method => typeof bridge[method as keyof LocalVoiceBridge] === 'function') ? bridge : undefined;
}

export function checkedVoiceStatus(value: unknown): LocalVoiceStatus {
  if (!value || typeof value !== 'object') throw new Error('本地语音状态未确认');
  const current = value as Record<string, unknown>;
  if (!['disabled', 'starting', 'listening', 'question', 'stopping', 'unavailable', 'error'].includes(String(current.phase))
    || typeof current.enabled !== 'boolean' || typeof current.microphoneActive !== 'boolean' || typeof current.dictationAvailable !== 'boolean'
    || current.localOnly !== true || typeof current.message !== 'string' || current.message.length > 500
    || (current.phase === 'disabled' && (current.enabled || current.microphoneActive))) throw new Error('本地语音状态未确认');
  return { phase: current.phase as LocalVoiceStatus['phase'], enabled: current.enabled, microphoneActive: current.microphoneActive,
    dictationAvailable: current.dictationAvailable, localOnly: true, message: current.message };
}
