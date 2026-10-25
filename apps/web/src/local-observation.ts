export interface LocalObservationStatus {
  state: 'off' | 'observing' | 'privacy_paused' | 'stopped' | 'cleanup_failed';
  captureActive: boolean;
  sourceName: string;
  cloudConfigured: boolean;
  /** 可选：旧宿主/旧测试夹具没有这个字段时，页面显示"模式信息未接入"，不当作截屏可用。 */
  guidance?: LocalGuidanceStatus;
}

export interface LocalGuidanceStatus {
  available: boolean;
  mode: 'screenshot-free' | 'single-frame' | 'continuous' | null;
  modeLabel: string;
  screenshotFree: boolean;
  active: boolean;
  reasonCode: string | null;
  reasonMessage: string | null;
  severity: 'info' | 'blocked';
  suggestSingleFrame: boolean;
  /** 本人是否已同意"把控件名称等文本发给已配置模型"；未同意时不会外发任何内容。 */
  textConsent: boolean;
  counts: { count: number; limit: number; truncated: boolean };
  review: { verdict: 'advanced' | 'unchanged' | 'unverifiable'; code: string; detail: string } | null;
}

export interface LocalObservationBridge {
  status(): Promise<LocalObservationStatus>;
  start(): Promise<LocalObservationStatus>;
  resume(): Promise<LocalObservationStatus>;
  stop(): Promise<LocalObservationStatus>;
  showPet(): Promise<LocalObservationStatus>;
}

declare global {
  interface Window { nuanbanObservation?: LocalObservationBridge; }
}

export function localObservationBridge(): LocalObservationBridge | undefined {
  const bridge = window.nuanbanObservation;
  return bridge && ['status', 'start', 'resume', 'stop', 'showPet'].every(method => typeof bridge[method as keyof LocalObservationBridge] === 'function') ? bridge : undefined;
}

const unavailableGuidance: LocalGuidanceStatus = Object.freeze({ available: false, mode: null, modeLabel: '模式信息未接入',
  screenshotFree: false, active: false, reasonCode: null, reasonMessage: null, severity: 'info', suggestSingleFrame: false,
  textConsent: false, counts: Object.freeze({ count: 0, limit: 0, truncated: false }), review: null });

const guidanceModes = ['screenshot-free', 'single-frame', 'continuous'] as const;
const guidanceVerdicts = ['advanced', 'unchanged', 'unverifiable'] as const;

// 指引模式块是**可选**的新字段：旧宿主没有它时显示"模式信息未接入"（与今天行为一致）；
// 字段类型/枚举/长度任一不合格就整块判为不可用，绝不用来路不明的文案或数字渲染界面。
export function checkedGuidanceStatus(value: unknown): LocalGuidanceStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailableGuidance;
  const current = value as Record<string, unknown>;
  if (current.available !== true) return unavailableGuidance;
  const counts = current.counts as Record<string, unknown> | undefined;
  const review = current.review as Record<string, unknown> | null | undefined;
  const mode = current.mode;
  const reasonCode = current.reasonCode ?? null;
  if (typeof mode !== 'string' || !(guidanceModes as readonly string[]).includes(mode)
    || typeof current.modeLabel !== 'string' || !current.modeLabel || current.modeLabel.length > 64
    || typeof current.screenshotFree !== 'boolean' || typeof current.active !== 'boolean'
    || !(reasonCode === null || (typeof reasonCode === 'string' && /^[a-z][a-z0-9_]{2,47}$/.test(reasonCode)))
    || !(current.reasonMessage === null || (typeof current.reasonMessage === 'string' && current.reasonMessage.length > 0 && current.reasonMessage.length <= 300))
    || !['info', 'blocked'].includes(String(current.severity)) || typeof current.suggestSingleFrame !== 'boolean'
    || typeof current.textConsent !== 'boolean'
    || !counts || typeof counts !== 'object' || !Number.isSafeInteger(counts.count) || (counts.count as number) < 0
    || !Number.isSafeInteger(counts.limit) || (counts.limit as number) < 0 || (counts.limit as number) > 4096
    || typeof counts.truncated !== 'boolean') return unavailableGuidance;
  let checkedReview: LocalGuidanceStatus['review'] = null;
  if (review !== null && review !== undefined) {
    if (typeof review !== 'object' || Array.isArray(review) || typeof review.verdict !== 'string'
      || !(guidanceVerdicts as readonly string[]).includes(review.verdict) || typeof review.code !== 'string' || review.code.length > 48
      || typeof review.detail !== 'string' || review.detail.length > 48) return unavailableGuidance;
    checkedReview = { verdict: review.verdict as 'advanced' | 'unchanged' | 'unverifiable', code: review.code, detail: review.detail };
  }
  return { available: true, mode: mode as LocalGuidanceStatus['mode'], modeLabel: current.modeLabel,
    screenshotFree: current.screenshotFree, active: current.active, reasonCode, reasonMessage: current.reasonMessage as string | null,
    severity: current.severity as 'info' | 'blocked', suggestSingleFrame: current.suggestSingleFrame, textConsent: current.textConsent,
    counts: { count: counts.count as number, limit: counts.limit as number, truncated: counts.truncated as boolean }, review: checkedReview };
}

export function checkedObservationStatus(value: unknown): LocalObservationStatus {
  if (!value || typeof value !== 'object') throw new Error('观察状态未确认');
  const current = value as Record<string, unknown>;
  if (!['off', 'observing', 'privacy_paused', 'stopped', 'cleanup_failed'].includes(String(current.state))
    || typeof current.captureActive !== 'boolean' || typeof current.sourceName !== 'string' || current.sourceName.length > 120
    || typeof current.cloudConfigured !== 'boolean') throw new Error('观察状态未确认');
  return { state: current.state as LocalObservationStatus['state'], captureActive: current.captureActive,
    sourceName: current.sourceName, cloudConfigured: current.cloudConfigured, guidance: checkedGuidanceStatus(current.guidance) };
}

// 界面文案：模式 + "这次为什么没给箭头" + 已读控件数（可核查），不显示控件名原文。
export function guidanceSummary(guidance: LocalGuidanceStatus): { mode: string; reason: string; controls: string; consent: string } {
  const mode = guidance.available && guidance.modeLabel ? guidance.modeLabel : '模式信息未接入（本机指引状态不可用）';
  const reason = guidance.available
    ? (guidance.reasonMessage ?? (guidance.active ? '已按本机控件清单给出箭头位置。' : '尚未发起指引。'))
    : '无法读取本机指引模式；不会因为没有模式信息就改用截屏。';
  const counts = guidance.available
    ? `已读取 ${guidance.counts.count} 个可指引控件（前台窗口上限 ${guidance.counts.limit}${guidance.counts.truncated ? '，清单已截断' : '，未截断'}）`
    : '控件数量未读取';
  const consent = guidance.available && guidance.screenshotFree
    ? (guidance.textConsent ? '文本发送同意：已同意（可在桌宠菜单或指引页撤回）' : '文本发送同意：未同意；未同意前不会把控件名称等文本发给模型')
    : guidance.available ? '文本发送同意：不适用于当前模式' : '文本发送同意：未知';
  return { mode: `当前模式：${mode}`, reason, controls: counts, consent };
}