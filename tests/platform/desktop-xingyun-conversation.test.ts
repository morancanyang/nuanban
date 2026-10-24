import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createXingyunConversationPermissionGuard } = require('../../apps/desktop/xingyun-permission-guard.cjs');
const { GATEWAY, createXingyunAvatarService, registerXingyunAvatarBridge } = require('../../apps/desktop/xingyun-avatar.cjs');

const credentials = { appId: '031ce3cd-synthetic-application-id', appSecret: 'synthetic-secret-00000000' };
const petPage = 'file:///C:/nuanban/apps/desktop/pet.html';
const conversationBody = () => ({ error_code: 0, data: { session_id: 'synthetic-session', resource_pack: {},
  e2e_resp: { ws_url: 'wss://e2emp.xingyun3d.com/ws/session?synthetic', e2e_token: 'synthetic-e2e-token',
    features: { auto_send_asr_to_llm: true, speech_frontend: { enabled: true, enable_aec: false }, vad_merge_mode: true } } } });
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const conversationRequest = () => ({ method: 'POST', body: { request_id: 'synthetic-request', config: { raw_audio: false } } });

class FakeContents {
  destroyed = false;
  constructor(public url = petPage) {}
  isDestroyed() { return this.destroyed; }
  getURL() { return this.url; }
}

type Handler = (...parameters: unknown[]) => unknown;

function fakeSession() {
  const handlers: { check?: Handler; request?: Handler; displayMedia?: Handler } = {};
  const session = {
    setPermissionCheckHandler: (handler: Handler) => { handlers.check = handler; },
    setPermissionRequestHandler: (handler: Handler) => { handlers.request = handler; },
    setDisplayMediaRequestHandler: (handler: Handler) => { handlers.displayMedia = handler; },
  };
  return { session, handlers };
}

function conversationFixture() {
  const fetchRequest = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => response(options?.method === 'POST' ? conversationBody() : { error_code: 0, data: {} }));
  const onState = vi.fn();
  return { fetchRequest, onState, service: createXingyunAvatarService({ credentials, fetch: fetchRequest, onState }) };
}

describe('星云实时对话：网关白名单与状态机', () => {
  it('conversation 模式只重建白名单字段，页面注入的 features/ids/config 一律不透传', async () => {
    const { service, fetchRequest } = conversationFixture();
    const grant = service.begin(true, 'conversation');
    expect(grant).toMatchObject({ mode: 'conversation', gatewayServer: 'https://nuanban-xingyun.invalid/session' });
    expect(JSON.stringify(grant)).not.toContain(credentials.appSecret);
    expect(service.status()).toMatchObject({ mode: 'conversation', conversation: { enabled: true, phase: 'connecting' }, autoReconnect: false, microphoneActive: false });
    const reply = await service.exchange(grant.lease, { method: 'POST', body: {
      request_id: 'synthetic-request', gateway_type: 'private-gateway', session_speak_req_id: 99, asr_id: 99, llm_id: 99,
      features: { auto_send_asr_to_llm: false, speech_frontend: { enabled: false, enable_aec: false }, injected: true },
      config: { raw_audio: false, framedata_proto_version: 99, walk_version: 99, brain_config: { query: 'private-question' } },
      tts_config: { voice: 'private-voice' }, extras: { url: 'https://private.invalid' }, appSecret: 'not-forwarded',
    } });
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    const [url, options] = fetchRequest.mock.calls[0];
    expect(url).toBe(GATEWAY);
    expect(options?.redirect).toBe('error');
    const sent = JSON.parse(String(options?.body));
    expect(sent).toEqual({ request_id: 'synthetic-request', gateway_type: 'default', session_speak_req_id: 1,
      features: { auto_send_asr_to_llm: true, speech_frontend: { enabled: true, enable_aec: false } },
      config: { framedata_proto_version: 2, walk_version: 3, raw_audio: false } });
    // 桌宠窗口是 file:// 不透明源，无法加载 blob AudioWorklet，因此对话模式必须关掉 AEC；
    // 平台尊重该值（实测回包 enable_aec:false），麦克风上行仍走 MediaRecorder/MSE，不需要 worklet。
    expect(sent.features.speech_frontend).toEqual({ enabled: true, enable_aec: false });
    expect(JSON.stringify(sent)).not.toContain('"enable_aec":true');
    expect(JSON.stringify(options)).not.toContain('private');
    expect(JSON.stringify(options)).not.toContain(credentials.appSecret);
    expect(reply.body.data.e2e_resp.ws_url).toBe('wss://e2emp.xingyun3d.com/ws/session?synthetic');
    expect(service.ready(grant.lease)).toBe(true);
    expect(service.status()).toMatchObject({ mode: 'conversation', conversation: { enabled: true, phase: 'active' } });
    expect(service.status().message).toContain('麦克风音频会上传星云做识别');
    expect(service.status().message).toContain('计费');
    expect(await service.stop()).toMatchObject({ stopped: true, phase: 'idle' });
    expect(service.status()).toMatchObject({ mode: 'conversation', conversation: { enabled: false, phase: 'idle' } });
    expect(fetchRequest.mock.calls.map(([, call]) => call?.method)).toEqual(['POST', 'DELETE']);
  });

  it('不传模式时仍是今天的 render 请求，非法模式在联网前拒绝', async () => {
    const { service, fetchRequest } = conversationFixture();
    const grant = service.begin(true);
    expect(grant.mode).toBe('render');
    expect(service.status()).toMatchObject({ mode: 'render', conversation: { enabled: false, phase: 'idle' } });
    await service.exchange(grant.lease, conversationRequest());
    const sent = JSON.parse(String(fetchRequest.mock.calls[0][1]?.body));
    expect(sent).toEqual({ request_id: 'synthetic-request', gateway_type: 'default',
      features: { auto_send_asr_to_llm: false, speech_frontend: { enabled: false } }, session_speak_req_id: 1,
      config: { framedata_proto_version: 2, walk_version: 3, raw_audio: false } });
    await service.stop();
    const invalid = conversationFixture();
    expect(() => invalid.service.begin(true, 'live')).toThrow('模式无效');
    expect(() => invalid.service.begin(true, { mode: 'conversation' })).toThrow('模式无效');
    expect(() => invalid.service.begin(true, '')).toThrow('模式无效');
    expect(invalid.fetchRequest).not.toHaveBeenCalled();
    expect(invalid.service.status()).toMatchObject({ phase: 'idle', conversation: { enabled: false, phase: 'idle' } });
  });

  it('对话会话的停止、平台错误与密钥隔离沿用手持标识，不自动重连', async () => {
    const { service, fetchRequest } = conversationFixture();
    fetchRequest.mockResolvedValueOnce(response({ error_code: 1008, error_reason: '角色、音色参数不完整 ' + credentials.appSecret + ' e2e_token ' + 'B'.repeat(32) }));
    const grant = service.begin(true, 'conversation');
    await expect(service.exchange(grant.lease, conversationRequest())).rejects.toThrow('1008');
    expect(service.status().message).not.toContain(credentials.appSecret);
    expect(JSON.stringify(service.status())).not.toContain(credentials.appSecret);
    expect(JSON.stringify(service.status())).not.toContain('B'.repeat(32));
    expect(service.status()).toMatchObject({ phase: 'error', conversation: { enabled: false, phase: 'idle' } });
    expect(fetchRequest.mock.calls.map(([, call]) => call?.method)).toEqual(['POST', 'DELETE']);
    expect(JSON.parse(String(fetchRequest.mock.calls[1][1]?.body))).toEqual({ request_id: 'synthetic-request', stop_reason: 'load_failed' });
    await service.stop();
  });

  it('一次本人确认只发一次 POST，停止确认前不创建第二个对话会话', async () => {
    const { service, fetchRequest } = conversationFixture();
    const grant = service.begin(true, 'conversation');
    await service.exchange(grant.lease, conversationRequest());
    expect(() => service.begin(true, 'conversation')).toThrow('第二个');
    await expect(service.exchange(grant.lease, conversationRequest())).rejects.toThrow('禁止自动重连');
    await expect(service.exchange('stale-lease', conversationRequest())).rejects.toThrow('授权已失效');
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it('对话确认通道只对受信桌宠开放，缺省实现一律拒绝', async () => {
    const handlers = new Map<string, Handler>();
    const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) };
    const trusted = {};
    const confirm = vi.fn().mockResolvedValue(true);
    const { service, fetchRequest } = conversationFixture();
    const bridge = registerXingyunAvatarBridge({ ipcMain, service, isTrusted: (event: unknown) => event === trusted, confirmConversation: confirm });
    expect(() => handlers.get('nuanban:avatar:confirm-conversation')!({}, 'extra')).toThrow('不可信');
    expect(await handlers.get('nuanban:avatar:confirm-conversation')!(trusted)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await handlers.get('nuanban:avatar:begin')!(trusted, true, 'conversation')).toMatchObject({ mode: 'conversation' });
    expect(() => handlers.get('nuanban:avatar:begin')!(trusted, true, 'live')).toThrow('模式无效');
    await service.stop();
    bridge.dispose();
    expect(handlers.size).toBe(0);
    expect(fetchRequest).not.toHaveBeenCalled();
    const unconfirmed = new Map<string, Handler>();
    registerXingyunAvatarBridge({ ipcMain: { handle: (channel: string, handler: Handler) => unconfirmed.set(channel, handler), removeHandler: () => {} }, service, isTrusted: () => true });
    expect(await unconfirmed.get('nuanban:avatar:confirm-conversation')!(trusted)).toBe(false);
  });
});

describe('实时对话的麦克风权限闸门', () => {
  it('未开启对话时一律拒绝，包括媒体检查', () => {
    const guard = createXingyunConversationPermissionGuard();
    const { session, handlers } = fakeSession();
    guard.install(session);
    const pet = new FakeContents();
    expect(handlers.check!(pet, 'media', 'file://', { isMainFrame: true, mediaType: 'audio' })).toBe(false);
    const callback = vi.fn();
    handlers.request!(pet, 'media', callback, { isMainFrame: true, mediaTypes: ['audio'] });
    expect(callback).toHaveBeenCalledWith(false);
    expect(guard.armed()).toBe(false);
  });

  it('只在桌宠窗口、同一页面、media 音频且本人已开启对话时放行', () => {
    const guard = createXingyunConversationPermissionGuard();
    const { session, handlers } = fakeSession();
    guard.install(session);
    const pet = new FakeContents();
    const other = new FakeContents('file:///C:/nuanban/apps/desktop/guide.html');
    const token = guard.arm(pet);
    expect(token).toBeGreaterThan(0);
    expect(guard.armed()).toBe(true);
    expect(handlers.check!(pet, 'media', 'file://', { isMainFrame: true, mediaType: 'audio' })).toBe(true);
    const allowed = vi.fn();
    handlers.request!(pet, 'media', allowed, { isMainFrame: true, mediaTypes: ['audio'] });
    expect(allowed).toHaveBeenCalledWith(true);
    expect(handlers.check!(other, 'media', 'file://', { isMainFrame: true, mediaType: 'audio' })).toBe(false);
    expect(handlers.check!(pet, 'media', 'file://', { isMainFrame: false, mediaType: 'audio' })).toBe(false);
    expect(handlers.check!(pet, 'media', 'file://', { isMainFrame: true, mediaType: 'video' })).toBe(false);
    expect(handlers.check!(pet, 'media', 'file://', { isMainFrame: true, mediaType: 'audio', requestingUrl: 'https://not-pet.invalid/' })).toBe(false);
    const denied = vi.fn();
    handlers.request!(pet, 'media', denied, { isMainFrame: true, mediaTypes: ['audio', 'video'] });
    expect(denied).toHaveBeenCalledWith(false);
    for (const permission of ['display-capture', 'geolocation', 'notifications', 'clipboard-read', 'mediaKeySystem', 'hid', 'usb']) {
      expect(handlers.check!(pet, permission, 'file://', { isMainFrame: true })).toBe(false);
    }
    pet.url = 'https://not-pet.invalid/';
    expect(handlers.check!(pet, 'media', 'file://', { isMainFrame: true, mediaType: 'audio' })).toBe(false);
    pet.url = petPage;
    expect(handlers.check!(pet, 'media', 'file://', { isMainFrame: true, mediaType: 'audio' })).toBe(true);
    pet.destroyed = true;
    expect(handlers.check!(pet, 'media', 'file://', { isMainFrame: true, mediaType: 'audio' })).toBe(false);
  });

  it('停止后立即失效，迟到的撤销不会注销新会话', () => {
    const guard = createXingyunConversationPermissionGuard();
    const { session, handlers } = fakeSession();
    guard.install(session);
    const pet = new FakeContents();
    const first = guard.arm(pet);
    expect(guard.disarm(first)).toBe(true);
    expect(guard.armed()).toBe(false);
    expect(handlers.check!(pet, 'media', 'file://', { isMainFrame: true, mediaType: 'audio' })).toBe(false);
    const second = guard.arm(pet);
    const third = guard.arm(pet);
    expect(second).not.toBe(third);
    expect(guard.disarm(second)).toBe(false);
    expect(handlers.check!(pet, 'media', 'file://', { isMainFrame: true, mediaType: 'audio' })).toBe(true);
    expect(guard.disarm(third)).toBe(true);
    expect(handlers.check!(pet, 'media', 'file://', { isMainFrame: true, mediaType: 'audio' })).toBe(false);
    expect(() => guard.arm(undefined)).toThrow('桌宠窗口不可用');
    expect(() => guard.install({})).toThrow('无法接管权限请求');
  });

  it('屏幕采集始终被拒绝，默认会话不会出现隐式放行', () => {
    const guard = createXingyunConversationPermissionGuard();
    const { session, handlers } = fakeSession();
    guard.install(session);
    const displayCallback = vi.fn();
    handlers.displayMedia!({}, displayCallback);
    expect(displayCallback).toHaveBeenCalledWith({});
  });

  it('会话状态驱动放行：开启即放行，停止确认后立刻拒绝且不残留麦克风', async () => {
    const guard = createXingyunConversationPermissionGuard();
    const { session, handlers } = fakeSession();
    guard.install(session);
    const pet = new FakeContents();
    let token: number | undefined;
    const fetchRequest = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => response(options?.method === 'POST' ? conversationBody() : { error_code: 0, data: {} }));
    const service = createXingyunAvatarService({ credentials, fetch: fetchRequest, onState: (state: { mode?: string; conversation?: { enabled?: boolean } }) => {
      const active = state.mode === 'conversation' && state.conversation?.enabled === true;
      if (active) { if (token === undefined) token = guard.arm(pet); }
      else if (token !== undefined) { guard.disarm(token); token = undefined; }
    } });
    expect(handlers.check!(pet, 'media', 'file://', { isMainFrame: true, mediaType: 'audio' })).toBe(false);
    const grant = service.begin(true, 'conversation');
    expect(handlers.check!(pet, 'media', 'file://', { isMainFrame: true, mediaType: 'audio' })).toBe(true);
    await service.exchange(grant.lease, conversationRequest());
    expect(service.ready(grant.lease)).toBe(true);
    expect(handlers.check!(pet, 'media', 'file://', { isMainFrame: true, mediaType: 'audio' })).toBe(true);
    expect(await service.stop()).toMatchObject({ stopped: true });
    expect(handlers.check!(pet, 'media', 'file://', { isMainFrame: true, mediaType: 'audio' })).toBe(false);
    expect(guard.armed()).toBe(false);
    expect(service.status().conversation).toMatchObject({ enabled: false, phase: 'idle' });
  });
});

describe('实时对话的源码守卫', () => {
  const read = (name: string) => readFileSync(new URL('../../apps/desktop/' + name, import.meta.url), 'utf8');
  const renderer = read('xingyun-renderer.js');
  const guardSource = read('xingyun-permission-guard.cjs');
  const host = read('standalone-host.cjs');
  const main = read('main.cjs');
  const preload = read('pet-preload.cjs');
  const html = read('pet.html');

  it('默认会话仍默认拒绝，唯一例外是绑定对话代次的音频闸门', () => {
    expect(main).toContain('createXingyunConversationPermissionGuard');
    expect(main).toContain('xingyunPermissions.install(session.defaultSession)');
    expect(main).toContain('xingyunPermissions,');
    expect(main).not.toMatch(/callback\(true\)/);
    expect(main).not.toMatch(/setPermissionCheckHandler\(\(\)\s*=>\s*true\)/);
    expect(guardSource).toContain("const ALLOWED_PERMISSION = 'media'");
    expect(guardSource).toContain('contents !== allowedContents');
    expect(guardSource).toContain('allowedContents.getURL() !== allowedUrl');
    expect(guardSource).not.toMatch(/ALLOWED_PERMISSION = '(display-capture|geolocation|notifications)'/);
    expect(host).toContain("avatarState?.mode === 'conversation' && avatarState?.conversation?.enabled === true");
    expect(host).toContain('if (avatarPermissionToken === undefined)');
    expect(host).toContain('xingyunPermissions.disarm(avatarPermissionToken)');
    expect(host).toMatch(/function revokeAvatarPermission\(\) \{[\s\S]*?xingyunPermissions\?\.disarm\(avatarPermissionToken\)/);
    expect(host).toMatch(/petWindow\.on\('closed', \(\) => \{ revokeAvatarPermission\(\)/);
    expect(host).toMatch(/async function dispose\(reason\) \{\n    revokeAvatarPermission\(\);/);
    expect(host).toMatch(/if \(live\(petWindow\)\) petWindow\.webContents\.send\('nuanban:avatar:state', state\)/);
  });

  it('render 模式不启动 ASR 或提问，conversation 才在就绪后聆听', () => {
    expect(renderer).toContain("startButton.addEventListener('click', () => { void start('render'); })");
    expect((renderer.match(/start\('conversation'\)/g) ?? [])).toHaveLength(1);
    expect(renderer).toContain("conversationStartButton?.addEventListener('click', () => { void start('conversation'); })");
    expect(renderer).toContain('audio: { inputEnabled: conversationMode }');
    expect(renderer).toContain('currentInstance.setVolume(conversationMode ? 1 : 0)');
    expect(renderer).toContain('reconnect: { enabled: false, maxAttempts: 0 }');
    expect(renderer).toContain("if (conversationMode) void startListening(current, currentInstance);");
    expect(renderer).toMatch(/async function startListening\(token, target\) \{\n  if \(!isCurrent\(token, target\) \|\| mode !== 'conversation'\) return;/);
    expect(renderer).toMatch(/async function stopListening\(\) \{\n  const target = instance;\n  const token = generation;\n  if \(!target \|\| mode !== 'conversation'\) return;/);
    expect(renderer).toMatch(/function conversationCommand\(event\) \{\n  const action = event\?\.detail\?\.action;\n  if \(disposed \|\| mode !== 'conversation' \|\| !instance\) return;/);
    expect((renderer.match(/startASR\(/g) ?? [])).toHaveLength(1);
    expect(renderer).not.toContain('getUserMedia');
    expect(renderer).not.toMatch(/\.ask\(/);
    expect(renderer).toContain("new CustomEvent('nuanban:avatar-conversation'");
    expect(renderer).toContain("window.addEventListener('nuanban:avatar-conversation-command', conversationCommand)");
  });

  it('按模式选类：仅形象用基类 XmovAvatar，实时对话才用 XingyunAvatarAgent', () => {
    // 仅形象不需要 Agent 的 E2E/ASR/Brain 管线；实时通道抖动不能把仅形象会话拖垮。
    expect(renderer).toContain("const { default: AvatarClass } = conversationMode ? await import('@xmov/avatar/agent') : await import('@xmov/avatar');");
    expect(renderer).toContain('new AvatarClass({');
    expect(renderer).not.toContain('new XingyunAvatarAgent(');
    expect((renderer.match(/import\('@xmov\/avatar\/agent'\)/g) ?? [])).toHaveLength(1);
    expect((renderer.match(/import\('@xmov\/avatar'\)/g) ?? [])).toHaveLength(1);
    // agentCallbacks（含 socket/agent 失败兜底）只在对话模式存在；仅形象不再因实时通道状态被判失败。
    expect(renderer).toContain('agentCallbacks: conversationMode ? {');
    expect(renderer).toMatch(/} : undefined,\n    \}\);/);
    expect(renderer).toContain("'init mode=' + mode + ' sdk=' + (conversationMode ? 'agent' : 'base')");
  });

  it('失败分级与真实原因上屏：阶段 + SDK 原始 code/message，且不含 token/密钥', () => {
    expect(renderer).toContain("const FAILURE_STAGES = {");
    for (const stage of ['session', 'resource', 'realtime', 'render', 'permission', 'timeout']) expect(renderer).toContain(stage + ':');
    expect(renderer).toContain('function failureSummary(stage, detail)');
    expect(renderer).toContain('function errorReason(error)');
    expect(renderer).toContain('bridge.fail(currentLease, kind, summary)');
    expect(renderer).toContain("fail('load_failed', 'realtime', errorReason(error))");
    expect(renderer).toContain("fail('load_failed', 'realtime', 'socket=' + cleanReason(String(socketState)))");
    expect(renderer).toContain("fail('load_failed', 'session', errorReason(error))");
    expect(renderer).toContain("fail('timeout', 'timeout', '等待形象就绪超过 120 秒')");
    expect(renderer).toContain('实时对话未能建立（');
    expect(renderer).not.toMatch(/console\.log|console\.error/);
  });

  it('销毁路径确保 stopASR 与 destroy，迟到回调按 generation 丢弃', () => {
    expect(renderer).toMatch(/async function destroyInstance\(previous, previousMode\) \{[\s\S]*?await previous\.stopASR\(\)[\s\S]*?await previous\.destroy\('user'\)/);
    expect(renderer).toContain("if (previousMode === 'conversation' && typeof previous.stopASR === 'function')");
    expect(renderer).toContain('if (previous) void destroyInstance(previous, previousMode);');
    expect(renderer).toContain('function isCurrent(token, target)');
    expect(renderer).toContain('return !disposed && token === generation && target === instance;');
    expect((renderer.match(/isCurrent\(current, currentInstance\)/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(renderer).toContain('if (!isCurrent(token, target)) return;');
    expect(renderer).toMatch(/window\.addEventListener\('pagehide', \(\) => \{ disposed = true; destroyLocal\(\);/);
  });

  it('对话模式必须本人原生确认，页面不自动开启、不自动重连', () => {
    expect(renderer).toContain('bridge?.confirmConversation');
    expect(renderer).toContain('if (accepted !== true)');
    expect(renderer).toContain("publishConversation({ state: 'cancelled', asr: 'off', error: '' })");
    expect(host).toContain("title: '开启星云实时对话'");
    expect(host).toContain('麦克风音频会上传星云做语音识别');
    expect(host).toContain('按星云平台规则计费');
    expect(host).toContain('停止实时对话');
    expect(host).toContain('不会自动重连');
    expect(host).toMatch(/buttons: \['开启实时对话', '取消'\], defaultId: 1, cancelId: 1/);
    expect(host).not.toMatch(/reconnect: \{ enabled: true/);
  });

  it('预加载只投影白名单字段，模式非法即拒绝', () => {
    expect(preload).toContain("if (mode !== 'render' && mode !== 'conversation') throw new TypeError('形象会话模式无效');");
    expect(preload).toContain("begin: (consent, mode) =>");
    expect(preload).toContain("confirmConversation: () => ipcRenderer.invoke('nuanban:avatar:confirm-conversation')");
    expect(preload).toContain("conversation: { enabled: state.conversation?.enabled === true");
    expect(preload).not.toMatch(/appSecret|e2e_token|ws_url|credentials/);
    // 取证只走受限 IPC 的一个通道，preload 不落地文件、不读密钥。
    expect(preload).toContain("ipcRenderer.send('nuanban:avatar:trace', projectAvatarTrace(entry))");
    expect(preload).toContain('const AVATAR_TRACE_KINDS =');
    expect(preload).toContain("trace: entry =>");
    expect(preload).toContain("fail: (lease, kind, detail) =>");
    expect(preload).not.toMatch(/node:fs|writeFileSync|readFileSync|app\.getPath/);
  });

  it('对话模式必须关掉 AEC（file:// 不能加载 blob AudioWorklet），仅形象会话体不变', () => {
    const avatarSource = read('xingyun-avatar.cjs');
    expect(avatarSource).toContain('speech_frontend: { enabled: true, enable_aec: false }');
    expect(avatarSource).not.toContain('enable_aec: true');
    expect(avatarSource).toContain('不透明源');
    expect(avatarSource).toContain("features: { auto_send_asr_to_llm: false, speech_frontend: { enabled: false } }");
    expect(renderer).toContain('{ auto_send_asr_to_llm: true, speech_frontend: { enabled: true, enable_aec: false } }');
    expect(renderer).toContain('{ auto_send_asr_to_llm: false, speech_frontend: { enabled: false } }');
    expect(renderer).not.toContain('enable_aec: true');
  });

  it('页面入口默认关闭，并写明上传、提问、计费与停止边界', () => {
    expect(html).toContain('id="feature-avatar-conversation"');
    expect(html).toContain('id="avatar-conversation-start"');
    expect(html).toMatch(/id="avatar-conversation-start"[^>]+disabled/);
    expect(html).toContain('id="avatar-conversation-state"');
    expect(html).toContain('id="avatar-conversation-transcript"');
    expect(html).toContain('id="avatar-conversation-reply"');
    expect(html).toContain('麦克风音频会上传星云做识别');
    expect(html).toContain('提问由星云模型回答、语音由星云合成');
    expect(html).toContain('计费');
    expect(html).toContain('停止即结束会话');
    expect(html).toContain('不自动重连');
    const petScript = read('pet.js');
    expect(petScript).toContain("bind(element('feature-avatar-conversation'), 'click'");
  });
});