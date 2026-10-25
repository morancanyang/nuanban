const { spawn: nodeSpawn } = require('node:child_process');
const path = require('node:path');
const { externalScriptPath } = require('../external-script-path.cjs');

// "目标窗口"的同义定义：最近一次出现在前台、且**不属于本应用**的顶层窗口。
// 为什么需要它：用户必须先点桌宠才能提问，提问那一瞬间的前台必然是本应用自己；
// 所以无截屏指引不能读"提问瞬间的前台窗口"，只能读最近操作过的第三方窗口。
// 本模块只处理元数据（hwnd/进程名/标题）：不 require 任何抓屏/图像模块，也不读取像素或控件树。
const FOREGROUND_LIMITS = Object.freeze({
  intervalMs: 750, minIntervalMs: 250, maxIntervalMs: 5000,
  maxTitleLength: 160, maxProcessNameLength: 80, maxLineBytes: 4096,
});
const PROCESS_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// 单行 NDJSON 校验：形状不符一律丢弃（fail closed），绝不猜。
function parseForegroundLine(line) {
  if (typeof line !== 'string' || !line.trim() || Buffer.byteLength(line, 'utf8') > FOREGROUND_LIMITS.maxLineBytes) return null;
  let parsed;
  try { parsed = JSON.parse(line.trim()); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.protocol !== 1 || parsed.kind !== 'foreground') return null;
  const hwnd = parsed.hwnd;
  const processId = parsed.processId;
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0 || !Number.isSafeInteger(processId) || processId <= 0) return null;
  // 超长标题说明回包不是本机脚本产生的形状：整行丢弃（fail closed），不截断后"看起来正常"。
  if (parsed.title !== undefined && (typeof parsed.title !== 'string' || parsed.title.length > FOREGROUND_LIMITS.maxTitleLength * 2)) return null;
  if (parsed.processName !== undefined && typeof parsed.processName !== 'string') return null;
  const title = typeof parsed.title === 'string' ? parsed.title : '';
  const processName = typeof parsed.processName === 'string' && PROCESS_NAME_PATTERN.test(parsed.processName) ? parsed.processName : '';
  return Object.freeze({ hwnd, processId, title, processName, scriptIsSelf: parsed.isSelf === true });
}

// 跟踪器：持有一个低频 watcher 进程，记住最近的非自身前台窗口。
// 注入项（spawn / isSelfProcessId / now）便于用假前台窗口序列做单测。
function createForegroundTargetTracker({ spawn = nodeSpawn, platform = process.platform, intervalMs = FOREGROUND_LIMITS.intervalMs,
  isSelfProcessId = () => false, ownProcessIds = () => [], now = Date.now, onTarget = () => {}, onState = () => {}, trace = () => {} } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < FOREGROUND_LIMITS.minIntervalMs || intervalMs > FOREGROUND_LIMITS.maxIntervalMs) throw new TypeError('前台窗口跟踪间隔无效');
  let child = null;
  let target = null;
  let started = false;
  let unavailable = false;
  let stopped = false;
  let pending = '';

  function accept(entry) {
    if (!entry) return;
    const self = entry.scriptIsSelf === true || (typeof isSelfProcessId === 'function' && isSelfProcessId(entry.processId) === true);
    trace('foreground_seen', { self, titled: Boolean(entry.title), hasProcessName: Boolean(entry.processName) });
    if (self) return; // 自身窗口（桌宠/管理窗/球窗）永远不作为目标。
    if (target && target.hwnd === entry.hwnd && target.title === entry.title && target.processName === entry.processName) { target = Object.freeze({ ...target, at: now() }); return; }
    target = Object.freeze({ hwnd: entry.hwnd, title: entry.title, processName: entry.processName, at: now() });
    trace('foreground_target', { titled: Boolean(entry.title), hasProcessName: Boolean(entry.processName) });
    try { onTarget(target); } catch {}
  }

  function ingest(chunk) {
    pending += chunk;
    if (pending.length > FOREGROUND_LIMITS.maxLineBytes) { pending = ''; return; }
    let index = pending.indexOf('\n');
    while (index >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      const entry = parseForegroundLine(line);
      if (entry) accept(entry);
      index = pending.indexOf('\n');
    }
  }

  function handleFailure() {
    unavailable = true;
    try { onState({ state: 'unavailable' }); } catch {}
  }

  function start() {
    if (started || stopped) return false;
    if (platform !== 'win32') { unavailable = true; return false; }
    const request = { protocol: 1, operation: 'watch-foreground', intervalMs, excludedProcessIds: ownIds() };
    let spawned;
    try {
      const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      spawned = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-File', externalScriptPath(path.join(__dirname, 'windows-foreground-watch.ps1'))], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { unavailable = true; return false; }
    child = spawned;
    started = true;
    unavailable = false;
    try { child.stdout?.setEncoding?.('utf8'); } catch {}
    child.stdout?.on('data', chunk => { if (!stopped) ingest(String(chunk)); });
    child.on?.('error', () => { if (!stopped) handleFailure(); });
    child.on?.('close', () => { if (!stopped && started) handleFailure(); });
    try { child.stdin?.on('error', () => {}); child.stdin?.end(JSON.stringify(request)); } catch {}
    return true;
  }

  function ownIds() {
    try {
      const ids = typeof ownProcessIds === 'function' ? ownProcessIds() : ownProcessIds;
      return Array.isArray(ids) ? ids.filter(value => Number.isSafeInteger(value) && value > 0).slice(0, 8) : [];
    } catch { return []; }
  }

  function stop() {
    stopped = true;
    started = false;
    pending = '';
    const running = child;
    child = null;
    try { running?.stdin?.destroy(); } catch {}
    try { running?.kill(); } catch {}
  }

  return Object.freeze({
    start,
    stop,
    // 撤回同意 / 会话结束：停止跟踪并忘掉目标窗口（不保留跨会话记录）。
    clear() { target = null; try { onTarget(null); } catch {} },
    target: () => target,
    snapshot: () => Object.freeze({ tracking: started && !unavailable, unavailable, target }),
  });
}

module.exports = { FOREGROUND_LIMITS, PROCESS_NAME_PATTERN, createForegroundTargetTracker, parseForegroundLine };