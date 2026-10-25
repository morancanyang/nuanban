export interface DipRect { x: number; y: number; width: number; height: number; displayId: string }
export function physicalBounds(display: { bounds: DipRect; scaleFactor?: number; nativeOrigin?: { x: number; y: number } }, screen?: {
  dipToScreenRect?(window: null, rect: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } | null;
}): { x: number; y: number; width: number; height: number } | null;
export function physicalToDipRect(rect: { x: number; y: number; width: number; height: number } | null | undefined, options?: {
  screen?: { getAllDisplays?(): Array<{ id?: number | string; bounds: DipRect; scaleFactor?: number; nativeOrigin?: { x: number; y: number } }>; dipToScreenRect?(window: null, rect: DipRect): DipRect | null };
}): DipRect | null;