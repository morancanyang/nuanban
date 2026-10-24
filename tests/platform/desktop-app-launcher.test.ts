import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createAppLauncher, validateSpawnArguments, HONEST_LAUNCH_NOTE, LAUNCH_ERROR_CODES } = require('../../apps/desktop/app-launcher.cjs');
const { createAppLauncherRegistry, REGISTRY_ERROR_CODES } = require('../../apps/desktop/app-launcher-registry.cjs');

// 全部使用假 spawn / 假 shell / 合成路径：测试绝不真实打开任何软件。
const env = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramData: 'C:\\ProgramData',
  LOCALAPPDATA: 'C:\\Users\\anna\\AppData\\Local',
  APPDATA: 'C:\\Users\\anna\\AppData\\Roaming',
  USERPROFILE: 'C:\\Users\\anna',
  HOME: 'C:\\Users\\anna',
};
const NOTEPAD = 'C:\\Windows\\System32\\notepad.exe';
const CALC = 'C:\\Windows\\System32\\calc.exe';
const EXPLORER = 'C:\\Windows\\explorer.exe';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CODE = 'C:\\Users\\anna\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
const REGISTERED = [NOTEPAD, CALC, EXPLORER, EDGE, CODE];
const DESKTOP = 'C:\\Users\\anna\\Desktop';
const DOCUMENTS = 'C:\\Users\\anna\\Documents';
const START_MENU = 'C:\\Users\\anna\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs';
const PUBLIC_START_MENU = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs';
const DYNAMIC_ID = 'sm:0123456789ab';
const LNK = `${START_MENU}\\网易云音乐.lnk`;
const PUBLIC_LNK = `${PUBLIC_START_MENU}\\Some App\\Some App.lnk`;
const URL_SHORTCUT = `${START_MENU}\\示例网站.url`;
const SYSTEM32_EXE = 'C:\\Windows\\System32\\notepad.exe';
const SPAWN_OPTIONS = { shell: false, detached: true, stdio: 'ignore', windowsHide: true };
const key = (value: string) => value.replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase();

class FakeChild extends EventEmitter {
  pid = 4242;
  killed = false;
  unref = vi.fn();
  kill = vi.fn(() => { this.killed = true; return true; });
}

function fixture(options: {
  existing?: string[]; directories?: string[]; files?: string[]; settleMs?: number;
  shell?: unknown; plan?: (child: FakeChild) => void; spawnFailure?: unknown; inventory?: unknown;
} = {}) {
  const existing = new Set<string>((options.existing ?? REGISTERED).map(key));
  const directories = new Set<string>([DESKTOP, DOCUMENTS, ...(options.directories ?? [])].map(key));
  const files = new Set<string>((options.files ?? []).map(key));
  const exists = vi.fn((value: string) => existing.has(key(value)) || directories.has(key(value)) || files.has(key(value)));
  const stat = vi.fn((value: string) => (directories.has(key(value)) ? { isDirectory: true } : files.has(key(value)) ? { isDirectory: false } : undefined));
  const children: FakeChild[] = [];
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const spawn = vi.fn((command: string, args: string[], spawnOptions: unknown) => {
    if (options.spawnFailure !== undefined) throw options.spawnFailure;
    const child = new FakeChild();
    children.push(child);
    calls.push({ command, args, options: spawnOptions });
    if (options.plan) queueMicrotask(() => options.plan!(child));
    return child;
  });
  const openExternal = vi.fn(async (_url: string) => undefined);
  const openPath = vi.fn(async (_path: string) => '');
  const launcher = createAppLauncher({
    spawn, shell: options.shell === undefined ? { openExternal, openPath } : options.shell,
    platform: 'win32', exists, stat, env, settleMs: options.settleMs ?? 0, inventory: options.inventory,
  });
  return { launcher, spawn, calls, children, exists, stat, openExternal, openPath };
}

// 假清单（app-inventory.cjs 的接口形状）+ 假 shell.openPath：绝不真实打开任何软件。
function dynamicInventory(target: string, displayName = '网易云音乐', kind = 'lnk') {
  const resolve = vi.fn((id: string) => (id === DYNAMIC_ID ? { ok: true, id, displayName, kind, target } : { ok: false, errorCode: 'APP_UNKNOWN' }));
  return { inventory: { resolve }, resolve };
}

function shortcutFixture(target: string, options: { files?: string[]; directories?: string[]; shell?: unknown } = {}) {
  const dynamic = dynamicInventory(target);
  const current = fixture({ ...options, files: [target, ...(options.files ?? [])], inventory: dynamic.inventory });
  return { ...current, resolve: dynamic.resolve };
}

describe('智能打开软件 · 启动器', () => {
  it('固定 exe 加固定空参数启动，只声称已发送启动请求', async () => {
    const f = fixture();
    const result = await f.launcher.launch({ appId: 'notepad', target: 'default', displayName: '记事本', kind: 'exe', executable: NOTEPAD, args: [] });
    expect(Object.keys(result).sort()).toEqual(['appId', 'errorCode', 'message', 'resolvedType', 'success', 'target']);
    expect(result).toMatchObject({ success: true, appId: 'notepad', target: 'default', errorCode: null, resolvedType: 'exe' });
    expect(result.message).toContain(HONEST_LAUNCH_NOTE);
    expect(result).not.toHaveProperty('pid');
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.calls).toEqual([{ command: NOTEPAD, args: [], options: SPAWN_OPTIONS }]);
    expect(f.children[0].unref).toHaveBeenCalledOnce();
  });

  it('省略 kind 时按登记目标派生启动方式，省略 args 时使用固定空参数', async () => {
    const f = fixture();
    await expect(f.launcher.launch({ appId: 'calculator', target: 'default', executable: CALC })).resolves.toMatchObject({ success: true, resolvedType: 'exe' });
    expect(f.calls[0].args).toEqual([]);
    const url = await f.launcher.launch({ appId: 'browser', target: 'url', url: 'https://example.org/' });
    expect(url).toMatchObject({ success: true, resolvedType: 'url' });
    const folder = await f.launcher.launch({ appId: 'explorer', target: 'folder', executable: EXPLORER, args: [DESKTOP] });
    expect(folder).toMatchObject({ success: true, resolvedType: 'folder' });
  });

  it.each(['C:\\evil.exe', 'calc.exe', 'C:\\Windows\\System32\\cmd.exe', '..\\..\\evil.exe', '\\\\server\\share\\evil.exe', `${NOTEPAD} `, 'C:\\Windows\\System32\\cmd.exe /c calc'])('未登记的 exe 即使存在也一律 EXECUTABLE_MISSING：%s', async executable => {
    const f = fixture({ existing: [...REGISTERED, 'C:\\evil.exe', 'C:\\Windows\\System32\\cmd.exe'], files: ['C:\\evil.exe'] });
    const result = await f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable });
    expect(result).toMatchObject({ success: false, errorCode: 'EXECUTABLE_MISSING' });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('Windows 路径大小写与分隔符差异视为同一候选，但实际启动登记路径', async () => {
    const f = fixture();
    const result = await f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable: 'c:/windows/system32/NOTEPAD.EXE' });
    expect(result).toMatchObject({ success: true });
    expect(f.calls[0].command).toBe(NOTEPAD);
  });

  it('登记程序不存在时 EXECUTABLE_MISSING，且不创建进程', async () => {
    const f = fixture({ existing: [] });
    await expect(f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable: NOTEPAD })).resolves.toMatchObject({ success: false, errorCode: 'EXECUTABLE_MISSING' });
    await expect(f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe' })).resolves.toMatchObject({ success: false, errorCode: 'EXECUTABLE_MISSING' });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each(['cmd', 'cmd /c calc', 'powershell', 'C:\\evil.exe', 'calculator ', 'CALCULATOR', ''])('未登记软件一律 APP_UNKNOWN，且不创建进程：%j', async appId => {
    const f = fixture();
    const result = await f.launcher.launch({ appId, target: 'default', kind: 'exe', executable: CALC });
    expect(result).toMatchObject({ success: false, errorCode: 'APP_UNKNOWN' });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 42, {}, ['calculator']])('非字符串 appId 也一律 APP_UNKNOWN：%j', async appId => {
    const f = fixture();
    await expect(f.launcher.launch({ appId, target: 'default' })).resolves.toMatchObject({ success: false, errorCode: 'APP_UNKNOWN' });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('未登记界面 TARGET_UNKNOWN，微信内部界面 TARGET_UNSUPPORTED 并说明只能打开主界面', async () => {
    const f = fixture();
    await expect(f.launcher.launch({ appId: 'notepad', target: 'delete', kind: 'exe', executable: NOTEPAD })).resolves.toMatchObject({ success: false, errorCode: 'TARGET_UNKNOWN' });
    await expect(f.launcher.launch({ appId: 'notepad', target: 'cmd /c calc' })).resolves.toMatchObject({ success: false, errorCode: 'TARGET_UNKNOWN' });
    for (const target of ['settings', 'chat', 'moments']) {
      const result = await f.launcher.launch({ appId: 'wechat', target, kind: 'exe', executable: 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe' });
      expect(result).toMatchObject({ success: false, errorCode: 'TARGET_UNSUPPORTED' });
      expect(result.message).toBe('该软件暂不支持直接打开这个界面，只能打开主界面。');
    }
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each([[['/c', 'start', 'calc']], [['cmd', '/c', 'calc']], [['a;b']], [['a && b']], [['a|b']], [['a\nb']], [['a > b']], [['a < b']], [['a"b']], [['calc.exe', '--flag']]])('任意参数、Shell 连接符与重定向一律拒绝：%j', async args => {
    const f = fixture();
    const result = await f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable: NOTEPAD, args });
    expect(result).toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each(['cmd /c calc', 42, {}, true, ['a', 42], [''], [' C:\\Windows '], Array(17).fill('a'), ['a'.repeat(1025)]])('非法参数结构一律 PARAMETERS_INVALID：%j', async args => {
    const f = fixture();
    const result = await f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable: NOTEPAD, args });
    expect(result).toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each([{ command: 'cmd /c calc' }, { shell: 'cmd /c calc' }, { script: 'calc.ps1' }, { cwd: 'C:\\Windows' }, { pid: 1 }, { approved: true }])('启动请求不接受任何额外字段：%j', async extra => {
    const f = fixture();
    const result = await f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable: NOTEPAD, ...extra });
    expect(result).toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('非对象启动请求一律 PARAMETERS_INVALID', async () => {
    const f = fixture();
    for (const request of [null, undefined, 'cmd /c calc', ['notepad'], 42]) {
      await expect(f.launcher.launch(request)).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    }
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each([['ENOENT', 'EXECUTABLE_MISSING'], ['EACCES', 'LAUNCH_FAILED'], ['EPERM', 'LAUNCH_FAILED'], [undefined, 'LAUNCH_FAILED']])('创建进程立即失败映射为固定错误码：%s', async (code, errorCode) => {
    const failure: NodeJS.ErrnoException = new Error('synthetic-launch-failure');
    if (code) failure.code = code;
    const f = fixture({ spawnFailure: failure });
    const result = await f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable: NOTEPAD });
    expect(result).toMatchObject({ success: false, errorCode });
    expect(result.message).not.toContain('synthetic');
  });

  it('创建进程返回无效句柄时 LAUNCH_FAILED，不假装成功', async () => {
    const spawn = vi.fn(() => undefined);
    const launcher = createAppLauncher({ spawn, shell: { openExternal: vi.fn() }, platform: 'win32', exists: () => true, stat: () => ({ isDirectory: true }), env, settleMs: 0 });
    await expect(launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable: NOTEPAD })).resolves.toMatchObject({ success: false, errorCode: 'LAUNCH_FAILED' });
  });

  it.each([['ENOENT', 'EXECUTABLE_MISSING'], ['EACCES', 'LAUNCH_FAILED']])('error 事件映射为固定错误码：%s', async (code, errorCode) => {
    const f = fixture({ settleMs: 20, plan: child => { const error: NodeJS.ErrnoException = new Error('synthetic'); error.code = code; child.emit('error', error); } });
    const result = await f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable: NOTEPAD });
    expect(result).toMatchObject({ success: false, errorCode });
  });

  it('结算之后迟到的 error 不影响结果，也不会变成未处理异常', async () => {
    const f = fixture({ settleMs: 0, plan: child => { setTimeout(() => { const error: NodeJS.ErrnoException = new Error('late'); error.code = 'ENOENT'; child.emit('error', error); }, 5); } });
    const result = await f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable: NOTEPAD });
    expect(result).toMatchObject({ success: true });
    await new Promise(resolve => setTimeout(resolve, 25));
  });

  it.each([1, 2, 127])('启动后立即非零退出视为 LAUNCH_FAILED：%i', async code => {
    const f = fixture({ settleMs: 20, plan: child => child.emit('exit', code) });
    await expect(f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable: NOTEPAD })).resolves.toMatchObject({ success: false, errorCode: 'LAUNCH_FAILED' });
  });

  it('立即零退出（例如已运行实例直接交接）仍只声称已发送启动请求', async () => {
    const f = fixture({ settleMs: 0, plan: child => child.emit('exit', 0) });
    const result = await f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable: NOTEPAD });
    expect(result).toMatchObject({ success: true, errorCode: null });
  });

  it('目录启动只接受一个已校验目录，参数数组固定为该项', async () => {
    const f = fixture();
    const result = await f.launcher.launch({ appId: 'explorer', target: 'folder', kind: 'folder', executable: EXPLORER, args: [DESKTOP] });
    expect(result).toMatchObject({ success: true, resolvedType: 'folder' });
    expect(result.message).toContain(HONEST_LAUNCH_NOTE);
    expect(f.calls).toEqual([{ command: EXPLORER, args: [DESKTOP], options: SPAWN_OPTIONS }]);
    const vscode = fixture();
    await expect(vscode.launcher.launch({ appId: 'vscode', target: 'folder', executable: CODE, args: [DOCUMENTS] })).resolves.toMatchObject({ success: true, resolvedType: 'folder' });
    expect(vscode.calls[0]).toEqual({ command: CODE, args: [DOCUMENTS], options: SPAWN_OPTIONS });
  });

  it.each(['C:\\', 'D:\\', 'C:\\Windows', 'C:\\Windows\\System32', 'C:\\Windows\\System32\\config', 'C:\\Users\\anna', 'C:\\Program Files', 'C:\\Program Files (x86)', '\\\\server\\share', '//server/share'])('目录启动拒绝敏感根与网络路径：%s', async folder => {
    const f = fixture({ directories: [folder] });
    const result = await f.launcher.launch({ appId: 'explorer', target: 'folder', kind: 'folder', executable: EXPLORER, args: [folder] });
    expect(result).toMatchObject({ success: false, errorCode: 'FOLDER_NOT_ALLOWED' });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('目录缺失或不是目录时 FOLDER_MISSING', async () => {
    const gone = fixture();
    await expect(gone.launcher.launch({ appId: 'explorer', target: 'folder', kind: 'folder', executable: EXPLORER, args: ['C:\\Users\\anna\\Gone'] })).resolves.toMatchObject({ success: false, errorCode: 'FOLDER_MISSING' });
    const file = fixture({ files: ['C:\\Users\\anna\\note.txt'] });
    await expect(file.launcher.launch({ appId: 'explorer', target: 'folder', kind: 'folder', executable: EXPLORER, args: ['C:\\Users\\anna\\note.txt'] })).resolves.toMatchObject({ success: false, errorCode: 'FOLDER_MISSING' });
    expect(gone.spawn).not.toHaveBeenCalled();
    expect(file.spawn).not.toHaveBeenCalled();
  });

  it('目录启动的参数个数、连接符、相对路径与未登记 exe 都被拒绝', async () => {
    const f = fixture();
    const launch = (request: Record<string, unknown>) => f.launcher.launch({ appId: 'explorer', target: 'folder', kind: 'folder', executable: EXPLORER, ...request });
    await expect(launch({ args: [DESKTOP, DOCUMENTS] })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    await expect(launch({})).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    await expect(launch({ args: ['Desktop'] })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    await expect(launch({ args: [`${DESKTOP};calc`] })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    await expect(launch({ args: [`${DESKTOP} && calc`] })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    await expect(launch({ args: [`${DESKTOP}|calc`] })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    await expect(launch({ executable: 'C:\\evil.exe', args: [DESKTOP] })).resolves.toMatchObject({ success: false, errorCode: 'EXECUTABLE_MISSING' });
    await expect(launch({ url: 'https://example.org/', args: [DESKTOP] })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('网址只交给系统浏览器打开，绝不创建进程', async () => {
    const f = fixture();
    const result = await f.launcher.launch({ appId: 'browser', target: 'url', kind: 'url', url: 'https://example.org/garden?a=1&b=2' });
    expect(result).toMatchObject({ success: true, resolvedType: 'url', errorCode: null });
    expect(result.message).toContain(HONEST_LAUNCH_NOTE);
    expect(f.openExternal).toHaveBeenCalledWith('https://example.org/garden?a=1&b=2');
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each(['file:///C:/private.txt', 'javascript:alert(1)', 'data:text/html,alert(1)', 'vbscript:msgbox(1)',
    'about:blank', 'ms-settings:privacy-microphone', 'shell:startup', 'ftp://example.org/'])('危险协议不打开：%s', async url => {
    const f = fixture();
    await expect(f.launcher.launch({ appId: 'browser', target: 'url', kind: 'url', url })).resolves.toMatchObject({ success: false, errorCode: 'URL_PROTOCOL_BLOCKED' });
    expect(f.openExternal).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each(['https://localhost/', 'https://127.0.0.1/', 'https://192.168.1.10/', 'https://10.0.0.5/',
    'https://user:pass@example.org/', 'https://example.org:8080/', 'cmd /c calc', 'C:\\Windows\\System32\\calc.exe'])('内网、IP、账号密码、异常端口与路径文本都不打开：%s', async url => {
    const f = fixture();
    const result = await f.launcher.launch({ appId: 'browser', target: 'url', kind: 'url', url });
    expect(result.success).toBe(false);
    expect(['URL_INVALID', 'URL_PROTOCOL_BLOCKED']).toContain(result.errorCode);
    expect(f.openExternal).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('网址缺失、类型错误、夹带 exe 或参数、用 exe 方式启动网址目标都被拒绝', async () => {
    const f = fixture();
    await expect(f.launcher.launch({ appId: 'browser', target: 'url', kind: 'url' })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    await expect(f.launcher.launch({ appId: 'browser', target: 'url', kind: 'url', url: 42 })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    await expect(f.launcher.launch({ appId: 'browser', target: 'url', kind: 'url', url: 'https://example.org/', executable: EDGE })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    await expect(f.launcher.launch({ appId: 'browser', target: 'url', kind: 'url', url: 'https://example.org/', args: ['--new-window'] })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    await expect(f.launcher.launch({ appId: 'browser', target: 'url', kind: 'exe', executable: EDGE })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    expect(f.openExternal).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('系统浏览器不可用或立即失败时 LAUNCH_FAILED，不创建进程，也不泄露原始异常', async () => {
    const missing = fixture({ shell: {} });
    await expect(missing.launcher.launch({ appId: 'browser', target: 'url', kind: 'url', url: 'https://example.org/' })).resolves.toMatchObject({ success: false, errorCode: 'LAUNCH_FAILED' });
    const throwing = fixture({ shell: { openExternal: vi.fn(async () => { throw new Error('synthetic-shell-failure'); }) } });
    const result = await throwing.launcher.launch({ appId: 'browser', target: 'url', kind: 'url', url: 'https://example.org/' });
    expect(result).toMatchObject({ success: false, errorCode: 'LAUNCH_FAILED' });
    expect(result.message).not.toContain('synthetic');
    const refused = fixture({ shell: { openExternal: vi.fn(async () => false) } });
    await expect(refused.launcher.launch({ appId: 'browser', target: 'url', kind: 'url', url: 'https://example.org/' })).resolves.toMatchObject({ success: false, errorCode: 'LAUNCH_FAILED' });
    for (const current of [missing, throwing, refused]) expect(current.spawn).not.toHaveBeenCalled();
  });

  it('不允许把主界面或目录目标降级成其它启动方式', async () => {
    const f = fixture();
    await expect(f.launcher.launch({ appId: 'calculator', target: 'default', kind: 'url', url: 'https://example.org/' })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    await expect(f.launcher.launch({ appId: 'calculator', target: 'default', kind: 'folder', args: [DESKTOP] })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    await expect(f.launcher.launch({ appId: 'calculator', target: 'default', kind: 'shell', executable: CALC })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    await expect(f.launcher.launch({ appId: 'explorer', target: 'folder', kind: 'exe', executable: EXPLORER })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    await expect(f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable: NOTEPAD, url: 'https://example.org/' })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    expect(f.openExternal).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('兼容主进程桥接的实际启动请求形态（exe / url / folder）', async () => {
    const f = fixture();
    expect(await f.launcher.launch({ appId: 'notepad', target: 'default', displayName: '记事本', kind: 'exe', executable: NOTEPAD, args: [] }))
      .toMatchObject({ success: true, resolvedType: 'exe' });
    expect(await f.launcher.launch({ appId: 'browser', target: 'url', displayName: '浏览器', kind: 'url', url: 'https://example.org/' }))
      .toMatchObject({ success: true, resolvedType: 'url' });
    expect(await f.launcher.launch({ appId: 'explorer', target: 'folder', displayName: '文件资源管理器', kind: 'folder', folder: DESKTOP, executable: EXPLORER, args: [DESKTOP] }))
      .toMatchObject({ success: true, resolvedType: 'folder' });
    expect(f.calls.map(call => call.args)).toEqual([[], [DESKTOP]]);
    expect(f.openExternal).toHaveBeenCalledWith('https://example.org/');
  });

  it('目录字段与参数数组必须一致，且只能用于目录目标', async () => {
    const f = fixture();
    const launch = (request: Record<string, unknown>) => f.launcher.launch({ appId: 'explorer', target: 'folder', kind: 'folder', executable: EXPLORER, ...request });
    await expect(launch({ folder: DESKTOP })).resolves.toMatchObject({ success: true });
    await expect(launch({ args: [DESKTOP] })).resolves.toMatchObject({ success: true });
    await expect(launch({ folder: DESKTOP, args: [DESKTOP] })).resolves.toMatchObject({ success: true });
    await expect(launch({ folder: DESKTOP, args: [DOCUMENTS] })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    await expect(launch({ folder: 42, args: [DESKTOP] })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    await expect(f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable: NOTEPAD, folder: DESKTOP })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    await expect(f.launcher.launch({ appId: 'browser', target: 'url', kind: 'url', url: 'https://example.org/', folder: DESKTOP })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    expect(f.spawn).toHaveBeenCalledTimes(3);
  });

  it('resolveExecutable 只返回注册表登记且实际存在的候选', () => {
    const f = fixture();
    expect(f.launcher.resolveExecutable('notepad')).toBe(NOTEPAD);
    expect(f.launcher.resolveExecutable('notepad', ['C:\\evil.exe', CALC, NOTEPAD])).toBe(NOTEPAD);
    expect(f.launcher.resolveExecutable('notepad', [CALC])).toBeUndefined();
    expect(f.launcher.resolveExecutable('notepad', ['C:\\evil.exe'])).toBeUndefined();
    expect(f.launcher.resolveExecutable('notepad', 'C:\\evil.exe')).toBeUndefined();
    expect(f.launcher.resolveExecutable('notepad', [])).toBeUndefined();
    expect(f.launcher.resolveExecutable('cmd', [NOTEPAD])).toBeUndefined();
    expect(fixture({ existing: [] }).launcher.resolveExecutable('notepad')).toBeUndefined();
  });

  it('启动器构造参数严格校验', () => {
    expect(() => createAppLauncher()).toThrow(TypeError);
    expect(() => createAppLauncher({ spawn: vi.fn(), settleMs: -1 })).toThrow('启动确认时间无效');
    expect(() => createAppLauncher({ spawn: vi.fn(), settleMs: 1.5 })).toThrow(TypeError);
    expect(() => createAppLauncher({ spawn: vi.fn(), settleMs: 60_000 })).toThrow(TypeError);
    expect(() => createAppLauncher({ spawn: vi.fn(), platform: '' })).toThrow(TypeError);
    expect(() => createAppLauncher({ spawn: vi.fn(), exists: 'always' })).toThrow(TypeError);
    expect(() => createAppLauncher({ spawn: vi.fn(), registry: {} })).toThrow(TypeError);
  });

  it('三种启动方式的成功文案都只声称已发送请求，绝不声称界面已加载', async () => {
    const f = fixture();
    const results = [
      await f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable: NOTEPAD }),
      await f.launcher.launch({ appId: 'browser', target: 'url', kind: 'url', url: 'https://example.org/' }),
      await f.launcher.launch({ appId: 'explorer', target: 'folder', kind: 'folder', executable: EXPLORER, args: [DESKTOP] }),
    ];
    for (const result of results) {
      expect(result.success).toBe(true);
      expect(result.message).toContain(HONEST_LAUNCH_NOTE);
      for (const claim of ['已进入', '已经打开', '已成功打开', '界面已就绪', '已加载完成', '已打开设置']) expect(result.message).not.toContain(claim);
    }
  });

  it('真实失败文案使用登记名称，不采信调用方伪造的 displayName', async () => {
    const f = fixture();
    const result = await f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', displayName: '系统设置', executable: NOTEPAD });
    expect(result.success).toBe(true);
    expect(result.message).toContain('记事本');
    expect(result.message).not.toContain('系统设置');
    await expect(f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', displayName: 42 })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
  });

  it('返回的每个错误码都在冻结清单内', async () => {
    const f = fixture({ existing: [], directories: ['C:\\Windows'] });
    const codes = new Set<string>();
    const collect = (result: { success: boolean; errorCode?: string | null }) => { if (result.success === false && result.errorCode) codes.add(result.errorCode); };
    collect(await f.launcher.launch({ appId: 'cmd /c calc', target: 'default' }));
    collect(await f.launcher.launch({ appId: 'notepad', target: 'format' }));
    collect(await f.launcher.launch({ appId: 'wechat', target: 'settings' }));
    collect(await f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe' }));
    collect(await f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable: NOTEPAD, args: ['a;b'] }));
    collect(await f.launcher.launch({ appId: 'browser', target: 'url', kind: 'url', url: 'javascript:alert(1)' }));
    collect(await f.launcher.launch({ appId: 'browser', target: 'url', kind: 'url', url: 'https://127.0.0.1/' }));
    collect(await f.launcher.launch({ appId: 'explorer', target: 'folder', kind: 'folder', executable: EXPLORER, args: ['C:\\Windows'] }));
    collect(await f.launcher.launch({ appId: 'explorer', target: 'folder', kind: 'folder', executable: EXPLORER, args: ['C:\\Users\\anna\\Gone'] }));
    collect(await f.launcher.launch({ appId: 'notepad', target: 'default', kind: 'exe', executable: NOTEPAD, args: 'cmd /c calc' }));
    collect(await f.launcher.launch({ appId: 'cmd', target: 'default' }));
    const brokenShell = fixture({ shell: {} });
    collect(await brokenShell.launcher.launch({ appId: 'browser', target: 'url', kind: 'url', url: 'https://example.org/' }));
    for (const code of codes) expect(LAUNCH_ERROR_CODES).toContain(code);
    expect([...codes].sort()).toEqual([...LAUNCH_ERROR_CODES].sort());
    expect(LAUNCH_ERROR_CODES).toHaveLength(11);
    for (const code of REGISTRY_ERROR_CODES) expect(LAUNCH_ERROR_CODES).toContain(code);
  });

  it('参数校验函数只接受干净的字符串数组，且不修改调用方数组', () => {
    expect(validateSpawnArguments(undefined)).toEqual({ ok: true, args: [] });
    expect(validateSpawnArguments([])).toEqual({ ok: true, args: [] });
    const args = [DOCUMENTS];
    expect(validateSpawnArguments(args)).toEqual({ ok: true, args: [DOCUMENTS] });
    expect(args).toEqual([DOCUMENTS]);
    for (const value of ['cmd /c calc', 42, {}, ['a', 2], ['a;b'], ['a && b'], ['a|b'], ['a\r\nb']]) {
      expect(validateSpawnArguments(value)).toMatchObject({ ok: false });
    }
  });

  it('启动器源码只使用固定的安全进程选项，且不接触 Shell 字符串', () => {
    const source = readFileSync(new URL('../../apps/desktop/app-launcher.cjs', import.meta.url), 'utf8');
    expect(source).toContain('shell: false');
    expect(source).toContain('detached: true');
    expect(source).toContain("stdio: 'ignore'");
    expect(source).toContain('windowsHide: true');
    expect(source).toContain(HONEST_LAUNCH_NOTE);
    expect(source).not.toMatch(/shell\s*:\s*true/u);
    expect(source).not.toContain('child_process');
    expect(source).not.toMatch(/(?:exec|execSync|execFileSync|spawnSync)\s*\(/u);
  });

  it('默认注册表下，登记软件的主界面与指定界面都能通过启动前校验', async () => {
    const spawn = vi.fn(() => new FakeChild());
    const registry = createAppLauncherRegistry({ platform: 'win32', exists: () => true, stat: () => ({ isDirectory: true }), env });
    const launcher = createAppLauncher({ spawn, shell: { openExternal: vi.fn(async () => undefined) }, platform: 'win32', exists: () => true, stat: () => ({ isDirectory: true }), env, settleMs: 0, registry });
    for (const application of registry.catalog()) {
      const target = application.targets.find((item: { risk: string }) => item.risk === 'low');
      const result = await launcher.launch({ appId: application.appId, target: target.target, kind: 'exe', displayName: application.displayName });
      expect(result.success).toBe(true);
    }
    expect(spawn).toHaveBeenCalledTimes(6);
  });
});

describe('智能打开软件 · 动态清单项（开始菜单快捷方式）', () => {
  it('清单项交给 shell.openPath 打开，绝不创建进程，也只声称已发送启动请求', async () => {
    const f = shortcutFixture(LNK);
    const result = await f.launcher.launch({ appId: DYNAMIC_ID, target: 'default', displayName: '网易云音乐', kind: 'shortcut', shortcut: LNK });
    expect(result).toEqual({ success: true, appId: DYNAMIC_ID, target: 'default', errorCode: null, resolvedType: 'shortcut',
      message: expect.stringContaining(HONEST_LAUNCH_NOTE) });
    expect(f.openPath).toHaveBeenCalledWith(LNK);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.openExternal).not.toHaveBeenCalled();
  });

  it('省略 kind 时按清单派生 shortcut，同时兼容 args:[路径] 与双来源一致写法', async () => {
    const f = shortcutFixture(LNK);
    expect((await f.launcher.launch({ appId: DYNAMIC_ID, target: 'default', shortcut: LNK })).resolvedType).toBe('shortcut');
    expect((await f.launcher.launch({ appId: DYNAMIC_ID, target: 'default', args: [LNK] })).success).toBe(true);
    expect((await f.launcher.launch({ appId: DYNAMIC_ID, target: 'default', shortcut: LNK, args: [LNK] })).success).toBe(true);
    expect(f.openPath).toHaveBeenCalledTimes(3);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('两个开始菜单根与 System32 顶层系统程序都在允许范围内', async () => {
    for (const target of [LNK, PUBLIC_LNK, URL_SHORTCUT]) {
      const f = shortcutFixture(target);
      await expect(f.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: target }))
        .resolves.toMatchObject({ success: true, resolvedType: 'shortcut' });
      expect(f.openPath).toHaveBeenCalledWith(target);
    }
    const system = shortcutFixture(SYSTEM32_EXE);
    await expect(system.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: SYSTEM32_EXE }))
      .resolves.toMatchObject({ success: true });
  });

  it.each(['C:\\Users\\anna\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs2\\evil.lnk',
    'C:\\Users\\anna\\Desktop\\evil.lnk', 'C:\\Temp\\evil.lnk',
    'C:\\Users\\anna\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\evil.lnk', 'C:\\Windows\\evil.lnk',
    'C:\\Windows\\System32\\sub\\notepad.exe', 'C:\\Windows\\System32\\calc.lnk'])('允许根之外的路径一律拒绝：%s', async target => {
    const f = shortcutFixture(target);
    const result = await f.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: target });
    expect(result).toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    expect(f.openPath).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each(['C:\\Users\\anna\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\evil.bat',
    'C:\\Users\\anna\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\evil.ps1',
    'C:\\Users\\anna\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\evil.txt',
    'C:\\Users\\anna\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\evil',
    'C:\\Users\\anna\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\evil.lnk.txt'])('只允许 .lnk/.url/.exe 扩展名：%s', async target => {
    const f = shortcutFixture(target);
    await expect(f.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: target }))
      .resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    expect(f.openPath).not.toHaveBeenCalled();
  });

  it.each(['卸载工具.lnk', 'Uninstall Helper.lnk', 'Windows 管理工具\\磁盘管理.lnk', 'Command Prompt.lnk',
    'regedit.exe', '系统配置.lnk', 'Format Tool.lnk', 'Windows Terminal.lnk', '任务管理器.lnk', '控制面板.lnk',
    'System Settings.lnk', 'System Tools\\系统信息.lnk', 'Windows System\\控制面板.lnk'])('即使位于开始菜单根，危险/管理类条目也一律拒绝：%s', async name => {
    const target = `${START_MENU}\\${name}`;
    const f = shortcutFixture(target);
    const result = await f.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: target });
    expect(result).toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    expect(f.openPath).not.toHaveBeenCalled();
  });

  it.each([`${START_MENU}\\a;b.lnk`, `${START_MENU}\\a && b.lnk`, `${START_MENU}\\a|b.lnk`, `${START_MENU}\\a>b.lnk`,
    `${START_MENU}\\a<b.lnk`, `${START_MENU}\\a\nb.lnk`, `${START_MENU}\\quote"name.lnk`,
    '\\\\server\\share\\evil.lnk', '//server/share/evil.lnk', `\\\\?\\C:\\Users\\anna\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\evil.lnk`])('含 Shell 字符或 UNC 的路径一律拒绝：%j', async target => {
    const f = shortcutFixture(target);
    await expect(f.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: target }))
      .resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    expect(f.openPath).not.toHaveBeenCalled();
  });

  it('路径不存在、是目录、缺失或类型错误分别报错', async () => {
    const dynamic = dynamicInventory(LNK);
    const missing = fixture({ inventory: dynamic.inventory, files: [] });
    await expect(missing.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: LNK }))
      .resolves.toMatchObject({ success: false, errorCode: 'EXECUTABLE_MISSING' });
    const asDirectory = fixture({ inventory: dynamic.inventory, directories: [LNK] });
    await expect(asDirectory.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: LNK }))
      .resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    const f = shortcutFixture(LNK);
    await expect(f.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut' }))
      .resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    await expect(f.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: 42 }))
      .resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    await expect(f.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: `${LNK} ` }))
      .resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    for (const current of [missing, asDirectory, f]) {
      expect(current.openPath).not.toHaveBeenCalled();
      expect(current.spawn).not.toHaveBeenCalled();
    }
  });

  it('路径必须与清单给出的目标一致，页面或模型无法替换路径', async () => {
    const other = `${START_MENU}\\另一个.lnk`;
    const dynamic = dynamicInventory(LNK);
    const f = fixture({ inventory: dynamic.inventory, files: [LNK, other] });
    await expect(f.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: other }))
      .resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    await expect(f.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: LNK }))
      .resolves.toMatchObject({ success: true });
    expect(f.openPath).toHaveBeenCalledTimes(1);
    expect(f.openPath).toHaveBeenCalledWith(LNK);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('注入的注册表没有 dynamicLaunch 时仍执行完整路径策略', async () => {
    const legacy = {
      resolve: () => ({ ok: true, appId: DYNAMIC_ID, target: 'default', displayName: '旧清单项',
        targetDescription: '主界面（本机开始菜单）', risk: 'low', dynamic: true, requiresFolder: false, requiresUrl: false }),
      validateParameters: () => ({ ok: true, parameters: {} }),
      executableCandidates: () => [],
    };
    const spawn = vi.fn();
    const openPath = vi.fn(async (_path: string) => '');
    const launcher = createAppLauncher({ spawn, shell: { openPath }, platform: 'win32',
      exists: (value: string) => key(value) === key(LNK), stat: () => ({ isDirectory: false }), env, settleMs: 0, registry: legacy });
    await expect(launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: LNK })).resolves.toMatchObject({ success: true });
    await expect(launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: 'C:\\Temp\\evil.lnk' }))
      .resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    await expect(launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: 'C:\\Windows\\System32\\cmd.exe' }))
      .resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    expect(spawn).not.toHaveBeenCalled();
    expect(openPath).toHaveBeenCalledTimes(1);
  });

  it('shell.openPath 缺失、抛错或返回错误字符串时 LAUNCH_FAILED，不创建进程', async () => {
    const missing = shortcutFixture(LNK, { shell: {} });
    await expect(missing.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: LNK }))
      .resolves.toMatchObject({ success: false, errorCode: 'LAUNCH_FAILED' });
    const throwing = shortcutFixture(LNK, { shell: { openPath: vi.fn(async () => { throw new Error('synthetic-open-failure'); }) } });
    const result = await throwing.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: LNK });
    expect(result).toMatchObject({ success: false, errorCode: 'LAUNCH_FAILED' });
    expect(result.message).not.toContain('synthetic');
    const refused = shortcutFixture(LNK, { shell: { openPath: vi.fn(async () => '文件已被移动或删除') } });
    await expect(refused.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: LNK }))
      .resolves.toMatchObject({ success: false, errorCode: 'LAUNCH_FAILED' });
    const tolerant = shortcutFixture(LNK, { shell: { openPath: vi.fn(async () => undefined) } });
    await expect(tolerant.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: LNK }))
      .resolves.toMatchObject({ success: true });
    for (const current of [missing, throwing, refused]) {
      expect(current.spawn).not.toHaveBeenCalled();
      expect(current.openExternal).not.toHaveBeenCalled();
    }
  });

  it('固定软件不能用 shortcut 启动，清单项也不能降级成 exe/url/folder', async () => {
    const fixed = fixture();
    await expect(fixed.launcher.launch({ appId: 'notepad', target: 'default', kind: 'shortcut', shortcut: LNK }))
      .resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    const dynamic = shortcutFixture(LNK);
    await expect(dynamic.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'exe', executable: NOTEPAD }))
      .resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    await expect(dynamic.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'url', url: 'https://example.org/' }))
      .resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    await expect(dynamic.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'folder', args: [DESKTOP] }))
      .resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    expect(fixed.spawn).not.toHaveBeenCalled();
    expect(fixed.openPath).not.toHaveBeenCalled();
    expect(dynamic.spawn).not.toHaveBeenCalled();
    expect(dynamic.openPath).not.toHaveBeenCalled();
    expect(dynamic.launcher.resolveExecutable(DYNAMIC_ID)).toBeUndefined();
    expect(dynamic.launcher.resolveExecutable(DYNAMIC_ID, [NOTEPAD])).toBeUndefined();
  });

  it('shortcut 请求不接受 executable/url/folder 混用、双来源不一致或额外字段', async () => {
    const f = shortcutFixture(LNK);
    const launch = (request: Record<string, unknown>) => f.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', ...request });
    await expect(launch({ shortcut: LNK, executable: NOTEPAD })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    await expect(launch({ shortcut: LNK, url: 'https://example.org/' })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    await expect(launch({ shortcut: LNK, folder: DESKTOP })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    await expect(launch({ shortcut: LNK, args: [DESKTOP] })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    await expect(launch({ shortcut: LNK, args: [LNK, DESKTOP] })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    await expect(launch({ shortcut: LNK, command: 'cmd /c calc' })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    await expect(launch({ shortcut: LNK, args: 'cmd /c calc' })).resolves.toMatchObject({ success: false, errorCode: 'PARAMETERS_INVALID' });
    expect(f.openPath).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('未注入清单时 sm: id 一律 APP_UNKNOWN，不创建进程也不调用 openPath', async () => {
    const f = fixture();
    await expect(f.launcher.launch({ appId: DYNAMIC_ID, target: 'default', kind: 'shortcut', shortcut: LNK }))
      .resolves.toMatchObject({ success: false, errorCode: 'APP_UNKNOWN' });
    expect(f.openPath).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });
});