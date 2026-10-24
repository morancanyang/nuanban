import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createAppInventory, inventoryIdFor, isDangerousName, INVENTORY_ERROR_CODES } = require('../../apps/desktop/app-inventory.cjs');

// 全部用例都只在自己创建的隔离临时目录里造合成快捷方式（空文件即可）：
// 不读取真实开始菜单、不打开任何软件、不创建子进程、不访问网络。

const temporaryDirectories: string[] = [];

function makeRoot(label = 'root'): string {
  const directory = mkdtempSync(path.join(tmpdir(), `nuanban-inventory-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

// 合成 .lnk/.url/.exe（写入极短内容，模块从不读取内容）。
function makeEntry(root: string, relative: string, content = 'synthetic'): string {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

// 独立复算契约里的 id：sm: + sha256(相对路径的小写规范化) 前 12 位十六进制。
function idOf(relativePath: string): string {
  return `sm:${createHash('sha256').update(relativePath.toLowerCase(), 'utf8').digest('hex').slice(0, 12)}`;
}

function inventoryFor(roots: string[], options: Record<string, unknown> = {}) {
  return createAppInventory({ platform: process.platform, roots, ...options });
}

function names(inventory: { catalog: () => Array<{ displayName: string }> }): string[] {
  return inventory.catalog().map(entry => entry.displayName);
}

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
});

describe('本机软件清单发现 · inventory', () => {
  it('扫描注入的开始菜单根，只收 .lnk/.url/.exe，按 displayName 排序且投影不含路径', () => {
    const userRoot = makeRoot('user');
    const machineRoot = makeRoot('machine');
    makeEntry(userRoot, '微信.lnk');
    makeEntry(userRoot, path.join('腾讯软件', 'QQ音乐.lnk'));
    makeEntry(userRoot, '记事本.url');
    makeEntry(machineRoot, 'Notepad.exe');
    makeEntry(userRoot, 'notes.txt');
    makeEntry(userRoot, path.join('子目录', 'readme.md'));

    const inventory = inventoryFor([userRoot, machineRoot]);
    const catalog = inventory.catalog();
    expect(catalog.map((entry: { displayName: string }) => entry.displayName)).toEqual(['Notepad', 'QQ音乐', '微信', '记事本']);
    expect(catalog.map((entry: { group: string }) => entry.group)).toEqual(['', '腾讯软件', '', '']);
    for (const entry of catalog) expect(Object.keys(entry).sort()).toEqual(['displayName', 'group', 'id']);
    expect(inventory.total()).toBe(4);

    // catalog() 绝不返回真实路径、扩展名或任何目录信息。
    const serialized = JSON.stringify(catalog);
    for (const secret of [userRoot, machineRoot, 'Temp', '.lnk', '.url', '.exe', ':\\']) {
      expect(serialized.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    expect(serialized).not.toMatch(/[\\/]/u);
    expect(serialized).not.toMatch(/[a-z]:[\\/]/iu);
    // 目录是每次新建的副本，外部修改不会污染内部状态。
    catalog[0].displayName = '被篡改';
    expect(inventory.catalog()[0].displayName).toBe('Notepad');
  });

  it('同名去重：跨根重复的同一快捷方式只保留一条，同名不同路径/不同扩展名也只留一条', () => {
    const userRoot = makeRoot('dup-user');
    const machineRoot = makeRoot('dup-machine');
    makeEntry(userRoot, '微信.lnk');
    makeEntry(machineRoot, '微信.lnk');
    makeEntry(userRoot, path.join('腾讯软件', '微信.lnk'));
    makeEntry(userRoot, '画图.url');
    makeEntry(userRoot, '画图.exe');

    const inventory = inventoryFor([userRoot, machineRoot]);
    expect(names(inventory)).toEqual(['微信', '画图']);
    expect(inventory.total()).toBe(2);
  });

  it('id 是 sm: + sha256(相对路径小写规范化) 前 12 位，稳定且不含真实路径', () => {
    const root = makeRoot('id');
    makeEntry(root, path.join('工具', 'Notepad.LNK'));
    makeEntry(root, path.join('工具', '子工具', 'Deep.LNK'));
    makeEntry(root, 'Case-Test.Lnk');

    const inventory = inventoryFor([root]);
    const catalog = inventory.catalog();
    const notepad = catalog.find((entry: { displayName: string }) => entry.displayName === 'Notepad');
    const caseTest = catalog.find((entry: { displayName: string }) => entry.displayName === 'Case-Test');
    const deep = catalog.find((entry: { displayName: string }) => entry.displayName === 'Deep');
    expect(notepad.id).toBe(idOf('工具/Notepad.LNK'));
    expect(caseTest.id).toBe(idOf('case-test.lnk'));
    expect(caseTest.id).toBe(idOf('CASE-TEST.LNK'));
    expect(deep.id).toBe(idOf('工具/子工具/Deep.LNK'));
    // group 是相对的所在文件夹（统一用 /），同样不含任何真实路径。
    expect(deep.group).toBe('工具/子工具');
    expect(JSON.stringify(catalog)).not.toMatch(/\\/u);
    expect(inventoryIdFor('工具\\Notepad.LNK')).toBe(notepad.id);
    expect(inventoryIdFor('CASE-TEST.LNK')).toBe(caseTest.id);
    expect(inventoryIdFor('')).toBe('');
    expect(inventoryIdFor('../逃逸.lnk')).toBe('');
    for (const entry of catalog) {
      expect(entry.id).toMatch(/^sm:[0-9a-f]{12}$/u);
      expect(entry.id).not.toMatch(/[\\/]/u);
      expect(entry.id.toLowerCase()).not.toContain(root.toLowerCase());
      expect(entry.id).not.toContain('工具');
    }

    // 稳定：新实例与 refresh() 之后同一个文件的 id 不变。
    const second = inventoryFor([root]);
    expect(second.catalog().map((entry: { id: string }) => entry.id)).toEqual(catalog.map((entry: { id: string }) => entry.id));
    expect(inventory.refresh()).toEqual({ ok: true, total: 3 });
    expect(inventory.catalog().find((entry: { displayName: string }) => entry.displayName === 'Notepad').id).toBe(notepad.id);
  });

  it('上限 maxEntries：按名称排序后截断，total() 与 catalog() 条数一致', () => {
    const root = makeRoot('cap');
    for (let index = 0; index < 6; index += 1) makeEntry(root, `App-${index}.lnk`);

    const capped = inventoryFor([root], { maxEntries: 3 });
    expect(capped.catalog().map((entry: { displayName: string }) => entry.displayName)).toEqual(['App-0', 'App-1', 'App-2']);
    expect(capped.total()).toBe(3);
    expect(capped.refresh()).toEqual({ ok: true, total: 3 });
    expect(inventoryFor([root]).total()).toBe(6);
    expect(inventoryFor([root], { maxEntries: 400 }).total()).toBe(6);

    for (const value of [0, -1, 1.5, '400', null, true, 10001]) {
      expect(() => inventoryFor([root], { maxEntries: value })).toThrow(TypeError);
    }
  });

  it('默认上限 400：更多条目时按名称取前 400 条', () => {
    const root = makeRoot('default-cap');
    for (let index = 0; index < 405; index += 1) makeEntry(root, `App-${String(index).padStart(3, '0')}.lnk`);
    const inventory = inventoryFor([root]);
    expect(inventory.total()).toBe(400);
    const catalog = inventory.catalog();
    expect(catalog).toHaveLength(400);
    expect(catalog[0].displayName).toBe('App-000');
    expect(catalog[399].displayName).toBe('App-399');
  });

  it('危险 / 管理类条目在扫描阶段就被排除（中英文关键词与所在文件夹）', () => {
    const root = makeRoot('danger');
    const forbiddenNames = ['卸载微信', 'Uninstall Tool', 'Remove-App', '删除精灵看图组件', 'Delete Tool', '修复工具', 'Repair Tool', '更新助手', 'Windows Update',
      '安装向导', 'Installer Tool', 'Setup Wizard', 'Installation notes', 'Install Additional Tools for Node.js',
      'Administrative Tools', 'Windows 管理工具', '管理工具', '系统工具', 'System Tools',
      '命令提示符', 'Command Prompt', 'Windows PowerShell', 'powershell', 'pwsh', 'cmd',
      'Windows Terminal', 'Terminal', 'WSL', 'Ubuntu on WSL', 'Git Bash', 'Bash', 'Anaconda Prompt', 'Miniconda Prompt', 'Conda Prompt',
      '虚拟网络编辑器', 'Virtual Network Editor', 'Steps Recorder', '步骤记录器',
      'regedit', '注册表编辑器', 'Registry Editor', 'msconfig', '系统配置', 'System Configuration',
      'gpedit', '组策略', 'Group Policy',
      '服务', 'Services', 'Service Manager', '计算机管理', 'Computer Management',
      '磁盘管理', 'Disk Management', '设备管理器', 'Device Manager', '任务计划程序', 'Task Scheduler',
      '资源监视器', 'Resource Monitor', '事件查看器', 'Event Viewer',
      'Format Tool', '分区助手', 'DiskPart',
      '任务管理器', 'Task Manager', '控制面板', 'Control Panel', 'Windows 设置', 'Settings'];
    for (const name of forbiddenNames) makeEntry(root, `${name}.lnk`);
    for (const folder of ['Administrative Tools', '系统工具', 'Uninstall', 'Install Tools']) makeEntry(root, path.join(folder, '普通软件.lnk'));

    const safeNames = ['微信', '记事本', 'Notepad', 'Visual Studio Code', 'Intel Graphics Command Center',
      '计算器', '画图', 'Chrome', '我的世界', 'QQ音乐'];
    for (const name of safeNames) makeEntry(root, `${name}.lnk`);

    const inventory = inventoryFor([root]);
    expect(names(inventory)).toEqual(['Chrome', 'Intel Graphics Command Center', 'Notepad', 'QQ音乐', 'Visual Studio Code',
      '微信', '我的世界', '画图', '计算器', '记事本']);
    expect(inventory.total()).toBe(safeNames.length);
    const text = JSON.stringify(inventory.catalog()).toLowerCase();
    for (const keyword of ['卸载', 'uninstall', '删除', 'delete', 'remove', 'repair', '修复', '更新', '安装', 'install', 'setup',
      'powershell', 'pwsh', 'cmd', 'bash', 'anaconda', 'virtualnetwork', 'stepsrecorder', '步骤记录器', 'regedit', '注册表',
      'msconfig', '系统配置', '设置', '服务', '计算机管理', '磁盘管理', '设备管理器', '任务计划程序', '组策略',
      '资源监视器', '事件查看器', 'terminal', 'wsl', '任务管理器', '控制面板', 'diskpart', 'format', '分区']) {
      expect(text).not.toContain(keyword);
    }

    // 危险条目既不在 catalog，也不可能被 resolve() 命中。
    for (const name of ['卸载微信', '删除精灵看图组件', 'Windows PowerShell', '系统工具', 'Task Manager', 'cmd',
      'Git Bash', 'Anaconda Prompt', 'Installation notes']) {
      expect(inventory.resolve(idOf(`${name}.lnk`))).toEqual({ ok: false, errorCode: 'APP_UNKNOWN' });
    }
    expect(inventory.resolve(idOf('Administrative Tools/普通软件.lnk'))).toEqual({ ok: false, errorCode: 'APP_UNKNOWN' });
    expect(inventory.resolve(idOf('Install Tools/普通软件.lnk'))).toEqual({ ok: false, errorCode: 'APP_UNKNOWN' });
    expect(isDangerousName('控制面板')).toBe(true);
    expect(isDangerousName('Notepad')).toBe(false);
    expect(isDangerousName('Intel Graphics Command Center')).toBe(false);
  });

  it('终端 / Shell / 安装器 / 虚拟网络 / 记录器类关键词在扫描期即排除，名字相近的正常软件仍保留', () => {
    const root = makeRoot('shell-install');
    const forbiddenNames = ['Anaconda Prompt', 'Miniconda Prompt', 'Conda Prompt', 'Git Bash', 'Bash',
      'Windows Terminal', 'Terminal', 'pwsh', 'PowerShell 7', 'Windows PowerShell ISE',
      'Install Additional Tools for Node.js', 'Installation notes', 'Installer Tool', 'Setup Wizard', 'Setup',
      '安装向导', '安装助手', '一键安装工具',
      '虚拟网络编辑器', 'Virtual Network Editor', 'VMware Virtual Network Editor',
      'Steps Recorder', '步骤记录器'];
    for (const name of forbiddenNames) makeEntry(root, `${name}.lnk`);
    for (const folder of ['Git Bash', 'Anaconda Prompt', 'Install Tools', '虚拟网络工具']) makeEntry(root, path.join(folder, '某个软件.lnk'));

    // 精准对照：明确的终端/安装/虚拟网络/记录器入口被排除，名字相近的正常 GUI 客户端与工具仍保留。
    const safeNames = ['Anaconda Navigator', 'Git GUI', 'Insta360 Studio', 'phpstudy_pro', 'Intel Graphics Command Center',
      'FinalShell', 'FinalShell网站', 'SQL Shell (psql)', 'VMware Workstation Pro', '微信'];
    for (const name of safeNames) makeEntry(root, `${name}.lnk`);

    const inventory = inventoryFor([root]);
    expect(names(inventory)).toEqual(['Anaconda Navigator', 'FinalShell', 'FinalShell网站', 'Git GUI', 'Insta360 Studio',
      'Intel Graphics Command Center', 'SQL Shell (psql)', 'VMware Workstation Pro', 'phpstudy_pro', '微信']);
    expect(inventory.total()).toBe(safeNames.length);
    const text = JSON.stringify(inventory.catalog()).toLowerCase();
    for (const keyword of ['prompt', 'bash', 'pwsh', 'install', 'setup', '安装', 'terminal', 'virtualnetwork', 'stepsrecorder', '步骤记录器']) {
      expect(text).not.toContain(keyword);
    }

    for (const name of forbiddenNames) {
      expect(inventory.resolve(idOf(`${name}.lnk`))).toEqual({ ok: false, errorCode: 'APP_UNKNOWN' });
    }
    for (const folder of ['Git Bash', 'Anaconda Prompt', 'Install Tools', '虚拟网络工具']) {
      expect(inventory.resolve(idOf(`${folder}/某个软件.lnk`))).toEqual({ ok: false, errorCode: 'APP_UNKNOWN' });
    }
    for (const name of ['Anaconda Prompt', 'Git Bash', 'Installation notes', 'Setup Wizard', '安装向导',
      '虚拟网络编辑器', 'Virtual Network Editor', 'Steps Recorder', '步骤记录器']) {
      expect(isDangerousName(name)).toBe(true);
    }
    // 决策：裸 shell 不入词表，FinalShell / SQL Shell 这类正常客户端必须保留。
    for (const name of ['Anaconda Navigator', 'Git GUI', 'Insta360 Studio', 'phpstudy_pro', 'FinalShell', 'FinalShell网站',
      'SQL Shell (psql)', 'VMware Workstation Pro', 'Remote Desktop Connection', 'Radmin Viewer 3', 'UU远程']) {
      expect(isDangerousName(name)).toBe(false);
    }
    for (const name of ['FinalShell', 'SQL Shell (psql)', 'VMware Workstation Pro']) {
      expect(inventory.resolve(idOf(`${name}.lnk`))).toMatchObject({ ok: true });
    }
    // catalog()/match() 里也绝不出现这些条目；名字相近的软件最多以低分候选出现，绝不可能是 100 分。
    for (const query of ['Anaconda Prompt', 'Git Bash', 'Install Additional Tools for Node.js', 'Installation notes',
      'Setup Wizard', '安装向导', '虚拟网络编辑器', 'Steps Recorder']) {
      for (const entry of inventory.match(query)) {
        expect(forbiddenNames).not.toContain(entry.displayName);
        expect(entry.score).toBeLessThan(100);
      }
    }
    expect(inventory.match('安装')).toEqual([]);
    expect(inventory.match('步骤记录器')).toEqual([]);
  });

  it('System32 / SysWOW64 下的条目一律排除，注入的根自身是系统目录时也全部排除', () => {
    const root = makeRoot('system');
    makeEntry(root, 'calc.exe');
    makeEntry(root, path.join('System32', 'calc.exe'));
    makeEntry(root, path.join('Windows', 'System32', 'notepad.exe'));
    makeEntry(root, path.join('SysWOW64', 'mspaint.exe'));
    makeEntry(root, path.join('Windows', 'System32', '管理工具', 'x.lnk'));

    const inventory = inventoryFor([root]);
    expect(names(inventory)).toEqual(['calc']);

    const systemRoot = path.join(root, 'System32');
    expect(inventoryFor([systemRoot]).catalog()).toEqual([]);
    expect(inventoryFor([systemRoot]).total()).toBe(0);
  });

  it('resolve 命中返回真实路径，未命中、格式异常与过期条目一律 APP_UNKNOWN', () => {
    const root = makeRoot('resolve');
    const wechat = makeEntry(root, '微信.lnk');
    const site = makeEntry(root, '官网.url');
    const tool = makeEntry(root, '小工具.exe');
    const inventory = inventoryFor([root]);
    const catalog = inventory.catalog();
    const find = (displayName: string) => catalog.find((entry: { displayName: string }) => entry.displayName === displayName);

    expect(inventory.resolve(find('微信').id)).toEqual({ ok: true, id: find('微信').id, displayName: '微信', kind: 'lnk', target: wechat });
    expect(inventory.resolve(find('官网').id)).toEqual({ ok: true, id: find('官网').id, displayName: '官网', kind: 'url', target: site });
    expect(inventory.resolve(find('小工具').id)).toEqual({ ok: true, id: find('小工具').id, displayName: '小工具', kind: 'exe', target: tool });
    // 真实路径只在 resolve() 里出现，catalog() 里没有。
    expect(JSON.stringify(catalog)).not.toContain(root);
    expect(JSON.stringify(inventory.match('微信'))).not.toContain(root);

    for (const value of ['sm:0123456789ab', 'SM:0123456789AB', 'sm:0123456789ABCD', 'sm:0123456789a', 'sm:zzzzzzzzzzzz',
      'wechat', 'sm:', '', 42, null, undefined, {}, ['sm:0123456789ab']]) {
      expect(inventory.resolve(value)).toEqual({ ok: false, errorCode: 'APP_UNKNOWN' });
    }
    expect(inventory.resolve(find('微信').id.toUpperCase())).toEqual({ ok: false, errorCode: 'APP_UNKNOWN' });
    expect([...INVENTORY_ERROR_CODES]).toEqual(['APP_UNKNOWN']);

    // 目标被删除后：清单快照仍在，但 resolve() 失败关闭，刷新后条目消失。
    unlinkSync(wechat);
    expect(inventory.resolve(find('微信').id)).toEqual({ ok: false, errorCode: 'APP_UNKNOWN' });
    expect(names(inventory)).toContain('微信');
    expect(inventory.refresh()).toEqual({ ok: true, total: 2 });
    expect(names(inventory)).toEqual(['官网', '小工具']);
    expect(inventory.resolve(find('微信').id)).toEqual({ ok: false, errorCode: 'APP_UNKNOWN' });
  });

  it('match 规范化口语词并按 完全相同 > 包含 > 词元重合 打分', () => {
    const root = makeRoot('match');
    for (const name of ['微信', '微信读书', '记事本', 'Notepad', 'Visual Studio Code', '计算器', '科学计算器', '计算器科学',
      '腾讯会议', '腾讯视频']) makeEntry(root, `${name}.lnk`);
    const inventory = inventoryFor([root]);

    const wechat = inventory.match('打开微信');
    expect(wechat[0]).toEqual({ id: idOf('微信.lnk'), displayName: '微信', score: 100 });
    expect(wechat[1]).toMatchObject({ displayName: '微信读书', score: 87 });
    expect(inventory.match('帮我打开一下记事本软件')[0]).toEqual({ id: idOf('记事本.lnk'), displayName: '记事本', score: 100 });
    expect(inventory.match('请打开微信读书')[0]).toMatchObject({ displayName: '微信读书', score: 100 });
    expect(inventory.match('请 帮我 打开 一下 Visual Studio Code 应用')[0])
      .toEqual({ id: idOf('Visual Studio Code.lnk'), displayName: 'Visual Studio Code', score: 100 });

    // 一次调用里同时出现三档分数：完全相同 100 > 包含 89 > 词元重合 44。
    expect(inventory.match('打开计算器科学')).toEqual([
      { id: idOf('计算器科学.lnk'), displayName: '计算器科学', score: 100 },
      { id: idOf('计算器.lnk'), displayName: '计算器', score: 89 },
      { id: idOf('科学计算器.lnk'), displayName: '科学计算器', score: 44 },
    ]);
    // 包含关系里更接近的排前面。
    const partial = inventory.match('腾讯');
    expect(partial.map((entry: { displayName: string }) => entry.displayName)).toEqual(['腾讯会议', '腾讯视频']);
    expect(partial[0].score).toBe(partial[1].score);
    for (const entry of partial) expect(entry.score).toBeGreaterThanOrEqual(75);
  });

  it('match 最多 8 条、按分数降序、无匹配返回空数组、非法输入不抛错', () => {
    const root = makeRoot('match-limit');
    for (let index = 0; index < 12; index += 1) makeEntry(root, `App-${String(index).padStart(2, '0')}.lnk`);
    const inventory = inventoryFor([root]);

    const results = inventory.match('app');
    expect(results).toHaveLength(8);
    for (const entry of results) expect(Object.keys(entry).sort()).toEqual(['displayName', 'id', 'score']);
    for (let index = 1; index < results.length; index += 1) {
      expect(results[index - 1].score).toBeGreaterThanOrEqual(results[index].score);
    }
    for (const entry of results) expect(entry.displayName).toMatch(/^App-\d{2}$/u);

    for (const value of ['完全不存在的软件名', '', '   ', '打开软件', '请帮我打开一下这个应用']) {
      expect(inventory.match(value)).toEqual([]);
    }
    for (const value of [42, null, undefined, {}, ['微信'], true]) expect(inventory.match(value)).toEqual([]);
  });

  it('refresh 重新扫描：新增与删除都会反映，且不改变已存在条目的 id', () => {
    const root = makeRoot('refresh');
    makeEntry(root, '微信.lnk');
    const inventory = inventoryFor([root]);
    expect(inventory.total()).toBe(1);
    const firstId = inventory.catalog()[0].id;

    // 懒扫描：创建实例之后再放文件，第一次读取也能看到。
    const added = makeEntry(root, '新增软件.lnk');
    expect(inventory.refresh()).toEqual({ ok: true, total: 2 });
    expect(names(inventory)).toEqual(['微信', '新增软件']);
    expect(inventory.catalog().find((entry: { displayName: string }) => entry.displayName === '微信').id).toBe(firstId);

    unlinkSync(added);
    expect(inventory.refresh()).toEqual({ ok: true, total: 1 });
    expect(names(inventory)).toEqual(['微信']);
    expect(inventory.catalog()[0].id).toBe(firstId);

    const lazy = inventoryFor([root]);
    makeEntry(root, '迟到的软件.lnk');
    expect(lazy.total()).toBe(2);
  });

  it('roots 注入后只扫描注入目录，绝不回落到真实开始菜单', () => {
    const root = makeRoot('isolated');
    makeEntry(root, '微信.lnk');
    const readdir = vi.fn((directory: string) => readdirSync(directory, { withFileTypes: true }));
    const inventory = createAppInventory({
      platform: process.platform, roots: [root], fsModule: { readdirSync: readdir, existsSync: () => true },
    });
    expect(names(inventory)).toEqual(['微信']);
    expect(readdir).toHaveBeenCalled();
    for (const call of readdir.mock.calls) expect(String(call[0]).startsWith(root)).toBe(true);

    // 非 Windows 平台且未注入 roots：不扫描任何目录。
    const untouched = vi.fn(() => { throw new Error('synthetic-read-failure'); });
    const empty = createAppInventory({ platform: 'linux', env: { HOME: '/home/anna' }, fsModule: { readdirSync: untouched } });
    expect(empty.catalog()).toEqual([]);
    expect(empty.total()).toBe(0);
    expect(untouched).not.toHaveBeenCalled();
  });

  it('符号链接一律跳过，不支持的扩展名与深层目录也安全处理', () => {
    const root = makeRoot('symlink');
    const fake = {
      readdirSync: vi.fn(() => [
        { name: '真微信.lnk', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false },
        { name: '外链.lnk', isFile: () => true, isDirectory: () => false, isSymbolicLink: () => true },
        { name: '目录', isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false },
        { name: '夹带.txt', isFile: () => true, isDirectory: () => false },
      ]),
      existsSync: () => true,
    };
    const inventory = createAppInventory({ platform: process.platform, roots: [root], fsModule: fake });
    expect(names(inventory)).toEqual(['真微信']);
    expect(inventory.total()).toBe(1);
  });

  it('now 注入只用于给扫描设定时长上限：超时停止、异常时钟回退为不限时', () => {
    const root = makeRoot('budget');
    makeEntry(root, '微信.lnk');
    makeEntry(root, path.join('子目录', '记事本.lnk'));
    expect(inventoryFor([root], { now: () => 1_000 }).total()).toBe(2);
    expect(inventoryFor([root], { now: 5 }).total()).toBe(2);
    expect(inventoryFor([root], { now: new Date(1_700_000_000_000) }).total()).toBe(2);
    expect(inventoryFor([root], { now: () => { throw new Error('synthetic-clock-failure'); } }).total()).toBe(2);

    let ticks = 0;
    const jumping = () => { ticks += 1; return ticks * 60_000; };
    const budgeted = inventoryFor([root], { now: jumping });
    expect(budgeted.catalog()).toEqual([]);
    expect(budgeted.refresh()).toEqual({ ok: true, total: 0 });
    expect(ticks).toBeGreaterThan(0);

    for (const value of ['now', null, Number.NaN, {}, []]) {
      expect(() => inventoryFor([root], { now: value })).toThrow(TypeError);
    }
  });

  it('选项严格校验：非法扫描根、网络根、模块与上限都抛 TypeError', () => {
    const root = makeRoot('options');
    expect(() => createAppInventory(null)).toThrow('清单选项');
    expect(() => inventoryFor([root], { platform: '' })).toThrow('运行平台');
    expect(() => inventoryFor([root], { env: null })).toThrow('运行环境');
    expect(() => inventoryFor([root], { fsModule: {} })).toThrow('文件系统模块');
    expect(() => inventoryFor([root], { pathModule: {} })).toThrow('路径模块');
    expect(() => inventoryFor([root], { exists: 42 })).toThrow('文件存在性检查');
    expect(() => inventoryFor([root], { maxEntries: 0 })).toThrow('清单条数上限');
    for (const roots of ['C:\\根', [42], [''], ['  '], ['相对目录'], ['\\\\server\\share\\Programs'], ['./start-menu']]) {
      expect(() => createAppInventory({ platform: 'win32', roots: roots as unknown as string[] })).toThrow('扫描根目录');
    }
    expect(() => inventoryFor(Array.from({ length: 17 }, () => root))).toThrow('扫描根目录');
    // 重复注入同一个根会被去重，不会重复扫描出重复条目。
    makeEntry(root, '微信.lnk');
    expect(inventoryFor([root, root, `${root}\\`]).total()).toBe(1);
  });

  it.skipIf(process.platform !== 'win32')('默认扫描根来自 APPDATA 与 ProgramData 的开始菜单目录', () => {
    const appData = makeRoot('appdata');
    const programData = makeRoot('programdata');
    const userPrograms = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const machinePrograms = path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    makeEntry(userPrograms, '微信.lnk');
    makeEntry(userPrograms, path.join('深层目录', '记事本.lnk'));
    makeEntry(machinePrograms, '画图.url');
    makeEntry(appData, '不该被扫描到的软件.lnk');
    makeEntry(programData, '也不该被扫描到的软件.exe');

    const inventory = createAppInventory({ platform: 'win32', env: { APPDATA: appData, ProgramData: programData } });
    expect(names(inventory)).toEqual(['微信', '画图', '记事本']);
    expect(inventory.total()).toBe(3);
  });

  it('模块自身只读：零子进程、零网络、不写文件、不读取快捷方式内容', () => {
    const source = readFileSync(new URL('../../apps/desktop/app-inventory.cjs', import.meta.url), 'utf8');
    expect(source).not.toContain('child_process');
    expect(source).not.toMatch(/\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/u);
    expect(source).not.toMatch(/require\(['"](?:node:)?(?:http|https|net|tls|dgram|dns)['"]\)/u);
    expect(source).not.toMatch(/\b(?:writeFileSync|appendFileSync|mkdirSync|unlinkSync|rmSync|renameSync|copyFileSync|createWriteStream|readFileSync|readFile)\s*\(/u);
    expect(source).not.toMatch(/shell\s*:\s*true/u);
    expect(source).toContain('readdirSync');
  });
});