const { randomUUID } = require('node:crypto');

// 受信 IPC：只有桌宠自己的页面能调用；主进程负责注册表校验、确认/自动执行判定与启动。
// 本模块不接受 Shell 字符串、任意路径、任意 URL 或任意参数。
const messages = Object.freeze({
  APP_UNKNOWN: '暂不支持打开该软件：它不在本机可打开的软件登记表中。',
  TARGET_UNKNOWN: '该软件没有登记这个界面，已拒绝打开。',
  TARGET_UNSUPPORTED: '该软件暂不支持直接打开这个界面，只能打开主界面。',
  PARAMETERS_INVALID: '参数不符合要求，已拒绝。',
  PARAMETERS_FORBIDDEN: '这个参数不被允许，已拒绝。',
  URL_PROTOCOL_BLOCKED: '只能打开 http 或 https 网页地址。',
  URL_INVALID: '该网址未通过安全校验，已拒绝。',
  FOLDER_NOT_ALLOWED: '该文件夹不允许打开：它可能不存在、不是目录，或属于系统敏感位置。',
  FOLDER_MISSING: '请先选择要打开的文件夹。',
  MODEL_UNAVAILABLE: '智能解析需要本机已配置模型；未配置时不会猜测或执行任何打开操作。',
  MODEL_INVALID_JSON: '模型没有返回可用的 JSON 指令，已拒绝执行。',
  UNSAFE_MODEL_OUTPUT: '模型返回了命令或脚本内容，已拒绝执行。',
  EXECUTABLE_MISSING: '未找到可用启动方式，本机可能尚未安装该软件。',
  LAUNCH_FAILED: '启动请求发送失败，请稍后手动重试。',
  CANCELLED: '已取消。',
  PLAN_EXPIRED: '这次打开请求已过期，请重新说一遍。',
  PLAN_UNKNOWN: '没有找到待执行的打开请求，请重新解析。',
  AUTO_EXECUTE_DENIED: '需要你确认后才会打开。',
});

function messageFor(code) {
  return messages[code] ?? '操作未完成，请稍后手动重试。';
}

function failure(code, message) {
  return { ok: false, code: Object.hasOwn(messages, code) ? code : 'LAUNCH_FAILED', message: message ?? messageFor(code) };
}

function payloadOnly(payload, fields) {
  return Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload)
    && Object.keys(payload).length === fields.length && fields.every(field => Object.hasOwn(payload, field));
}

function createAppLauncherController({ registry, launcher, intent, history, inventory, pickFolder, now = Date.now,
  planTtlMs = 60_000, maxPlans = 8 } = {}) {
  if (!registry || !launcher || !intent || !history) throw new TypeError('打开软件控制器缺少依赖');
  const plans = new Map();
  const confirmed = new Set();
  const folderAllowlist = [];
  let autoExecute = false;
  let generation = 0;
  let controller = null;

  const planKey = plan => `${plan.appId}:${plan.target}`;

  function prune() {
    const current = now();
    for (const [planId, entry] of plans) {
      if (entry.used || current - entry.createdAt > planTtlMs) plans.delete(planId);
    }
    while (plans.size >= maxPlans) {
      const oldest = [...plans.entries()].sort((first, second) => first[1].createdAt - second[1].createdAt)[0];
      if (!oldest) break;
      plans.delete(oldest[0]);
    }
  }

  function confirmationRequired(plan) {
    if (plan.requiresFolder && !plan.parameters.folder) return true;
    if (plan.risk !== 'low') return true;
    return !(autoExecute && confirmed.has(planKey(plan)));
  }

  function planView(plan, planId) {
    const requiresConfirmation = confirmationRequired(plan);
    return { planId, appId: plan.appId, appName: plan.appName, target: plan.target,
      targetDescription: plan.targetDescription, risk: plan.risk, parameters: { ...plan.parameters },
      requiresFolder: plan.requiresFolder === true, requiresConfirmation,
      autoExecutable: !requiresConfirmation, reason: plan.reason ?? '' };
  }

  function cancel() {
    generation += 1;
    controller?.abort();
    controller = null;
    for (const entry of plans.values()) entry.used = true;
    plans.clear();
    return { ok: true, message: '已停止，不会打开任何软件。' };
  }

  async function parse({ goal, consent } = {}) {
    if (consent !== true) return failure('PARAMETERS_INVALID', '请先勾选本次发送确认，暖暖才会把你的目标发给模型。');
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 300) return failure('PARAMETERS_INVALID', '请输入 1 至 300 字的目标，例如“打开计算器”。');
    generation += 1;
    const currentGeneration = generation;
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    let result;
    try {
      const candidates = typeof inventory?.match === 'function' ? inventory.match(goal.trim()) : [];
      result = await intent.parse(goal.trim(), { signal: requestController.signal, candidates });
    } catch {
      result = { ok: false, errorCode: 'LAUNCH_FAILED', message: messageFor('LAUNCH_FAILED') };
    } finally {
      if (controller === requestController) controller = null;
    }
    if (currentGeneration !== generation) return failure('CANCELLED');
    if (!result?.ok) return failure(result?.errorCode ?? 'LAUNCH_FAILED', result?.message);
    if (result.kind === 'clarify') return { ok: true, kind: 'clarify', question: result.question };
    if (result.kind === 'unsupported') return { ok: true, kind: 'unsupported', message: result.message };
    if (result.kind === 'cancel') return { ok: true, kind: 'cancel', message: '已取消，不会打开任何软件。' };
    prune();
    const planId = randomUUID();
    const plan = { ...result.plan, planId, parameters: { ...result.plan.parameters } };
    plans.set(planId, { plan, createdAt: now(), used: false });
    return { ok: true, kind: 'plan', plan: planView(plan, planId) };
  }

  async function execute({ planId, approved } = {}) {
    if (typeof planId !== 'string' || !planId || planId.length > 64) return failure('PLAN_UNKNOWN');
    const entry = plans.get(planId);
    if (!entry) return failure('PLAN_UNKNOWN');
    if (entry.used) return failure('PLAN_UNKNOWN');
    if (now() - entry.createdAt > planTtlMs) { entry.used = true; plans.delete(planId); return failure('PLAN_EXPIRED'); }
    const plan = entry.plan;
    if (plan.requiresFolder && !plan.parameters.folder) return failure('FOLDER_MISSING');
    const requiresConfirmation = confirmationRequired(plan);
    if (requiresConfirmation && approved !== true) {
      return { ok: true, result: { success: false, appId: plan.appId, target: plan.target,
        message: messageFor('AUTO_EXECUTE_DENIED'), errorCode: 'AUTO_EXECUTE_DENIED' } };
    }
    entry.used = true;
    plans.delete(planId);
    const resolved = registry.resolve(plan.appId, plan.target);
    if (!resolved.ok) {
      history.record({ appId: plan.appId, target: plan.target, success: false, errorCode: resolved.errorCode });
      return { ok: true, result: { success: false, appId: plan.appId, target: plan.target,
        message: resolved.message ?? messageFor(resolved.errorCode), errorCode: resolved.errorCode } };
    }
    const parameters = registry.validateParameters(resolved.appId, resolved.target, plan.parameters, { folderAllowlist });
    if (!parameters.ok) {
      history.record({ appId: resolved.appId, target: resolved.target, success: false, errorCode: parameters.errorCode });
      return { ok: true, result: { success: false, appId: resolved.appId, target: resolved.target,
        message: parameters.message ?? messageFor(parameters.errorCode), errorCode: parameters.errorCode } };
    }
    const kind = resolved.dynamic === true ? 'shortcut' : resolved.requiresUrl ? 'url' : resolved.requiresFolder ? 'folder' : 'exe';
    const spec = { appId: resolved.appId, target: resolved.target, displayName: resolved.displayName, kind,
      ...(kind === 'url' ? { url: parameters.parameters.url } : {}),
      ...(kind === 'folder' ? { folder: parameters.parameters.folder } : {}) };
    if (kind === 'shortcut') {
      // 动态清单项：真实路径只在本机主进程内部使用，绝不返回给页面或模型。
      const dynamic = typeof registry.dynamicLaunch === 'function' ? registry.dynamicLaunch(resolved.appId) : { ok: false, errorCode: 'EXECUTABLE_MISSING' };
      if (!dynamic?.ok) {
        const result = { success: false, appId: resolved.appId, target: resolved.target,
          message: `未找到可用启动方式，本机可能尚未安装${resolved.displayName}。`, errorCode: dynamic?.errorCode ?? 'EXECUTABLE_MISSING' };
        history.record({ appId: resolved.appId, target: resolved.target, success: false, errorCode: result.errorCode });
        return { ok: true, result };
      }
      spec.shortcut = dynamic.target;
    } else if (kind === 'exe') {
      const executable = launcher.resolveExecutable(resolved.appId, registry.executableCandidates(resolved.appId));
      if (!executable) {
        const result = { success: false, appId: resolved.appId, target: resolved.target,
          message: `未找到可用启动方式，本机可能尚未安装${resolved.displayName}。`, errorCode: 'EXECUTABLE_MISSING' };
        history.record({ appId: resolved.appId, target: resolved.target, success: false, errorCode: result.errorCode });
        return { ok: true, result };
      }
      spec.executable = executable;
      spec.args = [];
    } else if (kind === 'folder') {
      const executable = launcher.resolveExecutable(resolved.appId, registry.executableCandidates(resolved.appId));
      if (!executable) {
        const result = { success: false, appId: resolved.appId, target: resolved.target,
          message: `未找到可用启动方式，本机可能尚未安装${resolved.displayName}。`, errorCode: 'EXECUTABLE_MISSING' };
        history.record({ appId: resolved.appId, target: resolved.target, success: false, errorCode: result.errorCode });
        return { ok: true, result };
      }
      spec.executable = executable;
      spec.args = [parameters.parameters.folder];
    }
    let result;
    try {
      result = await launcher.launch(spec);
    } catch {
      result = { success: false, appId: resolved.appId, target: resolved.target,
        message: messageFor('LAUNCH_FAILED'), errorCode: 'LAUNCH_FAILED' };
    }
    const projected = { success: result?.success === true, appId: resolved.appId, target: resolved.target,
      message: typeof result?.message === 'string' && result.message ? result.message : messageFor(result?.errorCode ?? 'LAUNCH_FAILED'),
      errorCode: result?.success === true ? null : (result?.errorCode ?? 'LAUNCH_FAILED') };
    history.record({ appId: projected.appId, target: projected.target, success: projected.success, errorCode: projected.errorCode });
    if (projected.success) confirmed.add(planKey(plan));
    return { ok: true, result: projected };
  }

  async function chooseFolder() {
    const pending = [...plans.values()].filter(entry => !entry.used && entry.plan.requiresFolder && !entry.plan.parameters.folder)
      .sort((first, second) => second.createdAt - first.createdAt)[0];
    if (!pending) return failure('PLAN_UNKNOWN', '请先说明要打开哪个软件的文件夹，例如“打开 VS Code 的项目”。');
    let picked;
    try { picked = await pickFolder(); } catch { picked = undefined; }
    if (typeof picked !== 'string' || !picked) return failure('CANCELLED', '已取消选择文件夹，未打开任何软件。');
    const checked = registry.validateParameters(pending.plan.appId, pending.plan.target, { folder: picked },
      { folderAllowlist: [...folderAllowlist, picked] });
    if (!checked.ok) return failure(checked.errorCode, checked.message);
    folderAllowlist.push(picked);
    pending.plan.parameters.folder = checked.parameters.folder;
    const planId = [...plans.entries()].find(([, entry]) => entry === pending)?.[0];
    return { ok: true, path: checked.parameters.folder, display: checked.parameters.folder,
      plan: planId ? planView(pending.plan, planId) : null };
  }

  function status() {
    let modelReady = false;
    try { modelReady = intent.available() === true; } catch { modelReady = false; }
    let inventoryTotal = 0;
    try { inventoryTotal = typeof inventory?.total === 'function' ? Math.max(0, Number(inventory.total()) || 0) : 0; } catch { inventoryTotal = 0; }
    return { ok: true, modelReady, autoExecute, inventoryTotal, catalog: registry.catalog() };
  }

  // 本机已发现的可打开项：只回 id 与显示名，不回真实路径。
  function inventoryList() {
    let entries = [];
    let total = 0;
    try {
      const catalog = typeof inventory?.catalog === 'function' ? inventory.catalog() : [];
      total = typeof inventory?.total === 'function' ? Math.max(0, Number(inventory.total()) || 0) : catalog.length;
      entries = (Array.isArray(catalog) ? catalog : []).slice(0, 400)
        .filter(entry => entry && typeof entry.id === 'string' && typeof entry.displayName === 'string')
        .map(entry => ({ id: entry.id, displayName: entry.displayName }));
    } catch { entries = []; total = 0; }
    return { ok: true, total, entries };
  }

  // 本人从列表里直接选一个：不调用模型，直接生成计划，仍然要确认。
  function pickFromInventory({ id } = {}) {
    if (typeof id !== 'string' || !id || id.length > 64) return failure('APP_UNKNOWN', '请从本机列表里选择要打开的软件。');
    const resolved = registry.resolve(id, 'default');
    if (!resolved.ok) return failure(resolved.errorCode, resolved.message);
    prune();
    const plan = { appId: resolved.appId, appName: resolved.displayName, target: 'default',
      targetDescription: resolved.targetDescription, risk: resolved.risk, dynamic: resolved.dynamic === true,
      parameters: {}, requiresFolder: resolved.requiresFolder === true,
      reason: `本人从本机列表选择了${resolved.displayName}` };
    const planId = randomUUID();
    plans.set(planId, { plan, createdAt: now(), used: false });
    return { ok: true, kind: 'plan', plan: planView(plan, planId) };
  }

  function setAutoExecute(enabled) {
    if (typeof enabled !== 'boolean') return failure('PARAMETERS_INVALID', '自动执行开关必须是布尔值。');
    autoExecute = enabled;
    return { ok: true, autoExecute, message: enabled
      ? '已开启自动执行：只有低风险、且本会话确认过一次的目标会免确认；高风险仍需你确认。'
      : '已关闭自动执行：每次打开软件都需要你确认。' };
  }

  function listHistory() {
    return { ok: true, entries: history.list() };
  }

  return Object.freeze({ cancel, parse, execute, chooseFolder, status, setAutoExecute, listHistory, inventoryList, pickFromInventory,
    confirmationRequired, planKey, snapshot: () => ({ autoExecute, plans: plans.size, confirmed: [...confirmed], folders: [...folderAllowlist] }) });
}

function registerAppLauncherBridge({ ipcMain, isTrusted, showPage, registry, launcher, intent, history, inventory, pickFolder,
  now = Date.now, planTtlMs = 60_000, maxPlans = 8 } = {}) {
  if (typeof ipcMain?.handle !== 'function' || typeof isTrusted !== 'function') throw new TypeError('打开软件桥接缺少可信来源校验');
  const controller = createAppLauncherController({ registry, launcher, intent, history, inventory, pickFolder, now, planTtlMs, maxPlans });
  const channels = [];
  let disposed = false;

  function handle(name, action, fields = []) {
    const channel = `nuanban:pet-open-app:${name}`;
    channels.push(channel);
    ipcMain.handle(channel, (event, payload) => {
      if (disposed || !isTrusted(event)) throw new Error('不可信打开来源');
      if (fields.length ? !payloadOnly(payload, fields) : !payloadOnly(payload ?? {}, [])) throw new Error('打开参数无效');
      return action(payload ?? {});
    });
  }

  handle('status', () => controller.status());
  handle('parse', payload => controller.parse(payload), ['goal', 'consent']);
  handle('execute', payload => controller.execute(payload), ['planId', 'approved']);
  handle('pick-folder', () => controller.chooseFolder());
  handle('cancel', () => controller.cancel());
  handle('history', () => controller.listHistory());
  handle('auto', payload => controller.setAutoExecute(payload.enabled), ['enabled']);
  handle('inventory', () => controller.inventoryList());
  handle('pick', payload => controller.pickFromInventory(payload), ['id']);
  handle('show', () => { if (typeof showPage === 'function') showPage(); return { ok: true }; });

  return Object.freeze({
    controller,
    show: () => { if (!disposed && typeof showPage === 'function') showPage(); },
    cancel: () => controller.cancel(),
    dispose: () => { disposed = true; controller.cancel(); for (const channel of channels.splice(0)) ipcMain.removeHandler(channel); },
  });
}

module.exports = { registerAppLauncherBridge, createAppLauncherController, messages, messageFor, payloadOnly };