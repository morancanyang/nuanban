export interface CloudDictationResult { text: string; attempts: number; }
export interface CloudDictationStatus { available: true; model: string; uploadsAudio: true; }
export type TranscribeModel = 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe' | 'whisper-1';
export interface CloudDictationOptions {
  baseUrl: string;
  apiKey: string;
  model?: TranscribeModel;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelaysMs?: number[];
}
export interface CloudDictation {
  readonly model: string;
  status(): CloudDictationStatus;
  transcribe(input: { wav: Buffer; signal?: AbortSignal }): Promise<CloudDictationResult>;
}
export interface CloudDictationLoaderOptions {
  env?: Record<string, string | undefined>;
  configurationPath?: string;
  decrypt?(encrypted: string): Promise<string>;
  fetch?: typeof fetch;
  model?: TranscribeModel;
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelaysMs?: number[];
}
export declare const TRANSCRIBE_MODELS: Set<string>;
export declare const MAX_AUDIO_BYTES: number;
export declare const MAX_TEXT_CHARS: number;
export declare function createCloudDictation(options: CloudDictationOptions): CloudDictation;
export declare function loadConfiguredCloudDictation(options?: CloudDictationLoaderOptions): Promise<CloudDictation | undefined>;