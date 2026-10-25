const { createHash } = require('node:crypto');
const { createWindowsHelperProcess } = require('./windows-helper-process.cjs');
const { ObservationError } = require('./observation-common.cjs');
const { normalizedShellLabel } = require('./windows-shell-controls.cjs');

// 无截屏指引：只读取**前台窗口**的 UIA 控件树（名称/类型/矩形/可用/在屏），不抓屏、不读像素。
// 这是"模型只做选择题、坐标由本机给出"的数据来源；所有外发文本都要先经过这里和 policy 的门控。
const UIA_LIMITS = Object.freeze({
  maxDepth: 8, maxDepthLimit: 10,
  maxControls: 400, maxControlsLimit: 512,
  maxLabelLength: 64, maxControlTypeLength: 64,
  maxRectsPerList: 512,
});
const CONTROL_TYPE_LABELS = Object.freeze({
  'ControlType.Button': '按钮', 'ControlType.Edit': '输入框', 'ControlType.Text': '文字', 'ControlType.ListItem': '列表项',
  'ControlType.MenuItem': '菜单项', 'ControlType.Menu': '菜单', 'ControlType.MenuBar': '菜单栏', 'ControlType.Tab': '标签页',
  'ControlType.TabItem': '标签页项', 'ControlType.CheckBox': '复选框', 'ControlType.RadioButton': '单选按钮',
  'ControlType.ComboBox': '下拉框', 'ControlType.Hyperlink': '超链接', 'ControlType.Image': '图片', 'ControlType.Window': '窗口',
  'ControlType.Pane': '窗格', 'ControlType.Group': '分组', 'ControlType.ToolBar': '工具栏', 'ControlType.ScrollBar': '滚动条',
  'ControlType.ProgressBar': '进度条', 'ControlType.Slider': '滑块', 'ControlType.DataItem': '数据项', 'ControlType.DataGrid': '数据表格',
  'ControlType.Header': '表头', 'ControlType.HeaderItem': '表头项', 'ControlType.Tree': '树', 'ControlType.TreeItem': '树项',
  'ControlType.Document': '文档', 'ControlType.StatusBar': '状态栏', 'ControlType.TitleBar': '标题栏', 'ControlType.Separator': '分隔符',
  'ControlType.ToolTip': '提示', 'ControlType.Thumb': '滑块柄', 'ControlType.Custom': '自定义控件', 'ControlType.Table': '表格',
  'ControlType.Calendar': '日历', 'ControlType.Spinner': '微调框', 'ControlType.Sound': '声音', 'ControlType.SplitButton': '拆分按钮',
});

function controlTypeLabel(programmaticName) {
  if (typeof programmaticName !== 'string' || !programmaticName) return '控件';
  if (Object.hasOwn(CONTROL_TYPE_LABELS, programmaticName)) return CONTROL_TYPE_LABELS[programmaticName];
  const short = programmaticName.replace(/^ControlType\./, '');
  return /^[A-Za-z]{1,32}$/.test(short) ? short : '控件';
}

function checkedLimits(overrides = {}) {
  const limits = { ...UIA_LIMITS };
  for (const [key, maximum] of [['maxDepth', UIA_LIMITS.maxDepthLimit], ['maxControls', UIA_LIMITS.maxControlsLimit]]) {
    const value = overrides[key] ?? limits[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ObservationError('invalid_uia_limits');
    limits[key] = value;
  }
  return Object.freeze(limits);
}

function checkedRect(raw) {
  const values = [raw?.x, raw?.y, raw?.width, raw?.height];
  if (!values.every(Number.isFinite)) return null;
  if (raw.width <= 0 || raw.height <= 0 || Math.abs(raw.x) > 10_000_000 || Math.abs(raw.y) > 10_000_000
    || raw.width > 100_000 || raw.height > 100_000) return null;
  return Object.freeze({ x: raw.x, y: raw.y, width: raw.width, height: raw.height });
}

// helper 回包校验：只接受形状严格的纯文本控件项；任何异常都当作读不到控件（fail closed），不猜测。
function checkedControlItems(reply, limits) {
  if (!Array.isArray(reply) || reply.length > limits.maxControls) throw new ObservationError('uia_controls_invalid');
  return reply.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ObservationError('uia_controls_invalid');
    if (!Number.isSafeInteger(item.index) || item.index < 1 || item.index > limits.maxControls) throw new ObservationError('uia_controls_invalid');
    if (typeof item.controlType !== 'string' || item.controlType.length > limits.maxControlTypeLength
      || !/^[A-Za-z.]{0,64}$/.test(item.controlType)) throw new ObservationError('uia_controls_invalid');
    const controlType = item.controlType;
    if (typeof item.enabled !== 'boolean' || typeof item.offscreen !== 'boolean' || typeof item.depth !== 'number'
      || !Number.isSafeInteger(item.depth) || item.depth < 1 || item.depth > limits.maxDepthLimit) throw new ObservationError('uia_controls_invalid');
    const rect = checkedRect(item);
    const name = typeof item.name === 'string' ? item.name : '';
    if (name.length > limits.maxLabelLength + 8) throw new ObservationError('uia_controls_invalid');
    return Object.freeze({ index: item.index, name, readName: normalizedShellLabel(name), controlType, label: controlTypeLabel(controlType),
      enabled: item.enabled, offscreen: item.offscreen, focus: item.focus === true, depth: item.depth, rect });
  });
}

function windowKey(window) {
  if (!window || !Number.isSafeInteger(window.processId) || typeof window.className !== 'string' || typeof window.title !== 'string') return null;
  return createHash('sha256').update(`${window.processId}|${window.className}|${window.title}`).digest('hex').slice(0, 16);
}

// 可指引候选：有名、可用、在屏、矩形有效且在当前工作区内。全部条件都是本机判定。
function uiaCandidates(controls) {
  return controls.filter(control => control.readName !== null && control.enabled && !control.offscreen && control.rect !== null)
    .map(control => Object.freeze({ ...control, number: 0 }))
    .map((control, position) => Object.freeze({ ...control, number: position + 1 }));
}

// 生成发给模型的**纯文本**清单；敏感名称在离开本机前就被替换，绝不外发原文。
function buildControlList(candidates, { isRestrictedText, maxLines = 200 } = {}) {
  const restricted = typeof isRestrictedText === 'function' ? isRestrictedText : () => false;
  const lines = [];
  const byNumber = new Map();
  let redactedNames = 0;
  let readableNames = 0;
  for (const candidate of candidates.slice(0, maxLines)) {
    const hidden = restricted(candidate.name);
    if (hidden) redactedNames += 1;
    else readableNames += 1;
    const display = hidden || candidate.readName === null ? '（名称已隐藏）' : candidate.name;
    const rect = candidate.rect;
    lines.push(`${candidate.number}. ${display} · ${candidate.label} · 矩形(${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)})`);
    byNumber.set(candidate.number, candidate);
  }
  return Object.freeze({ lines: Object.freeze(lines), byNumber, count: byNumber.size, redactedNames, readableNames,
    listTruncated: candidates.length > byNumber.size });
}

function createUiaInventoryReader({ spawn, timeoutMs = 5000, platform = process.platform, limits: limitOverrides, excludedProcessIds } = {}) {
  const limits = checkedLimits(limitOverrides);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 20_000) throw new ObservationError('invalid_uia_timeout');
  const helper = createWindowsHelperProcess({ spawn, timeoutMs, maxOutputBytes: 1024 * 1024, platform, script: 'windows-uia-inventory.ps1', maxInputBytes: 64 * 1024 });

  function failure(reason) {
    return Object.freeze({ status: 'unavailable', reason, windowKey: null, truncated: false, counts: Object.freeze({ total: 0, limit: limits.maxControls }), controls: Object.freeze([]) });
  }

  async function read({ signal } = {}) {
    const excluded = typeof excludedProcessIds === 'function' ? excludedProcessIds() : excludedProcessIds;
    let reply;
    try {
      reply = await helper.run({ protocol: 1, operation: 'inventory', maxDepth: limits.maxDepth, maxControls: limits.maxControls,
        timeBudgetMs: Math.min(3000, timeoutMs - 500), ...(Array.isArray(excluded) && excluded.length
          ? { excludedProcessIds: excluded.filter(value => Number.isSafeInteger(value) && value > 0).slice(0, 8) } : {}) }, { signal });
    } catch (error) {
      const code = error instanceof ObservationError ? error.code : 'uia_inventory_failed';
      return failure(['helper_timeout', 'aborted'].includes(code) ? code : 'uia_inventory_unavailable');
    }
    if (!reply || reply.protocol !== 1 || !['complete', 'unavailable', 'failed'].includes(reply.status)) return failure('uia_inventory_invalid');
    if (reply.status !== 'complete') {
      return failure(typeof reply.reason === 'string' && /^[a-zA-Z0-9_:.+-]{1,160}$/.test(reply.reason) ? reply.reason : 'uia_inventory_unavailable');
    }
    let controls;
    try {
      controls = checkedControlItems(reply.controls, limits);
    } catch {
      return failure('uia_controls_invalid');
    }
    const counts = Object.freeze({ total: controls.length, limit: limits.maxControls });
    return Object.freeze({ status: 'complete', windowKey: windowKey(reply.window), focusedIndex: Number.isSafeInteger(reply.focusedIndex) ? reply.focusedIndex : 0,
      truncated: reply.truncated === true || reply.depthLimited === true || reply.deadlineReached === true,
      counts, controls: Object.freeze(controls) });
  }

  return Object.freeze({ read, stop: () => helper.stop(), limits });
}

module.exports = { UIA_LIMITS, buildControlList, checkedControlItems, checkedLimits, controlTypeLabel, createUiaInventoryReader, uiaCandidates, windowKey };