import type { UiaControlList, UiaInventoryResult } from './uia-inventory.cjs';

export interface UiaRect { x: number; y: number; width: number; height: number }
export interface GuidanceReason { code: string; severity: 'info' | 'blocked'; suggestSingleFrame: boolean; message: string }
export interface GuidanceCounts { count: number; limit: number; truncated: boolean }
export interface GuidanceTarget { number: number; name: string; nameKey: string; controlType: string; label: string; rect: UiaRect }
export interface GuidanceReviewVerdict { verdict: 'advanced' | 'unchanged' | 'unverifiable'; code: string; detail: string }
export interface GuidanceStep { status: 'ready' | 'blocked' | 'unchanged' | 'unverifiable' | 'advanced'; code: string;
  severity: 'info' | 'blocked'; message: string; suggestSingleFrame: boolean; counts: GuidanceCounts;
  detail?: string; verdict?: GuidanceReviewVerdict; target?: GuidanceTarget; instruction?: string;
  previous?: { windowKey: string | null; focusedIndex: number; candidateCount: number; target: { nameKey: string; controlType: string; rect: UiaRect; focused: boolean } };
  at?: number; next?: GuidanceStep | null }
export interface GuidanceSnapshot { mode: string; modeLabel: string; screenshotFree: boolean; active: boolean;
  reasonCode: string | null; reasonMessage: string | null; severity: string; suggestSingleFrame: boolean; textConsent: boolean;
  counts: GuidanceCounts; review: { verdict: string; code: string; detail: string } | null }
export interface UiaGuidanceSession {
  ask(question: string, options?: { signal?: AbortSignal }): Promise<GuidanceStep>;
  review(options?: { signal?: AbortSignal }): Promise<GuidanceStep>;
  snapshot(): GuidanceSnapshot;
  stop(): Promise<void>;
  mode: string;
}

export const GUIDANCE_MODES: { screenshotFree: 'screenshot-free'; singleFrame: 'single-frame'; continuous: 'continuous' };
export const DEFAULT_GUIDANCE_MODE: 'screenshot-free';
export const GUIDANCE_REASONS: Record<string, GuidanceReason>;
export const MODE_LABELS: Record<string, string>;
export function reasonInfo(code: unknown): GuidanceReason;
export function modeInfo(mode: unknown): { mode: string; label: string; screenshotFree: boolean };
export function parseControlChoice(value: unknown, count: number): { kind: 'control'; number: number; instruction: string } | { kind: 'no_match'; reason: string } | { kind: 'invalid'; code: string };
export function classifyReview(input: { previous?: { target?: { nameKey: string; controlType: string; rect: UiaRect }; windowKey?: string | null; focusedIndex?: number; candidateCount?: number } | null;
  current?: UiaInventoryResult | null; tolerance?: number }): GuidanceReviewVerdict;
export function choicePrompt(input: { question: string; list: UiaControlList; truncated: boolean }): string;
export function createUiaGuidanceSession(options: { inventory: { read(options?: { signal?: AbortSignal }): Promise<UiaInventoryResult>; stop?(): Promise<void> };
  chooser: ((input: { question: string; list: UiaControlList; count: number; truncated: boolean; signal?: AbortSignal }) => Promise<{ text?: string } | string>)
    | { choose(input: { question: string; list: UiaControlList; count: number; truncated: boolean; signal?: AbortSignal }): Promise<{ text?: string } | string> };
  isRestrictedText?: (value: unknown) => boolean; hasConsent?: () => boolean; now?: () => number;
  trace?: (event: string, detail?: Record<string, unknown>) => void; maxLines?: number }): UiaGuidanceSession;