const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createDesktopRuntime } = require('./runtime-coordinator.cjs');
const { createDesktopAnalysisClient } = require('./analysis-client.cjs');
const { createWindowsObservationSource } = require('./observation/windows-observation-source.cjs');
const { createObservationRegionSelector } = require('./observation/region-selector.cjs');
const { captureFailureReason } = require('./observation/observation-common.cjs');
const { createWindowsLocalWake } = require('./wake/windows-local-wake.cjs');
const { createRuntimeLearningStore } = require('./runtime-learning-store.cjs');
const { createSafeStoragePayloadCodec } = require('./reminder-store.cjs');
const { registerPetSearchBridge } = require('./pet-search-bridge.cjs');
const { createPetSearchClient } = require('./pet-search-client.cjs');
const { createAnySearchClient } = require('./anysearch-client.cjs');
const { createModelSearchClient } = require('./model-search-client.cjs');
const { createRealtimeVoiceHost } = require('./realtime-voice-host.cjs');
const { registerDictationBridge } = require('./wake/dictation-bridge.cjs');
const { loadXingyunCredentials } = require('./xingyun-credentials.cjs');
const { createXingyunAvatarService, registerXingyunAvatarBridge, defaultPet } = require('./xingyun-avatar.cjs');
const { createLiliHost } = require('./lili-host.cjs');
const { createSingleFrameGuidance } = require('./single-frame-guidance.cjs');
const { PRODUCT_ICON_PATH } = require('./brand.cjs');

function createStandaloneHost(options) {
  const { BrowserWindow, ipcMain, screen, Menu, Tray, dialog, desktopCapturer, nativeImage, safeStorage, powerMonitor, session } = options.electron;
  const petPath = path.join(__dirname, 'pet.html');
  const guidePath = path.join(__dirname, 'guide.html');
  const captionPath = path.join(__dirname, 'caption.html');
  const managementRoutes = new Set(['/', '/chat/new', '/notes', '/todos', '/pets', '/pets/draw', '/family', '/settings']);
  const petToolRoutes = new Set(['/chat/new', '/notes', '/todos', '/pets', '/pets/draw', '/pets/import-3d', '/family', '/settings', '/settings/status', '/onboarding/mode', '/onboarding/login', '/sync/conflicts']);
  let petWindow = null;
  let petDisplayCompatible = options.petDisplayCompatible === true;
  let petProtected;
  let singleFrameProtecting = false;
  let singleFrameEpoch = 0;
  let guideWindow = null;
  let captionWindow = null;
  let guideTimer = null;
  let pendingGuide = null;
  let consentedSourceId = null;
  let choosingSource = false;
  let choosingCloudConsent = false;
  let observationConsentGeneration = 0;
  let choosingWake = false;
  let dictating = false;
  let dictationPurpose = '';
  let dictationObservationGeneration = 0;
  let wakeConsentGeneration = 0;
  let wakeController = null;
  // Owner-approved cloud dictation: the switch is persisted, the audio client is optional, and the
  // recorder helper never uploads by itself. Everything stays fail-closed when any piece is missing.
  let cloudFailure = '';
  let cloudRecording = false;
  const cloudSettings = options.cloudSettings;
  const cloudDictation = options.cloudDictation;
  const cloudRecorder = options.cloudRecorder;
  const cloudDictationStatus = () => Object.freeze({
    enabled: cloudSettings?.read?.().enabled === true,
    available: typeof cloudDictation?.transcribe === 'function' && cloudRecorder?.available === true,
  });
  const cloudDictationReady = () => { const status = cloudDictationStatus(); return status.enabled && status.available; };
  let wakeFailure = '';
  let closing = false;
  let runtime;
  let learningStore = null;
  let learningUnavailable = false;
  let learningFailure = '';
  let reminderTimer = null;
  let searchBridge = null;
  let voiceHost = null;
  let faceVoiceVisible = false;
  let voiceBubble = { user: '', assistant: '' };
  let dictationBridge = null;
  let avatarService = null;
  let avatarBridge = null;
  let expanded = false;
  let collapsed = false;
  let restoreBounds = null;
  let idleTimer = null;
  let blurTimer = null;
  let menuOpen = false;
  let dialogOpen = 0;
  let lastActivityAt = 0;
  const idleHideMs = Number.isFinite(options.autoHideMs) ? Math.max(0, options.autoHideMs) : 5_000;
  const ballSize = 64;
  let petClosePromise = null;
  let petDrag = null;
  let liliTray = null;
  let petDragTimer = null;
  const listeners = [];
  const channels = [];
  const analyzer = options.analyzer ?? createDesktopAnalysisClient();
  const regionSelector = (options.createRegionSelector ?? createObservationRegionSelector)({ BrowserWindow, ipcMain });
  const source = options.source ?? createWindowsObservationSource({ desktopCapturer, screen, nativeImage, BrowserWindow, ipcMain, session,
    canCapture: ({ sourceId }) => consentedSourceId === sourceId && runtime?.snapshot().observation.state === 'observing',
    onCaptureInvalidated: event => { consentedSourceId = null; clearGuide(); if (runtime) runAction(() => stop(captureFailureReason(event?.reason))); } });
  const singleFrameSource = options.singleFrameSource ?? createWindowsObservationSource({ desktopCapturer, screen, nativeImage, BrowserWindow, ipcMain, session,
    canCapture: input => singleFrame.canCapture(input),
    onCaptureInvalidated: () => { runAction(() => singleFrame.cancel()); } });
  const singleFrame = createSingleFrameGuidance({ source: singleFrameSource, provider: options.questioner, nativeImage,
    selectSource: selectSingleFrameSource, onTarget: showGuide, clearTarget: clearGuide,
    onState: state => { if (live(petWindow)) petWindow.webContents.send('nuanban:pet:single-frame:state', state); } });
  const wake = (options.createWakeSource ?? createWindowsLocalWake)({
    onState: () => { if (runtime) publish(); },
    onWake: event => {
      const current = wake.snapshot();
      if (!closing && event.localOnly === true && event.generation === current.generation && current.enabled && current.microphoneActive) {
        expandFromBall({ focus: false });
        showPetPanel();
      }
    },
    onQuestion: text => {
      const current = wake.snapshot();
      if (!closing && current.enabled && current.microphoneActive && typeof text === 'string') runAction(() => runtime.ask(text));
    },
  });

  const lili = createLiliHost({ userDataPath: options.userDataPath,
    isVisible: () => live(petWindow) && petWindow.isVisible(), onView: applyLiliView,
    onFrame: state => { if (live(petWindow)) petWindow.webContents.send('nuanban:lili:state', state); },
    onResource: resource => { if (live(petWindow)) petWindow.webContents.send('nuanban:lili:resource', resource); },
    onEvent: event => { if (live(petWindow)) petWindow.webContents.send('nuanban:lili:event', event); } });

  function live(window) { return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed()); }

  function trusted(event, window, page) {
    return live(window) && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
      && event.senderFrame.url.split('#')[0] === pathToFileURL(page).href;
  }

  function snapshot() {
    const state = runtime.snapshot();
    state.pet = { collapsed, ballSize, idleHideMs };
    state.voice = voiceHost?.snapshot() ?? { state: 'off', active: false, microphoneActive: false, configured: false, message: '面对面语音未开启。' };
    state.voice = { ...state.voice, presentation: 'pet', ...(faceVoiceVisible ? { bubble: { ...voiceBubble } } : {}) };
    const localWake = wake.snapshot();
    const microphonePending = localWake.microphoneActive || localWake.enabled || ['starting', 'stopping'].includes(localWake.state);
    state.wake = { ...localWake, cloudDictation: cloudDictationStatus(), phase: localWake.state, state: microphonePending ? 'enabled' : 'disabled',
      reason: wakeFailure || (localWake.state === 'stopping' ? '正在等待本地麦克风进程真实退出，尚未确认停止。'
        : dictating && cloudFailure ? '云端识别失败（' + cloudFailure + '），已回退本机离线听写；请检查网络后重试。'
          : dictating && cloudRecording ? '正在录音并上传识别（仅本次，识别后立即丢弃）；请直接说话。'
        : dictating && localWake.state === 'question' ? dictationPurpose === 'screen-guidance' ? '正在本机听写；停麦后按本次授权查找屏幕目标，只绘制指引。' : '正在本机听写，请直接说话；识别后填入发起输入框，不会自动发送。'
          : dictating && localWake.state === 'starting' ? '正在启动本次本机听写，请等候“正在本机听写”提示。'
        : localWake.microphoneActive ? localWake.dictationAvailable ? '本地唤醒监听中；说“小暖”后可在本机识别问题，未唤醒音频不上传。' : '本地唤醒监听中；说“小暖”打开桌宠后，请输入问题。本机听写不可用。'
          : ['error', 'unavailable'].includes(localWake.state) ? '本机中文离线语音引擎或麦克风不可用；未改用云端常听。请使用点击和文字提问。'
            : '本地语音唤醒未开启，麦克风需本人单独确认；不随桌宠启动自动恢复。') };
    state.capabilities = { selectedScreenCapture: process.platform === 'win32' ? 'implemented_unverified' : 'unsupported', realCaptureAccepted: false,
      localDetector: 'requires_local_verification', cloudAnalysis: analyzer.capabilities().configured, encryptedLearning: Boolean(learningStore), managementIndependent: true };
    if (learningStore) {
      try {
        const latest = learningStore.getLatest();
        const noteView = note => note ? { id: note.noteId, question: note.question, summary: note.summary, result: note.result, mastery: note.mastery } : null;
        const proposal = latest.proposal;
        state.learning = { note: noteView(latest.note), notes: learningStore.listNotes({ limit: 20 }).map(noteView),
          proposal: proposal ? { id: proposal.proposalId, remindAt: proposal.remindAt, timezone: proposal.timezone, state: proposal.state, reason: proposal.reason } : null,
          due: dueReviews() };
      } catch { learningFailure = '学习记录读取失败，未显示未核实的保存结果。'; }
    }
    if (learningUnavailable) state.learningError = '本机加密教学记录不可用；不会将学习内容降级写为明文。';
    else if (learningFailure) state.learningError = learningFailure;
    return state;
  }

  function dueReviews() {
    if (!learningStore || !options.reminderStore) return [];
    return options.reminderStore.list(learningStore.getOwnerId())
      .filter(item => ['scheduled', 'submitted', 'unknown', 'failed', 'missed'].includes(item.status) && Date.parse(item.dueAt) <= Date.now())
      .flatMap(item => {
        const match = /^nuanban:\/\/review\/([a-z0-9-]{1,64})$/.exec(item.deepLink);
        const note = match && learningStore.getNote(match[1]);
        return note ? [{ id: item.reminderId, noteId: note.noteId, dueAt: item.dueAt, summary: note.summary }] : [];
      }).slice(0, 10);
  }

  function flushReviews() {
    if (!learningStore || !options.reminderStore) return;
    try {
      for (const item of learningStore.pendingReminders()) {
        options.reminderStore.schedule({ accountId: item.accountId, reminderId: item.reminderId, instanceId: item.instanceId,
          scheduleVersion: item.scheduleVersion, dueAt: item.dueAt, updatedAt: item.updatedAt, deepLink: item.deepLink, payload: item.payload });
        learningStore.markReminderScheduled(item.reminderId);
      }
      learningFailure = '';
    } catch { learningFailure = '复习已确认，但本地调度未完成；待重试，不代表提醒已送达。'; }
  }

  function pollReviews() {
    flushReviews();
    if (learningStore && options.reminderStore && options.reminderNotifications) {
      try {
        for (const item of options.reminderStore.list(learningStore.getOwnerId())) {
          if (item.status === 'scheduled' && Date.parse(item.dueAt) <= Date.now()) {
            options.reminderNotifications.notifyDue({ accountId: item.accountId, reminderId: item.reminderId, instanceId: item.instanceId, scheduleVersion: item.scheduleVersion });
          }
        }
      } catch { learningFailure = '复习通知状态未知，请在桌宠学习区查看；未标记为已送达。'; }
    }
    publish();
  }

  function captionState() {
    const state = runtime.snapshot();
    return { visible: state.captions.enabled && Boolean(state.captions.text) && state.observation.state !== 'privacy_paused', text: state.captions.text };
  }

  function updateCaptions() {
    if (!live(captionWindow)) return;
    const state = captionState();
    captionWindow.webContents.send('nuanban:caption:state', state);
    if (!state.visible) { captionWindow.hide(); return; }
    const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(740, workArea.width - 32);
    captionWindow.setBounds({ x: workArea.x + Math.round((workArea.width - width) / 2), y: workArea.y + workArea.height - 132, width, height: 116 });
    captionWindow.showInactive();
  }

  function publish() {
    const state = snapshot();
    if (dictationPurpose === 'screen-guidance' && (state.observation.generation !== dictationObservationGeneration
      || state.observation.state !== 'observing' || state.observation.captureActive !== true || state.observation.cloudConsent !== true)) wakeController?.abort();
    lili.observe(state);
    syncPetProtection(state.observation);
    options.onObservationState?.({ ...state.observation });
    if (state.observation.state !== 'observing') consentedSourceId = null;
    if (live(petWindow)) petWindow.webContents.send('nuanban:pet:state', state);
    updateCaptions();
  }

  function clearGuide() {
    clearTimeout(guideTimer);
    guideTimer = null;
    pendingGuide = null;
    if (live(guideWindow)) {
      guideWindow.webContents.send('nuanban:guide:state', { visible: false });
      guideWindow.hide();
    }
  }

  function intersects(first, second) {
    return first.x < second.x + second.width && first.x + first.width > second.x && first.y < second.y + second.height && first.y + first.height > second.y;
  }

  function movePetAwayFrom(rect, workArea) {
    if (collapsed || !live(petWindow) || !intersects(petWindow.getBounds(), rect)) return;
    const bounds = petWindow.getBounds();
    const candidates = [
      { x: workArea.x + 12, y: workArea.y + 12 },
      { x: workArea.x + workArea.width - bounds.width - 12, y: workArea.y + 12 },
      { x: workArea.x + 12, y: workArea.y + workArea.height - bounds.height - 12 },
      { x: workArea.x + workArea.width - bounds.width - 12, y: workArea.y + workArea.height - bounds.height - 12 },
    ];
    const position = candidates.find(candidate => !intersects({ ...bounds, ...candidate }, rect));
    if (position) petWindow.setPosition(Math.round(position.x), Math.round(position.y), false);
  }

  function showGuide(target) {
    if (!target || !target.visible || !live(guideWindow) || target.expiresAt <= Date.now()) { clearGuide(); return false; }
    const display = screen.getDisplayMatching(target.rect);
    const bounds = display.bounds;
    if (target.rect.x < bounds.x || target.rect.y < bounds.y || target.rect.x + target.rect.width > bounds.x + bounds.width || target.rect.y + target.rect.height > bounds.y + bounds.height) { clearGuide(); return false; }
    clearTimeout(guideTimer);
    movePetAwayFrom(target.rect, display.workArea);
    guideWindow.setBounds(bounds);
    pendingGuide = { ...target, rect: { ...target.rect, x: target.rect.x - bounds.x, y: target.rect.y - bounds.y } };
    guideWindow.webContents.send('nuanban:guide:state', pendingGuide);
    guideWindow.showInactive();
    guideTimer = setTimeout(clearGuide, target.expiresAt - Date.now());
    guideTimer.unref?.();
    return true;
  }

  function secureWindow(window, protectContent = true) {
    window.setContentProtection(protectContent);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
  }

  function syncPetProtection(observation) {
    if (!live(petWindow)) return;
    const required = !petDisplayCompatible || singleFrameProtecting || observation?.captureActive !== false;
    if (petProtected === required) return;
    petWindow.setContentProtection(required);
    petProtected = required;
  }

  function setPetDisplayCompatibility(compatible) {
    petDisplayCompatible = compatible === true;
    syncPetProtection(runtime?.snapshot().observation);
  }

  function windowPreferences(preload) {
    return { preload: path.join(__dirname, preload), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true };
  }

  function clampPetBounds(bounds, area) {
    const width = Math.max(1, Math.min(bounds.width, area.width - 16));
    const height = Math.max(1, Math.min(bounds.height, area.height - 16));
    return {
      x: Math.round(Math.max(area.x + 8, Math.min(bounds.x, area.x + area.width - width - 8))),
      y: Math.round(Math.max(area.y + 8, Math.min(bounds.y, area.y + area.height - height - 8))),
      width,
      height,
    };
  }

  function ballBoundsFor(bounds) {
    const area = screen.getDisplayMatching(bounds).workArea;
    const centerY = bounds.y + Math.round(bounds.height / 2);
    return {
      x: area.x + area.width - ballSize - 8,
      y: Math.round(Math.max(area.y + 8, Math.min(centerY - ballSize / 2, area.y + area.height - ballSize - 8))),
      width: ballSize,
      height: ballSize,
    };
  }

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (closing || collapsed || dialogOpen > 0 || menuOpen || !live(petWindow) || !petWindow.isVisible()) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      collapseToBall('idle');
    }, idleHideMs);
    idleTimer.unref?.();
  }

  function noteActivity() {
    const now = Date.now();
    if (now - lastActivityAt < 800) return;
    lastActivityAt = now;
    resetIdleTimer();
  }

  function expandFromBall({ focus = true } = {}) {
    if (!collapsed || !live(petWindow)) return false;
    collapsed = false;
    clearTimeout(blurTimer);
    blurTimer = null;
    const area = screen.getDisplayMatching(restoreBounds ?? petWindow.getBounds()).workArea;
    const fallback = { x: area.x + area.width - 324, y: area.y + area.height - 414, width: 300, height: Math.min(390, area.height - 24) };
    petWindow.setBounds(clampPetBounds(restoreBounds ?? fallback, area));
    petWindow.setAlwaysOnTop(false);
    if (focus) {
      petWindow.show();
      petWindow.focus();
    } else {
      petWindow.showInactive();
    }
    publish();
    resetIdleTimer();
    return true;
  }

  function collapseToBall(reason = 'idle') {
    if (closing || collapsed || petClosePromise || dialogOpen > 0 || menuOpen) return false;
    if (voiceHost?.snapshot().active === true || faceVoiceVisible === true) return false;
    if (!live(petWindow) || !petWindow.isVisible()) return false;
    restoreBounds = petWindow.getBounds();
    collapsed = true;
    clearTimeout(idleTimer);
    idleTimer = null;
    clearTimeout(blurTimer);
    blurTimer = null;
    clearPetDrag();
    petWindow.setAlwaysOnTop(false);
    petWindow.setBounds(ballBoundsFor(restoreBounds));
    petWindow.showInactive();
    publish();
    return true;
  }

  function setExpanded(value, liliView = lili.snapshot().view) {
    if (collapsed) expandFromBall({ focus: false });
    clearPetDrag();
    expanded = value && !faceVoiceVisible;
    if (!live(petWindow)) return;
    const area = screen.getDisplayMatching(petWindow.getBounds()).workArea;
    const liliSelected = lili.snapshot().enabled;
    const width = Math.max(1, Math.min(expanded ? 400 : faceVoiceVisible ? 320 : liliSelected ? Math.max(300, liliView.size + 24) : 300, area.width - 24));
    const height = Math.max(1, Math.min(expanded ? 760 : faceVoiceVisible ? 500 : liliSelected ? Math.max(390, liliView.size + 144) : 390, area.height - 24));
    const current = petWindow.getBounds();
    petWindow.setBounds({ x: Math.max(area.x + 12, Math.min(current.x, area.x + area.width - width - 12)),
      y: Math.max(area.y + 12, Math.min(current.y, area.y + area.height - height - 12)), width, height });
  }

  function clearPetDrag() {
    if (petDragTimer) {
      clearInterval(petDragTimer);
      petDragTimer = null;
    }
    petDrag = null;
  }

  function movePetToCursor(point) {
    if (closing || !live(petWindow) || !petWindow.isVisible() || !petDrag) {
      clearPetDrag();
      return false;
    }
    const cursor = point ?? screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const width = Math.min(petDrag.bounds.width, area.width);
    const height = Math.min(petDrag.bounds.height, area.height);
    const position = {
      x: Math.round(Math.max(area.x, Math.min(petDrag.bounds.x + cursor.x - petDrag.cursor.x, area.x + area.width - width))),
      y: Math.round(Math.max(area.y, Math.min(petDrag.bounds.y + cursor.y - petDrag.cursor.y, area.y + area.height - height))),
    };
    const next = { ...position, width, height };
    const previous = petDrag.applied ?? petDrag.bounds;
    if (Object.keys(next).some(key => next[key] !== previous[key])) {
      petWindow.setBounds(next, false);
      petDrag.applied = next;
    }
    return true;
  }

  function dragPet(action, point) {
    if (!['start', 'move', 'end'].includes(action)) throw new Error('桌宠移动请求无效');
    if (collapsed) return false;
    noteActivity();
    if (point !== undefined && (!point || Object.keys(point).length !== 2 || !['x', 'y'].every(key => Number.isFinite(point[key]) && Math.abs(point[key]) <= 1000000))) throw new Error('桌宠指针坐标无效');
    if (action === 'end') { clearPetDrag(); if (live(petWindow)) lili.rememberPosition(petWindow.getBounds()); return true; }
    if (closing || !live(petWindow) || !petWindow.isVisible()) { clearPetDrag(); return false; }
    const cursor = point ?? screen.getCursorScreenPoint();
    if (action === 'start') {
      clearPetDrag();
      const bounds = petWindow.getBounds();
      if (cursor.x < bounds.x || cursor.x >= bounds.x + bounds.width || cursor.y < bounds.y || cursor.y >= bounds.y + bounds.height) return false;
      const content = petWindow.getContentBounds();
      petDrag = { cursor, bounds: { ...bounds, width: content.width, height: content.height } };
      if (!point) {
        petDragTimer = setInterval(movePetToCursor, 8);
        petDragTimer.unref?.();
      }
      return true;
    }
    return movePetToCursor(point);
  }

  function focusPetInput() {
    if (closing || !expanded || !live(petWindow) || !petWindow.isVisible()) return false;
    if (petWindow.isMinimized()) petWindow.restore();
    petWindow.focus();
    petWindow.webContents.focus();
    return true;
  }

  function showPetPanel(panel = {}) {
    if (petClosePromise) return petClosePromise.then(() => showPetPanel(panel));
    if (!live(petWindow)) throw new Error('独立桌宠尚未就绪，请重新打开客户端。');
    noteActivity();
    if (lili.snapshot().enabled && lili.snapshot().view.clickThrough) lili.command({ type: 'display.set', options: { clickThrough: false } });
    if (petWindow.isMinimized()) petWindow.restore();
    setExpanded(true);
    if (!expanded) {
      petWindow.webContents.send('nuanban:pet:panel', { expanded: false, focusInput: false });
      petWindow.show();
      petWindow.focus();
      return;
    }
    const section = ['features', 'guidance', 'voice', 'observation', 'accessibility', 'question', 'dictation', 'search', 'learning', 'archive', 'todos', 'captions', 'wake', 'avatar'].includes(panel.section) ? panel.section : undefined;
    petWindow.webContents.send('nuanban:pet:panel', { expanded: true, focusInput: panel.focusInput === false ? false : !section,
      ...(section ? { section, ...(section === 'learning' && typeof panel.noteId === 'string' ? { noteId: panel.noteId } : {}) } : {}) });
    petWindow.show();
    focusPetInput();
  }

  async function openFaceVoice() {
    expandFromBall({ focus: false });
    setExpanded(false);
    if (live(petWindow)) {
      if (petWindow.isMinimized()) petWindow.restore();
      petWindow.webContents.send('nuanban:pet:panel', { expanded: false, focusInput: false });
      petWindow.showInactive();
    }
    await voiceHost.open();
  }

  function updateVoiceState(next) {
    const visible = next.active === true || next.microphoneActive === true;
    if (!visible) voiceBubble = { user: '', assistant: '' };
    if (visible !== faceVoiceVisible || (visible && expanded)) {
      faceVoiceVisible = visible;
      setExpanded(visible ? false : expanded);
      if (visible && live(petWindow)) petWindow.webContents.send('nuanban:pet:panel', { expanded: false, focusInput: false });
    }
    publish();
  }

  function updateVoiceTranscript(event) {
    if (closing || !faceVoiceVisible || !['user', 'assistant'].includes(event?.role) || typeof event.text !== 'string' || event.text.length > 6000) return;
    if (event.role === 'user') voiceBubble = { user: event.text, assistant: '' };
    else voiceBubble.assistant = event.text;
    publish();
  }

  function showDialog(configuration) {
    dialogOpen += 1;
    const pending = live(petWindow) ? dialog.showMessageBox(petWindow, configuration) : dialog.showMessageBox(configuration);
    return Promise.resolve(pending).finally(() => {
      dialogOpen = Math.max(0, dialogOpen - 1);
      noteActivity();
    });
  }

  function runAction(operation) {
    void Promise.resolve().then(operation).catch(async () => {
      await showDialog({ type: 'warning', message: '本次操作未完成', detail: '请重试，或先停止观察。不会把未完成操作当作成功。', buttons: ['知道了'] });
    });
  }

  async function chooseObservation(resume = false) {
    if (closing || choosingSource) throw new Error('正在等待本人选择观察范围或桌宠正在退出');
    await singleFrame.cancel();
    if (!['off', 'stopped', 'privacy_paused'].includes(runtime.snapshot().observation.state)) throw new Error('请先停止当前观察，再重新选择范围');
    if (runtime.snapshot().observation.state === 'privacy_paused' && !resume) throw new Error('请本人点击继续共享，不能跳过隐私暂停');
    choosingSource = true;
    const consentGeneration = ++observationConsentGeneration;
    const stillAuthorized = () => !closing && consentGeneration === observationConsentGeneration;
    try {
      const sources = (await source.listSources()).filter(item => item.type === 'screen' && item.geometry && !item.unavailableReason);
      if (!stillAuthorized()) return { ok: true, status: 'cancelled', snapshot: snapshot() };
      if (sources.length === 0) throw new Error('没有可验证几何的系统屏幕捕获源，观察未启动');
      const selected = await new Promise(resolve => {
        let chosen = null;
        const selection = Menu.buildFromTemplate([
          { label: resume ? '本人选择继续共享的屏幕' : '本人选择本地观察的屏幕', enabled: false },
          ...sources.flatMap(item => [
            { label: `${item.name.replace(/[\r\n]/g, ' ').slice(0, 80)} · ${item.geometry.width}×${item.geometry.height}`, click: () => { chosen = item; } },
            { label: `框选观察区域 · ${item.name.replace(/[\r\n]/g, ' ').slice(0, 80)}`, click: () => { chosen = { ...item, chooseRegion: true }; } },
          ]),
          { type: 'separator' }, { label: '取消', click: () => { chosen = null; } },
        ]);
        selection.popup({ window: petWindow, callback: () => resolve(chosen) });
      });
      if (!selected || !stillAuthorized()) return { ok: true, status: 'cancelled', snapshot: snapshot() };
      const region = selected.chooseRegion ? await regionSelector.select(selected.geometry) : null;
      if ((selected.chooseRegion && !region) || !stillAuthorized()) return { ok: true, status: 'cancelled', snapshot: snapshot() };
      const consent = await showDialog({ type: 'info', title: '开启本地观察', message: resume ? '由你本人重新授权，继续实时共享所选范围' : '允许微光指引在本机持续观察所选屏幕吗？',
        detail: `${region ? `本次仅检测框选区域（${region.width}×${region.height}）。系统媒体仍共享所选屏幕；完整帧只在本机内存中临时裁剪并清零，框外内容不进入 OCR 或云端分析。区域是固定位置，不会跟随窗口移动。\n\n` : ''}授权后将持续实时共享所选范围，不再识别敏感文字来决定是否暂停，也不会因未知页面或没有文字自动中断。请自行留意共享内容，可随时在桌宠点击“停止共享”或从托盘停止；关闭管理窗口不会停止共享。仍保留本地文字、人脸遮盖；系统撤权、共享来源断开或本地检测故障时停止采集，需由你本人重新授权。只有你亲手操作电脑，微光指引不会自动打开第三方应用、点击或输入。\n\n云分析为单独可选用途：仅提问、显著变页或核验时，发送必要的本地检测脱敏画面；未勾选则不发送。未配置真实服务时不会使用模拟答案。`,
        buttons: ['开启本地观察', '取消'], defaultId: 1, cancelId: 1, checkboxLabel: '允许为当前教学按需发送脱敏画面到已配置的分析服务', checkboxChecked: false });
      if (consent.response !== 0 || !stillAuthorized()) return { ok: true, status: 'cancelled', snapshot: snapshot() };
      consentedSourceId = selected.id;
      const input = { actor: 'owner', confirmed: true, sourceId: selected.id, sourceName: region ? `${selected.name}（框选区域 ${region.width}×${region.height}）` : selected.name, cloudConsent: consent.checkboxChecked === true, ...(region ? { region } : {}) };
      if (resume) await runtime.resumeObservation(input);
      else await runtime.startObservation(input);
      return { ok: true, snapshot: snapshot() };
    } finally { choosingSource = false; }
  }

  async function selectSingleFrameSource(sources, signal) {
    const available = sources.filter(item => item.type === 'screen' && item.geometry && !item.unavailableReason);
    if (!available.length) throw new Error('没有可验证位置的真实屏幕来源。');
    const selected = await new Promise(resolve => {
      let chosen = null;
      const selection = Menu.buildFromTemplate([
        { label: '选择单帧共享范围（不持续上传）', enabled: false },
        ...available.flatMap(item => [
          { label: `截取一帧 · ${item.name.replace(/[\r\n]/g, ' ').slice(0, 80)}`, click: () => { chosen = item; } },
          { label: `框选一帧 · ${item.name.replace(/[\r\n]/g, ' ').slice(0, 80)}`, click: () => { chosen = { ...item, chooseRegion: true }; } },
        ]),
        { type: 'separator' }, { label: '取消', click: () => { chosen = null; } },
      ]);
      const abort = () => { selection.closePopup?.(petWindow); resolve(null); };
      signal.addEventListener('abort', abort, { once: true });
      selection.popup({ window: petWindow, callback: () => { signal.removeEventListener('abort', abort); resolve(chosen); } });
      if (signal.aborted) abort();
    });
    if (!selected || signal.aborted || closing) return null;
    const abortRegion = () => regionSelector.cancel();
    signal.addEventListener('abort', abortRegion, { once: true });
    let region;
    try { region = selected.chooseRegion ? await regionSelector.select(selected.geometry) : null; }
    finally { signal.removeEventListener('abort', abortRegion); }
    if ((selected.chooseRegion && !region) || signal.aborted || closing) return null;
    const consent = await showDialog({ type: 'question', title: '仅截取一帧', message: '允许在本机截取并脱敏这一帧吗？',
      detail: `范围：${selected.name}${region ? `，框选 ${region.width}×${region.height}` : '，整块屏幕'}。如有持续观察，将先停止。\n\n此步不上传图片。截帧后停止本地采集，预览实际待发送的脱敏图；由你再次点击“仅分析此帧”并确认后，才向已配置的 AI 服务发送这张图片一次。分析后会仅在本机复核目标位置，不上传复核画面。\n\n文字与人脸会遮盖；其他画面仍可能包含私人内容，请优先框选目标图标。微光指引只显示箭头，不控制系统鼠标、不点击或输入。`,
      buttons: ['本机截取一帧', '取消'], defaultId: 1, cancelId: 1, noLink: true });
    if (consent.response !== 0 || signal.aborted || closing) return null;
    return { sourceId: selected.id, ...(region ? { region } : {}) };
  }

  async function runSingleFrame(operation) {
    if (closing || choosingSource) throw new Error('正在选择共享范围或桌宠正在退出。');
    choosingSource = true;
    const epoch = ++singleFrameEpoch;
    singleFrameProtecting = true;
    syncPetProtection(runtime.snapshot().observation);
    try { return await operation(epoch); }
    finally { singleFrameProtecting = false; choosingSource = false; syncPetProtection(runtime.snapshot().observation); }
  }

  async function analyzeSingleFrame(input) {
    if (!input || Array.isArray(input) || Object.keys(input).length !== 2 || typeof input.previewId !== 'string'
      || input.previewId.length > 80 || typeof input.question !== 'string' || !input.question.trim() || input.question.length > 1500) throw new Error('单帧分析参数无效。');
    return runSingleFrame(async epoch => {
      const state = singleFrame.snapshot();
      if (state.state !== 'preview' || !state.hasPreview) throw new Error('请先重新截帧并检查预览。');
      const consent = await showDialog({ type: 'question', title: '仅发送已预览的这一帧', message: '允许把预览的脱敏图片交给 AI 分析一次吗？',
        detail: '仅发送这一张图片及你输入的问题，不持续上传。分析完成后只在本机复核位置；如果画面或目标已变化，则不显示旧坐标。所有实际操作由你本人完成。',
        buttons: ['发送这一帧并分析', '取消'], defaultId: 1, cancelId: 1, noLink: true });
      if (consent.response !== 0 || closing || epoch !== singleFrameEpoch) return { state: 'cancelled', message: '未发送图片，可检查预览后重新决定。', hasPreview: singleFrame.snapshot().hasPreview };
      return singleFrame.analyze(input);
    });
  }

  async function authorizeObservationCloud(observationGeneration) {
    if (!Number.isSafeInteger(observationGeneration) || observationGeneration < 1) throw new Error('请先开启屏幕观察；本次画面分析授权必须对应当前观察范围。');
    const observation = runtime.snapshot().observation;
    const consentGeneration = observationConsentGeneration;
    const current = () => {
      const latest = runtime.snapshot().observation;
      return !closing && consentGeneration === observationConsentGeneration
        && Number.isSafeInteger(observationGeneration) && observationGeneration > 0 && latest.generation === observationGeneration
        && latest.id === observation.id && latest.state === 'observing' && latest.captureActive === true;
    };
    if (!current()) return { ok: false, status: 'observation_changed', message: '屏幕观察已变化，本次画面分析授权未生效；请核对当前状态后由本人重新确认。', snapshot: snapshot() };
    if (choosingCloudConsent || choosingSource) throw new Error('正在等待本人确认画面分析，请先完成当前选择。');
    if (observation.cloudConsent === true) return { ok: true, snapshot: snapshot() };
    choosingCloudConsent = true;
    try {
      const consent = await showDialog({ type: 'question', title: '本次查找的画面分析授权', message: '允许为当前查找按需分析脱敏画面吗？',
        detail: `当前观察范围：${observation.sourceName || '你已选择的屏幕'}。\n\n屏幕观察权限只允许本地观察，不等于允许发送画面。本次单独同意后，仅在你提问、当前教学显著变页或核验时，向已配置的分析服务发送必要的本地检测脱敏画面；安全控件模式只发送已识别的通用控件布局，不发送原画面。不会持续上传，也不会重发旧问题。\n\n不必停止观察或重新选择屏幕。这不授予麦克风权限；停止、隐私暂停或切换观察范围后授权失效。所有点击和输入仍由你亲手完成。取消后保留本地观察与问题草稿，不发送查找。`,
        buttons: ['同意本次按需分析', '仅本地观察'], defaultId: 1, cancelId: 1, noLink: true });
      if (consent.response !== 0 || !current()) return { ok: true, status: 'cancelled', snapshot: snapshot() };
      await runtime.authorizeCloudAnalysis({ actor: 'owner', confirmed: true, observationGeneration });
      return { ok: true, snapshot: snapshot() };
    } finally { choosingCloudConsent = false; }
  }

  async function disableWake() {
    wakeConsentGeneration += 1;
    wakeController?.abort();
    wakeController = null;
    const result = await wake.disable();
    publish();
    return result;
  }

  async function enableWake() {
    if (voiceHost?.snapshot().active) throw new Error('请先结束面对面语音；本地唤醒不与实时对话同时占用麦克风');
    if (closing || choosingWake || wake.snapshot().enabled || wake.snapshot().microphoneActive) throw new Error('本地唤醒正在处理或尚未停止');
    choosingWake = true;
    const consentGeneration = ++wakeConsentGeneration;
    const controller = new AbortController();
    wakeController = controller;
    wakeFailure = '';
    try {
      const confirmation = await showDialog({ type: 'question', title: '单独开启本地语音唤醒', message: '允许微光指引在本机监听“小暖”等唤醒词吗？',
        detail: '仅使用本机离线中文引擎；未唤醒音频不上传、不保存。唤醒后的短问题在本机听写为文字；若已另行同意云端教学，文字可随必要脱敏画面发送分析。此确认不授予屏幕或云端权限，也不代替 Windows 麦克风权限。锁屏、停止或退出会关闭监听；重启不自动恢复。',
        buttons: ['本人同意开启', '暂不开启'], defaultId: 1, cancelId: 1, noLink: true });
      if (confirmation.response !== 0 || controller.signal.aborted || closing || consentGeneration !== wakeConsentGeneration) return;
      const capability = await wake.probe({ signal: controller.signal });
      if (controller.signal.aborted || closing || consentGeneration !== wakeConsentGeneration) return;
      if (capability.status !== 'complete') throw new Error('本机离线中文语音引擎不可用');
      await wake.enable({ actor: 'owner', confirmed: true, signal: controller.signal });
    } catch {
      if (!controller.signal.aborted) {
        wakeFailure = '本机离线中文语音引擎或麦克风未就绪；没有启用云端替代，请使用点击和文字提问。';
        throw new Error(wakeFailure);
      }
    } finally {
      choosingWake = false;
      publish();
    }
  }

  async function requestVoiceDictation({ signal, purpose, observationGeneration } = {}) {
    const screenGuidance = purpose === 'screen-guidance';
    const observationValid = () => {
      const observation = runtime.snapshot().observation;
      return Number.isSafeInteger(observationGeneration) && observationGeneration > 0 && observation.generation === observationGeneration
        && observation.state === 'observing' && observation.captureActive === true && observation.cloudConsent === true;
    };
    if (purpose !== undefined && !screenGuidance) throw new Error('本次语音用途无效');
    if (screenGuidance && !observationValid()) throw new Error('请先开启屏幕观察并单独允许按需脱敏分析，再使用语音查找。');
    if (voiceHost?.snapshot().active) throw new Error('请先结束面对面语音，再使用本地听写');
    if (closing || choosingWake) throw new Error('本地语音正在处理，请先结束当前输入');
    if (typeof wake.dictate !== 'function') throw new Error('请重新打开客户端以加载语音输入功能');
    const cancelled = () => ({ status: 'cancelled', localOnly: true });
    if (signal?.aborted) return cancelled();
    choosingWake = true;
    dictating = true;
    dictationPurpose = purpose ?? '';
    dictationObservationGeneration = screenGuidance ? observationGeneration : 0;
    const consentGeneration = ++wakeConsentGeneration;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    wakeController = controller;
    wakeFailure = '';
    const current = () => !controller.signal.aborted && !closing && consentGeneration === wakeConsentGeneration;
    try {
      // Cloud dictation applies to plain voice input; screen guidance keeps the local engine.
      const cloudMode = !screenGuidance && cloudDictationReady();
      cloudFailure = '';
      const confirmation = await showDialog({ type: 'question', title: screenGuidance ? '本次语音查找与屏幕指引' : cloudMode ? '本次云端语音输入' : '本次本地语音输入',
        message: screenGuidance ? '允许听写这句话，并结合已授权的屏幕查找目标吗？' : cloudMode ? '允许本次使用麦克风，并把这段录音上传到已配置的模型网关识别吗？' : '允许本次使用麦克风，把说话内容填入输入框吗？',
        detail: (screenGuidance ? '仅使用本机离线中文听写。直接说一句“帮我找到……”；最多等待 20 秒，识别结束并关闭麦克风后，识别文字将自动提交，结合当前已授权范围的脱敏画面进行分析。成功定位后绘制高亮和箭头，不控制系统鼠标，不代点或代输。不覆盖已有输入草稿；观察停止或范围改变后，不再发起查找。'
          : cloudMode ? '本人已开启云端听写：本次录制的这一句话会被上传到已配置的模型网关做语音识别，识别结束立即丢弃，不在本机保存、不用于其它用途；识别文字仍需你检查后亲手发送。若云端失败会回退本机离线识别，并明确提示。最多等待 20 秒。'
          : '仅使用本机离线中文听写，不需要先说唤醒词。看到“正在本机听写”后直接说一句话，最多等待 20 秒；识别结束即关闭本次麦克风，文字需由你检查后亲手发送。')
          + (cloudMode ? '\n\n如不再希望上传音频，请在语音面板关闭“云端听写”。此确认不授予新的屏幕观察或云分析权限。' : '\n\n音频不上云、不保存。如果本地语音唤醒已开启，本次输入会先关闭唤醒，不会自动恢复。此确认不授予新的屏幕观察或云分析权限。'),
        buttons: ['本人同意本次输入', '取消'], defaultId: 1, cancelId: 1, noLink: true });
      if (confirmation.response !== 0 || !current() || (screenGuidance && !observationValid())) return cancelled();
      const stopped = await wake.disable();
      if (!current()) return cancelled();
      if (stopped.enabled || stopped.microphoneActive) throw new Error('麦克风停止尚未确认');
      if (cloudMode) {
        cloudRecording = true;
        publish();
        try {
          const recording = await cloudRecorder.record({ signal: controller.signal });
          if (!current()) return cancelled();
          const reply = await cloudDictation.transcribe({ wav: recording.wav, signal: controller.signal });
          if (!current()) return cancelled();
          return Object.freeze({ status: 'complete', text: reply.text, localOnly: false, recognition: 'cloud', microphoneActive: false,
            seconds: recording.seconds, model: cloudDictation.model });
        } catch (error) {
          if (!current()) return cancelled();
          cloudFailure = typeof error?.code === 'string' ? error.code : 'cloud_dictation_failed';
          // Nothing reached the microphone: the offline engine cannot do better on a silent recording.
          if (cloudFailure === 'cloud_dictation_no_speech') throw Object.assign(new Error('cloud_dictation_no_speech'), { code: 'cloud_dictation_no_speech' });
        } finally {
          cloudRecording = false;
          publish();
        }
      }
      const capability = await wake.probe({ signal: controller.signal });
      if (!current() || (screenGuidance && !observationValid())) return cancelled();
      if (capability.status !== 'complete' || capability.dictationAvailable !== true) throw Object.assign(new Error('wake_dictation_unavailable'), { code: 'wake_dictation_unavailable' });
      const result = await wake.dictate({ actor: 'owner', confirmed: true, signal: controller.signal });
      if (!current() || (screenGuidance && !observationValid())) return cancelled();
      return result?.status === 'complete' ? Object.freeze({ ...result, recognition: 'local' }) : result;
    } catch (error) {
      if (!current()) return cancelled();
      wakeFailure = cloudFailure === 'cloud_dictation_no_speech' ? '这次几乎没有收到声音：请靠近麦克风（约 10~15 厘米）、在系统声音设置里提高输入音量或麦克风加强后再说一次；本次未上传音频。'
        : cloudFailure ? '云端识别失败（' + cloudFailure + '），已回退本机离线识别但仍未得到结果；请检查网络与麦克风后重试。'
        : error?.code === 'wake_dictation_timeout' ? '20 秒内未识别到完整语句，请靠近默认麦克风说话，再试一次。'
        : error?.code === 'wake_dictation_unavailable' ? '本机离线中文听写引擎不可用；未改用云端，请检查中文语音组件。'
          : error?.code === 'wake_microphone_access_denied' ? 'Windows 拒绝麦克风访问，请检查麦克风访问和桌面应用访问开关。'
            : '本次语音输入失败，请检查 Windows 默认输入设备、麦克风权限和离线中文语音引擎。';
      throw new Error(wakeFailure);
    } finally {
      signal?.removeEventListener('abort', abort);
      if (wakeController === controller) wakeController = null;
      choosingWake = false;
      dictating = false;
      dictationPurpose = '';
      dictationObservationGeneration = 0;
      publish();
    }
  }

  async function stop(reason = 'user') {
    regionSelector.cancel();
    singleFrameEpoch += 1;
    const singleFrameStopping = singleFrame.cancel().then(() => true, () => false);
    const voiceStopping = voiceHost?.stop(reason) ?? { stopped: true, microphoneActive: false };
    searchBridge?.cancel();
    observationConsentGeneration += 1;
    consentedSourceId = null;
    const [result, localWake, voiceResult, avatarResult, singleFrameStopped] = await Promise.all([runtime.stopObservation(reason), disableWake(), voiceStopping, avatarService?.stop(reason) ?? { stopped: true }, singleFrameStopping]);
    return { ...result, avatarStopped: avatarResult.stopped, singleFrameStopped, stopped: singleFrameStopped && result.stopped === true && voiceResult.stopped === true && localWake.microphoneActive === false && localWake.enabled === false && avatarResult.stopped === true,
      microphoneActive: localWake.microphoneActive || voiceResult.microphoneActive, captureActive: !singleFrameStopped || result.captureActive || localWake.microphoneActive || voiceResult.microphoneActive };
  }

  function closePetWindow() {
    if (petClosePromise) return petClosePromise;
    clearTimeout(idleTimer);
    idleTimer = null;
    clearTimeout(blurTimer);
    blurTimer = null;
    collapsed = false;
    restoreBounds = null;
    if (!options.hasManagementWindow?.()) {
      options.onExit();
      return true;
    }
    petClosePromise = stop('user').then(result => {
      if (!result.stopped) throw new Error(result.avatarStopped === false
        ? '联网形象停止尚未确认，桌宠仍保持可见，请重试。'
        : '采集停止尚未确认，桌宠仍保持可见，请重试。');
      if (options.hasManagementWindow?.()) {
        if (live(petWindow)) petWindow.hide();
      } else options.onExit();
      return true;
    }).finally(() => { petClosePromise = null; });
    return petClosePromise;
  }

  function menu() {
    const current = runtime.snapshot();
    return Menu.buildFromTemplate([
      { label: '微光指引 · 独立桌宠', enabled: false }, { type: 'separator' },
      { label: '角色', submenu: [
        { label: '栗栗 · 兼容二维小鹿', type: 'radio', checked: lili.snapshot().enabled, click: () => runAction(() => selectLili(true)) },
        { label: '原有形象（花环水獭 / 原画 / 本地模型）', type: 'radio', checked: !lili.snapshot().enabled, click: () => runAction(() => selectLili(false)) },
      ] },
      ...(lili.snapshot().enabled ? liliMenuItems() : []),
      { label: '桌宠全部功能', click: () => showPetPanel({ section: 'features' }) },
      { label: collapsed ? '取回桌宠' : '收起为悬浮球', click: () => { menuOpen = false; if (collapsed) expandFromBall(); else collapseToBall('menu'); } },
      { label: '远程与录屏可见（观察期间暂停）', type: 'checkbox', checked: petDisplayCompatible,
        click: () => setPetDisplayCompatibility(!petDisplayCompatible) },
      { label: '星云' + defaultPet.name + ' · 3D 形象', click: () => showPetPanel({ section: 'avatar' }) },
      { label: '停止星云形象（恢复本机桌宠）', enabled: ['connecting', 'ready', 'cleanup_failed'].includes(avatarService?.status().phase), click: () => runAction(() => avatarService.stop()) },
      { label: '光标指引 · 教我操作', click: () => showPetPanel({ section: 'guidance' }) },
      { label: '和微光指引说说 / 教我操作', click: showPetPanel },
      { label: '面对面实时语音…', click: () => runAction(openFaceVoice) },
      { label: '智能查询', click: () => searchBridge?.show() },
      { label: '开始本地观察…', enabled: !choosingSource && ['off', 'stopped'].includes(current.observation.state), click: () => runAction(() => chooseObservation()) },
      { label: '继续共享（本人确认）…', enabled: !choosingSource && current.observation.state === 'privacy_paused', click: () => runAction(() => chooseObservation(true)) },
      { label: '我点好了 · 重新核验', enabled: current.task.state === 'awaiting_action' && current.observation.state === 'observing', click: () => runAction(() => runtime.verify()) },
      { label: '再讲一遍', enabled: Boolean(current.task.instruction), click: () => runAction(() => runtime.repeat()) },
      { label: '结束本次教学（保留观察）', enabled: Boolean(current.task.id) && !['completed', 'ended'].includes(current.task.state), click: () => runAction(() => runtime.finishTeaching()) },
      { label: '大字字幕', type: 'checkbox', checked: current.captions.enabled, click: () => runtime.toggleCaptions() },
      { label: '本地语音唤醒…', type: 'checkbox', checked: wake.snapshot().enabled, enabled: !choosingWake && !voiceHost?.snapshot().active,
        click: () => runAction(() => wake.snapshot().enabled || wake.snapshot().microphoneActive ? disableWake() : enableWake()) },
      { type: 'separator' },
      { label: '学习笔记与复习', click: () => showPetPanel({ section: 'learning' }) },
      { label: '学习档案', click: () => showPetPanel({ section: 'archive', focusInput: false }) },
      { label: '待办与复习', click: () => showPetPanel({ section: 'todos', focusInput: false }) },
      ...[['文字与图片问答', '/chat/new'], ['我的小伙伴', '/pets'], ['本地 3D 桌宠', '/pets/import-3d'], ['画一画', '/pets/draw'], ['亲情陪伴（远程未接通）', '/family'], ['设置与隐私', '/settings'], ['接口与能力状态', '/settings/status'], ['陪伴与无障碍模式', '/onboarding/mode'], ['账号与设备（远程未接入）', '/onboarding/login'], ['资料冲突处理', '/sync/conflicts']].map(([label, route]) => ({ label, click: () => runAction(() => openPetTool(route)) })),
      { label: '打开管理窗口', click: () => runAction(() => options.showManagement('/')) },
      { type: 'separator' }, { label: '停止观察、语音和发送', click: () => runAction(() => stop('user')) },
      { label: '关闭桌宠（停止所有采集）', click: () => runAction(closePetWindow) },
    ]);
  }

  function liliMenuItems() {
    const state = lili.snapshot();
    const send = payload => { lili.command(payload); refreshLiliTray(); };
    return [
      { label: '栗栗动作', submenu: [ ['idle', '站立待机'], ['wave', '招手'], ['guide', '提灯指路'], ['sign', '举空白木牌'], ['success', '成功反馈'], ['rest', '夜间休息'] ]
        .map(([action, label]) => ({ label, click: () => send({ type: 'action.play', action }) })) },
      { label: '栗栗表情', submenu: [ [null, '随动作变化'], ['smile', '温柔微笑'], ['blink', '缓慢眨眼'], ['listening', '认真倾听'], ['happy', '开心'], ['sleepy', '困倦'], ['concern', '担心但平静'] ]
        .map(([expression, label]) => ({ label, click: () => send({ type: 'expression.set', expression }) })) },
      { label: '栗栗大小', submenu: [64, 160, 240, 320].map(size => ({ label: `${size} 像素`, type: 'radio', checked: state.view.size === size,
        click: () => send({ type: 'display.set', options: { size } }) })) },
      { label: '暂停栗栗动画', type: 'checkbox', checked: state.view.paused, click: () => send({ type: 'animation.configure', options: { paused: !state.view.paused } }) },
      { label: '减少动态效果', type: 'checkbox', checked: state.view.reducedMotion, click: () => send({ type: 'animation.configure', options: { reducedMotion: !state.view.reducedMotion } }) },
      { label: '桌宠不置顶（置顶已取消）', enabled: false },
      { label: '鼠标穿透（从托盘取消）', type: 'checkbox', checked: state.view.clickThrough, enabled: Boolean(liliTray),
        click: () => send({ type: 'display.set', options: { clickThrough: !state.view.clickThrough } }) },
      { label: '隐藏栗栗（从托盘恢复）', enabled: Boolean(liliTray), click: () => send({ type: 'display.set', options: { visible: false } }) },
      { type: 'separator' },
    ];
  }

  function refreshLiliTray() {
    if (!liliTray || liliTray.isDestroyed?.()) return;
    liliTray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示桌宠 / 取消鼠标穿透', click: () => { lili.command({ type: 'display.set', options: { visible: true, clickThrough: false } }); if (live(petWindow)) petWindow.showInactive(); } },
      ...liliMenuItems(),
      { label: '打开微光指引面板', click: () => { lili.command({ type: 'display.set', options: { visible: true, clickThrough: false } }); showPetPanel(); } },
      { label: '退出微光指引（停止所有采集）', click: () => runAction(() => options.onExit()) },
    ]));
  }

  function ensureLiliTray() {
    if (liliTray) return true;
    if (!Tray || !nativeImage?.createFromPath) return false;
    try {
      const icon = nativeImage.createFromPath(PRODUCT_ICON_PATH).resize({ width: 32, height: 32 });
      if (icon.isEmpty()) return false;
      liliTray = new Tray(icon);
      liliTray.setToolTip('栗栗 · 微光指引桌宠');
      liliTray.on('double-click', () => { lili.command({ type: 'display.set', options: { visible: true, clickThrough: false } }); if (live(petWindow)) petWindow.showInactive(); });
      return true;
    } catch { return false; }
  }

  function applyLiliView(view) {
    if (!live(petWindow)) return { ok: false, code: 'window_unavailable' };
    if (view.enabled) ensureLiliTray();
    if ((view.clickThrough || view.visible === false) && !liliTray) return { ok: false, code: 'tray_unavailable' };
    petWindow.setIgnoreMouseEvents(view.enabled && view.clickThrough, { forward: true });
    petWindow.setAlwaysOnTop(false);
    petWindow.setOpacity?.(view.enabled ? view.opacity : 1);
    setExpanded(expanded, view);
    if (view.enabled && Number.isFinite(view.x) && Number.isFinite(view.y)) {
      const bounds = petWindow.getBounds();
      const area = screen.getDisplayNearestPoint({ x: view.x, y: view.y }).workArea;
      petWindow.setPosition(Math.round(Math.max(area.x, Math.min(view.x, area.x + area.width - bounds.width))),
        Math.round(Math.max(area.y, Math.min(view.y, area.y + area.height - bounds.height))), false);
    }
    if (view.visible === false) petWindow.hide();
    else if (view.visible === true) petWindow.showInactive();
    refreshLiliTray();
    return { ok: true };
  }

  async function selectLili(value) {
    if (typeof value !== 'boolean') return { ok: false, code: 'invalid_selection' };
    if (value && ['connecting', 'ready', 'cleanup_failed'].includes(avatarService?.status().phase)) {
      const stopped = await avatarService.stop();
      if (stopped?.stopped !== true) return { ok: false, code: 'avatar_stop_unconfirmed' };
    }
    const result = lili.setEnabled(value);
    refreshLiliTray();
    return result;
  }

  async function showLocalModel() {
    if (!live(petWindow)) throw new Error('独立桌宠尚未就绪，请重新打开客户端。');
    if (['connecting', 'ready', 'cleanup_failed'].includes(avatarService?.status().phase)) {
      const stopped = await avatarService.stop();
      if (stopped?.stopped !== true) throw new Error('原角色尚未停止，内置伙伴未切换。请稍后重试。');
    }
    if (lili.snapshot().enabled) {
      const selected = await selectLili(false);
      if (selected?.ok !== true) throw new Error('原角色未能切换，内置伙伴未应用。请重试。');
    }
    await showPetPanel({ focusInput: false });
    return true;
  }

  function handle(channel, action) {
    channels.push(channel);
    ipcMain.handle(channel, (event, ...argumentsList) => {
      if (!trusted(event, petWindow, petPath)) throw new Error('不可信桌宠来源');
      return action(...argumentsList);
    });
  }

  function openPetTool(route) {
    if (typeof route !== 'string' || !petToolRoutes.has(route)) throw new Error('桌宠工具不存在');
    if (route === '/notes' || route === '/todos') {
      showPetPanel({ section: route === '/notes' ? 'archive' : 'todos', focusInput: false });
      return true;
    }
    if (typeof options.showPetTool !== 'function') throw new Error('桌宠工具窗口尚未接入');
    return options.showPetTool(route);
  }

  async function command(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.type !== 'string') throw new Error('桌宠指令无效');
    const fields = { 'observation.authorize-cloud': ['type', 'observationGeneration'], 'panel.set-expanded': ['type', 'expanded'], 'learning.set-mastery': ['type', 'noteId', 'mastered'],
      'guidance.reply': ['type', 'text', 'guideId', 'taskGeneration', 'observationGeneration'],
      'guidance.rescan': ['type', 'guideId', 'taskGeneration', 'observationGeneration'],
      'learning.review.confirm': ['type', 'proposalId'], 'learning.review.decline': ['type', 'proposalId'] };
    const allowed = fields[payload.type] ?? ['type'];
    if (Object.keys(payload).some(key => !allowed.includes(key))) throw new Error('桌宠指令包含不允许的参数');
    switch (payload.type) {
      case 'observation.start': return chooseObservation();
      case 'observation.authorize-cloud': return authorizeObservationCloud(payload.observationGeneration);
      case 'observation.reselect': {
        const stopped = await stop('reselect');
        if (stopped.stopped !== true || stopped.captureActive !== false) throw new Error('旧屏幕观察停止尚未确认，请勿继续选择或共享。');
        return chooseObservation();
      }
      case 'observation.resume': return chooseObservation(true);
      case 'observation.stop': await stop(); break;
      case 'guidance.verify': await runtime.verify(); break;
      case 'guidance.finish': await runtime.finishTeaching(); break;
      case 'guidance.repeat': runtime.repeat(); break;
      case 'guidance.reply': await runtime.replyToClarification(payload); break;
      case 'guidance.rescan': await runtime.rescanClarification(payload); break;
      case 'captions.toggle': runtime.toggleCaptions(); break;
      case 'wake.enable': await enableWake(); break;
      case 'wake.disable': await disableWake(); break;
      case 'voice.open': await openFaceVoice(); break;
      case 'voice.stop': {
        const result = await voiceHost.stop();
        if (result.stopped !== true || result.microphoneActive !== false) throw new Error('麦克风停止尚未确认，请重试结束语音');
        break;
      }
      case 'voice.mute': await voiceHost.control('mute'); break;
      case 'voice.unmute': await voiceHost.control('unmute'); break;
      case 'voice.interrupt': await voiceHost.control('interrupt'); break;
      case 'learning.set-mastery':
        if (!learningStore || typeof payload.noteId !== 'string' || typeof payload.mastered !== 'boolean') throw new Error('本人掌握确认参数无效');
        learningStore.confirmMastery({ actor: 'owner', noteId: payload.noteId, mastered: payload.mastered });
        publish(); break;
      case 'learning.review.confirm':
        if (!learningStore || typeof payload.proposalId !== 'string') throw new Error('复习确认参数无效');
        learningStore.confirmReview({ actor: 'owner', proposalId: payload.proposalId });
        pollReviews(); break;
      case 'learning.review.decline':
        if (!learningStore || typeof payload.proposalId !== 'string') throw new Error('复习拒绝参数无效');
        learningStore.declineReview({ actor: 'owner', proposalId: payload.proposalId });
        publish(); break;
      case 'panel.set-expanded':
        if (typeof payload.expanded !== 'boolean') throw new Error('面板状态无效');
        setExpanded(payload.expanded);
        if (expanded) focusPetInput();
        break;
      default: throw new Error('不支持的桌宠指令');
    }
    return { ok: true, snapshot: snapshot() };
  }

  function listen(emitter, event, callback) {
    emitter.on(event, callback);
    listeners.push(() => emitter.removeListener(event, callback));
  }

  async function initialize() {
    const avatarCredentials = await (options.loadAvatarCredentials ?? loadXingyunCredentials)().catch(() => undefined);
    avatarService = createXingyunAvatarService({ credentials: avatarCredentials, onState: state => {
      if (live(petWindow)) petWindow.webContents.send('nuanban:avatar:state', state);
    } });
    try {
      learningStore = (options.createLearningStore ?? createRuntimeLearningStore)({ databasePath: path.join(options.userDataPath, 'nuanban-runtime-learning.sqlite'), payloadCodec: createSafeStoragePayloadCodec(safeStorage) });
    } catch { learningUnavailable = true; }
    runtime = createDesktopRuntime({ source, analyzer, questioner: options.questioner, onState: publish, onTarget: showGuide,
      recordTeaching: note => { if (!learningStore) throw new Error('加密教学仓储不可用'); return learningStore.recordTeaching(note); },
      suggestReview: proposal => { if (!learningStore) throw new Error('加密教学仓储不可用'); const result = learningStore.suggestReview(proposal); publish(); return result; } });
    const area = screen.getPrimaryDisplay().workArea;
    petWindow = new BrowserWindow({ width: 300, height: Math.min(390, area.height - 24), x: area.x + area.width - 324, y: area.y + area.height - Math.min(414, area.height - 12),
      title: '微光指引桌宠', icon: PRODUCT_ICON_PATH, show: false, transparent: true, frame: false, hasShadow: false, alwaysOnTop: false, skipTaskbar: true,
      focusable: true, resizable: false, movable: true, backgroundColor: '#00000000', webPreferences: windowPreferences('pet-preload.cjs') });
    guideWindow = new BrowserWindow({ width: 400, height: 300, title: '微光指引教学指引', icon: PRODUCT_ICON_PATH, show: false, transparent: true, frame: false,
      hasShadow: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, resizable: false, backgroundColor: '#00000000', webPreferences: windowPreferences('guide-preload.cjs') });
    captionWindow = new BrowserWindow({ width: 700, height: 116, title: '微光指引大字字幕', icon: PRODUCT_ICON_PATH, show: false, transparent: true, frame: false,
      hasShadow: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, resizable: false, backgroundColor: '#00000000', webPreferences: windowPreferences('caption-preload.cjs') });
    for (const window of [petWindow, captionWindow]) secureWindow(window);
    secureWindow(guideWindow, false);
    for (const window of [guideWindow, captionWindow]) window.setAlwaysOnTop(true, 'floating');
    petWindow.setAlwaysOnTop(false);
    syncPetProtection(runtime.snapshot().observation);
    guideWindow.setIgnoreMouseEvents(true, { forward: true });
    captionWindow.setIgnoreMouseEvents(true, { forward: true });
    petWindow.on('close', event => { if (!options.isQuitting()) { event.preventDefault(); runAction(closePetWindow); } });
    petWindow.on('closed', () => { petWindow = null; if (!options.isQuitting()) options.onExit(); });
    petWindow.on('focus', () => {
      clearTimeout(blurTimer);
      blurTimer = null;
      noteActivity();
    });
    petWindow.on('blur', () => {
      clearPetDrag();
      clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        blurTimer = null;
        collapseToBall('blur');
      }, 300);
      blurTimer.unref?.();
    });
    petWindow.on('show', () => resetIdleTimer());
    petWindow.webContents.on('render-process-gone', () => { runAction(() => stop('renderer-gone')); });
    petWindow.on('unresponsive', () => { runAction(() => stop('renderer-gone')); });
    guideWindow.webContents.on('render-process-gone', () => { clearGuide(); runAction(() => stop('renderer-gone')); });
    guideWindow.webContents.on('did-finish-load', () => { if (pendingGuide) guideWindow.webContents.send('nuanban:guide:state', pendingGuide); });
    captionWindow.webContents.on('did-finish-load', updateCaptions);
    handle('nuanban:pet:snapshot', snapshot);
    handle('nuanban:pet:activity', () => { noteActivity(); return true; });
    handle('nuanban:pet:expand', () => expandFromBall());
    handle('nuanban:pet:collapse', () => collapseToBall('manual'));
    handle('nuanban:pet:focus-input', input => {
      if (input !== undefined) throw new Error('桌宠聚焦参数无效');
      return focusPetInput();
    });
    handle('nuanban:pet:command', command);
    handle('nuanban:pet:single-frame:snapshot', () => singleFrame.snapshot());
    handle('nuanban:pet:single-frame:capture', input => {
      if (input !== undefined) throw new Error('单帧截图参数无效。');
      return runSingleFrame(async epoch => {
        observationConsentGeneration += 1;
        consentedSourceId = null;
        await runtime.stopObservation('user');
        if (epoch !== singleFrameEpoch || closing) return { state: { state: 'cancelled', message: '单帧截图已取消，未发送图片。', hasPreview: false } };
        return singleFrame.capture();
      });
    });
    handle('nuanban:pet:single-frame:analyze', analyzeSingleFrame);
    handle('nuanban:pet:single-frame:cancel', async () => { singleFrameEpoch += 1; regionSelector.cancel(); await singleFrame.cancel(); return singleFrame.snapshot(); });
    handle('nuanban:pet:drag', dragPet);
    handle('nuanban:lili:bootstrap', lili.bootstrap);
    handle('nuanban:lili:select', selectLili);
    handle('nuanban:lili:command', payload => { const result = lili.command(payload); refreshLiliTray(); return result; });
    handle('nuanban:lili:interaction', lili.interaction);
    for (const event of ['blur', 'hide', 'closed']) listen(petWindow, event, clearPetDrag);
    listen(petWindow.webContents, 'render-process-gone', clearPetDrag);
    handle('nuanban:pet:ask', async input => {
      if (!input || typeof input.text !== 'string' || !Object.keys(input).every(key => ['text', 'observationGeneration'].includes(key))
        || (Object.hasOwn(input, 'observationGeneration') && (!Number.isSafeInteger(input.observationGeneration) || input.observationGeneration < 1))) throw new Error('提问参数无效');
      await runtime.ask(input.text, input.observationGeneration);
      return { ok: true, snapshot: snapshot() };
    });
    handle('nuanban:pet:context-menu', () => {
      menuOpen = true;
      menu().popup({ window: petWindow, callback: () => { menuOpen = false; noteActivity(); } });
      return true;
    });
    handle('nuanban:pet:open-main', route => { if (typeof route !== 'string' || !managementRoutes.has(route)) throw new Error('管理页面不存在'); return options.showManagement(route); });
    handle('nuanban:pet:open-tool', openPetTool);
    handle('nuanban:pet:close', closePetWindow);
    avatarBridge = registerXingyunAvatarBridge({ ipcMain, service: avatarService, isTrusted: event => trusted(event, petWindow, petPath) });
    dictationBridge = registerDictationBridge({ ipcMain, prefix: 'nuanban:pet:voice', isTrusted: event => trusted(event, petWindow, petPath),
      getHost: () => ({ hasPetWindow: () => live(petWindow), requestVoiceDictation }) });
    searchBridge = registerPetSearchBridge({ ipcMain, isTrusted: event => trusted(event, petWindow, petPath),
      client: options.searchClient ?? createPetSearchClient({
        anySearch: createAnySearchClient({ getApiKey: () => options.anysearchKeyStore?.read() }),
        model: createModelSearchClient({ provider: options.questioner }),
      }),
      openExternal: url => options.electron.shell.openExternal(url),
      showSearch: () => {
        showPetPanel({ focusInput: false, section: 'search' });
        petWindow.webContents.send('nuanban:pet-search:opened');
      } });
    voiceHost = (options.createVoiceHost ?? createRealtimeVoiceHost)({ electron: options.electron, showDialog, onState: updateVoiceState, onTranscript: updateVoiceTranscript,
      presentation: 'pet', client: options.voiceClient, provider: options.questioner,
      beforeStart: async () => {
        await disableWake();
        if (wake.snapshot().enabled || wake.snapshot().microphoneActive) throw new Error('本地唤醒的麦克风尚未真实停止');
      } });
    listen(powerMonitor, 'lock-screen', () => runAction(() => stop('lock')));
    listen(powerMonitor, 'suspend', () => runAction(() => stop('lock')));
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) listen(screen, event, () => {
      clearPetDrag(); clearGuide(); if (!collapsed) setExpanded(expanded); if (live(petWindow)) lili.rememberPosition(petWindow.getBounds()); runAction(() => stop('window-moved'));
    });
    if (options.liliEnabled === true) lili.setEnabled(true);
    lili.start();
    await Promise.all([petWindow.loadFile(petPath), guideWindow.loadFile(guidePath), captionWindow.loadFile(captionPath)]);
    petWindow.showInactive();
    resetIdleTimer();
    pollReviews();
    reminderTimer = setInterval(pollReviews, 15000);
    reminderTimer.unref?.();
    publish();
  }

  async function dispose(reason) {
    singleFrameEpoch += 1;
    clearTimeout(idleTimer);
    idleTimer = null;
    clearTimeout(blurTimer);
    blurTimer = null;
    const singleFrameStopping = singleFrame.cancel().then(() => true, () => false);
    clearPetDrag();
    lili.rememberPosition(live(petWindow) ? petWindow.getBounds() : null);
    lili.dispose();
    liliTray?.destroy();
    liliTray = null;
    regionSelector.dispose();
    closing = true;
    const voiceStopping = voiceHost?.dispose() ?? { stopped: true, microphoneActive: false };
    searchBridge?.dispose();
    dictationBridge?.dispose();
    observationConsentGeneration += 1;
    clearTimeout(guideTimer);
    clearInterval(reminderTimer);
    consentedSourceId = null;
    const [runtimeResult, localWake, voiceResult, avatarResult, singleFrameStopped] = await Promise.all([
      runtime ? runtime.dispose(reason) : { stopped: true, captureActive: false, mediaActive: false, reason }, disableWake(), voiceStopping,
      avatarService?.dispose() ?? { stopped: true }, singleFrameStopping,
    ]);
    const result = { ...runtimeResult, avatarStopped: avatarResult.stopped, singleFrameStopped, stopped: singleFrameStopped && runtimeResult.stopped === true && voiceResult.stopped === true && localWake.microphoneActive === false && localWake.enabled === false && avatarResult.stopped === true,
      microphoneActive: localWake.microphoneActive || voiceResult.microphoneActive, captureActive: !singleFrameStopped || runtimeResult.captureActive || localWake.microphoneActive || voiceResult.microphoneActive };
    if (result.stopped) {
      avatarBridge?.dispose();
      for (const unsubscribe of listeners.splice(0)) unsubscribe();
      for (const channel of channels.splice(0)) ipcMain.removeHandler(channel);
      learningStore?.close();
      learningStore = null;
    }
    return result;
  }

  async function setCloudDictation(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('云端听写开关参数无效');
    if (!cloudSettings?.write) throw new Error('当前客户端不支持云端听写开关');
    const status = cloudDictationStatus();
    if (enabled && !status.available) throw new Error('本机尚未配置可用的模型网关，云端听写不可用');
    if (enabled) {
      const confirmation = await showDialog({ type: 'question', title: '开启云端语音听写',
        message: '开启后，每次语音输入的这一句话会被上传到已配置的模型网关做识别，用于替代本机离线识别。是否开启？',
        detail: '仅在你每次确认“本次语音输入”后录音并上传；识别结束立即丢弃，不在本机保存，不用于其它用途；识别文字仍需你检查后亲手发送。关闭开关后立即恢复为仅本机离线识别。\n\n音频上传属于隐私边界变更，请确认你接受后再开启。',
        buttons: ['本人同意开启云端听写', '取消'], defaultId: 1, cancelId: 1, noLink: true });
      if (confirmation.response !== 0) return Object.freeze({ enabled: cloudSettings.read().enabled });
    }
    cloudSettings.write({ enabled });
    publish();
    return Object.freeze({ enabled });
  }

  return { initialize, dispose, stop, snapshot, showPetPanel, showLocalModel, setPetDisplayCompatibility, selectLili, lili, requestObservation: resume => chooseObservation(resume === true),
    cloudDictationStatus, setCloudDictation,
    requestLocalVoice: enableWake, stopLocalVoice: disableWake, requestVoiceDictation,
    hasPetWindow: () => live(petWindow), getPetWindow: () => live(petWindow) ? petWindow : null };
}

module.exports = { createStandaloneHost };
