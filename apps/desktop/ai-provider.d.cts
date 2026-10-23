export interface ProviderInput {
  question: string;
  signal?: AbortSignal;
  instructions?: string;
  image?: { mime: 'image/png'; bytes: Buffer; width?: number; height?: number };
}
export interface AiProvider {
  status(): { available: true };
  answer(input: ProviderInput): Promise<{ text: string }>;
}
export class ProviderFailure extends Error { code: string; retryable: boolean; constructor(code: string, retryable?: boolean); }
export function createOpenAiCompatibleProvider(options: { baseUrl: string; model: string; apiKey: string; fetch?: typeof fetch; timeoutMs?: number; retryAttempts?: number; retryDelaysMs?: number[] }): AiProvider;
export function loadConfiguredProvider(options?: {
  env?: Record<string, string | undefined>;
  configurationPath?: string;
  decrypt?(encrypted: string): Promise<string>;
  fetch?: typeof fetch;
}): Promise<AiProvider | undefined>;
