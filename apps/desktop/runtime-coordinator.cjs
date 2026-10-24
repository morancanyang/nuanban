const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { matchesVisualControl } = require('./observation/visual-controls.cjs');

const guidanceTraceFile = (() => {
  if (process.env.NUANBAN_GUIDANCE_TRACE === '0') return null;
  const base = process.env.APPDATA || process.env.LOCALAPPDATA || os.tmpdir();
  return nodePath.join(base, '@nuanban', 'desktop', 'guidance-trace.log');
})();

function traceGuidance(event, detail = {}) {
  if (!guidanceTraceFile) return;
  try {
    fs.mkdirSync(nodePath.dirname(guidanceTraceFile), { recursive: true });
    const stat = fs.statSync(guidanceTraceFile, { throwIfNoEntry: false });
    if (stat && stat.size > 512 * 1024) fs.renameSync(guidanceTraceFile, guidanceTraceFile + '.1');
  } catch {}
  try {
    fs.appendFileSync(guidanceTraceFile, JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + '\n');
  } catch {}
}
const { evaluateLocalFrame, isAdmittedFrame, isRestrictedText, normalizeLabel, safeSummary } = require('./observation-policy.cjs');
const { captureFailureReason, captureFailureMessage, localDetectionFailureMessage } = require('./observation/observation-common.cjs');

function checkedLabels(value) {
  if (!Array.isArray(value) || value.length > 10 || value.some(label => typeof label !== 'string'
    || !normalizeLabel(label) || label.length > 80 || isRestrictedText(label))) throw new Error('invalid_analysis_labels');
  return [...new Map(value.map(label => [normalizeLabel(label), label])).values()];
}

function analysisFailureMessage(error, timedOut) {
  const messages = {
    ANALYSIS_TIMEOUT: '本次屏幕分析超时，已取消请求；可以手动重新提问或结束教学，不会自动重试。',
    ANALYSIS_UNAVAILABLE: '模型服务暂时不可用（网络中断或服务端错误，已做有界自动重试）；未显示箭头，不会用演示数据替代。可稍后手动重新提问。',
    ANALYSIS_AUTH_FAILED: '模型认证或权限检查失败，请检查模型凭证和模型权限；未显示箭头。',
    ANALYSIS_RATE_LIMITED: '模型服务暂时限流（已做有界自动重试）；未显示箭头；请稍后手动重新提问。',
    ANALYSIS_IMAGE_TOO_LARGE: '脱敏画面超过分析服务大小上限，本次未发送，未显示箭头；当前本地共享仍保持。可停止共享后重新选择较小区域，再手动提问。',
    ANALYSIS_VISION_REQUIRED: '当前本机模型是纯文字模型，看不到任何图片，因此无法分析屏幕；未发送画面、未显示箭头。请安装视觉模型（命令示例：ollama pull qwen2.5vl:3b），或在桌宠右键菜单“配置云端智能服务”里换成支持看图的云端模型。',
    ANALYSIS_RESPONSE_INCOMPLETE: '模型结果未完整返回，未显示箭头；请手动重新提问，不会使用残缺结果。',
    ANALYSIS_FAILED: '模型请求失败（网络、图片大小或返回异常），未显示箭头；请稍后手动重新提问，不会使用旧位置。',
    INVALID_ANALYSIS_RESPONSE: '模型返回的格式或目标未通过本机校验，未显示箭头；请重新提问。若反复出现，请检查模型是否支持图片与 JSON 指引。',
    OUTBOUND_CLOSED: '分析返回时画面已过期或观察范围发生变化，未显示箭头。请保持目标区域可见，再点击“查找并指引”；不会使用旧位置。',
  };
  const code = timedOut ? 'ANALYSIS_TIMEOUT' : error?.code;
  return Object.hasOwn(messages, code) ? messages[code]
    : '本次分析未获得可核验的结果。可以重新提问、核验或结束，不会继续指错。';
}

function reviewSuggestion(value, sourceGuideId, timestamp) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = ['remind_at', 'timezone', 'reason'];
  if (Reflect.ownKeys(descriptors).length !== keys.length
    || !keys.every(key => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value'))) return null;
  const { remind_at: remindAt, timezone, reason } = value;
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 240 || isRestrictedText(reason)
    || /[<>\x00-\x1F]/u.test(reason) || typeof timezone !== 'string' || timezone.length > 64
    || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone)) return null;
  const parts = typeof remindAt === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(remindAt) : null;
  if (!parts) return null;
  const [, year, month, day, hour, minute, second, zone, zoneHour, zoneMinute] = parts;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  calendar.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  const dueAt = Date.parse(remindAt);
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() + 1 !== Number(month) || calendar.getUTCDate() !== Number(day)
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (zone !== 'Z' && (Number(zoneHour) > 14 || Number(zoneMinute) > 59 || (Number(zoneHour) === 14 && Number(zoneMinute) !== 0)))
    || !Number.isFinite(timestamp) || !Number.isFinite(dueAt) || dueAt <= timestamp || dueAt - timestamp > 365 * 86400000) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { return null; }
  return { sourceGuideId, remindAt, timezone, reason: safeSummary(reason, 240).trim(), source: 'ai' };
}

function createDesktopRuntime(options) {
  if (!options?.source || typeof options.source.capture !== 'function' || typeof options.source.detect !== 'function') throw new TypeError('本地观察端口不完整');
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 1500;
  const maxAgeMs = options.maxAgeMs ?? 5000;
  const staleFrameRetryLimit = 3;
  // Admission stays at five seconds. A frame that was admitted may be a little older by the time the
  // analysis payload is prepared (PNG downscale/encode): the uploaded image is only used to pick a
  // target from the locally detected element list, and the target is re-verified against a fresh
  // admitted frame before any arrow appears, so the send path gets a bounded extra budget.
  const analysisSendMaxAgeMs = Math.min(9000, maxAgeMs + 4000);
  const analysisTimeoutMs = options.analysisTimeoutMs ?? 50000;
  // 云端通常几十秒内返回；本机 CPU 视觉模型分析整屏可能要几分钟，因此允许更长的上限。
  const analysisTimeoutLimitMs = options.analysisTimeoutLimitMs ?? 60000;
  if (!Number.isSafeInteger(analysisTimeoutMs) || analysisTimeoutMs < 1 || analysisTimeoutMs > analysisTimeoutLimitMs
    || !Number.isSafeInteger(analysisTimeoutLimitMs) || analysisTimeoutLimitMs < 1 || analysisTimeoutLimitMs > 180000) throw new TypeError('屏幕分析超时配置无效');
  // A locally detected runtime reports `vision`; cloud providers leave it undefined (unknown).
  const localModelProvider = options.questioner?.vision !== undefined;
  const localModelVision = options.questioner?.vision === true;
  const notify = options.onState ?? (() => undefined);
  const renderTarget = options.onTarget ?? (() => undefined);
  // Owner-approved raw upload: when enabled, the policy accepts frames that were not masked locally.
  const isUnredactedUpload = typeof options.isUnredactedUpload === 'function' ? options.isUnredactedUpload : () => options.unredactedUpload === true;
  let observationGeneration = 0;
  let taskGeneration = 0;
  let analysisSequence = 0;
  let questionSequence = 0;
  let timer = null;
  let targetTimer = null;
  let captureController = null;
  let captureJob = null;
  let analysisController = null;
  let analysisJob = null;
  let questionController = null;
  let questionJob = null;
  let cleanupJob = null;
  let pendingReason = null;
  let pendingAnalysis = null;
  let latestFrame = null;
  let analysisFrame = null;
  let previousStep = null;
  let targetMisses = 0;
  let clarificationReplies = [];
  let sourceId = null;
  let observationRegion = null;
  let cloudConsent = false;
  let gateOpen = false;
  let disposed = false;
  const recordedTasks = new Set();
  const recordingTasks = new Map();
  const state = {
    observation: { state: 'off', generation: 0, sourceName: '', reason: null, captureActive: false, cloudConsent: false },
    task: { state: 'idle', id: null, observationGeneration: 0, question: '', instruction: '', explanation: '', presentation: null, targetState: 'hidden', result: null, autoStep: false, stepIndex: 0 },
    analysis: { state: 'idle', message: '默认不采集。请本人选择观察范围并开启。' },
    captions: { enabled: false, text: '' },
    wake: { state: 'unsupported', reason: '尚未配置经本机验证的本地唤醒引擎；点击和文字提问仍可用。' },
    messages: [], message: '右键查看功能；提问和教学不需要打开管理窗口。',
  };

  function snapshot() {
    return structuredClone({ ...state, observation: { ...state.observation, generation: observationGeneration, unredactedUpload: isUnredactedUpload() }, task: { ...state.task, generation: taskGeneration } });
  }

  function publish() {
    notify(snapshot());
  }

  function message(text, role = 'system') {
    state.message = text;
    state.messages.push({ id: randomUUID(), role, text });
    if (state.messages.length > 24) state.messages.splice(0, state.messages.length - 24);
  }

  function clearTarget(reason = 'unspecified') {
    clearTimeout(targetTimer);
    targetTimer = null;
    targetMisses = 0;
    if (state.task.targetState === 'visible') traceGuidance('arrow_hide', { reason });
    state.task.targetState = 'hidden';
    renderTarget(null);
  }

  function release(frame) {
    if (frame && frame !== latestFrame && frame !== analysisFrame && frame !== pendingAnalysis?.frame) frame.sanitizedPng?.fill(0);
  }

  function sameFrameScope(first, second) {
    return Boolean(first && second && first.sourceId === second.sourceId && first.displayId === second.displayId
      && first.width === second.width && first.height === second.height
      && JSON.stringify(first.geometry) === JSON.stringify(second.geometry));
  }

  function sameFrameContext(first, second) {
    return sameFrameScope(first, second) && first.signature === second.signature;
  }

  function invalidateAnalysis() {
    analysisSequence += 1;
    analysisController?.abort();
    const obsolete = pendingAnalysis?.frame;
    pendingAnalysis = null;
    release(obsolete);
  }

  function invalidateQuestion() {
    questionSequence += 1;
    questionController?.abort();
    questionController = null;
  }

  function textQuestionFailure(error) {
    const messages = {
      AUTH_FAILED: '模型凭证或模型权限无效，未使用模拟答案。',
      RATE_LIMITED: '模型网关暂时限流，请稍后手动重试。',
      TIMEOUT: '等待模型超时，已停止请求，未使用模拟答案。',
      CANCELLED: '本次文字提问已停止。',
    };
    return messages[error?.code] ?? '真实文字模型接口暂不可用，未使用模拟答案。';
  }

  function cleanTextAnswer(value) {
    return typeof value === 'string' && value.length <= 24000 ? value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim() : '';
  }

  async function answerTextQuestion(questionText, taskId, taskGenerationAtStart) {
    if (typeof options.questioner?.answer !== 'function') return false;
    const sequence = questionSequence;
    const observation = observationGeneration;
    const controller = new AbortController();
    questionController = controller;
    const stillCurrent = () => !disposed && sequence === questionSequence
      && state.task.id === taskId && taskGeneration === taskGenerationAtStart && observationGeneration === observation;
    let timedOut = false;
    let rejectCancellation;
    const cancellation = new Promise((_resolve, reject) => {
      rejectCancellation = () => reject(Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' }));
    });
    controller.signal.addEventListener('abort', rejectCancellation, { once: true });
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 45000);
    timeout.unref?.();
    const job = (async () => {
      state.task.state = 'analyzing';
      state.analysis = { state: 'analyzing', message: '正在请求文字模型；本次仅发送输入文字，不附带屏幕或音频。' };
      publish();
      try {
        controller.signal.throwIfAborted();
        const reply = await Promise.race([options.questioner.answer({ question: questionText, signal: controller.signal,
          instructions: '这是独立桌宠的文字提问，没有提供当前屏幕画面。只回答一般性的操作准备、功能说明和安全提示；不得声称看到了桌面、当前软件状态或已经完成操作。若问题需要判断当前画面，请提示本人先选择真实屏幕范围并开启本地观察。用户必须亲手打开软件、切换窗口、点击和输入；不得索取或处理密码、验证码、支付、转账或私人信息。' }), cancellation]);
        if (!stillCurrent() || controller.signal.aborted) return false;
        const answer = cleanTextAnswer(reply?.text);
        if (!answer) throw Object.assign(new Error('empty_text_answer'), { code: 'PROVIDER_UNAVAILABLE' });
        state.task.state = 'ended';
        state.task.explanation = answer;
        state.task.result = 'answered';
        state.analysis = { state: 'idle', message: '文字模型已返回；本次未发送屏幕或音频，不代表教学已完成。' };
        state.captions.text = answer;
        message(answer, 'assistant');
      } catch (error) {
        if (!stillCurrent() || (controller.signal.aborted && !timedOut)) return false;
        const detail = textQuestionFailure(timedOut ? { code: 'TIMEOUT' } : error);
        state.task.state = 'ended';
        state.task.explanation = detail;
        state.task.result = 'failed';
        state.analysis = { state: 'error', message: '文字模型未返回有效回答。' };
        state.captions.text = detail;
        message(detail, 'assistant');
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener('abort', rejectCancellation);
        if (questionController === controller) questionController = null;
      }
      publish();
      return true;
    })();
    questionJob = job;
    try { return await job; } finally { if (questionJob === job) questionJob = null; }
  }

  async function recordTeaching(result, task = { ...state.task }) {
    if (!task.id || task.kind === 'text' || recordedTasks.has(task.id)) return false;
    if (recordingTasks.has(task.id)) return recordingTasks.get(task.id);
    const note = {
      sourceGuideId: task.id, question: safeSummary(task.question),
      summary: safeSummary(task.instruction || task.explanation || '教学未完成。'),
      result, mastery: 'unmastered', startedAt: task.startedAt, endedAt: now(),
    };
    const recording = Promise.resolve().then(async () => {
      if (options.recordTeaching) await options.recordTeaching(note);
      recordedTasks.add(task.id);
      if (recordedTasks.size > 128) recordedTasks.delete(recordedTasks.values().next().value);
      return typeof options.recordTeaching === 'function';
    });
    recordingTasks.set(task.id, recording);
    try { return await recording; } finally { recordingTasks.delete(task.id); }
  }

  async function finishTeaching(result = 'unfinished', completion = null) {
    if (result === 'completed' && !completion) throw new Error('教学完成必须通过新画面的实际变化核验');
    const task = { ...state.task };
    const observation = observationGeneration;
    const generation = ++taskGeneration;
    clarificationReplies = [];
    state.task.awaitingReply = false;
    const stillCurrent = () => !disposed && state.task.id === task.id && taskGeneration === generation && observationGeneration === observation;
    questionController?.abort();
    invalidateAnalysis();
    clearTarget();
    previousStep = null;
    if (task.kind === 'text') {
      if (task.state !== 'ended') {
        state.task.state = 'ended';
        state.task.result = 'cancelled';
        state.task.explanation = '本次文字提问已停止，不会自动恢复。';
      }
      if (state.observation.state === 'observing' || state.analysis.state !== 'error') state.analysis = { state: 'idle', message: '文字提问已结束；没有记录为屏幕教学完成。' };
      state.captions.text = '';
      publish();
      return snapshot();
    }
    if (task.id && !['completed', 'ended'].includes(task.state)) {
      state.task.state = 'finishing';
      let saved;
      try { saved = await recordTeaching(result, task); }
      catch {
        if (!stillCurrent()) return snapshot();
        message('本次教学记录未保存，请保留当前窗口稍后重试。');
        state.task.state = 'needs_help';
        state.analysis = { state: 'error', message: '教学记录未保存，不会创建复习建议或提醒。' };
        publish();
        return snapshot();
      }
      if (!stillCurrent()) return snapshot();
      state.task.state = result === 'completed' ? 'completed' : 'ended';
      state.task.result = result;
      state.task.instruction = '';
      if (saved && completion?.review && options.suggestReview && state.observation.state === 'observing' && gateOpen) {
        const suggestion = reviewSuggestion(completion.review, task.id, now());
        if (suggestion) {
          try { await options.suggestReview(suggestion); }
          catch { if (stillCurrent()) message('教学记录已保存，但复习建议未保存；未创建提醒，请稍后重试。'); }
          if (!stillCurrent()) return snapshot();
        }
      }
    }
    if (state.observation.state === 'observing' || state.analysis.state !== 'error') state.analysis = { state: 'idle', message: state.observation.state === 'observing' ? '本次教学已结束；仍获授权的本地观察可继续。' : '本次教学已结束；本地观察已停止，不会自动重新开启。' };
    state.captions.text = '';
    publish();
    return snapshot();
  }

  function closeObservation(reason, privacyPaused = false) {
    if (cleanupJob) return cleanupJob.then(async result => {
      if (!privacyPaused) {
        state.observation.state = result.stopped ? 'stopped' : 'cleanup_failed';
        await finishTeaching('interrupted');
        publish();
      }
      return result;
    });
    cleanupJob = performCloseObservation(reason, privacyPaused).finally(() => { cleanupJob = null; });
    return cleanupJob;
  }

  async function performCloseObservation(reason, privacyPaused) {
    invalidateQuestion();
    gateOpen = false;
    cloudConsent = false;
    state.observation.cloudConsent = false;
    observationGeneration += 1;
    invalidateAnalysis();
    pendingReason = null;
    clearTimeout(timer);
    timer = null;
    captureController?.abort();
    clearTarget();
    previousStep = null;
    const obsolete = latestFrame;
    latestFrame = null;
    release(obsolete);
    state.observation.state = privacyPaused ? 'privacy_paused' : 'stopped';
    state.observation.reason = reason;
    const failureMessage = captureFailureMessage(reason) ?? localDetectionFailureMessage(reason);
    const safetyMessage = ['unclassified_screen', 'unknown'].includes(reason)
      ? '本地分类器尚未识别此画面，不等于已发现敏感内容。已停止采集和发送；请在“继续共享”中选择“框选观察区域”，只保留目标软件后重新检查。'
      : reason === 'sensitive_screen' ? '本地检测发现敏感文字，已停止采集和发送。请先关闭敏感页面，再由本人重新选择观察范围。'
      : '本地安全检查未完成或未通过，已停止采集和发送。请重新选择观察范围；若仍失败，请停止观察后检查本地检测能力。';
    state.analysis = { state: failureMessage || privacyPaused ? 'error' : 'idle', message: failureMessage ?? (privacyPaused ? safetyMessage : '观察已停止；不会自动重新开启。') };
    state.captions.text = '';
    publish();
    let stopped = true;
    try { await options.source.stop?.(); }
    catch {
      stopped = false;
      state.observation.state = 'cleanup_failed';
      state.observation.reason = 'capture_cleanup_failed';
      message('本地采集退出未确认，已关闭发送。请退出桌宠后重新启动，不能继续共享。');
    }
    state.observation.captureActive = !stopped;
    if (!privacyPaused) await finishTeaching('interrupted');
    else if (state.task.id) state.task.state = 'needs_help';
    publish();
    return { stopped, captureActive: !stopped, mediaActive: false, reason };
  }

  function sameGeneration(observation, task) {
    return !disposed && state.observation.state === 'observing' && observationGeneration === observation && (task === undefined || taskGeneration === task);
  }

  function scheduleCapture() {
    clearTimeout(timer);
    timer = null;
    if (disposed || state.observation.state !== 'observing') return;
    const targetAge = hasActiveGuidanceTask() && latestFrame
      ? Math.max(0, now() - latestFrame.capturedAt) : 0;
    timer = setTimeout(() => { timer = null; requestFrame('page_changed'); }, Math.max(0, intervalMs - targetAge));
    timer.unref?.();
  }

  function hasActiveGuidanceTask() {
    return Boolean(state.task.id && state.task.kind === 'guidance'
      && !['completed', 'ended', 'idle', 'finishing'].includes(state.task.state));
  }

  function noteStaleFrameRetry(retryCount) {
    clearTarget();
    state.observation.reason = 'stale_frame';
    state.analysis = {
      state: 'capture_retry',
      message: `本地画面处理较慢，正在重新采集最新画面（${retryCount}/${staleFrameRetryLimit}）；不会使用过期画面，也不会重新请求屏幕共享。`,
    };
    publish();
  }

  function failStaleFrameRefresh() {
    invalidateAnalysis();
    clearTarget();
    const obsolete = latestFrame;
    latestFrame = null;
    release(obsolete);
    gateOpen = false;
    state.observation.reason = 'stale_frame';
    const detail = '本地画面处理超时，未使用过期画面。请保持目标软件可见后重新点击“查找并指引”；当前屏幕共享仍保持，不需要重新授权。';
    if (hasActiveGuidanceTask()) {
      state.task.state = 'needs_help';
      state.task.targetState = 'stale';
      state.task.awaitingReply = false;
      state.task.explanation = detail;
    }
    state.captions.text = '';
    state.analysis = { state: 'capture_error', message: detail };
    publish();
  }

  function hasVerifiedGeometry(frame) {
    const geometry = frame.geometry;
    return Boolean(geometry && [geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite)
      && geometry.width > 0 && geometry.height > 0
      && (geometry.scaleFactor === undefined || (Number.isFinite(geometry.scaleFactor) && geometry.scaleFactor > 0))
      && Math.abs((frame.width / frame.height) / (geometry.width / geometry.height) - 1) <= 0.01);
  }

  function targetFor(frame, element) {
    if (!hasVerifiedGeometry(frame)) return null;
    const geometry = frame.geometry;
    return {
      x: geometry.x + element.rect.x * geometry.width / frame.width,
      y: geometry.y + element.rect.y * geometry.height / frame.height,
      width: element.rect.width * geometry.width / frame.width,
      height: element.rect.height * geometry.height / frame.height,
    };
  }

  function currentElement(original, originalFrame, currentFrame) {
    if (!sameFrameContext(originalFrame, currentFrame)) return null;
    const matches = currentFrame.elements.filter(element => normalizeLabel(element.label) === normalizeLabel(original.label)
      && matchesVisualControl(original, element)
      && Math.abs(element.rect.x - original.rect.x) <= 4 && Math.abs(element.rect.y - original.rect.y) <= 4);
    return matches.length === 1 ? matches[0] : null;
  }

  function relocatedElement(original, originalFrame, currentFrame) {
    // Retention of an already verified arrow tolerates unrelated text drift: same capture scope plus
    // the same label within 4 px is enough to keep pointing at the same control. Install-time
    // verification keeps using the strict signature-based currentElement().
    if (!sameFrameScope(originalFrame, currentFrame)) return null;
    const matches = currentFrame.elements.filter(element => normalizeLabel(element.label) === normalizeLabel(original.label)
      && matchesVisualControl(original, element)
      && Math.abs(element.rect.x - original.rect.x) <= 4 && Math.abs(element.rect.y - original.rect.y) <= 4);
    return matches.length === 1 ? matches[0] : null;
  }

  function currentShellElement(step, frame) {
    const original = step?.element;
    if (!original || !['taskbar', 'desktop'].includes(original.surface)
      || !sameFrameScope(step.frame, frame) || !isAdmittedFrame(frame, now(), maxAgeMs)) return null;
    const matches = frame.elements.filter(element => element.surface === original.surface
      && normalizeLabel(element.label) === normalizeLabel(original.label)
      && ['x', 'y', 'width', 'height'].every(key => Math.abs(element.rect[key] - original.rect[key]) <= 4));
    return matches.length === 1 ? matches[0] : null;
  }

  function showStepTarget(frame, element) {
    clearTimeout(targetTimer);
    targetTimer = null;
    const rect = targetFor(frame, element);
    if (!rect) {
      clearTarget();
      state.task.targetState = 'unavailable';
      state.task.explanation = '当前捕获范围的屏幕坐标未验证，暂不绘制位置指引。请重新选择观察屏幕后再查找。';
      return false;
    }
    // The image may already be a few seconds old when local OCR/UIA finishes, but the target was
    // just re-verified against an admitted frame. The visible window is therefore measured from the
    // verification time and renewed by the next admitted frame; if no fresh frame renews it for five
    // seconds the timer below hides the arrow.
    const verifiedAt = now();
    const expiresAt = verifiedAt + 5000;
    if (expiresAt <= verifiedAt) {
      clearTarget();
      state.task.targetState = 'stale';
      return false;
    }
    if (renderTarget({ visible: true, rect, label: element.label, instruction: state.task.instruction, presentation: state.task.presentation, expiresAt }) === false) {
      clearTarget();
      state.task.targetState = 'unavailable';
      state.task.explanation = '指引窗口未能在当前屏幕显示，未显示箭头。请重新选择观察屏幕后再查找；不要按旧位置操作。';
      return false;
    }
    targetMisses = 0;
    traceGuidance('arrow_show', { expiresInMs: expiresAt - now(), labelLen: element.label.length });
    state.task.explanation = state.task.presentation === 'uncertain_candidate'
      ? '这是当前画面中的候选位置，尚未确认；请先核对。' : '请亲手操作；微光指引不会自动点击或输入。';
    state.task.targetState = 'visible';
    targetTimer = setTimeout(() => {
      clearTarget('expired');
      if (state.task.state === 'awaiting_action') state.task.targetState = 'stale';
      publish();
    }, expiresAt - now());
    targetTimer.unref?.();
    return true;
  }

  function canUseFrame(frame, observation, task, allowRefreshed = false) {
    const current = latestFrame;
    const timestamp = now();
    if (!gateOpen || !cloudConsent || !sameGeneration(observation, task) || !current
      || !sameFrameContext(current, frame) || current.capturedAt < frame.capturedAt
      || !isAdmittedFrame(current, timestamp, maxAgeMs)) return false;
    if (isAdmittedFrame(frame, timestamp, maxAgeMs)) return true;
    return allowRefreshed && current.capturedAt > frame.capturedAt
      && typeof frame.displayId === 'string' && Boolean(frame.displayId.trim())
      && hasVerifiedGeometry(frame) && hasVerifiedGeometry(current)
      && isAdmittedFrame(current, timestamp, Math.min(maxAgeMs, 5000))
      && isAdmittedFrame(frame, frame.capturedAt, maxAgeMs);
  }

  const { createAnalysisImageScaler, ANALYSIS_IMAGE_LIMIT_BYTES: analysisImageLimitBytes } = require('./analysis-image.cjs');
  const scaleAnalysisImage = createAnalysisImageScaler({ nativeImage: options.nativeImage });

  function analysisImageFor(frame) {
    if (typeof options.resizeAnalysisImage === 'function') {
      try {
        const provided = options.resizeAnalysisImage(frame, analysisImageLimitBytes);
        if (provided && typeof provided.image?.bytes?.length === 'number' && provided.image.bytes.length <= 2_000_000) return provided;
      } catch {}
    }
    const prepared = scaleAnalysisImage(frame?.sanitizedPng);
    if (prepared) {
      traceGuidance('analysis_image_scaled', { originalBytes: frame.sanitizedPng.length, bytes: prepared.image.bytes.length,
        width: prepared.image.width, height: prepared.image.height });
    }
    return prepared;
  }

  function installableOnLatest(job) {
    const current = latestFrame;
    return Boolean(current && gateOpen && cloudConsent && sameGeneration(job.observation, job.task)
      && sameFrameScope(current, job.frame) && isAdmittedFrame(current, now(), maxAgeMs));
  }

  function verifiedTransition(step, frame) {
    if (!step || frame.sourceId !== step.frame.sourceId || frame.displayId !== step.frame.displayId
      || frame.capturedAt <= Math.max(step.frame.capturedAt, step.issuedAt)
      || !isAdmittedFrame(frame, now(), maxAgeMs)) return false;
    const expected = step.expectedLabels.map(normalizeLabel);
    const labels = new Set(frame.elements.map(element => normalizeLabel(element.label)));
    return expected.length > 0 && expected.every(label => labels.has(label))
      && expected.some(label => !step.baselineLabels.has(label));
  }

  async function installAnalysis(result, job) {
    const current = latestFrame;
    if (!current || !installableOnLatest(job) || !isAdmittedFrame(current, now(), maxAgeMs)
      || job.previous !== previousStep) throw new Error('stale_analysis_frame');
    if (!result || typeof result.instruction !== 'string' || !result.instruction.trim()
      || result.instruction.length > 600 || isRestrictedText(result.instruction)) throw new Error('invalid_analysis');
    const identity = result.observation_generation === job.observation && result.task_generation === job.task
      && result.frame_id === job.frame.frameId && result.guide_id === job.guideId && result.trigger_id === job.triggerId
      && (result.observation_id === undefined || result.observation_id === job.observationId);
    if (!identity) throw new Error('stale_analysis');
    if (result.kind === 'completed') {
      // Completion needs proven DIP geometry and display identity for both the analysed frame and
      // the frame the completion is verified against; otherwise only a step explanation is allowed.
      if (typeof job.frame.displayId !== 'string' || !job.frame.displayId.trim()
        || typeof current.displayId !== 'string' || !current.displayId.trim()
        || !hasVerifiedGeometry(job.frame) || !hasVerifiedGeometry(current)) throw new Error('completion_geometry_unverified');
      const labels = new Set(current.elements.map(element => normalizeLabel(element.label)));
      const evidence = checkedLabels(result.evidence_labels).map(normalizeLabel);
      if (!['verification', 'page_changed'].includes(job.reason) || !verifiedTransition(job.previous, current)
        || !evidence.every(label => labels.has(label))
        || !job.previous.expectedLabels.every(label => evidence.includes(normalizeLabel(label)))) throw new Error('completion_not_verified');
      const proposedReview = reviewSuggestion(Object.getOwnPropertyDescriptor(result, 'review_proposal')?.value, job.guideId, now());
      state.task.explanation = result.instruction;
      state.captions.text = result.instruction;
      message(result.instruction, 'assistant');
      await finishTeaching('completed', { review: proposedReview
        ? Object.freeze({ remind_at: proposedReview.remindAt, timezone: proposedReview.timezone, reason: proposedReview.reason }) : null });
      return true;
    }
    if (result.kind !== 'step') {
      if (!['clarify', 'unsupported'].includes(result.kind)) throw new Error('invalid_analysis_kind');
      clearTarget();
      state.task.state = 'needs_help';
      state.task.instruction = '';
      state.task.presentation = null;
      state.task.explanation = result.instruction;
      state.task.awaitingReply = result.kind === 'clarify';
      state.analysis = { state: 'ready', message: '本次画面分析已结束，未定位到可核验的目标；没有生成箭头，请查看说明后继续。' };
      state.captions.text = result.instruction;
      message(result.instruction, 'assistant');
      return true;
    }
    const proposed = job.frame.elements.find(element => element.id === result.target_id);
    const element = proposed ? relocatedElement(proposed, job.frame, current) : null;
    if (!element || !['confirmed', 'uncertain_candidate'].includes(result.presentation)) throw new Error('target_not_in_current_frame');
    const expected = result.expected_labels === undefined ? [] : checkedLabels(result.expected_labels);
    const progressed = verifiedTransition(job.previous, current);
    if (job.previous && !progressed) {
      const repeated = relocatedElement(job.previous.element, job.previous.frame, current);
      const sameExpectation = expected.length === job.previous.expectedLabels.length
        && expected.every(label => job.previous.expectedLabels.some(item => normalizeLabel(item) === normalizeLabel(label)));
      if (!repeated || repeated.id !== element.id || !sameExpectation) throw new Error('previous_step_not_verified');
    }
    const nextStepIndex = (state.task.stepIndex ?? 0) + 1;
    if (state.task.autoStep && nextStepIndex > 12) {
      clearTarget();
      state.task.explanation = '自动步进已达到 12 步上限，已停止继续上传；你可以点“再讲一遍”，或结束教学后重新开始。';
      state.analysis = { state: 'ready', message: state.task.explanation };
      state.captions.text = state.task.explanation;
      message(state.task.explanation, 'assistant');
      await finishTeaching('interrupted');
      return true;
    }
    state.task.stepIndex = nextStepIndex;
    state.task.state = 'awaiting_action';
    state.task.awaitingReply = false;
    state.task.instruction = result.instruction;
    state.task.presentation = element.surface === 'visual' ? 'uncertain_candidate' : result.presentation;
    if (element.surface === 'visual' && result.presentation === 'confirmed') state.task.instruction = '请先核对箭头处的图标候选是否为要找的入口，确认后再由本人操作。';
    state.task.explanation = state.task.presentation === 'uncertain_candidate' ? '这是当前画面中的候选位置，尚未确认；请先核对。' : '请亲手操作；微光指引不会自动点击或输入。';
    state.captions.text = state.task.instruction;
    previousStep = job.previous && !progressed ? job.previous : {
      element: { ...element, rect: { ...element.rect } }, signature: current.signature, frame: current,
      baselineLabels: new Set(current.elements.map(item => normalizeLabel(item.label))), issuedAt: now(),
      expectedLabels: expected, instruction: state.task.instruction,
    };
    showStepTarget(current, element);
    message(state.task.instruction, 'assistant');
    return true;
  }

  function queueAnalysis(frame, reason) {
    if (!state.task.id || state.task.kind === 'text' || ['completed', 'ended', 'idle', 'finishing'].includes(state.task.state)) return;
    if (reason === 'page_changed' && (state.task.awaitingReply || state.analysis.state === 'capture_error')) return;
    if (!cloudConsent || !options.analyzer?.analyze) {
      state.analysis = { state: 'unavailable', message: cloudConsent ? '尚未配置已认证的云分析服务；不使用模拟答案。' : '未同意云分析，画面仅在本地处理。可停止或重新选择观察用途。' };
      state.task.state = 'needs_help';
      publish();
      return;
    }
    const obsolete = pendingAnalysis?.frame;
    pendingAnalysis = { frame, reason, observation: observationGeneration, task: taskGeneration, triggerId: randomUUID(), previous: previousStep,
      guideId: state.task.id, question: state.task.question, clarificationReplies: clarificationReplies.map(reply => ({ ...reply })), observationId: state.observation.id };
    release(obsolete);
    if (analysisJob) {
      analysisController?.abort();
      return;
    }
    analysisJob = (async () => {
      while (pendingAnalysis) {
        const job = pendingAnalysis;
        pendingAnalysis = null;
        analysisFrame = job.frame;
        const sequence = ++analysisSequence;
        const controller = new AbortController();
        analysisController = controller;
        if (!canUseFrame(job.frame, job.observation, job.task)) { analysisFrame = null; release(job.frame); continue; }
        traceGuidance('analysis_request', { pngBytes: job.frame?.sanitizedPng?.length ?? 0, elements: job.frame?.elements?.length ?? 0,
          reason: job.reason, frameAgeMs: job.frame ? now() - job.frame.capturedAt : null, sendMaxAgeMs: analysisSendMaxAgeMs });
        state.analysis = { state: 'analyzing', message: localModelProvider && localModelVision
          ? '仅为本次有效触发发送经过本地检查与脱敏的必要画面。本机视觉模型在 CPU 上分析整屏可能需要 1–2 分钟，请勿重复点击；框选更小的观察区域会明显更快。'
          : '仅为本次有效触发发送经过本地检查与脱敏的必要画面。' };
        state.task.state = job.reason === 'verification' ? 'verifying' : 'analyzing';
        publish();
        let timedOut = false;
        let rejectCancellation;
        const cancellation = new Promise((_resolve, reject) => {
          rejectCancellation = () => reject(Object.assign(new Error('ANALYSIS_CANCELLED'), { code: 'ANALYSIS_CANCELLED' }));
        });
        controller.signal.addEventListener('abort', rejectCancellation, { once: true });
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, analysisTimeoutMs);
        timeout.unref?.();
        const canSend = () => !controller.signal.aborted && sequence === analysisSequence
          && canUseFrame(job.frame, job.observation, job.task, true);
        // Real capture+detect cycles here take ~3.5s, so the threshold must stay below the five
        // second safety limit rather than assuming a fast local pipeline.
        // installableOnLatest already requires an admitted frame (<= maxAge) in the same capture
        // scope; a second "extra fresh" margin made full-screen installs impossible because one
        // capture+OCR cycle finishes near age 4.3-4.7s.
        const readyToInstall = () => installableOnLatest(job);
        const confirmCurrentFrame = async () => {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            if (readyToInstall()) return true;
            if (controller.signal.aborted || sequence !== analysisSequence || !gateOpen || !cloudConsent
              || !sameGeneration(job.observation, job.task) || !sameFrameScope(latestFrame, job.frame)) {
              traceGuidance('install_blocked', { aborted: controller.signal.aborted, sequence, gateOpen, cloudConsent,
                sameGeneration: sameGeneration(job.observation, job.task),
                sameScope: Boolean(latestFrame && sameFrameScope(latestFrame, job.frame)) });
              return false;
            }
            if (!captureJob) requestFrame('page_changed');
            if (!captureJob) return false;
            state.analysis = { state: 'analyzing', message: '分析已返回，正在等待当前本地画面完成安全核验；通过后才会显示指引。' };
            publish();
            await Promise.race([captureJob, cancellation]);
          }
          const fresh = readyToInstall();
          traceGuidance('install_freshness', {
            fresh,
            ageMs: latestFrame ? now() - latestFrame.capturedAt : null,
            admitted: Boolean(latestFrame && isAdmittedFrame(latestFrame, now(), maxAgeMs)),
            sameScope: Boolean(latestFrame && sameFrameScope(latestFrame, job.frame)),
            gateOpen, cloudConsent,
            displayId: latestFrame?.displayId ?? null,
            width: latestFrame?.width ?? null,
            height: latestFrame?.height ?? null,
            jobWidth: job.frame?.width ?? null,
            jobHeight: job.frame?.height ?? null,
          });
          return fresh;
        };
        try {
          const result = await Promise.race([options.analyzer.analyze({
            frame: job.frame, frameMaxAgeMs: analysisSendMaxAgeMs,
            // Downscaling can take ~0.7s; run it only after the analyzer's own gate has accepted the
            // freshly admitted frame so the gate is not raced by payload preparation.
            prepareImage: () => analysisImageFor(job.frame),
            question: job.question, clarificationReplies: job.clarificationReplies, reason: job.reason,
            observationId: job.observationId, guideId: job.guideId, observationGeneration: job.observation,
            taskGeneration: job.task, triggerId: job.triggerId,
            previousStep: job.previous ? { instruction: job.previous.instruction, expectedLabels: [...job.previous.expectedLabels] } : null,
            signal: controller.signal, canSend, confirmCurrentFrame,
            canInstallCurrent: () => installableOnLatest(job),
          }).then(async result => {
            if (!await confirmCurrentFrame()) throw Object.assign(new Error('OUTBOUND_CLOSED'), { code: 'OUTBOUND_CLOSED' });
            return result;
          }), cancellation]);
          if (sequence === analysisSequence && sameGeneration(job.observation, job.task) && !controller.signal.aborted) {
            traceGuidance('analysis_reply', { kind: result?.kind, installable: installableOnLatest(job) });
            const installed = await installAnalysis(result, job);
            if (installed && state.task.state === 'awaiting_action') state.analysis = { state: 'ready', message: state.task.targetState === 'visible'
              ? '请核对箭头与当前一步说明，再亲手操作。' : '本次分析已返回，但未显示箭头；请查看这一步的说明，不要按旧位置操作。' };
            publish();
          }
        } catch (error) {
          traceGuidance('analysis_error', { code: error?.code ?? error?.message ?? 'unknown', name: error?.name, providerCode: error?.providerCode,
            attempts: Number.isSafeInteger(error?.attempts) ? error.attempts : undefined, timedOut });
          if (sequence === analysisSequence && sameGeneration(job.observation, job.task) && (!controller.signal.aborted || timedOut)) {
            clearTarget();
            state.task.state = 'needs_help';
            state.analysis = { state: 'error', message: analysisFailureMessage(error, timedOut) };
            message(state.analysis.message, 'assistant');
            publish();
          }
        } finally {
          clearTimeout(timeout);
          controller.signal.removeEventListener('abort', rejectCancellation);
          analysisFrame = null;
          release(job.frame);
        }
      }
    })().finally(() => { analysisJob = null; analysisController = null; });
  }

  async function captureOne(reason) {
    const generation = observationGeneration;
    const task = taskGeneration;
    let staleFrameRetries = 0;
    let gateRetries = 0;
    let analysisBeforeRetry = null;
    while (sameGeneration(generation)) {
      const controller = new AbortController();
      captureController = controller;
      let frame;
      let detection;
      try {
        const captureStartedAt = now();
        frame = await options.source.capture({ sourceId, signal: controller.signal, ...(observationRegion ? { region: { ...observationRegion } } : {}) });
        const captureMs = now() - captureStartedAt;
        if (!sameGeneration(generation)) return;
        const detectStartedAt = now();
        detection = await options.source.detect(frame, { signal: controller.signal });
        const detectMs = now() - detectStartedAt;
        if (!sameGeneration(generation)) return;
        const admitted = evaluateLocalFrame(frame, detection, { now: now(), maxAgeMs, authorizedSharing: true, unredactedUpload: isUnredactedUpload() });
        traceGuidance('capture_cycle', { captureMs, detectMs, ageMs: now() - (frame?.capturedAt ?? now()), elements: admitted?.elements?.length ?? 0, decision: admitted?.decision });
        if (admitted.decision !== 'allow') {
          if (admitted.reason === 'stale_frame' && detection?.status === 'complete') {
            if (!sameGeneration(generation, task)) return;
            if (staleFrameRetries < staleFrameRetryLimit) {
              staleFrameRetries += 1;
              if (state.analysis.state !== 'capture_retry') analysisBeforeRetry = state.analysis;
              noteStaleFrameRetry(staleFrameRetries);
              continue;
            }
            failStaleFrameRefresh();
            return;
          }
          // Owner request for the auto-step feature: a sensitive or unclassified screen must not stop
          // sharing with an error. Only auto-step softens this; the manual guidance flow keeps the
          // original fail-closed policy. Classification problems are retried locally, then the frame
          // is skipped without uploading anything and without pausing; hard integrity failures still
          // stop the session, because no sanitized frame exists to send.
          const autoStep = state.task.autoStep === true;
          const classification = ['unclassified_screen', 'no_readable_text', 'sensitive_screen'].includes(admitted.reason);
          const recoverable = autoStep && (classification || ['local_detector_unavailable', 'incomplete_local_detection', 'detector_frame_mismatch',
            'invalid_local_regions', 'unredacted_frame'].includes(admitted.reason));
          if (recoverable && gateRetries < staleFrameRetryLimit) {
            gateRetries += 1;
            state.analysis = { state: 'capture_retry', message: classification
              ? '本机遮盖后暂未得到可用控件，正在本机重试；这一帧没有上传，共享也没有暂停。'
              : '本机检测或遮盖暂未通过，正在本机重试；没有上传任何画面。' };
            publish();
            continue;
          }
          if (autoStep && classification) {
            clearTarget('gate_skipped_frame');
            state.analysis = { state: 'ready', message: '本机在本机遮盖后仍未得到可用控件，已跳过这一帧且未上传；请保持目标可见，或点“再讲一遍”。' };
            publish();
            return;
          }
          await closeObservation(admitted.reason, true);
          return;
        }
        const old = latestFrame;
        if (old && admitted.capturedAt <= old.capturedAt) {
          release(admitted);
          if (staleFrameRetries > 0 && sameGeneration(generation, task)) { failStaleFrameRefresh(); return; }
          if (reason === 'verification' && sameGeneration(generation, task) && previousStep) {
            state.task.state = 'awaiting_action';
            state.analysis = { state: 'ready', message: '本次未取得比上次更新的本地安全画面，不能确认操作完成，请重新核验。' };
            publish();
          }
          return;
        }
        const recoveredStaleFrame = staleFrameRetries > 0;
        const scopeChanged = Boolean(old && !sameFrameScope(old, admitted));
        const changed = Boolean(old && !sameFrameContext(old, admitted));
        const progressed = Boolean(previousStep && verifiedTransition(previousStep, admitted));
        const retainedTarget = ((reason === 'page_changed' && state.task.state === 'awaiting_action')
          || (reason === 'verification' && state.task.state === 'verifying'))
          && previousStep && !progressed
          ? (currentShellElement(previousStep, admitted)
            ?? (reason === 'page_changed' ? relocatedElement(previousStep.element, previousStep.frame, admitted) : null))
          : null;
        latestFrame = admitted;
        gateOpen = true;
        gateRetries = 0;
        const sharingUpdated = state.observation.reason !== 'authorized_sharing';
        state.observation.reason = 'authorized_sharing';
        // A frame that changed its capture scope, contains restricted text, or no longer offers any
        // recognizable control cannot verify an in-flight answer. Benign text drift does not.
        if (!retainedTarget && (scopeChanged || admitted.elements.length === 0)) {
          clearTarget();
          invalidateAnalysis();
        }
        release(old);
        if (!sameGeneration(generation, task)) return;
        if (state.analysis.state === 'capture_retry' && analysisBeforeRetry) state.analysis = analysisBeforeRetry;
        if (sharingUpdated) publish();
        if (retainedTarget) {
          if (reason === 'verification' && state.task.autoStep) {
            // Auto-step: the owner pressed “我点好了，请核验”, so always analyse the fresh masked
            // frame instead of assuming nothing changed.
            targetMisses = 0;
            state.task.state = 'verifying';
            queueAnalysis(admitted, 'verification');
            return;
          }
          const targetState = state.task.targetState;
          state.task.state = 'awaiting_action';
          targetMisses = 0;
          showStepTarget(admitted, retainedTarget);
          if (changed || reason === 'verification' || recoveredStaleFrame || targetState !== state.task.targetState) {
            state.analysis = { state: 'ready', message: reason === 'verification'
              ? '已检查新画面，尚未观察到预期变化；不会因为点击“我点好了”就进入下一步。'
              : '新的本地安全画面已核对；请核对箭头并亲手操作。' };
            publish();
          }
          return;
        }
        if (reason === 'verification' && previousStep
          && (previousStep.signature === admitted.signature || admitted.capturedAt <= previousStep.issuedAt)) {
          if (state.task.autoStep) {
            state.task.state = 'verifying';
            queueAnalysis(admitted, 'verification');
            return;
          }
          state.task.state = 'awaiting_action';
          state.analysis = { state: 'ready', message: '已检查新画面，尚未观察到预期变化；不会因为点击“我点好了”就进入下一步。' };
          const element = currentElement(previousStep.element, previousStep.frame, admitted);
          if (element) showStepTarget(admitted, element);
          publish();
        } else if (reason === 'page_changed' && previousStep && state.task.state === 'awaiting_action') {
          if (state.task.autoStep) {
            // The arrow hides as soon as the target is gone or the expected post-action controls
            // appeared; the next analysis only starts after the owner presses the verify button.
            targetMisses = 0;
            clearTarget(progressed ? 'auto_step_progressed' : 'auto_step_target_gone');
            state.task.state = 'awaiting_verify';
            state.task.targetState = 'hidden';
            state.analysis = { state: 'ready', message: progressed
              ? '看起来这一步已经完成，箭头已隐藏。请点“我点好了，请核验”继续下一步。'
              : '目标已不在原位，箭头已隐藏。若这一步已完成，请点“我点好了，请核验”；也可以点“再讲一遍”。' };
            publish();
            return;
          }
          if (progressed) {
            // The expected post-action controls appeared: ask the model to confirm and continue.
            targetMisses = 0;
            queueAnalysis(admitted, reason);
            return;
          }
          targetMisses += 1;
          traceGuidance('target_miss', { count: targetMisses, elements: admitted.elements.length, scopeChanged });
          // Real OCR occasionally drops a label for a single polling frame. Keep the last verified
          // arrow for one interval, then hide it if the next safety frame still cannot see the target.
          if (targetMisses >= 2) {
            clearTarget('relocate_miss');
            if (state.task.targetState !== 'stale' || state.analysis.state !== 'ready') {
              state.task.targetState = 'stale';
              state.analysis = { state: 'ready', message: '新画面里暂时找不到刚才的位置；箭头已隐藏。目标被遮挡或正在滚动时可稍后再试，也可以亲手操作后点“我点好了”。' };
              publish();
            }
          }
        } else if (reason !== 'page_changed' || changed) queueAnalysis(admitted, reason);
        else if (recoveredStaleFrame) publish();
        return;
      } catch (error) {
        if (sameGeneration(generation) && !controller.signal.aborted) await closeObservation(captureFailureReason(error?.code), true);
        return;
      } finally {
        frame?.png?.fill(0);
        detection?.sanitizedPng?.fill(0);
        if (captureController === controller) captureController = null;
      }
    }
  }

  function requestFrame(reason) {
    if (disposed || state.observation.state !== 'observing') return;
    const priority = { page_changed: 0, question: 1, verification: 2 };
    if (!pendingReason || priority[reason] >= priority[pendingReason]) pendingReason = reason;
    clearTimeout(timer);
    timer = null;
    if (captureJob) return;
    captureJob = (async () => {
      while (pendingReason && state.observation.state === 'observing') {
        const nextReason = pendingReason;
        pendingReason = null;
        await captureOne(nextReason);
      }
    })().finally(() => { captureJob = null; scheduleCapture(); });
  }

  async function startObservation(input) {
    if (disposed || input?.actor !== 'owner' || input?.confirmed !== true || typeof input.sourceId !== 'string' || !input.sourceId) throw new Error('必须由本人选择范围并明确开启观察');
    if (cleanupJob) await cleanupJob;
    if (state.observation.state === 'cleanup_failed') throw new Error('采集清理尚未确认，不能重新开启');
    if (state.observation.state === 'privacy_paused' && input.resume !== true) throw new Error('隐私暂停仅允许本人点击继续共享后恢复');
    if (state.observation.state === 'observing') await closeObservation('source_changed');
    invalidateQuestion();
    if (state.task.kind === 'text' && state.task.state !== 'ended') {
      state.task.state = 'ended';
      state.task.result = 'cancelled';
      state.task.explanation = '观察范围已改变，本次文字提问已停止；需要讲解时请重新提问。';
    }
    observationGeneration += 1;
    sourceId = input.sourceId;
    observationRegion = input.region ? { ...input.region } : null;
    cloudConsent = input.cloudConsent === true;
    gateOpen = false;
    state.observation = { state: 'observing', id: randomUUID(), generation: observationGeneration, sourceName: input.sourceName ?? '', reason: null, captureActive: true, cloudConsent, unredactedUpload: isUnredactedUpload() };
    if (state.task.id && !['completed', 'ended'].includes(state.task.state)) state.task.observationGeneration = observationGeneration;
    state.analysis = { state: 'idle', message: cloudConsent ? '本地观察已开启；没有有效任务触发时不会持续上传。' : '仅本地观察，不向云端发送画面。' };
    message('观察范围由本人开启；随时可以停止。');
    publish();
    requestFrame(state.task.id && !['completed', 'ended'].includes(state.task.state) ? 'question' : 'page_changed');
    return snapshot();
  }

  async function authorizeCloudAnalysis(input) {
    const current = () => !disposed && !cleanupJob && input?.actor === 'owner' && input.confirmed === true
      && Number.isSafeInteger(input.observationGeneration) && input.observationGeneration > 0 && input.observationGeneration === observationGeneration
      && state.observation.state === 'observing' && state.observation.captureActive === true;
    if (!current()) throw new Error('当前屏幕观察已变化或未获本人确认，本次画面分析授权未生效。');
    if (cloudConsent) return snapshot();
    invalidateQuestion();
    const question = questionSequence;
    if (state.task.id && !['completed', 'ended'].includes(state.task.state)) await finishTeaching('interrupted');
    if (!current() || question !== questionSequence) throw new Error('确认期间屏幕观察或问题已变化，请重新确认当前范围；没有开启画面分析。');
    cloudConsent = true;
    state.observation.cloudConsent = true;
    state.analysis = { state: 'idle', message: '已单独同意当前观察范围的按需脱敏分析；提问前不会发送画面，也不会重发旧问题。' };
    publish();
    return snapshot();
  }

  function requireGuidanceObservation(generation) {
    if (!Number.isSafeInteger(generation) || generation < 1 || generation !== observationGeneration
      || state.observation.state !== 'observing' || state.observation.captureActive !== true || !cloudConsent) {
      throw new Error('屏幕观察或本次画面授权已失效，请重新选择范围并同意按需脱敏分析；问题未发送。');
    }
  }

  async function ask(text, requiredObservation, askOptions = {}) {
    if (disposed || typeof text !== 'string' || !text.trim() || text.length > 500) throw new Error('请输入不超过500字的问题');
    if (cleanupJob || !['off', 'stopped', 'observing'].includes(state.observation.state)) throw new Error('请先处理本地观察的安全或停止状态，再重新提问');
    if (requiredObservation !== undefined) requireGuidanceObservation(requiredObservation);
    const autoStep = askOptions?.autoStep === true;
    invalidateQuestion();
    const question = questionSequence;
    if (state.task.id && !['completed', 'ended'].includes(state.task.state)) await finishTeaching('interrupted');
    if (question !== questionSequence || disposed) return snapshot();
    if (requiredObservation !== undefined) requireGuidanceObservation(requiredObservation);
    taskGeneration += 1;
    clarificationReplies = [];
    const textOnly = !autoStep && typeof options.questioner?.answer === 'function' && (state.observation.state !== 'observing' || !cloudConsent);
    state.task = { id: randomUUID(), kind: textOnly ? 'text' : 'guidance', state: 'needs_help', observationGeneration, question: safeSummary(text.trim()), instruction: '', explanation: '', presentation: null, targetState: 'hidden', result: null, autoStep, stepIndex: 0, startedAt: now() };
    message(safeSummary(text.trim()), 'user');
    if (isRestrictedText(text)) {
      clearTarget();
      state.task.state = 'ended';
      state.task.result = 'risk_blocked';
      state.task.explanation = '涉及支付、转账、验证码或私人信息时，微光指引不继续指导该操作。请退出风险页面，必要时与家人电话确认。';
      state.captions.text = state.task.explanation;
      message(state.task.explanation, 'assistant');
      await recordTeaching('risk_blocked');
    } else if (textOnly) await answerTextQuestion(text.trim(), state.task.id, taskGeneration);
    else if (state.observation.state !== 'observing') message('真实文字模型接口暂不可用；不会使用固定回答。若要进行外部软件教学，请先配置模型并由本人开启本地观察。');
    else {
      state.task.state = 'analyzing';
      state.analysis = { state: 'analyzing', message: '查找请求已受理，正在本地检查本次授权画面；可结束教学或停止观察取消。' };
      requestFrame('question');
    }
    publish();
    return snapshot();
  }

  // Auto-step: start the guidance loop without a typed question. The owner already shared the
  // screen and granted cloud analysis, so the first masked frame goes out immediately.
  async function startAutoStep(goalText) {
    const goal = typeof goalText === 'string' && goalText.trim() ? goalText.trim().slice(0, 500) : '帮助我完成当前屏幕上要做的下一步';
    return ask(goal, observationGeneration, { autoStep: true });
  }

  async function replyToClarification(input) {
    if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 500) throw new Error('请输入不超过500字的补充回答');
    return continueClarification(input, input.text.trim());
  }

  async function continueClarification(input, answer) {
    if (!input) throw new Error('追问已失效，请核对当前问题');
    requireGuidanceObservation(input.observationGeneration);
    if (disposed || cleanupJob || state.task.id !== input.guideId || taskGeneration !== input.taskGeneration
      || state.task.observationGeneration !== observationGeneration || state.task.kind !== 'guidance'
      || state.task.state !== 'needs_help' || state.task.awaitingReply !== true || state.analysis.state !== 'ready') throw new Error('这条追问已变化或结束，请核对当前问题后再回答；补充内容未发送。');
    if (answer && isRestrictedText(answer)) return ask(answer, input.observationGeneration);
    const prompt = state.task.explanation;
    invalidateQuestion();
    invalidateAnalysis();
    clearTarget();
    previousStep = null;
    taskGeneration += 1;
    if (answer) clarificationReplies = [...clarificationReplies, { prompt, answer: safeSummary(answer) }].slice(-3);
    state.task.awaitingReply = false;
    state.task.state = 'analyzing';
    state.task.explanation = '';
    state.analysis = { state: 'analyzing', message: answer ? '已收到补充回答，保留原来的目标，正在重新检查当前授权画面。' : '保留原来的目标与补充回答，正在重新识别当前授权画面。' };
    if (answer) message(safeSummary(answer), 'user');
    requestFrame('question');
    publish();
    return snapshot();
  }

  async function verify() {
    if (state.observation.state !== 'observing' || !state.task.id || !previousStep
      || ['completed', 'ended', 'finishing'].includes(state.task.state)) throw new Error('当前没有可核验的教学步骤');
    clearTarget();
    state.task.state = 'verifying';
    state.analysis = { state: 'analyzing', message: '正在重新观察当前画面，不会把按钮点击当成成功。' };
    publish();
    requestFrame('verification');
    return snapshot();
  }

  function repeat() {
    if (!state.task.instruction) throw new Error('当前没有可重讲的步骤');
    state.captions.text = state.task.instruction;
    message(state.task.instruction, 'assistant');
    publish();
    return snapshot();
  }

  function toggleCaptions() {
    state.captions.enabled = !state.captions.enabled;
    publish();
    return snapshot();
  }

  async function dispose(reason = 'process-terminated') {
    const result = await closeObservation(reason);
    disposed = true;
    state.messages.length = 0;
    return result;
  }

  async function whenIdle() {
    while (captureJob || analysisJob || questionJob) {
      if (captureJob) await captureJob;
      if (analysisJob) await analysisJob;
      if (questionJob) await questionJob;
    }
  }

  return { snapshot, startObservation, stopObservation: reason => closeObservation(reason ?? 'user'),
    resumeObservation: input => startObservation({ ...input, resume: true }), authorizeCloudAnalysis, ask, startAutoStep, replyToClarification,
    rescanClarification: input => continueClarification(input), verify, finishTeaching: result => { invalidateQuestion(); return finishTeaching(result); }, repeat,
    toggleCaptions, dispose, whenIdle };
}

module.exports = { createDesktopRuntime };
