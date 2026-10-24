function registerDictationBridge({ ipcMain, prefix, isTrusted, getHost }) {
  let active = null;
  let disposed = false;
  const channels = [`${prefix}:dictate`, `${prefix}:cancel-dictation`];

  function authorize(event, argumentsList) {
    if (disposed || !isTrusted(event)) throw new Error('不可信语音入口');
    if (argumentsList.length) throw new Error('麦克风授权必须由本人在原生窗口确认');
    const host = getHost();
    if (!host?.hasPetWindow()) throw new Error('独立桌宠尚未就绪');
    return host;
  }

  ipcMain.handle(channels[0], (event, ...argumentsList) => {
    const host = authorize(event, []);
    const input = argumentsList[0];
    if (argumentsList.length && (argumentsList.length !== 1 || !input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== 2 || input.purpose !== 'screen-guidance'
      || !Number.isSafeInteger(input.observationGeneration) || input.observationGeneration < 1)) throw new Error('麦克风授权必须由本人在原生窗口确认');
    if (active) throw new Error('本次语音输入尚未结束');
    if (typeof host.requestVoiceDictation !== 'function') throw new Error('请重新打开客户端以加载语音输入功能');
    const operation = { controller: new AbortController(), sender: event.sender, promise: null };
    const abort = () => operation.controller.abort();
    const navigate = (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame !== false) abort(); };
    active = operation;
    operation.sender?.on('destroyed', abort);
    operation.sender?.on('render-process-gone', abort);
    operation.sender?.on('did-start-navigation', navigate);
    operation.promise = Promise.resolve().then(() => host.requestVoiceDictation({ signal: operation.controller.signal,
      ...(input ? { purpose: 'screen-guidance', observationGeneration: input.observationGeneration } : {}) })).then(result => {
      if (operation.controller.signal.aborted || disposed || !isTrusted(event)) return { status: 'cancelled', localOnly: true };
      const cloud = result?.localOnly === false && result?.recognition === 'cloud';
      const local = result?.localOnly === true && (result?.recognition === undefined || result?.recognition === 'local');
      if (!result || (!cloud && !local) || !['complete', 'uncertain', 'cancelled'].includes(result.status)
        || (result.status === 'complete' && (result.microphoneActive !== false || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 500))
        || (result.status === 'uncertain' && result.microphoneActive !== false)
        || (cloud && result.status !== 'complete')) throw new Error('听写结果未确认');
      return Object.freeze({ status: result.status, ...(result.status === 'complete' ? { text: result.text.trim(), microphoneActive: false,
        recognition: cloud ? 'cloud' : 'local' } : result.status === 'uncertain' ? { microphoneActive: false } : {}), localOnly: cloud ? false : true });
    }).finally(() => {
      operation.sender?.removeListener('destroyed', abort);
      operation.sender?.removeListener('render-process-gone', abort);
      operation.sender?.removeListener('did-start-navigation', navigate);
      if (active === operation) active = null;
    });
    return operation.promise;
  });

  ipcMain.handle(channels[1], async (event, ...argumentsList) => {
    authorize(event, argumentsList);
    const operation = active;
    if (!operation || operation.sender !== event.sender) return false;
    operation.controller.abort();
    await operation.promise;
    return true;
  });

  return { dispose() {
    disposed = true;
    active?.controller.abort();
    for (const channel of channels) ipcMain.removeHandler(channel);
  } };
}

module.exports = { registerDictationBridge };
