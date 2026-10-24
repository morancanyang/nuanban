const fs = require('node:fs');
const path = require('node:path');
const { createAppLauncherRegistry, forbiddenSpawnText, pathIdentity } = require('./app-launcher-registry.cjs');

// 智能打开软件 · 启动器（core）。
// 只允许：注册表登记的固定 exe（绝对候选且存在）+ 固定参数数组，或 http/https 网址（shell.openExternal），
// 或 explorer.exe/Code.exe + 单个已校验目录。绝不接受 Shell 字符串、任意 exe、任意参数、任意 URL。

const HONEST_LAUNCH_NOTE = '仅确认已发送启动请求，无法确认软件内部页面已加载';
// 唯一的进程创建方式：无 Shell、脱离父进程、丢弃标准流、不显示窗口。
const SPAWN_OPTIONS = Object.freeze({ shell: false, detached: true, stdio: 'ignore', windowsHide: true });
const REQUEST_FIELDS = Object.freeze(['appId', 'target', 'displayName', 'kind', 'executable', 'args', 'url', 'folder']);
const LAUNCH_KINDS = Object.freeze(['exe', 'url', 'folder']);
const LAUNCH_ERROR_CODES = Object.freeze(['APP_UNKNOWN', 'TARGET_UNKNOWN', 'TARGET_UNSUPPORTED', 'PARAMETERS_INVALID',
  'PARAMETERS_FORBIDDEN', 'URL_PROTOCOL_BLOCKED', 'URL_INVALID', 'FOLDER_NOT_ALLOWED', 'FOLDER_MISSING',
  'EXECUTABLE_MISSING', 'LAUNCH_FAILED']);
const MAX_TEXT_LENGTH = 64;
const MAX_ARGUMENTS = 16;
const MAX_ARGUMENT_LENGTH = 1024;
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/u;

// core 只返回 errorCode；这里的 message 仅是兜底文案，界面统一提示由 app-launcher-bridge.cjs 映射。
const FAILURE_MESSAGES = Object.freeze({
  APP_UNKNOWN: '没有登记这个软件，已拒绝启动。',
  TARGET_UNKNOWN: '没有登记这个界面，已拒绝启动。',
  PARAMETERS_INVALID: '启动参数无效，已拒绝启动。',
  PARAMETERS_FORBIDDEN: '启动参数不在允许范围内，已拒绝启动。',
  URL_PROTOCOL_BLOCKED: '只能打开 http 或 https 网址，已拒绝。',
  URL_INVALID: '这个网址不在允许范围内，已拒绝。',
  FOLDER_NOT_ALLOWED: '这个文件夹不在允许范围内，已拒绝打开。',
  FOLDER_MISSING: '这个文件夹不存在或不可用，已拒绝打开。',
  EXECUTABLE_MISSING: '没有找到已登记且可用的程序，未发送启动请求。',
  LAUNCH_FAILED: '启动请求发送失败，请稍后手动打开。',
});

function successMessage(kind, displayName) {
  if (kind === 'url') return `已向系统浏览器发送打开该网址的请求。${HONEST_LAUNCH_NOTE}。`;
  if (kind === 'folder') return `已发送在「${displayName}」中打开这个文件夹的请求。${HONEST_LAUNCH_NOTE}。`;
  return `已发送打开「${displayName}」的请求。${HONEST_LAUNCH_NOTE}。`;
}

// 参数必须是字符串数组，且不含 ; / && / | / 换行 / 重定向。
function validateSpawnArguments(value) {
  if (value === undefined) return { ok: true, args: [] };
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS) return { ok: false, errorCode: 'PARAMETERS_INVALID' };
  const args = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item || item.length > MAX_ARGUMENT_LENGTH || item !== item.trim()) return { ok: false, errorCode: 'PARAMETERS_INVALID' };
    if (forbiddenSpawnText(item)) return { ok: false, errorCode: 'PARAMETERS_FORBIDDEN' };
    args.push(item);
  }
  return { ok: true, args };
}

function errorCodeFor(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  return code === 'ENOENT' ? 'EXECUTABLE_MISSING' : 'LAUNCH_FAILED';
}

function createAppLauncher({ spawn, shell, platform = 'win32', exists, stat, env = process.env, settleMs = 300, registry } = {}) {
  if (typeof spawn !== 'function') throw new TypeError('启动器缺少进程创建函数');
  if (typeof platform !== 'string' || !platform) throw new TypeError('运行平台无效');
  if (!Number.isSafeInteger(settleMs) || settleMs < 0 || settleMs > 10_000) throw new TypeError('启动确认时间无效');
  if (exists !== undefined && typeof exists !== 'function') throw new TypeError('文件存在性检查无效');
  if (registry !== undefined && (!registry || typeof registry !== 'object'
    || typeof registry.resolve !== 'function' || typeof registry.validateParameters !== 'function'
    || typeof registry.executableCandidates !== 'function')) throw new TypeError('应用注册表无效');
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const fileExists = value => { try { return (exists ?? fs.existsSync)(value) === true; } catch { return false; } };
  const store = registry ?? createAppLauncherRegistry({ platform, exists, stat, env });

  function executableIndex(appId) {
    const index = new Map();
    for (const candidate of store.executableCandidates(appId)) index.set(pathIdentity(candidate, platform), candidate);
    return index;
  }

  // 候选路径必须同时是注册表登记的固定候选且实际存在，调用方传入的其它路径一律忽略。
  function resolveExecutable(appId, candidates) {
    const index = executableIndex(appId);
    if (!index.size) return undefined;
    const requested = candidates === undefined ? [...index.values()] : (Array.isArray(candidates) ? candidates : []);
    for (const value of requested) {
      if (typeof value !== 'string') continue;
      const command = index.get(pathIdentity(value, platform));
      if (!command || !fileExists(command)) continue;
      return command;
    }
    return undefined;
  }

  function failure(appId, target, errorCode, resolvedType, message) {
    return { success: false, appId, target, errorCode, resolvedType,
      message: typeof message === 'string' && message ? message : FAILURE_MESSAGES[errorCode] ?? FAILURE_MESSAGES.LAUNCH_FAILED };
  }

  function success(appId, target, kind, displayName) {
    return { success: true, appId, target, errorCode: null, resolvedType: kind, message: successMessage(kind, displayName) };
  }

  // 只观察 error 事件与立即非零退出；不读取 PID，也不把退出码当作“软件界面已就绪”。
  function spawnDetached(command, args) {
    return new Promise(resolve => {
      let child;
      try { child = spawn(command, args, { ...SPAWN_OPTIONS }); }
      catch (error) { resolve({ ok: false, errorCode: errorCodeFor(error) }); return; }
      if (!child || (typeof child.once !== 'function' && typeof child.on !== 'function')) { resolve({ ok: false, errorCode: 'LAUNCH_FAILED' }); return; }
      let settled = false;
      let timer = null;
      const onError = error => finish({ ok: false, errorCode: errorCodeFor(error) });
      const onExit = code => { if (typeof code === 'number' && code !== 0) finish({ ok: false, errorCode: 'LAUNCH_FAILED' }); };
      const detach = () => {
        if (typeof child.removeListener === 'function') {
          child.removeListener('error', onError);
          child.removeListener('exit', onExit);
        }
        // 结算后仍保留空监听：迟到的 error 不再影响结果，也不会变成未处理异常。
        if (typeof child.on === 'function') child.on('error', () => {});
      };
      const finish = outcome => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        detach();
        resolve(outcome);
      };
      child.once('error', onError);
      child.once('exit', onExit);
      if (typeof child.unref === 'function') child.unref();
      timer = setTimeout(() => finish({ ok: true }), settleMs);
    });
  }

  async function launchExecutable({ appId, target, resolved, executable, args, url, folder }) {
    if (url !== undefined || folder !== undefined) return failure(appId, target, 'PARAMETERS_FORBIDDEN', 'exe');
    const parsed = validateSpawnArguments(args);
    if (!parsed.ok) return failure(appId, target, parsed.errorCode, 'exe');
    // 注册表未声明任何需要参数的 exe 启动：固定参数一律为空数组。
    if (parsed.args.length) return failure(appId, target, 'PARAMETERS_FORBIDDEN', 'exe');
    const command = resolveExecutable(appId, executable === undefined ? undefined : [executable]);
    if (!command) return failure(appId, target, 'EXECUTABLE_MISSING', 'exe');
    const outcome = await spawnDetached(command, []);
    if (!outcome.ok) return failure(appId, target, outcome.errorCode, 'exe');
    return success(appId, target, 'exe', resolved.displayName);
  }

  async function launchUrl({ appId, target, resolved, executable, args, url, folder }) {
    if (executable !== undefined || folder !== undefined) return failure(appId, target, 'PARAMETERS_FORBIDDEN', 'url');
    const parsed = validateSpawnArguments(args);
    if (!parsed.ok) return failure(appId, target, parsed.errorCode, 'url');
    if (parsed.args.length) return failure(appId, target, 'PARAMETERS_FORBIDDEN', 'url');
    const parameters = store.validateParameters(appId, target, { url });
    if (!parameters.ok) return failure(appId, target, parameters.errorCode, 'url');
    if (!shell || typeof shell.openExternal !== 'function') return failure(appId, target, 'LAUNCH_FAILED', 'url');
    try {
      const opened = await shell.openExternal(parameters.parameters.url);
      if (opened === false) return failure(appId, target, 'LAUNCH_FAILED', 'url');
    } catch { return failure(appId, target, 'LAUNCH_FAILED', 'url'); }
    return success(appId, target, 'url', resolved.displayName);
  }

  async function launchFolder({ appId, target, resolved, executable, args, url, folder }) {
    if (url !== undefined) return failure(appId, target, 'PARAMETERS_FORBIDDEN', 'folder');
    const parsed = validateSpawnArguments(args);
    if (!parsed.ok) return failure(appId, target, parsed.errorCode, 'folder');
    // 目录只接受一个来源：args:[folder] 或 folder 字段；两者同时出现时必须完全一致。
    if (parsed.args.length > 1) return failure(appId, target, 'PARAMETERS_INVALID', 'folder');
    if (folder !== undefined && parsed.args.length === 1 && parsed.args[0] !== folder) return failure(appId, target, 'PARAMETERS_FORBIDDEN', 'folder');
    const selected = folder ?? parsed.args[0];
    if (typeof selected !== 'string' || !selected) return failure(appId, target, 'PARAMETERS_INVALID', 'folder');
    // 会话级 folderAllowlist 由主进程持有；启动器读不到，因此把该目录当作唯一授权项，
    // 重新执行“绝对路径 / 敏感根 / 存在性 / 是目录”的全部校验。
    const parameters = store.validateParameters(appId, target, { folder: selected }, { folderAllowlist: [selected] });
    if (!parameters.ok) return failure(appId, target, parameters.errorCode, 'folder');
    const command = resolveExecutable(appId, executable === undefined ? undefined : [executable]);
    if (!command) return failure(appId, target, 'EXECUTABLE_MISSING', 'folder');
    const outcome = await spawnDetached(command, [parameters.parameters.folder]);
    if (!outcome.ok) return failure(appId, target, outcome.errorCode, 'folder');
    return success(appId, target, 'folder', resolved.displayName);
  }

  function readRequest(request) {
    const echo = value => (typeof value === 'string' && value.length <= 200 ? value : null);
    if (!request || typeof request !== 'object' || Array.isArray(request)) return { ok: false, appId: null, target: null, errorCode: 'PARAMETERS_INVALID' };
    const appId = request.appId;
    if (typeof appId !== 'string' || !appId || appId !== appId.trim() || appId.length > MAX_TEXT_LENGTH) {
      return { ok: false, appId: echo(appId), target: echo(request.target), errorCode: 'APP_UNKNOWN' };
    }
    const target = request.target;
    if (typeof target !== 'string' || !target || target !== target.trim() || target.length > MAX_TEXT_LENGTH) {
      return { ok: false, appId, target: echo(target), errorCode: 'TARGET_UNKNOWN' };
    }
    // 严格字段白名单：额外字段（例如 command / script / shell）一律拒绝，不做静默忽略。
    if (Object.keys(request).some(key => !REQUEST_FIELDS.includes(key))) return { ok: false, appId, target, errorCode: 'PARAMETERS_FORBIDDEN' };
    if (request.displayName !== undefined && (typeof request.displayName !== 'string' || request.displayName.length > MAX_TEXT_LENGTH || CONTROL_PATTERN.test(request.displayName))) {
      return { ok: false, appId, target, errorCode: 'PARAMETERS_INVALID' };
    }
    if (request.kind !== undefined && request.kind !== null && !LAUNCH_KINDS.includes(request.kind)) return { ok: false, appId, target, errorCode: 'PARAMETERS_INVALID' };
    if (request.executable !== undefined && typeof request.executable !== 'string') return { ok: false, appId, target, errorCode: 'PARAMETERS_INVALID' };
    if (request.url !== undefined && typeof request.url !== 'string') return { ok: false, appId, target, errorCode: 'PARAMETERS_INVALID' };
    if (request.folder !== undefined && typeof request.folder !== 'string') return { ok: false, appId, target, errorCode: 'PARAMETERS_INVALID' };
    if (request.args !== undefined && !Array.isArray(request.args)) return { ok: false, appId, target, errorCode: 'PARAMETERS_INVALID' };
    return { ok: true, appId, target, kind: request.kind ?? undefined, displayName: request.displayName,
      executable: request.executable, args: request.args, url: request.url, folder: request.folder };
  }

  async function launch(request) {
    const shape = readRequest(request);
    if (!shape.ok) return failure(shape.appId, shape.target, shape.errorCode, null);
    // displayName 只用来做类型校验；结果文案一律使用注册表登记的 displayName，不采信调用方文案。
    const { appId, target, executable, args, url, folder } = shape;
    const resolved = store.resolve(appId, target);
    if (!resolved.ok) {
      return failure(appId, target, resolved.errorCode, null, resolved.errorCode === 'TARGET_UNSUPPORTED' ? resolved.message : undefined);
    }
    const expectedKind = resolved.requiresUrl ? 'url' : resolved.requiresFolder ? 'folder' : 'exe';
    const kind = shape.kind === undefined ? expectedKind : shape.kind;
    if (!LAUNCH_KINDS.includes(kind)) return failure(appId, target, 'PARAMETERS_INVALID', null);
    // 目标与启动方式必须一致：不允许把“指定文件夹/指定网址”降级成其它方式启动。
    if (kind !== expectedKind) return failure(appId, target, 'PARAMETERS_INVALID', kind);
    const context = { appId, target, resolved, executable, args, url, folder };
    if (kind === 'url') return launchUrl(context);
    if (kind === 'folder') return launchFolder(context);
    return launchExecutable(context);
  }

  return Object.freeze({ resolveExecutable, launch });
}

module.exports = { createAppLauncher, validateSpawnArguments, errorCodeFor, HONEST_LAUNCH_NOTE, SPAWN_OPTIONS, LAUNCH_ERROR_CODES };