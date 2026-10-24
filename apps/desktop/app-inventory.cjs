const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// 本机软件清单发现（inventory）。
//
// 安全边界（与 .cache/app-launcher-contract-v2.md 的 A 节一致）：
// - 只读遍历开始菜单的两个根（可用 roots 注入）；零子进程、零网络、不写入任何文件；
// - 绝不解析 .lnk/.url 的内容，也不运行任何目标程序：打开动作只能由主进程的启动器完成；
// - catalog()/match() 只返回不含路径的投影，真实路径只由 resolve() 交给主进程内部使用；
// - 危险与管理类条目（卸载、命令提示符、注册表、系统管理工具、System32/SysWOW64 管理工具目录……）
//   在扫描阶段就丢弃，既不在清单里，也不可能被 resolve() 命中。
//
// 返回结构（冻结契约 A 节，不夹带任何额外字段、任何真实路径）：
//   .catalog()   // [{ id, displayName, group }]，按 displayName 升序，最多 maxEntries
//   .resolve(id) // { ok:true, id, displayName, kind:'lnk'|'url'|'exe', target } | { ok:false, errorCode:'APP_UNKNOWN' }
//   .match(text) // [{ id, displayName, score }]，按 score 降序，最多 8 条
//   .refresh()   // { ok:true, total }
//   .total()     // number（与 catalog() 的条数一致）

const INVENTORY_ERROR_CODES = Object.freeze(['APP_UNKNOWN']);
const ID_PREFIX = 'sm:';
const ID_HEX_LENGTH = 12;
const ID_PATTERN = /^sm:[0-9a-f]{12}$/u;
const DEFAULT_MAX_ENTRIES = 400;
const MAX_ENTRIES_LIMIT = 10000;
const MAX_ROOTS = 16;
const MAX_SCAN_DEPTH = 12;
const MAX_SCAN_ENTRIES = 20000;
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_MATCH_TEXT_LENGTH = 300;
const MAX_MATCH_RESULTS = 8;
// 单次扫描的总时长上限：遍历大目录树时不会把主进程卡住（now 可注入以便测试与验证）。
const DEFAULT_SCAN_BUDGET_MS = 2000;
const SCORE_EXACT = 100;
const SCORE_INCLUDES_MIN = 75;
const SCORE_INCLUDES_MAX = 99;
const SCORE_TOKEN_MAX = 74;
const KIND_BY_EXTENSION = new Map([['.lnk', 'lnk'], ['.url', 'url'], ['.exe', 'exe']]);
// System32/SysWOW64 下的管理工具目录一律不进入清单。
const ADMIN_PATH_SEGMENTS = new Set(['system32', 'syswow64']);
const CONTROL_OR_FORMAT_PATTERN = /[\p{Cc}\p{Cf}]/u;
const SPACE_OR_PUNCT_PATTERN = /[\s\p{P}\p{Z}]+/gu;
const HAN_ONLY_PATTERN = /^\p{Script=Han}+$/u;
const NETWORK_PATH_PATTERN = /^[\\/]{2}/u;
const PATH_SEPARATOR_PATTERN = /[\\/]+/u;

// 危险 / 管理类关键词（大小写不敏感，含中英文；文件夹名同样参与判断）。
// 命中即整条丢弃，绝不进入 catalog()/resolve()/match()。
const DANGEROUS_KEYWORDS = Object.freeze([
  // 卸载、删除、修复、更新
  '卸载', 'uninstall', '删除', 'delete', 'remove', 'repair', '修复', '更新', 'update',
  // 安装与安装器：安装/部署类入口一律不进清单（刻意 fail-closed，会连带排除 Installation notes 这类说明项）
  '安装', 'install', 'installer', 'setup',
  // 管理工具类目录
  'administrative tools', '管理工具', 'windows 管理工具', '系统工具', 'system tools',
  // 命令、脚本与终端（只收明确名称；刻意不用裸 shell，避免误伤 FinalShell / SQL Shell 这类 GUI 客户端）
  '命令提示符', 'command prompt', 'powershell', 'pwsh', 'windows terminal', 'terminal', '终端',
  'git bash', 'bash', 'anaconda prompt', 'miniconda prompt', 'conda prompt', 'wsl', 'cmd',
  // 虚拟网络与管理员工具
  '虚拟网络', 'virtual network',
  // 操作记录类（隐私相关）
  '步骤记录器', 'steps recorder',
  // 注册表与系统配置
  'regedit', 'registry editor', '注册表', 'msconfig', '系统配置', 'system configuration',
  'gpedit', '组策略', 'group policy',
  // 系统管理面板
  '服务', 'service', '计算机管理', 'computer management', '磁盘管理', 'disk management',
  '设备管理器', 'device manager', '任务计划程序', 'task scheduler', '资源监视器', 'resource monitor',
  '事件查看器', 'event viewer', '任务管理器', 'task manager', '控制面板', 'control panel',
  '设置', 'settings',
  // 磁盘与分区
  'format', '分区', 'diskpart',
]);

// 查询规范化时要摘掉的口语化词（长的先摘，避免残留半截词）。
const FILLER_WORDS = Object.freeze(['帮我打开', '我想打开', '电脑上的', '应用程序', '应用软件', '帮我', '帮忙', '打开一下',
  '打开', '开启', '启动', '运行', '请', '一下', '软件', '应用', '程序', '我要', '我想', '电脑', '本机', '上面的',
  '我', '你', '的', '下', '吧', '吗', '呢', '啊', '哦', '嗯']
  .slice().sort((left, right) => right.length - left.length || (left < right ? -1 : 1)));

const DANGEROUS_KEYWORD_FORMS = Object.freeze(DANGEROUS_KEYWORDS.map(keyword => Object.freeze({
  raw: keyword.toLowerCase(),
  compact: compactKeyword(keyword),
})));

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compactKeyword(value) {
  return value.normalize('NFKC').toLowerCase().replace(SPACE_OR_PUNCT_PATTERN, '');
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string' || !value) return '';
  return value.normalize('NFKC').replace(CONTROL_OR_FORMAT_PATTERN, ' ').replace(/\s+/gu, ' ').trim();
}

// 同名判定：大小写、全角半角、空白差异都视为同一个名字。
function nameKey(value) {
  return normalizeDisplayName(value).toLowerCase();
}

function stripFillers(value) {
  let text = value;
  for (let round = 0; round < 4; round += 1) {
    let changed = false;
    for (const word of FILLER_WORDS) {
      if (!text.includes(word)) continue;
      text = text.split(word).join(' ');
      changed = true;
    }
    if (!changed) break;
  }
  return text.replace(/\s+/gu, ' ').trim();
}

// 规范形：NFKC → 去口语词 → 去空白与标点 → 小写。
function compactText(value) {
  const normalized = normalizeDisplayName(value);
  if (!normalized) return '';
  return stripFillers(normalized).toLowerCase().replace(SPACE_OR_PUNCT_PATTERN, '');
}

function tokenize(value) {
  const prepared = stripFillers(normalizeDisplayName(value)).toLowerCase();
  const tokens = new Set();
  for (const piece of prepared.split(SPACE_OR_PUNCT_PATTERN)) {
    if (!piece) continue;
    tokens.add(piece);
    // 中文没有词边界：补上二字滑窗，让“计算器科学”这类颠倒词也能按词元重合命中。
    if (HAN_ONLY_PATTERN.test(piece)) {
      for (let index = 0; index + 1 < piece.length; index += 1) tokens.add(piece.slice(index, index + 2));
    }
  }
  return tokens;
}

function tokenDice(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  if (!shared) return 0;
  return (2 * shared) / (left.size + right.size);
}

// 名称或所在文件夹命中危险关键词即视为危险条目。
function isDangerousText(value) {
  if (typeof value !== 'string' || !value) return false;
  const raw = value.normalize('NFKC').toLowerCase();
  const compact = raw.replace(SPACE_OR_PUNCT_PATTERN, '');
  return DANGEROUS_KEYWORD_FORMS.some(form =>
    (form.raw && raw.includes(form.raw)) || (form.compact && compact.includes(form.compact)));
}

function isDangerousName(value) {
  return isDangerousText(normalizeDisplayName(value));
}

function hasAdminPathSegment(value) {
  if (typeof value !== 'string' || !value) return false;
  return value.split(PATH_SEPARATOR_PATTERN).some(segment => ADMIN_PATH_SEGMENTS.has(segment.toLowerCase()));
}

function pathIdentity(value, pathApi) {
  if (typeof value !== 'string' || !value) return '';
  const normalized = pathApi.normalize(value);
  const root = pathApi.parse ? pathApi.parse(normalized).root : '';
  const trimmed = normalized.length > root.length ? normalized.replace(/[\\/]+$/u, '') : normalized;
  return trimmed.toLowerCase();
}

function firstAbsolute(value, pathApi) {
  return typeof value === 'string' && value && pathApi.isAbsolute(value) ? value : undefined;
}

// 默认扫描根：当前用户与所有用户的开始菜单 Programs 目录。
function defaultStartMenuRoots(env, pathApi) {
  const roots = [];
  const roaming = firstAbsolute(env.APPDATA, pathApi)
    ?? (firstAbsolute(env.USERPROFILE, pathApi) ? pathApi.join(env.USERPROFILE, 'AppData', 'Roaming') : undefined);
  const machine = firstAbsolute(env.ProgramData, pathApi) ?? firstAbsolute(env.PROGRAMDATA, pathApi)
    ?? firstAbsolute(env.ALLUSERSPROFILE, pathApi) ?? (firstAbsolute(env.SystemDrive, pathApi)
      ? pathApi.join(env.SystemDrive, 'ProgramData') : undefined);
  if (roaming) roots.push(pathApi.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  if (machine) roots.push(pathApi.join(machine, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  return roots;
}

function pathApiFor(platform, pathModule) {
  const candidate = platform === 'win32' ? pathModule.win32 : pathModule.posix;
  return plainObject(candidate) ? candidate : pathModule;
}

function resolveClock(now) {
  if (now === undefined) return Date.now;
  if (typeof now === 'function') {
    return () => {
      try {
        const value = now();
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
        return Number.NaN;
      } catch { return Number.NaN; }
    };
  }
  if (typeof now === 'number' && Number.isFinite(now)) return () => now;
  if (now instanceof Date && !Number.isNaN(now.getTime())) return () => now.getTime();
  throw new TypeError('时间来源无效');
}

// id 必须稳定且不含路径：sm: + sha256(相对路径的小写规范化) 前 12 位十六进制。
function inventoryIdFor(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) return '';
  const normalized = relativePath.replace(/\\/gu, '/').replace(/\/{2,}/gu, '/').replace(/^\.\//u, '').replace(/\/+$/u, '').toLowerCase();
  if (!normalized || normalized.startsWith('../') || normalized === '..') return '';
  return `${ID_PREFIX}${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, ID_HEX_LENGTH)}`;
}

function resolveRoots(injected, { platform, env, pathApi }) {
  if (injected === undefined) return platform === 'win32' ? defaultStartMenuRoots(env, pathApi) : [];
  if (!Array.isArray(injected) || injected.length > MAX_ROOTS) throw new TypeError('扫描根目录无效');
  const roots = [];
  const seen = new Set();
  for (const value of injected) {
    if (typeof value !== 'string' || !value || value !== value.trim() || CONTROL_OR_FORMAT_PATTERN.test(value)) {
      throw new TypeError('扫描根目录无效');
    }
    if (!pathApi.isAbsolute(value)) throw new TypeError('扫描根目录无效');
    // 网络路径一律拒绝：扫描必须保证零网络。
    if (NETWORK_PATH_PATTERN.test(value)) throw new TypeError('扫描根目录无效');
    const identity = pathIdentity(value, pathApi);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    roots.push(pathApi.normalize(value));
  }
  return roots;
}

// 读取一层目录：符号链接一律跳过，既避免目录环，也保证不越出扫描根。
function readDirectory(fsModule, pathApi, directory) {
  let items;
  try { items = fsModule.readdirSync(directory, { withFileTypes: true }); } catch { return []; }
  if (!Array.isArray(items)) return [];
  const result = [];
  for (const item of items) {
    if (typeof item === 'string') {
      if (!item || item === '.' || item === '..') continue;
      const details = statEntry(fsModule, pathApi.join(directory, item));
      if (!details) continue;
      result.push({ name: item, isDirectory: details === 'directory', isFile: details === 'file' });
      continue;
    }
    if (!plainObject(item) || typeof item.name !== 'string' || !item.name || item.name === '.' || item.name === '..') continue;
    // 只跳过明确是符号链接的条目；注入的简化形态（只有 isFile/isDirectory 布尔字段）照常处理。
    if (flagOf(item, 'isSymbolicLink') === true) continue;
    result.push({ name: item.name, isDirectory: flagOf(item, 'isDirectory') === true, isFile: flagOf(item, 'isFile') === true });
  }
  return result;
}

function flagOf(item, name) {
  const value = item[name];
  if (typeof value === 'function') {
    try { return value.call(item) === true; } catch { return undefined; }
  }
  return typeof value === 'boolean' ? value : undefined;
}

function statEntry(fsModule, target) {
  if (typeof fsModule.statSync !== 'function') return undefined;
  try {
    const details = fsModule.statSync(target);
    if (!plainObject(details)) return undefined;
    const isDirectory = typeof details.isDirectory === 'function' ? details.isDirectory() : details.isDirectory;
    const isFile = typeof details.isFile === 'function' ? details.isFile() : details.isFile;
    if (isDirectory === true) return 'directory';
    if (isFile === true) return 'file';
    return undefined;
  } catch { return undefined; }
}

function createAppInventory(options = {}) {
  if (!plainObject(options)) throw new TypeError('清单选项必须是对象');
  const platform = options.platform === undefined ? process.platform : options.platform;
  const env = options.env === undefined ? process.env : options.env;
  const fsModule = options.fsModule === undefined ? fs : options.fsModule;
  const pathModule = options.pathModule === undefined ? path : options.pathModule;
  const exists = options.exists;
  const maxEntries = options.maxEntries === undefined ? DEFAULT_MAX_ENTRIES : options.maxEntries;

  if (typeof platform !== 'string' || !platform) throw new TypeError('运行平台无效');
  if (!plainObject(env)) throw new TypeError('运行环境无效');
  if (!plainObject(fsModule) || typeof fsModule.readdirSync !== 'function') throw new TypeError('文件系统模块无效');
  if (!plainObject(pathModule)) throw new TypeError('路径模块无效');
  const pathApi = pathApiFor(platform, pathModule);
  if (typeof pathApi.join !== 'function' || typeof pathApi.relative !== 'function' || typeof pathApi.basename !== 'function'
    || typeof pathApi.extname !== 'function' || typeof pathApi.isAbsolute !== 'function' || typeof pathApi.normalize !== 'function') {
    throw new TypeError('路径模块无效');
  }
  if (exists !== undefined && typeof exists !== 'function') throw new TypeError('文件存在性检查无效');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES_LIMIT) throw new TypeError('清单条数上限无效');
  const clock = resolveClock(options.now);
  const rootList = resolveRoots(options.roots, { platform, env, pathApi });
  const existsProbe = exists ?? (typeof fsModule.existsSync === 'function' ? fsModule.existsSync.bind(fsModule) : fs.existsSync);
  const fileExists = value => { try { return existsProbe(value) === true; } catch { return false; } };

  const state = { scanned: false, entries: [], byId: new Map() };

  function buildEntry({ root, fullPath, fileName, kind, folderSegments }) {
    if (CONTROL_OR_FORMAT_PATTERN.test(fileName)) return undefined;
    const extension = pathApi.extname(fileName);
    const displayName = normalizeDisplayName(pathApi.basename(fileName, extension));
    if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) return undefined;
    if (/[\\/]/u.test(displayName)) return undefined;
    const relative = pathApi.relative(root, fullPath);
    if (!relative || relative.startsWith('..') || pathApi.isAbsolute(relative)) return undefined;
    const id = inventoryIdFor(relative);
    if (!id) return undefined;
    const folders = folderSegments.map(normalizeDisplayName);
    // 危险 / 管理类：名称或所在文件夹命中关键词，或位于 System32/SysWOW64 下，一律丢弃。
    if (isDangerousText(displayName)) return undefined;
    if (folders.some(isDangerousText)) return undefined;
    if (hasAdminPathSegment(fullPath)) return undefined;
    return { id, displayName, nameKey: nameKey(displayName), group: folders.filter(Boolean).join('/'),
      folders, kind, target: fullPath };
  }

  function scan() {
    const collected = [];
    const seenIds = new Set();
    const seenNames = new Set();
    const startedAt = clock();
    const deadline = Number.isFinite(startedAt) ? startedAt + DEFAULT_SCAN_BUDGET_MS : Number.POSITIVE_INFINITY;
    let visited = 0;
    let stopped = false;

    const visit = (root, directory, depth, folderSegments) => {
      if (stopped || depth > MAX_SCAN_DEPTH) return;
      if (clock() > deadline) { stopped = true; return; }
      // 目录内的处理顺序固定为名称升序：去重与截断都由此可复现，id 也保持稳定。
      const items = readDirectory(fsModule, pathApi, directory)
        .slice().sort((left, right) => compareText(left.name, right.name));
      for (const item of items) {
        if (stopped) return;
        visited += 1;
        if (visited > MAX_SCAN_ENTRIES) { stopped = true; return; }
        const fullPath = pathApi.join(directory, item.name);
        if (item.isDirectory) {
          if (CONTROL_OR_FORMAT_PATTERN.test(item.name) || item.name.length > MAX_DISPLAY_NAME_LENGTH) continue;
          visit(root, fullPath, depth + 1, [...folderSegments, item.name]);
          continue;
        }
        if (!item.isFile) continue;
        const kind = KIND_BY_EXTENSION.get(pathApi.extname(item.name).toLowerCase());
        if (!kind) continue;
        const entry = buildEntry({ root, fullPath, fileName: item.name, kind, folderSegments });
        if (!entry) continue;
        // 去重：同一 id（同一条相对路径，例如两个根里的同一个快捷方式）或同一规范化名称只保留一条。
        if (seenIds.has(entry.id) || seenNames.has(entry.nameKey)) continue;
        seenIds.add(entry.id);
        seenNames.add(entry.nameKey);
        collected.push(entry);
      }
    };

    for (const root of rootList) {
      if (stopped) break;
      visit(root, root, 0, []);
    }
    collected.sort((left, right) => compareText(left.displayName, right.displayName) || compareText(left.id, right.id));
    const capped = collected.slice(0, maxEntries);
    state.entries = capped;
    state.byId = new Map(capped.map(entry => [entry.id, entry]));
    state.scanned = true;
  }

  function ensureScanned() {
    if (!state.scanned) scan();
  }

  function catalog() {
    ensureScanned();
    return state.entries.map(entry => ({ id: entry.id, displayName: entry.displayName, group: entry.group }));
  }

  function resolve(id) {
    ensureScanned();
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return { ok: false, errorCode: 'APP_UNKNOWN' };
    const entry = state.byId.get(id);
    if (!entry) return { ok: false, errorCode: 'APP_UNKNOWN' };
    // 二次兜底：即使内部状态被污染，危险条目也绝不返回可启动路径。
    if (isDangerousText(entry.displayName) || entry.folders.some(isDangerousText) || hasAdminPathSegment(entry.target)) {
      return { ok: false, errorCode: 'APP_UNKNOWN' };
    }
    // 清单可能过期：目标已被删除时一律 APP_UNKNOWN，交由扫描刷新后再试。
    if (!fileExists(entry.target)) return { ok: false, errorCode: 'APP_UNKNOWN' };
    return { ok: true, id: entry.id, displayName: entry.displayName, kind: entry.kind, target: entry.target };
  }

  function match(text) {
    ensureScanned();
    if (typeof text !== 'string') return [];
    const trimmed = text.slice(0, MAX_MATCH_TEXT_LENGTH).trim();
    if (!trimmed) return [];
    const query = compactText(trimmed);
    if (!query) return [];
    const queryTokens = tokenize(trimmed);
    const scored = [];
    for (const entry of state.entries) {
      const name = compactText(entry.displayName);
      if (!name) continue;
      let score = 0;
      if (name === query) {
        score = SCORE_EXACT;
      } else if (name.includes(query) || query.includes(name)) {
        const shorter = Math.min(name.length, query.length);
        const longer = Math.max(name.length, query.length);
        score = Math.round(SCORE_INCLUDES_MIN + (SCORE_INCLUDES_MAX - SCORE_INCLUDES_MIN) * (shorter / longer));
      } else {
        score = Math.min(SCORE_TOKEN_MAX, Math.round(SCORE_TOKEN_MAX * tokenDice(queryTokens, tokenize(entry.displayName))));
      }
      if (score <= 0) continue;
      scored.push({ id: entry.id, displayName: entry.displayName, score });
    }
    scored.sort((left, right) => right.score - left.score || compareText(left.displayName, right.displayName)
      || compareText(left.id, right.id));
    return scored.slice(0, MAX_MATCH_RESULTS);
  }

  function refresh() {
    scan();
    return { ok: true, total: state.entries.length };
  }

  function total() {
    ensureScanned();
    return state.entries.length;
  }

  return Object.freeze({ catalog, resolve, match, refresh, total });
}

module.exports = { createAppInventory, inventoryIdFor, isDangerousName, isDangerousText, INVENTORY_ERROR_CODES };