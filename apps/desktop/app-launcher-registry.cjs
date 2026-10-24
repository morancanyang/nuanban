const fs = require('node:fs');
const { isIP } = require('node:net');
const path = require('node:path');

// 智能打开软件 · 固定注册表（core）。
// 安全边界：本模块不创建进程、不读取注册表、不接触 Shell；
// 只把“软件 + 界面”映射为固定候选与固定校验规则，任何未登记输入一律拒绝。

const TARGET_UNSUPPORTED_MESSAGE = '该软件暂不支持直接打开这个界面，只能打开主界面。';
const REGISTRY_ERROR_CODES = Object.freeze(['APP_UNKNOWN', 'TARGET_UNKNOWN', 'TARGET_UNSUPPORTED', 'PARAMETERS_INVALID',
  'PARAMETERS_FORBIDDEN', 'URL_PROTOCOL_BLOCKED', 'URL_INVALID', 'FOLDER_NOT_ALLOWED', 'FOLDER_MISSING']);
const MAX_TEXT_LENGTH = 64;
const MAX_PATH_LENGTH = 512;
const MAX_URL_LENGTH = 2048;
const URL_ALLOWED_PORTS = new Set(['', '80', '443']);
const BLOCKED_HOST_SUFFIX = /(?:^|\.)(?:localhost|local|internal|home|lan|onion|invalid|test|example)$/u;
const HOST_PATTERN = /^[a-z0-9.-]+$/u;
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/u;
const ARGUMENT_FORBIDDEN_PATTERN = /[;|<>"]/u;
const UNC_PATTERN = /^[\\/]{2}/u;
const POSIX_SENSITIVE_ROOTS = Object.freeze(['/', '/System', '/Library', '/bin', '/sbin', '/usr', '/etc', '/var', '/boot', '/dev', '/proc', '/sys', '/root']);

// 首批软件：全部为本机常见软件，且不含删除、格式化、注册表、管理员工具、系统设置等高风险目标。
const APPLICATIONS = Object.freeze([
  Object.freeze({ appId: 'calculator', displayName: '计算器', exeNames: Object.freeze(['calc.exe']),
    targets: Object.freeze([Object.freeze({ target: 'default', description: '主界面', risk: 'low' })]),
    candidates: Object.freeze(['%SystemRoot%\\System32\\calc.exe', '%LOCALAPPDATA%\\Microsoft\\WindowsApps\\calc.exe']) }),
  Object.freeze({ appId: 'notepad', displayName: '记事本', exeNames: Object.freeze(['notepad.exe']),
    targets: Object.freeze([Object.freeze({ target: 'default', description: '主界面', risk: 'low' })]),
    candidates: Object.freeze(['%SystemRoot%\\System32\\notepad.exe', '%SystemRoot%\\notepad.exe']) }),
  Object.freeze({ appId: 'explorer', displayName: '文件资源管理器', exeNames: Object.freeze(['explorer.exe']),
    targets: Object.freeze([
      Object.freeze({ target: 'default', description: '主界面', risk: 'low' }),
      Object.freeze({ target: 'folder', description: '指定文件夹', risk: 'confirm', requiresFolder: true }),
    ]),
    candidates: Object.freeze(['%SystemRoot%\\explorer.exe']) }),
  Object.freeze({ appId: 'browser', displayName: '浏览器', exeNames: Object.freeze(['msedge.exe', 'chrome.exe', 'firefox.exe']),
    targets: Object.freeze([
      Object.freeze({ target: 'default', description: '主界面', risk: 'low' }),
      Object.freeze({ target: 'url', description: '指定网址', risk: 'confirm', requiresUrl: true }),
    ]),
    candidates: Object.freeze([
      '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
      '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
      '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
      '%ProgramFiles%\\Mozilla Firefox\\firefox.exe',
      '%ProgramFiles(x86)%\\Mozilla Firefox\\firefox.exe',
    ]) }),
  Object.freeze({ appId: 'vscode', displayName: 'VS Code 代码编辑器', exeNames: Object.freeze(['Code.exe']),
    targets: Object.freeze([
      Object.freeze({ target: 'default', description: '主界面', risk: 'low' }),
      Object.freeze({ target: 'folder', description: '指定文件夹', risk: 'confirm', requiresFolder: true }),
    ]),
    candidates: Object.freeze([
      '%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe',
      '%ProgramFiles%\\Microsoft VS Code\\Code.exe',
      '%ProgramFiles(x86)%\\Microsoft VS Code\\Code.exe',
    ]) }),
  Object.freeze({ appId: 'wechat', displayName: '微信', exeNames: Object.freeze(['WeChat.exe', 'Weixin.exe']),
    targets: Object.freeze([Object.freeze({ target: 'default', description: '主界面', risk: 'low' })]),
    // 已知但暂不支持的内部界面：明确拒绝，绝不假装能直达。
    unsupportedTargets: Object.freeze(['settings', 'chat', 'moments']),
    candidates: Object.freeze([
      '%ProgramFiles%\\Tencent\\WeChat\\WeChat.exe',
      '%ProgramFiles(x86)%\\Tencent\\WeChat\\WeChat.exe',
      '%ProgramFiles%\\Tencent\\Weixin\\Weixin.exe',
      '%ProgramFiles(x86)%\\Tencent\\Weixin\\Weixin.exe',
    ]) }),
]);
const APPLICATION_INDEX = new Map(APPLICATIONS.map(application => [application.appId, application]));

function firstText(...values) {
  return values.find(value => typeof value === 'string' && value.length > 0);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 统一的“路径身份”：忽略大小写（Windows）与结尾分隔符，用于白名单、敏感根与候选比对。
function pathIdentity(value, platform = 'win32') {
  if (typeof value !== 'string' || !value) return '';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const normalized = pathApi.normalize(value);
  const root = pathApi.parse(normalized).root;
  const trimmed = normalized.length > root.length ? normalized.replace(/[\\/]+$/u, '') : normalized;
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

// Shell 连接符与重定向：参数与目录一律不得包含（一律 shell:false，这里再拒绝一次）。
function forbiddenSpawnText(value) {
  return typeof value === 'string' && (CONTROL_PATTERN.test(value) || ARGUMENT_FORBIDDEN_PATTERN.test(value) || value.includes('&&'));
}

// 只允许 http/https：拒绝 file:/javascript:/data:/vbscript:/about: 等一切协议、带账号密码、非 80/443 端口、localhost/内网/IP 直连。
function validateLaunchUrl(value) {
  if (typeof value !== 'string') return { ok: false, errorCode: 'PARAMETERS_INVALID' };
  if (value.length < 8 || value.length > MAX_URL_LENGTH) return { ok: false, errorCode: 'URL_INVALID' };
  let url;
  try { url = new URL(value); } catch { return { ok: false, errorCode: 'URL_INVALID' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, errorCode: 'URL_PROTOCOL_BLOCKED' };
  if (CONTROL_PATTERN.test(value) || /[\s\\"<>`]/u.test(value)) return { ok: false, errorCode: 'URL_INVALID' };
  if (url.username || url.password) return { ok: false, errorCode: 'URL_INVALID' };
  if (!URL_ALLOWED_PORTS.has(url.port)) return { ok: false, errorCode: 'URL_INVALID' };
  const hostname = url.hostname.replace(/^\[/u, '').replace(/\]$/u, '').toLowerCase();
  if (!hostname || hostname.length > 253 || hostname.endsWith('.') || !hostname.includes('.')) return { ok: false, errorCode: 'URL_INVALID' };
  if (isIP(hostname)) return { ok: false, errorCode: 'URL_INVALID' };
  if (!HOST_PATTERN.test(hostname)) return { ok: false, errorCode: 'URL_INVALID' };
  if (BLOCKED_HOST_SUFFIX.test(hostname)) return { ok: false, errorCode: 'URL_INVALID' };
  return { ok: true, url: url.href };
}

function userProfileRoot(env, pathApi) {
  const profile = firstText(env.USERPROFILE, env.HOME);
  return profile && pathApi.isAbsolute(profile) ? profile : 'C:\\Users\\Default';
}

function templateValue(name, env, pathApi) {
  switch (name) {
    case 'SystemRoot': return firstText(env.SystemRoot, env.windir) || 'C:\\Windows';
    case 'ProgramFiles': return firstText(env.ProgramFiles) || 'C:\\Program Files';
    case 'ProgramFiles(x86)': return firstText(env['ProgramFiles(x86)'], env.ProgramW6432) || 'C:\\Program Files (x86)';
    case 'LOCALAPPDATA': return firstText(env.LOCALAPPDATA) || pathApi.join(userProfileRoot(env, pathApi), 'AppData', 'Local');
    case 'APPDATA': return firstText(env.APPDATA) || pathApi.join(userProfileRoot(env, pathApi), 'AppData', 'Roaming');
    default: return undefined;
  }
}

function expandCandidate(template, env, pathApi) {
  return template.replace(/%([A-Za-z()0-9]+)%/gu, (match, name) => templateValue(name, env, pathApi) ?? match);
}

function windowsUserRoots(env, pathApi) {
  const roots = [];
  const push = value => { if (typeof value === 'string' && value && pathApi.isAbsolute(value)) roots.push(value); };
  push(env.USERPROFILE);
  push(env.HOME);
  if (typeof env.HOMEDRIVE === 'string' && typeof env.HOMEPATH === 'string') push(`${env.HOMEDRIVE}${env.HOMEPATH}`);
  for (const key of ['APPDATA', 'LOCALAPPDATA']) {
    const value = env[key];
    if (typeof value === 'string' && pathApi.isAbsolute(value)) push(pathApi.dirname(pathApi.dirname(value)));
  }
  return roots;
}

// 系统敏感根：盘符根、Windows、System32/SysWOW64、Program Files 根、用户目录根。
function sensitiveFolderIndex({ platform, pathApi, env }) {
  const exact = new Set();
  const nested = new Set();
  const add = (bucket, value) => {
    if (typeof value !== 'string' || !value || !pathApi.isAbsolute(value)) return;
    bucket.add(pathIdentity(value, platform));
  };
  if (platform === 'win32') {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') add(exact, `${letter}:\\`);
    const windows = firstText(env.SystemRoot, env.windir) || 'C:\\Windows';
    add(exact, windows); add(nested, windows);
    add(exact, pathApi.join(windows, 'System32')); add(nested, pathApi.join(windows, 'System32'));
    add(exact, pathApi.join(windows, 'SysWOW64')); add(nested, pathApi.join(windows, 'SysWOW64'));
    add(exact, firstText(env.ProgramFiles) || 'C:\\Program Files');
    add(exact, firstText(env['ProgramFiles(x86)'], env.ProgramW6432) || 'C:\\Program Files (x86)');
    for (const root of windowsUserRoots(env, pathApi)) add(exact, root);
  } else {
    for (const root of POSIX_SENSITIVE_ROOTS) add(exact, root);
    add(exact, firstText(env.HOME, env.USERPROFILE));
  }
  return { exact, nested };
}

function createAppLauncherRegistry({ platform = process.platform, exists, stat, env = process.env, appPaths } = {}) {
  if (typeof platform !== 'string' || !platform) throw new TypeError('运行平台无效');
  if (env === null || typeof env !== 'object') throw new TypeError('运行环境无效');
  if (exists !== undefined && typeof exists !== 'function') throw new TypeError('文件存在性检查无效');
  if (stat !== undefined && typeof stat !== 'function') throw new TypeError('文件类型检查无效');
  if (appPaths !== undefined && typeof appPaths !== 'function') throw new TypeError('App Paths 读取器无效');
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const fileExists = exists ?? fs.existsSync;
  const fileStat = stat ?? fs.statSync;
  const context = {
    platform,
    pathApi,
    env,
    exists: value => { try { return fileExists(value) === true; } catch { return false; } },
    // fs.statSync 返回的 isDirectory 是方法，测试注入的常是布尔字段：两种形态都归一化。
    stat: value => {
      try {
        const details = fileStat(value);
        if (!plainObject(details)) return undefined;
        if (typeof details.isDirectory === 'function') return { isDirectory: details.isDirectory() === true };
        return { isDirectory: details.isDirectory === true };
      } catch { return undefined; }
    },
    sensitive: sensitiveFolderIndex({ platform, pathApi, env }),
  };

  function catalog() {
    return APPLICATIONS.map(application => ({
      appId: application.appId,
      displayName: application.displayName,
      targets: application.targets.map(target => ({
        target: target.target,
        description: target.description,
        risk: target.risk,
        requiresFolder: target.requiresFolder === true,
        requiresUrl: target.requiresUrl === true,
      })),
    }));
  }

  function resolve(appId, target) {
    if (typeof appId !== 'string' || !appId || appId.length > MAX_TEXT_LENGTH) return { ok: false, errorCode: 'APP_UNKNOWN' };
    const application = APPLICATION_INDEX.get(appId);
    if (!application) return { ok: false, errorCode: 'APP_UNKNOWN' };
    if (typeof target !== 'string' || !target || target.length > MAX_TEXT_LENGTH) return { ok: false, errorCode: 'TARGET_UNKNOWN' };
    const declared = application.targets.find(item => item.target === target);
    if (declared) {
      return { ok: true, appId, target, displayName: application.displayName, targetDescription: declared.description,
        risk: declared.risk, requiresFolder: declared.requiresFolder === true, requiresUrl: declared.requiresUrl === true };
    }
    if (application.unsupportedTargets?.includes(target)) return { ok: false, errorCode: 'TARGET_UNSUPPORTED', message: TARGET_UNSUPPORTED_MESSAGE };
    return { ok: false, errorCode: 'TARGET_UNKNOWN' };
  }

  function folderSensitive(value) {
    const identity = pathIdentity(value, platform);
    if (!identity) return true;
    if (context.sensitive.exact.has(identity)) return true;
    for (const root of context.sensitive.nested) {
      const prefix = root.endsWith(pathApi.sep) ? root : `${root}${pathApi.sep}`;
      if (identity === root || identity.startsWith(prefix)) return true;
    }
    return false;
  }

  function validateFolder(value, folderAllowlist) {
    if (typeof value !== 'string') return { ok: false, errorCode: 'PARAMETERS_INVALID' };
    if (!value || value.length > MAX_PATH_LENGTH || value !== value.trim()) return { ok: false, errorCode: 'PARAMETERS_INVALID' };
    if (forbiddenSpawnText(value)) return { ok: false, errorCode: 'PARAMETERS_FORBIDDEN' };
    if (!pathApi.isAbsolute(value)) return { ok: false, errorCode: 'PARAMETERS_INVALID' };
    if (UNC_PATTERN.test(value)) return { ok: false, errorCode: 'FOLDER_NOT_ALLOWED' };
    if (folderSensitive(value)) return { ok: false, errorCode: 'FOLDER_NOT_ALLOWED' };
    const identity = pathIdentity(value, platform);
    if (!folderAllowlist.some(item => pathIdentity(item, platform) === identity)) return { ok: false, errorCode: 'FOLDER_NOT_ALLOWED' };
    if (!context.exists(value)) return { ok: false, errorCode: 'FOLDER_MISSING' };
    const details = context.stat(value);
    if (!details || details.isDirectory !== true) return { ok: false, errorCode: 'FOLDER_MISSING' };
    return { ok: true };
  }

  function validateParameters(appId, target, parameters, options = {}) {
    const resolved = resolve(appId, target);
    if (!resolved.ok) return resolved;
    const folderAllowlist = options?.folderAllowlist ?? [];
    if (!Array.isArray(folderAllowlist) || folderAllowlist.some(item => typeof item !== 'string')) throw new TypeError('目录授权列表无效');
    const supplied = parameters === undefined ? {} : parameters;
    if (!plainObject(supplied)) return { ok: false, errorCode: 'PARAMETERS_INVALID' };
    const keys = Object.keys(supplied);
    // 只接受白名单键：任何 shell、路径、exe、额外参数都会在这里被拒绝。
    if (keys.some(key => key !== 'url' && key !== 'folder')) return { ok: false, errorCode: 'PARAMETERS_FORBIDDEN' };
    if (resolved.requiresUrl) {
      if (Object.hasOwn(supplied, 'folder')) return { ok: false, errorCode: 'PARAMETERS_FORBIDDEN' };
      if (!Object.hasOwn(supplied, 'url')) return { ok: false, errorCode: 'PARAMETERS_INVALID' };
      const url = validateLaunchUrl(supplied.url);
      if (!url.ok) return url;
      return { ok: true, parameters: { url: url.url } };
    }
    if (resolved.requiresFolder) {
      if (Object.hasOwn(supplied, 'url')) return { ok: false, errorCode: 'PARAMETERS_FORBIDDEN' };
      if (!Object.hasOwn(supplied, 'folder')) return { ok: false, errorCode: 'PARAMETERS_INVALID' };
      const folder = validateFolder(supplied.folder, folderAllowlist);
      if (!folder.ok) return folder;
      return { ok: true, parameters: { folder: supplied.folder } };
    }
    if (keys.length) return { ok: false, errorCode: 'PARAMETERS_FORBIDDEN' };
    return { ok: true, parameters: {} };
  }

  function safeExecutable(value) {
    if (typeof value !== 'string' || value.length < 4 || value.length > MAX_PATH_LENGTH || value !== value.trim()) return false;
    if (forbiddenSpawnText(value)) return false;
    if (!pathApi.isAbsolute(value) || UNC_PATTERN.test(value)) return false;
    if (platform === 'win32' && pathApi.extname(value).toLowerCase() !== '.exe') return false;
    return true;
  }

  // 固定候选：只由注册表模板（系统固定位置）与受信任的 App Paths 读取器组成，绝不包含调用方传入的路径。
  function executableCandidates(appId) {
    if (typeof appId !== 'string' || !appId || appId.length > MAX_TEXT_LENGTH) return [];
    const application = APPLICATION_INDEX.get(appId);
    if (!application) return [];
    const candidates = [];
    const seen = new Set();
    const push = value => {
      if (!safeExecutable(value)) return;
      const identity = pathIdentity(value, platform);
      if (!identity || seen.has(identity)) return;
      seen.add(identity);
      candidates.push(value);
    };
    for (const template of application.candidates) push(expandCandidate(template, env, pathApi));
    if (typeof appPaths === 'function') {
      let extra;
      try { extra = appPaths({ appId: application.appId, exeNames: application.exeNames }); } catch { extra = undefined; }
      if (Array.isArray(extra)) for (const value of extra) { if (context.exists(value)) push(value); }
    }
    return candidates;
  }

  return Object.freeze({ catalog, resolve, validateParameters, executableCandidates });
}

module.exports = { createAppLauncherRegistry, validateLaunchUrl, forbiddenSpawnText, pathIdentity, REGISTRY_ERROR_CODES };