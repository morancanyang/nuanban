const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { createLocalConversation } = require('./local-conversation.cjs');
const { contentProtectionRequired } = require('../capture-visibility.cjs');

function createLocalVoiceHost({ electron, showDialog, beforeStart = async () => {}, onState = () => {}, onTranscript = () => {}, presentation = 'window', provider, contentProtected = contentProtectionRequired(process.argv, 'pet'), createConversation = createLocalConversation }) {
  if (!['window', 'pet'].includes(presentation)) throw new TypeError('语音显示方式无效');
  const { BrowserWindow, ipcMain, session, screen } = electron;
  const page = path.join(__dirname, '..', 'realtime-voice.html');
  const pageUrl = pathToFileURL(page).href;
  const channels = [];
  let window = null;
  let conversation = null;
  let controller = null;
  let cleanup = null;
  let generation = 0;
  let disposed = false;
  let started = false;
  let state = 'off';
  let message = '使用本机识别与朗读，复用已有文字模型；无需另开实时语音账号。';
  const live = () => Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed());
  const snapshot = () => ({ state, configured: true, mode: 'local', active: Boolean(controller) || live() || !['off', 'error'].includes(state),
    microphoneActive: conversation?.snapshot().microphoneActive === true, message });
  function publish() { onState(snapshot()); }

  function stop(reason = 'user') {
    if (cleanup) return cleanup;
    generation += 1;
    controller?.abort();
    state = 'stopping';
    message = '正在等待本地麦克风和朗读进程实际退出…';
    publish();
    cleanup = Promise.resolve().then(async () => {
      const result = await conversation?.stop();
      if (conversation && (result?.stopped !== true || result.microphoneActive !== false || conversation.snapshot().microphoneActive)) throw new Error('本地麦克风停止尚未确认');
      if (window && !window.isDestroyed()) window.destroy();
      if (live()) throw new Error('语音窗口尚未关闭');
      window = null;
      conversation = null;
      controller = null;
      started = false;
      state = 'off';
      message = reason === 'user' ? '对话已结束，本地麦克风、朗读与文字请求已停止。' : '语音已停止，不会自动重连或恢复本地唤醒。';
      publish();
      return { stopped: true, microphoneActive: false };
    }).catch(() => {
      state = 'error';
      message = '停止尚未确认，请重试停止或退出桌宠。';
      publish();
      return { stopped: false, microphoneActive: conversation?.snapshot().microphoneActive === true };
    }).finally(() => { cleanup = null; });
    return cleanup;
  }

  async function fail() {
    const result = await stop('error');
    if (!result.stopped) return;
    state = 'error';
    message = '本地语音已停止，请检查 Windows 麦克风权限、中文语音组件、已有文字模型网络及额度。';
    publish();
    await showDialog({ type: 'warning', title: '本地语音已停止', message,
      detail: '未自动重连，也没有切换到其他语音服务或后台常听。请从桌宠手动重试。', buttons: ['知道了'] });
  }

  function handle(name, count, action) {
    const channel = 'nuanban:voice-chat:' + name;
    channels.push(channel);
    ipcMain.handle(channel, (event, ...args) => {
      if (disposed || !live() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageUrl || args.length !== count) throw new Error('不可信语音会话入口');
      return action(...args);
    });
  }
  async function control(action) {
    if (!controller || controller.signal.aborted || cleanup) throw new Error('本次语音会话已结束');
    if (action === 'start' && !started) { started = true; return conversation.start({ actor: 'owner', confirmed: true }); }
    if (!started) throw new Error('本地语音尚未开始');
    if (action === 'mute' || action === 'unmute') return conversation.setMuted(action === 'mute');
    if (action === 'interrupt') return conversation.interrupt();
    throw new Error('语音操作无效');
  }
  handle('mode', 0, () => ({ mode: 'local' }));
  handle('local-control', 1, control);
  handle('stop', 0, () => stop());
  handle('failed', 0, () => { void fail().catch(() => {}); return true; });

  async function open() {
    if (disposed) throw new Error('桌宠正在退出');
    if (cleanup) return;
    if (controller || live()) { if (presentation === 'window' && live()) { window.show(); window.focus(); } return; }
    if (!['off', 'error'].includes(state)) return;
    const current = ++generation;
    controller = new AbortController();
    const request = controller;
    const valid = () => !disposed && current === generation && !request.signal.aborted;
    state = 'confirming';
    message = '正在等待本人确认本地语音与文字模型用途；麦克风尚未开启。';
    publish();
    try {
      const confirmation = await showDialog({ type: 'question', title: '开启本地语音对话 · 无需新增语音账号',
        message: '允许本次在本机听写、朗读，并将识别文字发送给已配置的文字模型吗？',
        detail: '不需要 OpenAI 实时语音账号或单独语音密钥。原始音频不上传、不保存；识别后的文字及少量本次上下文会自动发送给现有文字模型，仍需要其网络与额度，不能保证免费或完全离线。基础敏感拦截不能识别所有隐私，请勿说出密码、验证码、电话等个人信息。\n\n说完稍停，暖暖会朗读回答；朗读时暂停听写，避免把自己的声音当成问题，可点击“打断暖暖”继续说。不申请摄像头、不读取屏幕、不操作电脑。本地唤醒会先停止且结束后不自动恢复；静音、结束、关闭、锁屏或退出会关闭本地麦克风。每次最多15分钟，网络失败不自动重连。',
        buttons: ['本人同意，开始语音', '暂不开启'], defaultId: 1, cancelId: 1, noLink: true });
      if (!valid()) return;
      if (confirmation.response !== 0) { await stop(); return; }
      state = 'connecting';
      message = '正在检查本机中文听写与朗读组件；麦克风尚未开启。';
      publish();
      await beforeStart();
      if (!valid()) return;
      conversation = createConversation({ provider, onEvent: event => {
        if (!valid()) return;
        if (event.type === 'state') {
          state = event.state;
          message = state === 'muted' ? '已暂停本次对话，本地麦克风已关闭。' : '本机听写与朗读，文字由已有模型回答；不使用额外语音账号。';
          publish();
        }
        if (event.type === 'transcript') onTranscript(event);
        if (live()) window.webContents.send('nuanban:voice-chat:event', event);
      }, onError: () => { if (valid()) void fail().catch(() => {}); }, onEnd: () => { if (valid()) void stop('duration'); } });
      await conversation.probe({ signal: request.signal });
      if (!valid()) return;
      if (presentation === 'pet') {
        await control('start');
        if (valid()) publish();
        return;
      }
      const privateSession = session.fromPartition('nuanban-local-voice-' + randomUUID(), { cache: false });
      privateSession.setPermissionCheckHandler(() => false);
      privateSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      privateSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      privateSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
      const area = screen.getPrimaryDisplay().workArea;
      window = new BrowserWindow({ width: Math.min(480, area.width), height: Math.min(760, area.height), minWidth: 320, minHeight: 480,
        title: '微光指引 · 本地语音对话', show: false, backgroundColor: '#fff8ed', alwaysOnTop: true, autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, '..', 'realtime-voice-preload.cjs'), session: privateSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
      const opened = window;
      opened.setContentProtection(contentProtected === true);
      opened.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      opened.webContents.on('will-navigate', event => { event.preventDefault(); void stop('navigation'); });
      opened.webContents.on('will-attach-webview', event => event.preventDefault());
      opened.webContents.on('render-process-gone', () => { if (valid()) void fail().catch(() => {}); });
      opened.on('unresponsive', () => { if (valid()) void fail().catch(() => {}); });
      opened.on('close', event => { if (valid()) { event.preventDefault(); void stop(); } });
      opened.on('closed', () => { if (valid()) void stop(); });
      await opened.loadFile(page);
      if (valid() && live()) { opened.show(); publish(); }
    } catch {
      if (!valid()) return;
      await stop('error');
      state = 'error';
      message = '本地语音尚未开启，请检查本机中文语音组件和已有文字模型配置。';
      publish();
      throw new Error('本机中文听写或朗读未就绪，未开启麦克风；请检查 Windows 中文语音组件。');
    }
  }

  return { open, stop, control, snapshot, async dispose() {
    disposed = true;
    const result = await stop('exit');
    if (result.stopped) for (const channel of channels.splice(0)) ipcMain.removeHandler(channel);
    return result;
  } };
}

module.exports = { createLocalVoiceHost };
