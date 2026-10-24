import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createAppLauncherRegistry, validateLaunchUrl, forbiddenSpawnText, REGISTRY_ERROR_CODES } = require('../../apps/desktop/app-launcher-registry.cjs');

// 合成环境与合成路径：不读取真实注册表、不访问真实磁盘、不创建任何进程。
const env = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\anna\\AppData\\Local',
  APPDATA: 'C:\\Users\\anna\\AppData\\Roaming',
  USERPROFILE: 'C:\\Users\\anna',
  HOME: 'C:\\Users\\anna',
};
const userDirectories = ['C:\\Users\\anna\\Documents', 'C:\\Users\\anna\\Desktop'];
const key = (value: string) => value.replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase();

function fixture(options: { directories?: string[]; files?: string[]; platform?: string; env?: Record<string, string>; appPaths?: (input: unknown) => string[] } = {}) {
  const directories = new Set<string>([...userDirectories, ...(options.directories ?? [])].map(key));
  const files = new Set<string>((options.files ?? []).map(key));
  const exists = vi.fn((value: string) => directories.has(key(value)) || files.has(key(value)));
  const stat = vi.fn((value: string) => (directories.has(key(value)) ? { isDirectory: true } : files.has(key(value)) ? { isDirectory: false } : undefined));
  const registry = createAppLauncherRegistry({
    platform: options.platform ?? 'win32', exists, stat, env: options.env ?? env, appPaths: options.appPaths,
  });
  return { registry, exists, stat };
}

describe('智能打开软件 · 固定注册表', () => {
  it('登记六款软件，界面风险分级正确，且不含任何高风险目标', () => {
    const { registry } = fixture();
    const catalog = registry.catalog();
    expect(catalog.map((application: { appId: string }) => application.appId)).toEqual(['calculator', 'notepad', 'explorer', 'browser', 'vscode', 'wechat']);
    expect(catalog.find((application: { appId: string }) => application.appId === 'notepad')).toEqual({
      appId: 'notepad', displayName: '记事本',
      targets: [{ target: 'default', description: '主界面', risk: 'low', requiresFolder: false, requiresUrl: false }],
    });
    expect(catalog.find((application: { appId: string }) => application.appId === 'explorer').targets).toEqual([
      { target: 'default', description: '主界面', risk: 'low', requiresFolder: false, requiresUrl: false },
      { target: 'folder', description: '指定文件夹', risk: 'confirm', requiresFolder: true, requiresUrl: false },
    ]);
    expect(catalog.find((application: { appId: string }) => application.appId === 'browser').targets).toEqual([
      { target: 'default', description: '主界面', risk: 'low', requiresFolder: false, requiresUrl: false },
      { target: 'url', description: '指定网址', risk: 'confirm', requiresFolder: false, requiresUrl: true },
    ]);
    expect(catalog.find((application: { appId: string }) => application.appId === 'wechat').targets)
      .toEqual([{ target: 'default', description: '主界面', risk: 'low', requiresFolder: false, requiresUrl: false }]);
    const text = JSON.stringify(catalog).toLowerCase();
    for (const forbidden of ['delete', 'format', 'registry', 'admin', 'uninstall', 'settings', 'shell', 'powershell', 'cmd']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('目录是每次新建的副本，外部修改不会污染注册表', () => {
    const { registry } = fixture();
    const first = registry.catalog();
    first[0].displayName = '被篡改';
    first[0].targets[0].risk = 'confirm';
    expect(registry.catalog()[0]).toEqual({ appId: 'calculator', displayName: '计算器', targets: [{ target: 'default', description: '主界面', risk: 'low', requiresFolder: false, requiresUrl: false }] });
  });

  it.each(['cmd', 'cmd /c calc', 'powershell', 'powershell -c calc', 'C:\\evil.exe', 'calc.exe', 'calculator ', 'CALCULATOR', 'wechat-settings', 'delete', 'settings', ''])('未登记软件一律 APP_UNKNOWN：%j', appId => {
    expect(fixture().registry.resolve(appId, 'default')).toMatchObject({ ok: false, errorCode: 'APP_UNKNOWN' });
  });

  it.each([null, undefined, 42, {}, ['calculator'], true])('非字符串 appId 也一律 APP_UNKNOWN：%j', appId => {
    expect(fixture().registry.resolve(appId, 'default')).toMatchObject({ ok: false, errorCode: 'APP_UNKNOWN' });
  });

  it.each(['settings', 'delete', 'format', 'shell', '..\\default', 'default ', 'C:\\evil.exe', 'cmd /c calc', 'url', ''])('未登记界面一律 TARGET_UNKNOWN：%j', target => {
    expect(fixture().registry.resolve('notepad', target)).toMatchObject({ ok: false, errorCode: 'TARGET_UNKNOWN' });
  });

  it.each([null, undefined, 7, {}, ['default']])('非字符串 target 也一律 TARGET_UNKNOWN：%j', target => {
    expect(fixture().registry.resolve('notepad', target)).toMatchObject({ ok: false, errorCode: 'TARGET_UNKNOWN' });
  });

  it('微信已声明但暂不支持的内部界面明确说明只能打开主界面', () => {
    const { registry } = fixture();
    for (const target of ['settings', 'chat', 'moments']) {
      const result = registry.resolve('wechat', target);
      expect(result).toMatchObject({ ok: false, errorCode: 'TARGET_UNSUPPORTED' });
      expect(result.message).toBe('该软件暂不支持直接打开这个界面，只能打开主界面。');
      expect(result.message).toContain('只能打开主界面');
    }
    expect(registry.resolve('wechat', 'default')).toMatchObject({ ok: true, risk: 'low' });
    expect(registry.resolve('wechat', 'contacts')).toMatchObject({ ok: false, errorCode: 'TARGET_UNKNOWN' });
  });

  it('合法登记返回固定结构，不夹带额外字段', () => {
    expect(fixture().registry.resolve('browser', 'url')).toEqual({
      ok: true, appId: 'browser', target: 'url', displayName: '浏览器', targetDescription: '指定网址',
      risk: 'confirm', requiresFolder: false, requiresUrl: true,
    });
    expect(fixture().registry.resolve('explorer', 'folder')).toEqual({
      ok: true, appId: 'explorer', target: 'folder', displayName: '文件资源管理器', targetDescription: '指定文件夹',
      risk: 'confirm', requiresFolder: true, requiresUrl: false,
    });
  });

  it('只接受 url/folder 白名单键，Shell 与路径类参数一律拒绝', () => {
    const { registry } = fixture();
    expect(registry.validateParameters('notepad', 'default', {})).toEqual({ ok: true, parameters: {} });
    expect(registry.validateParameters('notepad', 'default', undefined)).toEqual({ ok: true, parameters: {} });
    for (const parameters of [{ command: 'cmd /c calc' }, { exe: 'C:\\evil.exe' }, { path: 'C:\\Windows' },
      { shell: true }, { script: 'calc.ps1' }, { parameters: { url: 'https://example.org' } }]) {
      expect(registry.validateParameters('notepad', 'default', parameters)).toEqual({ ok: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    }
    for (const parameters of [null, 'cmd /c calc', ['cmd'], 42, true]) {
      expect(registry.validateParameters('notepad', 'default', parameters)).toEqual({ ok: false, errorCode: 'PARAMETERS_INVALID' });
    }
    expect(registry.validateParameters('cmd /c calc', 'default', {})).toMatchObject({ ok: false, errorCode: 'APP_UNKNOWN' });
    expect(registry.validateParameters('notepad', 'settings', {})).toMatchObject({ ok: false, errorCode: 'TARGET_UNKNOWN' });
    expect(registry.validateParameters('wechat', 'moments', {})).toMatchObject({ ok: false, errorCode: 'TARGET_UNSUPPORTED' });
  });

  it('目标与参数必须匹配：指定网址只收 url，指定文件夹只收 folder', () => {
    const { registry } = fixture();
    expect(registry.validateParameters('browser', 'url', {})).toEqual({ ok: false, errorCode: 'PARAMETERS_INVALID' });
    expect(registry.validateParameters('browser', 'url', { url: 'https://example.org/', folder: 'C:\\Users\\anna\\Documents' }))
      .toEqual({ ok: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    expect(registry.validateParameters('explorer', 'folder', {})).toEqual({ ok: false, errorCode: 'PARAMETERS_INVALID' });
    expect(registry.validateParameters('explorer', 'folder', { folder: 'C:\\Users\\anna\\Documents', url: 'https://example.org/' }))
      .toEqual({ ok: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    expect(registry.validateParameters('calculator', 'default', { url: 'https://example.org/' }))
      .toEqual({ ok: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    expect(registry.validateParameters('browser', 'url', { url: 42 })).toEqual({ ok: false, errorCode: 'PARAMETERS_INVALID' });
  });

  it('只允许 http/https 且主机带点，返回规范化地址', () => {
    const { registry } = fixture();
    for (const [value, expected] of [['https://example.org/garden?a=1&b=2', 'https://example.org/garden?a=1&b=2'],
      ['http://example.org/', 'http://example.org/'], ['https://example.org:443/', 'https://example.org/'],
      ['http://example.org:80/notes', 'http://example.org/notes'], ['HTTPS://EXAMPLE.ORG/', 'https://example.org/']] as const) {
      expect(registry.validateParameters('browser', 'url', { url: value })).toEqual({ ok: true, parameters: { url: expected } });
    }
  });

  it.each(['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'data:text/html,alert(1)', 'vbscript:msgbox(1)',
    'about:blank', 'ms-settings:privacy-microphone', 'shell:startup', 'ftp://example.org/', 'chrome://settings',
    'search-ms:query=calc', 'C:\\Windows\\System32\\calc.exe'])('危险协议一律 URL_PROTOCOL_BLOCKED：%s', url => {
    expect(fixture().registry.validateParameters('browser', 'url', { url })).toEqual({ ok: false, errorCode: 'URL_PROTOCOL_BLOCKED' });
  });

  it.each(['https://localhost/', 'http://localhost:3000/', 'https://127.0.0.1/', 'https://[::1]/', 'https://10.0.0.5/',
    'https://192.168.1.10/admin', 'https://172.16.3.4/', 'https://2130706433/', 'https://intranet/', 'https://server.local/',
    'https://example.internal/', 'https://example.org./', 'https://user:pass@example.org/', 'https://example.org:8080/',
    'https://example.org:21/', 'https://example.org/a b', 'https://example.org\\a', 'cmd /c calc', 'https://'])('内网、IP、账号密码、异常端口或畸形地址一律 URL_INVALID：%s', url => {
    expect(fixture().registry.validateParameters('browser', 'url', { url })).toEqual({ ok: false, errorCode: 'URL_INVALID' });
  });

  it('超长地址与空白地址被拒绝', () => {
    const { registry } = fixture();
    expect(registry.validateParameters('browser', 'url', { url: `https://${'a'.repeat(2100)}.org/` })).toEqual({ ok: false, errorCode: 'URL_INVALID' });
    expect(registry.validateParameters('browser', 'url', { url: '   ' })).toEqual({ ok: false, errorCode: 'URL_INVALID' });
  });

  it('目录必须命中授权列表，大小写与结尾分隔符不影响比对，子目录不被授权', () => {
    const { registry } = fixture();
    const folderAllowlist = ['C:\\Users\\anna\\Documents'];
    expect(registry.validateParameters('explorer', 'folder', { folder: 'C:\\Users\\anna\\Documents' }, { folderAllowlist }))
      .toEqual({ ok: true, parameters: { folder: 'C:\\Users\\anna\\Documents' } });
    expect(registry.validateParameters('explorer', 'folder', { folder: 'c:\\users\\anna\\documents\\' }, { folderAllowlist }))
      .toEqual({ ok: true, parameters: { folder: 'c:\\users\\anna\\documents\\' } });
    expect(registry.validateParameters('explorer', 'folder', { folder: 'C:\\Users\\anna\\Desktop' }, { folderAllowlist }))
      .toEqual({ ok: false, errorCode: 'FOLDER_NOT_ALLOWED' });
    expect(registry.validateParameters('explorer', 'folder', { folder: 'C:\\Users\\anna\\Documents\\secret' }, { folderAllowlist }))
      .toEqual({ ok: false, errorCode: 'FOLDER_NOT_ALLOWED' });
    expect(registry.validateParameters('explorer', 'folder', { folder: 'C:\\Users\\anna\\Documents' }, { folderAllowlist: [] }))
      .toEqual({ ok: false, errorCode: 'FOLDER_NOT_ALLOWED' });
    expect(registry.validateParameters('vscode', 'folder', { folder: 'C:\\Users\\anna\\Desktop' }, { folderAllowlist: ['C:\\Users\\anna\\Desktop'] }))
      .toEqual({ ok: true, parameters: { folder: 'C:\\Users\\anna\\Desktop' } });
  });

  it('即使被授权，系统敏感根与网络路径也一律 FOLDER_NOT_ALLOWED', () => {
    const sensitive = ['C:\\', 'D:\\', 'C:\\Windows', 'C:\\Windows\\System32', 'C:\\Windows\\System32\\config',
      'C:\\Windows\\SysWOW64', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\Users\\anna', '\\\\server\\share', '//server/share'];
    const { registry } = fixture({ directories: [...sensitive, 'C:\\Windows\\System32\\config'] });
    for (const folder of sensitive) {
      expect(registry.validateParameters('explorer', 'folder', { folder }, { folderAllowlist: [folder] }))
        .toEqual({ ok: false, errorCode: 'FOLDER_NOT_ALLOWED' });
    }
    // 用户目录根之下的普通子目录仍可用。
    expect(registry.validateParameters('explorer', 'folder', { folder: 'C:\\Users\\anna\\Documents' }, { folderAllowlist: ['C:\\Users\\anna\\Documents'] }))
      .toEqual({ ok: true, parameters: { folder: 'C:\\Users\\anna\\Documents' } });
  });

  it('目录缺失、不是目录、相对路径或含 Shell 连接符都分别报错', () => {
    const { registry } = fixture({ files: ['C:\\Users\\anna\\Desktop\\note.txt'] });
    expect(registry.validateParameters('explorer', 'folder', { folder: 'C:\\Users\\anna\\Gone' }, { folderAllowlist: ['C:\\Users\\anna\\Gone'] }))
      .toEqual({ ok: false, errorCode: 'FOLDER_MISSING' });
    expect(registry.validateParameters('explorer', 'folder', { folder: 'C:\\Users\\anna\\Desktop\\note.txt' }, { folderAllowlist: ['C:\\Users\\anna\\Desktop\\note.txt'] }))
      .toEqual({ ok: false, errorCode: 'FOLDER_MISSING' });
    for (const folder of ['Documents\\notes', 'Documents', '', '   ', 42, 'C:\\Users\\anna\\Documents ']) {
      expect(registry.validateParameters('explorer', 'folder', { folder }, { folderAllowlist: [String(folder)] }))
        .toEqual({ ok: false, errorCode: 'PARAMETERS_INVALID' });
    }
    for (const folder of ['C:\\Users\\anna\\Documents;calc', 'C:\\Users\\anna\\Documents && calc', 'C:\\Users\\anna\\Documents|calc', 'C:\\Users\\anna\\Documents\ncalc']) {
      expect(registry.validateParameters('explorer', 'folder', { folder }, { folderAllowlist: [folder] }))
        .toEqual({ ok: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    }
  });

  it('授权列表本身必须是字符串数组', () => {
    const { registry } = fixture();
    expect(() => registry.validateParameters('explorer', 'folder', { folder: 'C:\\Users\\anna\\Documents' }, { folderAllowlist: 'C:\\Users\\anna\\Documents' })).toThrow('目录授权列表');
    expect(() => registry.validateParameters('explorer', 'folder', { folder: 'C:\\Users\\anna\\Documents' }, { folderAllowlist: [42] })).toThrow(TypeError);
  });

  it('固定候选全部是绝对 exe，且不含调用方路径与 Shell 字符', () => {
    const { registry } = fixture();
    expect(registry.executableCandidates('notepad')).toEqual(['C:\\Windows\\System32\\notepad.exe', 'C:\\Windows\\notepad.exe']);
    expect(registry.executableCandidates('explorer')).toEqual(['C:\\Windows\\explorer.exe']);
    expect(registry.executableCandidates('calculator')).toEqual(['C:\\Windows\\System32\\calc.exe', 'C:\\Users\\anna\\AppData\\Local\\Microsoft\\WindowsApps\\calc.exe']);
    expect(registry.executableCandidates('vscode')).toEqual(['C:\\Users\\anna\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', 'C:\\Program Files\\Microsoft VS Code\\Code.exe', 'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe']);
    for (const application of registry.catalog()) {
      for (const candidate of registry.executableCandidates(application.appId)) {
        expect(path.win32.isAbsolute(candidate)).toBe(true);
        expect(candidate.toLowerCase().endsWith('.exe')).toBe(true);
        expect(candidate).not.toMatch(/[;&|<>"\r\n]/u);
        expect(candidate).not.toMatch(/^\\\\/u);
      }
    }
    for (const appId of ['cmd', 'powershell', 'C:\\evil.exe', 'calc.exe', '', undefined, 42]) {
      expect(registry.executableCandidates(appId)).toEqual([]);
    }
  });

  it('候选随本机固定环境变化，不需要硬编码系统盘', () => {
    const { registry } = fixture({ env: { SystemRoot: 'D:\\WinNT', USERPROFILE: 'D:\\Profiles\\bob', LOCALAPPDATA: 'D:\\Profiles\\bob\\AppData\\Local' } });
    expect(registry.executableCandidates('notepad')).toEqual(['D:\\WinNT\\System32\\notepad.exe', 'D:\\WinNT\\notepad.exe']);
    expect(registry.executableCandidates('calculator')).toEqual(['D:\\WinNT\\System32\\calc.exe', 'D:\\Profiles\\bob\\AppData\\Local\\Microsoft\\WindowsApps\\calc.exe']);
  });

  it('App Paths 读取器是受信任扩展点：只接受存在的绝对 exe，其余全部丢弃', () => {
    const registered = 'D:\\Apps\\WeChat\\WeChat.exe';
    const appPaths = vi.fn(() => [registered, 'relative\\WeChat.exe', 'C:\\evil.exe;calc', '"C:\\quoted.exe"', '\\\\server\\share\\evil.exe', 'C:\\Missing\\WeChat.exe']);
    const directories = new Set<string>([key(registered)]);
    const base = fixture();
    const registry = createAppLauncherRegistry({
      platform: 'win32', env,
      exists: (value: string) => directories.has(key(value)) || base.exists(value),
      stat: base.stat, appPaths,
    });
    const candidates = registry.executableCandidates('wechat');
    expect(appPaths).toHaveBeenCalledWith({ appId: 'wechat', exeNames: ['WeChat.exe', 'Weixin.exe'] });
    expect(candidates).toContain(registered);
    expect(candidates).toHaveLength(5);
    expect(candidates.join(' ')).not.toContain('evil');
    expect(candidates.join(' ')).not.toContain('relative');
    const throwing = createAppLauncherRegistry({ platform: 'win32', env, exists: () => false, stat: () => undefined, appPaths: () => { throw new Error('synthetic-reader-failure'); } });
    expect(throwing.executableCandidates('wechat')).toHaveLength(4);
  });

  it('非 Windows 平台不会把 Windows 固定路径当作候选', () => {
    const { registry } = fixture({ platform: 'linux', env: { HOME: '/home/anna' } });
    expect(registry.executableCandidates('notepad')).toEqual([]);
    expect(registry.validateParameters('explorer', 'folder', { folder: '/home/anna/Documents' }, { folderAllowlist: ['/home/anna/Documents'] }))
      .toEqual({ ok: false, errorCode: 'FOLDER_MISSING' });
    expect(registry.validateParameters('explorer', 'folder', { folder: '/etc' }, { folderAllowlist: ['/etc'] }))
      .toEqual({ ok: false, errorCode: 'FOLDER_NOT_ALLOWED' });
    expect(registry.validateParameters('explorer', 'folder', { folder: '/home/anna' }, { folderAllowlist: ['/home/anna'] }))
      .toEqual({ ok: false, errorCode: 'FOLDER_NOT_ALLOWED' });
  });

  it('A 节列出的每个注册表错误码都真实可达', () => {
    const { registry } = fixture({ directories: ['C:\\Windows'], files: ['C:\\Users\\anna\\Desktop\\note.txt'] });
    const codes = new Set<string>();
    const collect = (result: { ok: boolean; errorCode?: string }) => { if (result.ok === false && result.errorCode) codes.add(result.errorCode); };
    collect(registry.resolve('cmd /c calc', 'default'));
    collect(registry.resolve('notepad', 'format'));
    collect(registry.resolve('wechat', 'settings'));
    collect(registry.validateParameters('browser', 'url', { url: 42 }));
    collect(registry.validateParameters('notepad', 'default', { command: 'cmd /c calc' }));
    collect(registry.validateParameters('browser', 'url', { url: 'javascript:alert(1)' }));
    collect(registry.validateParameters('browser', 'url', { url: 'https://127.0.0.1/' }));
    collect(registry.validateParameters('explorer', 'folder', { folder: 'C:\\Windows' }, { folderAllowlist: ['C:\\Windows'] }));
    collect(registry.validateParameters('explorer', 'folder', { folder: 'C:\\Users\\anna\\Gone' }, { folderAllowlist: ['C:\\Users\\anna\\Gone'] }));
    expect([...codes].sort()).toEqual([...REGISTRY_ERROR_CODES].sort());
    expect([...REGISTRY_ERROR_CODES]).toHaveLength(9);
  });

  it('公共判定函数只认可规范的 http/https 与干净文本', () => {
    expect(validateLaunchUrl('https://example.org/')).toEqual({ ok: true, url: 'https://example.org/' });
    expect(validateLaunchUrl('file:///C:/private.txt')).toEqual({ ok: false, errorCode: 'URL_PROTOCOL_BLOCKED' });
    expect(validateLaunchUrl(42)).toEqual({ ok: false, errorCode: 'PARAMETERS_INVALID' });
    expect(forbiddenSpawnText('C:\\Users\\anna\\Documents')).toBe(false);
    for (const value of ['a;b', 'a && b', 'a|b', 'a>b', 'a<b', 'a\nb', 'a\rb', 'a"b', 'a\u0000b']) expect(forbiddenSpawnText(value)).toBe(true);
  });

  it('真实 fs.statSync 形态（isDirectory 是方法）与异常 stat 都被正确处理', () => {
    const directory = 'C:\\Users\\anna\\Documents';
    const file = 'C:\\Users\\anna\\note.txt';
    const asDirectory = createAppLauncherRegistry({ platform: 'win32', env, exists: () => true, stat: () => ({ isDirectory: () => true }) });
    expect(asDirectory.validateParameters('explorer', 'folder', { folder: directory }, { folderAllowlist: [directory] }))
      .toEqual({ ok: true, parameters: { folder: directory } });
    const asFile = createAppLauncherRegistry({ platform: 'win32', env, exists: () => true, stat: () => ({ isDirectory: () => false }) });
    expect(asFile.validateParameters('explorer', 'folder', { folder: file }, { folderAllowlist: [file] }))
      .toEqual({ ok: false, errorCode: 'FOLDER_MISSING' });
    const broken = createAppLauncherRegistry({ platform: 'win32', env, exists: () => true, stat: () => { throw new Error('synthetic-stat-failure'); } });
    expect(broken.validateParameters('explorer', 'folder', { folder: directory }, { folderAllowlist: [directory] }))
      .toEqual({ ok: false, errorCode: 'FOLDER_MISSING' });
    const unreadable = createAppLauncherRegistry({ platform: 'win32', env, exists: () => { throw new Error('synthetic-exists-failure'); }, stat: () => undefined });
    expect(unreadable.validateParameters('explorer', 'folder', { folder: directory }, { folderAllowlist: [directory] }))
      .toEqual({ ok: false, errorCode: 'FOLDER_MISSING' });
  });

  it.skipIf(process.platform !== 'win32')('默认 exists/stat 在真实文件系统上也只放行真实目录', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'nuanban-launcher-folder-'));
    const file = path.join(directory, 'note.txt');
    writeFileSync(file, 'synthetic');
    try {
      const registry = createAppLauncherRegistry({ platform: 'win32', env: process.env });
      expect(registry.validateParameters('explorer', 'folder', { folder: directory }, { folderAllowlist: [directory] }))
        .toEqual({ ok: true, parameters: { folder: directory } });
      expect(registry.validateParameters('explorer', 'folder', { folder: file }, { folderAllowlist: [file] }))
        .toEqual({ ok: false, errorCode: 'FOLDER_MISSING' });
      expect(registry.validateParameters('explorer', 'folder', { folder: 'C:\\Users\\nuanban-missing-folder' }, { folderAllowlist: ['C:\\Users\\nuanban-missing-folder'] }))
        .toEqual({ ok: false, errorCode: 'FOLDER_MISSING' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('注册表模块自身不创建进程、不接触 Shell', () => {
    const source = readFileSync(new URL('../../apps/desktop/app-launcher-registry.cjs', import.meta.url), 'utf8');
    expect(source).not.toContain('child_process');
    expect(source).not.toMatch(/\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/u);
    expect(source).not.toMatch(/shell\s*:\s*true/u);
  });
});