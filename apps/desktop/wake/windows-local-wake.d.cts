export type WindowsLocalWakeSignalProblem = 'none' | 'TooNoisy' | 'NoSignal' | 'TooLoud' | 'TooSoft' | 'TooFast' | 'TooSlow' | 'Unknown';
export interface WindowsLocalWakeState {
  state: 'disabled' | 'starting' | 'listening' | 'question' | 'stopping' | 'unavailable' | 'error';
  enabled: boolean;
  microphoneActive: boolean;
  generation: number;
  reason?: string;
  localOnly: true;
  dictationAvailable: boolean;
  /** C2: advisory input level/problem snapshot from the local engine; never affects the fail-closed policy. */
  signal?: Readonly<{ level: number; problem: WindowsLocalWakeSignalProblem }>;
}
export interface WindowsLocalWakeProbe {
  status: 'complete' | 'unavailable';
  reason?: string;
  recognizers?: Array<{ culture: string; name: string; id: string }>;
  dictationAvailable?: boolean;
  dictationReason?: string;
  microphoneOpened?: false;
  localOnly?: true;
}
export interface WindowsLocalWakeOptions {
  onWake?: (event: { localOnly: true; generation: number; dictationAvailable: boolean }) => void;
  onQuestion?: (text: string) => void;
  onState?: (state: WindowsLocalWakeState) => void;
  spawn?: typeof import('node:child_process').spawn;
  platform?: string;
  timeoutMs?: number;
  questionTimeoutMs?: number;
  dictationTimeoutMs?: number;
  maxOutputBytes?: number;
}
export type WindowsLocalDictationResult = Readonly<
  | { status: 'complete'; text: string; localOnly: true; microphoneActive: false }
  | { status: 'uncertain'; localOnly: true; microphoneActive: false }
  | { status: 'cancelled'; localOnly: true; microphoneActive: false }
>;
export function createWindowsLocalWake(options?: WindowsLocalWakeOptions): Readonly<{
  probe(options?: { signal?: AbortSignal }): Promise<WindowsLocalWakeProbe>;
  enable(options: { actor: 'owner'; confirmed: true; signal?: AbortSignal }): Promise<WindowsLocalWakeState>;
  dictate(options: { actor: 'owner'; confirmed: true; signal?: AbortSignal }): Promise<WindowsLocalDictationResult>;
  disable(): Promise<WindowsLocalWakeState>;
  snapshot(): WindowsLocalWakeState;
}>;
