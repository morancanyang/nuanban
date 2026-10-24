const fs = require('node:fs');
const path = require('node:path');

// “智能打开软件”的最近记录。只保存时间、appId、target 与执行结果，
// 绝不保存问题原文、路径、屏幕内容、聊天内容、密码或令牌。
function createAppLauncherHistory({ filePath, fsModule = fs, max = 20, now = Date.now } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new TypeError('打开记录文件路径无效');
  if (!Number.isSafeInteger(max) || max < 1 || max > 100) throw new TypeError('打开记录上限无效');

  function valid(entry) {
    return Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length <= 5
      && Number.isFinite(entry.at) && entry.at > 0
      && typeof entry.appId === 'string' && entry.appId.length >= 1 && entry.appId.length <= 40
      && typeof entry.target === 'string' && entry.target.length >= 1 && entry.target.length <= 40
      && typeof entry.success === 'boolean'
      && (entry.errorCode === null || (typeof entry.errorCode === 'string' && entry.errorCode.length <= 40));
  }

  function load() {
    try {
      const details = fsModule.lstatSync(filePath);
      if (!details.isFile() || details.size < 1 || details.size > 64 * 1024) return [];
      const parsed = JSON.parse(fsModule.readFileSync(filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter(valid).slice(0, max) : [];
    } catch { return []; }
  }

  let entries = load();

  function list() {
    return entries.map(entry => ({ ...entry }));
  }

  function record({ appId, target, success, errorCode = null } = {}) {
    if (typeof appId !== 'string' || !appId || appId.length > 40 || typeof target !== 'string' || !target || target.length > 40) {
      throw new TypeError('打开记录内容无效');
    }
    const entry = Object.freeze({ at: now(), appId, target, success: success === true,
      errorCode: success === true ? null : (typeof errorCode === 'string' && errorCode ? errorCode : 'LAUNCH_FAILED') });
    entries = [entry, ...entries].slice(0, max);
    try {
      fsModule.mkdirSync(path.dirname(filePath), { recursive: true });
      fsModule.writeFileSync(filePath, JSON.stringify(entries), { mode: 0o600 });
    } catch { /* 记录失败不影响打开流程，也不回退写入其他位置 */ }
    return { ...entry };
  }

  return Object.freeze({ list, record });
}

module.exports = { createAppLauncherHistory };