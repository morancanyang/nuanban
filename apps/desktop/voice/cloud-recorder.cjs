const fs = require('node:fs');
const path = require('node:path');
const { spawn: nodeSpawn } = require('node:child_process');
const { externalScriptPath } = require('../external-script-path.cjs');

const MAX_WAV_BYTES = 10 * 1024 * 1024;
const REASONS = new Set(['cloud_dictation_no_speech', 'cloud_dictation_failed', 'cloud_dictation_unavailable',
  'cloud_dictation_timeout', 'cloud_dictation_naudio_missing', 'cloud_dictation_request_invalid']);

function recorderError(code) { return Object.assign(new Error(code), { code }); }

/**
 * Records one utterance with the packaged PowerShell helper and returns the normalised WAV bytes.
 * The helper never uploads anything; the caller decides whether the audio may leave the machine.
 * Temporary WAV files are removed on every exit path.
 */
function createCloudRecorder({ spawn = nodeSpawn, scriptPath, powershellPath = 'powershell.exe', platform = process.platform,
  maxSeconds = 20, silenceMs = 1500, timeoutMs = 40_000, maxBufferBytes = 64 * 1024 } = {}) {
  if (platform !== 'win32') return Object.freeze({ available: false, reason: 'cloud_dictation_unavailable', record: async () => { throw recorderError('cloud_dictation_unavailable'); } });
  if (typeof scriptPath !== 'string' || path.extname(scriptPath).toLowerCase() !== '.ps1') throw new TypeError('cloud_dictation_script_invalid');
  if (!Number.isSafeInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 30) throw new TypeError('cloud_dictation_limits_invalid');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 120_000) throw new TypeError('cloud_dictation_limits_invalid');

  async function record({ outFile, signal } = {}) {
    const target = outFile ?? path.join(path.dirname(scriptPath), `dictation-${process.pid}-${Date.now()}.wav`);
    const helper = externalScriptPath(scriptPath);
    const naudioPath = path.join(path.dirname(helper), 'NAudio.dll');
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', helper, '-OutFile', target, '-MaxSeconds', String(maxSeconds), '-SilenceMs', String(silenceMs), '-NaudioPath', naudioPath];
    let child;
    try {
      child = spawn(powershellPath, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { throw recorderError('cloud_dictation_unavailable'); }

    const cleanup = () => {
      for (const candidate of [target, `${target}.normalised.wav`]) {
        try { fs.rmSync(candidate, { force: true }); } catch {}
      }
    };

    try {
      const summary = await new Promise((resolve, reject) => {
        let buffer = '';
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (error) reject(error); else resolve(value);
        };
        const onAbort = () => { try { child.kill(); } catch {} finish(recorderError('cloud_dictation_unavailable')); };
        const timer = setTimeout(() => { try { child.kill(); } catch {} finish(recorderError('cloud_dictation_timeout')); }, timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          buffer += chunk;
          if (buffer.length > maxBufferBytes) { try { child.kill(); } catch {} finish(recorderError('cloud_dictation_failed')); return; }
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            let event;
            try { event = JSON.parse(line); } catch { continue; }
            if (event?.kind === 'error') { finish(recorderError(REASONS.has(event.reason) ? event.reason : 'cloud_dictation_failed')); return; }
            if (event?.kind === 'recorded') {
              const detail = event.detail ?? {};
              if (typeof detail.path !== 'string' || !path.isAbsolute(detail.path)) { finish(recorderError('cloud_dictation_failed')); return; }
              finish(null, { path: detail.path, seconds: Number(detail.seconds) || 0, peak: Number(detail.peak) || 0, gain: Number(detail.gain) || 1 });
              return;
            }
          }
        });
        child.on('error', () => finish(recorderError('cloud_dictation_unavailable')));
        child.on('close', (code) => { if (!settled) finish(recorderError(code === 0 ? 'cloud_dictation_failed' : 'cloud_dictation_no_speech')); });
      });

      let wav;
      try {
        const details = fs.lstatSync(summary.path);
        if (!details.isFile() || details.size < 44 || details.size > MAX_WAV_BYTES) throw recorderError('cloud_dictation_failed');
        wav = fs.readFileSync(summary.path);
      } catch (error) {
        if (error?.code?.startsWith?.('cloud_dictation_')) throw error;
        throw recorderError('cloud_dictation_failed');
      }
      return Object.freeze({ wav, seconds: summary.seconds, peak: summary.peak, gain: summary.gain });
    } finally {
      cleanup();
    }
  }

  return Object.freeze({ available: true, record });
}

module.exports = { createCloudRecorder, MAX_WAV_BYTES };