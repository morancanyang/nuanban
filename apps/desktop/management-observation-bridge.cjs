const { GUIDANCE_REASONS } = require('./observation/uia-guidance.cjs');

const states = new Set(['off', 'observing', 'privacy_paused', 'stopped', 'cleanup_failed']);
const guidanceModes = new Set(['screenshot-free', 'single-frame', 'continuous']);
const guidanceVerdicts = new Set(['advanced', 'unchanged', 'unverifiable']);

// 指引模式块只允许**文本元数据**过桥：模式、原因码、计数、复核结论。
// 控件名原文、像素、帧与路径一律不在白名单内；校验失败一律 fail-closed（旧调用方不受影响）。
function checkedGuidance(value) {
  const unavailable = Object.freeze({ available: false, reason: 'unavailable' });
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.available !== true) return unavailable;
  const { mode, modeLabel, screenshotFree, active, reasonCode, reasonMessage, severity, suggestSingleFrame, textConsent, counts, review } = value;
  if (!guidanceModes.has(mode) || typeof modeLabel !== 'string' || !modeLabel || modeLabel.length > 64
    || typeof screenshotFree !== 'boolean' || typeof active !== 'boolean' || typeof textConsent !== 'boolean'
    || !(reasonCode === null || (typeof reasonCode === 'string' && Object.hasOwn(GUIDANCE_REASONS, reasonCode)))
    || !(reasonMessage === null || (typeof reasonMessage === 'string' && reasonMessage.length > 0 && reasonMessage.length <= 300))
    || !['info', 'blocked'].includes(severity) || typeof suggestSingleFrame !== 'boolean'
    || !counts || typeof counts !== 'object' || !Number.isSafeInteger(counts.count) || counts.count < 0
    || !Number.isSafeInteger(counts.limit) || counts.limit < 0 || counts.limit > 4096 || typeof counts.truncated !== 'boolean') return unavailable;
  let checkedReview = null;
  if (review !== null && review !== undefined) {
    if (typeof review !== 'object' || Array.isArray(review) || !guidanceVerdicts.has(review.verdict)
      || typeof review.code !== 'string' || review.code.length > 48 || typeof review.detail !== 'string' || review.detail.length > 48) return unavailable;
    checkedReview = Object.freeze({ verdict: review.verdict, code: review.code, detail: review.detail });
  }
  return Object.freeze({ available: true, mode, modeLabel, screenshotFree, active, textConsent,
    reasonCode: reasonCode ?? null, reasonMessage: reasonMessage ?? null, severity, suggestSingleFrame,
    counts: Object.freeze({ count: counts.count, limit: counts.limit, truncated: counts.truncated }), review: checkedReview });
}

function registerManagementObservationBridge({ ipcMain, isTrusted, getHost }) {
  const channels = [];

  function hostFor(event, argumentsList) {
    if (!isTrusted(event)) throw new Error('不可信屏幕观察来源');
    if (argumentsList.length !== 0) throw new Error('屏幕范围和用途必须由本人在原生窗口选择');
    const host = getHost();
    if (!host || !host.hasPetWindow()) throw new Error('独立桌宠尚未就绪，请先启动桌宠');
    return host;
  }

  function status(host) {
    const current = host.snapshot();
    const observation = current.observation;
    if (!observation || !states.has(observation.state) || typeof observation.captureActive !== 'boolean') throw new Error('屏幕观察状态未确认');
    const state = observation.captureActive && ['off', 'stopped'].includes(observation.state) ? 'cleanup_failed' : observation.state;
    return Object.freeze({ state, captureActive: observation.captureActive,
      sourceName: typeof observation.sourceName === 'string' ? observation.sourceName.slice(0, 120) : '',
      cloudConfigured: current.capabilities?.cloudAnalysis === true,
      guidance: checkedGuidance(observation.guidance) });
  }

  function handle(channel, action) {
    channels.push(channel);
    ipcMain.handle(channel, (event, ...argumentsList) => action(hostFor(event, argumentsList)));
  }

  handle('nuanban:observation:status', status);
  for (const [action, resume] of [['start', false], ['resume', true]]) {
    handle(`nuanban:observation:${action}`, async host => {
      await host.showPetPanel();
      await host.requestObservation(resume);
      return status(host);
    });
  }
  handle('nuanban:observation:stop', async host => { await host.stop('user'); return status(host); });
  handle('nuanban:observation:show-pet', async host => { await host.showPetPanel(); return status(host); });

  return { dispose() { for (const channel of channels.splice(0)) ipcMain.removeHandler(channel); } };
}

module.exports = { registerManagementObservationBridge };
