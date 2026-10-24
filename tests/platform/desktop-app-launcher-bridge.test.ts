import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { registerAppLauncherBridge, createAppLauncherController } = require('../../apps/desktop/app-launcher-bridge.cjs');

type Handler = (event: unknown, payload?: unknown) => any;

function fakeRegistry() {
  const catalog = [
    { appId: 'calculator', displayName: '计算器', targets: [{ target: 'default', description: '计算器主界面', risk: 'low', requiresFolder: false, requiresUrl: false }] },
    { appId: 'explorer', displayName: '文件资源管理器', targets: [
      { target: 'default', description: '文件资源管理器主界面', risk: 'low', requiresFolder: false, requiresUrl: false },
      { target: 'folder', description: '指定文件夹', risk: 'confirm', requiresFolder: true, requiresUrl: false }] },
    { appId: 'browser', displayName: '浏览器', targets: [
      { target: 'default', description: '浏览器首页', risk: 'low', requiresFolder: false, requiresUrl: false },
      { target: 'url', description: '指定网页', risk: 'confirm', requiresFolder: false, requiresUrl: true }] },
    { appId: 'wechat', displayName: '微信', targets: [{ target: 'default', description: '微信主界面', risk: 'low', requiresFolder: false, requiresUrl: false }] },
  ];
  return {
    catalog: () => catalog.map(app => ({ ...app, targets: app.targets.map(target => ({ ...target })) })),
    resolve(appId: string, target: string) {
      const app = catalog.find(entry => entry.appId === appId);
      if (!app) return { ok: false, errorCode: 'APP_UNKNOWN' };
      const found = app.targets.find(entry => entry.target === target);
      if (!found) return { ok: false, errorCode: 'TARGET_UNKNOWN' };
      return { ok: true, appId, target, displayName: app.displayName, targetDescription: found.description, risk: found.risk,
        requiresFolder: found.requiresFolder, requiresUrl: found.requiresUrl };
    },
    validateParameters(appId: string, target: string, parameters: Record<string, unknown>, { folderAllowlist = [] as string[] } = {}) {
      const resolved = this.resolve(appId, target) as { ok: boolean; requiresUrl?: boolean; requiresFolder?: boolean; errorCode?: string };
      if (!resolved.ok) return resolved;
      if (resolved.requiresUrl) {
        const url = String(parameters.url ?? '');
        if (!url.startsWith('https://')) return { ok: false, errorCode: 'URL_PROTOCOL_BLOCKED' };
        return { ok: true, parameters: { url } };
      }
      if (resolved.requiresFolder) {
        const folder = String(parameters.folder ?? '');
        if (!folderAllowlist.includes(folder)) return { ok: false, errorCode: 'FOLDER_NOT_ALLOWED' };
        return { ok: true, parameters: { folder } };
      }
      return { ok: true, parameters: {} };
    },
    executableCandidates: (appId: string) => [`C:/fake/${appId}.exe`],
  };
}

function fakeLauncher() {
  return {
    resolveExecutable: vi.fn((_appId: string, candidates: string[]) => candidates[0]),
    launch: vi.fn(async (spec: Record<string, unknown>): Promise<{ success: boolean; appId: unknown; target: unknown; message: string; errorCode: string | null }> => ({ success: true, appId: spec.appId, target: spec.target,
      message: `已打开${spec.displayName}，仅确认已发送启动请求，无法确认软件内部页面已加载。`, errorCode: null })),
  };
}

function fakeIntent(results: unknown[]) {
  const queue = [...results];
  return { available: () => true, parse: vi.fn(async () => queue.shift() ?? { ok: false, errorCode: 'MODEL_INVALID_JSON' }) };
}

function fakeHistory() {
  const entries: Array<Record<string, unknown>> = [];
  return { list: () => entries.map(entry => ({ ...entry })), record: vi.fn((entry: Record<string, unknown>) => { entries.push(entry); return entry; }), entries };
}

function plan(overrides: Record<string, unknown> = {}) {
  return { ok: true, kind: 'plan', plan: { appId: 'calculator', appName: '计算器', target: 'default',
    targetDescription: '计算器主界面', risk: 'low', parameters: {}, requiresFolder: false, requiresConfirmation: true, reason: '打开计算器', ...overrides } };
}

function bridgeFixture(options: { results?: unknown[]; launcher?: ReturnType<typeof fakeLauncher>; pickFolder?: () => Promise<string | undefined>; now?: () => number; history?: ReturnType<typeof fakeHistory> } = {}) {
  const handlers = new Map<string, Handler>();
  const channels: string[] = [];
  const registry = fakeRegistry();
  const launcher = options.launcher ?? fakeLauncher();
  const intent = fakeIntent(options.results ?? [plan()]);
  const history = options.history ?? fakeHistory();
  const showPage = vi.fn();
  const bridge = registerAppLauncherBridge({
    ipcMain: { handle: (channel: string, handler: Handler) => { channels.push(channel); handlers.set(channel, handler); }, removeHandler: (channel: string) => handlers.delete(channel) },
    isTrusted: (event: unknown) => Boolean((event as { trusted?: boolean } | undefined)?.trusted),
    registry, launcher, intent, history,
    pickFolder: options.pickFolder ?? (async () => 'C:/Users/33864/Documents/demo'),
    showPage, now: options.now,
  });
  const trusted = { trusted: true };
  const untrusted = { trusted: false };
  const invoke = (name: string, payload?: unknown, event: unknown = trusted): any => handlers.get(`nuanban:pet-open-app:${name}`)!(event, payload);
  return { bridge, handlers, channels, registry, launcher, intent, history, showPage, invoke, trusted, untrusted, controller: bridge.controller };
}

describe('智能打开软件的受信 IPC 与执行策略（假启动器，不打开任何真实软件）', () => {
  it('只注册固定通道，非受信任来源一律拒绝', () => {
    const current = bridgeFixture();
    expect(current.channels.sort()).toEqual(['nuanban:pet-open-app:auto', 'nuanban:pet-open-app:cancel', 'nuanban:pet-open-app:execute',
      'nuanban:pet-open-app:history', 'nuanban:pet-open-app:parse', 'nuanban:pet-open-app:pick-folder', 'nuanban:pet-open-app:show',
      'nuanban:pet-open-app:status']);
    expect(() => current.invoke('status', {}, current.untrusted)).toThrow('不可信打开来源');
  });

  it('参数只接受严格白名单字段，命令类字段无法进入主进程', () => {
    const current = bridgeFixture();
    expect(() => current.invoke('parse', { goal: '打开计算器', consent: true, command: 'powershell -c calc' })).toThrow('打开参数无效');
    expect(() => current.invoke('execute', { planId: 'x', approved: true, executable: 'C:/evil.exe' })).toThrow('打开参数无效');
    expect(() => current.invoke('auto', { enabled: true, shell: 'cmd' })).toThrow('打开参数无效');
  });

  it('默认确认模式下不会自动执行，必须本人确认', async () => {
    const current = bridgeFixture();
    const parsed = await current.invoke('parse', { goal: '打开计算器', consent: true });
    expect(parsed).toMatchObject({ ok: true, kind: 'plan', plan: { appId: 'calculator', requiresConfirmation: true, autoExecutable: false } });
    const denied = await current.invoke('execute', { planId: parsed.plan.planId, approved: false });
    expect(denied).toMatchObject({ ok: true, result: { success: false, errorCode: 'AUTO_EXECUTE_DENIED' } });
    expect(current.launcher.launch).not.toHaveBeenCalled();
    const approved = await current.invoke('execute', { planId: parsed.plan.planId, approved: true });
    expect(approved).toMatchObject({ ok: true, result: { success: true, appId: 'calculator', target: 'default', errorCode: null } });
    expect(current.launcher.launch).toHaveBeenCalledOnce();
  });

  it('未勾选发送确认时不解析，也不调用模型', async () => {
    const current = bridgeFixture();
    await expect(current.invoke('parse', { goal: '打开计算器', consent: false })).resolves.toMatchObject({ ok: false, code: 'PARAMETERS_INVALID' });
    expect(current.intent.parse).not.toHaveBeenCalled();
  });

  it('自动执行默认关闭；开启后首次仍需确认，确认过才免确认；关闭后不再自动启动', async () => {
    const current = bridgeFixture({ results: [plan(), plan(), plan()] });
    expect((await current.invoke('status', {})).autoExecute).toBe(false);
    expect(await current.invoke('auto', { enabled: true })).toMatchObject({ ok: true, autoExecute: true });

    const first = await current.invoke('parse', { goal: '打开计算器', consent: true });
    expect(first.plan.requiresConfirmation).toBe(true);
    await current.invoke('execute', { planId: first.plan.planId, approved: false });
    expect(current.launcher.launch).not.toHaveBeenCalled();
    await current.invoke('execute', { planId: first.plan.planId, approved: true });
    expect(current.launcher.launch).toHaveBeenCalledTimes(1);

    const second = await current.invoke('parse', { goal: '打开计算器', consent: true });
    expect(second.plan).toMatchObject({ requiresConfirmation: false, autoExecutable: true });
    await expect(current.invoke('execute', { planId: second.plan.planId, approved: false }))
      .resolves.toMatchObject({ ok: true, result: { success: true } });
    expect(current.launcher.launch).toHaveBeenCalledTimes(2);

    expect(await current.invoke('auto', { enabled: false })).toMatchObject({ ok: true, autoExecute: false });
    const third = await current.invoke('parse', { goal: '打开计算器', consent: true });
    await expect(current.invoke('execute', { planId: third.plan.planId, approved: false }))
      .resolves.toMatchObject({ ok: true, result: { success: false, errorCode: 'AUTO_EXECUTE_DENIED' } });
    expect(current.launcher.launch).toHaveBeenCalledTimes(2);
  });

  it('高风险目标即使开启自动执行、且已确认过也仍需确认', async () => {
    const confirmPlan = { ok: true, kind: 'plan', plan: { appId: 'browser', appName: '浏览器', target: 'url',
      targetDescription: '指定网页', risk: 'confirm', parameters: { url: 'https://www.example.com' }, requiresFolder: false,
      requiresConfirmation: true, reason: '打开网页' } };
    const current = bridgeFixture({ results: [confirmPlan, confirmPlan] });
    await current.invoke('auto', { enabled: true });
    const first = await current.invoke('parse', { goal: '打开浏览器看新闻', consent: true });
    await current.invoke('execute', { planId: first.plan.planId, approved: true });
    expect(current.launcher.launch).toHaveBeenCalledTimes(1);
    const second = await current.invoke('parse', { goal: '再打开一次网页', consent: true });
    expect(second.plan).toMatchObject({ risk: 'confirm', requiresConfirmation: true, autoExecutable: false });
    await expect(current.invoke('execute', { planId: second.plan.planId, approved: false }))
      .resolves.toMatchObject({ ok: true, result: { success: false, errorCode: 'AUTO_EXECUTE_DENIED' } });
    expect(current.launcher.launch).toHaveBeenCalledTimes(1);
  });

  it('启动失败与缺少可执行文件都如实返回错误码并记录', async () => {
    const failing = fakeLauncher();
    failing.launch.mockResolvedValueOnce({ success: false, appId: 'calculator', target: 'default', message: '启动请求发送失败，请稍后手动重试。', errorCode: 'LAUNCH_FAILED' });
    const current = bridgeFixture({ launcher: failing });
    const parsed = await current.invoke('parse', { goal: '打开计算器', consent: true });
    await expect(current.invoke('execute', { planId: parsed.plan.planId, approved: true }))
      .resolves.toMatchObject({ ok: true, result: { success: false, errorCode: 'LAUNCH_FAILED' } });
    expect(current.history.entries.at(-1)).toMatchObject({ appId: 'calculator', target: 'default', success: false, errorCode: 'LAUNCH_FAILED' });

    const missing = fakeLauncher();
    missing.resolveExecutable.mockReturnValue(undefined as unknown as string);
    const second = bridgeFixture({ launcher: missing });
    const planTwo = await second.invoke('parse', { goal: '打开微信', consent: true });
    await expect(second.invoke('execute', { planId: planTwo.plan.planId, approved: true }))
      .resolves.toMatchObject({ ok: true, result: { success: false, errorCode: 'EXECUTABLE_MISSING' } });
    expect(second.launcher.launch).not.toHaveBeenCalled();
  });

  it('目录目标必须由本人在本机选择，模型给的路径系统不使用', async () => {
    const folderPlan = { ok: true, kind: 'plan', plan: { appId: 'explorer', appName: '文件资源管理器', target: 'folder',
      targetDescription: '指定文件夹', risk: 'confirm', parameters: {}, requiresFolder: true, requiresConfirmation: true, reason: '打开文件夹' } };
    const current = bridgeFixture({ results: [folderPlan], pickFolder: async () => 'C:/Users/33864/Documents/demo' });
    const parsed = await current.invoke('parse', { goal: '打开文档文件夹', consent: true });
    expect(parsed.plan).toMatchObject({ requiresFolder: true, requiresConfirmation: true, parameters: {} });
    await expect(current.invoke('execute', { planId: parsed.plan.planId, approved: true }))
      .resolves.toMatchObject({ ok: false, code: 'FOLDER_MISSING' });
    const picked = await current.invoke('pick-folder', {});
    expect(picked).toMatchObject({ ok: true, path: 'C:/Users/33864/Documents/demo' });
    await expect(current.invoke('execute', { planId: parsed.plan.planId, approved: true }))
      .resolves.toMatchObject({ ok: true, result: { success: true } });
    expect(current.launcher.launch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'folder', args: ['C:/Users/33864/Documents/demo'] }));
    expect(current.launcher.launch).toHaveBeenCalledWith(expect.not.objectContaining({ command: expect.anything() }));
  });

  it('目录选择被取消时明确取消，不记录也不启动', async () => {
    const folderPlan = { ok: true, kind: 'plan', plan: { appId: 'explorer', appName: '文件资源管理器', target: 'folder',
      targetDescription: '指定文件夹', risk: 'confirm', parameters: {}, requiresFolder: true, requiresConfirmation: true, reason: '打开文件夹' } };
    const current = bridgeFixture({ results: [folderPlan], pickFolder: async () => undefined });
    await current.invoke('parse', { goal: '打开文件夹', consent: true });
    await expect(current.invoke('pick-folder', {})).resolves.toMatchObject({ ok: false, code: 'CANCELLED' });
    expect(current.launcher.launch).not.toHaveBeenCalled();
    expect(current.history.entries).toHaveLength(0);
  });

  it('停止会作废待确认计划，过期计划不能执行', async () => {
    let now = 1_000;
    const current = bridgeFixture({ results: [plan(), plan()], now: () => now });
    const parsed = await current.invoke('parse', { goal: '打开计算器', consent: true });
    expect(current.invoke('cancel', {})).toMatchObject({ ok: true });
    await expect(current.invoke('execute', { planId: parsed.plan.planId, approved: true })).resolves.toMatchObject({ ok: false, code: 'PLAN_UNKNOWN' });

    const second = await current.invoke('parse', { goal: '打开计算器', consent: true });
    now += 61_000;
    await expect(current.invoke('execute', { planId: second.plan.planId, approved: true })).resolves.toMatchObject({ ok: false, code: 'PLAN_EXPIRED' });
    expect(current.launcher.launch).not.toHaveBeenCalled();
  });

  it('最近记录只保存时间、appId、target 与结果，不含目标原文', async () => {
    const { createAppLauncherHistory } = require('../../apps/desktop/app-launcher-history.cjs');
    const filePath = `${require('node:os').tmpdir()}/nuanban-launcher-history-${require('node:crypto').randomUUID()}.json`;
    const history = createAppLauncherHistory({ filePath, now: () => 1_700_000_000_000 });
    const current = bridgeFixture({ history });
    const parsed = await current.invoke('parse', { goal: '打开计算器', consent: true });
    await current.invoke('execute', { planId: parsed.plan.planId, approved: true });
    const listed = await current.invoke('history', {});
    expect(listed.entries).toHaveLength(1);
    expect(Object.keys(listed.entries[0]).sort()).toEqual(['appId', 'at', 'errorCode', 'success', 'target']);
    expect(listed.entries[0]).toMatchObject({ at: 1_700_000_000_000, appId: 'calculator', target: 'default', success: true, errorCode: null });
    const raw = require('node:fs').readFileSync(filePath, 'utf8');
    expect(raw).not.toContain('打开计算器');
    expect(JSON.parse(raw)[0]).toEqual({ at: 1_700_000_000_000, appId: 'calculator', target: 'default', success: true, errorCode: null });
    require('node:fs').rmSync(filePath, { force: true });
  });

  it('状态返回注册表目录与模型可用性，页面可按目录渲染', async () => {
    const current = bridgeFixture();
    const status = await current.invoke('status', {});
    expect(status).toMatchObject({ ok: true, modelReady: true, autoExecute: false });
    expect(status.catalog.map((app: { appId: string }) => app.appId)).toEqual(['calculator', 'explorer', 'browser', 'wechat']);
  });

  it('询问与不支持都不会产生计划，取消不留痕', async () => {
    const current = bridgeFixture({ results: [{ ok: true, kind: 'clarify', question: '你想打开哪个软件？' },
      { ok: true, kind: 'unsupported', message: '暂不支持该软件。' }, { ok: true, kind: 'cancel' }] });
    await expect(current.invoke('parse', { goal: '打开那个', consent: true })).resolves.toMatchObject({ ok: true, kind: 'clarify' });
    await expect(current.invoke('parse', { goal: '打开某个软件', consent: true })).resolves.toMatchObject({ ok: true, kind: 'unsupported' });
    await expect(current.invoke('parse', { goal: '算了', consent: true })).resolves.toMatchObject({ ok: true, kind: 'cancel' });
    expect(current.launcher.launch).not.toHaveBeenCalled();
    expect(current.controller.snapshot().plans).toBe(0);
  });

  it('控制器源码与桥接不引入任何 Shell 执行能力', () => {
    const source = require('node:fs').readFileSync(new URL('../../apps/desktop/app-launcher-bridge.cjs', import.meta.url), 'utf8');
    expect(source).not.toContain('child_process');
    expect(source).not.toContain('execSync');
    expect(source).not.toContain('shell:');
    expect(createAppLauncherController).toBeTypeOf('function');
  });
});