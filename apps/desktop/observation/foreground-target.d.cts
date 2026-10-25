// 前台目标窗口跟踪器：只读取 hwnd、窗口标题与进程名，不读像素、不截屏。
export interface ForegroundTarget {
  hwnd: number;
  title: string;
  processName: string;
  at: number;
}

export interface ForegroundTargetSummary extends ForegroundTarget {
  label: string;
  foreground: boolean | null;
}

export interface ForegroundTargetState {
  tracking: boolean;
  unavailable: boolean;
  target: ForegroundTarget | null;
}

export interface ForegroundTargetTracker {
  start(): void;
  stop(): void;
  clear(): void;
  target(): ForegroundTarget | null;
  snapshot(): ForegroundTargetState;
}

export const FOREGROUND_LIMITS: {
  intervalMs: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  maxTitleLength: number;
  maxProcessNameLength: number;
  maxLineBytes: number;
};

export const PROCESS_NAME_PATTERN: RegExp;

export function parseForegroundLine(line: string): ForegroundTarget | null;

export function createForegroundTargetTracker(options?: {
  spawn?: (command: string, args: string[], options: Record<string, unknown>) => unknown;
  platform?: string;
  intervalMs?: number;
  isSelfProcessId?: (processId: number) => boolean;
  ownProcessIds?: () => number[];
  now?: () => number;
  onTarget?: (target: ForegroundTarget | null) => void;
  onState?: (state: ForegroundTargetState) => void;
  trace?: (event: string, detail?: Record<string, unknown>) => void;
}): ForegroundTargetTracker;