export type LocalVoiceSignalProblem = 'none' | 'TooNoisy' | 'NoSignal' | 'TooLoud' | 'TooSoft' | 'TooFast' | 'TooSlow' | 'Unknown';
export interface LocalVoiceSignal { level: number; problem: LocalVoiceSignalProblem; }
export interface LocalVoiceStatus {
  phase: 'disabled' | 'starting' | 'listening' | 'question' | 'stopping' | 'unavailable' | 'error';
  enabled: boolean;
  microphoneActive: boolean;
  dictationAvailable: boolean;
  localOnly: true;
  message: string;
  /** C2: advisory microphone signal snapshot. Absent until the local engine reports one. */
  signal?: LocalVoiceSignal;
}

const signalProblems = new Set<LocalVoiceSignalProblem>(['none', 'TooNoisy', 'NoSignal', 'TooLoud', 'TooSoft', 'TooFast', 'TooSlow', 'Unknown']);

export function checkedVoiceSignal(value: unknown): LocalVoiceSignal | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('本地语音状态未确认');
  const signal = value as Record<string, unknown>;
  if (!Number.isInteger(signal.level) || (signal.level as number) < 0 || (signal.level as number) > 100
    || typeof signal.problem !== 'string' || !signalProblems.has(signal.problem as LocalVoiceSignalProblem)) throw new Error('本地语音状态未确认');
  return { level: signal.level as number, problem: signal.problem as LocalVoiceSignalProblem };
}

/**
 * Turns the signal snapshot into an actionable hint. Kept pure so the panel and tests share one source
 * of truth; it never claims that speech was recognised.
 */
export function micSignalHint(signal: LocalVoiceSignal | undefined): string {
  if (!signal) return '正在读取麦克风信号；说话前可先看这里的电平变化。';
  if (signal.problem === 'TooNoisy') return '环境噪声过大：请关闭附近噪声源，或改用带麦克风的耳机。';
  if (signal.problem === 'TooLoud') return '声音过大导致失真：请把麦克风放远一点或降低输入音量。';
  if (signal.problem === 'NoSignal') return '没有收到任何声音：请确认麦克风未被静音，并选择正确的输入设备。';
  if (signal.problem === 'TooFast') return '语速过快：请放慢一点，一次说一句完整的话。';
  if (signal.problem === 'TooSlow') return '停顿过长：请连贯说一句完整的话。';
  if (signal.problem === 'TooSoft' || signal.level < 12) return '麦克风信号过弱：请靠近麦克风，或在系统声音设置里提高输入音量/麦克风加强。';
  return `正在接收语音（电平 ${signal.level}/100）。听到后可继续说，识别不清时会提示你重说。`;
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
  const signal = checkedVoiceSignal(current.signal);
  return { phase: current.phase as LocalVoiceStatus['phase'], enabled: current.enabled, microphoneActive: current.microphoneActive,
    dictationAvailable: current.dictationAvailable, localOnly: true, message: current.message, ...(signal ? { signal } : {}) };
}
