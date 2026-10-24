import type { AdmittedFrame, LocalDetection, ObservationFrame, PixelRect } from './observation-policy.cjs';

export interface RuntimeSnapshot {
  observation: { state: string; id?: string; generation: number; sourceName: string; reason: string | null; captureActive: boolean; cloudConsent: boolean };
  task: { state: string; kind?: 'text' | 'guidance'; id: string | null; generation: number; observationGeneration: number; question: string; instruction: string; explanation: string; presentation: string | null; targetState?: 'hidden' | 'visible' | 'unavailable' | 'stale'; awaitingReply?: boolean; result: string | null; startedAt?: number; autoStep?: boolean; stepIndex?: number };
  analysis: { state: string; message: string }; captions: { enabled: boolean; text: string };
  wake: { state: string; reason: string }; messages: { id: string; role: string; text: string }[]; message: string;
}
export interface TeachingRecord { sourceGuideId: string; question: string; summary: string; result: string; mastery: 'unmastered'; startedAt?: number; endedAt: number }
export interface AnalysisReviewProposal { remind_at: string; timezone: string; reason: string }
export interface ReviewSuggestion { sourceGuideId: string; remindAt: string; timezone: string; reason: string; source: 'ai' }
export interface AnalysisResult {
  observation_id?: string; guide_id: string; observation_generation: number; task_generation: number;
  trigger_id: string; frame_id: string; kind: 'step' | 'completed' | 'clarify' | 'unsupported'; instruction: string;
  target_id?: string; presentation?: 'confirmed' | 'uncertain_candidate'; expected_labels?: string[]; evidence_labels?: string[];
  review_proposal?: AnalysisReviewProposal;
}
export interface AnalysisInput {
  frame: AdmittedFrame; question: string; reason: 'question' | 'page_changed' | 'verification';
  observationId: string; guideId: string; observationGeneration: number; taskGeneration: number; triggerId: string;
  previousStep: { instruction: string; expectedLabels: string[] } | null; signal: AbortSignal; canSend(): boolean;
  /** Frame age budget for the send path (admission itself stays at the five second window). */
  frameMaxAgeMs?: number;
  /** Lazily produce the scaled upload copy; called only after the analyzer's send gate passes. */
  prepareImage?(): { image: { mime: 'image/png'; bytes: Buffer; width: number; height: number } } | null | undefined;
  /** Optional scaled copy of the sanitized frame for providers with a strict image byte limit. */
  image?: { mime: 'image/png'; bytes: Buffer; width: number; height: number };
  clarificationReplies?: { prompt: string; answer: string }[];
  confirmCurrentFrame?(): Promise<boolean>;
}
export interface RuntimeOptions {
  source: { capture(input: { sourceId: string; signal: AbortSignal; region?: { x: number; y: number; width: number; height: number } }): Promise<ObservationFrame>; detect(frame: ObservationFrame, input: { signal: AbortSignal }): Promise<LocalDetection>; stop?(): Promise<unknown> | void };
  analyzer?: { analyze(input: AnalysisInput): Promise<AnalysisResult> };
  questioner?: { answer(input: { question: string; signal: AbortSignal; instructions?: string }): Promise<{ text: string }> };
  recordTeaching?(note: TeachingRecord): Promise<unknown> | unknown;
  suggestReview?(proposal: ReviewSuggestion): Promise<unknown> | unknown;
  onState?(snapshot: RuntimeSnapshot): void;
  onTarget?(target: { visible: boolean; rect: PixelRect; label: string; instruction: string; presentation: string; expiresAt: number } | null): boolean | void;
  now?(): number; intervalMs?: number; maxAgeMs?: number; analysisTimeoutMs?: number;
  resizeAnalysisImage?(frame: AdmittedFrame, limitBytes: number): { image: { mime: 'image/png'; bytes: Buffer; width: number; height: number } } | null | undefined;
}
export interface ObservationConsent { actor: string; confirmed: boolean; sourceId: string; sourceName?: string; cloudConsent?: boolean; region?: { x: number; y: number; width: number; height: number } }
export interface StopResult { stopped: boolean; captureActive: boolean; mediaActive: boolean; reason: string }
export interface DesktopRuntime {
  snapshot(): RuntimeSnapshot; startObservation(input: ObservationConsent): Promise<RuntimeSnapshot>;
  resumeObservation(input: ObservationConsent): Promise<RuntimeSnapshot>; stopObservation(reason?: string): Promise<StopResult>;
  authorizeCloudAnalysis(input: { actor: string; confirmed: boolean; observationGeneration: number }): Promise<RuntimeSnapshot>;
  ask(text: string, requiredObservation?: number): Promise<RuntimeSnapshot>; startAutoStep(goal?: string): Promise<RuntimeSnapshot>; verify(): Promise<RuntimeSnapshot>;
  replyToClarification(input: { text: string; guideId: string; taskGeneration: number; observationGeneration: number }): Promise<RuntimeSnapshot>;
  rescanClarification(input: { guideId: string; taskGeneration: number; observationGeneration: number }): Promise<RuntimeSnapshot>;
  finishTeaching(result?: string): Promise<RuntimeSnapshot>; repeat(): RuntimeSnapshot; toggleCaptions(): RuntimeSnapshot;
  dispose(reason?: string): Promise<StopResult>; whenIdle(): Promise<void>;
}
export function createDesktopRuntime(options: RuntimeOptions): DesktopRuntime;
