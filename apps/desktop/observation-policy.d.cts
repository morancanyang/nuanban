export interface PixelRect { x: number; y: number; width: number; height: number }
export interface ScreenGeometry extends PixelRect { scaleFactor?: number }
export interface ObservationFrame {
  sourceId: string; sourceName?: string; displayId?: string; frameId?: string; frameHash: string;
  capturedAt: number; width: number; height: number; png: Buffer; geometry: ScreenGeometry | null;
}
export interface LocalDetection {
  sourceId?: string;
  shellControls?: { label: string; surface: 'taskbar' | 'desktop'; rect: PixelRect }[];
  visualControls?: import('./observation/visual-controls.cjs').VisualControl[];
  status: 'complete' | 'unavailable' | 'failed'; reason?: string; frameHash: string; width: number; height: number;
  words: { text: string; rect: PixelRect; ocrPass?: number }[]; faces: { rect: PixelRect }[];
  sanitizedPng: Buffer; redaction: { text: boolean; faces: boolean };
}
export interface ScreenElement { id: string; label: string; rect: PixelRect; surface?: 'taskbar' | 'desktop' | 'visual'; appearance?: string }
export interface AdmittedFrame {
  decision: 'allow'; risk: 'safe'; reason: string; policyVersion: string; frameId: string; frameHash: string;
  sanitizedHash: string; capturedAt: number; sourceId: string; sourceName: string; displayId?: string;
  width: number; height: number; geometry: ScreenGeometry | null; signature: string; elements: ScreenElement[];
  sanitizedPng: Buffer; redactionProfile: 'all_text_and_faces_v1' | 'owner_approved_none'; unredacted?: boolean; scene: string;
}
export interface DeniedFrame { decision: 'pause'; risk: string; reason: string; policyVersion: string }
export function evaluateLocalFrame(frame: ObservationFrame, detection: LocalDetection, options?: { now?: number; maxAgeMs?: number; authorizedSharing?: boolean; unredactedUpload?: boolean }): AdmittedFrame | DeniedFrame;
export function evaluateSelectedFrame(frame: ObservationFrame, detection: LocalDetection, options?: { now?: number; maxAgeMs?: number }): AdmittedFrame | DeniedFrame;
export function isAdmittedFrame(frame: unknown, now?: number, maxAgeMs?: number): frame is AdmittedFrame;
export function isRestrictedText(value: unknown): boolean;
export function normalizeLabel(value: unknown): string;
export function safeSummary(value: unknown, maximum?: number): string;
export function validRect(value: unknown, width: number, height: number): boolean;
export const policyVersion: string;
