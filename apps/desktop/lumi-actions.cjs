const { randomUUID } = require('node:crypto');

const modelHash = '14c6ac8e79fb51a1c4c7be44b63a4e78fdbf77599b93b7f90695f4d8fa782ead';
const actions = Object.freeze([
  { name: 'Idle_Breathe', durationMs: 4000, loop: true },
  { name: 'Blink_Soft', durationMs: 300, loop: false },
  { name: 'Listen_Curious', durationMs: 3000, loop: false },
  { name: 'Wave_Gentle', durationMs: 2500, loop: false },
  { name: 'Nod_Encourage', durationMs: 2000, loop: false },
  { name: 'Guide_Point', durationMs: 3000, loop: false },
  { name: 'Step_InPlace', durationMs: 2000, loop: true },
].map(Object.freeze));
const semantics = Object.freeze({ idle: 'Idle_Breathe', listening: 'Listen_Curious', greeting: 'Wave_Gentle',
  encouraging: 'Nod_Encourage', guiding: 'Guide_Point', walking: 'Step_InPlace', blink: 'Blink_Soft' });
const unavailable = () => ({ ok: false, code: 'unavailable', message: '自然动作版露米未显示或动作未确认，请先应用并等待桌宠就绪' });

function registerLumiActions({ ipcMain, isManagementTrusted, trustedPet, getPetWindow, getManagementWindow, getToolWindow, readModel, timeoutMs = 3000 }) {
  const pending = new Map();
  const channels = ['nuanban:lumi:describe', 'nuanban:lumi:play', 'nuanban:lumi:stop', 'nuanban:lumi:semantic', 'nuanban:lumi:complete'];
  let disposed = false;
  const requireTrusted = event => { if (!isManagementTrusted(event) && !trustedPet(event)) throw new Error('不可信露米动作来源'); };
  function invalidate() {
    for (const request of pending.values()) { clearTimeout(request.timer); request.resolve(unavailable()); }
    pending.clear();
  }
  function dispatch(event, action) {
    requireTrusted(event);
    const definition = actions.find(item => item.name === action);
    if (action !== 'stop' && !definition) return { ok: false, code: 'invalid', message: '未知露米动作' };
    const pet = getPetWindow();
    const model = readModel();
    if (disposed || model.kind !== 'model' || model.id !== modelHash || !pet || pet.isDestroyed() || pet.webContents.isDestroyed() || pending.size >= 16) return unavailable();
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { pending.delete(id); resolve(unavailable()); }, timeoutMs);
      pending.set(id, { resolve, timer, action, definition, sender: pet.webContents });
      try { pet.webContents.send('nuanban:lumi:action', { id, action, modelId: modelHash }); }
      catch { clearTimeout(timer); pending.delete(id); resolve(unavailable()); }
    });
  }
  ipcMain.handle(channels[0], event => { requireTrusted(event); return { id: 'lumi-animated-v4', version: '4.1.0', actions: actions.map(item => ({ ...item })) }; });
  ipcMain.handle(channels[1], (event, action, ...extra) => {
    requireTrusted(event);
    if (!actions.some(item => item.name === action)) return { ok: false, code: 'invalid', message: '未知露米动作' };
    return extra.length ? { ok: false, code: 'invalid', message: '动作不接受额外参数' } : dispatch(event, action);
  });
  ipcMain.handle(channels[2], (event, ...extra) => {
    requireTrusted(event);
    return extra.length ? { ok: false, code: 'invalid', message: '停止不接受额外参数' } : dispatch(event, 'stop');
  });
  ipcMain.handle(channels[3], (event, name, ...extra) => {
    requireTrusted(event);
    if (typeof name !== 'string' || !Object.hasOwn(semantics, name) || extra.length) return { ok: false, code: 'invalid', message: '未知露米语义' };
    return dispatch(event, semantics[name]);
  });
  ipcMain.handle(channels[4], (event, payload) => {
    if (!trustedPet(event)) throw new Error('仅桌宠渲染器可确认露米动作');
    if (!payload || typeof payload.id !== 'string' || typeof payload.ok !== 'boolean') return false;
    const request = pending.get(payload.id);
    if (!request || request.sender !== event.sender) return false;
    pending.delete(payload.id);
    clearTimeout(request.timer);
    const model = readModel();
    const result = payload.ok && model.kind === 'model' && model.id === modelHash
      ? { ok: true, action: request.action, ...(request.definition ? { durationMs: request.definition.durationMs, loop: request.definition.loop } : {}) } : unavailable();
    request.resolve(result);
    if (result.ok) {
      const notification = { action: request.action, at: new Date().toISOString() };
      for (const window of [getManagementWindow(), getToolWindow(), getPetWindow()]) {
        if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('nuanban:lumi:played', notification);
      }
    }
    return true;
  });
  return { invalidate, dispose() { disposed = true; invalidate(); channels.forEach(channel => ipcMain.removeHandler(channel)); } };
}

module.exports = { registerLumiActions, actions, modelHash };
