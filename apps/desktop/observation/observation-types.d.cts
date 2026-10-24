import type { spawn } from 'node:child_process';

export interface Rect { x: number; y: number; width: number; height: number }

export interface ObservationGeometry extends Rect {
  coordinateSpace: 'screen-dip';
  scaleFactor: number;
  pixelX: number;
  pixelY: number;
  pixelWidth: number;
  pixelHeight: number;
  rotation: number;
}

export interface ObservationSourceMetadata {
  id: string;
  name: string;
  type: 'screen' | 'window';
  displayId: string;
  geometry: ObservationGeometry | null;
  unavailableReason?: string;
}

export interface ObservationFrame {
  region?: Rect;
  sourceId: string;
  sourceName?: string;
  sourceType?: 'screen' | 'window';
  sourceIdentity?: string;
  displayId?: string;
  frameId?: string;
  frameHash: string;
  capturedAt: number;
  width: number;
  height: number;
  png: Buffer;
  geometry: ObservationGeometry | null;
}

export interface DetectionWord { text: string; rect: Rect; globalRect?: Rect; ocrPass?: number; textAngle?: number | null }
export interface DetectionFace { rect: Rect; globalRect?: Rect }
export interface ShellControl { label: string; surface: 'taskbar' | 'desktop'; rect: Rect }

export type DetectionResult = {
  status: 'complete';
  sourceId: string;
  sourceIdentity: string | null;
  frameHash: string;
  width: number;
  height: number;
  words: DetectionWord[];
  faces: DetectionFace[];
  shellControls?: ShellControl[];
  visualControls?: import('./visual-controls.cjs').VisualControl[];
  sanitizedPng: Buffer;
  sanitizedFrameHash: string;
  redaction: { text: true; faces: true };
  ocrStatus: 'complete';
  faceStatus: 'complete';
} | {
  status: 'unavailable' | 'failed';
  reason: string;
  sourceId: string | null;
  frameHash: string | null;
  width: number | null;
  height: number | null;
  words: [];
  faces: [];
  redaction: { text: false; faces: false };
  sanitizedPng?: never;
};

export type ProbeResult = {
  status: 'complete';
  ocr: { status: 'available'; languages: string[]; recognizerLanguage: string; maxImageDimension: number };
  face: { status: 'available'; supportedPixelFormats: string[] };
  powershellVersion: string;
} | { status: 'unavailable' | 'failed'; reason: string };

export interface SignalOptions { signal?: AbortSignal }
export interface ObservationLimits { maxPngBytes?: number; maxPixels?: number; maxDimension?: number; maxSources?: number }
export interface LocalImage {
  isEmpty(): boolean;
  getSize(scaleFactor?: number): { width: number; height: number };
  toPNG(options?: { scaleFactor?: number }): Buffer;
  toBitmap(options?: { scaleFactor?: number }): Buffer;
}
export interface NativeImageApi {
  createFromBuffer(buffer: Buffer): LocalImage;
  createFromBitmap(buffer: Buffer, options: { width: number; height: number; scaleFactor?: number }): LocalImage;
}
export interface RawDesktopSource { id: string; name: string; display_id: string; thumbnail?: LocalImage }
export interface DesktopCapturerApi {
  getSources(options: { types: Array<'screen' | 'window'>; thumbnailSize: { width: number; height: number }; fetchWindowIcons: boolean }): Promise<RawDesktopSource[]>;
}
export interface ScreenApi {
  getAllDisplays(): Array<{ id: number | string; bounds: Rect; scaleFactor: number; rotation: number; nativeOrigin?: { x: number; y: number } }>;
  dipToScreenRect?(window: null, rect: Rect): Rect;
}
export interface LocalDetectorOptions {
  canReadShellControls?: (frame: ObservationFrame) => boolean;
  /** Opt-in second up-scaled OCR pass for very small text (default false: guidance latency first). */
  scaledPass?: boolean;
  /** Downscale OCR input so the longest side stays at or below this many pixels (default 1080; 0 disables). */
  ocrMaxDimension?: number;
  nativeImage?: NativeImageApi;
  spawn?: typeof spawn;
  timeoutMs?: number;
  maxOutputBytes?: number;
  platform?: string;
  limits?: ObservationLimits;
}
export interface WindowsLocalDetector {
  detect(frame: ObservationFrame, options?: SignalOptions): Promise<DetectionResult>;
  probe(options?: SignalOptions): Promise<ProbeResult>;
  stop(): Promise<void>;
}
export interface WindowsObservationSource extends WindowsLocalDetector {
  listSources(options?: SignalOptions): Promise<ObservationSourceMetadata[]>;
  capture(options: SignalOptions & { sourceId: string; region?: Rect }): Promise<ObservationFrame>;
}
export interface WindowsObservationSourceOptions {
  desktopCapturer?: DesktopCapturerApi;
  screen?: ScreenApi;
  nativeImage?: NativeImageApi;
  canCapture?: (selection: { sourceId: string }) => boolean;
  now?: () => number;
  timeoutMs?: number;
  platform?: string;
  limits?: ObservationLimits;
  detectorOptions?: Omit<LocalDetectorOptions, 'nativeImage' | 'platform' | 'limits'>;
  /** Pre-capture source enumeration cache TTL in ms (default 6000); post-capture enumeration stays real. */
  sourceRefreshMs?: number;
}
