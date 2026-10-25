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
const AVATAR_TRACE_KINDS = ['stage', 'error', 'unhandledrejection', 'console', 'renderer-gone', 'preload', 'load'];
function projectAvatarTrace(entry) {
  if (!entry || typeof entry !== 'object' || !AVATAR_TRACE_KINDS.includes(entry.kind)) throw new TypeError('形象取证条目无效');
  const projected = { kind: entry.kind, message: typeof entry.message === 'string' ? entry.message.slice(0, 500) : '' };
  if (typeof entry.source === 'string' && entry.source) projected.source = entry.source.slice(0, 160);
  if (Number.isSafeInteger(entry.line) && entry.line >= 0) projected.line = entry.line;
  return projected;
}
// 取证只经受限 IPC 进入主进程写盘；这里不落地任何文件、不读取任何凭证。
function reportAvatarTrace(entry) {
  try { ipcRenderer.send('nuanban:avatar:trace', projectAvatarTrace(entry)); } catch {}
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
  fail: (lease, kind, detail) => ipcRenderer.invoke('nuanban:avatar:fail', lease, kind === 'timeout' ? 'timeout' : 'load_failed',
    typeof detail === 'string' ? detail.slice(0, 300) : ''),
  trace: entry => { try { reportAvatarTrace(entry); return true; } catch { return false; } },
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
// 页面级未捕获错误与未处理拒绝：在 preload（隔离世界）监听 window 事件，经受限 IPC 交给主进程写 avatar-trace.log。
// window 可能不存在（例如纯 Node 上下文复用本文件做静态检查），此时只跳过监听，不影响任何桥接。
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('error', event => reportAvatarTrace({ kind: 'error', message: String(event?.message ?? ''),
    source: typeof event?.filename === 'string' ? event.filename : '', line: Number.isSafeInteger(event?.lineno) ? event.lineno : undefined }));
  window.addEventListener('unhandledrejection', event => reportAvatarTrace({ kind: 'unhandledrejection',
    message: String(event?.reason?.message ?? event?.reason ?? '') }));
}
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
    observation: { state: 'string', sourceName: 'string', reason: 'string', generation: 'number', captureActive: 'boolean', cloudConsent: 'boolean', unredactedUpload: 'boolean', relaxedSafety: 'boolean', maxPermissions: 'boolean' },
    task: { id: 'string', kind: 'string', generation: 'number', observationGeneration: 'number', state: 'string', question: 'string', instruction: 'string', explanation: 'string', presentation: 'string', targetState: 'string', awaitingReply: 'boolean', result: 'string', autoStep: 'boolean', stepIndex: 'number' },
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
  // 无截屏指引模式必须能到达桌宠界面，否则按钮会因为看不到模式而一直禁用。
  // 只投影文本元数据：模式、原因码、控件计数与复核结论；控件名原文、像素与路径一律不在此列。
  const rawGuidance = value.observation && typeof value.observation === 'object' && !Array.isArray(value.observation)
    ? value.observation.guidance : undefined;
  const guidance = projectRecord(rawGuidance, { mode: 'string', modeLabel: 'string', screenshotFree: 'boolean',
    active: 'boolean', reasonCode: 'string', reasonMessage: 'string', severity: 'string',
    suggestSingleFrame: 'boolean', textConsent: 'boolean', available: 'boolean' });
  if (guidance && typeof guidance.screenshotFree === 'boolean' && result.observation) {
    if (rawGuidance.reasonCode === null) guidance.reasonCode = null;
    if (rawGuidance.reasonMessage === null) guidance.reasonMessage = null;
    if (guidance.severity !== 'info' && guidance.severity !== 'blocked') delete guidance.severity;
    if (typeof guidance.modeLabel === 'string' && guidance.modeLabel.length > 64) delete guidance.modeLabel;
    if (typeof guidance.reasonMessage === 'string' && guidance.reasonMessage.length > 300) delete guidance.reasonMessage;
    const counts = projectRecord(rawGuidance.counts, { count: 'number', limit: 'number', truncated: 'boolean' }) ?? {};
    if (Number.isSafeInteger(counts.count) && counts.count >= 0 && Number.isSafeInteger(counts.limit) && counts.limit >= 0 && counts.limit <= 4096) {
      guidance.counts = { count: counts.count, limit: counts.limit, truncated: counts.truncated === true };
    }
    const review = projectRecord(rawGuidance.review, { verdict: 'string', code: 'string', detail: 'string' });
    if (review && ['advanced', 'unchanged', 'unverifiable'].includes(review.verdict)
      && String(review.code ?? '').length <= 48 && String(review.detail ?? '').length <= 48) {
      guidance.review = { verdict: review.verdict, code: review.code, detail: review.detail };
    }
    result.observation.guidance = guidance;
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

const commands = new Set(['observation.start', 'observation.stop', 'observation.resume', 'observation.reselect', 'observation.authorize-cloud', 'guidance.auto-start', 'guidance.verify', 'guidance.finish', 'guidance.repeat', 'guidance.reply', 'guidance.rescan', 'captions.toggle', 'wake.enable', 'wake.disable', 'voice.open', 'voice.stop', 'voice.mute', 'voice.unmute', 'voice.interrupt', 'panel.set-expanded', 'learning.set-mastery', 'learning.review.confirm', 'learning.review.decline']);

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
    if (payload.type === 'guidance.auto-start') {
      if (payload.goal !== undefined && (typeof payload.goal !== 'string' || payload.goal.length > 500)) throw new TypeError('自动步进目标不能超过 500 字');
      if (typeof payload.goal === 'string' && payload.goal.trim()) command.goal = payload.goal;
    }
    if (payload.type === 'learning.set-mastery') {
      command.noteId = requireIdentifier(payload.noteId);
      if (typeof payload.mastered !== 'boolean') throw new TypeError('掌握状态必须由本人明确选择');
      command.mastered = payload.mastered;
    }
    if (['learning.review.confirm', 'learning.review.decline'].includes(payload.type)) command.proposalId = requireIdentifier(payload.proposalId);
    return ipcRenderer.invoke('nuanban:pet:command', command).then(projectReply);
  },
  ask: (text, observationGeneration, screenshotFree) => {
    if (typeof text !== 'string' || !text.trim() || text.length > 500) throw new TypeError('请输入 1 至 500 字的问题');
    if (observationGeneration !== undefined && (!Number.isSafeInteger(observationGeneration) || observationGeneration < 1)) throw new TypeError('屏幕观察代次无效');
    if (screenshotFree !== undefined && screenshotFree !== true) throw new TypeError('无截屏标志无效');
    // 只做转发：第三项只表示"这次走无截屏控件清单路径"，不携带任何画面数据，是否可用由主进程决定。
    return ipcRenderer.invoke('nuanban:pet:ask', { text, ...(observationGeneration !== undefined ? { observationGeneration } : {}), ...(screenshotFree === true ? { screenshotFree: true } : {}) }).then(projectReply);
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

const openAppErrorCodes = ['APP_UNKNOWN', 'TARGET_UNKNOWN', 'TARGET_UNSUPPORTED', 'PARAMETERS_INVALID', 'PARAMETERS_FORBIDDEN', 'URL_PROTOCOL_BLOCKED', 'URL_INVALID', 'FOLDER_NOT_ALLOWED', 'FOLDER_MISSING', 'MODEL_UNAVAILABLE', 'MODEL_INVALID_JSON', 'UNSAFE_MODEL_OUTPUT', 'EXECUTABLE_MISSING', 'LAUNCH_FAILED', 'CANCELLED', 'PLAN_EXPIRED', 'PLAN_UNKNOWN', 'AUTO_EXECUTE_DENIED'];

function openAppPlanId(value) {
  if (!validIdentifier(value)) throw new TypeError('打开计划标识无效，请重新解析');
  return value;
}

function projectOpenAppError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== false) throw new TypeError('智能打开软件回复无效');
  if (!openAppErrorCodes.includes(value.code)) throw new TypeError('智能打开软件错误码无效');
  if (typeof value.message !== 'string' || value.message.length > 500) throw new TypeError('智能打开软件提示无效');
  return { ok: false, code: value.code, message: value.message };
}

function projectOpenAppParameters(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('智能打开软件参数无效');
  const parameters = {};
  if (Object.hasOwn(value, 'url')) {
    if (typeof value.url !== 'string' || !value.url.trim() || value.url.length > 2048 || !/^https?:\/\//.test(value.url)) throw new TypeError('智能打开软件网址参数无效');
    parameters.url = value.url;
  }
  if (Object.hasOwn(value, 'folder')) {
    if (typeof value.folder !== 'string' || !value.folder.trim() || value.folder.length > 1024) throw new TypeError('智能打开软件文件夹参数无效');
    parameters.folder = value.folder;
  }
  return parameters;
}

function projectOpenAppPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('打开计划无效');
  if (!validIdentifier(value.appId)) throw new TypeError('打开计划软件标识无效');
  if (!validIdentifier(value.target)) throw new TypeError('打开计划界面标识无效');
  if (typeof value.appName !== 'string' || !value.appName.trim() || value.appName.length > 100) throw new TypeError('打开计划软件名无效');
  if (typeof value.targetDescription !== 'string' || value.targetDescription.length > 200) throw new TypeError('打开计划界面说明无效');
  if (!['low', 'confirm'].includes(value.risk)) throw new TypeError('打开计划风险等级无效');
  if (typeof value.requiresConfirmation !== 'boolean') throw new TypeError('打开计划确认要求无效');
  if (value.requiresFolder !== undefined && typeof value.requiresFolder !== 'boolean') throw new TypeError('打开计划文件夹要求无效');
  if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 300)) throw new TypeError('打开计划说明无效');
  return {
    planId: openAppPlanId(value.planId),
    appId: value.appId,
    appName: value.appName,
    target: value.target,
    targetDescription: value.targetDescription,
    risk: value.risk,
    parameters: projectOpenAppParameters(value.parameters),
    requiresConfirmation: value.requiresConfirmation,
    ...(value.requiresFolder !== undefined ? { requiresFolder: value.requiresFolder } : {}),
    reason: typeof value.reason === 'string' ? value.reason : '',
  };
}

function projectOpenAppResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.success !== 'boolean') throw new TypeError('打开结果无效');
  const result = { success: value.success };
  if (value.appId !== undefined) {
    if (!validIdentifier(value.appId)) throw new TypeError('打开结果软件标识无效');
    result.appId = value.appId;
  }
  if (value.target !== undefined) {
    if (!validIdentifier(value.target)) throw new TypeError('打开结果界面标识无效');
    result.target = value.target;
  }
  if (value.message !== undefined) {
    if (typeof value.message !== 'string' || !value.message.trim() || value.message.length > 1000) throw new TypeError('打开结果说明无效');
    result.message = value.message;
  }
  if (value.errorCode !== undefined && value.errorCode !== null) {
    if (!openAppErrorCodes.includes(value.errorCode)) throw new TypeError('打开结果错误码无效');
    result.errorCode = value.errorCode;
  }
  if (value.success === true && typeof result.message !== 'string') throw new TypeError('打开结果缺少说明');
  return result;
}

function projectOpenAppReply(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('智能打开软件回复无效');
  if (value.ok === false) return projectOpenAppError(value);
  if (value.ok !== true) throw new TypeError('智能打开软件回复无效');
  if (value.kind === 'plan') return { ok: true, kind: 'plan', plan: projectOpenAppPlan(value.plan) };
  if (value.kind === 'clarify') {
    if (typeof value.question !== 'string' || !value.question.trim() || value.question.length > 300) throw new TypeError('智能打开软件追问无效');
    return { ok: true, kind: 'clarify', question: value.question };
  }
  if (value.kind === 'unsupported' || value.kind === 'cancel') {
    if (typeof value.message !== 'string' || !value.message.trim() || value.message.length > 300) throw new TypeError('智能打开软件说明无效');
    return { ok: true, kind: value.kind, message: value.message };
  }
  throw new TypeError('智能打开软件回复无效');
}

function projectOpenAppExecuteReply(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('智能打开软件回复无效');
  if (value.ok === false) return projectOpenAppError(value);
  if (value.ok !== true) throw new TypeError('智能打开软件回复无效');
  return { ok: true, result: projectOpenAppResult(value.result) };
}

function projectOpenAppFolder(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('目录选择结果无效');
  if (value.ok === false) return projectOpenAppError(value);
  if (value.ok !== true) throw new TypeError('目录选择结果无效');
  if (typeof value.path !== 'string' || !value.path.trim() || value.path.length > 1024) throw new TypeError('目录选择结果无效');
  if (typeof value.display !== 'string' || value.display.length > 200) throw new TypeError('目录选择结果无效');
  const result = { ok: true, path: value.path, display: value.display };
  if (value.plan !== undefined && value.plan !== null) result.plan = projectOpenAppPlan(value.plan);
  return result;
}

function projectOpenAppHistory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true || !Array.isArray(value.entries) || value.entries.length > 100) throw new TypeError('最近打开记录无效');
  return {
    ok: true,
    entries: value.entries.slice(-20).map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Number.isFinite(entry.at)) throw new TypeError('最近打开记录无效');
      const record = { at: entry.at };
      if (typeof entry.appId === 'string' && entry.appId.length <= 128) record.appId = entry.appId;
      if (typeof entry.target === 'string' && entry.target.length <= 128) record.target = entry.target;
      if (typeof entry.success === 'boolean') record.success = entry.success;
      if (typeof entry.errorCode === 'string' && openAppErrorCodes.includes(entry.errorCode)) record.errorCode = entry.errorCode;
      return record;
    }),
  };
}

function openAppItemId(value) {
  return typeof value === 'string' && (/^sm:[a-f0-9]{12}$/.test(value) || /^[a-z][a-z0-9-]{0,39}$/.test(value));
}

function projectOpenAppInventory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true) throw new TypeError('本机软件清单无效');
  if (!Number.isSafeInteger(value.total) || value.total < 0 || value.total > 100000) throw new TypeError('本机软件清单数量无效');
  if (!Array.isArray(value.entries) || value.entries.length > 400) throw new TypeError('本机软件清单无效');
  return {
    ok: true,
    total: value.total,
    entries: value.entries.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !openAppItemId(entry.id)) throw new TypeError('本机软件条目无效');
      if (typeof entry.displayName !== 'string' || !entry.displayName.trim() || entry.displayName.length > 200) throw new TypeError('本机软件条目无效');
      return { id: entry.id, displayName: entry.displayName };
    }),
  };
}

function projectOpenAppStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true) throw new TypeError('智能打开软件状态无效');
  if (typeof value.modelReady !== 'boolean' || typeof value.autoExecute !== 'boolean' || !Array.isArray(value.catalog) || value.catalog.length > 50) throw new TypeError('智能打开软件状态无效');
  const catalog = value.catalog.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !validIdentifier(entry.appId)) throw new TypeError('智能打开软件清单无效');
    if (typeof entry.displayName !== 'string' || !entry.displayName.trim() || entry.displayName.length > 100) throw new TypeError('智能打开软件清单无效');
    if (!Array.isArray(entry.targets) || entry.targets.length > 20) throw new TypeError('智能打开软件清单无效');
    return {
      appId: entry.appId,
      displayName: entry.displayName,
      targets: entry.targets.map(target => {
        if (!target || typeof target !== 'object' || Array.isArray(target) || !validIdentifier(target.target)) throw new TypeError('智能打开软件目标无效');
        if (typeof target.description !== 'string' || target.description.length > 200) throw new TypeError('智能打开软件目标说明无效');
        if (!['low', 'confirm'].includes(target.risk)) throw new TypeError('智能打开软件风险等级无效');
        if (typeof target.requiresFolder !== 'boolean' || typeof target.requiresUrl !== 'boolean') throw new TypeError('智能打开软件目标参数无效');
        return { target: target.target, description: target.description, risk: target.risk, requiresFolder: target.requiresFolder, requiresUrl: target.requiresUrl };
      }),
    };
  });
  const status = { ok: true, modelReady: value.modelReady, autoExecute: value.autoExecute, catalog };
  if (Number.isSafeInteger(value.inventoryTotal) && value.inventoryTotal >= 0 && value.inventoryTotal <= 100000) status.inventoryTotal = value.inventoryTotal;
  return status;
}

function projectOpenAppCancelled(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true) throw new TypeError('停止请求未确认');
  return { ok: true };
}

function projectOpenAppAuto(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('自动执行状态未确认');
  if (value.ok === false) return projectOpenAppError(value);
  if (value.ok !== true || typeof value.autoExecute !== 'boolean') throw new TypeError('自动执行状态未确认');
  return { ok: true, autoExecute: value.autoExecute };
}

contextBridge.exposeInMainWorld('nuanbanOpenApp', Object.freeze({
  status: () => ipcRenderer.invoke('nuanban:pet-open-app:status').then(projectOpenAppStatus),
  inventory: () => ipcRenderer.invoke('nuanban:pet-open-app:inventory').then(projectOpenAppInventory),
  pick: id => {
    if (!openAppItemId(id)) throw new TypeError('本机软件标识无效，请刷新列表后重新选择');
    return ipcRenderer.invoke('nuanban:pet-open-app:pick', { id }).then(projectOpenAppReply);
  },
  parse: input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2) throw new TypeError('智能打开软件请求无效');
    if (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 300) throw new TypeError('请输入 1 至 300 字的打开目标');
    if (input.consent !== true) throw new TypeError('请先确认本次由本人发起解析');
    return ipcRenderer.invoke('nuanban:pet-open-app:parse', { goal: input.goal, consent: true }).then(projectOpenAppReply);
  },
  execute: input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2) throw new TypeError('智能打开软件请求无效');
    const planId = openAppPlanId(input.planId);
    if (typeof input.approved !== 'boolean') throw new TypeError('请明确是否继续打开');
    return ipcRenderer.invoke('nuanban:pet-open-app:execute', { planId, approved: input.approved }).then(projectOpenAppExecuteReply);
  },
  pickFolder: () => ipcRenderer.invoke('nuanban:pet-open-app:pick-folder').then(projectOpenAppFolder),
  cancel: () => ipcRenderer.invoke('nuanban:pet-open-app:cancel').then(projectOpenAppCancelled),
  history: () => ipcRenderer.invoke('nuanban:pet-open-app:history').then(projectOpenAppHistory),
  setAutoExecute: enabled => {
    if (typeof enabled !== 'boolean') throw new TypeError('自动执行开关必须是布尔值');
    return ipcRenderer.invoke('nuanban:pet-open-app:auto', { enabled }).then(projectOpenAppAuto);
  },
}));
