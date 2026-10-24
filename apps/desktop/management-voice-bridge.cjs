const { registerDictationBridge } = require('./wake/dictation-bridge.cjs');
const phases = new Set(['disabled', 'starting', 'listening', 'question', 'stopping', 'unavailable', 'error']);

function registerManagementVoiceBridge({ ipcMain, isTrusted, getHost, openMicrophoneSettings }) {
  const channels = [];
  const dictation = registerDictationBridge({ ipcMain, prefix: 'nuanban:voice', isTrusted, getHost });

  function hostFor(event, argumentsList) {
    if (!isTrusted(event)) throw new Error('不可信语音入口');
    if (argumentsList.length !== 0) throw new Error('麦克风授权必须由本人在原生窗口确认');
    const host = getHost();
    if (!host || !host.hasPetWindow()) throw new Error('独立桌宠尚未就绪');
    return host;
  }

  function status(host) {
    const wake = host.snapshot().wake;
    if (!wake || !phases.has(wake.phase) || typeof wake.enabled !== 'boolean' || typeof wake.microphoneActive !== 'boolean'
      || typeof wake.dictationAvailable !== 'boolean' || wake.localOnly !== true || typeof wake.reason !== 'string') throw new Error('本地语音状态未确认');
    const cloud = wake.cloudDictation;
    if (!cloud || typeof cloud.enabled !== 'boolean' || typeof cloud.available !== 'boolean') throw new Error('云端听写状态未确认');
    return Object.freeze({ phase: wake.phase, enabled: wake.enabled, microphoneActive: wake.microphoneActive,
      dictationAvailable: wake.dictationAvailable, localOnly: true, message: wake.reason.slice(0, 500),
      cloudDictation: Object.freeze({ enabled: cloud.enabled, available: cloud.available }) });
  }

  function handle(channel, action) {
    channels.push(channel);
    ipcMain.handle(channel, (event, ...argumentsList) => action(hostFor(event, argumentsList)));
  }

  handle('nuanban:voice:status', status);
  handle('nuanban:voice:enable', async host => {
    host.showPetPanel();
    await host.requestLocalVoice();
    return status(host);
  });
  handle('nuanban:voice:disable', async host => { await host.stopLocalVoice(); return status(host); });
  ipcMain.handle('nuanban:voice:set-cloud-dictation', async (event, enabled) => {
    if (!isTrusted(event)) throw new Error('不可信语音入口');
    const host = getHost();
    if (!host || !host.hasPetWindow() || typeof host.setCloudDictation !== 'function') throw new Error('独立桌宠尚未就绪');
    const next = await host.setCloudDictation(enabled === true);
    return Object.freeze({ enabled: next.enabled === true });
  });
  channels.push('nuanban:voice:set-cloud-dictation');
  handle('nuanban:voice:open-settings', async () => {
    if (typeof openMicrophoneSettings !== 'function') throw new Error('请在 Windows 设置中手动打开麦克风隐私页');
    await openMicrophoneSettings();
    return true;
  });

  return { dispose() { dictation.dispose(); for (const channel of channels.splice(0)) ipcMain.removeHandler(channel); } };
}

module.exports = { registerManagementVoiceBridge };
