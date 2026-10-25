const { buildControlList, uiaCandidates } = require('./uia-inventory.cjs');
const { normalizedShellLabel } = require('./windows-shell-controls.cjs');

// 无截屏指引：模型只做"读控件名 → 选第 N 号"的选择题，坐标永远由本机 UIA 给出。
// 本模块只处理文本：不 require 任何抓屏或图像模块，也不读取像素。
const GUIDANCE_MODES = Object.freeze({ screenshotFree: 'screenshot-free', singleFrame: 'single-frame', continuous: 'continuous' });
const DEFAULT_GUIDANCE_MODE = GUIDANCE_MODES.screenshotFree;
const MODE_LABELS = Object.freeze({
  'screenshot-free': '无截屏（默认）', 'single-frame': '单帧截屏（需本人当次允许）', continuous: '持续观察（需本人开启）',
});

// 每个原因都有稳定的机器码 + 中文说明；界面直接显示这两项，不显示控件名或坐标。
const GUIDANCE_REASONS = Object.freeze({
  ok: { code: 'ok', severity: 'info', suggestSingleFrame: false, message: '本机已读出前台窗口的控件清单；模型只选序号，箭头位置由本机 UIA 给出。' },
  foreground_is_self: { code: 'foreground_is_self', severity: 'blocked', suggestSingleFrame: false, message: '当前前台窗口是微光指引自己。请先点一下你要操作的软件窗口，再回来提问。' },
  // 目标窗口 = 最近一次出现在前台的第三方窗口（不是提问瞬间的前台窗口，因为那时前台必然是本应用自己）。
  target_window_missing: { code: 'target_window_missing', severity: 'blocked', suggestSingleFrame: false, message: '还没记录到你要操作的窗口。请先点一下那个软件窗口，再回来提问；本机会记住最近点过的窗口。' },
  target_window_gone: { code: 'target_window_gone', severity: 'blocked', suggestSingleFrame: false, message: '上次操作的窗口已关闭，请重新点一下目标软件再提问。' },
  no_uia_controls: { code: 'no_uia_controls', severity: 'blocked', suggestSingleFrame: true, message: '这个软件没有可读的控件树（自绘界面常见）。无截屏模式无法定位控件：这次需要你允许截一帧，或先在软件里打开有标准控件的界面。' },
  names_unreadable: { code: 'names_unreadable', severity: 'blocked', suggestSingleFrame: true, message: '读到的控件都没有可读名称，做不成"选择题"。这次需要你允许截一帧，或换一个界面再试。' },
  sensitive_name_redacted: { code: 'sensitive_name_redacted', severity: 'info', suggestSingleFrame: false, message: '个别控件名称可能含隐私，已在本机隐藏后再发送；模型看不到名称原文。' },
  list_truncated: { code: 'list_truncated', severity: 'info', suggestSingleFrame: false, message: '前台窗口控件较多，清单已按上限截断；目标不在清单里时，请先滚动到目标可见再试。' },
  inventory_unavailable: { code: 'inventory_unavailable', severity: 'blocked', suggestSingleFrame: false, message: '本机这次没能读出控件清单（系统 UI Automation 不可用或超时），没有发送任何内容。' },
  question_blocked: { code: 'question_blocked', severity: 'blocked', suggestSingleFrame: false, message: '问题为空、过长或涉及隐私词，未发送；请换一种说法。' },
  consent_required: { code: 'consent_required', severity: 'blocked', suggestSingleFrame: false, message: '无截屏指引只会把前台窗口的控件名称、类型与位置等文本发给已配置的模型，不发送任何画面。请先由本人确认这一次发送；没有同意时不会外发任何内容。' },
  provider_failed: { code: 'provider_failed', severity: 'blocked', suggestSingleFrame: false, message: '模型没有返回可用的选择结果（网络、服务或格式问题），没有画箭头。' },
  model_no_match: { code: 'model_no_match', severity: 'blocked', suggestSingleFrame: false, message: '模型在这份控件清单里没有找到匹配项。请换一种说法，或先打开目标功能所在的界面。' },
  invalid_choice: { code: 'invalid_choice', severity: 'blocked', suggestSingleFrame: false, message: '模型返回的内容不是合法选择（格式或序号无效），已丢弃且不会画箭头。' },
  choice_out_of_range: { code: 'choice_out_of_range', severity: 'blocked', suggestSingleFrame: false, message: '模型选的序号超出本机清单范围，已丢弃且不会画箭头。' },
  coordinates_rejected: { code: 'coordinates_rejected', severity: 'blocked', suggestSingleFrame: false, message: '模型返回了坐标而不是序号，按本机规则拒绝（坐标只能由本机 UIA 给出）。' },
  element_gone: { code: 'element_gone', severity: 'blocked', suggestSingleFrame: false, message: '模型选中的控件在画箭头前已消失、不可用或不在屏，已放弃，不会按旧位置指。' },
  coordinates_unverified: { code: 'coordinates_unverified', severity: 'blocked', suggestSingleFrame: false, message: '本机无法把该控件的物理像素证明为屏幕 DIP 坐标，按规则不画箭头；请重新选择观察屏或改用单帧方式。' },
  review_advanced: { code: 'review_advanced', severity: 'info', suggestSingleFrame: false, message: '复核：前台窗口或控件已经变化，按新读到的控件树给出下一步。' },
  review_unchanged: { code: 'review_unchanged', severity: 'info', suggestSingleFrame: false, message: '复核：控件树与上一步几乎一致，可能没有点到。请再试一次，或核对箭头是否落在目标控件上。' },
  review_unverifiable: { code: 'review_unverifiable', severity: 'info', suggestSingleFrame: true, message: '复核：本机这次无法判断（控件树读不到或变化无法区分），不猜结果。' },
});

function reasonInfo(code) {
  return Object.hasOwn(GUIDANCE_REASONS, code) ? GUIDANCE_REASONS[code]
    : { code: typeof code === 'string' && code ? code : 'unknown', severity: 'blocked', suggestSingleFrame: false, message: '这次没有给出箭头；原因未在已知清单内，按失败关闭处理。' };
}

function modeInfo(mode) {
  const selected = Object.hasOwn(MODE_LABELS, mode) ? mode : DEFAULT_GUIDANCE_MODE;
  return Object.freeze({ mode: selected, label: MODE_LABELS[selected], screenshotFree: selected === GUIDANCE_MODES.screenshotFree });
}

const CHOICE_FIELDS = new Set(['kind', 'control', 'instruction', 'reason']);
const COORDINATE_FIELDS = ['x', 'y', 'rect', 'rectangle', 'coordinates', 'coord', 'left', 'top', 'width', 'height', 'position'];

function parsedChoiceObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  if (!text || text.length > 8000) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

// 严格解析模型回答：只接受"第 N 号控件"或"没找到 + 原因"；出现坐标字段一律拒绝。
function parseControlChoice(value, count) {
  const parsed = parsedChoiceObject(value);
  if (!parsed) return { kind: 'invalid', code: 'invalid_choice' };
  // 模型提供坐标一律拒绝（哪怕同时给了合法序号）：坐标只能由本机 UIA 给出。
  if (COORDINATE_FIELDS.some(field => Object.hasOwn(parsed, field))) return { kind: 'invalid', code: 'coordinates_rejected' };
  if (Object.keys(parsed).some(key => !CHOICE_FIELDS.has(key))) return { kind: 'invalid', code: 'invalid_choice' };
  if (!Number.isSafeInteger(count) || count < 0) return { kind: 'invalid', code: 'invalid_choice' };
  const kind = parsed.kind;
  if (kind === 'no_match') {
    const reason = parsed.reason;
    if (reason !== undefined && (typeof reason !== 'string' || !reason.trim() || reason.length > 200)) return { kind: 'invalid', code: 'invalid_choice' };
    return { kind: 'no_match', reason: typeof reason === 'string' ? reason.trim() : '' };
  }
  if (kind !== 'control' || !Number.isSafeInteger(parsed.control)) return { kind: 'invalid', code: 'invalid_choice' };
  if (count < 1 || parsed.control < 1 || parsed.control > count) return { kind: 'invalid', code: 'choice_out_of_range' };
  const instruction = parsed.instruction;
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 600) return { kind: 'invalid', code: 'invalid_choice' };
  return { kind: 'control', number: parsed.control, instruction: instruction.trim() };
}

function nameKey(control) {
  return control?.readName ?? (typeof control?.name === 'string' ? normalizedShellLabel(control.name) ?? control.name : '');
}

function sameTarget(control, target) {
  return Boolean(control && target) && nameKey(control) === target.nameKey && control.controlType === target.controlType;
}

function rectWithin(rect, target, tolerance) {
  return ['x', 'y', 'width', 'height'].every(field => Math.abs(rect[field] - target[field]) <= tolerance);
}

// 复核三态：只根据本机重新读到的控件树判断，不用截图、不猜。
function classifyReview({ previous, current, tolerance = 8 } = {}) {
  if (!previous?.target || !current || current.status !== 'complete' || !Array.isArray(current.controls) || current.controls.length === 0) {
    return Object.freeze({ verdict: 'unverifiable', code: 'review_unverifiable', detail: 'inventory_unavailable' });
  }
  if (previous.windowKey && current.windowKey && previous.windowKey !== current.windowKey) {
    return Object.freeze({ verdict: 'advanced', code: 'review_advanced', detail: 'window_changed' });
  }
  const candidates = uiaCandidates(current.controls);
  const match = candidates.find(candidate => sameTarget(candidate, previous.target));
  if (!match) return Object.freeze({ verdict: 'advanced', code: 'review_advanced', detail: 'target_gone' });
  if (!rectWithin(match.rect, previous.target.rect, tolerance)) {
    return Object.freeze({ verdict: 'advanced', code: 'review_advanced', detail: 'target_moved' });
  }
  const previousFocus = previous.focusedIndex ?? 0;
  const currentFocus = current.focusedIndex ?? 0;
  if (previousFocus !== currentFocus || (match.focus && !previous.target.focused)) {
    return Object.freeze({ verdict: 'advanced', code: 'review_advanced', detail: 'focus_changed' });
  }
  if (Math.abs(candidates.length - (previous.candidateCount ?? candidates.length)) >= 3) {
    return Object.freeze({ verdict: 'advanced', code: 'review_advanced', detail: 'controls_changed' });
  }
  return Object.freeze({ verdict: 'unchanged', code: 'review_unchanged', detail: 'no_change' });
}

function choicePrompt({ question, list, truncated }) {
  return '你正在帮助一位长辈操作 Windows 软件。下面是本机 UI Automation 读到的**前台窗口控件清单**（只有序号、名称、类型和矩形）。'
    + '请只回答"目标是第几号控件"，不要输出任何坐标：坐标由本机给出。'
    + (truncated ? '清单已按上限截断，若目标明显不在清单里就回答找不到。' : '')
    + '无法确定或清单里没有匹配项时，回答找不到并说明原因，不要猜。'
    + `\n\n用户想做的事：${question}\n\n控件清单：\n${list.lines.join('\n')}`
    + '\n\n只输出一个 JSON 对象，不要 Markdown、不要多余文字：'
    + '{"kind":"control","control":序号,"instruction":"只讲一步、提醒本人亲手操作"}；'
    + '找不到时输出 {"kind":"no_match","reason":"简短原因"}。不要输出 x/y/rect/坐标字段。';
}

function createUiaGuidanceSession({ inventory, chooser, isRestrictedText = () => false, hasConsent = () => true, now = Date.now, trace = () => {}, maxLines = 200,
  targetWindow } = {}) {
  if (!inventory || typeof inventory.read !== 'function') throw new TypeError('UIA 控件清单读取端口不完整');
  let generation = 0;
  let busy = false;
  let last = null;
  let lastVerdict = null;
  let lastQuestion = '';
  let lastHwnd = null;

  // 目标窗口：由宿主注入的低频跟踪器提供（最近的非自身前台窗口）。
  // 没有注入跟踪器时退化为旧的"读当前前台窗口"，只用于兼容调用方与旧测试；宿主始终注入。
  function currentTarget() {
    if (!targetWindow || typeof targetWindow.target !== 'function') return null;
    const value = targetWindow.target();
    if (!value || !Number.isSafeInteger(value.hwnd) || value.hwnd <= 0) return null;
    return Object.freeze({ hwnd: value.hwnd, title: typeof value.title === 'string' ? value.title : '', processName: typeof value.processName === 'string' ? value.processName : '',
      at: Number.isSafeInteger(value.at) ? value.at : 0 });
  }

  function targetSummary(target, { foreground = null } = {}) {
    if (!target) return null;
    return Object.freeze({ hwnd: target.hwnd, title: target.title, processName: target.processName, at: target.at,
      label: target.title || target.processName || '未知窗口',
      // 三态：true=此刻仍在前台；false=已不在前台（按最近记录继续指引并在界面说明）；null=这次没读到该信息。
      foreground: foreground === true ? true : foreground === false ? false : null });
  }

  function record(state) {
    last = Object.freeze(state);
    return last;
  }

  function blocked(code, extra = {}) {
    const info = reasonInfo(code);
    trace('uia_blocked', { code: info.code, ...extra });
    return record({ status: 'blocked', ...info, ...extra });
  }

  function snapshot() {
    const mode = modeInfo(DEFAULT_GUIDANCE_MODE);
    const info = last ? reasonInfo(last.code) : reasonInfo('ok');
    const consented = typeof hasConsent === 'function' ? hasConsent() === true : true;
    const tracked = currentTarget();
    const observed = last?.targetWindow && tracked && last.targetWindow.hwnd === tracked.hwnd ? last.targetWindow : null;
    return Object.freeze({
      mode: mode.mode, modeLabel: mode.label, screenshotFree: mode.screenshotFree,
      active: Boolean(last && last.status === 'ready'),
      reasonCode: last ? info.code : null, reasonMessage: last ? info.message : null,
      severity: last ? info.severity : 'info', suggestSingleFrame: Boolean(last && last.suggestSingleFrame),
      textConsent: consented,
      target: targetSummary(tracked, { foreground: observed ? observed.foreground : null }),
      counts: last?.counts ? { ...last.counts } : { count: 0, limit: 0, truncated: false },
      review: lastVerdict ? { verdict: lastVerdict.verdict, code: lastVerdict.code, detail: lastVerdict.detail } : null,
    });
  }

  async function readInventory({ signal } = {}, hwnd = null) {
    try {
      const result = hwnd === null ? await inventory.read({ signal }) : await inventory.read({ signal, hwnd });
      if (!result || typeof result !== 'object' || !['complete', 'unavailable'].includes(result.status)) return null;
      return result;
    } catch { return null; }
  }

  async function ask(question, { signal } = {}) {
    if (busy) return blocked('provider_failed', { detail: 'busy' });
    if (typeof question !== 'string' || !question.trim() || question.length > 500 || isRestrictedText(question)) {
      return blocked('question_blocked', { counts: { count: 0, limit: 0, truncated: false } });
    }
    // 先把"把控件文本发给模型"的本人同意确认清楚：没有同意时一个字都不外发（也不读清单，避免误导）。
    if (typeof hasConsent === 'function' && hasConsent() !== true) {
      return blocked('consent_required', { counts: { count: 0, limit: 0, truncated: false } });
    }
    const current = ++generation;
    busy = true;
    lastQuestion = question.trim();
    try {
      // 目标窗口必须是"最近一次操作的第三方窗口"：提问瞬间的前台必然是本应用自己（用户刚点过桌宠），
      // 所以先取跟踪器记录的目标，再只读它的控件清单；没有注入跟踪器时才退回读当前前台窗口。
      const target = currentTarget();
      if (targetWindow && typeof targetWindow.target === 'function' && !target) {
        return blocked('target_window_missing', { counts: { count: 0, limit: 0, truncated: false }, targetWindow: null });
      }
      const hwnd = target ? target.hwnd : null;
      lastHwnd = hwnd;
      const first = await readInventory({ signal }, hwnd);
      const stale = () => current !== generation;
      if (stale()) return blocked('provider_failed', { detail: 'superseded' });
      if (!first || first.status !== 'complete') {
        const gone = first?.reason === 'target_window_gone';
        const reason = gone ? 'target_window_gone'
          : first?.reason === 'foreground_is_self' ? 'foreground_is_self' : 'inventory_unavailable';
        return blocked(reason, { counts: { count: 0, limit: first?.counts?.limit ?? 0, truncated: false },
          targetWindow: targetSummary(target, { foreground: gone ? false : null }) });
      }
      const usable = first.controls.filter(control => control.enabled && !control.offscreen && control.rect !== null);
      const candidates = uiaCandidates(first.controls);
      const counts = { count: candidates.length, limit: first.counts.limit, truncated: first.truncated === true };
      trace('uia_inventory', { count: counts.count, limit: counts.limit, truncated: counts.truncated, usable: usable.length, reason: first.truncated ? 'list_truncated' : 'ok' });
      // 有可用控件但没有可读名称（自绘界面）与"根本没有可用控件"是两种不同的原因，分别如实告知。
      if (!usable.length) return blocked('no_uia_controls', { counts, targetWindow: targetSummary(target) });
      if (!counts.count) return blocked('names_unreadable', { counts, targetWindow: targetSummary(target) });
      const list = buildControlList(candidates, { isRestrictedText, maxLines });
      if (!list.readableNames) return blocked('names_unreadable', { counts, targetWindow: targetSummary(target) });
      trace('uia_choice_request', { count: list.count, truncated: counts.truncated, redactedNames: list.redactedNames, questionLength: question.trim().length });
      let reply;
      try {
        reply = await (typeof chooser === 'function' ? chooser({ question: question.trim(), list, count: list.count, truncated: counts.truncated, signal })
          : chooser.choose({ question: question.trim(), list, count: list.count, truncated: counts.truncated, signal }));
      } catch { return blocked('provider_failed', { counts }); }
      if (stale()) return blocked('provider_failed', { detail: 'superseded', counts });
      const text = typeof reply === 'string' ? reply : reply?.text;
      const parsed = parseControlChoice(text, list.count);
      if (parsed.kind === 'invalid') {
        trace('uia_choice_reply', { code: parsed.code, count: list.count });
        return blocked(parsed.code, { counts });
      }
      if (parsed.kind === 'no_match') {
        trace('uia_choice_reply', { code: 'model_no_match', count: list.count, reasonLength: parsed.reason.length });
        return blocked('model_no_match', { counts });
      }
      trace('uia_choice_reply', { code: 'ok', number: parsed.number, instructionLength: parsed.instruction.length, count: list.count });
      const chosen = list.byNumber.get(parsed.number);
      if (!chosen) return blocked('element_gone', { counts });
      // 画箭头前再次本地校验：控件仍存在、可用、在屏且矩形仍有效（fail closed）。
      const confirm = await readInventory({ signal }, hwnd);
      if (stale()) return blocked('provider_failed', { detail: 'superseded', counts });
      // 目标窗口在这中间被关掉：明确失败，不给箭头，也不改读别的窗口。
      if (confirm && confirm.status !== 'complete' && confirm.reason === 'target_window_gone') {
        trace('uia_target_rejected', { code: 'target_window_gone', number: parsed.number });
        return blocked('target_window_gone', { counts, targetWindow: targetSummary(target, { foreground: false }) });
      }
      const stillThere = confirm?.status === 'complete'
        ? uiaCandidates(confirm.controls).find(candidate => sameTarget(candidate, { nameKey: nameKey(chosen), controlType: chosen.controlType }))
        : null;
      if (!stillThere) {
        trace('uia_target_rejected', { code: 'element_gone', number: parsed.number });
        return blocked('element_gone', { counts, targetWindow: targetSummary(target) });
      }
      trace('uia_target', { number: parsed.number, controlType: chosen.controlType, depth: chosen.depth, moved: rectWithin(stillThere.rect, chosen.rect, 2) ? 'same' : 'moved' });
      const informational = list.redactedNames ? 'sensitive_name_redacted' : counts.truncated ? 'list_truncated' : 'ok';
      const info = reasonInfo(informational);
      return record({ status: 'ready', code: info.code, severity: info.severity, message: info.message, suggestSingleFrame: false,
        counts, targetWindow: targetSummary(target, { foreground: first.foreground === true ? true : first.foreground === false ? false : null }),
        target: Object.freeze({ number: parsed.number, name: chosen.name, nameKey: nameKey(chosen), controlType: chosen.controlType,
          label: chosen.label, rect: { ...stillThere.rect } }), instruction: parsed.instruction,
        previous: { windowKey: confirm.windowKey, focusedIndex: confirm.focusedIndex, candidateCount: uiaCandidates(confirm.controls).length,
          target: { nameKey: nameKey(chosen), controlType: chosen.controlType, rect: { ...stillThere.rect }, focused: stillThere.focus } },
        at: now() });
    } finally {
      busy = false;
    }
  }

  async function review({ signal } = {}) {
    const state = last;
    if (!state || state.status !== 'ready' || !state.previous) {
      return record({ status: 'unverifiable', ...reasonInfo('review_unverifiable'), detail: 'no_step', counts: { count: 0, limit: 0, truncated: false } });
    }
    const current = await readInventory({ signal }, lastHwnd);
    if (current && current.status !== 'complete' && current.reason === 'target_window_gone') {
      lastVerdict = Object.freeze({ verdict: 'unverifiable', code: 'target_window_gone', detail: 'target_window_gone' });
      trace('uia_review', { verdict: 'unverifiable', code: 'target_window_gone', detail: 'target_window_gone' });
      return record({ status: 'unverifiable', ...reasonInfo('target_window_gone'), detail: 'target_window_gone',
        counts: state.counts, targetWindow: null, target: state.target, instruction: state.instruction });
    }
    const verdict = classifyReview({ previous: state.previous, current });
    lastVerdict = verdict;
    trace('uia_review', { verdict: verdict.verdict, code: verdict.code, detail: verdict.detail });
    if (verdict.verdict !== 'advanced') {
      // 保留上一步，便于本人再点一次"核验"；不猜、不画箭头。
      return record({ status: verdict.verdict === 'unchanged' ? 'unchanged' : 'unverifiable', ...reasonInfo(verdict.code), detail: verdict.detail,
        counts: state.counts, verdict: Object.freeze({ ...verdict }), previous: state.previous, target: state.target,
        targetWindow: state.targetWindow ?? null, instruction: state.instruction });
    }
    // 已经前进：按新读到的控件树再问一次模型，拿到下一步（仍然只选序号，坐标本机给）。
    const next = lastQuestion ? await ask(lastQuestion, { signal }) : null;
    return Object.freeze({ status: 'advanced', ...reasonInfo('review_advanced'), detail: verdict.detail, counts: state.counts,
      verdict: Object.freeze({ ...verdict }), next });
  }

  async function stop() {
    generation += 1;
    last = null;
    lastVerdict = null;
    lastQuestion = '';
    lastHwnd = null;
    try { await inventory.stop?.(); } catch {}
  }

  return Object.freeze({ ask, review, snapshot, stop, mode: DEFAULT_GUIDANCE_MODE });
}

module.exports = { DEFAULT_GUIDANCE_MODE, GUIDANCE_MODES, GUIDANCE_REASONS, MODE_LABELS, choicePrompt, classifyReview,
  createUiaGuidanceSession, modeInfo, parseControlChoice, reasonInfo };