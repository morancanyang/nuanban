const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nuanbanCompanion', Object.freeze({
  showLili: async () => {
    try { return await ipcRenderer.invoke('nuanban:companion:show-lili'); }
    catch (error) {
      const message = typeof error?.message === 'string' ? error.message.replace(/^Error invoking remote method 'nuanban:companion:show-lili': (?:Error: )?/, '') : '';
      throw new Error(message || '栗栗桌宠调用未完成，请重试。');
    }
  },
}));
contextBridge.exposeInMainWorld('nuanbanWorkspace', Object.freeze({
  status: async () => {
    const mode = await ipcRenderer.invoke('nuanban:workspace:status');
    if (!['management', 'pet-tool'].includes(mode)) throw new Error('桌宠工具状态未确认');
    return mode;
  },
  onMode: listener => {
    if (typeof listener !== 'function') throw new TypeError('工作区监听器必须是函数');
    const handler = (_event, mode) => { if (['management', 'pet-tool'].includes(mode)) listener(mode); };
    ipcRenderer.on('nuanban:workspace:mode', handler);
    let subscribed = true;
    return () => { if (subscribed) { subscribed = false; ipcRenderer.removeListener('nuanban:workspace:mode', handler); } };
  },
  returnToPet: () => ipcRenderer.invoke('nuanban:workspace:return-pet'),
}));
contextBridge.exposeInMainWorld('nuanbanTextQuestion', Object.freeze({
  status: async () => {
    try {
      const status = await ipcRenderer.invoke('nuanban:text-question:status');
      return { available: status?.available === true };
    } catch { return { available: false }; }
  },
  answer: input => ipcRenderer.invoke('nuanban:text-question:answer', input),
  cancel: requestId => ipcRenderer.invoke('nuanban:text-question:cancel', requestId),
}));
async function invokeModel(channel, ...argumentsList) {
  try { return await ipcRenderer.invoke(channel, ...argumentsList); } catch (error) {
    const message = typeof error?.message === 'string' ? error.message.replace(/^Error invoking remote method 'nuanban:model:(?:read|choose|apply|clear|discard|read-builtin|apply-builtin)': (?:Error: )?/, '') : '';
    throw new Error(message || '本机模型操作未完成，请重试');
  }
}
contextBridge.exposeInMainWorld('nuanbanModel', Object.freeze({
  read: () => invokeModel('nuanban:model:read'),
  choose: () => invokeModel('nuanban:model:choose'),
  readBuiltin: id => invokeModel('nuanban:model:read-builtin', ['lumi', 'lili', 'lili-natural-v4'].includes(id) ? id : null),
  applyBuiltin: id => invokeModel('nuanban:model:apply-builtin', ['lumi', 'lili', 'lili-natural-v4'].includes(id) ? id : null),
  apply: token => invokeModel('nuanban:model:apply', typeof token === 'string' ? token : null),
  clear: () => invokeModel('nuanban:model:clear'),
  discard: () => invokeModel('nuanban:model:discard'),
  onChanged: listener => {
    if (typeof listener !== 'function') throw new TypeError('模型监听器必须是函数');
    const handler = (_event, model) => listener(model);
    ipcRenderer.on('nuanban:model:changed', handler);
    return () => ipcRenderer.removeListener('nuanban:model:changed', handler);
  },
}));
contextBridge.exposeInMainWorld('nuanbanImageQuestion', Object.freeze({
  status: () => ipcRenderer.invoke('nuanban:image-question:status'),
  answer: input => ipcRenderer.invoke('nuanban:image-question:answer', input),
  cancel: requestId => ipcRenderer.invoke('nuanban:image-question:cancel', requestId),
}));
contextBridge.exposeInMainWorld('nuanbanVoice', Object.freeze({
  status: () => ipcRenderer.invoke('nuanban:voice:status'),
  dictate: () => ipcRenderer.invoke('nuanban:voice:dictate'),
  cancelDictation: () => ipcRenderer.invoke('nuanban:voice:cancel-dictation'),
  enable: () => ipcRenderer.invoke('nuanban:voice:enable'),
  disable: () => ipcRenderer.invoke('nuanban:voice:disable'),
  openSettings: () => ipcRenderer.invoke('nuanban:voice:open-settings'),
  setCloudDictation: enabled => ipcRenderer.invoke('nuanban:voice:set-cloud-dictation', enabled === true),
}));
contextBridge.exposeInMainWorld('nuanbanObservation', Object.freeze({
  status: () => ipcRenderer.invoke('nuanban:observation:status'),
  start: () => ipcRenderer.invoke('nuanban:observation:start'),
  resume: () => ipcRenderer.invoke('nuanban:observation:resume'),
  stop: () => ipcRenderer.invoke('nuanban:observation:stop'),
  showPet: () => ipcRenderer.invoke('nuanban:observation:show-pet'),
}));
async function invokeArtwork(channel, ...argumentsList) {
  try { return await ipcRenderer.invoke(channel, ...argumentsList); } catch (error) {
    const message = typeof error?.message === 'string' ? error.message.replace(/^Error invoking remote method 'nuanban:artwork:(?:read|apply|clear)': (?:Error: )?/, '') : '';
    throw new Error(message || '本机原画操作未完成，请重试。');
  }
}
contextBridge.exposeInMainWorld('nuanbanArtwork', Object.freeze({
  read: () => invokeArtwork('nuanban:artwork:read'),
  apply: artwork => invokeArtwork('nuanban:artwork:apply', { dataUrl: artwork?.dataUrl, width: artwork?.width, height: artwork?.height }),
  clear: () => invokeArtwork('nuanban:artwork:clear'),
  onChanged: listener => {
    if (typeof listener !== 'function') throw new TypeError('原画监听器必须是函数');
    const handler = (_event, artwork) => listener(artwork);
    ipcRenderer.on('nuanban:artwork:changed', handler);
    return () => ipcRenderer.removeListener('nuanban:artwork:changed', handler);
  },
}));
const lifecycleEvents = new Set(['nuanban:host-before-quit','nuanban:host-renderer-gone','nuanban:host-window-moved','nuanban:host-recursive-capture']);
ipcRenderer.on('nuanban:lifecycle', (_event, name) => {
  if (lifecycleEvents.has(name)) window.dispatchEvent(new Event(name));
});
ipcRenderer.on('nuanban:reminder-open', (_event, detail) => {
  if (detail && typeof detail.deepLink === 'string') window.dispatchEvent(new CustomEvent('nuanban:reminder-open', { detail: { deepLink: detail.deepLink } }));
});
const reminderStore = Object.freeze({
  schedule: input => ipcRenderer.invoke('nuanban:reminders:schedule', input),
  read: (accountId, reminderId) => ipcRenderer.invoke('nuanban:reminders:read', accountId, reminderId),
  list: accountId => ipcRenderer.invoke('nuanban:reminders:list', accountId),
  cancel: input => ipcRenderer.invoke('nuanban:reminders:cancel', input),
  submitDue: input => ipcRenderer.invoke('nuanban:reminders:submit-due', input),
  recordReceipt: input => ipcRenderer.invoke('nuanban:reminders:receipt', input),
  complete: input => ipcRenderer.invoke('nuanban:reminders:complete', input),
  notifyDue: input => ipcRenderer.invoke('nuanban:reminders:notify-due', input),
});
contextBridge.exposeInMainWorld('nuanbanHost',Object.freeze({ platform:'windows', capabilities:()=>ipcRenderer.invoke('nuanban:capabilities'), stopAll:()=>ipcRenderer.invoke('nuanban:stop'), reminderStore }));
