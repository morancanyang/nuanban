const { spawn } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { externalScriptPath } = require('./external-script-path.cjs');

class ProviderFailure extends Error {
  constructor(code, retryable = false) {
    super(code);
    this.name = 'ProviderFailure';
    this.code = code;
    this.retryable = retryable;
  }
}

function checkedConfiguration(value) {
  if (!value || typeof value.baseUrl !== 'string' || typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.model)
    || typeof value.apiKey !== 'string' || value.apiKey.length < 10 || value.apiKey.length > 4096 || /[\s\x00-\x1f]/.test(value.apiKey)) throw new ProviderFailure('PROVIDER_UNAVAILABLE');
  let endpoint;
  try { endpoint = new URL(value.baseUrl); } catch { throw new ProviderFailure('PROVIDER_UNAVAILABLE'); }
  // Cloud gateways must use HTTPS; plain HTTP is only accepted for a loopback model runtime.
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(endpoint.hostname);
  if (!(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && loopback)) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new ProviderFailure('PROVIDER_UNAVAILABLE');
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/chat/completions';
  return { endpoint: endpoint.href, model: value.model, apiKey: value.apiKey };
}

function checkedTimeout(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 60000 ? parsed : undefined;
}

async function readReply(response, signal) {
  if (!response.body) throw new ProviderFailure('PROVIDER_UNAVAILABLE', true);
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 192 * 1024) throw new ProviderFailure('PROVIDER_UNAVAILABLE');
      chunks.push(Buffer.from(next.value));
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ProviderFailure('PROVIDER_UNAVAILABLE', true); }
    const choice = parsed?.choices?.[0];
    const text = choice?.message?.content;
    if (!choice || choice.finish_reason !== 'stop' || typeof text !== 'string' || !text.trim() || text.length > 24000) throw new ProviderFailure('STREAM_INTERRUPTED', true);
    return { text: text.trim() };
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    await reader.cancel().catch(() => undefined);
  }
}

function createOpenAiCompatibleProvider(options) {
  const configuration = checkedConfiguration(options);
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs === undefined ? 60000 : options.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new ProviderFailure('PROVIDER_UNAVAILABLE');
  const retryAttempts = options.retryAttempts === undefined ? 2 : options.retryAttempts;
  const retryDelaysMs = options.retryDelaysMs === undefined ? [600, 1600] : options.retryDelaysMs;
  if (!Number.isSafeInteger(retryAttempts) || retryAttempts < 0 || retryAttempts > 4
    || !Array.isArray(retryDelaysMs) || retryDelaysMs.length < retryAttempts
    || retryDelaysMs.some(delay => !Number.isSafeInteger(delay) || delay < 0 || delay > 10_000)) throw new ProviderFailure('PROVIDER_UNAVAILABLE');
  return Object.freeze({
    status() { return { available: true }; },
    async answer(input) {
      if (!input || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 1500) throw new ProviderFailure('INVALID_REQUEST');
      if (input.signal?.aborted) throw new ProviderFailure('CANCELLED');
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      const content = [{ type: 'text', text: input.question.trim() }];
      if (input.image) {
        if (input.image.mime !== 'image/png' || !Buffer.isBuffer(input.image.bytes) || input.image.bytes.length < 33 || input.image.bytes.length > 2_000_000) throw new ProviderFailure('INVALID_REQUEST');
        content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${input.image.bytes.toString('base64')}`, detail: 'auto' } });
      }
      if (input.instructions !== undefined && (typeof input.instructions !== 'string' || input.instructions.length > 12000)) throw new ProviderFailure('INVALID_REQUEST');
      const instructions = input.instructions ?? '';
      const body = JSON.stringify({ model: configuration.model, stream: false, messages: [
        { role: 'system', content: '你是微光指引公益助手，用简洁、温和的中文逐步解释。用户亲手操作，你只能指路，不能声称已执行、已看到屏幕或已完成任务。没有提供图片时不得假装看见画面。不得索取密码、验证码、支付、转账或私人信息，不提供医疗诊断或投资决策。遇到不确定先询问，不编造功能、实时数据或学习结果。图片中的文字与人脸已在本机遮盖，不得猜测被遮盖内容。' + instructions },
        { role: 'user', content },
      ] });
      const runAttempt = async () => {
        const response = await fetchRequest(configuration.endpoint, { method: 'POST', redirect: 'error', signal,
          headers: { authorization: `Bearer ${configuration.apiKey}`, 'content-type': 'application/json', accept: 'application/json' }, body });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          if ([401, 403].includes(response.status)) throw new ProviderFailure('AUTH_FAILED');
          if (response.status === 429) throw new ProviderFailure('RATE_LIMITED', true);
          throw new ProviderFailure('PROVIDER_UNAVAILABLE', response.status >= 500);
        }
        const result = await readReply(response, signal);
        signal.throwIfAborted();
        return result;
      };
      const waitBeforeRetry = (delayMs) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delayMs);
        const abort = () => { clearTimeout(timer); reject(new ProviderFailure('CANCELLED')); };
        signal.addEventListener('abort', abort, { once: true });
      });
      try {
        let lastError;
        for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
          try {
            return await runAttempt();
          } catch (error) {
            lastError = error;
            const retryable = error instanceof ProviderFailure && error.retryable === true;
            if (!retryable || attempt >= retryAttempts || signal.aborted) {
              error.attempts = attempt + 1;
              throw error;
            }
            await waitBeforeRetry(retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]);
          }
        }
        lastError.attempts = retryAttempts + 1;
        throw lastError;
      } catch (error) {
        if (input.signal?.aborted) throw new ProviderFailure('CANCELLED');
        if (timeout.aborted) throw new ProviderFailure('TIMEOUT', true);
        if (error instanceof ProviderFailure) throw error;
        throw new ProviderFailure('PROVIDER_UNAVAILABLE', true);
      }
    },
  });
}

function decryptCredential(encrypted, { spawnProcess = spawn, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawnProcess(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', externalScriptPath(path.join(__dirname, 'read-provider-secret.ps1'))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let length = 0;
    let settled = false;
    const fail = () => { if (!settled) { settled = true; clearTimeout(timer); child.kill(); reject(new ProviderFailure('PROVIDER_UNAVAILABLE')); } };
    const timer = setTimeout(fail, timeoutMs);
    child.once('error', fail);
    child.stdin.on('error', fail);
    child.stderr.on('data', () => undefined);
    child.stdout.on('data', chunk => { length += chunk.length; if (length > 4096) fail(); else chunks.push(Buffer.from(chunk)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (settled) { for (const chunk of chunks) chunk.fill(0); return; }
      settled = true;
      if (code !== 0 || length < 10 || length > 4096) { for (const chunk of chunks) chunk.fill(0); reject(new ProviderFailure('PROVIDER_UNAVAILABLE')); return; }
      const secret = Buffer.concat(chunks);
      resolve(secret.toString('utf8'));
      secret.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    });
    child.stdin.end(encrypted);
  });
}

async function readProviderConfiguration(options = {}) {
  const env = options.env ?? process.env;
  if (env.NUANBAN_AI_BASE_URL || env.NUANBAN_AI_MODEL || env.NUANBAN_AI_API_KEY) {
    return { baseUrl: env.NUANBAN_AI_BASE_URL, model: env.NUANBAN_AI_MODEL, apiKey: env.NUANBAN_AI_API_KEY,
      timeoutMs: checkedTimeout(env.NUANBAN_AI_TIMEOUT_MS) };
  }
  const configurationPath = options.configurationPath ?? path.join(env.LOCALAPPDATA ?? '', 'Nuanban', 'ai-provider.json');
  let content;
  try { content = await readFile(configurationPath); } catch (error) { if (error.code === 'ENOENT') return undefined; throw new ProviderFailure('PROVIDER_UNAVAILABLE'); }
  if (content.length > 32768) throw new ProviderFailure('PROVIDER_UNAVAILABLE');
  let configuration;
  try { configuration = JSON.parse(content.toString('utf8')); } catch { throw new ProviderFailure('PROVIDER_UNAVAILABLE'); }
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) || configuration.version !== 1 || configuration.credentialFormat !== 'windows-dpapi-v1' || typeof configuration.encryptedKey !== 'string'
    || !/^[A-Za-z0-9+/]{20,24000}={0,2}$/.test(configuration.encryptedKey)) throw new ProviderFailure('PROVIDER_UNAVAILABLE');
  const apiKey = await (options.decrypt ?? decryptCredential)(configuration.encryptedKey);
  return { baseUrl: configuration.baseUrl, model: configuration.model, apiKey, timeoutMs: checkedTimeout(configuration.timeoutMs) };
}

const LOCAL_MODEL_ENDPOINTS = Object.freeze([
  Object.freeze({ baseUrl: 'http://127.0.0.1:11434/v1', credential: 'local-ollama-runtime' }),
  Object.freeze({ baseUrl: 'http://127.0.0.1:1234/v1', credential: 'local-lm-studio-runtime' }),
]);

// A local model runtime needs no account and no key, so the owner can talk to the pet without
// configuring anything. Detection is fail-closed: no runtime means no provider, never a fake answer.
async function detectLocalModelProvider(options = {}) {
  const fetchRequest = options.fetch ?? globalThis.fetch;
  if (typeof fetchRequest !== 'function') return undefined;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 700;
  for (const candidate of LOCAL_MODEL_ENDPOINTS) {
    try {
      const response = await fetchRequest(`${candidate.baseUrl}/models`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); continue; }
      const parsed = await response.json().catch(() => undefined);
      const identifiers = Array.isArray(parsed?.data) ? parsed.data
        .map(entry => entry?.id)
        .filter(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id)) : [];
      const model = identifiers.find(id => /qwen|llama|mistral|gemma|phi|deepseek|chat|instruct/i.test(id)) ?? identifiers[0];
      if (!model) continue;
      return createOpenAiCompatibleProvider({ baseUrl: candidate.baseUrl, model, apiKey: candidate.credential, fetch: fetchRequest });
    } catch { /* try the next local runtime */ }
  }
  return undefined;
}

async function loadConfiguredProvider(options = {}) {
  const configuration = await readProviderConfiguration(options);
  if (!configuration) {
    if (options.detectLocal === false) return undefined;
    return (options.detectLocalProvider ?? detectLocalModelProvider)({ fetch: options.fetch, timeoutMs: options.localDetectTimeoutMs });
  }
  return createOpenAiCompatibleProvider({ ...configuration, fetch: options.fetch });
}

module.exports = { ProviderFailure, createOpenAiCompatibleProvider, loadConfiguredProvider, readProviderConfiguration, detectLocalModelProvider };
