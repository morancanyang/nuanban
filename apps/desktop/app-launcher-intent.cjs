const { randomUUID } = require('node:crypto');

// 把用户口语目标交给已配置模型，模型只能返回严格 JSON；本机再按注册表交叉校验，
// 拒绝任何命令、脚本、任意路径、任意 URL 与未登记软件/界面。
const allowedKeys = Object.freeze({
  open_app: new Set(['action', 'appId', 'appName', 'target', 'targetDescription', 'parameters', 'confidence', 'needsConfirmation', 'reason']),
  ask_clarification: new Set(['action', 'question', 'confidence']),
  unsupported: new Set(['action', 'appId', 'target', 'reason', 'confidence']),
  cancel: new Set(['action', 'reason', 'confidence']),
});
// 危险输出特征。盘符路径必须排除 URL 里的 “s:/”（https://），否则所有网址都会被误判。
const unsafePattern = /(?:powershell|pwsh|\bcmd(?:\.exe)?\b|\bstart\s+[A-Za-z]:|\bnode(?:\.exe)?\s|\bpython(?:\.exe)?\s|\.ps1\b|\.bat\b|\.cmd\b|\.vbs\b|\.exe\b|(?:^|[^\w:/])[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._-]+[\\/]|`|\$\(|&&|\|\||>\s*[A-Za-z]:|<\s*[A-Za-z]:)/iu;
const controls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u;

function cleanText(value, limit) {
  return typeof value === 'string' ? value.replace(controls, '').trim().slice(0, limit) : '';
}

function failure(errorCode, message) {
  return { ok: false, errorCode, message };
}

function createAppLauncherIntent({ provider, registry, timeoutMs = 30_000 } = {}) {
  function available() {
    try { return typeof provider?.answer === 'function' && provider.status?.()?.available === true; }
    catch { return false; }
  }

  function catalogLines() {
    return registry.catalog().map(app => {
      const targets = app.targets.map(target => `${target.target}（${target.description}${target.risk === 'confirm' ? '，需本人确认' : '，低风险'}${target.requiresFolder ? '，需本人先选文件夹' : ''}${target.requiresUrl ? '，需带 http/https 网址' : ''}）`).join('、');
      const blocked = (app.unsupportedTargets ?? []).join('、');
      return `- ${app.appId} = ${app.displayName}；可用 target：${targets}${blocked ? `；声明但不支持：${blocked}` : ''}`;
    }).join('\n');
  }

  function candidateLines(candidates) {
    const list = Array.isArray(candidates) ? candidates : [];
    if (!list.length) {
      return '本机开始菜单候选：无（本次没有本地匹配结果）。用户要打开别的软件时，先输出 ask_clarification 让本人换个说法或从桌宠的“从本机列表选择”里挑，不要编造 appId。\n';
    }
    return '本机开始菜单候选（只能逐字使用下面的 appId；这些软件只支持 target 为 default）：\n'
      + list.map(candidate => `- ${candidate.id} = ${candidate.displayName}`).join('\n') + '\n';
  }

  function buildInstructions(candidates) {
    return '你是桌宠“智能打开软件”的意图解析器，只负责把用户的话转成打开指令，不执行任何操作。'
      + '只输出一个 JSON 对象，不要 Markdown 代码块、解释或多余文字。禁止输出任何命令、脚本、Shell、PowerShell、CMD、批处理、可执行文件路径或系统调用；'
      + '禁止输出 file://、javascript:、data:、vbscript:；禁止编造未登记的软件、界面或 appId。\n'
      + '允许的 action：open_app、ask_clarification、unsupported、cancel。\n'
      + 'open_app 可以使用两类 id：下面是桌面已登记软件（可带 target）：\n' + catalogLines() + '\n'
      + candidateLines(candidates)
      + 'open_app 输出格式：{"action":"open_app","appId":"calculator","appName":"计算器","target":"default","targetDescription":"计算器主界面","parameters":{},"confidence":0.95,"needsConfirmation":true,"reason":"用户想打开计算器"}\n'
      + 'target 为 url 时 parameters 只允许 {"url":"https://…"}；target 为 folder 时 parameters 必须是空对象（文件夹由用户在本机选择，不接受模型给路径）；开始菜单候选的 target 只能是 default 且 parameters 必须为 {}。\n'
      + '目标不明确时输出：{"action":"ask_clarification","question":"你想打开哪个软件？可以从桌宠的“从本机列表选择”里挑一个，或换个说法。","confidence":0.4}\n'
      + '用户想打开的软件不在任何清单里时输出：{"action":"unsupported","reason":"…","confidence":0.9}\n'
      + '用户说要取消或不想打开时输出：{"action":"cancel","reason":"…","confidence":0.9}\n'
      + '不要因为用户提到“帮我操作一下”就编造内部页面；不确定就用 ask_clarification。';
  }

  const instructions = buildInstructions([]);

  function extractJson(text) {
    const trimmed = cleanText(text, 4000);
    if (!trimmed) return undefined;
    if (unsafePattern.test(trimmed)) return { unsafe: true };
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
    const candidate = fenced ? fenced[1] : trimmed;
    try { return { value: JSON.parse(candidate) }; } catch { return undefined; }
  }

  function validateOpenApp(payload) {
    const keys = Object.keys(payload);
    if (keys.some(key => !allowedKeys.open_app.has(key))) return failure('PARAMETERS_FORBIDDEN', '模型返回了不允许的字段，已拒绝。');
    const appId = cleanText(payload.appId, 40);
    const target = cleanText(payload.target, 40);
    const resolved = registry.resolve(appId, target);
    if (!resolved.ok) {
      if (resolved.errorCode === 'TARGET_UNSUPPORTED') {
        return { ok: true, kind: 'unsupported', message: resolved.message ?? '该软件暂不支持直接打开这个界面，可以改为打开主界面。' };
      }
      return failure(resolved.errorCode, resolved.errorCode === 'APP_UNKNOWN'
        ? `暂不支持打开“${cleanText(payload.appName, 40) || appId || '该软件'}”：它不在本机可打开的软件登记表中。`
        : '暂不支持打开该界面：它不在该软件的安全路由登记表中。');
    }
    const parameters = payload.parameters === undefined ? {} : payload.parameters;
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return failure('PARAMETERS_INVALID', '模型返回的参数格式无效，已拒绝。');
    const parameterKeys = Object.keys(parameters);
    if (parameterKeys.length) {
      if (resolved.requiresUrl) {
        if (parameterKeys.some(key => key !== 'url')) return failure('PARAMETERS_FORBIDDEN', '该界面只允许带一个网址参数。');
        const checked = registry.validateParameters(resolved.appId, resolved.target, { url: parameters.url }, { folderAllowlist: [] });
        if (!checked.ok) {
          return failure(checked.errorCode, checked.errorCode === 'URL_PROTOCOL_BLOCKED'
            ? '只能打开 http 或 https 网页地址，其他协议已被拒绝。'
            : '模型给出的网址未通过校验，已拒绝。');
        }
      } else if (resolved.requiresFolder) {
        // 文件夹必须由用户在本机选择，模型给的任何路径都拒绝。
        return failure('PARAMETERS_FORBIDDEN', '文件夹需要你在本机选择，模型给出的路径一律不使用。');
      } else {
        return failure('PARAMETERS_FORBIDDEN', '该界面不接受参数。');
      }
    }
    if (resolved.requiresFolder) {
      return { ok: true, kind: 'plan', plan: {
        planId: randomUUID(), appId: resolved.appId, appName: resolved.displayName, target: resolved.target,
        targetDescription: resolved.targetDescription, risk: resolved.risk, parameters: {}, requiresFolder: true,
        requiresConfirmation: true, reason: cleanText(payload.reason, 300) } };
    }
    if (resolved.requiresUrl && parameterKeys.length === 0) {
      return failure('PARAMETERS_INVALID', '打开网页需要给出具体网址，请补充要访问的网站。');
    }
    const confidence = Number.isFinite(payload.confidence) ? Math.min(1, Math.max(0, payload.confidence)) : 0;
    // 动态清单项（本机开始菜单发现的软件）：只开主界面，首次必须确认。
    if (resolved.dynamic === true) {
      if (parameterKeys.length) return failure('PARAMETERS_FORBIDDEN', '本机发现的软件只支持打开主界面，不接受参数。');
      if (resolved.target !== 'default') return failure('TARGET_UNKNOWN', '本机发现的软件只支持打开主界面。');
      return { ok: true, kind: 'plan', plan: {
        planId: randomUUID(), appId: resolved.appId, appName: resolved.displayName, target: 'default',
        targetDescription: resolved.targetDescription, risk: 'low', dynamic: true, parameters: {},
        requiresFolder: false, requiresConfirmation: true, reason: cleanText(payload.reason, 300) } };
    }
    return { ok: true, kind: 'plan', plan: {
      planId: randomUUID(), appId: resolved.appId, appName: resolved.displayName, target: resolved.target,
      targetDescription: resolved.targetDescription, risk: resolved.risk,
      parameters: resolved.requiresUrl ? { url: parameters.url } : {}, requiresFolder: false,
      requiresConfirmation: payload.needsConfirmation !== false || confidence < 0.8 || resolved.risk !== 'low',
      reason: cleanText(payload.reason, 300) } };
  }

  async function parse(goal, { signal, candidates } = {}) {
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 300 || controls.test(goal)) {
      return failure('PARAMETERS_INVALID', '请输入 1 至 300 字的目标，例如“打开计算器”。');
    }
    const question = goal.trim().replace(/\s+/gu, ' ');
    if (signal?.aborted) return failure('CANCELLED', '已取消本次解析。');
    if (!available()) return failure('MODEL_UNAVAILABLE', '智能解析需要本机已配置模型；未配置时不会猜测或执行任何打开操作。');
    let reply;
    const candidateList = (Array.isArray(candidates) ? candidates : [])
      .filter(candidate => candidate && typeof candidate.id === 'string' && typeof candidate.displayName === 'string')
      .slice(0, 40)
      .map(candidate => ({ id: cleanText(candidate.id, 40), displayName: cleanText(candidate.displayName, 60) }))
      .filter(candidate => candidate.id && candidate.displayName);
    try {
      reply = await provider.answer({ question, instructions: buildInstructions(candidateList), signal, timeoutMs });
    } catch (error) {
      if (signal?.aborted) return failure('CANCELLED', '已取消本次解析。');
      return failure('MODEL_UNAVAILABLE', '智能解析暂不可用，请稍后手动重试或检查本机模型配置。');
    }
    if (signal?.aborted) return failure('CANCELLED', '已取消本次解析。');
    const text = typeof reply?.text === 'string' ? reply.text : '';
    const parsed = extractJson(text);
    if (!parsed) return failure('MODEL_INVALID_JSON', '模型没有返回可用的 JSON 指令，已拒绝执行。');
    if (parsed.unsafe) return failure('UNSAFE_MODEL_OUTPUT', '模型返回了命令或脚本内容，已拒绝执行。');
    const payload = parsed.value;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return failure('MODEL_INVALID_JSON', '模型没有返回可用的 JSON 指令，已拒绝执行。');
    const action = cleanText(payload.action, 30);
    if (!Object.hasOwn(allowedKeys, action)) return failure('MODEL_INVALID_JSON', '模型返回了不支持的 action，已拒绝执行。');
    const keys = Object.keys(payload);
    if (keys.some(key => !allowedKeys[action].has(key))) return failure('UNSAFE_MODEL_OUTPUT', '模型返回了不允许的字段，已拒绝执行。');
    if (action === 'open_app') return validateOpenApp(payload);
    if (action === 'ask_clarification') {
      const ask = cleanText(payload.question, 300);
      if (!ask) return failure('MODEL_INVALID_JSON', '模型追问内容为空，已拒绝执行。');
      return { ok: true, kind: 'clarify', question: ask };
    }
    if (action === 'unsupported') {
      return { ok: true, kind: 'unsupported', message: cleanText(payload.reason, 300) || '该软件或界面暂不支持直接打开。' };
    }
    return { ok: true, kind: 'cancel' };
  }

  return Object.freeze({ available, parse, instructions: () => instructions,
    instructionsFor: candidates => buildInstructions(candidates) });
}

module.exports = { createAppLauncherIntent, unsafePattern, allowedKeys };