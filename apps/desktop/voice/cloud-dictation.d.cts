export interface CloudDictationResult { text: string; attempts: number; }
export interface CloudDictationStatus { available: true; model: string; uploadsAudio: true; }
export interface CloudDictationOptions {
  baseUrl: string;
  apiKey: string;
  model?: 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe' | 'whisper-1';
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
export declare const TRANSCRIBE_MODELS: Set<string>;
export declare const MAX_AUDIO_BYTES: number;
export declare const MAX_TEXT_CHARS: number;
export declare function createCloudDictation(options: CloudDictationOptions): CloudDictation;