import type { AiProvider } from './ai-provider.cjs';
import type { AnalysisInput, AnalysisResult } from './runtime-coordinator.cjs';
export function createProviderAnalysisClient(options?: { provider?: Pick<AiProvider, 'answer'> & { vision?: boolean }; now?(): number; relaxedSafety?: boolean | (() => boolean) }): {
  capabilities(): { configured: boolean; protocol: string };
  analyze(input: AnalysisInput): Promise<AnalysisResult>;
};
/** 无截屏：只发文本控件清单 + 问题，模型只回序号（不接收也不返回坐标/图片）。 */
export function createControlChoiceAnalysisClient(options?: { provider?: Pick<AiProvider, 'answer'>; now?(): number; relaxedSafety?: boolean | (() => boolean) }): {
  capabilities(): { configured: boolean; protocol: string; screenshotFree: boolean };
  choose(input: { question: string; lines: string[]; truncated?: boolean; signal?: AbortSignal }): Promise<{ text: string; screenshotFree: true; controls: number; at: number }>;
};
