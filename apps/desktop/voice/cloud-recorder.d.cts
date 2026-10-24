export interface CloudRecorderResult { wav: Buffer; seconds: number; peak: number; gain: number; }
export interface CloudRecorderOptions {
  spawn?: typeof import('node:child_process').spawn;
  scriptPath?: string;
  powershellPath?: string;
  platform?: string;
  maxSeconds?: number;
  silenceMs?: number;
  timeoutMs?: number;
  maxBufferBytes?: number;
}
export type CloudRecorder =
  | { available: false; reason: string; record(): Promise<never> }
  | { available: true; record(input?: { outFile?: string; signal?: AbortSignal }): Promise<CloudRecorderResult> };
export declare const MAX_WAV_BYTES: number;
export declare function createCloudRecorder(options?: CloudRecorderOptions): CloudRecorder;