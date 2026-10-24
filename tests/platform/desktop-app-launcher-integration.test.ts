import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createAppLauncherRegistry } = require('../../apps/desktop/app-launcher-registry.cjs');
const { createAppLauncher } = require('../../apps/desktop/app-launcher.cjs');
const { createAppLauncherIntent } = require('../../apps/desktop/app-launcher-intent.cjs');
const { createAppLauncherHistory } = require('../../apps/desktop/app-launcher-history.cjs');
const { registerAppLauncherBridge } = require('../../apps/desktop/app-launcher-bridge.cjs');

// 假 spawn：只记录调用并返回一个从不触发 error/exit 的句柄，绝不真实启动任何进程。
function fakeSpawn() {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const spawn = vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args: [...args], options: { ...options } });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    return child;
  });
  return { spawn, calls };
}

function integrationFixture(results: unknown[]) {
  const queue = [...results];
  const registry = createAppLauncherRegistry();
  const { spawn, calls } = fakeSpawn();
  const openExternal = vi.fn(async () => undefined);
  const launcher = createAppLauncher({ spawn, shell: { openExternal }, platform: 'win32', settleMs: 10 });
  const provider = { status: () => ({ available: true }), answer: vi.fn(async () => ({ text: JSON.stringify(queue.shift()) })) };
  const intent = createAppLauncherIntent({ provider, registry });
  const historyPath = join(mkdtempSync(join(tmpdir(), 'nuanban-launcher-')), 'history.json');
  const history = createAppLauncherHistory({ filePath: historyPath });
  const handlers = new Map<string, (event: unknown, payload?: unknown) => any>();
  const bridge = registerAppLauncherBridge({
    ipcMain: { handle: (channel: string, handler: (event: unknown, payload?: unknown) => any) => handlers.set(channel, handler), removeHandler: () => {} },
    isTrusted: () => true,
    registry, launcher, intent, history,
    pickFolder: async () => folderPick.current,
    showPage: () => {},
  });
  const folderPick: { current: string | undefined } = { current: undefined };
  const invoke = (name: string, payload?: unknown): any => handlers.get(`nuanban:pet-open-app:${name}`)!( {}, payload);
  return { registry, launcher, intent, history, bridge, invoke, calls, openExternal, historyPath, folderPick, spawn };
}

const shellOutput = { action: 'open_app', appId: 'calculator', appName: '计算器', target: 'default',
  targetDescription: '计算器主界面', parameters: {}, confidence: 0.95, needsConfirmation: true, reason: '合成模型' };
const wechatSettings = { action: 'open_app', appId: 'wechat', appName: '微信', target: 'settings',
  targetDescription: '微信设置', parameters: {}, confidence: 0.9, needsConfirmation: true, reason: '合成模型' };
const browserUrl = { action: 'open_app', appId: 'browser', appName: '浏览器', target: 'url',
  targetDescription: '指定网页', parameters: { url: 'https://www.example.com/news' }, confidence: 0.9, needsConfirmation: true, reason: '合成模型' };
const explorerFolder = { action: 'open_app', appId: 'explorer', appName: '文件资源管理器', target: 'folder',
  targetDescription: '指定文件夹', parameters: {}, confidence: 0.9, needsConfirmation: true, reason: '合成模型' };

describe('智能打开软件·真实注册表与启动器集成（假 spawn，不启动任何真实软件）', () => {
  it('注册表目录覆盖首批软件，微信只支持主界面', () => {
    const { catalog, resolve } = createAppLauncherRegistry();
    const ids = catalog().map((app: { appId: string }) => app.appId);
    expect(ids).toEqual(['calculator', 'notepad', 'explorer', 'browser', 'vscode', 'wechat']);
    expect(resolve('wechat', 'settings')).toMatchObject({ ok: false, errorCode: 'TARGET_UNSUPPORTED' });
    expect(resolve('registry-editor', 'default')).toMatchObject({ ok: false, errorCode: 'APP_UNKNOWN' });
    expect(resolve('calculator', 'default')).toMatchObject({ ok: true, risk: 'low' });
  });

  it('自然语言→计划→确认→执行：真实启动器用固定 exe 与空参数启动，并如实说明只发送了请求', async () => {
    const fixture = integrationFixture([shellOutput]);
    const parsed = await fixture.invoke('parse', { goal: '打开计算器', consent: true });
    expect(parsed).toMatchObject({ ok: true, kind: 'plan', plan: { appId: 'calculator', target: 'default', requiresConfirmation: true } });
    expect(fixture.calls).toHaveLength(0);
    const executed = await fixture.invoke('execute', { planId: parsed.plan.planId, approved: true });
    expect(executed).toMatchObject({ ok: true, result: { success: true, errorCode: null } });
    expect(String(executed.result.message)).toContain('仅确认已发送启动请求');
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0].command.toLowerCase()).toMatch(/calc\.exe$/u);
    expect(fixture.calls[0].args).toEqual([]);
    expect(fixture.calls[0].options).toMatchObject({ shell: false, detached: true, stdio: 'ignore', windowsHide: true });
    expect(fixture.history.list()).toHaveLength(1);
  });

  it('打开网页只走 shell.openExternal，不创建进程', async () => {
    const fixture = integrationFixture([browserUrl]);
    const parsed = await fixture.invoke('parse', { goal: '打开浏览器看新闻', consent: true });
    expect(parsed.plan).toMatchObject({ appId: 'browser', target: 'url', risk: 'confirm' });
    await fixture.invoke('execute', { planId: parsed.plan.planId, approved: true });
    expect(fixture.openExternal).toHaveBeenCalledWith('https://www.example.com/news');
    expect(fixture.calls).toHaveLength(0);
  });

  it('打开文件夹必须先由本机选择目录，且用同一个目录作为唯一参数', async () => {
    const fixture = integrationFixture([explorerFolder]);
    const directory = mkdtempSync(join(tmpdir(), 'nuanban-folder-'));
    fixture.folderPick.current = directory;
    const parsed = await fixture.invoke('parse', { goal: '打开这个文件夹', consent: true });
    expect(parsed.plan).toMatchObject({ requiresFolder: true });
    await expect(fixture.invoke('execute', { planId: parsed.plan.planId, approved: true })).resolves.toMatchObject({ ok: false, code: 'FOLDER_MISSING' });
    await expect(fixture.invoke('pick-folder', {})).resolves.toMatchObject({ ok: true, path: directory });
    await fixture.invoke('execute', { planId: parsed.plan.planId, approved: true });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0].command.toLowerCase()).toMatch(/explorer\.exe$/u);
    expect(fixture.calls[0].args).toEqual([directory]);
    rmSync(directory, { recursive: true, force: true });
  });

  it('系统敏感目录即使被选择也不允许打开', async () => {
    const fixture = integrationFixture([explorerFolder]);
    fixture.folderPick.current = 'C:\\Windows';
    await fixture.invoke('parse', { goal: '打开这个文件夹', consent: true });
    const picked = await fixture.invoke('pick-folder', {});
    expect(picked).toMatchObject({ ok: false });
    expect(['FOLDER_NOT_ALLOWED', 'FOLDER_MISSING', 'PARAMETERS_INVALID']).toContain(picked.code);
    expect(fixture.calls).toHaveLength(0);
  });

  it('微信设置等未支持界面如实告知，不伪造成功', async () => {
    const fixture = integrationFixture([wechatSettings]);
    const parsed = await fixture.invoke('parse', { goal: '打开微信设置', consent: true });
    expect(parsed).toMatchObject({ ok: true, kind: 'unsupported' });
    expect(String(parsed.message)).toContain('暂不支持直接打开这个界面');
    expect(fixture.calls).toHaveLength(0);
    expect(fixture.history.list()).toHaveLength(0);
  });

  it('模型返回命令或脚本内容时被拒绝，未登记软件被拒绝', async () => {
    const command = integrationFixture([{ action: 'open_app', appId: 'calculator', target: 'default', parameters: { command: 'powershell -c calc' } }]);
    await expect(command.invoke('parse', { goal: '打开计算器', consent: true }))
      .resolves.toMatchObject({ ok: false, code: 'UNSAFE_MODEL_OUTPUT' });
    const unknown = integrationFixture([{ action: 'open_app', appId: 'registry-editor', target: 'default', parameters: {} }]);
    await expect(unknown.invoke('parse', { goal: '打开注册表编辑器', consent: true }))
      .resolves.toMatchObject({ ok: false, code: 'APP_UNKNOWN' });
    expect(command.calls).toHaveLength(0);
    expect(unknown.calls).toHaveLength(0);
  });

  it('启动失败时如实报错并记录，界面不会显示成功', async () => {
    const fixture = integrationFixture([shellOutput]);
    fixture.spawn.mockImplementation(() => { throw Object.assign(new Error('synthetic ENOENT'), { code: 'ENOENT' }); });
    const parsed = await fixture.invoke('parse', { goal: '打开计算器', consent: true });
    const executed = await fixture.invoke('execute', { planId: parsed.plan.planId, approved: true });
    expect(executed.result).toMatchObject({ success: false });
    expect(['EXECUTABLE_MISSING', 'LAUNCH_FAILED']).toContain(executed.result.errorCode);
    expect(fixture.history.list().at(0)).toMatchObject({ appId: 'calculator', target: 'default', success: false });
  });
});