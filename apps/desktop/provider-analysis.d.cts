import type { AiProvider } from './ai-provider.cjs';
import type { AnalysisInput, AnalysisResult } from './runtime-coordinator.cjs';
export function createProviderAnalysisClient(options?: { provider?: Pick<AiProvider, 'answer'> & { vision?: boolean }; now?(): number; relaxedSafety?: boolean | (() => boolean) }): {
  capabilities(): { configured: boolean; protocol: string };
  analyze(input: AnalysisInput): Promise<AnalysisResult>;
};
