export type LocalVoiceSignalProblem = 'none' | 'TooNoisy' | 'NoSignal' | 'TooLoud' | 'TooSoft' | 'TooFast' | 'TooSlow' | 'Unknown';
export interface LocalVoiceSignal { level: number; problem: LocalVoiceSignalProblem; }

/** 原生侧上报的云端听写状态。 */
export interface LocalCloudDictation {
  /** 用户是否已在原生窗口确认开启云端听写（桌面侧持久化）。 */
  enabled: boolean;
  /** 本机是否已配置可用的模型网关；未配置时为 false，此时云端听写不可用。 */
  available: boolean;
}

export interface LocalVoiceStatus {
  phase: 'disabled' | 'starting' | 'listening' | 'question' | 'stopping' | 'unavailable' | 'error';
  enabled: boolean;
  microphoneActive: boolean;
  dictationAvailable: boolean;
  localOnly: true;
  message: string;
  /** C2: advisory microphone signal snapshot. Absent until the local engine reports one. */
  signal?: LocalVoiceSignal;
  /**
   * 云端听写状态。旧宿主或原生尚未上报时缺省；任何消费方都必须把缺省当作“未开启且不可用”，
   * 不能因为缺省就假定云端听写可用。
   */
  cloudDictation?: LocalCloudDictation;
}

const signalProblems = new Set<LocalVoiceSignalProblem>(['none', 'TooNoisy', 'NoSignal', 'TooLoud', 'TooSoft', 'TooFast', 'TooSlow', 'Unknown']);

export function checkedVoiceSignal(value: unknown): LocalVoiceSignal | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('本地语音状态未确认');
  const signal = value as Record<string, unknown>;
  if (!Number.isInteger(signal.level) || (signal.level as number) < 0 || (signal.level as number) > 100
    || typeof signal.problem !== 'string' || !signalProblems.has(signal.problem as LocalVoiceSignalProblem)) throw new Error('本地语音状态未确认');
  return { level: signal.level as number, problem: signal.problem as LocalVoiceSignalProblem };
}

/** 校验云端听写字段：缺省合法（旧宿主），出现时 enabled/available 必须是布尔。 */
export function checkedCloudDictation(value: unknown): LocalCloudDictation | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('本地语音状态未确认');
  const cloud = value as Record<string, unknown>;
  if (typeof cloud.enabled !== 'boolean' || typeof cloud.available !== 'boolean') throw new Error('本地语音状态未确认');
  return { enabled: cloud.enabled, available: cloud.available };
}

/**
 * Turns the signal snapshot into an actionable hint. Kept pure so the panel and tests share one source
 * of truth; it never claims that speech was recognised.
 */
export function micSignalHint(signal: LocalVoiceSignal | undefined): string {
  if (!signal) return '正在读取麦克风信号；说话前可先看这里的电平变化。';
  if (signal.problem === 'TooNoisy') return '环境噪声过大：请关闭附近噪声源，或改用带麦克风的耳机。';
  if (signal.problem === 'TooLoud') return '声音过大导致失真：请把麦克风放远一点或降低输入音量。';
  if (signal.problem === 'NoSignal') return '没有收到任何声音：请确认麦克风未被静音，并选择正确的输入设备。';
  if (signal.problem === 'TooFast') return '语速过快：请放慢一点，一次说一句完整的话。';
  if (signal.problem === 'TooSlow') return '停顿过长：请连贯说一句完整的话。';
  if (signal.problem === 'TooSoft' || signal.level < 12) return '麦克风信号过弱：请靠近麦克风，或在系统声音设置里提高输入音量/麦克风加强。';
  return `正在接收语音（电平 ${signal.level}/100）。听到后可继续说，识别不清时会提示你重说。`;
}

export interface LocalVoiceBridge {
  status(): Promise<LocalVoiceStatus>;
  dictate?(): Promise<LocalDictationResult>;
  cancelDictation?(): Promise<boolean>;
  enable(): Promise<LocalVoiceStatus>;
  disable(): Promise<LocalVoiceStatus>;
  openSettings(): Promise<boolean>;
  /**
   * 新增能力：请原生侧切换云端听写。原生会先弹本人确认窗口，用户取消时返回 `{ enabled: false }`；
   * 调用方只能按返回值刷新状态，不得自行假定成功。旧宿主没有这个方法，因此保持可选，由调用方
   * 在运行时探测；缺少它不等于本地语音整体不可用。
   */
  setCloudDictation?(enabled: boolean): Promise<{ enabled: boolean }>;
}

export type LocalDictationResult = { status: 'complete'; text: string; localOnly: true; microphoneActive: false; recognition?: 'local' }
  | { status: 'uncertain'; localOnly: true; microphoneActive: false; recognition?: 'local' }
  | { status: 'cancelled'; localOnly: true; recognition?: 'local' }
  | { status: 'complete'; text: string; localOnly: false; recognition: 'cloud'; microphoneActive: false };

export function checkedDictationResult(value: unknown): LocalDictationResult {
  if (!value || typeof value !== 'object') throw new Error('本地听写结果未确认');
  const result = value as Record<string, unknown>;
  const recognition = result.recognition;
  if (result.localOnly === false) {
    // 云端变体是唯一允许 localOnly:false 的形状：必须显式 recognition='cloud'、麦克风已关闭、文本 1～500 字。
    if (result.status !== 'complete' || recognition !== 'cloud' || result.microphoneActive !== false
      || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 500) throw new Error('本地听写结果未确认');
    return { status: 'complete', text: result.text.trim(), localOnly: false, recognition: 'cloud', microphoneActive: false };
  }
  // 本机变体必须 localOnly:true，且不得把自己谎报成云端识别。
  if (result.localOnly !== true || (recognition !== undefined && recognition !== 'local')) throw new Error('本地听写结果未确认');
  // 取消表示没有发生识别，因此不投影 recognition：与“本机/云端”无关，也不携带文本。
  if (result.status === 'cancelled') return { status: 'cancelled', localOnly: true };
  if (result.status === 'uncertain' && result.microphoneActive === false) {
    return { status: 'uncertain', localOnly: true, microphoneActive: false, ...(recognition === 'local' ? { recognition: 'local' as const } : {}) };
  }
  if (result.status !== 'complete' || result.microphoneActive !== false
    || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 500) throw new Error('本地听写结果未确认');
  return { status: 'complete', text: result.text.trim(), localOnly: true, microphoneActive: false, ...(recognition === 'local' ? { recognition: 'local' as const } : {}) };
}

/**
 * 听写结束后的路径提示。云端与本机必须分别说清音频去向；面板和测试共用这一份文案。
 * 取消的结果按本机路径处理（没有上传），但面板另有取消提示，不会把它当成一次识别。
 */
export function dictationPathNotice(result: LocalDictationResult): string {
  return result.recognition === 'cloud'
    ? '本次由云端识别，音频已上传且未在本机保存。'
    : '本次由本机离线识别，音频未上传。';
}

export function checkedCloudDictationToggle(value: unknown): { enabled: boolean } {
  if (!value || typeof value !== 'object' || typeof (value as Record<string, unknown>).enabled !== 'boolean') throw new Error('云端听写设置未确认');
  return { enabled: (value as Record<string, unknown>).enabled as boolean };
}

/** Fail-closed 视图：缺省、缺字段或非布尔一律按“未开启且不可用”处理，绝不假定云端可用。 */
export function cloudDictationState(status: LocalVoiceStatus | null | undefined): LocalCloudDictation {
  const cloud = status?.cloudDictation;
  return { enabled: cloud?.enabled === true, available: cloud?.available === true };
}

/** 云端听写的可用性/开启状态说明；未配置网关或旧宿主时必须说明原因，而不是只显示一个灰掉的开关。 */
export function cloudDictationHint(state: LocalCloudDictation, hostSupportsToggle = true): string {
  if (!hostSupportsToggle) return '当前宿主没有云端听写设置入口，请更新客户端后再试；本机离线听写仍可使用。';
  if (!state.available) return '未配置模型网关，云端听写不可用；本机离线听写仍可使用。';
  return state.enabled
    ? '云端听写已开启：每次听写仍会在原生窗口确认“录音会上传”。'
    : '云端听写默认关闭；开启需本人在原生窗口确认。';
}

declare global {
  interface Window { nuanbanVoice?: LocalVoiceBridge; }
}

export function localVoiceBridge(): LocalVoiceBridge | undefined {
  const bridge = window.nuanbanVoice;
  return bridge && ['status', 'enable', 'disable', 'openSettings'].every(method => typeof bridge[method as keyof LocalVoiceBridge] === 'function') ? bridge : undefined;
}

export function checkedVoiceStatus(value: unknown): LocalVoiceStatus {
  if (!value || typeof value !== 'object') throw new Error('本地语音状态未确认');
  const current = value as Record<string, unknown>;
  if (!['disabled', 'starting', 'listening', 'question', 'stopping', 'unavailable', 'error'].includes(String(current.phase))
    || typeof current.enabled !== 'boolean' || typeof current.microphoneActive !== 'boolean' || typeof current.dictationAvailable !== 'boolean'
    || current.localOnly !== true || typeof current.message !== 'string' || current.message.length > 500
    || (current.phase === 'disabled' && (current.enabled || current.microphoneActive))) throw new Error('本地语音状态未确认');
  const signal = checkedVoiceSignal(current.signal);
  const cloudDictation = checkedCloudDictation(current.cloudDictation);
  return { phase: current.phase as LocalVoiceStatus['phase'], enabled: current.enabled, microphoneActive: current.microphoneActive,
    dictationAvailable: current.dictationAvailable, localOnly: true, message: current.message,
    ...(signal ? { signal } : {}), ...(cloudDictation ? { cloudDictation } : {}) };
}