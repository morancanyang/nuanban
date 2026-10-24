import defaultPet from './default-pet.json';

const bridge = window.nuanbanAvatar;
const element = identifier => document.getElementById(identifier);
const container = element('xingyun-canvas');
const surface = element('xingyun-pet');
const consent = element('avatar-consent');
const startButton = element('avatar-start');
const stopButton = element('avatar-stop');
const progress = element('avatar-progress');
const conversationStartButton = element('avatar-conversation-start');
const conversationStopButton = element('avatar-conversation-stop');
const conversationListenButton = element('avatar-conversation-listen');
const conversationInterruptButton = element('avatar-conversation-interrupt');
const conversationStateLabel = element('avatar-conversation-state');
const conversationTranscriptLabel = element('avatar-conversation-transcript');
const conversationReplyLabel = element('avatar-conversation-reply');
const motions = [
  { button: 'avatar-motion-idle', method: 'idle', label: '待机' },
  { button: 'avatar-motion-interactive', method: 'interactiveidle', label: '互动' },
  { button: 'avatar-motion-listen', method: 'listen', label: '聆听' },
  { button: 'avatar-motion-think', method: 'think', label: '思考' },
];
const CONVERSATION_LABELS = {
  idle: '实时对话未开启。未开启时不会使用麦克风，也不会把提问交给星云。',
  cancelled: '已取消：实时对话未开启，麦克风保持关闭。',
  connecting: '正在连接星云实时对话…',
  listening: '正在聆听，请直接说话',
  thinking: '正在思考你的问题…',
  paused: '已暂停聆听，实时对话会话仍保持；点击“继续聆听”恢复。',
  speaking: '正在说话…',
  stopping: '正在结束实时对话…',
  stopped: '实时对话已结束，会话已确认关闭；再次开启需本人重新确认。',
  error: '实时对话已中断，不会自动重连。',
};
const ASR_LABELS = {
  off: '麦克风未开启',
  requesting: '正在请求麦克风权限…',
  starting: '正在开启聆听…',
  listening: '麦克风正在采集，音频会上传星云做识别',
  stopping: '正在停止聆听…',
  failed: '麦克风未开启，本次不会自动重试',
};
let state = { configured: false, phase: 'unconfigured', message: '正在读取本机形象配置…', mode: 'render', conversation: { enabled: false, phase: 'idle' } };
let conversation = { state: 'idle', asr: 'off', transcript: '', reply: '', error: '' };
let instance;
let generation = 0;
let timeout;
let disposed = false;
let lease;
let mode = 'render';

function displayState() {
  const label = element('avatar-display-state');
  if (!label) return;
  const live = element('pet-toggle').classList.contains('is-cloud-avatar');
  label.textContent = live ? state.mode === 'conversation' && state.conversation.enabled ? defaultPet.name + ' · 星云实时对话'
    : defaultPet.name + ' · 星云实时 3D'
    : !element('model-pet').hidden ? '本地 3D 模型'
      : !element('custom-pet').hidden ? '本机原画桌宠'
        : !element('fallback-cat-pet').hasAttribute('hidden') ? '预览不可用 · 备用小橘猫'
          : '默认' + defaultPet.name + ' · 本地静态预览';
}

function visibility(visible) {
  surface.hidden = !visible;
  surface.style.visibility = visible ? 'visible' : 'hidden';
  element('pet-toggle').classList.toggle('is-cloud-avatar', visible);
  window.dispatchEvent(new CustomEvent('nuanban:avatar-visibility', { detail: { visible } }));
  displayState();
}

function conversationLive() {
  return mode === 'conversation' && Boolean(instance) && state.phase === 'ready' && !disposed;
}

function isCurrent(token, target) {
  return !disposed && token === generation && target === instance;
}

function renderConversation() {
  if (conversationStateLabel) {
    conversationStateLabel.textContent = conversation.error && conversation.state === 'error'
      ? conversation.error
      : CONVERSATION_LABELS[conversation.state] ?? CONVERSATION_LABELS.idle;
    conversationStateLabel.dataset.state = conversation.state;
    conversationStateLabel.dataset.asr = conversation.asr;
    conversationStateLabel.dataset.asrText = ASR_LABELS[conversation.asr] ?? ASR_LABELS.off;
  }
  if (conversationTranscriptLabel) conversationTranscriptLabel.textContent = conversation.transcript ? '我：' + conversation.transcript : '';
  if (conversationReplyLabel) conversationReplyLabel.textContent = conversation.reply ? defaultPet.name + '：' + conversation.reply : '';
}

// 识别文字、回答与状态只通过页面事件暴露；音频与提问仍由 SDK 直接送往星云，不写入本机日志。
function publishConversation(patch) {
  conversation = { ...conversation, ...patch };
  renderConversation();
  window.dispatchEvent(new CustomEvent('nuanban:avatar-conversation', { detail: {
    mode, generation, state: conversation.state, asr: conversation.asr,
    transcript: conversation.transcript, reply: conversation.reply, error: conversation.error,
  } }));
}

function receive(next) {
  if (disposed) return;
  const reported = next?.conversation && typeof next.conversation === 'object' ? next.conversation : {};
  state = { ...next, mode: next?.mode === 'conversation' ? 'conversation' : 'render',
    conversation: { enabled: reported.enabled === true, phase: typeof reported.phase === 'string' ? reported.phase : 'idle' } };
  if (['idle', 'error', 'stopping', 'cleanup_failed', 'unconfigured'].includes(state.phase) && instance) destroyLocal();
  if (mode === 'conversation' && !instance) {
    if (state.phase === 'cleanup_failed') publishConversation({ state: 'error', asr: 'off', error: '本机已停止显示，但星云未确认会话关闭；请重试停止，并在星云后台检查会话与计费。' });
    else if (['idle', 'unconfigured'].includes(state.phase) && !['idle', 'stopped'].includes(conversation.state)) publishConversation({ state: 'stopped', asr: 'off' });
    else if (state.phase === 'error') publishConversation({ state: 'error', asr: 'off', error: state.message });
  }
  render();
}

function render() {
  element('avatar-status').textContent = state.message;
  element('avatar-status').dataset.phase = state.phase;
  element('avatar-application').textContent = state.configured ? '应用 · ' + state.appId.slice(-8)
    : state.configurationMismatch ? '待切换至应用 · ' + defaultPet.application.editorId : '本机尚未配置应用';
  startButton.disabled = !state.configured || !consent.checked || !['idle', 'error'].includes(state.phase);
  startButton.textContent = state.phase === 'error' ? '本人重试连接' : '启用' + defaultPet.name;
  const stopping = ['connecting', 'ready', 'cleanup_failed'].includes(state.phase);
  const conversationRunning = mode === 'conversation' && (stopping || state.conversation.enabled);
  stopButton.disabled = !(stopping || state.conversation.enabled);
  stopButton.textContent = state.phase === 'cleanup_failed' ? '重试关闭云端会话' : conversationRunning ? '停止实时对话' : '停止并恢复原桌宠';
  progress.hidden = state.phase !== 'connecting';
  if (progress.hidden) element('avatar-download').textContent = '';
  for (const motion of motions) {
    const button = element(motion.button);
    if (button) button.disabled = state.phase !== 'ready' || !instance || mode === 'conversation';
  }
  if (conversationStartButton) conversationStartButton.disabled = !state.configured || !['idle', 'error'].includes(state.phase) || Boolean(instance);
  if (conversationStopButton) conversationStopButton.disabled = !conversationRunning;
  if (conversationListenButton) {
    conversationListenButton.hidden = !conversationLive();
    conversationListenButton.disabled = !conversationLive() || ['requesting', 'starting', 'stopping'].includes(conversation.asr);
    conversationListenButton.textContent = conversation.asr === 'listening' ? '暂停聆听' : '继续聆听';
  }
  if (conversationInterruptButton) {
    conversationInterruptButton.hidden = !conversationLive();
    conversationInterruptButton.disabled = !conversationLive();
  }
  const motionStatus = element('avatar-motion-status');
  if (motionStatus) {
    if (state.phase !== 'ready') motionStatus.textContent = '本地预览不包含星云动作。启用实时 3D 后，播放当前应用已发布的角色动作。';
    else if (mode === 'conversation') motionStatus.textContent = '实时对话进行中，动作由星云按对话状态播放；这里的按钮在对话期间不可用。';
    else if (motionStatus.dataset.phase !== 'ready') motionStatus.textContent = '实时 3D 已启用，由星云应用播放已发布的默认动作。点击桌宠可请求互动动作，也可在这里切换动作状态。';
    motionStatus.dataset.phase = state.phase;
  }
  renderConversation();
}

function playMotion(motion) {
  if (disposed || state.phase !== 'ready' || !instance || mode === 'conversation') return;
  const status = element('avatar-motion-status');
  try {
    if (typeof instance[motion.method] !== 'function') throw new Error('unsupported');
    instance[motion.method]();
    if (status) status.textContent = '已请求星云播放' + motion.label + '动作；具体效果以当前应用已发布的配置为准。聆听动作不会开启麦克风。';
  } catch {
    if (status) status.textContent = '本次动作未能发送，实时形象保持连接。请检查星云应用的动作配置与发布状态。';
  }
}

async function destroyInstance(previous, previousMode) {
  // 销毁路径必须确保 stopASR 先结束上行，再 destroy；两者都在 generation 失效之后执行，迟到回调不会再回到页面。
  if (previousMode === 'conversation' && typeof previous.stopASR === 'function') {
    try { await previous.stopASR(); } catch {}
  }
  try { await previous.destroy('user'); } catch {}
}

function destroyLocal() {
  const previous = instance;
  const previousMode = mode;
  generation++;
  clearTimeout(timeout);
  visibility(false);
  instance = undefined;
  if (previous) void destroyInstance(previous, previousMode);
}

async function startListening(token, target) {
  if (!isCurrent(token, target) || mode !== 'conversation') return;
  const asr = typeof target.getASRState === 'function' ? target.getASRState() : 'idle';
  if (['listening', 'starting', 'requesting-permission', 'stopping'].includes(asr)) return;
  publishConversation({ state: 'listening', asr: 'starting', error: '' });
  try {
    await target.startASR();
    if (!isCurrent(token, target)) return;
    publishConversation({ state: 'listening', asr: 'listening' });
  } catch {
    if (!isCurrent(token, target)) return;
    publishConversation({ state: 'error', asr: 'failed', error: '本次未能开启麦克风：请检查系统麦克风权限后重新开启实时对话。' });
  }
}

async function stopListening() {
  const target = instance;
  const token = generation;
  if (!target || mode !== 'conversation') return;
  publishConversation({ asr: 'stopping' });
  try { await target.stopASR(); } catch {}
  if (!isCurrent(token, target)) return;
  publishConversation({ asr: 'off', state: ['listening', 'thinking', 'speaking'].includes(conversation.state) ? 'paused' : conversation.state });
}

const nativeFetch = window.fetch.bind(window);
async function sessionFetch(resource, options) {
  const url = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
  if (!url.startsWith('https://nuanban-xingyun.invalid/')) return nativeFetch(resource, options);
  const parsed = new URL(url);
  if (parsed.pathname !== '/session' || !['POST', 'DELETE'].includes(options?.method) || options.body?.length > 16384) throw new Error('形象请求无效');
  if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
  const reply = await bridge.exchange(parsed.searchParams.get('lease'), { method: options.method, body: JSON.parse(options.body ?? '{}') });
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
}

async function start(nextMode = 'render') {
  if (disposed || instance) return;
  const conversationMode = nextMode === 'conversation';
  if (!conversationMode && startButton.disabled) return;
  if (conversationMode && (!conversationStartButton || conversationStartButton.disabled)) return;
  if (!conversationMode) consent.checked = false;
  if (conversationMode) {
    // 对话模式必须先由本人在原生对话框确认：麦克风音频上传、星云回答、平台计费、停止即结束。
    mode = 'conversation';
    let accepted = false;
    try { accepted = typeof bridge?.confirmConversation === 'function' && await bridge.confirmConversation() === true; } catch { accepted = false; }
    if (accepted !== true) {
      publishConversation({ state: 'cancelled', asr: 'off', error: '' });
      mode = 'render';
      return;
    }
  }
  const current = ++generation;
  mode = conversationMode ? 'conversation' : 'render';
  conversation = { state: conversationMode ? 'connecting' : 'idle', asr: 'off', transcript: '', reply: '', error: '' };
  renderConversation();
  state = { ...state, phase: 'connecting', message: conversationMode ? '正在向主进程请求本次实时对话会话…' : '正在向主进程请求本次形象连接…' };
  progress.value = 0;
  render();
  let currentLease;
  let currentInstance;
  try {
    const session = await bridge.begin(true, mode);
    currentLease = session.lease;
    lease = currentLease;
    if (disposed || current !== generation) { await bridge.stop(); return; }
    let initialized = false;
    let rendered = false;
    let markedReady = false;
    let reportingFailure = false;
    const fail = kind => {
      if (disposed || current !== generation || reportingFailure) return;
      reportingFailure = true;
      if (conversationMode) publishConversation({ state: 'error', asr: 'off', error: '实时对话未能建立或已中断；不会自动重连，请检查网络与麦克风权限后重试。' });
      destroyLocal();
      void bridge.fail(currentLease, kind).then(receive).catch(() => {
        receive({ ...state, phase: 'cleanup_failed', message: '形象停止尚未确认，请重试停止或在星云后台检查会话。' });
      });
    };
    const markReady = () => {
      if (!initialized || !rendered || markedReady || disposed || current !== generation) return;
      markedReady = true;
      clearTimeout(timeout);
      void bridge.ready(currentLease).then(accepted => {
        if (!accepted || disposed || current !== generation) return;
        visibility(true);
        if (conversationMode) void startListening(current, currentInstance);
      }).catch(() => fail('load_failed'));
    };
    timeout = setTimeout(() => fail('timeout'), 120000);
    const { default: XingyunAvatarAgent } = await import('@xmov/avatar/agent');
    if (disposed || current !== generation) return;
    container.replaceChildren();
    surface.hidden = false;
    surface.style.visibility = 'hidden';
    const created = new XingyunAvatarAgent({
      containerId: '#xingyun-canvas', container,
      appId: session.appId, appSecret: 'main-process-signing-only',
      gatewayServer: session.gatewayServer + '?lease=' + encodeURIComponent(currentLease),
      audio: { inputEnabled: conversationMode }, reconnect: { enabled: false, maxAttempts: 0 },
      features: conversationMode
        ? { auto_send_asr_to_llm: true, speech_frontend: { enabled: true, enable_aec: true } }
        : { auto_send_asr_to_llm: false, speech_frontend: { enabled: false } },
      sentry: { enabled: false }, enableLogger: false, enableDebugger: false,
      useAlphaMask: true, scaleDownBy: 2,
      onMessage: error => { if (![50002, 30001].includes(Number(error.code))) fail('load_failed'); },
      onRenderChange: renderState => { if (['rendering', 'resumed'].includes(renderState)) { rendered = true; markReady(); } },
      agentCallbacks: conversationMode ? {
        onAgentStateChange: agentState => { if (['failed', 'reconnecting'].includes(agentState)) fail('load_failed'); },
        onSocketStateChange: socketState => { if (['closed', 'error'].includes(socketState)) fail('load_failed'); },
        onError: error => { if (![50002, 30001].includes(Number(error.code))) fail('load_failed'); },
        onASRStateChange: asrState => {
          if (!isCurrent(current, currentInstance)) return;
          const mapped = { 'requesting-permission': 'requesting', starting: 'starting', listening: 'listening', stopping: 'stopping', idle: 'off', failed: 'failed' }[asrState] ?? 'off';
          if (mapped === 'off' && conversation.asr === 'off') return;
          publishConversation({ asr: mapped, state: mapped === 'listening' ? 'listening' : mapped === 'failed' ? 'error' : conversation.state,
            error: mapped === 'failed' ? '麦克风已停止：请检查系统麦克风权限后重新开启实时对话。' : '' });
        },
        onASRResult: result => {
          if (!isCurrent(current, currentInstance)) return;
          const text = typeof result?.text === 'string' ? result.text.slice(0, 500) : '';
          if (!text) return;
          publishConversation({ transcript: text, state: result.isFinal ? 'thinking' : conversation.state });
        },
        onLLMResponse: response => {
          if (!isCurrent(current, currentInstance)) return;
          const text = typeof response?.text === 'string' ? response.text : '';
          if (response?.event !== 'chunk' || !text) return;
          publishConversation({ reply: (conversation.reply + text).slice(0, 2000), state: 'speaking' });
        },
        onConversationChange: event => {
          if (!isCurrent(current, currentInstance)) return;
          const mapped = { asking: 'thinking', 'speaking-directly': 'speaking', speaking: 'speaking', completed: 'listening', interrupted: 'listening', failed: 'error' }[event?.state];
          if (!mapped) return;
          publishConversation({ state: mapped, ...(mapped === 'speaking' && typeof event.text === 'string' && event.text ? { reply: event.text.slice(0, 2000) } : {}) });
        },
        onSpeakStateChange: event => {
          if (!isCurrent(current, currentInstance)) return;
          const value = String(event?.state ?? '');
          if (value.includes('start')) publishConversation({ state: 'speaking' });
          else if (value.includes('end') || value.includes('complete') || value.includes('stop')) publishConversation({ state: conversation.asr === 'listening' ? 'listening' : 'paused' });
        },
      } : {
        onAgentStateChange: agentState => { if (['failed', 'reconnecting'].includes(agentState)) fail('load_failed'); },
        onSocketStateChange: socketState => { if (['closed', 'error'].includes(socketState)) fail('load_failed'); },
        onError: error => { if (![50002, 30001].includes(Number(error.code))) fail('load_failed'); },
      },
    });
    if (disposed || current !== generation) { void created.destroy('load_failed').catch(() => {}); return; }
    instance = created;
    currentInstance = created;
    currentInstance.setVolume(conversationMode ? 1 : 0);
    await currentInstance.init({ useAlphaMask: true, scaleDownBy: 2, onDownloadProgress: value => {
      if (disposed || current !== generation) return;
      progress.value = Math.min(100, Math.max(0, Number(value) || 0));
      element('avatar-download').textContent = '形象资源加载 · ' + Math.round(progress.value) + '%';
    } });
    if (disposed || current !== generation) return;
    initialized = true;
    markReady();
  } catch {
    if (disposed || current !== generation) return;
    if (conversationMode) publishConversation({ state: 'error', asr: 'off', error: '实时对话未能建立；不会自动重连，请检查网络与麦克风权限后重试。' });
    destroyLocal();
    try { receive(currentLease ? await bridge.fail(currentLease, 'load_failed') : await bridge.status()); }
    catch { receive({ ...state, phase: 'error', message: '本次连接未完成；不会自动重连，请检查本机配置或网络后重试。' }); }
  }
}

async function stop() {
  const wasConversation = mode === 'conversation';
  destroyLocal();
  if (wasConversation) publishConversation({ state: 'stopping', asr: 'off', transcript: '', reply: '' });
  state = { ...state, phase: 'stopping', message: wasConversation ? '正在结束实时对话并确认星云会话关闭…' : '正在确认星云会话停止…' };
  render();
  try {
    const result = await bridge.stop();
    receive(result);
    if (wasConversation) publishConversation({ state: result?.stopped === true ? 'stopped' : 'error', asr: 'off',
      ...(result?.stopped === true ? {} : { error: result?.message || '星云未确认会话关闭，请重试停止。' }) });
  } catch {
    receive({ ...state, phase: 'cleanup_failed', message: '停止未确认，请重试停止并检查星云后台会话。' });
    if (wasConversation) publishConversation({ state: 'error', asr: 'off', error: '本机已停止显示，但星云未确认会话关闭；请重试停止，并在星云后台检查会话与计费。' });
  }
}

function conversationCommand(event) {
  const action = event?.detail?.action;
  if (disposed || mode !== 'conversation' || !instance) return;
  if (action === 'interrupt') {
    try { instance.interrupt(); publishConversation({ state: conversation.asr === 'listening' ? 'listening' : conversation.state }); } catch {}
    return;
  }
  if (action === 'start-asr') { void startListening(generation, instance); return; }
  if (action === 'stop-asr') { void stopListening(); }
}

if (bridge && container && surface && startButton && stopButton && consent) {
  const sourceObserver = new MutationObserver(displayState);
  sourceObserver.observe(element('pet-toggle'), { attributes: true, attributeFilter: ['hidden'], subtree: true });
  displayState();
  window.fetch = sessionFetch;
  const unsubscribe = bridge.onState(receive);
  startButton.addEventListener('click', () => { void start('render'); });
  stopButton.addEventListener('click', () => { void stop(); });
  consent.addEventListener('change', render);
  conversationStartButton?.addEventListener('click', () => { void start('conversation'); });
  conversationStopButton?.addEventListener('click', () => { void stop(); });
  conversationListenButton?.addEventListener('click', () => {
    if (conversation.asr === 'listening') void stopListening();
    else void startListening(generation, instance);
  });
  conversationInterruptButton?.addEventListener('click', () => conversationCommand({ detail: { action: 'interrupt' } }));
  window.addEventListener('nuanban:avatar-conversation-command', conversationCommand);
  for (const motion of motions) element(motion.button)?.addEventListener('click', () => playMotion(motion));
  window.addEventListener('nuanban:avatar-interaction', () => playMotion(motions[1]));
  renderConversation();
  void bridge.status().then(receive).catch(() => receive({ ...state, phase: 'error', message: '本机形象配置读取失败，原桌宠保持不变。' }));
  window.addEventListener('offline', () => { if (lease && instance) { const failedLease = lease; destroyLocal(); void bridge.fail(failedLease, 'load_failed').then(receive).catch(() => {}); } });
  window.addEventListener('pagehide', () => { disposed = true; destroyLocal(); sourceObserver.disconnect(); unsubscribe(); void bridge.stop().catch(() => {}); }, { once: true });
} else if (startButton) {
  receive({ ...state, phase: 'unconfigured', message: '请在独立桌宠中使用。浏览器预览不会连接形象服务。' });
}