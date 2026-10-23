const { spawn: nodeSpawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { externalScriptPath } = require('../external-script-path.cjs');

const wakePhrases = new Set(['暖伴', '暖伴暖伴', '小暖']);

function wakeError(code) { return Object.assign(new Error(code), { code }); }

function createWindowsLocalWake({ onWake = () => {}, onQuestion = () => {}, onState = () => {}, spawn = nodeSpawn, platform = process.platform, timeoutMs = 8_000, questionTimeoutMs = 8_000, dictationTimeoutMs = 20_000, maxOutputBytes = 65_536 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60_000 || !Number.isSafeInteger(questionTimeoutMs) || questionTimeoutMs < 1_000 || questionTimeoutMs > 30_000 || !Number.isSafeInteger(dictationTimeoutMs) || dictationTimeoutMs < 1_000 || dictationTimeoutMs > 30_000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 256 || maxOutputBytes > 256 * 1024) throw new RangeError('wake_limits_invalid');
  let generation = 0;
  let active = null;
  let state = Object.freeze({ state: 'disabled', enabled: false, microphoneActive: false, generation, localOnly: true, dictationAvailable: false });

  function notify(callback, value) {
    try { Promise.resolve(callback(value)).catch(() => {}); } catch {}
  }

  function publish(next, reason, operation = active) {
    const potentiallyActive = Boolean(operation && operation.kind !== 'probe' && !operation.isClosed);
    state = Object.freeze({ state: next, enabled: Boolean(potentiallyActive), microphoneActive: Boolean(potentiallyActive), generation, ...(reason ? { reason } : {}), localOnly: true, dictationAvailable: operation?.dictationAvailable === true });
    notify(onState, state);
  }

  function available(operation) {
    return active === operation && operation.generation === generation && !operation.intentional && !operation.failure && !operation.isClosed;
  }

  function kill(operation) { try { operation.child?.kill(); } catch {} }

  function fail(operation, reason) {
    if (operation.isClosed || operation.intentional || operation.failure) return;
    operation.failure = reason;
    clearTimeout(operation.questionTimer);
    operation.questionId = null;
    operation.rejectReady(wakeError(reason));
    if (active === operation && operation.kind !== 'probe') publish(reason.includes('unavailable') ? 'unavailable' : 'error', reason, operation);
    kill(operation);
  }

  function send(operation, command) {
    if (!operation.child || operation.isClosed) return false;
    try {
      if (operation.child.stdin.destroyed || operation.child.stdin.writableEnded) throw wakeError('wake_stdin_failed');
      operation.child.stdin.write(`${JSON.stringify({ ...command, token: operation.token, generation: operation.generation })}\n`);
      return true;
    } catch { fail(operation, 'wake_stdin_failed'); return false; }
  }

  function resumeWake(operation) {
    clearTimeout(operation.questionTimer);
    operation.questionId = null;
    if (!available(operation)) return;
    send(operation, { op: 'mode', mode: 'wake' });
    if (available(operation)) publish('listening', undefined, operation);
  }

  function handleEvent(operation, event) {
    if (!available(operation)) return;
    if (!event || typeof event !== 'object' || Array.isArray(event)) { fail(operation, 'wake_protocol_invalid'); return; }
    if (event.token !== operation.token || event.generation !== operation.generation) return;
    if (event.kind === 'error') {
      fail(operation, typeof event.reason === 'string' && /^wake_[a-z_]{1,60}$/.test(event.reason) ? event.reason : 'wake_engine_failed');
      return;
    }
    if (operation.kind === 'probe') {
      if (event.kind !== 'probe' || operation.probeResult) { fail(operation, 'wake_probe_output_invalid'); return; }
      if (event.status !== 'complete') {
        operation.probeResult = { status: 'unavailable', reason: typeof event.reason === 'string' && /^wake_[a-z_]{1,60}$/.test(event.reason) ? event.reason : 'wake_probe_failed' };
        return;
      }
      if (!Array.isArray(event.recognizers) || event.recognizers.length > 32 || typeof event.dictationAvailable !== 'boolean') { fail(operation, 'wake_probe_output_invalid'); return; }
      const recognizers = [];
      for (const item of event.recognizers) {
        if (!item || !['culture', 'name', 'id'].every(key => typeof item[key] === 'string' && item[key].length >= 1 && item[key].length <= 128)) { fail(operation, 'wake_probe_output_invalid'); return; }
        recognizers.push(Object.freeze({ culture: item.culture, name: item.name, id: item.id }));
      }
      operation.probeResult = recognizers.some(item => /^zh-(?:Hans-)?CN$/i.test(item.culture))
        ? { status: 'complete', recognizers: Object.freeze(recognizers), dictationAvailable: event.dictationAvailable, ...(event.dictationAvailable ? {} : { dictationReason: 'wake_dictation_unavailable' }), microphoneOpened: false, localOnly: true }
        : { status: 'unavailable', reason: 'wake_zh_cn_recognizer_unavailable' };
      return;
    }
    if (event.kind === 'ready') {
      if (operation.ready || typeof event.dictationAvailable !== 'boolean') { fail(operation, 'wake_protocol_invalid'); return; }
      clearTimeout(operation.timer);
      operation.ready = true;
      operation.dictationAvailable = event.dictationAvailable;
      if (operation.kind === 'dictate') {
        if (!operation.dictationAvailable) { fail(operation, 'wake_dictation_unavailable'); return; }
        operation.questionTimer = setTimeout(() => fail(operation, 'wake_dictation_timeout'), dictationTimeoutMs);
      }
      publish(operation.kind === 'dictate' ? 'question' : 'listening', undefined, operation);
      if (available(operation)) operation.resolveReady();
      return;
    }
    if (!operation.ready) { fail(operation, 'wake_protocol_invalid'); return; }
    if (event.kind === 'wake') {
      if (operation.kind === 'dictate') return;
      if (state.state !== 'listening' || !wakePhrases.has(event.phrase)) return;
      if (operation.dictationAvailable) {
        operation.questionId = randomUUID();
        if (!send(operation, { op: 'mode', mode: 'question', questionId: operation.questionId }) || !available(operation)) return;
        operation.questionTimer = setTimeout(() => resumeWake(operation), questionTimeoutMs);
        publish('question', undefined, operation);
      }
      if (available(operation)) notify(onWake, Object.freeze({ localOnly: true, generation: operation.generation, dictationAvailable: operation.dictationAvailable }));
      return;
    }
    if (event.kind === 'uncertain') {
      if (state.state !== 'question' || !operation.questionId || event.questionId !== operation.questionId) return;
      if (operation.kind === 'dictate') {
        operation.uncertain = true;
        void stopOperation(operation);
      } else resumeWake(operation);
      return;
    }
    if (event.kind === 'question') {
      if (state.state !== 'question' || !operation.questionId || event.questionId !== operation.questionId) return;
      if (typeof event.text !== 'string' || event.text.length > 500) { fail(operation, 'wake_question_limit'); return; }
      const text = event.text.trim();
      if (operation.kind === 'dictate') {
        if (text) { operation.transcript = text; void stopOperation(operation); }
        return;
      }
      resumeWake(operation);
      if (text && available(operation)) notify(onQuestion, text);
      return;
    }
    if (event.kind !== 'mode') fail(operation, 'wake_protocol_invalid');
  }

  function begin(kind, signal) {
    const operation = { kind, generation: ++generation, token: randomUUID(), child: null, ready: false, intentional: false, failure: null, isClosed: false, dictationAvailable: false, uncertain: false, probeResult: null, questionId: null, questionTimer: null, timer: null, stopTimer: null, decoder: new TextDecoder('utf-8', { fatal: true }), pending: '', outputBytes: 0, stderrBytes: 0 };
    operation.transcript = null;
    if (kind === 'dictate') operation.questionId = randomUUID();
    operation.readyPromise = new Promise((resolve, reject) => { operation.resolveReady = resolve; operation.rejectReady = reject; });
    operation.readyPromise.catch(() => {});
    operation.closed = new Promise(resolve => { operation.resolveClosed = resolve; });
    operation.onAbort = () => { if (active === operation) void disable(); };
    active = operation;
    signal?.addEventListener('abort', operation.onAbort, { once: true });
    function closed(code) {
      if (operation.isClosed) return;
      if (!operation.intentional && !operation.failure) {
        try { operation.pending += operation.decoder.decode(); } catch { operation.failure = 'wake_output_invalid'; }
        if (!operation.failure) {
          if (operation.pending.trim() || operation.stderrBytes || code !== 0) operation.failure = 'wake_engine_failed';
          else if (kind !== 'probe') operation.failure = 'wake_helper_exited';
          else if (!operation.probeResult) operation.failure = 'wake_probe_output_invalid';
        }
      }
      operation.isClosed = true;
      operation.pending = '';
      clearTimeout(operation.timer);
      clearTimeout(operation.questionTimer);
      clearTimeout(operation.stopTimer);
      signal?.removeEventListener('abort', operation.onAbort);
      operation.rejectReady(wakeError(operation.intentional ? 'aborted' : operation.failure ?? 'wake_engine_failed'));
      if (active === operation) {
        active = null;
        if (operation.intentional) publish('disabled', undefined, operation);
        else if (kind !== 'probe') publish(operation.failure?.includes('unavailable') ? 'unavailable' : 'error', operation.failure, operation);
      }
      operation.resolveClosed();
    }
    operation.close = closed;
    operation.timer = setTimeout(() => fail(operation, kind === 'probe' ? 'wake_probe_timeout' : 'wake_start_timeout'), timeoutMs);
    if (kind !== 'probe') publish('starting', undefined, operation);
    if (operation.intentional || signal?.aborted) {
      operation.intentional = true;
      closed(0);
      return operation;
    }
    try {
      const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', externalScriptPath(path.join(__dirname, 'windows-local-wake.ps1'))], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      operation.child = child;
      child.on('error', () => fail(operation, 'wake_helper_spawn_unavailable'));
      child.on('close', closed);
      child.stdin.on('error', () => { if (!operation.intentional) fail(operation, 'wake_stdin_failed'); });
      child.stdout.on('error', () => fail(operation, 'wake_stdout_failed'));
      child.stderr.on('error', () => fail(operation, 'wake_stderr_failed'));
      child.stderr.on('data', bytes => { operation.stderrBytes += bytes.length; if (operation.stderrBytes > 8192) fail(operation, 'wake_stderr_limit'); });
      child.stdout.on('data', bytes => {
        if (!available(operation)) return;
        operation.outputBytes += bytes.length;
        if (operation.outputBytes > maxOutputBytes) { fail(operation, 'wake_output_limit'); return; }
        try { operation.pending += operation.decoder.decode(bytes, { stream: true }); } catch { fail(operation, 'wake_output_invalid'); return; }
        let newline;
        while (available(operation) && (newline = operation.pending.indexOf('\n')) >= 0) {
          const line = operation.pending.slice(0, newline).trim();
          operation.pending = operation.pending.slice(newline + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { fail(operation, 'wake_output_invalid'); return; }
          handleEvent(operation, event);
        }
      });
      send(operation, { op: kind === 'dictate' ? 'enable' : kind, ...(kind !== 'probe' ? { actor: 'owner', confirmed: true, questionTimeoutMs: kind === 'dictate' ? dictationTimeoutMs : questionTimeoutMs } : {}), ...(kind === 'dictate' ? { mode: 'dictation', questionId: operation.questionId } : {}) });
      if (kind === 'probe') child.stdin.end();
    } catch {
      operation.failure = 'wake_helper_spawn_unavailable';
      if (operation.child) kill(operation);
      else closed(1);
    }
    return operation;
  }

  async function probe({ signal } = {}) {
    if (platform !== 'win32') return Object.freeze({ status: 'unavailable', reason: 'windows_speech_unavailable' });
    if (active) return Object.freeze({ status: 'unavailable', reason: 'busy' });
    if (signal?.aborted) return Object.freeze({ status: 'unavailable', reason: 'aborted' });
    const operation = begin('probe', signal);
    await operation.closed;
    return Object.freeze(operation.intentional ? { status: 'unavailable', reason: 'aborted' } : operation.failure ? { status: 'unavailable', reason: operation.failure } : operation.probeResult);
  }

  async function enable({ actor, confirmed, signal } = {}) {
    if (actor !== 'owner' || confirmed !== true) throw wakeError('owner_confirmation_required');
    if (platform !== 'win32') throw wakeError('windows_speech_unavailable');
    if (active) throw wakeError('busy');
    if (signal?.aborted) throw wakeError('aborted');
    const operation = begin('enable', signal);
    try {
      await operation.readyPromise;
      if (!available(operation)) throw wakeError(operation.intentional ? 'aborted' : operation.failure ?? 'wake_engine_failed');
      return state;
    } catch (error) { await operation.closed; throw wakeError(error?.code ?? 'wake_engine_failed'); }
  }

  async function dictate({ actor, confirmed, signal } = {}) {
    if (actor !== 'owner' || confirmed !== true) throw wakeError('owner_confirmation_required');
    if (platform !== 'win32') throw wakeError('windows_speech_unavailable');
    if (active) throw wakeError('busy');
    if (signal?.aborted) return Object.freeze({ status: 'cancelled', localOnly: true, microphoneActive: false });
    const operation = begin('dictate', signal);
    try { await operation.readyPromise; } catch {}
    await operation.closed;
    if (signal?.aborted || (operation.intentional && !operation.transcript && !operation.uncertain)) return Object.freeze({ status: 'cancelled', localOnly: true, microphoneActive: false });
    if (operation.uncertain) return Object.freeze({ status: 'uncertain', localOnly: true, microphoneActive: false });
    if (operation.failure || !operation.transcript) throw wakeError(operation.failure ?? 'wake_engine_failed');
    return Object.freeze({ status: 'complete', text: operation.transcript, localOnly: true, microphoneActive: false });
  }

  function stopOperation(operation) {
    if (!operation) { if (state.state !== 'disabled') publish('disabled'); return Promise.resolve(state); }
    if (operation.stopPromise) { if (!operation.isClosed) kill(operation); return operation.stopPromise; }
    operation.intentional = true;
    generation += 1;
    clearTimeout(operation.timer);
    clearTimeout(operation.questionTimer);
    operation.rejectReady(wakeError('aborted'));
    operation.stopPromise = operation.closed.then(() => state);
    publish('stopping', undefined, operation);
    if (!operation.child) operation.close(0);
    else if (operation.kind === 'probe') kill(operation);
    else {
      send(operation, { op: 'stop' });
      if (!operation.isClosed) operation.stopTimer = setTimeout(() => kill(operation), 500);
    }
    return operation.stopPromise;
  }

  function disable() {
    if (active) active.transcript = null;
    return stopOperation(active);
  }

  notify(onState, state);
  return Object.freeze({ probe, enable, dictate, disable, snapshot: () => state });
}

module.exports = { createWindowsLocalWake };
