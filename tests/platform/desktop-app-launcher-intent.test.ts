import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createAppLauncherIntent } = require('../../apps/desktop/app-launcher-intent.cjs');

// 合成注册表：与冻结契约同形，避免依赖 core 队友的实现，测试可独立运行。
function fakeRegistry() {
  const apps: Record<string, { displayName: string; unsupported?: string[]; targets: Record<string, Record<string, unknown>> }> = {
    calculator: { displayName: '计算器', targets: { default: { description: '计算器主界面', risk: 'low' } } },
    notepad: { displayName: '记事本', targets: { default: { description: '记事本主界面', risk: 'low' } } },
    explorer: { displayName: '文件资源管理器', targets: {
      default: { description: '文件资源管理器主界面', risk: 'low' },
      folder: { description: '指定文件夹', risk: 'confirm', requiresFolder: true } } },
    browser: { displayName: '浏览器', targets: {
      default: { description: '浏览器首页', risk: 'low' },
      url: { description: '指定网页', risk: 'confirm', requiresUrl: true } } },
    vscode: { displayName: 'Visual Studio Code', targets: {
      default: { description: 'VS Code 主界面', risk: 'low' },
      folder: { description: '指定项目文件夹', risk: 'confirm', requiresFolder: true } } },
    wechat: { displayName: '微信', unsupported: ['settings', 'chat', 'moments'], targets: { default: { description: '微信主界面', risk: 'low' } } },
  };
  return {
    catalog: () => Object.entries(apps).map(([appId, app]) => ({ appId, displayName: app.displayName,
      unsupportedTargets: app.unsupported ?? [],
      targets: Object.entries(app.targets).map(([target, value]) => ({ target, ...value })) })),
    resolve(appId: string, target: string) {
      const app = apps[appId];
      if (!app) return { ok: false, errorCode: 'APP_UNKNOWN' };
      const entry = app.targets[target];
      if (!entry) {
        if ((app.unsupported ?? []).includes(target)) return { ok: false, errorCode: 'TARGET_UNSUPPORTED', message: '该软件暂不支持直接打开这个界面，只能打开主界面。' };
        return { ok: false, errorCode: 'TARGET_UNKNOWN' };
      }
      return { ok: true, appId, target, displayName: app.displayName, targetDescription: String(entry.description),
        risk: String(entry.risk), requiresFolder: entry.requiresFolder === true, requiresUrl: entry.requiresUrl === true };
    },
    validateParameters(appId: string, target: string, parameters: Record<string, unknown>, { folderAllowlist = [] as string[] } = {}) {
      const resolved = this.resolve(appId, target);
      if (!resolved.ok) return resolved;
      if (resolved.requiresUrl) {
        const url = String(parameters.url ?? '');
        if (!/^https?:\/\//u.test(url)) return { ok: false, errorCode: 'URL_PROTOCOL_BLOCKED' };
        return { ok: true, parameters: { url } };
      }
      if (resolved.requiresFolder) {
        const folder = String(parameters.folder ?? '');
        if (!folderAllowlist.includes(folder)) return { ok: false, errorCode: 'FOLDER_NOT_ALLOWED' };
        return { ok: true, parameters: { folder } };
      }
      return { ok: true, parameters: {} };
    },
    executableCandidates: () => ['C:/fake/calc.exe'],
  };
}

function providerWith(text: string) {
  return { status: () => ({ available: true }), answer: vi.fn(async () => ({ text })) };
}

const json = (value: unknown) => JSON.stringify(value);

describe('智能打开软件的模型意图解析（合成模型，不调用真实网关）', () => {
  it('自然语言目标被解析成合法结构化计划，并使用注册表元数据', async () => {
    const provider = providerWith(json({ action: 'open_app', appId: 'calculator', appName: '计算器', target: 'default',
      targetDescription: '计算器主界面', parameters: {}, confidence: 0.95, needsConfirmation: true, reason: '用户想打开计算器' }));
    const intent = createAppLauncherIntent({ provider, registry: fakeRegistry() });
    expect(intent.available()).toBe(true);
    const result = await intent.parse('打开计算器');
    expect(result).toMatchObject({ ok: true, kind: 'plan', plan: { appId: 'calculator', appName: '计算器',
      target: 'default', targetDescription: '计算器主界面', risk: 'low', parameters: {} } });
    expect(result.plan.planId).toMatch(/^[a-f0-9-]{36}$/u);
  });

  it('低风险目标在高置信度下可标记为免确认', async () => {
    const provider = providerWith(json({ action: 'open_app', appId: 'notepad', appName: '记事本', target: 'default',
      targetDescription: '记事本主界面', parameters: {}, confidence: 0.93, needsConfirmation: false, reason: '打开记事本' }));
    const result = await createAppLauncherIntent({ provider, registry: fakeRegistry() }).parse('打开记事本');
    expect(result).toMatchObject({ ok: true, kind: 'plan', plan: { requiresConfirmation: false, risk: 'low' } });
  });

  it('模型返回 Shell、命令或可执行路径时被拒绝', async () => {
    const samples = [
      json({ action: 'open_app', appId: 'calculator', target: 'default', parameters: { command: 'powershell -c start calc' } }),
      '{"action":"open_app","appId":"calculator","target":"default","parameters":{"path":"C:\\\\Windows\\\\System32\\\\calc.exe"}}',
      'run: cmd /c start calc',
      '```json\n{"action":"open_app","appId":"calculator","target":"default","parameters":{"cmd":"node evil.js"}}\n```',
    ];
    for (const text of samples) {
      const result = await createAppLauncherIntent({ provider: providerWith(text), registry: fakeRegistry() }).parse('打开计算器');
      expect(result).toMatchObject({ ok: false });
      expect(['UNSAFE_MODEL_OUTPUT', 'MODEL_INVALID_JSON', 'PARAMETERS_FORBIDDEN', 'PARAMETERS_INVALID']).toContain(result.errorCode);
    }
  });

  it('未登记的软件与未登记的界面被拒绝，声明但不支持的界面给出诚实提示', async () => {
    const intent = (text: string) => createAppLauncherIntent({ provider: providerWith(text), registry: fakeRegistry() });
    await expect(intent(json({ action: 'open_app', appId: 'registry-editor', target: 'default' })).parse('打开注册表编辑器'))
      .resolves.toMatchObject({ ok: false, errorCode: 'APP_UNKNOWN' });
    await expect(intent(json({ action: 'open_app', appId: 'calculator', target: 'admin' })).parse('打开计算器的管理员模式'))
      .resolves.toMatchObject({ ok: false, errorCode: 'TARGET_UNKNOWN' });
    await expect(intent(json({ action: 'open_app', appId: 'wechat', target: 'settings' })).parse('打开微信设置'))
      .resolves.toMatchObject({ ok: true, kind: 'unsupported' });
  });

  it('危险协议与任意路径参数被拒绝，网址只允许 http/https', async () => {
    const intent = (text: string) => createAppLauncherIntent({ provider: providerWith(text), registry: fakeRegistry() });
    const blockedFileUrl = await intent(json({ action: 'open_app', appId: 'browser', target: 'url', parameters: { url: 'file:///C:/Windows/System32/calc.exe' } }))
      .parse('用浏览器打开这个文件');
    expect(blockedFileUrl).toMatchObject({ ok: false });
    expect(['UNSAFE_MODEL_OUTPUT', 'URL_PROTOCOL_BLOCKED']).toContain(blockedFileUrl.errorCode);
    await expect(intent(json({ action: 'open_app', appId: 'browser', target: 'url', parameters: { url: 'file:///C:/Windows/win.ini' } }))
      .parse('用浏览器打开这个文件')).resolves.toMatchObject({ ok: false, errorCode: 'URL_PROTOCOL_BLOCKED' });
    await expect(intent(json({ action: 'open_app', appId: 'browser', target: 'url', parameters: { url: 'javascript:alert(1)' } }))
      .parse('打开这个脚本')).resolves.toMatchObject({ ok: false, errorCode: 'URL_PROTOCOL_BLOCKED' });
    const modelPath = await intent(json({ action: 'open_app', appId: 'vscode', target: 'folder', parameters: { folder: 'C:/Windows' } }))
      .parse('打开这个项目');
    expect(modelPath).toMatchObject({ ok: false });
    expect(['UNSAFE_MODEL_OUTPUT', 'PARAMETERS_FORBIDDEN']).toContain(modelPath.errorCode);
    await expect(intent(json({ action: 'open_app', appId: 'vscode', target: 'folder', parameters: { folder: '../../Windows' } }))
      .parse('打开这个项目')).resolves.toMatchObject({ ok: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    await expect(intent(json({ action: 'open_app', appId: 'calculator', target: 'default', parameters: { extra: 'x' } }))
      .parse('打开计算器')).resolves.toMatchObject({ ok: false, errorCode: 'PARAMETERS_FORBIDDEN' });
    const allowed = await intent(json({ action: 'open_app', appId: 'browser', target: 'url', parameters: { url: 'https://www.example.com/news' }, confidence: 0.9 }))
      .parse('打开浏览器看新闻');
    expect(allowed).toMatchObject({ ok: true, kind: 'plan', plan: { target: 'url', parameters: { url: 'https://www.example.com/news' } } });
  });

  it('目标不明确时必须追问，不猜软件也不执行', async () => {
    const provider = providerWith(json({ action: 'ask_clarification', question: '你想打开哪个软件？例如计算器、记事本或浏览器。', confidence: 0.4 }));
    const result = await createAppLauncherIntent({ provider, registry: fakeRegistry() }).parse('帮我打开那个东西');
    expect(result).toMatchObject({ ok: true, kind: 'clarify' });
    expect(result.question).toContain('哪个软件');
  });

  it('取消意图与不支持意图都不产生计划', async () => {
    await expect(createAppLauncherIntent({ provider: providerWith(json({ action: 'cancel', reason: '用户改主意了' })), registry: fakeRegistry() })
      .parse('算了不打开了')).resolves.toMatchObject({ ok: true, kind: 'cancel' });
    await expect(createAppLauncherIntent({ provider: providerWith(json({ action: 'unsupported', reason: '暂不支持该软件' })), registry: fakeRegistry() })
      .parse('帮我打开某个不存在的东西')).resolves.toMatchObject({ ok: true, kind: 'unsupported' });
  });

  it('模型未配置或返回非 JSON 时明确失败，不回退猜测', async () => {
    const unavailable = createAppLauncherIntent({ provider: { status: () => ({ available: false }), answer: vi.fn() }, registry: fakeRegistry() });
    expect(unavailable.available()).toBe(false);
    await expect(unavailable.parse('打开计算器')).resolves.toMatchObject({ ok: false, errorCode: 'MODEL_UNAVAILABLE' });
    await expect(createAppLauncherIntent({ provider: providerWith('好的，我这就帮你打开计算器。'), registry: fakeRegistry() })
      .parse('打开计算器')).resolves.toMatchObject({ ok: false, errorCode: 'MODEL_INVALID_JSON' });
  });

  it('提示词包含注册表目录并明确禁止命令与脚本', () => {
    const intent = createAppLauncherIntent({ provider: providerWith('{}'), registry: fakeRegistry() });
    const instructions = intent.instructions();
    expect(instructions).toContain('calculator = 计算器');
    expect(instructions).toContain('禁止输出任何命令、脚本');
    expect(instructions).toContain('settings');
  });
});