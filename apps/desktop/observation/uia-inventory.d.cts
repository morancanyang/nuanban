import type { UiaCandidate, UiaControl, UiaControlList, UiaInventoryResult } from './uia-inventory.cjs';

export interface UiaLimits { maxDepth: number; maxDepthLimit: number; maxControls: number; maxControlsLimit: number; maxLabelLength: number; maxControlTypeLength: number; maxRectsPerList: number }
export const UIA_LIMITS: UiaLimits;
export function controlTypeLabel(programmaticName: unknown): string;
export function checkedLimits(overrides?: { maxDepth?: number; maxControls?: number }): UiaLimits;
export function checkedControlItems(reply: unknown, limits: Pick<UiaLimits, 'maxControls' | 'maxDepthLimit' | 'maxControlTypeLength' | 'maxLabelLength'>): UiaControl[];
export function uiaCandidates(controls: UiaControl[]): UiaCandidate[];
export function windowKey(window: unknown): string | null;
export function buildControlList(candidates: UiaCandidate[], options?: { isRestrictedText?: (value: unknown) => boolean; maxLines?: number }): UiaControlList;
export function createUiaInventoryReader(options?: { spawn?: unknown; timeoutMs?: number; platform?: string; limits?: { maxDepth?: number; maxControls?: number }; excludedProcessIds?: number[] | (() => number[]) }): {
  read(options?: { signal?: AbortSignal }): Promise<UiaInventoryResult>;
  stop(): Promise<void>;
  limits: UiaLimits;
};