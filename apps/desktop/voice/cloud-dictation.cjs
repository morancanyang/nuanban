const { ProviderFailure, readProviderConfiguration } = require('../ai-provider.cjs');

const TRANSCRIBE_MODELS = new Set(['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1']);
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 500;

function checkedOptions({ model, timeoutMs, retryAttempts, retryDelaysMs }) {
  if (typeof model !== 'string' || !TRANSCRIBE_MODELS.has(model)) throw new ProviderFailure('INVALID_REQUEST');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new ProviderFailure('INVALID_REQUEST');
  if (!Number.isSafeInteger(retryAttempts) || retryAttempts < 0 || retryAttempts > 3) throw new ProviderFailure('INVALID_REQUEST');
  if (!Array.isArray(retryDelaysMs) || retryDelaysMs.length < retryAttempts
    || retryDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 10_000)) throw new ProviderFailure('INVALID_REQUEST');
}

function checkedText(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.text !== 'string') throw new ProviderFailure('PROVIDER_UNAVAILABLE', true);
  const text = payload.text.trim();
  if (!text) throw new ProviderFailure('INVALID_REQUEST');
  if (text.length > MAX_TEXT_CHARS) throw new ProviderFailure('INVALID_REQUEST');
  return text;
}

/**
 * Cloud dictation client. Audio is held in memory for this request only: nothing is written to disk by
 * this module and the caller decides whether uploading is allowed at all (owner consent gate).
 */
function createCloudDictation(options = {}) {
  const baseUrl = options.baseUrl;
  if (typeof baseUrl !== 'string' || !/^https:\/\//.test(baseUrl)) throw new ProviderFailure('INVALID_REQUEST');
  const apiKey = options.apiKey;
  if (typeof apiKey !== 'string' || apiKey.length < 10) throw new ProviderFailure('INVALID_REQUEST');
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const model = options.model === undefined ? 'gpt-4o-transcribe' : options.model;
  const timeoutMs = options.timeoutMs === undefined ? 60_000 : options.timeoutMs;
  const retryAttempts = options.retryAttempts === undefined ? 2 : options.retryAttempts;
  const retryDelaysMs = options.retryDelaysMs === undefined ? [800, 2_400] : options.retryDelaysMs;
  checkedOptions({ model, timeoutMs, retryAttempts, retryDelaysMs });
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;

  async function runAttempt(wavBytes, signal) {
    const form = new FormData();
    form.append('model', model);
    form.append('language', 'zh');
    form.append('response_format', 'json');
    form.append('file', new Blob([wavBytes], { type: 'audio/wav' }), 'speech.wav');
    const response = await fetchRequest(endpoint, { method: 'POST', redirect: 'error', signal,
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' }, body: form });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if ([401, 403].includes(response.status)) throw new ProviderFailure('AUTH_FAILED');
      if (response.status === 429) throw new ProviderFailure('RATE_LIMITED', true);
      if (response.status === 400 || response.status === 413) throw new ProviderFailure('INVALID_REQUEST');
      throw new ProviderFailure('PROVIDER_UNAVAILABLE', response.status >= 500);
    }
    const payload = await response.json().catch(() => null);
    return checkedText(payload);
  }

  return Object.freeze({
    model,
    status() { return Object.freeze({ available: true, model, uploadsAudio: true }); },
    async transcribe({ wav, signal } = {}) {
      if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.length > MAX_AUDIO_BYTES) throw new ProviderFailure('INVALID_REQUEST');
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let lastError;
      for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
        try {
          const text = await runAttempt(wav, combined);
          combined.throwIfAborted();
          return Object.freeze({ text, attempts: attempt + 1 });
        } catch (error) {
          lastError = error;
          const retryable = error instanceof ProviderFailure && error.retryable === true;
          if (!retryable || attempt >= retryAttempts || combined.aborted) {
            if (error instanceof ProviderFailure) error.attempts = attempt + 1;
            break;
          }
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { combined.removeEventListener('abort', abort); resolve(); },
              retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]);
            const abort = () => { clearTimeout(timer); reject(new ProviderFailure('CANCELLED')); };
            combined.addEventListener('abort', abort, { once: true });
          });
        }
      }
      if (signal?.aborted) throw new ProviderFailure('CANCELLED');
      if (timeout.aborted) throw new ProviderFailure('TIMEOUT', true);
      throw lastError;
    },
  });
}

/**
 * Builds a cloud dictation client from the same encrypted provider configuration the text model uses.
 * Returns undefined when no gateway is configured, so the host simply keeps local-only dictation.
 */
async function loadConfiguredCloudDictation(options = {}) {
  const configuration = await readProviderConfiguration(options);
  if (!configuration) return undefined;
  const env = options.env ?? process.env;
  const model = options.model ?? env.NUANBAN_AI_TRANSCRIBE_MODEL ?? 'gpt-4o-transcribe';
  return createCloudDictation({ baseUrl: configuration.baseUrl, apiKey: configuration.apiKey, model,
    timeoutMs: options.timeoutMs ?? 60_000, fetch: options.fetch,
    ...(options.retryAttempts === undefined ? {} : { retryAttempts: options.retryAttempts }),
    ...(options.retryDelaysMs === undefined ? {} : { retryDelaysMs: options.retryDelaysMs }) });
}

module.exports = { createCloudDictation, loadConfiguredCloudDictation, TRANSCRIBE_MODELS, MAX_AUDIO_BYTES, MAX_TEXT_CHARS };