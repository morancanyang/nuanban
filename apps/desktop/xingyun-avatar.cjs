const { createHash, randomUUID } = require('node:crypto');
const defaultPet = require('./default-pet.json');

const GATEWAY = 'https://nebula-agent.xingyun3d.com/user/v1/ttsa_v2/session';
const MARKER_GATEWAY = 'https://nuanban-xingyun.invalid/session';
// 形象会话只有两种模式：render 只渲染形象（默认，今天的行为），conversation 使用星云原生实时对话
// （星云 ASR + 星云 Brain + 星云 TTS + 口型）。非法模式在联网前拒绝，避免页面用未知模式试探网关。
const SESSION_MODES = ['render', 'conversation'];
const PET_AVATAR_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https://*.xingyun3d.com https://public-xmov.oss-cn-hangzhou.aliyuncs.com; connect-src blob: data: https://*.xingyun3d.com wss://*.xingyun3d.com https://public-xmov.oss-cn-hangzhou.aliyuncs.com; worker-src 'self' blob:; media-src blob: data: https://*.xingyun3d.com https://public-xmov.oss-cn-hangzhou.aliyuncs.com; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

function compareCodePoints(left, right) {
  const leftPoints = Array.from(left, character => character.codePointAt(0));
  const rightPoints = Array.from(right, character => character.codePointAt(0));
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index++) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort(compareCodePoints).map(key => [key, sortKeys(value[key])]));
}

function signSession(credentials, method, data, timestamp = Math.floor(Date.now() / 1000)) {
  const sorted = sortKeys(data);
  const body = JSON.stringify(sorted);
  const canonical = body.replace(/[^\u0000-\u007E]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).replace(/ /g, '');
  const token = createHash('md5').update(new URL(GATEWAY).pathname.toLowerCase() + method.toLowerCase() + canonical + credentials.appSecret + timestamp).digest('hex');
  return { body, headers: { 'content-type': 'application/json', 'X-APP-ID': credentials.appId, 'X-TOKEN': token, 'X-TIMESTAMP': String(timestamp) } };
}

function createXingyunAvatarService({ credentials, fetch: fetchRequest = globalThis.fetch, onState = () => {}, timeoutMs = 25000 }) {
  const configured = Boolean(credentials?.appId?.startsWith(defaultPet.application.appIdPrefix));
  const configurationMismatch = Boolean(credentials) && !configured;
  let phase = configured ? 'idle' : 'unconfigured';
  let message = configured ? '默认桌宠为' + defaultPet.name + '，当前显示本地静态预览；本人启用后连接实时 3D。'
    : configurationMismatch ? '默认桌宠已更换为' + defaultPet.name + '；本机仍配置其他星云应用。请更新为应用 ' + defaultPet.application.editorId + ' 的完整凭证，当前不会连接旧形象。'
      : '默认' + defaultPet.name + '正在以本地静态预览显示；连接实时 3D 需要先在本机加密配置星云应用。';
  let active;
  let lastMode = 'render';
  let disposed = false;
  const conversationState = () => {
    if (!active || active.mode !== 'conversation') return { enabled: false, phase: 'idle' };
    if (phase === 'cleanup_failed') return { enabled: false, phase: 'cleanup_failed' };
    if (active.stopRequested) return { enabled: false, phase: 'stopping' };
    if (phase === 'error') return { enabled: false, phase: 'error' };
    return { enabled: true, phase: active.sessionId ? 'active' : 'connecting' };
  };
  const status = () => ({ configured, configurationMismatch, phase, message, appId: credentials?.appId ?? '', defaultAvatarId: defaultPet.id, defaultAvatarName: defaultPet.name, mode: active?.mode ?? lastMode, conversation: conversationState(), autoReconnect: false, microphoneActive: false });
  function publish(next, text) { phase = next; message = text; onState(status()); }

  async function send(method, data) {
    const signed = signSession(credentials, method, data);
    const response = await fetchRequest(GATEWAY, { method, ...signed, redirect: 'error', signal: AbortSignal.timeout(method === 'DELETE' ? 10000 : timeoutMs) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error([401, 403].includes(response.status) ? '星云鉴权失败，请核对 App ID、密钥和应用发布状态。' : '星云服务暂不可用，请检查网络或平台额度。');
    }
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error('星云会话响应超出安全限制。');
    let body;
    try { body = JSON.parse(text); } catch { throw new Error('星云服务没有返回有效的会话信息。'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('星云会话响应无效。');
    if ((body.error_code !== undefined && body.error_code !== 0) || (body.code !== undefined && ![0, 200].includes(body.code))) {
      const code = String(body.error_code ?? body.code);
      const reason = typeof body.error_reason === 'string' ? body.error_reason.replaceAll(credentials.appSecret, '[密钥已隐藏]')
        .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/https?:\/\/\S+/g, '[地址已隐藏]').replace(/[A-Za-z0-9_=-]{24,}/g, '[标识已隐藏]').slice(0, 200) : '';
      throw new Error('星云平台拒绝了会话请求' + (/^[A-Za-z0-9_-]{1,32}$/.test(code) ? '（' + code + '）' : '') + (reason ? '：' + reason : '。请核对应用是否已发布、额度及并发数。'));
    }
    return body;
  }

  function begin(consent, mode = 'render') {
    if (disposed || !configured) throw new Error(configurationMismatch ? '本机仍是其他星云应用，请先更新为应用 ' + defaultPet.application.editorId + ' 的完整凭证。' : '星云应用尚未配置。');
    if (consent !== true) throw new Error('请本人确认联网形象服务后再启用。');
    if (!SESSION_MODES.includes(mode)) throw new Error('形象会话模式无效，已拒绝创建会话。');
    if (active) throw new Error('已有形象会话，停止确认前不会创建第二个会话。');
    lastMode = mode;
    active = { lease: randomUUID(), mode, requestId: undefined, sessionId: undefined, postStarted: false, stopRequested: false, starting: undefined, stopping: undefined };
    publish('connecting', mode === 'conversation'
      ? '正在连接' + defaultPet.name + '实时对话；本模式会把麦克风音频与提问交给星云，按其平台规则计费。本次只尝试一个会话，不自动重连。'
      : '正在连接' + defaultPet.name + '；本次只尝试一个会话，不自动重连。');
    return { lease: active.lease, mode, appId: credentials.appId, gatewayServer: MARKER_GATEWAY };
  }

  function stop(reason = 'user') {
    const attempt = active;
    if (!attempt) return Promise.resolve({ stopped: true, ...status() });
    if (attempt.stopping) return attempt.stopping;
    attempt.stopRequested = true;
    publish('stopping', '正在关闭形象连接并确认星云会话停止…');
    attempt.stopping = (async () => {
      if (attempt.starting) await attempt.starting.catch(() => {});
      try {
        if (attempt.postStarted) {
          await send('DELETE', { stop_reason: ['user', 'app_exit', 'renderer_gone', 'load_failed', 'timeout', 'page_unload'].includes(reason) ? reason : 'user',
            ...(attempt.sessionId ? { session_id: attempt.sessionId } : {}), ...(attempt.requestId ? { request_id: attempt.requestId } : {}) });
        }
        if (active === attempt) active = undefined;
        publish('idle', '星云会话已停止，已恢复本机桌宠。下次需本人手动启用。');
        return { stopped: true, ...status() };
      } catch {
        publish('cleanup_failed', '本机已停止显示，但星云未确认会话关闭；请重试停止，并在星云后台检查会话与计费。');
        return { stopped: false, ...status() };
      } finally { attempt.stopping = undefined; }
    })();
    return attempt.stopping;
  }

  async function exchange(lease, input) {
    const attempt = active;
    if (!attempt || lease !== attempt.lease || !input || typeof input !== 'object') throw new Error('形象会话授权已失效。');
    if (input.method === 'DELETE') {
      const result = await stop('user');
      if (!result.stopped) throw new Error(result.message);
      return { status: 200, body: { error_code: 0, data: {} } };
    }
    if (input.method !== 'POST' || attempt.postStarted || attempt.stopRequested) throw new Error('禁止自动重连或重复创建星云会话。');
    const requestId = input.body?.request_id;
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new Error('形象请求标识无效。');
    const rawAudio = input.body?.config?.raw_audio;
    if (typeof rawAudio !== 'boolean') throw new Error('形象音频格式参数无效，请更新桌宠形象运行资源后重试。');
    attempt.postStarted = true;
    attempt.requestId = requestId;
    // 白名单重建：页面传入的 features/ids/config 一律丢弃，只保留页面唯一有权决定的 raw_audio。
    // conversation 模式才启用星云 ASR→Brain 与语音前端；render 模式与今天完全一致。
    const sessionRequest = attempt.mode === 'conversation'
      ? { request_id: requestId, gateway_type: 'default', session_speak_req_id: 1,
        features: { auto_send_asr_to_llm: true, speech_frontend: { enabled: true, enable_aec: true } },
        config: { framedata_proto_version: 2, walk_version: 3, raw_audio: rawAudio } }
      : { request_id: requestId, gateway_type: 'default',
        features: { auto_send_asr_to_llm: false, speech_frontend: { enabled: false } }, session_speak_req_id: 1,
        config: { framedata_proto_version: 2, walk_version: 3, raw_audio: rawAudio } };
    attempt.starting = send('POST', sessionRequest).then(body => {
      if (typeof body.data?.session_id === 'string' && body.data.session_id.length <= 256) attempt.sessionId = body.data.session_id;
      return body;
    });
    try {
      const body = await attempt.starting;
      if (!body.data?.resource_pack || typeof body.data.resource_pack !== 'object') throw new Error('星云应用未返回形象资源，请在平台核对' + defaultPet.name + '应用配置后重试。');
      if (attempt.stopRequested) { await stop('user'); throw new Error('本次形象连接已取消。'); }
      return { status: 200, body };
    } catch (error) {
      const wasStopping = attempt.stopRequested;
      const text = error instanceof Error && error.message.startsWith('星云') ? error.message : '星云形象连接失败或超时；未自动重连，请检查网络后手动重试。';
      const stopped = await stop('load_failed');
      if (stopped.stopped && !wasStopping) publish('error', text);
      throw new Error(text);
    }
  }

  function ready(lease) {
    if (!active || lease !== active.lease || active.stopRequested || !active.sessionId) return false;
    publish('ready', active.mode === 'conversation'
      ? defaultPet.name + '实时对话已就绪。麦克风音频会上传星云做识别，提问由星云模型回答，语音由星云合成，按其平台规则计费；停止即结束本次会话。'
      : defaultPet.name + '已启用。只接入形象，不向星云发送问答、屏幕或麦克风。');
    return true;
  }

  async function fail(lease, kind) {
    if (!active || lease !== active.lease) return status();
    const stopped = await stop(kind === 'timeout' ? 'timeout' : 'load_failed');
    if (stopped.stopped) publish('error', kind === 'timeout' ? defaultPet.name + '加载超时，已停止会话并恢复本机桌宠；不会自动重连。' : defaultPet.name + '资源或连接加载失败，已恢复本机桌宠；请检查网络后手动重试。');
    return status();
  }

  return Object.freeze({ status, begin, exchange, ready, fail, stop, async dispose() { disposed = true; return stop('app_exit'); } });
}

function registerXingyunAvatarBridge({ ipcMain, service, isTrusted, confirmConversation }) {
  const actions = { status: () => service.status(), begin: (consent, mode) => service.begin(consent, mode), exchange: (lease, input) => service.exchange(lease, input),
    ready: lease => service.ready(lease), fail: (lease, kind) => service.fail(lease, kind), stop: () => service.stop(),
    'confirm-conversation': async () => {
      if (typeof confirmConversation !== 'function') return false;
      return (await confirmConversation()) === true;
    } };
  for (const [name, action] of Object.entries(actions)) ipcMain.handle('nuanban:avatar:' + name, (event, ...parameters) => {
    if (!isTrusted(event)) throw new Error('不可信桌宠来源');
    return action(...parameters);
  });
  return { dispose() { for (const name of Object.keys(actions)) ipcMain.removeHandler('nuanban:avatar:' + name); } };
}

module.exports = { GATEWAY, MARKER_GATEWAY, PET_AVATAR_CSP, defaultPet, signSession, createXingyunAvatarService, registerXingyunAvatarBridge };
