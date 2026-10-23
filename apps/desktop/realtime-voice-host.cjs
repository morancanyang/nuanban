const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { createRealtimeVoiceClient, audioOnlySdp } = require('./realtime-voice-client.cjs');
const { createLocalVoiceHost } = require('./voice/local-voice-host.cjs');
const { contentProtectionRequired } = require('./capture-visibility.cjs');

function createRealtimeVoiceHost({ electron, showDialog, beforeStart, onState = () => {}, onTranscript = () => {}, presentation = 'window', client = createRealtimeVoiceClient(), provider, contentProtected = contentProtectionRequired(process.argv, 'pet') }) {
  if (!['window', 'pet'].includes(presentation)) throw new TypeError('语音显示方式无效');
  if (!client.status().configured && process.platform === 'win32' && typeof provider?.answer === 'function') {
    return createLocalVoiceHost({ electron, showDialog, beforeStart, onState, onTranscript, presentation, provider, contentProtected });
  }
  const { BrowserWindow, ipcMain, session, screen } = electron;
  const page = path.join(__dirname, 'realtime-voice.html');
  const pageUrl = pathToFileURL(page).href;
  const channels = [];
  let voiceWindow = null;
  let privateSession = null;
  let controller = null;
  let generation = 0;
  let disposed = false;
  let offered = false;
  let state = 'off';
  let message = '面对面语音未开启；点击并单独同意后才能使用麦克风。';

  const live = () => Boolean(voiceWindow && !voiceWindow.isDestroyed() && !voiceWindow.webContents.isDestroyed());
  const snapshot = () => ({ state, active: live() || !['off', 'error'].includes(state), microphoneActive: live(),
    message: !client.status().configured && state === 'off' ? '面对面语音待配置真实服务；麦克风未开启，不使用模拟回答。' : message,
    configured: client.status().configured === true });
  function publish() { onState(snapshot()); }
  const trusted = event => live() && event.sender === voiceWindow.webContents && event.senderFrame === voiceWindow.webContents.mainFrame
    && event.senderFrame.url === pageUrl;

  function stop(reason = 'user') {
    generation += 1;
    controller?.abort();
    controller = null;
    offered = false;
    state = 'off';
    message = reason === 'user' ? '对话已结束，麦克风和语音连接已关闭。' : '语音已停止；再次对话需要本人重新开启，不自动重连。';
    if (privateSession) {
      privateSession.setPermissionCheckHandler(() => false);
      privateSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    }
    const previous = voiceWindow;
    try { if (previous && !previous.isDestroyed()) previous.destroy(); } catch {}
    if (previous && !previous.isDestroyed()) {
      state = 'error';
      message = '语音窗口尚未真实停止，请重试停止或退出桌宠。';
      publish();
      return { stopped: false, microphoneActive: true };
    }
    voiceWindow = null;
    privateSession = null;
    publish();
    return { stopped: true, microphoneActive: false };
  }

  function fail() {
    const result = stop('error');
    if (!result.stopped) return;
    state = 'error';
    message = '实时语音已停止。请检查麦克风、网络、语音服务配置和额度，然后从桌宠手动重试。';
    publish();
    void Promise.resolve(showDialog({ type: 'warning', title: '实时语音已停止', message,
      detail: '没有自动重连，也没有转为后台常听。推荐使用耳机，检查 Windows 麦克风权限。', buttons: ['知道了'] })).catch(() => {});
  }

  function handle(name, count, action) {
    const channel = 'nuanban:voice-chat:' + name;
    channels.push(channel);
    ipcMain.handle(channel, (event, ...argumentsList) => {
      if (disposed || !trusted(event) || argumentsList.length !== count) throw new Error('不可信语音会话入口');
      return action(...argumentsList);
    });
  }

  handle('mode', 0, () => ({ mode: 'realtime', ...(presentation === 'pet' ? { presentation: 'pet' } : {}) }));
  handle('transcript', 1, value => {
    if (!offered || !controller || controller.signal.aborted || !value || !['user', 'assistant'].includes(value.role)
      || typeof value.id !== 'string' || value.id.length > 220 || typeof value.text !== 'string' || value.text.length > 6000) throw new Error('语音字幕无效');
    onTranscript({ type: 'transcript', id: value.id, role: value.role, text: value.text });
    return true;
  });
  handle('connect', 1, async offer => {
    if (offered || !audioOnlySdp(offer) || !controller || controller.signal.aborted) throw new Error('语音会话已失效或已连接');
    offered = true;
    const current = generation;
    try {
      const result = await client.connect(offer, { signal: controller.signal });
      if (current !== generation || !live()) throw new Error('语音会话已结束');
      return result;
    } catch {
      if (current === generation) fail();
      throw new Error('实时语音连接未完成，麦克风已停止');
    }
  });
  handle('state', 1, next => {
    if (!offered || !['listening', 'thinking', 'speaking', 'muted'].includes(next)) throw new Error('语音状态无效');
    state = next;
    message = next === 'muted' ? '麦克风已静音，恢复后继续当前对话。' : '面对面实时语音进行中，未开启摄像头或屏幕观察。';
    publish();
    return true;
  });
  handle('stop', 0, () => stop());
  handle('failed', 0, () => { fail(); return true; });

  function control(action) {
    if (presentation !== 'pet' || !live() || !controller || controller.signal.aborted
      || !['listening', 'thinking', 'speaking', 'muted'].includes(state) || !['mute', 'unmute', 'interrupt'].includes(action)) throw new Error('本次语音操作不可用');
    voiceWindow.webContents.send('nuanban:voice-chat:control', action);
    return { accepted: true };
  }

  async function open() {
    if (disposed) throw new Error('桌宠正在退出');
    if (live()) { if (presentation === 'window') { voiceWindow.show(); voiceWindow.focus(); } return; }
    if (!['off', 'error'].includes(state)) return;
    if (!client.status().configured) {
      await showDialog({ type: 'info', title: '面对面语音待配置', message: '真实语音服务尚未配置，麦克风没有开启。',
        detail: '桌宠需要微光指引后端地址 NUANBAN_DESKTOP_API_BASE_URL 和已认证设备的 NUANBAN_DESKTOP_API_TOKEN；后端另需 NUANBAN_REALTIME_API_KEY 与 NUANBAN_REALTIME_MODEL。\n\n供应密钥只配置在后端，不要填到设备令牌中，也不要发送到聊天里。配置后重新启动对应进程。不会用模拟回答假装已经接通。', buttons: ['知道了'] });
      return;
    }
    const current = ++generation;
    const requestController = new AbortController();
    controller = requestController;
    state = 'confirming';
    message = '正在等待本人确认语音用途；麦克风尚未开启。';
    publish();
    const valid = () => !disposed && current === generation && !requestController.signal.aborted;
    try {
      const confirmation = await showDialog({ type: 'question', title: '与暖暖面对面语音聊天', message: '允许本次对话使用麦克风，并将语音实时发送给 OpenAI 吗？',
        detail: '暖暖会直接用声音回答，可连续交流和打断。这是独立云端语音对话，不是本地唤醒：开启期间说出的内容会直接发送，音频不会先做本地脱敏，请勿说出密码、验证码等隐私。供应方按其数据政策处理数据，可能产生费用。\n\n不开摄像头、不读取屏幕、不操作电脑，不在本机保存录音或字幕。本地唤醒会先停止且结束后不自动恢复。结束、关闭对话窗、锁屏或退出桌宠立即停止；断线不自动重连。建议佩戴耳机。',
        buttons: ['本人同意，开始语音', '暂不开启'], defaultId: 1, cancelId: 1, noLink: true });
      if (!valid()) return;
      if (confirmation.response !== 0) { stop(); return; }
      state = 'connecting';
      message = '正在检查真实语音服务；麦克风尚未开启。';
      publish();
      await client.check({ signal: requestController.signal });
      if (!valid()) return;
      await beforeStart();
      if (!valid()) return;
      if (!session?.fromPartition) throw new Error('隔离音频会话不可用');
      privateSession = session.fromPartition('nuanban-voice-' + randomUUID(), { cache: false });
      const area = screen.getPrimaryDisplay().workArea;
      voiceWindow = new BrowserWindow({ width: Math.min(480, area.width), height: Math.min(760, area.height), minWidth: 320, minHeight: 480,
        title: '微光指引 · 面对面语音', show: false, backgroundColor: '#fff8ed', alwaysOnTop: true, autoHideMenuBar: true,
        skipTaskbar: presentation === 'pet',
        webPreferences: { preload: path.join(__dirname, 'realtime-voice-preload.cjs'), session: privateSession,
          sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
      const window = voiceWindow;
      const allowed = (contents, details) => valid() && live() && contents === window.webContents
        && window.webContents.mainFrame.url === pageUrl && details?.requestingUrl === pageUrl && details?.isMainFrame === true;
      privateSession.setPermissionCheckHandler((contents, permission, _origin, details) => permission === 'media'
        && details?.mediaType === 'audio' && allowed(contents, details));
      privateSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(permission === 'media'
        && allowed(contents, details) && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio'));
      privateSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      privateSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
      window.setContentProtection(contentProtected === true);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => { event.preventDefault(); stop('navigation'); });
      window.webContents.on('will-attach-webview', event => event.preventDefault());
      window.webContents.on('render-process-gone', () => { if (current === generation) fail(); });
      window.on('unresponsive', () => { if (current === generation) fail(); });
      window.on('close', () => { if (current === generation) stop(); });
      window.on('closed', () => { if (current === generation) stop(); });
      await window.loadFile(page);
      if (valid() && live()) { if (presentation === 'window') window.show(); publish(); }
    } catch (error) {
      if (valid()) {
        const result = stop('error');
        if (!result.stopped) throw new Error('语音窗口尚未停止，请重试停止或退出桌宠');
        state = 'error';
        message = '实时语音未开启，请检查服务端模型配置、设备令牌、网络及麦克风权限。';
        publish();
        throw error;
      }
    }
  }

  return { open, stop, control, snapshot, dispose() {
    disposed = true;
    const result = stop('exit');
    if (result.stopped) for (const channel of channels.splice(0)) ipcMain.removeHandler(channel);
    return result;
  } };
}

module.exports = { createRealtimeVoiceHost };
