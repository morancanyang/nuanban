const { contextBridge, ipcRenderer } = require('electron');
function projectSingleFrameState(value) {
  const states = ['idle', 'capturing', 'preview', 'analyzing', 'verifying', 'shown', 'clarify', 'unsupported', 'error', 'expired', 'cancelled'];
  if (!value || !states.includes(value.state) || typeof value.message !== 'string' || value.message.length > 1000 || typeof value.hasPreview !== 'boolean') throw new TypeError('单帧状态无效');
  return { state: value.state, message: value.message, hasPreview: value.hasPreview };
}
contextBridge.exposeInMainWorld('nuanbanSingleFrame', Object.freeze({
  snapshot: () => ipcRenderer.invoke('nuanban:pet:single-frame:snapshot').then(projectSingleFrameState),
  capture: async () => {
    const result = await ipcRenderer.invoke('nuanban:pet:single-frame:capture');
    const projected = { state: projectSingleFrameState(result?.state) };
    const preview = result?.preview;
    if (preview !== undefined) {
      if (!preview || typeof preview.id !== 'string' || !/^[a-f0-9-]{36}$/.test(preview.id) || typeof preview.dataUrl !== 'string'
        || preview.dataUrl.length > 2_700_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(preview.dataUrl)
        || !['width', 'height'].every(key => Number.isSafeInteger(preview[key]) && preview[key] > 0 && preview[key] <= 16384)
        || !Number.isFinite(preview.expiresAt)) throw new TypeError('单帧预览无效');
      projected.preview = { id: preview.id, dataUrl: preview.dataUrl, width: preview.width, height: preview.height, expiresAt: preview.expiresAt };
    }
    return projected;
  },
  analyze: input => {
    if (!input || Object.keys(input).length !== 2 || typeof input.previewId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.previewId)
      || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 1500) throw new TypeError('单帧提问无效');
    return ipcRenderer.invoke('nuanban:pet:single-frame:analyze', { previewId: input.previewId, question: input.question }).then(projectSingleFrameState);
  },
  cancel: () => ipcRenderer.invoke('nuanban:pet:single-frame:cancel').then(projectSingleFrameState),
  onState: listener => {
    if (typeof listener !== 'function') throw new TypeError('单帧状态监听无效');
    const handler = (_event, value) => listener(projectSingleFrameState(value));
    ipcRenderer.on('nuanban:pet:single-frame:state', handler);
    return () => ipcRenderer.removeListener('nuanban:pet:single-frame:state', handler);
  },
}));
contextBridge.exposeInMainWorld('nuanbanLili', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('nuanban:lili:bootstrap'),
  select: enabled => {
    if (typeof enabled !== 'boolean') throw new TypeError('角色选择必须是布尔值');
    return ipcRenderer.invoke('nuanban:lili:select', enabled);
  },
  command: payload => {
    const commands = ['resource.describe', 'state.get', 'action.play', 'action.stop', 'expression.set', 'expression.reset',
      'animation.configure', 'semantic.send', 'ui.bubble', 'display.set'];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !commands.includes(payload.type)) throw new TypeError('栗栗指令无效');
    return ipcRenderer.invoke('nuanban:lili:command', payload);
  },
  interaction: payload => {
    if (!payload || !['loaded', 'loadFailed', 'click'].includes(payload.type)) throw new TypeError('栗栗交互无效');
    return ipcRenderer.invoke('nuanban:lili:interaction', { type: payload.type });
  },
  onState: listener => subscribeLili('nuanban:lili:state', listener),
  onResource: listener => subscribeLili('nuanban:lili:resource', listener),
  onEvent: listener => subscribeLili('nuanban:lili:event', listener),
}));

function subscribeLili(channel, listener) {
  if (typeof listener !== 'function') throw new TypeError('栗栗监听器必须是函数');
  const handler = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
contextBridge.exposeInMainWorld('nuanbanAvatar', Object.freeze({
  status: () => ipcRenderer.invoke('nuanban:avatar:status'),
  begin: (consent, mode) => {
    if (mode !== 'render' && mode !== 'conversation') throw new TypeError('形象会话模式无效');
    return ipcRenderer.invoke('nuanban:avatar:begin', consent === true, mode);
  },
  confirmConversation: () => ipcRenderer.invoke('nuanban:avatar:confirm-conversation'),
  exchange: (lease, input) => {
    if (typeof lease !== 'string' || lease.length > 64 || !['POST', 'DELETE'].includes(input?.method)) throw new TypeError('形象会话请求无效');
    return ipcRenderer.invoke('nuanban:avatar:exchange', lease, { method: input.method, body: input.body });
  },
  ready: lease => ipcRenderer.invoke('nuanban:avatar:ready', lease),
  fail: (lease, kind) => ipcRenderer.invoke('nuanban:avatar:fail', lease, kind === 'timeout' ? 'timeout' : 'load_failed'),
  stop: () => ipcRenderer.invoke('nuanban:avatar:stop'),
  onState: listener => {
    if (typeof listener !== 'function') throw new TypeError('形象状态监听器必须是函数');
    const handler = (_event, state) => listener({ configured: state.configured === true, phase: state.phase, message: state.message, appId: state.appId, defaultAvatarId: state.defaultAvatarId, defaultAvatarName: state.defaultAvatarName,
      mode: state.mode === 'conversation' ? 'conversation' : 'render',
      conversation: { enabled: state.conversation?.enabled === true, phase: typeof state.conversation?.phase === 'string' ? state.conversation.phase : 'idle' },
      autoReconnect: false, microphoneActive: false });
    ipcRenderer.on('nuanban:avatar:state', handler);
    return () => ipcRenderer.removeListener('nuanban:avatar:state', handler);
  },
}));
contextBridge.exposeInMainWorld('nuanbanModel', Object.freeze({
  read: () => ipcRenderer.invoke('nuanban:model:read'),
  onChanged: listener => {
    if (typeof listener !== 'function') throw new TypeError('模型监听器必须是函数');
    const handler = (_event, model) => listener(model);
    ipcRenderer.on('nuanban:model:changed', handler);
    return () => ipcRenderer.removeListener('nuanban:model:changed', handler);
  },
}));
contextBridge.exposeInMainWorld('nuanbanLumi', Object.freeze({
  describe: () => ipcRenderer.invoke('nuanban:lumi:describe'),
  play: action => ipcRenderer.invoke('nuanban:lumi:play', typeof action === 'string' && action.length <= 40 ? action : null),
  semantic: name => ipcRenderer.invoke('nuanban:lumi:semantic', typeof name === 'string' && name.length <= 30 ? name : null),
  stop: () => ipcRenderer.invoke('nuanban:lumi:stop'),
  onAction: listener => {
    if (typeof listener !== 'function') throw new TypeError('露米动作监听器必须是函数');
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('nuanban:lumi:played', handler);
    return () => ipcRenderer.removeListener('nuanban:lumi:played', handler);
  },
  onRequest: listener => {
    if (typeof listener !== 'function') throw new TypeError('露米动作监听器必须是函数');
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('nuanban:lumi:action', handler);
    return () => ipcRenderer.removeListener('nuanban:lumi:action', handler);
  },
  complete: (id, ok) => ipcRenderer.invoke('nuanban:lumi:complete', { id: typeof id === 'string' ? id : '', ok: ok === true }),
}));
contextBridge.exposeInMainWorld('nuanbanSearch', Object.freeze({
  status: () => ipcRenderer.invoke('nuanban:pet-search:status'),
  open: () => ipcRenderer.invoke('nuanban:pet-search:show'),
  search: (query, consent) => {
    if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new TypeError('请输入 1 至 500 字的问题');
    return ipcRenderer.invoke('nuanban:pet-search:run', { query, consent: consent === true });
  },
  cancel: () => ipcRenderer.invoke('nuanban:pet-search:cancel'),
  openSource: id => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(id)) throw new TypeError('搜索来源无效');
    return ipcRenderer.invoke('nuanban:pet-search:open-source', { id });
  },
  onOpen: listener => {
    if (typeof listener !== 'function') throw new TypeError('搜索面板监听器必须是函数');
    const handler = () => listener();
    ipcRenderer.on('nuanban:pet-search:opened', handler);
    return () => ipcRenderer.removeListener('nuanban:pet-search:opened', handler);
  },
}));
contextBridge.exposeInMainWorld('nuanbanArtwork', Object.freeze({
  read: () => ipcRenderer.invoke('nuanban:artwork:read'),
  onChanged: listener => {
    if (typeof listener !== 'function') throw new TypeError('原画监听器必须是函数');
    const handler = (_event, artwork) => listener(artwork);
    ipcRenderer.on('nuanban:artwork:changed', handler);
    return () => ipcRenderer.removeListener('nuanban:artwork:changed', handler);
  },
}));

function projectRecord(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [field, kind] of Object.entries(fields)) {
    if (typeof value[field] === kind && (kind !== 'number' || Number.isFinite(value[field]))) result[field] = value[field];
  }
  return result;
}

function projectNote(value) {
  const note = projectRecord(value, { id: 'string', question: 'string', summary: 'string', result: 'string', mastery: 'string' });
  if (!note) return undefined;
  if (!note.id && typeof value.noteId === 'string') note.id = value.noteId;
  if (typeof value.mastery === 'boolean') note.mastery = value.mastery;
  return note;
}

function projectSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.ok === true && Object.hasOwn(value, 'snapshot')) value = value.snapshot;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok === false) return null;
  const result = projectRecord(value, { message: 'string', learningUnavailable: 'boolean', learningError: 'string' });
  const sections = {
    observation: { state: 'string', sourceName: 'string', reason: 'string', generation: 'number', captureActive: 'boolean', cloudConsent: 'boolean' },
    task: { id: 'string', kind: 'string', generation: 'number', observationGeneration: 'number', state: 'string', question: 'string', instruction: 'string', explanation: 'string', presentation: 'string', targetState: 'string', awaitingReply: 'boolean', result: 'string' },
    analysis: { state: 'string', message: 'string' },
    captions: { enabled: 'boolean', text: 'string' },
    wake: { state: 'string', reason: 'string', phase: 'string', microphoneActive: 'boolean', dictationAvailable: 'boolean' },
    pet: { collapsed: 'boolean', ballSize: 'number', idleHideMs: 'number', hidden: 'boolean', edge: 'string' },
    voice: { state: 'string', active: 'boolean', microphoneActive: 'boolean', configured: 'boolean', message: 'string', mode: 'string', presentation: 'string' },
  };
  for (const [name, fields] of Object.entries(sections)) {
    const section = projectRecord(value[name], fields);
    if (section) result[name] = section;
  }
  if (result.voice?.presentation === 'pet' && (result.voice.active === true || result.voice.microphoneActive === true)) {
    const bubble = projectRecord(value.voice?.bubble, { user: 'string', assistant: 'string' });
    if (bubble && Object.values(bubble).every(text => text.length <= 6000)) result.voice.bubble = bubble;
  }
  if (Array.isArray(value.messages)) {
    result.messages = value.messages.slice(-20).map(message => projectRecord(message, { id: 'string', role: 'string', text: 'string' })).filter(message => message && ['user', 'assistant', 'system'].includes(message.role) && typeof message.text === 'string');
  }
  if (value.learning && typeof value.learning === 'object' && !Array.isArray(value.learning)) {
    result.learning = {};
    const note = projectNote(value.learning.note);
    if (note) result.learning.note = note;
    const proposal = projectRecord(value.learning.proposal, { id: 'string', remindAt: 'string', timezone: 'string', state: 'string', reason: 'string' });
    if (proposal) {
      if (!proposal.id && typeof value.learning.proposal.proposalId === 'string') proposal.id = value.learning.proposal.proposalId;
      if (typeof value.learning.proposal.remindAt === 'number' && Number.isFinite(value.learning.proposal.remindAt)) proposal.remindAt = value.learning.proposal.remindAt;
      result.learning.proposal = proposal;
    }
    if (Array.isArray(value.learning.notes)) result.learning.notes = value.learning.notes.slice(0, 20).map(projectNote).filter(Boolean);
    if (Array.isArray(value.learning.due)) {
      result.learning.due = value.learning.due.slice(0, 20).map(entry => {
        const due = projectRecord(entry, { id: 'string', noteId: 'string', dueAt: 'string', summary: 'string' });
        if (due && typeof entry.dueAt === 'number' && Number.isFinite(entry.dueAt)) due.dueAt = entry.dueAt;
        return due;
      }).filter(Boolean);
    }
  }
  return result;
}

function projectReply(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return typeof value === 'boolean' ? value : null;
  const result = projectRecord(value, { ok: 'boolean', accepted: 'boolean', success: 'boolean', status: 'string', message: 'string', reason: 'string', error: 'string' });
  if (['observation', 'task', 'analysis', 'captions', 'wake', 'pet', 'voice', 'learning', 'learningUnavailable', 'learningError'].some(section => Object.hasOwn(value, section))) Object.assign(result, projectSnapshot(value));
  if (Object.hasOwn(value, 'snapshot')) result.snapshot = projectSnapshot(value.snapshot);
  return result;
}

const commands = new Set(['observation.start', 'observation.stop', 'observation.resume', 'observation.reselect', 'observation.authorize-cloud', 'guidance.verify', 'guidance.finish', 'guidance.repeat', 'guidance.reply', 'guidance.rescan', 'captions.toggle', 'wake.enable', 'wake.disable', 'voice.open', 'voice.stop', 'voice.mute', 'voice.unmute', 'voice.interrupt', 'panel.set-expanded', 'learning.set-mastery', 'learning.review.confirm', 'learning.review.decline']);

function validIdentifier(value) {
  return typeof value === 'string' && Boolean(value.trim()) && value === value.trim() && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function requireIdentifier(value) {
  if (!validIdentifier(value)) throw new TypeError('学习记录标识无效，请刷新状态后重试');
  return value;
}

contextBridge.exposeInMainWorld('nuanbanPet', Object.freeze({
  snapshot: () => ipcRenderer.invoke('nuanban:pet:snapshot').then(projectSnapshot),
  focusInput: () => ipcRenderer.invoke('nuanban:pet:focus-input'),
  drag: (action, point) => {
    if (!['start', 'move', 'end'].includes(action)) throw new TypeError('桌宠移动请求无效');
    if (point !== undefined) {
      if (!point || Object.keys(point).length !== 2 || !['x', 'y'].every(key => Number.isFinite(point[key]) && Math.abs(point[key]) <= 1000000)) throw new TypeError('桌宠指针坐标无效');
      return ipcRenderer.invoke('nuanban:pet:drag', action, { x: point.x, y: point.y });
    }
    return ipcRenderer.invoke('nuanban:pet:drag', action);
  },
  dictate: observationGeneration => {
    if (observationGeneration === undefined) return ipcRenderer.invoke('nuanban:pet:voice:dictate');
    if (!Number.isSafeInteger(observationGeneration) || observationGeneration < 1) throw new TypeError('屏幕观察代次无效');
    return ipcRenderer.invoke('nuanban:pet:voice:dictate', { purpose: 'screen-guidance', observationGeneration });
  },
  cancelDictation: () => ipcRenderer.invoke('nuanban:pet:voice:cancel-dictation'),
  onState: listener => {
    if (typeof listener !== 'function') throw new TypeError('状态监听器必须是函数');
    const handler = (_event, state) => listener(projectSnapshot(state));
    ipcRenderer.on('nuanban:pet:state', handler);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      ipcRenderer.removeListener('nuanban:pet:state', handler);
    };
  },
  onPanel: listener => {
    if (typeof listener !== 'function') throw new TypeError('面板监听器必须是函数');
    const handler = (_event, state) => {
      const panel = projectRecord(state, { expanded: 'boolean', focusInput: 'boolean' });
      if (!panel || typeof panel.expanded !== 'boolean') return;
      if (['features', 'guidance', 'voice', 'observation', 'accessibility', 'question', 'dictation', 'search', 'learning', 'archive', 'todos', 'captions', 'wake', 'avatar'].includes(state.section)) {
        panel.section = state.section;
        if (state.section === 'learning' && validIdentifier(state.noteId)) panel.noteId = state.noteId;
      }
      listener(panel);
    };
    ipcRenderer.on('nuanban:pet:panel', handler);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      ipcRenderer.removeListener('nuanban:pet:panel', handler);
    };
  },
  command: payload => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !commands.has(payload.type)) throw new TypeError('不支持的桌宠指令');
    if (payload.type === 'panel.set-expanded' && typeof payload.expanded !== 'boolean') throw new TypeError('面板展开状态必须是布尔值');
    const command = payload.type === 'panel.set-expanded' ? { type: payload.type, expanded: payload.expanded } : { type: payload.type };
    if (payload.type === 'guidance.reply' || payload.type === 'guidance.rescan') {
      if (payload.type === 'guidance.reply') {
        if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 500) throw new TypeError('请输入 1 至 500 字的补充回答');
        command.text = payload.text;
      }
      if (!validIdentifier(payload.guideId) || !Number.isSafeInteger(payload.taskGeneration) || payload.taskGeneration < 1
        || !Number.isSafeInteger(payload.observationGeneration) || payload.observationGeneration < 1) throw new TypeError('追问或屏幕观察代次无效');
      Object.assign(command, { guideId: payload.guideId, taskGeneration: payload.taskGeneration, observationGeneration: payload.observationGeneration });
    }
    if (payload.type === 'observation.authorize-cloud') {
      if (!Number.isSafeInteger(payload.observationGeneration) || payload.observationGeneration < 1) throw new TypeError('屏幕观察代次无效');
      command.observationGeneration = payload.observationGeneration;
    }
    if (payload.type === 'learning.set-mastery') {
      command.noteId = requireIdentifier(payload.noteId);
      if (typeof payload.mastered !== 'boolean') throw new TypeError('掌握状态必须由本人明确选择');
      command.mastered = payload.mastered;
    }
    if (['learning.review.confirm', 'learning.review.decline'].includes(payload.type)) command.proposalId = requireIdentifier(payload.proposalId);
    return ipcRenderer.invoke('nuanban:pet:command', command).then(projectReply);
  },
  ask: (text, observationGeneration) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 500) throw new TypeError('请输入 1 至 500 字的问题');
    if (observationGeneration !== undefined && (!Number.isSafeInteger(observationGeneration) || observationGeneration < 1)) throw new TypeError('屏幕观察代次无效');
    return ipcRenderer.invoke('nuanban:pet:ask', { text, ...(observationGeneration !== undefined ? { observationGeneration } : {}) }).then(projectReply);
  },
  close: () => ipcRenderer.invoke('nuanban:pet:close'),
  openMain: (route = '/') => {
    if (typeof route !== 'string' || !/^\/(?!\/)[^?#\\\s]*$/.test(route)) throw new TypeError('请使用微光指引内部页面路径');
    return ipcRenderer.invoke('nuanban:pet:open-main', route);
  },
  openTool: route => {
    if (typeof route !== 'string' || !/^\/(?!\/)[^?#\\\s]*$/.test(route)) throw new TypeError('请使用微光指引内部工具路径');
    return ipcRenderer.invoke('nuanban:pet:open-tool', route);
  },
  showMenu: () => ipcRenderer.invoke('nuanban:pet:context-menu'),
  activity: () => ipcRenderer.invoke('nuanban:pet:activity'),
  expand: () => ipcRenderer.invoke('nuanban:pet:expand'),
  collapse: () => ipcRenderer.invoke('nuanban:pet:collapse'),
}));
