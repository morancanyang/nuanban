const { spawn: nodeSpawn } = require('node:child_process');
const path = require('node:path');
const { externalScriptPath } = require('../external-script-path.cjs');
const { ObservationError, checkAborted } = require('./observation-common.cjs');

function createWindowsHelperProcess({ spawn = nodeSpawn, timeoutMs = 15_000, maxOutputBytes = 2 * 1024 * 1024, platform = process.platform, script = 'windows-local-analysis.ps1', maxStderrBytes = 8192, maxInputBytes = 33_570_816 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 128 || maxOutputBytes > 2 * 1024 * 1024) throw new ObservationError('invalid_helper_limits');
  // 固定脚本名（不接受调用方传任意路径）：调用方只能在本目录内选择随包脚本。
  if (typeof script !== 'string' || !/^windows-[a-z0-9-]+\.ps1$/.test(script)) throw new ObservationError('invalid_helper_script');
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 128 || maxInputBytes > 33_570_816) throw new ObservationError('invalid_helper_limits');
  let active = null;

  async function run(request, { signal } = {}) {
    checkAborted(signal);
    if (platform !== 'win32') throw new ObservationError('windows_analysis_unavailable');
    if (active) throw new ObservationError('busy');
    const encoded = Buffer.from(JSON.stringify(request), 'utf8');
    if (encoded.length > maxInputBytes) throw new ObservationError('helper_input_limit');
    let child;
    try {
      const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', externalScriptPath(path.join(__dirname, script))], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      encoded.fill(0);
      throw new ObservationError('helper_spawn_unavailable');
    }
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    const operation = { child, closed, cancel: null };
    active = operation;
    return new Promise((resolve, reject) => {
      let pendingError = null;
      let outputBytes = 0;
      let stderrBytes = 0;
      const chunks = [];
      const cancel = reason => {
        pendingError ??= new ObservationError(reason);
        child.stdin?.destroy();
        try { child.kill(); } catch {}
      };
      operation.cancel = cancel;
      const onAbort = () => cancel('aborted');
      const timer = setTimeout(() => cancel('helper_timeout'), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', () => { pendingError ??= new ObservationError('helper_spawn_unavailable'); });
      child.stdout.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) cancel('helper_output_limit');
        else if (!pendingError) chunks.push(Buffer.from(chunk));
      });
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length;
        if (stderrBytes > maxStderrBytes) cancel('helper_stderr_limit');
      });
      child.stdin.on('error', () => {
        if (!pendingError) cancel('helper_stdin_failed');
      });
      child.on('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        encoded.fill(0);
        if (active === operation) active = null;
        resolveClosed();
        try {
          if (pendingError) throw pendingError;
          if (code !== 0 || stderrBytes !== 0) throw new ObservationError('helper_process_failed');
          const output = Buffer.concat(chunks, outputBytes);
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(output);
            resolve(JSON.parse(text));
          } finally {
            output.fill(0);
          }
        } catch (error) {
          reject(error instanceof ObservationError ? error : new ObservationError('helper_output_invalid'));
        } finally {
          for (const chunk of chunks) chunk.fill(0);
        }
      });
      if (signal?.aborted) onAbort();
      else child.stdin.end(encoded);
    });
  }

  async function stop() {
    const operation = active;
    if (!operation) return;
    operation.cancel('aborted');
    await operation.closed;
  }

  return Object.freeze({ run, stop });
}

module.exports = { createWindowsHelperProcess };
