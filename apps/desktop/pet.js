(() => {
  'use strict';

  const bridge = window.nuanbanPet;
  const element = name => document.getElementById(name);
  const pending = new Set();
  const removers = [];
  const composerSections = ['guidance', 'question', 'dictation'];
  const sectionViews = {
    features: { title: '暖暖的功能小屋', target: 'feature-home', panels: ['feature-home'] },
    avatar: { title: '星云花环水獭 · 3D 形象', target: 'avatar-view', panels: ['avatar-view'] },
    question: { title: '桌宠提问', target: 'question', panels: ['question-view', 'conversation-view'] },
    dictation: { title: '本地语音输入', target: 'dictation-view', panels: ['dictation-view', 'conversation-view'] },
    guidance: { title: '光标指引', target: 'lesson-card', panels: ['lesson-card', 'conversation-view'] },
    voice: { title: '语音陪伴', target: 'voice-section', panels: ['voice-section'] },
    observation: { title: '本地观察与脱敏', target: 'observation-section', panels: ['observation-section'] },
    search: { title: '智能查询', target: 'search-query', panels: ['search-view'] },
    learning: { title: '学习笔记与复习', target: 'learning-summary', panels: ['learning-view'] },
    archive: { title: '学习档案', target: 'archive-view', panels: ['archive-view'] },
    todos: { title: '待办与复习', target: 'todos-view', panels: ['todos-view'] },
    captions: { title: '大字字幕', target: 'toggle-captions', panels: ['captions-view'] },
    wake: { title: '本地语音唤醒', target: 'toggle-wake', panels: ['wake-view'] },
    accessibility: { title: '管理与退出', target: 'accessibility-section', panels: ['accessibility-section'] },
  };
  const viewPanels = [...new Set(Object.values(sectionViews).flatMap(view => view.panels))];
  const observationLabels = { off: '本地观察未开启', awaiting_permission: '等待本人授权', observing: '正在本地观察', privacy_paused: '隐私暂停', stopped: '观察已停止', cleanup_failed: '停止尚未确认' };
  const analysisLabels = { idle: '云端未在分析', unavailable: '云分析不可用', analyzing: '按需分析中', capture_retry: '正在刷新本地画面', capture_error: '本地画面待重试', ready: '本次分析就绪', error: '云分析失败' };
  const taskLabels = { idle: '等待你的问题', analyzing: '正在理解这一步', awaiting_action: '轮到你亲手操作', verifying: '正在用新画面核验', completed: '本次教学已完成', needs_help: '需要再确认一下', ended: '本次教学已结束' };
  let runtime = {};
  let ready = false;
  let disposed = false;
  let unsubscribe;
  let unsubscribePanel;
  let snapshotRequest = 0;
  let stateVersion = 0;
  let newestGeneration = -1;
  let expanded = false;
  let activeSection = 'features';
  let desiredExpanded;
  let syncingPanel = false;
  let retryAction;
  let messagesSignature = '';
  let guidanceFeedbackSignature = '';
  let clarificationDraftKey = '';
  let newQuestionKey = '';
  let draftVersion = 0;
  let focusRequest = 0;
  let dictationGeneration = 0;
  let voiceFindMode = false;
  let dictationNotice = '';
  let guidanceNoticeGeneration;
  let dictationTranscript = '';
  let learningRequested = false;
  let recentNotesSignature = '';
  let dueReviewsSignature = '';
  let learningNavigation;
  let learningNotice = '';
  let faceVoiceShown = false;
  const notifications = new Map();
  const seenNotificationMessages = new Set();
  let knownTodoNotifications = new Set();
  let notificationsInitialized = false;
  let privacyNotification = '';
  let errorNotification = '';
  let petDrag;
  let suppressPetClick = false;

  function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function text(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value : fallback;
  }

  function bind(target, name, handler, options) {
    target.addEventListener(name, handler, options);
    removers.push(() => target.removeEventListener(name, handler, options));
  }

  function faceVoiceActive() {
    const voice = record(runtime.voice);
    return voice.presentation === 'pet' && (voice.active === true || voice.microphoneActive === true);
  }

  function renderFaceVoice(voice) {
    const active = faceVoiceActive();
    element('pet-window').classList.toggle('is-voice-chat', active);
    element('pet-window').dataset.voiceState = active ? text(voice.state, 'connecting') : 'off';
    element('pet-voice-bubble').hidden = !active;
    element('pet-voice-controls').hidden = !active;
    element('pet-toggle').disabled = false;
    if (!active) {
      for (const identifier of ['pet-voice-you', 'pet-voice-text', 'pet-voice-note']) element(identifier).textContent = '';
      faceVoiceShown = false;
      return;
    }
    if (expanded) setExpanded(false, { notifyHost: false });
    const labels = { confirming: '等待你的确认', connecting: '正在准备语音', listening: '正在听你说', thinking: '暖暖想一想', speaking: '暖暖在说话', muted: '麦克风已静音', stopping: '正在关闭麦克风', error: '停止尚未确认' };
    const prompts = { confirming: '请先确认本次语音用途，麦克风尚未开启。', connecting: '正在准备本次语音，请稍候…', listening: '我在听，你慢慢说。', thinking: '正在等模型回答，请稍候…', speaking: '暖暖正在回答你。', muted: '先安静一会儿，点击下方恢复麦克风。', stopping: '正在等麦克风和语音真正停止…' };
    const bubble = record(voice.bubble);
    element('pet-voice-state').textContent = labels[voice.state] || '语音状态待确认';
    element('pet-voice-you').hidden = !text(bubble.user);
    element('pet-voice-you').textContent = text(bubble.user) ? '你说：' + bubble.user : '';
    const reply = voice.state === 'error' ? text(voice.message, '请再次点击结束，确认麦克风停止。') : text(bubble.assistant, prompts[voice.state] || text(voice.message));
    if (element('pet-voice-text').textContent !== reply) {
      element('pet-voice-text').textContent = reply;
      element('pet-voice-text').scrollTop = element('pet-voice-text').scrollHeight;
    }
    element('pet-voice-note').textContent = voice.mode === 'local'
      ? voice.state === 'speaking' ? '朗读时暂停听写 · 想说话时点“打断”' : '本机听写与朗读 · 文字按授权交给已有模型'
      : '云端实时语音 · 静音不释放麦克风，结束才关闭';
    const busy = ['voice.mute', 'voice.unmute', 'voice.stop'].some(type => pending.has(type));
    element('pet-voice-mute').disabled = busy || !['listening', 'thinking', 'speaking', 'muted'].includes(voice.state);
    element('pet-voice-mute').textContent = voice.state === 'muted' ? '恢复麦克风' : '静音麦克风';
    element('pet-voice-mute').setAttribute('aria-pressed', String(voice.state === 'muted'));
    element('pet-voice-interrupt').disabled = busy || pending.has('voice.interrupt') || voice.state !== 'speaking';
    element('pet-voice-end').disabled = pending.has('voice.stop');
    element('pet-voice-end').textContent = pending.has('voice.stop') ? '结束中…' : '结束';
    if (!faceVoiceShown) element('pet-voice-end').focus({ preventScroll: true });
    faceVoiceShown = true;
  }

  function flags() {
    const observation = record(runtime.observation);
    const task = record(runtime.task);
    const analysis = record(runtime.analysis);
    const privacyPaused = observation.state === 'privacy_paused';
    const cleanupFailed = observation.state === 'cleanup_failed';
    const safetyUnclassified = /unclassified_screen|unknown|未分类|安全.*未知/i.test(text(observation.reason));
    const captureConflict = observation.captureActive === true && observation.state !== 'observing';
    const privacyConflict = privacyPaused && analysis.state === 'analyzing';
    const generationKnown = Number.isSafeInteger(observation.generation) && observation.generation >= 0;
    const safeObserving = ready && observation.state === 'observing' && observation.captureActive === true && generationKnown && observation.generation > 0;
    const taskBusy = ['analyzing', 'verifying'].includes(task.state);
    const activeTask = ['analyzing', 'awaiting_action', 'verifying', 'needs_help'].includes(task.state);
    const taskOutdated = activeTask && (!generationKnown || task.observationGeneration !== observation.generation);
    const blocked = cleanupFailed || safetyUnclassified || captureConflict || privacyConflict;
    const observationPending = [...pending].some(type => type.startsWith('observation.'));
    const guidancePending = [...pending].some(type => type.startsWith('guidance.'));
    const bridgeAvailable = typeof bridge?.command === 'function';
    const voice = record(runtime.voice);
    return {
      observation, task, analysis, privacyPaused, cleanupFailed, safetyUnclassified, captureConflict, privacyConflict, blocked, safeObserving, activeTask, taskOutdated, observationPending,
      canAsk: ready && typeof bridge?.ask === 'function' && !privacyPaused && !blocked && !taskBusy && !observationPending && !pending.has('ask') && !pending.has('dictate') && !pending.has('voice-find')
        && (activeSection === 'guidance' ? safeObserving && (observation.cloudConsent === true || (observation.cloudConsent === false && bridgeAvailable)) : safeObserving || (['off', 'stopped'].includes(observation.state) && observation.captureActive === false)),
      canVoiceFind: ready && safeObserving && (observation.cloudConsent === true || (observation.cloudConsent === false && bridgeAvailable)) && !blocked && !taskBusy && !observationPending && !guidancePending
        && !pending.has('ask') && !pending.has('dictate') && !pending.has('voice-find') && voice.active !== true
        && typeof bridge?.ask === 'function' && typeof bridge?.dictate === 'function' && typeof bridge?.cancelDictation === 'function',
      canStart: ready && !blocked && ['off', 'stopped'].includes(observation.state) && observation.captureActive === false && !observationPending,
      canStop: bridgeAvailable && !pending.has('observation.stop') && (!['off', 'stopped'].includes(observation.state) || observation.captureActive !== false
        || pending.has('ask') || (task.kind === 'text' && taskBusy)
        || record(runtime.wake).state === 'enabled' || record(runtime.wake).microphoneActive === true || record(runtime.voice).active === true || record(runtime.voice).microphoneActive === true || pending.has('voice.open') || pending.has('wake.enable') || pending.has('dictate') || observationPending),
      canResume: ready && privacyPaused && !cleanupFailed && !captureConflict && !privacyConflict && observation.captureActive === false && generationKnown && !observationPending,
      canVerify: safeObserving && !blocked && !taskOutdated && ['awaiting_action', 'needs_help'].includes(task.state) && Boolean(text(task.instruction)) && !guidancePending && !observationPending && !pending.has('ask'),
      canRepeat: ready && !privacyPaused && !blocked && !taskOutdated && ['awaiting_action', 'needs_help', 'completed'].includes(task.state) && Boolean(text(task.instruction)) && !guidancePending && !observationPending && !pending.has('ask'),
      canFinish: ready && activeTask && !pending.has('guidance.finish'),
    };
  }

  function renderMessages() {
    const messages = Array.isArray(runtime.messages) ? runtime.messages.filter(message => message && ['user', 'assistant', 'system'].includes(message.role) && typeof message.text === 'string').slice(-8) : [];
    element('view-conversation').hidden = messages.length === 0;
    const signature = JSON.stringify(messages);
    if (signature === messagesSignature) return;
    messagesSignature = signature;
    const fragment = document.createDocumentFragment();
    for (const message of messages) {
      const item = document.createElement('li');
      const author = document.createElement('span');
      const body = document.createElement('span');
      item.dataset.role = message.role;
      author.className = 'message-author';
      author.textContent = { user: '你', assistant: '暖暖', system: '运行提示' }[message.role];
      body.textContent = message.text;
      item.append(author, body);
      fragment.append(item);
    }
    element('message-list').replaceChildren(fragment);
    element('conversation').hidden = messages.length === 0;
  }

  function renderNotifications(state = flags()) {
    if (ready) {
      const messages = Array.isArray(runtime.messages) ? runtime.messages : [];
      for (const message of messages) {
        if (!message || !['assistant', 'system'].includes(message.role) || !text(message.text)) continue;
        const key = validIdentifier(message.id) ? message.id : JSON.stringify([message.role, message.text]);
        if (seenNotificationMessages.has(key)) continue;
        seenNotificationMessages.add(key);
        if (seenNotificationMessages.size > 128) seenNotificationMessages.delete(seenNotificationMessages.values().next().value);
        if (notificationsInitialized && !faceVoiceActive()) notifications.set('messages', state.task.kind === 'guidance' ? 'guidance' : 'question');
      }
      notificationsInitialized = true;
    }
    const privacy = state.cleanupFailed || state.privacyPaused || state.blocked
      ? JSON.stringify([state.cleanupFailed, state.privacyPaused, state.blocked, record(runtime.observation).reason]) : '';
    if (privacy !== privacyNotification) {
      privacyNotification = privacy;
      notifications.delete('privacy');
      if (privacy) notifications.set('privacy', 'observation');
    }
    const error = element('error-notice').hidden ? '' : element('error-text').textContent;
    if (error !== errorNotification) {
      errorNotification = error;
      notifications.delete('error');
      if (error) notifications.set('error', 'features');
    }
    if (expanded) {
      for (const [key, section] of notifications) {
        const conversationVisible = section === 'question' && sectionViews[activeSection].panels.includes('conversation-view');
        if (key === 'privacy' || key === 'error' || section === activeSection || conversationVisible) notifications.delete(key);
      }
    }
    element('pet-notification').hidden = notifications.size === 0 || expanded || faceVoiceActive();
  }

  function masteryLabel(value) {
    if (value === 'mastered' || value === true) return '已掌握（本人标记）';
    if (value === 'unmastered' || value === false) return '尚未掌握';
    return '掌握状态待确认';
  }

  function learningResult(value) {
    const labels = { completed: '教学已完成', unfinished: '教学未完成', failed: '教学未完成 / 失败', ended: '教学已结束', interrupted: '教学已中断' };
    return Object.hasOwn(labels, value) ? labels[value] : '教学结果待确认';
  }

  function validIdentifier(value) {
    return typeof value === 'string' && Boolean(value.trim()) && value === value.trim() && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
  }

  function reviewTime(proposal) {
    const timezone = text(proposal.timezone);
    const invalid = { valid: false, future: false, label: '具体日期与时点尚未确认', timezone, iso: '' };
    if (!timezone || !(timezone === 'UTC' || /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/.test(timezone))) return invalid;
    const raw = proposal.remindAt;
    if (typeof raw !== 'number' && typeof raw !== 'string') return invalid;
    if (typeof raw === 'string') {
      const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(raw);
      if (!parts) return invalid;
      const [, year, month, day, hour, minute, second] = parts;
      const monthNumber = Number(month);
      const dayNumber = Number(day);
      const daysInMonth = new Date(Date.UTC(Number(year), monthNumber, 0)).getUTCDate();
      if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > daysInMonth || Number(hour) > 23 || Number(minute) > 59 || Number(second || '0') > 59) return invalid;
    }
    const instant = typeof raw === 'number' ? raw : Date.parse(raw);
    if (!Number.isFinite(instant)) return invalid;
    try {
      const date = new Date(instant);
      const label = new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
      return { valid: true, future: instant > Date.now(), label, timezone, iso: date.toISOString() };
    } catch {
      return invalid;
    }
  }

  function learningState() {
    const learning = record(runtime.learning);
    const note = record(learning.note);
    const proposal = record(learning.proposal);
    const unavailable = runtime.learningUnavailable === true;
    const error = text(runtime.learningError, /本次教学记录未保存|教学记录.*保存失败/.test(text(runtime.message)) ? text(runtime.message) : '');
    const available = ready && !unavailable && !error;
    const masteryPending = pending.has('learning.set-mastery');
    const reviewPending = pending.has('learning.review.confirm') || pending.has('learning.review.decline');
    const time = reviewTime(proposal);
    return {
      learning, note, proposal, unavailable, error, time,
      canSetMastery: available && validIdentifier(note.id) && !masteryPending,
      canConfirm: available && validIdentifier(proposal.id) && proposal.state === 'suggested' && time.valid && time.future && !reviewPending,
      canDecline: available && validIdentifier(proposal.id) && proposal.state === 'suggested' && !reviewPending,
    };
  }

  function renderRecentNotes(notes) {
    const signature = JSON.stringify(notes);
    if (signature === recentNotesSignature) return;
    recentNotesSignature = signature;
    const list = element('recent-notes-list');
    const openKeys = new Set(Array.from(list.children).map(item => item.firstElementChild).filter(detail => detail?.open).map(detail => detail.dataset.recordKey));
    const fragment = document.createDocumentFragment();
    for (const [index, note] of notes.entries()) {
      const item = document.createElement('li');
      const detail = document.createElement('details');
      const summary = document.createElement('summary');
      const body = document.createElement('p');
      const meta = document.createElement('p');
      detail.dataset.recordKey = text(note.id, `record-${index}`);
      detail.open = openKeys.has(detail.dataset.recordKey);
      summary.textContent = `${text(note.question, '未提供问题标题')} · ${masteryLabel(note.mastery)}`;
      body.textContent = text(note.summary, '尚未提供教学总结。');
      meta.className = 'muted';
      meta.textContent = `${learningResult(note.result)} · ${masteryLabel(note.mastery)}`;
      detail.append(summary, body, meta);
      item.append(detail);
      fragment.append(item);
    }
    list.replaceChildren(fragment);
  }

  function renderDueReviews(learning, available) {
    const timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const entries = available && Array.isArray(learning.due) ? learning.due.slice(0, 20).map(record).filter(entry => validIdentifier(entry.id) && validIdentifier(entry.noteId)).map(entry => ({ ...entry, time: reviewTime({ remindAt: entry.dueAt, timezone }) })).filter(entry => entry.time.valid && !entry.time.future) : [];
    const signature = JSON.stringify(entries);
    element('due-reviews').hidden = entries.length === 0;
    element('due-reviews-title').textContent = `到期复习 · ${entries.length} 条`;
    if (signature === dueReviewsSignature) return entries.length;
    dueReviewsSignature = signature;
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const item = document.createElement('li');
      const time = document.createElement('time');
      const zone = document.createElement('p');
      const summary = document.createElement('p');
      time.textContent = `复习时间：${entry.time.label}`;
      time.setAttribute('datetime', entry.time.iso);
      zone.className = 'muted';
      zone.textContent = `按本机时区显示：${entry.time.timezone}`;
      summary.textContent = text(entry.summary, '本条复习未提供内容摘要。');
      item.append(time, zone, summary);
      fragment.append(item);
    }
    element('due-reviews-list').replaceChildren(fragment);
    return entries.length;
  }

  function renderLearningNotice() {
    element('learning-navigation').textContent = learningNotice;
    element('learning-navigation').hidden = !learningNotice;
  }

  function locateLearningNote(noteId, focus) {
    let target;
    let focusTarget;
    if (!element('learning-note').hidden && record(record(runtime.learning).note).id === noteId) {
      target = element('learning-note');
      focusTarget = target;
    } else {
      const detail = Array.from(element('recent-notes-list').children).map(item => item.firstElementChild).find(detail => detail?.dataset.recordKey === noteId);
      if (detail) {
        element('recent-notes').open = true;
        detail.open = true;
        target = detail;
        focusTarget = detail.firstElementChild;
      }
    }
    if (!target) return false;
    target.scrollIntoView({ block: 'start' });
    if (focus) focusTarget.focus({ preventScroll: true });
    return true;
  }

  function renderLearning() {
    const state = learningState();
    const { learning, note, proposal, time } = state;
    const hasNote = Object.keys(note).length > 0;
    const hasProposal = Object.keys(proposal).length > 0;
    const notes = Array.isArray(learning.notes) ? learning.notes.slice(0, 20).filter(note => note && typeof note === 'object' && !Array.isArray(note) && Object.keys(note).length) : [];
    element('learning-summary').hidden = !learningRequested && !Object.hasOwn(runtime, 'learning') && !state.unavailable && !state.error;
    element('learning-error').textContent = state.unavailable ? `本机加密学习记录不可用，不会降级为明文保存。${state.error}` : state.error ? `学习记录保存或读取失败：${state.error}。当前不能确认本次内容已保存。` : '';
    element('learning-error').hidden = !state.unavailable && !state.error;
    renderLearningNotice();
    const dueCount = renderDueReviews(learning, ready && !state.unavailable && !state.error);
    element('learning-empty').hidden = hasNote || hasProposal || notes.length > 0 || dueCount > 0;
    element('learning-note').hidden = !hasNote;
    element('learning-question').textContent = text(note.question, '未提供本次问题标题');
    element('learning-note-summary').textContent = text(note.summary, '运行核心尚未提供教学总结。');
    element('learning-result').textContent = learningResult(note.result);
    element('mastery-status').textContent = masteryLabel(note.mastery);
    element('mark-mastered').disabled = !state.canSetMastery;
    element('mark-unmastered').disabled = !state.canSetMastery;
    element('mark-mastered').setAttribute('aria-pressed', String(note.mastery === 'mastered' || note.mastery === true));
    element('mark-unmastered').setAttribute('aria-pressed', String(note.mastery === 'unmastered' || note.mastery === false));
    element('review-card').hidden = !hasProposal;
    element('review-time').textContent = time.label;
    if (time.valid) element('review-time').setAttribute('datetime', time.iso);
    else element('review-time').removeAttribute('datetime');
    element('review-timezone').textContent = time.timezone ? `IANA 时区：${time.timezone}` : 'IANA 时区尚未提供';
    element('review-reason').textContent = text(proposal.reason);
    element('review-actions').hidden = proposal.state !== 'suggested';
    element('confirm-review').disabled = !state.canConfirm;
    element('decline-review').disabled = !state.canDecline;
    element('review-status').textContent = proposal.state === 'accepted' ? '已确认；调度与送达状态尚未核实。' : proposal.state === 'declined' ? '已拒绝，本次不安排复习。' : proposal.state === 'suggested' ? !time.valid ? '建议日期或 IANA 时区尚未确认，不能安排提醒。' : !time.future ? '建议时间已过，请等待新的具体建议；不会自动顺延。' : '仅为复习建议，等待本人确认；未确认不建提醒。' : '复习建议状态待确认，不能确认已安排。';
    element('recent-notes').hidden = notes.length === 0;
    element('recent-notes-title').textContent = `最近 ${notes.length} 条学习记录（展开查看）`;
    renderRecentNotes(notes);
  }

  function clarificationContext() {
    const state = flags();
    const task = state.task;
    if (activeSection !== 'guidance' || !state.safeObserving || state.blocked || state.privacyPaused || state.taskOutdated
      || task.kind !== 'guidance' || task.state !== 'needs_help' || task.awaitingReply !== true || state.analysis.state !== 'ready'
      || !validIdentifier(task.id) || !Number.isSafeInteger(task.generation)) return null;
    const key = `${task.id}:${task.generation}`;
    return key === newQuestionKey ? null : { key, guideId: task.id, taskGeneration: task.generation, observationGeneration: state.observation.generation };
  }

  function renderView() {
    const view = sectionViews[activeSection];
    for (const panel of viewPanels) element(panel).hidden = !view.panels.includes(panel);
    const clarification = clarificationContext();
    element('question-form').hidden = !composerSections.includes(activeSection) || Boolean(clarification);
    element('guidance-reply-form').hidden = !clarification;
    if (clarification) {
      if (clarificationDraftKey !== clarification.key) {
        clarificationDraftKey = clarification.key;
        element('guidance-answer').value = '';
      }
      element('guidance-original-question').textContent = `继续查找：${text(record(runtime.task).question)}`;
      element('guidance-send-answer').disabled = !flags().canAsk || !element('guidance-answer').value.trim();
      element('guidance-rescan').disabled = !flags().canAsk;
    }
    element('pet-panel').dataset.view = activeSection;
    element('panel-title').textContent = view.title;
    element('panel-eyebrow').textContent = activeSection === 'features' ? '所有陪伴，从暖暖开始' : '暖暖的功能小屋 / 独立功能页';
    for (const [control, section] of Object.entries({ 'view-features': 'features', 'view-guidance': 'guidance', 'view-voice': 'voice' })) {
      if (section === activeSection) element(control).setAttribute('aria-current', 'page');
      else element(control).removeAttribute('aria-current');
    }
  }

  function render() {
    if (disposed) return;
    const state = flags();
    const { observation, task, analysis } = state;
    const captions = record(runtime.captions);
    const wake = record(runtime.wake);
    const unsafe = state.captureConflict || state.privacyConflict;
    const observationIncomplete = observation.state === 'observing' && !state.safeObserving;
    element('observation-status').textContent = state.cleanupFailed ? '停止尚未确认' : unsafe ? '保护状态异常，请停止' : state.safetyUnclassified ? '画面安全类别待确认' : observationIncomplete ? '观察信号待核验' : (ready && Object.hasOwn(observationLabels, observation.state) ? observationLabels[observation.state] : '') || '观察状态待确认';
    element('observation-status').dataset.tone = state.blocked || state.privacyPaused ? 'danger' : state.safeObserving ? 'active' : 'neutral';
    const source = text(observation.sourceName);
    const reasonDetail = ['capture_retry', 'capture_error'].includes(analysis.state) ? text(analysis.message, '正在重新采集最新本地画面；不会使用过期画面，也不会重新请求屏幕共享。')
      : state.safeObserving && observation.reason === 'authorized_sharing'
      ? '已授权持续实时共享，不再按敏感文字、未知页面或无文字自动暂停。可随时点击“停止共享”关闭；本地仍遮盖文字与人脸，云分析仅在另行授权后按需发送。'
      : state.safeObserving && observation.reason === 'controls_only'
      ? '正在本地观察（安全控件布局模式）：只保留已识别的通用控件标签和位置，不包含原画面、正文、文件名或图片。仅在本人另行授权后，才按需发送控件布局用于教学；不会自动操作。'
      : text(observation.reason) && analysis.state === 'error' ? text(analysis.message, observation.reason) : text(observation.reason);
    element('observation-detail').textContent = state.cleanupFailed ? `停止清理尚未确认，请退出桌宠并重新启动。${text(observation.reason)}` : unsafe ? '隐私或停止状态与采集 / 分析信号不一致。请立即停止观察，再检查运行核心。' : state.safetyUnclassified ? 'unclassified_screen / unknown：当前本地分类器尚未识别此画面，不等于已发现敏感内容。已支持设置、桌面、文件管理器及常见浏览器/编辑器控件；可在继续共享时选择“框选观察区域”，只保留目标软件。仍未分类时继续保持暂停，不会发送画面。' : text(reasonDetail, source ? `共享来源：${source}` : ready && observation.state === 'off' && observation.captureActive === false ? '尚未共享屏幕。提问不会由面板自动开启观察。' : ready && observation.state === 'stopped' && observation.captureActive === false ? '采集已由运行核心报告停止，重新开启仍需本人确认。' : '等待运行核心确认共享来源与采集状态。');
    element('analysis-status').textContent = ready && state.privacyPaused && (state.safetyUnclassified || analysis.state === 'error') && !unsafe ? '本地安全检查暂停' : (ready && Object.hasOwn(analysisLabels, analysis.state) ? analysisLabels[analysis.state] : '') || '云分析待确认';
    element('analysis-detail').textContent = text(analysis.message);
    element('analysis-detail').hidden = !text(analysis.message);
    element('privacy-notice').hidden = !state.privacyPaused && !state.blocked;
    element('privacy-title').textContent = state.cleanupFailed ? '请退出桌宠并重新启动' : unsafe ? '请先停止观察' : state.safetyUnclassified ? '安全待确认，继续共享会重新检查' : '共享已暂停，需本人确认';
    const privacyReason = state.privacyPaused && analysis.state === 'error' ? text(analysis.message) : '';
    element('privacy-detail').textContent = state.cleanupFailed ? '不能确认采集是否已停。继续共享、提问与核验均已禁用。可再次尝试停止，或在“管理与退出”中明确退出桌宠。' : unsafe ? '当前信号存在冲突，继续共享已禁用。停止并检查后再操作。' : state.safetyUnclassified ? observation.captureActive === false ? '运行核心报告采集已停止。点击“本人继续共享”重新选择屏幕或框选观察区域并确认授权。请只保留目标软件，避开聊天或敏感窗口；新画面须通过本地安全检查，仍未分类时继续保持暂停，不会发送画面。' : '采集停止尚待确认，请尝试停止观察。' : `${privacyReason ? `${privacyReason}\n` : ''}提问、重讲或“我点好了”均不会恢复共享。仅本人点击下方按钮后，由运行核心重新检查授权和安全。`;
    element('resume-sharing').disabled = !state.canResume;
    element('start-observation').disabled = !state.canStart;
    element('stop-observation').disabled = !state.canStop;
    element('start-observation').textContent = pending.has('observation.start') ? '等待选择来源…' : '开启本地观察';
    element('stop-observation').textContent = pending.has('observation.stop') ? '正在请求停止…' : record(runtime.wake).state === 'enabled' || record(runtime.voice).active === true ? '停止共享与语音' : task.kind === 'text' && task.state === 'analyzing' ? '停止本次提问' : '停止共享';
    const voice = record(runtime.voice);
    element('voice-chat-status').textContent = text(voice.message, '面对面语音默认关闭；不会自动打开麦克风。');
    for (const identifier of ['start-voice-chat', 'pet-voice', 'feature-voice']) element(identifier).disabled = !ready || pending.has('voice.open');
    renderFaceVoice(voice);
    element('start-voice-chat').textContent = pending.has('voice.open')
      ? voice.state === 'confirming' ? '正在等待本人确认…' : voice.state === 'connecting' ? '正在准备语音…' : voice.configured === false ? '正在显示配置说明…' : '正在准备语音…'
      : voice.active === true ? '回到面对面语音' : '和暖暖面对面语音';
    element('resume-sharing').textContent = pending.has('observation.resume') ? '等待选择范围与确认…' : '本人继续共享';
    element('feature-guidance-status').textContent = !ready ? '正在确认运行核心，不会开启采集' : state.blocked || state.privacyPaused ? '共享已暂停，先查看隐私与安全状态' : state.safeObserving ? task.state === 'awaiting_action' ? '已有当前步骤，请核对后亲手操作' : '本地观察中；提问后按需分析并定位' : '未观察屏幕；点击了解授权与教学流程';
    const targetStatus = task.targetState === 'unavailable' ? `本次分析已返回，但未显示箭头。${text(task.explanation)}`
      : task.targetState === 'stale' || task.targetState === 'hidden' ? '上次位置已隐藏；正在等待新的本地安全画面，不要按旧位置操作。'
        : task.presentation === 'uncertain_candidate' ? `找到当前画面中的候选位置；请先核对箭头，再亲手操作。${text(task.instruction)}`
          : `已找到当前画面中的目标；请看箭头并亲手操作。${text(task.instruction)}`;
    const cloudAuthorizing = pending.has('observation.authorize-cloud');
    const voiceFindStatus = !ready ? '正在确认运行核心，不会开启采集。' : state.blocked || state.privacyPaused ? '共享已暂停；请查看下方原因。处理后由你本人点击“继续共享”，重新选择范围并确认；不会自动恢复或重发问题。'
      : !state.safeObserving ? '先开启本地观察，并在系统列表中选择你要查找的屏幕。'
        : ['capture_retry', 'capture_error'].includes(state.analysis.state) ? text(state.analysis.message, '正在等待最新的本地安全画面；屏幕共享仍保持。')
        : cloudAuthorizing ? '请在系统窗口单独确认本次画面分析；确认前不启动查找、不发送画面。'
          : state.observation.cloudConsent !== true ? '屏幕已开启本地观察。可直接点击“查找并指引”或“语音查找并指引”，单独同意按需脱敏分析后继续，无需重新选择屏幕。'
          : pending.has('dictate') && voiceFindMode ? '请在弹出的系统窗口确认麦克风；说出目标后本机停麦，再按本次授权分析。'
            : state.task.kind !== 'text' && (state.task.state === 'analyzing' || state.analysis.state === 'analyzing') ? '查找请求已受理，正在检查并分析当前授权画面；可点击“结束教学”取消，不会代替你点击或输入。'
              : ['unavailable', 'error'].includes(state.analysis.state) ? text(state.analysis.message, '当前没有可用的屏幕分析结果，可手动重试；不会生成假指引。')
                : state.taskOutdated ? '观察范围已变化，旧位置已隐藏；请等待与当前画面对应的新指引。'
                  : state.task.state === 'awaiting_action' ? targetStatus
                    : state.task.state === 'needs_help' ? `本次分析没有生成箭头。${text(task.explanation, text(state.analysis.message, '请重新描述目标，或先亲手打开需要操作的软件。'))}${task.awaitingReply === true ? '可在下方“回答暖暖的追问”继续回答，或点击“重新识别当前画面”。' : ''}`
                  : '点击并确认后说出目标；音频仅在本机识别，文字与必要的脱敏画面只为本次查找发送。';
    const observationScope = state.safeObserving && source ? `观察范围：${source}。` : '';
    element('guidance-status').textContent = voiceFindStatus + (observationScope ? `\n${observationScope}` : '');
    element('guidance-analysis').hidden = !state.analysis.message || ['idle', 'ready', 'analyzing'].includes(state.analysis.state);
    element('guidance-analysis').textContent = text(state.analysis.message);
    const canReselectObservation = state.safeObserving && observation.cloudConsent === false && !state.blocked && !state.privacyPaused && !state.observationPending
      && !['analyzing', 'verifying'].includes(task.state) && !pending.has('dictate') && !pending.has('ask');
    element('guidance-start-observation').disabled = !state.canStart && !canReselectObservation && !state.canResume;
    element('guidance-start-observation').textContent = pending.has('observation.start') || pending.has('observation.reselect') || pending.has('observation.resume') ? '正在等待选择屏幕…' : state.canResume ? '① 本人继续共享' : canReselectObservation
      ? '① 重新选择观察屏幕' : state.safeObserving ? '① 屏幕已就绪' : '① 选择屏幕与授权';
    element('screen-voice-find').disabled = !state.canVoiceFind;
    element('screen-voice-find').textContent = cloudAuthorizing ? '正在等待分析授权…' : pending.has('dictate') && voiceFindMode ? '正在本机听写…' : state.analysis.state === 'capture_retry' ? '正在刷新本地画面…' : state.task.kind !== 'text' && state.task.state === 'analyzing' ? '正在分析当前画面…' : clarificationContext() ? '② 语音回答并继续' : '② 语音查找并指引';
    for (const button of document.querySelectorAll('[data-tool]')) button.disabled = !ready || pending.has('open-tool');

    element('task-status').textContent = ready && task.kind === 'text' ? task.state === 'analyzing' ? '正在请求文字模型' : task.result === 'answered' ? '文字回答已返回（未核验屏幕）' : task.result === 'failed' ? '文字回答未完成' : '文字提问已结束' : (ready && Object.hasOwn(taskLabels, task.state) ? taskLabels[task.state] : '') || '等待教学状态';
    element('step-title').textContent = state.privacyPaused || state.blocked ? '先保护隐私，再继续学习' : state.taskOutdated ? '等待与当前画面对应的新指引' : text(task.instruction, text(task.question, '你想学什么？'));
    element('step-explanation').textContent = state.privacyPaused || state.blocked ? '继续教学操作已禁用。你仍可以结束教学或停止观察，旧指引不会代替新的核验。' : state.taskOutdated ? '教学代际与当前观察不一致或尚未确认。请勿按旧指引操作，等待运行核心更新。' : text(task.explanation, '直接在下面提问，不用打开管理客户端。软件由你亲手打开、切换和操作。');
    element('presentation-note').hidden = task.presentation !== 'uncertain_candidate' || state.privacyPaused || state.blocked || state.taskOutdated;
    const result = !state.privacyPaused && !state.blocked && !state.taskOutdated && ['completed', 'needs_help', 'ended'].includes(task.state) ? text(task.result) : '';
    element('step-result').textContent = result;
    element('step-result').hidden = !result;
    element('verify-step').disabled = !state.canVerify;
    element('repeat-step').disabled = !state.canRepeat;
    element('finish-lesson').disabled = !state.canFinish;
    element('verify-step').textContent = pending.has('guidance.verify') || task.state === 'verifying' ? '等待新画面核验…' : '我点好了，请核验';
    element('finish-lesson').textContent = pending.has('guidance.finish') ? '正在请求结束…' : '结束教学';
    element('send-question').disabled = !state.canAsk || !element('question').value.trim();
    element('send-question').textContent = cloudAuthorizing ? '正在等待分析授权…' : pending.has('ask') ? '正在发送…' : state.analysis.state === 'capture_retry' ? '正在刷新画面…' : task.state === 'analyzing' ? task.kind === 'text' ? '正在等待回答…' : '正在分析画面…' : activeSection === 'guidance' ? '查找并指引 ↗' : '问暖暖 ↗';
    element('question-hint').textContent = state.privacyPaused || state.blocked ? '安全状态待处理，可保留草稿，不能发送' : !ready ? '等待连接，可先写下问题' : activeSection === 'guidance'
      ? state.safeObserving ? observation.cloudConsent === true ? '结合当前已授权画面查找 · Enter 发送' : '屏幕已就绪 · 点击查找后单独确认按需脱敏分析' : '先选择屏幕，再点击查找并确认按需脱敏分析' : '文字发送给已配置模型 · Enter 发送 · Shift + Enter 换行';
    const dictationPending = pending.has('dictate');
    element('start-dictation').disabled = !state.canAsk || voice.active === true || typeof bridge?.dictate !== 'function' || typeof bridge?.cancelDictation !== 'function';
    element('start-dictation').textContent = dictationPending ? '本次听写中…' : '语音输入';
    element('cancel-dictation').hidden = !dictationPending;
    element('cancel-dictation').disabled = pending.has('dictation.cancel');
    element('dictation-status').textContent = cloudAuthorizing ? '请在系统窗口确认是否允许本次按需脱敏分析；当前没有发送查找或开启麦克风。' : pending.has('dictation.cancel') ? '正在取消并等待本次麦克风关闭…' : dictationPending ? voiceFindMode ? wake.phase === 'question' ? '正在本机听写查找目标；麦克风关闭前不会发送。' : wake.phase === 'stopping' ? '听写结束，正在确认麦克风关闭…' : '请在系统窗口确认本次语音查找。' : wake.phase === 'question' ? '正在本机听写，请直接说一句话；最多等待 20 秒。' : wake.phase === 'stopping' ? '已结束识别，正在等待麦克风关闭…' : '请在原生窗口确认本次输入，等候正在本机听写提示。' : dictationNotice || '点击语音输入，本人确认后直接说话；仅置信度足够的文字会填入草稿，且不会自动发送。';
    element('dictation-result').hidden = !dictationTranscript;
    element('dictation-result').textContent = dictationTranscript ? `本次识别文字：${dictationTranscript}` : '';

    const captionsKnown = typeof captions.enabled === 'boolean';
    element('toggle-captions').disabled = !ready || !captionsKnown || pending.has('captions.toggle');
    element('toggle-captions').textContent = !captionsKnown ? '字幕状态待确认' : captions.enabled ? '关闭字幕' : '开启字幕';
    element('toggle-captions').setAttribute('aria-pressed', String(captions.enabled === true));
    const caption = state.privacyPaused || state.blocked || state.taskOutdated ? '' : text(captions.text);
    element('caption-line').textContent = caption;
    element('caption-line').hidden = !ready || captions.enabled !== true || !caption;
    const wakeKnown = ['disabled', 'enabled', 'unsupported'].includes(wake.state);
    element('wake-status').textContent = text(wake.reason, wake.state === 'enabled' ? '本地语音唤醒已启用。' : wake.state === 'unsupported' ? '此设备尚不支持本地语音唤醒。' : wake.state === 'disabled' ? '本地语音唤醒未开启，麦克风不由面板自动启用。' : '语音唤醒待确认，默认关闭。');
    element('toggle-wake').disabled = !ready || !wakeKnown || wake.state === 'unsupported' || voice.active === true || ((state.blocked || state.privacyPaused) && wake.state !== 'enabled') || pending.has('wake.enable') || pending.has('wake.disable') || dictationPending;
    element('toggle-wake').textContent = wake.state === 'enabled' ? '关闭本地语音唤醒' : '启用本地语音唤醒';
    element('confirm-exit').disabled = pending.has('exit');
    element('retry-action').disabled = pending.has('connection');
    element('message').textContent = retryAction ? '遇到问题，点我展开重试' : state.cleanupFailed ? '停止未确认，请退出并重启' : state.privacyPaused || state.blocked ? '共享暂停，先保护你的隐私' : text(runtime.message, state.activeTask ? '我在这里，陪你一步一步做' : ready ? '我在这里，点我聊聊' : '等待连接，点我查看');
    renderMessages();
    renderLearning();
    renderView();
    renderNotifications(state);
    const safetyFeedback = state.privacyPaused || state.blocked;
    const feedbackSignature = expanded && activeSection === 'guidance' && (safetyFeedback || (task.kind === 'guidance' && task.state !== 'idle'))
      ? JSON.stringify([observation.generation, task.generation, task.state, task.instruction, task.explanation, task.targetState, state.privacyPaused, state.blocked, observation.reason, privacyReason]) : '';
    if (feedbackSignature && feedbackSignature !== guidanceFeedbackSignature) element(safetyFeedback ? 'privacy-notice' : 'guidance-status').scrollIntoView({ block: 'start' });
    guidanceFeedbackSignature = feedbackSignature;
  }

  function clearError() {
    retryAction = undefined;
    element('error-text').textContent = '';
    element('error-notice').hidden = true;
  }

  function showError(label, error, retry) {
    if (disposed) return;
    const detail = typeof error?.message === 'string' ? error.message : '运行核心没有确认请求';
    element('error-text').textContent = `${label}：${detail}。可重试；若持续失败，请检查桌面主进程是否已接入对应能力。`;
    element('error-notice').hidden = false;
    retryAction = retry;
    render();
  }

  function checkReply(reply) {
    const response = record(reply);
    if (reply === false || response.ok === false || response.accepted === false || response.success === false || ['error', 'denied', 'rejected', 'unavailable', 'unsupported'].includes(response.status) || text(response.error)) {
      throw new Error(text(response.error, text(response.reason, text(response.message, '请求未被运行核心接受'))));
    }
  }

  function acceptSnapshot(snapshot) {
    if (disposed) return;
    checkReply(snapshot);
    if (snapshot?.ok === true && Object.hasOwn(snapshot, 'snapshot')) snapshot = snapshot.snapshot;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('收到的运行状态无效');
    const generation = record(snapshot.observation).generation;
    const previousObservation = record(runtime.observation);
    if (Number.isSafeInteger(generation) && generation >= 0) {
      if (generation < newestGeneration) return;
      newestGeneration = generation;
    }
    if ((guidanceNoticeGeneration !== undefined && (generation !== guidanceNoticeGeneration || record(snapshot.observation).cloudConsent !== true))
      || (Number.isSafeInteger(previousObservation.generation) && previousObservation.generation !== generation)) {
      dictationNotice = '观察范围或画面授权已变化，旧查找已失效；草稿和识别文字仍保留，重新确认后可查找。';
      guidanceNoticeGeneration = undefined;
    }
    runtime = snapshot;
    ready = true;
    render();
    if (learningNavigation && expanded) {
      const navigation = learningNavigation;
      learningNavigation = undefined;
      learningNotice = locateLearningNote(navigation.noteId, navigation.focus) ? '' : '请求的笔记不在本次本机快照或最近 20 条记录中；未自动打开管理窗口。';
      renderLearningNotice();
    }
  }

  async function refreshSnapshot() {
    if (typeof bridge?.snapshot !== 'function') throw new Error('桌宠状态接口尚未接入');
    const request = ++snapshotRequest;
    const version = stateVersion;
    let snapshot;
    try {
      snapshot = await bridge.snapshot();
    } catch (error) {
      if (disposed || request !== snapshotRequest || version !== stateVersion) return;
      ready = false;
      render();
      throw error;
    }
    if (disposed || request !== snapshotRequest || version !== stateVersion) return;
    try { acceptSnapshot(snapshot); } catch (error) { ready = false; render(); throw error; }
  }

  async function connect() {
    if (disposed || pending.has('connection')) return;
    pending.add('connection');
    render();
    try {
      if (typeof bridge?.onState !== 'function') throw new Error('桌宠状态订阅接口尚未接入');
      if (!unsubscribe) {
        unsubscribe = bridge.onState(snapshot => {
          if (disposed) return;
          stateVersion += 1;
          try {
            acceptSnapshot(snapshot);
          } catch (error) {
            ready = false;
            showError('无法读取最新状态', error, connect);
          }
        });
        if (typeof unsubscribe !== 'function') throw new Error('运行核心没有提供状态订阅取消函数');
      }
      if (!unsubscribePanel) {
        if (typeof bridge?.onPanel !== 'function') throw new Error('桌宠面板事件接口尚未接入');
        unsubscribePanel = bridge.onPanel(panel => {
          if (disposed || typeof panel?.expanded !== 'boolean') return;
          element('exit-confirmation').hidden = true;
          setExpanded(panel.expanded, { notifyHost: false, focusInput: panel.focusInput === true, section: panel.section, noteId: panel.noteId });
        });
        if (typeof unsubscribePanel !== 'function') throw new Error('运行核心没有提供面板订阅取消函数');
      }
      await refreshSnapshot();
      if (!disposed) clearError();
    } catch (error) {
      ready = false;
      showError('桌宠连接未就绪', error, connect);
    } finally {
      pending.delete('connection');
      render();
    }
  }

  async function perform(key, label, operation, retry, refresh = false) {
    if (disposed || pending.has(key)) return;
    pending.add(key);
    clearError();
    render();
    let acknowledged = false;
    try {
      checkReply(await operation());
      acknowledged = true;
      if (!disposed && refresh) await refreshSnapshot();
    } catch (error) {
      showError(acknowledged && refresh ? '请求已发送，状态未确认' : label, error, !ready || (acknowledged && refresh) ? connect : retry);
    } finally {
      pending.delete(key);
      render();
    }
  }

  function requestCommand(type, control) {
    if (disposed || element(control).disabled) return;
    if (type === 'voice.open') setExpanded(false, { notifyHost: false });
    void perform(type, '操作未确认', () => bridge.command({ type }), () => requestCommand(type, control), true);
  }

  async function ensureGuidanceCloudConsent(observationGeneration) {
    const unchanged = () => {
      const current = flags();
      return current.safeObserving && !current.blocked && current.observation.generation === observationGeneration;
    };
    const changed = () => {
      dictationNotice = '确认期间观察范围或安全状态已变化，本次查找没有发送；问题草稿已保留。请核对当前状态，再由本人重新确认。';
      return false;
    };
    pending.add('observation.check-guidance');
    clearError();
    render();
    try {
      await refreshSnapshot();
      if (disposed) return false;
      if (!unchanged()) return changed();
      const initial = flags();
      if (initial.observation.cloudConsent === true) return true;
      if (initial.observation.cloudConsent !== false || typeof bridge?.command !== 'function') throw new Error('当前画面分析授权未确认，请重新读取桌宠状态。');
      pending.add('observation.authorize-cloud');
      render();
      let reply;
      try {
        reply = await bridge.command({ type: 'observation.authorize-cloud', observationGeneration });
      } catch {
        if (disposed) return false;
        await refreshSnapshot();
        if (disposed) return false;
        if (!unchanged()) return changed();
        throw new Error('本次画面分析授权未完成，没有发送查找或开启麦克风；请稍后重新点击确认。');
      }
      if (disposed) return false;
      await refreshSnapshot();
      if (disposed) return false;
      if (!unchanged() || reply?.status === 'observation_changed') return changed();
      checkReply(reply);
      const current = flags();
      if (reply?.status === 'cancelled' || current.observation.cloudConsent !== true) {
        dictationNotice = '本次未同意画面分析，仍仅本地观察；没有发送查找或开启麦克风，问题草稿已保留。';
        return false;
      }
      dictationNotice = '';
      return true;
    } finally {
      pending.delete('observation.check-guidance');
      pending.delete('observation.authorize-cloud');
      render();
    }
  }

  async function startDictation() {
    if (disposed || element('start-dictation').disabled) return;
    const request = ++dictationGeneration;
    voiceFindMode = false;
    pending.add('dictate');
    dictationNotice = '';
    dictationTranscript = '';
    clearError();
    render();
    try {
      const result = await bridge.dictate();
      if (disposed || request !== dictationGeneration) return;
      if (!result || result.localOnly !== true || !['complete', 'uncertain', 'cancelled'].includes(result.status)) throw new Error('本地听写结果未确认');
      if (result.status === 'cancelled') { dictationNotice = '本次听写已取消，没有填入或发送文字。'; return; }
      if (result.status === 'uncertain' && result.microphoneActive !== false) throw new Error('本地听写结果未确认');
      if (result.status === 'uncertain') { dictationNotice = '这次没有听清，未填入或发送文字。请靠近麦克风、说慢一点后重试。'; return; }
      if (result.microphoneActive !== false || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 500) throw new Error('本地听写结果未确认');
      const recognized = result.text.trim();
      const previous = element('question').value;
      const draft = previous ? `${previous}\n${recognized}` : recognized;
      if (draft.length > 500) {
        dictationTranscript = recognized;
        dictationNotice = '草稿加上听写超过 500 字，未覆盖原文字。请整理草稿后使用下方识别文字。';
      } else {
        element('question').value = draft;
        draftVersion += 1;
        dictationNotice = '已填入输入框，请检查后点击“问暖暖”发送。本次麦克风已关闭。';
        element('question').focus({ preventScroll: true });
      }
    } catch (error) {
      if (!disposed && request === dictationGeneration) showError('语音输入未完成', error, startDictation);
    } finally {
      if (request === dictationGeneration) pending.delete('dictate');
      render();
    }
  }

  async function cancelDictation() {
    if (!pending.has('dictate') || pending.has('dictation.cancel')) return;
    dictationGeneration += 1;
    const wasVoiceFind = voiceFindMode;
    voiceFindMode = false;
    pending.add('dictation.cancel');
    render();
    let stopped = false;
    try {
      await bridge.cancelDictation();
      stopped = true;
      dictationNotice = wasVoiceFind ? '本次语音查找已取消，没有发送文字或屏幕画面。' : '本次听写已取消，没有填入或发送文字。';
    } catch (error) { showError('听写停止尚未确认', error, cancelDictation); }
    finally {
      if (stopped) pending.delete('dictate');
      pending.delete('dictation.cancel');
      render();
    }
  }

  async function sendVoiceFind(question, observationGeneration, clarification = null) {
    guidanceNoticeGeneration = observationGeneration;
    voiceFindMode = true;
    await perform('ask', '语音查找未完成', async () => {
      try {
        const reply = clarification ? await bridge.command({ type: 'guidance.reply', text: question, guideId: clarification.guideId,
          taskGeneration: clarification.taskGeneration, observationGeneration }) : await bridge.ask(question, observationGeneration);
        checkReply(reply);
        if (!disposed) {
          const current = flags();
          if (!current.safeObserving || current.observation.generation !== observationGeneration || current.observation.cloudConsent !== true) {
            dictationNotice = '观察范围或画面授权已变化，旧查找已失效；识别文字已保留，没有启动新查找。';
            return reply;
          }
          const result = record(record(reply).snapshot);
          const task = record(result.task);
          const analysis = record(result.analysis);
          dictationNotice = task.state === 'awaiting_action' ? task.presentation === 'uncertain_candidate'
            ? '语音已识别，候选位置已高亮；请先核对，再亲手操作。' : '语音已识别，目标已高亮；请看箭头并亲手操作。'
            : task.result === 'risk_blocked' ? '本次请求涉及受限操作，已停止指引，没有生成箭头。'
              : task.state === 'analyzing' ? '本机听写已完成，麦克风已关闭；查找请求已受理，请在上方查看分析进度与箭头指引。'
                : analysis.state === 'unavailable' ? '语音已识别，但屏幕分析服务不可用；没有使用假答案或生成错误位置。'
                : '语音已识别，但没有获得可核验的目标位置；请查看教学说明或重新描述。';
        }
        return reply;
      } finally { voiceFindMode = false; }
    }, () => sendVoiceFind(question, observationGeneration, clarification), true);
  }

  async function startVoiceFind() {
    const initial = flags();
    if (disposed || !initial.canVoiceFind) return;
    const observationGeneration = initial.observation.generation;
    const clarification = clarificationContext();
    const request = ++dictationGeneration;
    dictationNotice = '';
    dictationTranscript = '';
    clearError();
    try {
      if (!await ensureGuidanceCloudConsent(observationGeneration)) return;
      if (disposed || request !== dictationGeneration || !flags().canVoiceFind || flags().observation.generation !== observationGeneration || flags().observation.cloudConsent !== true) return;
      voiceFindMode = true;
      pending.add('dictate');
      render();
      const result = await bridge.dictate(observationGeneration);
      if (disposed || request !== dictationGeneration) return;
      if (!result || result.localOnly !== true || !['complete', 'uncertain', 'cancelled'].includes(result.status)) throw new Error('本地听写结果未确认');
      if (result.status === 'cancelled') { dictationNotice = '本次语音查找已取消，没有发送文字或屏幕画面。'; return; }
      if (result.status === 'uncertain' && result.microphoneActive !== false) throw new Error('本地听写结果未确认');
      if (result.status === 'uncertain') { dictationNotice = '这次没有听清，未发送问题或屏幕画面。请靠近麦克风、说慢一点后重试。'; return; }
      if (result.microphoneActive !== false || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 500) throw new Error('本地听写结果未确认');
      const recognized = result.text.trim();
      dictationTranscript = recognized;
      pending.delete('dictate');
      const current = flags();
      if (!current.canVoiceFind || current.observation.generation !== observationGeneration || current.observation.cloudConsent !== true) {
        dictationNotice = '屏幕观察或授权已变化。识别文字已保留在下方，没有发送画面或问题。';
        return;
      }
      if (clarification && clarificationContext()?.key !== clarification.key) {
        dictationNotice = '追问已经变化，旧语音回答没有发送，也没有覆盖当前回答草稿。';
        showError('语音回答未发送', new Error(dictationNotice));
        return;
      }
      dictationNotice = '本机听写已完成，麦克风已关闭；正在按本次授权查找目标。';
      render();
      if (clarification) element('guidance-answer').value = recognized;
      await sendVoiceFind(recognized, observationGeneration, clarification);
    } catch (error) {
      if (!disposed && request === dictationGeneration) showError('语音查找未完成', error, ready ? startVoiceFind : connect);
    } finally {
      if (request === dictationGeneration) {
        pending.delete('dictate');
        voiceFindMode = false;
      }
      render();
    }
  }

  function setMastery(mastered, expectedId = learningState().note.id) {
    if (disposed) return;
    const state = learningState();
    if (!state.canSetMastery) return;
    if (state.note.id !== expectedId) {
      showError('学习记录已更新', new Error('请核对当前问题后重新选择掌握状态'), connect);
      return;
    }
    void perform('learning.set-mastery', '掌握状态更新未确认', () => bridge.command({ type: 'learning.set-mastery', noteId: expectedId, mastered }), () => setMastery(mastered, expectedId), true);
  }

  function respondToReview(confirmed, expectedId = learningState().proposal.id, expectedTime = learningState().time.iso, expectedTimezone = learningState().time.timezone) {
    if (disposed) return;
    const state = learningState();
    if (state.proposal.id !== expectedId || state.time.iso !== expectedTime || state.time.timezone !== expectedTimezone) {
      showError('复习建议已更新', new Error('请重新核对具体日期、时点与时区后选择'), connect);
      return;
    }
    if (confirmed ? !state.canConfirm : !state.canDecline) {
      if (confirmed && state.proposal.state === 'suggested' && (!state.time.valid || !state.time.future)) {
        renderLearning();
        showError('复习时间未确认', new Error('建议时间已过或日期 / 时区无效，请等待新的具体建议'), connect);
      }
      return;
    }
    const type = confirmed ? 'learning.review.confirm' : 'learning.review.decline';
    void perform(type, '复习选择未确认', () => bridge.command({ type, proposalId: expectedId }), () => respondToReview(confirmed, expectedId, expectedTime, expectedTimezone), true);
  }

  function sendClarification() {
    const context = clarificationContext();
    if (!context || !flags().canAsk) return;
    const answer = element('guidance-answer').value.trim();
    if (!answer || answer.length > 500) return;
    void perform('ask', '补充回答未确认', () => bridge.command({ type: 'guidance.reply', text: answer, guideId: context.guideId,
      taskGeneration: context.taskGeneration, observationGeneration: context.observationGeneration }), sendClarification, true);
  }

  function rescanGuidance() {
    const context = clarificationContext();
    if (!context || !flags().canAsk) return;
    void perform('ask', '重新识别未确认', () => bridge.command({ type: 'guidance.rescan', guideId: context.guideId,
      taskGeneration: context.taskGeneration, observationGeneration: context.observationGeneration }), rescanGuidance, true);
  }

  function sendQuestion() {
    if (disposed || !flags().canAsk) return;
    const draft = element('question').value;
    const version = draftVersion;
    const question = draft.trim();
    const guidanceGeneration = activeSection === 'guidance' ? flags().observation.generation : undefined;
    if (!question) return;
    if (question.length > 500) {
      showError('问题未发送', new Error('问题不能超过 500 字'), () => element('question').focus());
      return;
    }
    void perform('ask', '问题未确认', async () => {
      if (guidanceGeneration !== undefined) {
        if (!await ensureGuidanceCloudConsent(guidanceGeneration)) return;
        if (disposed || activeSection !== 'guidance' || draftVersion !== version || element('question').value !== draft) {
          dictationNotice = '授权期间问题或功能页已变化，本次未发送；请检查草稿后重新点击查找。';
          return;
        }
        guidanceNoticeGeneration = guidanceGeneration;
      }
      const reply = guidanceGeneration === undefined ? await bridge.ask(question) : await bridge.ask(question, guidanceGeneration);
      checkReply(reply);
      if (guidanceGeneration !== undefined && (!flags().safeObserving || flags().observation.generation !== guidanceGeneration || flags().observation.cloudConsent !== true)) {
        if (!disposed) dictationNotice = '观察范围或画面授权已变化，旧查找已失效；问题草稿已保留，没有启动新查找。';
        return reply;
      }
      if (guidanceGeneration !== undefined || reply?.snapshot?.task?.kind === 'guidance') {
        if (!disposed) dictationNotice = '查找请求已受理，问题草稿已保留；请查看上方的分析进度与箭头指引，失败后可手动重试。';
        return reply;
      }
      if (reply?.snapshot?.task?.kind === 'text' && reply.snapshot.task.result !== 'answered') {
        if (!disposed) dictationNotice = '本次未获得有效回答，问题草稿已保留。请检查模型服务后手动重试。';
        return reply;
      }
      if (!disposed && draftVersion === version && element('question').value === draft) {
        element('question').value = '';
        dictationNotice = dictationTranscript ? '草稿已提交给桌宠；下方识别文字未自动发送，仍保留供你整理。' : '问题已提交给桌宠；请在“最近问答”查看回复或运行提示。';
      }
      return reply;
    }, sendQuestion, true);
  }

  async function syncPanel() {
    if (syncingPanel || disposed) return;
    syncingPanel = true;
    try {
      while (typeof desiredExpanded === 'boolean' && !disposed) {
        const requested = desiredExpanded;
        desiredExpanded = undefined;
        try {
          if (typeof bridge?.command !== 'function') throw new Error('面板窗口接口尚未接入');
          checkReply(await bridge.command({ type: 'panel.set-expanded', expanded: requested }));
        } catch (error) {
          if (requested === expanded) showError('面板窗口尺寸未同步', error, () => { desiredExpanded = expanded; void syncPanel(); });
        }
      }
    } finally {
      syncingPanel = false;
    }
  }

  function showLearning(focus = true, noteId) {
    learningRequested = true;
    learningNotice = '';
    learningNavigation = validIdentifier(noteId) ? { noteId, focus } : undefined;
    renderLearning();
    if (learningNavigation && locateLearningNote(noteId, focus)) {
      learningNavigation = undefined;
      return;
    }
    element('learning-summary').scrollIntoView({ block: 'start' });
    if (focus) element('learning-summary').focus({ preventScroll: true });
    if (learningNavigation) {
      learningNotice = '当前快照尚未包含这条笔记；将核对下一次本机状态，不会自动打开管理窗口。';
      renderLearningNotice();
      if (ready) {
        const navigation = learningNavigation;
        void refreshSnapshot().catch(error => {
          if (disposed) return;
          if (learningNavigation === navigation) learningNavigation = undefined;
          showError('笔记状态未刷新', error, connect);
        });
      }
    }
  }

  function focusTextInput(input) {
    if (disposed || !expanded || input.disabled) return;
    const current = ++focusRequest;
    const section = activeSection;
    input.focus({ preventScroll: true });
    if (typeof bridge?.focusInput !== 'function') return;
    try {
      Promise.resolve(bridge.focusInput()).then(focused => {
        if (focused === true && !disposed && expanded && current === focusRequest && section === activeSection
          && !input.disabled && document.activeElement === input) input.focus({ preventScroll: true });
      }).catch(() => {});
    } catch {}
  }

  function setExpanded(value, options = {}) {
    if (disposed) return;
    focusRequest += 1;
    endPetDrag();
    if (value && faceVoiceActive()) value = false;
    const previousExpanded = expanded;
    const previousSection = activeSection;
    if (value) {
      const section = options.section ?? (options.focusInput === true ? 'question' : !expanded ? 'features' : activeSection);
      activeSection = Object.hasOwn(sectionViews, section) ? section : 'features';
    }
    if (!value || (pending.has('dictate') && (previousSection !== activeSection || !composerSections.includes(activeSection)))) void cancelDictation();
    expanded = value;
    element('pet-panel').hidden = !value;
    renderView();
    if (previousSection !== activeSection || previousExpanded !== expanded) {
      element('panel-body').scrollTop = 0;
      window.dispatchEvent(new CustomEvent('nuanban:pet:view-changed', { detail: { section: value ? activeSection : null } }));
    }
    element('pet-window').classList.toggle('is-expanded', value);
    renderNotifications();
    element('pet-toggle').setAttribute('aria-expanded', String(value));
    element('pet-toggle').setAttribute('aria-label', value ? '收起暖暖面板' : '展开暖暖面板');
    element('exit-confirmation').hidden = true;
    if (!value || options.section !== 'learning') learningNavigation = undefined;
    if (options.notifyHost !== false) {
      desiredExpanded = value;
      void syncPanel();
    } else desiredExpanded = undefined;
    if (!value) element('pet-toggle').focus({ preventScroll: true });
    else if (options.section === 'learning') showLearning(options.focusInput !== true, options.noteId);
    else if (Object.hasOwn(sectionViews, options.section)) {
      const target = element(sectionViews[activeSection].target);
      if (options.section === 'accessibility') target.open = true;
      target.scrollIntoView({ block: 'start' });
      if (['question', 'search'].includes(activeSection)) focusTextInput(target);
      else target.focus({ preventScroll: true });
    }
    else if (retryAction && options.notifyHost !== false) element('retry-action').focus({ preventScroll: true });
    else if (value && !options.section) element('feature-home').scrollIntoView({ block: 'start' });
    if (value && !element('question-form').hidden && (options.focusInput === true || (options.focusInput !== false && !options.section && !retryAction))) focusTextInput(element('question'));
  }

  function sendPetDrag(action, event) {
    const point = event && Number.isFinite(event.screenX) && Number.isFinite(event.screenY) ? { x: event.screenX, y: event.screenY } : undefined;
    try {
      Promise.resolve(point ? bridge.drag(action, point) : bridge.drag(action)).catch(error => {
        if (disposed) return;
        endPetDrag();
        showError('桌宠移动未完成', error);
      });
    } catch (error) {
      endPetDrag();
      showError('桌宠移动未完成', error);
    }
  }

  function endPetDrag(event) {
    if (!petDrag || (event?.pointerId !== undefined && event.pointerId !== petDrag.pointerId)) return;
    const current = petDrag;
    petDrag = undefined;
    if (current.frame !== undefined) window.cancelAnimationFrame?.(current.frame);
    suppressPetClick = suppressPetClick || current.moved;
    element('pet-toggle').classList.toggle('is-dragging', false);
    try { element('pet-toggle').releasePointerCapture?.(current.pointerId); } catch {}
    sendPetDrag('end');
  }

  function markPetDragMoved(event) {
    if (!petDrag || event.pointerId !== petDrag.pointerId) return false;
    if (!petDrag.moved && Math.hypot(event.screenX - petDrag.x, event.screenY - petDrag.y) < 2) return false;
    petDrag.moved = true;
    suppressPetClick = true;
    element('pet-toggle').classList.toggle('is-dragging', true);
    return true;
  }

  function movePetDrag(event) {
    if (!petDrag || event.pointerId !== petDrag.pointerId) return;
    if ((event.buttons & 1) === 0) { endPetDrag(event); return; }
    if (!markPetDragMoved(event)) return;
    event.preventDefault();
    if (petDrag.point?.screenX === event.screenX && petDrag.point?.screenY === event.screenY) return;
    petDrag.point = { screenX: event.screenX, screenY: event.screenY };
    if (!petDrag.sentFirstMove) {
      petDrag.sentFirstMove = true;
      sendPetDrag('move', petDrag.point);
    } else if (petDrag.frame === undefined && typeof window.requestAnimationFrame === 'function') {
      const current = petDrag;
      current.frame = window.requestAnimationFrame(() => {
        current.frame = undefined;
        if (petDrag === current) sendPetDrag('move', current.point);
      });
    }
  }

  function releasePetDrag(event) {
    if (!petDrag || event.pointerId !== petDrag.pointerId) return;
    if (markPetDragMoved(event)) sendPetDrag('move', event);
    endPetDrag(event);
  }

  function showMenu() {
    endPetDrag();
    void perform('menu', '原生菜单未打开', () => {
      if (typeof bridge?.showMenu !== 'function') throw new Error('原生菜单接口尚未接入');
      return bridge.showMenu();
    }, showMenu);
  }

  function dispose() {
    if (disposed) return;
    endPetDrag();
    if (pending.has('dictate')) void bridge?.cancelDictation?.().catch(() => {});
    dictationGeneration += 1;
    disposed = true;
    snapshotRequest += 1;
    for (const remove of removers) remove();
    for (const release of [unsubscribe, unsubscribePanel]) {
      if (typeof release === 'function') {
        try { release(); } catch (error) { console.error('桌宠订阅清理失败', error); }
      }
    }
    unsubscribe = undefined;
    unsubscribePanel = undefined;
  }

  bind(element('pet-toggle'), 'pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false || typeof bridge?.drag !== 'function') return;
    endPetDrag();
    suppressPetClick = false;
    petDrag = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, moved: false, sentFirstMove: false };
    try { element('pet-toggle').setPointerCapture?.(event.pointerId); } catch {}
    sendPetDrag('start', event);
  }, true);
  for (const target of [element('pet-toggle'), window]) {
    bind(target, 'pointermove', movePetDrag, true);
    bind(target, 'pointerup', releasePetDrag, true);
    bind(target, 'pointercancel', endPetDrag, true);
  }
  bind(element('pet-toggle'), 'lostpointercapture', endPetDrag);
  bind(window, 'blur', () => endPetDrag());
  bind(element('pet-toggle'), 'dragstart', event => event.preventDefault());
  bind(element('pet-toggle'), 'click', event => {
    if (suppressPetClick) {
      suppressPetClick = false;
      if (event.detail !== 0) { event.preventDefault(); event.stopPropagation(); return; }
    }
    if (window.nuanbanLili && element('pet-window').classList.contains('is-lili')) void window.nuanbanLili.interaction({ type: 'click' }).catch(() => {});
    window.dispatchEvent(new CustomEvent('nuanban:avatar-interaction'));
    setExpanded(!expanded);
  });
  bind(element('pet-notification'), 'click', () => {
    const section = notifications.get('privacy') || notifications.get('error') || notifications.values().next().value;
    if (!section) return;
    setExpanded(true, { section, focusInput: false });
    if (section === 'todos') window.dispatchEvent(new CustomEvent('nuanban:pet:show-due-todos'));
    else if (section === 'question') {
      element('conversation').scrollIntoView({ block: 'start' });
      element('conversation').focus({ preventScroll: true });
    }
  });
  bind(window, 'nuanban:pet:due-todos', event => {
    const entries = record(event.detail).keys;
    if (!Array.isArray(entries)) return;
    const keys = new Set(entries.filter(key => typeof key === 'string' && key.length <= 256).map(key => `todo:${key}`));
    for (const key of notifications.keys()) {
      if (key.startsWith('todo:') && !keys.has(key)) notifications.delete(key);
    }
    for (const key of keys) {
      if (knownTodoNotifications.has(key)) continue;
      notifications.set(key, 'todos');
    }
    knownTodoNotifications = keys;
    renderNotifications();
  });
  bind(element('collapse-panel'), 'click', () => setExpanded(false));
  for (const [control, section] of Object.entries({ 'view-features': 'features', 'view-guidance': 'guidance', 'feature-guidance': 'guidance', 'view-voice': 'voice', 'feature-question': 'question', 'feature-dictation': 'dictation', 'feature-observation': 'observation', 'guidance-observation': 'observation', 'observation-guidance': 'guidance', 'feature-learning': 'learning', 'feature-archive': 'archive', 'feature-todos': 'todos', 'archive-learning': 'learning', 'todos-archive': 'archive', 'pet-due-todos': 'todos', 'feature-captions': 'captions', 'feature-wake': 'wake', 'feature-management': 'accessibility' })) {
    bind(element(control), 'click', () => {
      setExpanded(true, { section, focusInput: false });
      if (control === 'feature-dictation') element('start-dictation').focus({ preventScroll: true });
      if (control === 'feature-wake') element('toggle-wake').focus({ preventScroll: true });
    });
  }
  bind(element('pet-toggle'), 'contextmenu', event => { event.preventDefault(); event.stopPropagation(); showMenu(); });
  bind(element('pet-toggle'), 'keydown', event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); showMenu(); }
  });
  bind(element('pet-menu'), 'click', showMenu);
  bind(window, 'nuanban:pet:navigate', event => {
    const section = record(event.detail).section;
    if (typeof section === 'string' && Object.hasOwn(sectionViews, section)) setExpanded(true, { section, focusInput: false });
  });
  bind(element('feature-avatar'), 'click', () => setExpanded(true, { section: 'avatar', focusInput: false }));
  bind(document, 'keydown', event => {
    if (event.key === 'Escape' && expanded && !event.isComposing) { event.preventDefault(); setExpanded(false); }
  });
  for (const identifier of ['question', 'search-query']) {
    bind(element(identifier), 'pointerdown', event => { if (event.button === 0) focusTextInput(element(identifier)); });
  }
  bind(element('question'), 'input', () => {
    if (!pending.has('dictate') && !dictationTranscript) dictationNotice = '';
    draftVersion += 1;
    learningNavigation = undefined;
    render();
  });
  bind(element('view-conversation'), 'click', () => {
    if (element('conversation').hidden) return;
    if (!composerSections.includes(activeSection)) setExpanded(true, { section: 'question', focusInput: false });
    element('conversation').scrollIntoView({ block: 'start' });
    element('conversation').focus({ preventScroll: true });
  });
  bind(element('question'), 'keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); sendQuestion(); }
  });
  bind(element('question-form'), 'submit', event => { event.preventDefault(); sendQuestion(); });
  bind(element('guidance-answer'), 'pointerdown', event => { if (event.button === 0) element('guidance-answer').focus({ preventScroll: true }); });
  bind(element('guidance-answer'), 'input', render);
  bind(element('guidance-answer'), 'keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); sendClarification(); }
  });
  bind(element('guidance-reply-form'), 'submit', event => { event.preventDefault(); sendClarification(); });
  bind(element('guidance-rescan'), 'click', rescanGuidance);
  bind(element('guidance-new-question'), 'click', () => {
    const context = clarificationContext();
    if (!context) return;
    newQuestionKey = context.key;
    render();
    element('question').focus({ preventScroll: true });
  });
  bind(element('start-dictation'), 'click', () => { void startDictation(); });
  bind(element('cancel-dictation'), 'click', () => { void cancelDictation(); });
  for (const [control, type] of Object.entries({ 'start-observation': 'observation.start', 'stop-observation': 'observation.stop', 'resume-sharing': 'observation.resume', 'verify-step': 'guidance.verify', 'repeat-step': 'guidance.repeat', 'finish-lesson': 'guidance.finish', 'toggle-captions': 'captions.toggle', 'start-voice-chat': 'voice.open', 'pet-voice': 'voice.open', 'feature-voice': 'voice.open', 'pet-voice-interrupt': 'voice.interrupt', 'pet-voice-end': 'voice.stop' })) {
    bind(element(control), 'click', () => requestCommand(type, control));
  }
  bind(element('guidance-start-observation'), 'click', () => {
    const state = flags();
    const type = state.canResume ? 'observation.resume' : state.safeObserving && state.observation.cloudConsent === false ? 'observation.reselect' : 'observation.start';
    requestCommand(type, 'guidance-start-observation');
  });
  bind(element('screen-voice-find'), 'click', () => { void startVoiceFind(); });
  bind(element('pet-voice-mute'), 'click', () => requestCommand(record(runtime.voice).state === 'muted' ? 'voice.unmute' : 'voice.mute', 'pet-voice-mute'));
  bind(element('toggle-wake'), 'click', () => requestCommand(record(runtime.wake).state === 'enabled' ? 'wake.disable' : 'wake.enable', 'toggle-wake'));
  bind(element('view-learning'), 'click', () => setExpanded(true, { section: 'learning', focusInput: false }));
  bind(element('mark-mastered'), 'click', () => setMastery(true));
  bind(element('mark-unmastered'), 'click', () => setMastery(false));
  bind(element('confirm-review'), 'click', () => respondToReview(true));
  bind(element('decline-review'), 'click', () => respondToReview(false));
  for (const button of document.querySelectorAll('[data-route]')) {
    const open = () => { void perform('open-main', '管理窗口未打开', () => bridge.openMain(button.dataset.route), open); };
    bind(button, 'click', open);
  }
  for (const button of document.querySelectorAll('[data-tool]')) {
    const open = () => {
      if (disposed || button.disabled) return;
      if (['/notes', '/todos'].includes(button.dataset.tool)) {
        setExpanded(true, { section: button.dataset.tool === '/notes' ? 'archive' : 'todos', focusInput: false });
        return;
      }
      void perform('open-tool', '桌宠工具未打开', () => {
        if (typeof bridge?.openTool !== 'function') throw new Error('桌宠工具接口尚未加载，请在保存当前操作后重新打开微光指引。');
        return bridge.openTool(button.dataset.tool);
      }, open);
    };
    bind(button, 'click', open);
  }
  bind(element('close-pet'), 'click', () => { element('exit-confirmation').hidden = false; element('confirm-exit').focus({ preventScroll: true }); });
  bind(element('cancel-exit'), 'click', () => { element('exit-confirmation').hidden = true; element('close-pet').focus({ preventScroll: true }); });
  const exit = () => { void perform('exit', '关闭桌宠未确认', () => bridge.close(), exit); };
  bind(element('confirm-exit'), 'click', exit);
  bind(element('retry-action'), 'click', () => { if (retryAction) retryAction(); });
  bind(element('dismiss-error'), 'click', () => { clearError(); render(); });
  bind(window, 'pagehide', dispose);
  bind(window, 'beforeunload', dispose);
  render();
  void connect();
})();
