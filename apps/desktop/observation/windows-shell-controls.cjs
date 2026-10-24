const { ObservationError } = require('./observation-common.cjs');

// 候选不再限于写死的白名单：任何本机可读、清洗后仍像“一个可指引入口名称”的 shell 元素都可以成为候选。
// 这里与 windows-shell-controls.ps1 保持同一套清洗规则，并对 helper 回包再校验一次：
// 空名、纯空白、纯符号、含控制字符、异常超长或非字符串的名称仍然被拒绝，伪造回包不能塞进任意文本。
const SHELL_LABEL_MAX_LENGTH = 64;
// 超过硬上限的名称只可能来自伪造/损坏的回包，直接拒绝而不是截断后当候选。
const SHELL_LABEL_HARD_LIMIT = 256;

function normalizedShellLabel(value) {
  if (typeof value !== 'string' || value.length > SHELL_LABEL_HARD_LIMIT) return null;
  const cleaned = value.normalize('NFKC').replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim();
  // 归一化可能把个别兼容字符展开得更长，先按上限截断再判空与纯符号，保证候选名称始终有界。
  const bounded = cleaned.slice(0, SHELL_LABEL_MAX_LENGTH).trim();
  if (!bounded) return null;
  if (!/[\p{L}\p{N}]/u.test(bounded)) return null;
  return bounded;
}

function isPublicShellControlLabel(value) {
  return normalizedShellLabel(value) !== null;
}

// 策略层只接受已经清洗、长度有界的名称：检测器输出必须等于它自己的归一化结果。
function isBoundedShellControlLabel(value) {
  const normalized = normalizedShellLabel(value);
  return normalized !== null && normalized === value;
}

function checkedShellControls(controls, geometry) {
  if (controls === undefined) return [];
  if (!Array.isArray(controls) || controls.length > 128) throw new ObservationError('shell_controls_invalid');
  if (controls.length && !geometry) throw new ObservationError('shell_controls_unrequested');
  const seen = new Set();
  return controls.flatMap(control => {
    if (!control || !['taskbar', 'desktop'].includes(control.surface)) throw new ObservationError('shell_controls_invalid');
    const label = normalizedShellLabel(control.label);
    if (label === null) throw new ObservationError('shell_controls_invalid');
    const rect = control.rect;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
      || rect.width <= 0 || rect.height <= 0 || rect.x < geometry.pixelX || rect.y < geometry.pixelY
      || rect.x + rect.width > geometry.pixelX + geometry.pixelWidth
      || rect.y + rect.height > geometry.pixelY + geometry.pixelHeight) throw new ObservationError('shell_controls_out_of_bounds');
    const key = `${label}|${rect.x},${rect.y},${rect.width},${rect.height}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ label, surface: control.surface,
      rect: { x: rect.x - geometry.pixelX, y: rect.y - geometry.pixelY, width: rect.width, height: rect.height } }];
  });
}

module.exports = { checkedShellControls, isBoundedShellControlLabel, isPublicShellControlLabel, normalizedShellLabel, SHELL_LABEL_HARD_LIMIT, SHELL_LABEL_MAX_LENGTH };
