import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowsLocalWake, type WindowsLocalWakeOptions, type WindowsLocalWakeState } from '../../apps/desktop/wake/windows-local-wake.cjs';

type Packet = Record<string, unknown>;
type Wake = ReturnType<typeof createWindowsLocalWake>;
interface ProcessSettings {
  autoReady?: boolean;
  autoProbe?: boolean;
  closeProbe?: boolean;
  closeOnStop?: boolean;
  closeOnKill?: boolean;
  dictationAvailable?: boolean;
  probeEvent?: Packet;
  enableEvent?: Packet;
}

class WakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  commands: Packet[] = [];
  isClosed = false;
  private pending = '';
  kill = vi.fn(() => {
    if (this.settings.closeOnKill !== false) queueMicrotask(() => this.close(0));
    return true;
  });

  constructor(readonly settings: ProcessSettings) {
    super();
    this.stdin.on('data', (bytes: Buffer) => {
      this.pending += bytes.toString('utf8');
      let newline;
      while ((newline = this.pending.indexOf('\n')) >= 0) {
        const command = JSON.parse(this.pending.slice(0, newline)) as Packet;
        this.pending = this.pending.slice(newline + 1);
        this.commands.push(command);
        if (command.op === 'probe' && this.settings.autoProbe !== false) {
          this.packet(this.settings.probeEvent ?? { kind: 'probe', status: 'complete', recognizers: [{ culture: 'zh-CN', name: 'Local recognizer', id: 'local-zh' }], dictationAvailable: this.settings.dictationAvailable !== false });
          if (this.settings.closeProbe !== false) queueMicrotask(() => this.close(0));
        }
        if (command.op === 'enable' && this.settings.autoReady !== false) this.packet(this.settings.enableEvent ?? { kind: 'ready', dictationAvailable: this.settings.dictationAvailable !== false });
        if (command.op === 'stop' && this.settings.closeOnStop !== false) queueMicrotask(() => this.close(0));
      }
    });
  }

  packet(event: Packet) {
    const request = this.commands[0];
    this.stdout.write(`${JSON.stringify({ token: request?.token, generation: request?.generation, ...event })}\n`);
  }

  question(text: string, questionId = [...this.commands].reverse().find(command => ['question', 'dictation'].includes(String(command.mode)))?.questionId) {
    this.packet({ kind: 'question', questionId, text });
  }

  close(code = 0) {
    if (this.isClosed) return;
    this.isClosed = true;
    this.emit('close', code, null);
  }
}

const adapters: Wake[] = [];
const processes: WakeProcess[] = [];

function setup(settings: ProcessSettings = {}, options: WindowsLocalWakeOptions = {}) {
  const children: WakeProcess[] = [];
  const spawn = vi.fn((_executable: string, _arguments: readonly string[], _options: unknown) => {
    const child = new WakeProcess(settings);
    children.push(child);
    processes.push(child);
    return child as unknown as ReturnType<typeof nodeSpawn>;
  });
  const onWake = vi.fn<(event: { localOnly: true; generation: number; dictationAvailable: boolean }) => void>();
  const onQuestion = vi.fn<(text: string) => void>();
  const onState = vi.fn<(state: WindowsLocalWakeState) => void>();
  const wake = createWindowsLocalWake({ platform: 'win32', spawn: spawn as unknown as typeof nodeSpawn, onWake, onQuestion, onState, ...options });
  adapters.push(wake);
  return { wake, spawn, children, onWake, onQuestion, onState, enable: () => wake.enable({ actor: 'owner', confirmed: true }), child: () => children.at(-1)! };
}

afterEach(async () => {
  const pending = adapters.splice(0).map(wake => wake.disable());
  for (const child of processes.splice(0)) child.close(0);
  await Promise.all(pending);
  vi.useRealTimers();
});

describe('explicit one-shot local dictation without a wake phrase', () => {
  it('requires owner confirmation and never starts as a side effect of status', async () => {
    const current = setup();
    current.wake.snapshot();
    await expect(current.wake.dictate({ actor: 'remote', confirmed: true } as never)).rejects.toThrow('owner_confirmation_required');
    expect(current.spawn).not.toHaveBeenCalled();
  });

  it('recognizes directly, stops the microphone, and does not submit a wake question', async () => {
    const current = setup();
    const result = current.wake.dictate({ actor: 'owner', confirmed: true });
    expect(current.child().commands[0]).toMatchObject({ op: 'enable', mode: 'dictation', questionId: expect.any(String), questionTimeoutMs: 20_000 });
    expect(current.wake.snapshot()).toMatchObject({ state: 'question', microphoneActive: true });
    current.child().question('忽略旧结果', 'old-request');
    current.child().packet({ kind: 'wake', phrase: '暖伴' });
    current.child().question('  教我收藏网页  ');
    await expect(result).resolves.toEqual({ status: 'complete', text: '教我收藏网页', localOnly: true, microphoneActive: false });
    expect(current.wake.snapshot()).toMatchObject({ state: 'disabled', microphoneActive: false });
    expect(current.onWake).not.toHaveBeenCalled();
    expect(current.onQuestion).not.toHaveBeenCalled();
    expect(current.child().commands.some(command => command.mode === 'wake')).toBe(false);
  });

  it('does not release a transcript until the real microphone process has exited', async () => {
    const current = setup({ closeOnStop: false, closeOnKill: false });
    const settled = vi.fn();
    const result = current.wake.dictate({ actor: 'owner', confirmed: true }).then(value => { settled(); return value; });
    current.child().question('本地听写');
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(current.wake.snapshot()).toMatchObject({ state: 'stopping', enabled: true, microphoneActive: true });
    current.child().close();
    await expect(result).resolves.toMatchObject({ status: 'complete', text: '本地听写' });
  });

  it('returns an uncertain result without releasing a guessed transcript', async () => {
    const current = setup({ closeOnStop: false, closeOnKill: false });
    const result = current.wake.dictate({ actor: 'owner', confirmed: true });
    current.child().packet({ kind: 'uncertain', questionId: current.child().commands[0].questionId });
    expect(current.wake.snapshot()).toMatchObject({ state: 'stopping', microphoneActive: true });
    current.child().close();
    await expect(result).resolves.toEqual({ status: 'uncertain', localOnly: true, microphoneActive: false });
    expect(current.onQuestion).not.toHaveBeenCalled();
  });

  it('cancels the lifetime and discards late recognition while awaiting actual shutdown', async () => {
    const current = setup({ closeOnStop: false, closeOnKill: false });
    const controller = new AbortController();
    const result = current.wake.dictate({ actor: 'owner', confirmed: true, signal: controller.signal });
    controller.abort();
    current.child().question('不应回填');
    expect(current.wake.snapshot()).toMatchObject({ state: 'stopping', microphoneActive: true });
    current.child().close();
    await expect(result).resolves.toMatchObject({ status: 'cancelled', microphoneActive: false });
    expect(current.onQuestion).not.toHaveBeenCalled();
  });

  it('expires silent dictation without resuming wake listening or retrying', async () => {
    vi.useFakeTimers();
    const current = setup({}, { dictationTimeoutMs: 1_000 });
    const result = current.wake.dictate({ actor: 'owner', confirmed: true });
    const rejected = expect(result).rejects.toThrow('wake_dictation_timeout');
    await vi.advanceTimersByTimeAsync(1_001);
    await rejected;
    expect(current.spawn).toHaveBeenCalledOnce();
    expect(current.wake.snapshot().microphoneActive).toBe(false);
  });

  it('fails closed when dictation grammar is unavailable or output exceeds its limit', async () => {
    const missing = setup({ dictationAvailable: false });
    await expect(missing.wake.dictate({ actor: 'owner', confirmed: true })).rejects.toThrow('wake_dictation_unavailable');
    const oversized = setup();
    const result = oversized.wake.dictate({ actor: 'owner', confirmed: true });
    oversized.child().question('字'.repeat(501));
    await expect(result).rejects.toThrow('wake_question_limit');
    expect(oversized.onQuestion).not.toHaveBeenCalled();
  });

  it('cannot compete with an existing wake process and can be cancelled during startup', async () => {
    const listening = setup();
    await listening.enable();
    await expect(listening.wake.dictate({ actor: 'owner', confirmed: true })).rejects.toThrow('busy');
    expect(listening.spawn).toHaveBeenCalledOnce();
    const starting = setup({ autoReady: false });
    const result = starting.wake.dictate({ actor: 'owner', confirmed: true });
    await starting.wake.disable();
    await expect(result).resolves.toMatchObject({ status: 'cancelled' });
  });
});

describe('local recognizer probe never opens the microphone', () => {
  it('returns local installed capabilities and remains disabled', async () => {
    const { wake, child, onWake, onQuestion } = setup();
    expect(await wake.probe()).toEqual({ status: 'complete', recognizers: [{ culture: 'zh-CN', name: 'Local recognizer', id: 'local-zh' }], dictationAvailable: true, microphoneOpened: false, localOnly: true });
    expect(child().commands).toHaveLength(1);
    expect(child().commands[0]).toMatchObject({ op: 'probe' });
    expect(child().commands[0]).not.toHaveProperty('confirmed');
    expect(child().stdin.writableEnded).toBe(true);
    expect(child().isClosed).toBe(true);
    expect(wake.snapshot()).toMatchObject({ state: 'disabled', enabled: false, microphoneActive: false });
    expect(onWake).not.toHaveBeenCalled();
    expect(onQuestion).not.toHaveBeenCalled();
  });

  it('waits for actual probe exit and rejects overlapping workers', async () => {
    const { wake, enable, child, spawn } = setup({ closeProbe: false });
    let finished = false;
    const result = wake.probe().then(value => { finished = true; return value; });
    await Promise.resolve();
    expect(finished).toBe(false);
    await expect(enable()).rejects.toMatchObject({ code: 'busy' });
    expect(await wake.probe()).toMatchObject({ reason: 'busy' });
    expect(wake.snapshot().microphoneActive).toBe(false);
    child().close();
    expect(await result).toMatchObject({ status: 'complete' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('exposes no-dictation support without fabricating a question', async () => {
    const { wake } = setup({ dictationAvailable: false });
    expect(await wake.probe()).toMatchObject({ status: 'complete', dictationAvailable: false, dictationReason: 'wake_dictation_unavailable' });
  });

  it.each(['wake_zh_cn_recognizer_unavailable', 'wake_speech_assembly_unavailable', 'wake_powershell_version_unavailable'])('preserves a specific local unavailable reason: %s', async reason => {
    const { wake } = setup({ probeEvent: { kind: 'error', reason } });
    expect(await wake.probe()).toEqual({ status: 'unavailable', reason });
  });

  it.each([
    { kind: 'probe', status: 'complete', recognizers: [], dictationAvailable: true },
    { kind: 'probe', status: 'complete', recognizers: [{ culture: 'en-US', name: 'English', id: 'en' }], dictationAvailable: true }
  ])('does not call an absent zh-CN engine supported: %j', async probeEvent => {
    const { wake } = setup({ probeEvent });
    expect(await wake.probe()).toEqual({ status: 'unavailable', reason: 'wake_zh_cn_recognizer_unavailable' });
  });

  it.each([
    { kind: 'probe', status: 'complete', recognizers: null, dictationAvailable: true },
    { kind: 'probe', status: 'complete', recognizers: [{ culture: 'zh-CN', name: '', id: 'zh' }], dictationAvailable: true },
    { kind: 'probe', status: 'complete', recognizers: [], dictationAvailable: 'yes' },
    { kind: 'ready', dictationAvailable: true }
  ])('rejects malformed probe capabilities: %j', async probeEvent => {
    const { wake } = setup({ probeEvent });
    expect(await wake.probe()).toEqual({ status: 'unavailable', reason: 'wake_probe_output_invalid' });
  });

  it('rejects a trailing incomplete UTF-8 sequence even after a valid probe', async () => {
    const { wake, child } = setup({ closeProbe: false });
    const result = wake.probe();
    child().stdout.write(Buffer.from([0xe4, 0xb8]));
    child().close();
    expect(await result).toEqual({ status: 'unavailable', reason: 'wake_output_invalid' });
  });

  it('cancels a probe and waits for the actual process close', async () => {
    const controller = new AbortController();
    const { wake, child } = setup({ closeProbe: false, closeOnKill: false });
    const result = wake.probe({ signal: controller.signal });
    controller.abort();
    expect(child().kill).toHaveBeenCalledTimes(1);
    expect(wake.snapshot().microphoneActive).toBe(false);
    child().close();
    expect(await result).toEqual({ status: 'unavailable', reason: 'aborted' });
  });
});

describe('strict wake grammar and one local question', () => {
  it.each(['暖伴', '暖伴暖伴', '小暖'])('accepts only the exact local wake phrase %s', async phrase => {
    const { enable, child, onWake, onQuestion, wake } = setup();
    await enable();
    child().packet({ kind: 'wake', phrase });
    expect(onWake).toHaveBeenCalledWith({ localOnly: true, generation: 1, dictationAvailable: true });
    expect(wake.snapshot().state).toBe('question');
    expect(child().commands.at(-1)).toMatchObject({ op: 'mode', mode: 'question', questionId: expect.any(String) });
    expect(onQuestion).not.toHaveBeenCalled();
  });

  it.each(['暖伴请帮忙', 'hello', ' 暖伴', '小暖小暖', 'NUANBAN', ''])('ignores non-grammar phrase %j', async phrase => {
    const { enable, child, onWake, wake } = setup();
    await enable();
    child().packet({ kind: 'wake', phrase });
    expect(onWake).not.toHaveBeenCalled();
    expect(wake.snapshot().state).toBe('listening');
    expect(child().commands).toHaveLength(1);
  });

  it('ignores question text before wake and outside the current question round', async () => {
    const { enable, child, onQuestion, wake } = setup();
    await enable();
    child().question('unrequested text', 'absent-round');
    expect(onQuestion).not.toHaveBeenCalled();
    expect(wake.snapshot().state).toBe('listening');
  });

  it('reports wake only when local dictation is unavailable', async () => {
    const { enable, child, onWake, onQuestion, wake } = setup({ dictationAvailable: false });
    await enable();
    child().packet({ kind: 'wake', phrase: '暖伴' });
    child().question('must not escape', 'absent-round');
    expect(onWake).toHaveBeenCalledWith(expect.objectContaining({ dictationAvailable: false }));
    expect(onQuestion).not.toHaveBeenCalled();
    expect(wake.snapshot().state).toBe('listening');
    expect(child().commands).toHaveLength(1);
  });

  it('returns one bounded question and immediately returns to wake grammar', async () => {
    const { enable, child, onQuestion, onWake, wake } = setup();
    await enable();
    child().packet({ kind: 'wake', phrase: '小暖' });
    child().packet({ kind: 'wake', phrase: '暖伴' });
    const questionId = child().commands.at(-1)!.questionId;
    child().question(` ${'字'.repeat(498)} `, questionId);
    child().question('duplicate', questionId);
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onQuestion).toHaveBeenCalledExactlyOnceWith('字'.repeat(498));
    expect(wake.snapshot().state).toBe('listening');
    expect(child().commands.at(-1)).toMatchObject({ op: 'mode', mode: 'wake' });
    expect(child().commands.every(command => !('text' in command))).toBe(true);
  });

  it('accepts a question exactly 500 UTF-16 units long', async () => {
    const { enable, child, onQuestion } = setup();
    await enable();
    child().packet({ kind: 'wake', phrase: '暖伴' });
    child().question('字'.repeat(500));
    expect(onQuestion).toHaveBeenCalledExactlyOnceWith('字'.repeat(500));
  });

  it('rejects an overlong question rather than passing an unbounded payload', async () => {
    const { enable, child, onQuestion, wake } = setup({ closeOnKill: false });
    await enable();
    child().packet({ kind: 'wake', phrase: '暖伴' });
    child().question('字'.repeat(501));
    expect(onQuestion).not.toHaveBeenCalled();
    expect(wake.snapshot()).toMatchObject({ state: 'error', reason: 'wake_question_limit', enabled: true, microphoneActive: true });
    expect(child().kill).toHaveBeenCalledTimes(1);
  });

  it('returns to strict wake grammar on timeout without inventing text', async () => {
    vi.useFakeTimers();
    const { enable, child, onQuestion, wake } = setup({}, { questionTimeoutMs: 1000 });
    await enable();
    child().packet({ kind: 'wake', phrase: '暖伴' });
    const questionId = child().commands.at(-1)!.questionId;
    await vi.advanceTimersByTimeAsync(1000);
    expect(wake.snapshot().state).toBe('listening');
    expect(child().commands.at(-1)).toMatchObject({ mode: 'wake' });
    child().question('late result', questionId);
    expect(onQuestion).not.toHaveBeenCalled();
  });

  it('rejects old question IDs after timeout and a fresh wake', async () => {
    vi.useFakeTimers();
    const { enable, child, onQuestion } = setup({}, { questionTimeoutMs: 1000 });
    await enable();
    child().packet({ kind: 'wake', phrase: '暖伴' });
    const oldId = child().commands.at(-1)!.questionId;
    await vi.advanceTimersByTimeAsync(1000);
    child().packet({ kind: 'wake', phrase: '小暖' });
    const nextId = child().commands.at(-1)!.questionId;
    expect(nextId).not.toBe(oldId);
    child().question('stale', oldId);
    child().question('current', nextId);
    expect(onQuestion).toHaveBeenCalledExactlyOnceWith('current');
  });

  it.each([{ token: 'another-worker' }, { generation: 9000 }])('ignores foreign identity: %j', async identity => {
    const { enable, child, onWake, onQuestion, wake } = setup();
    await enable();
    child().packet({ kind: 'wake', phrase: '暖伴', ...identity });
    child().packet({ kind: 'error', reason: 'wake_microphone_access_denied', ...identity });
    expect(onWake).not.toHaveBeenCalled();
    expect(onQuestion).not.toHaveBeenCalled();
    expect(wake.snapshot().state).toBe('listening');
  });

  it('ignores all old-worker and stopping-worker results', async () => {
    const { wake, enable, child, onQuestion, onWake } = setup({ closeOnStop: false, closeOnKill: false });
    await enable();
    const oldChild = child();
    oldChild.packet({ kind: 'wake', phrase: '暖伴' });
    const stop = wake.disable();
    oldChild.question('stale after stop');
    oldChild.close();
    await stop;
    await enable();
    oldChild.packet({ kind: 'wake', phrase: '暖伴' });
    oldChild.question('stale old worker');
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onQuestion).not.toHaveBeenCalled();
    expect(wake.snapshot().generation).toBeGreaterThan(1);
  });
});

describe('wake failure is bounded, local and never automatically reconnects', () => {
  it.each(['stdin', 'stdout', 'stderr'] as const)('handles %s pipe errors without leaking text or claiming a stopped microphone', async pipe => {
    const { wake, enable, child, onQuestion } = setup({ closeOnKill: false });
    await enable();
    child()[pipe].emit('error', new Error('private input or recognition detail'));
    expect(wake.snapshot()).toMatchObject({ state: 'error', reason: `wake_${pipe}_failed`, enabled: true, microphoneActive: true });
    expect(onQuestion).not.toHaveBeenCalled();
    expect(child().kill).toHaveBeenCalledTimes(1);
    child().close(1);
    expect(wake.snapshot()).toMatchObject({ enabled: false, microphoneActive: false });
  });

  it.each(['false', 'throws'])('keeps disable pending and retryable when process kill %s', async behavior => {
    const { wake, enable, child } = setup({ closeOnStop: false, closeOnKill: false });
    await enable();
    child().kill.mockImplementation(() => { if (behavior === 'throws') throw new Error('process error details'); return false; });
    const pending = wake.disable();
    expect(wake.disable()).toBe(pending);
    expect(wake.disable()).toBe(pending);
    expect(child().kill).toHaveBeenCalledTimes(2);
    expect(wake.snapshot()).toMatchObject({ state: 'stopping', enabled: true, microphoneActive: true });
    child().close();
    await pending;
    expect(wake.snapshot()).toMatchObject({ state: 'disabled', enabled: false, microphoneActive: false });
  });

  it.each(['wake_microphone_access_denied', 'wake_microphone_unavailable', 'wake_recognizer_unavailable', 'wake_recognition_unavailable', 'wake_recognition_stopped'])('stops on %s and remains active until real exit', async reason => {
    const { enable, child, wake, spawn } = setup({ closeOnKill: false });
    await enable();
    child().packet({ kind: 'error', reason });
    expect(wake.snapshot()).toMatchObject({ state: reason.includes('unavailable') ? 'unavailable' : 'error', reason, enabled: true, microphoneActive: true });
    await expect(enable()).rejects.toMatchObject({ code: 'busy' });
    expect(child().kill).toHaveBeenCalledTimes(1);
    child().close(2);
    expect(wake.snapshot()).toMatchObject({ reason, enabled: false, microphoneActive: false });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('rejects startup privacy denial only after actual process exit', async () => {
    const { enable, child, wake } = setup({ enableEvent: { kind: 'error', reason: 'wake_microphone_access_denied' }, closeOnKill: false });
    const rejected = expect(enable()).rejects.toMatchObject({ code: 'wake_microphone_access_denied' });
    expect(wake.snapshot()).toMatchObject({ state: 'error', enabled: true, microphoneActive: true });
    child().close(2);
    await rejected;
    expect(wake.snapshot().microphoneActive).toBe(false);
  });

  it('sanitizes arbitrary error details', async () => {
    const { enable, child, wake } = setup({ closeOnKill: false });
    await enable();
    child().packet({ kind: 'error', reason: 'private question / user path / microphone details' });
    expect(wake.snapshot().reason).toBe('wake_engine_failed');
    expect(JSON.stringify(wake.snapshot())).not.toContain('private question');
  });

  it('requires a new explicit owner action after an unexpected process exit', async () => {
    vi.useFakeTimers();
    const { enable, child, wake, spawn } = setup();
    await enable();
    child().close(1);
    expect(wake.snapshot()).toMatchObject({ state: 'error', reason: 'wake_engine_failed', enabled: false, microphoneActive: false });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(spawn).toHaveBeenCalledTimes(1);
    await enable();
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('does not treat an unexpected clean exit as disabled success', async () => {
    const { enable, child, wake } = setup();
    await enable();
    child().close(0);
    expect(wake.snapshot()).toMatchObject({ state: 'error', reason: 'wake_helper_exited', enabled: false, microphoneActive: false });
  });

  it('enforces startup timeout without retrying', async () => {
    vi.useFakeTimers();
    const { enable, child, wake, spawn } = setup({ autoReady: false }, { timeoutMs: 500 });
    const rejected = expect(enable()).rejects.toMatchObject({ code: 'wake_start_timeout' });
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(child().kill).toHaveBeenCalledTimes(1);
    expect(wake.snapshot().enabled).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('bounds probe startup time without opening a microphone', async () => {
    vi.useFakeTimers();
    const { wake, child } = setup({ autoProbe: false }, { timeoutMs: 500 });
    const result = wake.probe();
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toEqual({ status: 'unavailable', reason: 'wake_probe_timeout' });
    expect(child().commands).toHaveLength(1);
    expect(child().commands[0]!.op).toBe('probe');
    expect(wake.snapshot().microphoneActive).toBe(false);
  });

  it.each(['invalid-json', 'invalid-utf8', 'stdout-limit', 'stderr-limit', 'missing-ready', 'duplicate-ready', 'unexpected-kind'])('fails closed on %s', async scenario => {
    const { enable, child, wake, onQuestion } = setup({ closeOnKill: false, autoReady: scenario !== 'missing-ready' }, { maxOutputBytes: 2048 });
    const starting = enable();
    if (scenario === 'missing-ready') void starting.catch(() => {});
    else await starting;
    if (scenario === 'invalid-json') child().stdout.write('{invalid}\n');
    if (scenario === 'invalid-utf8') child().stdout.write(Buffer.from([0xff]));
    if (scenario === 'stdout-limit') child().stdout.write('x'.repeat(2049));
    if (scenario === 'stderr-limit') child().stderr.write('x'.repeat(8193));
    if (scenario === 'missing-ready') child().packet({ kind: 'wake', phrase: '暖伴' });
    if (scenario === 'duplicate-ready') child().packet({ kind: 'ready', dictationAvailable: true });
    if (scenario === 'unexpected-kind') child().packet({ kind: 'unexpected' });
    expect(wake.snapshot()).toMatchObject({ state: 'error', enabled: true, microphoneActive: true });
    expect(child().kill).toHaveBeenCalledTimes(1);
    child().packet({ kind: 'wake', phrase: '暖伴' });
    child().question('must not escape');
    expect(onQuestion).not.toHaveBeenCalled();
    child().close();
    if (scenario === 'missing-ready') await expect(starting).rejects.toMatchObject({ code: 'wake_protocol_invalid' });
  });

  it('accepts split UTF-8 packets without corrupting local Chinese text', async () => {
    const { enable, child, onWake } = setup();
    await enable();
    const request = child().commands[0]!;
    const packet = Buffer.from(`${JSON.stringify({ kind: 'wake', token: request.token, generation: request.generation, phrase: '暖伴' })}\n`);
    for (const byte of packet) child().stdout.write(Buffer.from([byte]));
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('cleans up spawn errors without exposing exception details', async () => {
    const spawn = vi.fn(() => { throw new Error('private executable details'); });
    const { wake, enable } = setup({}, { spawn: spawn as unknown as typeof nodeSpawn });
    await expect(enable()).rejects.toMatchObject({ code: 'wake_helper_spawn_unavailable' });
    expect(wake.snapshot()).toMatchObject({ state: 'unavailable', enabled: false, microphoneActive: false, reason: 'wake_helper_spawn_unavailable' });
    expect(await wake.probe()).toEqual({ status: 'unavailable', reason: 'wake_helper_spawn_unavailable' });
  });

  it('does not leak question text into state, commands, or console', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { enable, child, onState, onQuestion } = setup();
      await enable();
      child().packet({ kind: 'wake', phrase: '小暖' });
      child().question('private-local-question');
      expect(onQuestion).toHaveBeenCalledExactlyOnceWith('private-local-question');
      expect(JSON.stringify(onState.mock.calls)).not.toContain('private-local-question');
      expect(JSON.stringify(child().commands)).not.toContain('private-local-question');
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally { log.mockRestore(); error.mockRestore(); }
  });

  it('contains host callback failures without restarting the recognizer', async () => {
    const { enable, child, wake, spawn } = setup({}, { onState: () => { throw new Error('host callback'); }, onWake: () => { throw new Error('host callback'); }, onQuestion: async () => { throw new Error('host callback'); } });
    await enable();
    child().packet({ kind: 'wake', phrase: '小暖' });
    child().question('local question');
    await Promise.resolve();
    expect(wake.snapshot().state).toBe('listening');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('offline helper source boundaries', () => {
  it('has one microphone opening strictly after the probe-only branch and owner validation', () => {
    const helper = readFileSync('apps/desktop/wake/windows-local-wake.ps1', 'utf8');
    const microphone = helper.indexOf('$engine.SetInputToDefaultAudioDevice()');
    expect(helper.match(/SetInputToDefaultAudioDevice\(\)/g)).toHaveLength(1);
    expect(helper.indexOf("$request.actor -cne 'owner'")).toBeLessThan(microphone);
    expect(helper.indexOf("if ($request.op -eq 'probe')")).toBeLessThan(microphone);
    expect(helper.slice(helper.indexOf("if ($request.op -eq 'probe')"), microphone)).toContain('} else {');
    expect(helper).toContain('$engine.SetInputToNull()');
    expect(helper).toContain('InstalledRecognizers()');
  });

  it('uses strict local grammar, disabled dictation by default, and bounded event queues', () => {
    const helper = readFileSync('apps/desktop/wake/windows-local-wake.ps1', 'utf8');
    expect(helper).toContain('System.Speech.Recognition.SpeechRecognitionEngine');
    expect(helper).toContain("$grammar.Name = 'NuanbanLocalWake'");
    expect(helper).toContain('$dictation.Enabled = $false');
    expect(helper).toContain('$script:WakePhrases -ccontains $phrase');
    expect(helper).toContain('$recognition.Confidence -lt 0.65');
    expect(helper).toContain('$recognition.Confidence -lt 0.78');
    expect(helper).toContain("kind = 'uncertain'");
    expect(helper).toContain('function Complete-DirectDictation');
    expect(helper).toContain('[System.Speech.Recognition.RecognizeMode]::Single');
    expect(helper).toContain('$engine.EndSilenceTimeout');
    expect(helper).toContain('$queuedEvents.Count -gt 16');
    expect(helper).toContain('$text.Length -gt 500');
    expect(helper).toContain('[DateTime]::UtcNow -ge $script:QuestionDeadline');
    expect(helper).toContain('$engine.RecognizeAsyncCancel()');
    expect(helper).toContain('$engine.Dispose()');
    expect(helper).toContain('$inputStream.BeginRead(');
    expect(helper).not.toContain('ReadLineAsync');
    expect(/[^\x00-\x7f]/.test(helper)).toBe(false);
  });

  it('has no audio export, disk writes, network clients, user-text logging, or auto-restart', () => {
    const helper = readFileSync('apps/desktop/wake/windows-local-wake.ps1', 'utf8');
    const adapter = readFileSync('apps/desktop/wake/windows-local-wake.cjs', 'utf8');
    expect(helper).not.toMatch(/Result\.Audio|WriteToWave|SetInputToWave|FileStream|WriteAll|Out-File|Add-Content|Set-Content|Start-Transcript|Invoke-WebRequest|Invoke-RestMethod|HttpClient|WebClient|SpeechSDK|Start-Process|Write-Host|Write-Output/);
    expect(adapter).not.toMatch(/console\.|node:https|node:http|node:fs|fetch\(|WebSocket|setInterval/);
    expect(helper.match(/RecognizeAsync\(/g)).toHaveLength(2);
    expect(helper.match(/SetInputToDefaultAudioDevice\(\)/g)).toHaveLength(1);
    expect(helper).toContain("$request.mode -eq 'dictation'");
    expect(adapter.match(/const child = spawn\(/g)).toHaveLength(1);
  });
});

describe('Windows local wake owner and process boundaries', () => {
  it('is disabled by default without spawning a process or opening a microphone', () => {
    const { wake, spawn, onState } = setup();
    expect(wake.snapshot()).toEqual({ state: 'disabled', enabled: false, microphoneActive: false, generation: 0, localOnly: true, dictationAvailable: false });
    expect(spawn).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(wake.snapshot())).toBe(true);
  });

  it.each([{}, { actor: 'guest', confirmed: true }, { actor: 'owner', confirmed: false }, { actor: 'owner', confirmed: 'true' }])('requires explicit owner confirmation: %j', async request => {
    const { wake, spawn } = setup();
    await expect(wake.enable(request as Parameters<Wake['enable']>[0])).rejects.toMatchObject({ code: 'owner_confirmation_required' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not spawn for a pre-aborted owner request or probe', async () => {
    const { wake, spawn } = setup();
    const signal = AbortSignal.abort();
    await expect(wake.enable({ actor: 'owner', confirmed: true, signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(await wake.probe({ signal })).toMatchObject({ status: 'unavailable', reason: 'aborted' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports unsupported platforms without spawning a worker', async () => {
    const { wake, spawn, enable } = setup({}, { platform: 'linux' });
    expect(await wake.probe()).toEqual({ status: 'unavailable', reason: 'windows_speech_unavailable' });
    await expect(enable()).rejects.toMatchObject({ code: 'windows_speech_unavailable' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([{ timeoutMs: 499 }, { timeoutMs: 60_001 }, { timeoutMs: NaN }, { questionTimeoutMs: 999 }, { questionTimeoutMs: 30_001 }, { maxOutputBytes: 255 }, { maxOutputBytes: 262_145 }, { maxOutputBytes: 500.5 }])('rejects invalid bounds: %j', options => {
    expect(() => createWindowsLocalWake(options)).toThrow('wake_limits_invalid');
  });

  it('starts a hidden local PowerShell process with pipes and no shell', async () => {
    const { spawn, enable, child } = setup();
    expect(await enable()).toMatchObject({ state: 'listening', enabled: true, microphoneActive: true });
    const [executable, arguments_, options] = spawn.mock.calls[0]!;
    expect(executable).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    expect(arguments_).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File']));
    expect(arguments_.at(-1)).toMatch(/wake[\\/]windows-local-wake\.ps1$/);
    expect(options).toEqual({ windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(child().commands[0]).toMatchObject({ op: 'enable', actor: 'owner', confirmed: true, questionTimeoutMs: 8000, generation: 1, token: expect.any(String) });
  });

  it('allows only one process across probe and enable', async () => {
    const { wake, enable, spawn } = setup();
    await enable();
    await expect(enable()).rejects.toMatchObject({ code: 'busy' });
    expect(await wake.probe()).toEqual({ status: 'unavailable', reason: 'busy' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('keeps startup conservatively active until the worker actually closes', async () => {
    const { wake, enable, child } = setup({ autoReady: false, closeOnStop: false, closeOnKill: false });
    const rejected = expect(enable()).rejects.toMatchObject({ code: 'aborted' });
    expect(wake.snapshot()).toMatchObject({ state: 'starting', enabled: true, microphoneActive: true });
    const stopped = wake.disable();
    expect(wake.snapshot()).toMatchObject({ state: 'stopping', enabled: true, microphoneActive: true });
    child().close();
    await stopped;
    await rejected;
    expect(wake.snapshot()).toMatchObject({ state: 'disabled', enabled: false, microphoneActive: false });
  });

  it('shares disable waiting and retries kill without falsely reporting exit', async () => {
    const { wake, enable, child, spawn } = setup({ closeOnStop: false, closeOnKill: false });
    await enable();
    let finished = false;
    const first = wake.disable();
    void first.then(() => { finished = true; });
    expect(wake.disable()).toBe(first);
    expect(child().kill).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(wake.snapshot()).toMatchObject({ state: 'stopping', enabled: true, microphoneActive: true });
    await expect(enable()).rejects.toMatchObject({ code: 'busy' });
    child().packet({ kind: 'ready', dictationAvailable: true });
    child().close();
    await first;
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(wake.snapshot()).toMatchObject({ state: 'disabled', enabled: false, microphoneActive: false });
    await expect(wake.disable()).resolves.toMatchObject({ state: 'disabled' });
  });

  it('kills a worker that ignores graceful stop after the fixed grace period', async () => {
    vi.useFakeTimers();
    const { wake, enable, child } = setup({ closeOnStop: false });
    await enable();
    const stopped = wake.disable();
    await vi.advanceTimersByTimeAsync(499);
    expect(child().kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(child().kill).toHaveBeenCalledTimes(1);
    expect(wake.snapshot().microphoneActive).toBe(false);
  });

  it('keeps an aborted lifetime signal effective after startup', async () => {
    const controller = new AbortController();
    const { wake, child } = setup({ closeOnStop: false, closeOnKill: false });
    await wake.enable({ actor: 'owner', confirmed: true, signal: controller.signal });
    controller.abort();
    expect(wake.snapshot()).toMatchObject({ state: 'stopping', enabled: true, microphoneActive: true });
    child().close();
    await wake.disable();
    expect(wake.snapshot().enabled).toBe(false);
  });

  it.each(['starting', 'listening'])('cannot enable if a %s callback revokes consent', async phase => {
    let current: Wake | undefined;
    const context = setup({}, { onState: value => { if (value.state === phase) void current!.disable(); } });
    current = context.wake;
    await expect(context.enable()).rejects.toMatchObject({ code: 'aborted' });
    expect(context.spawn).toHaveBeenCalledTimes(phase === 'starting' ? 0 : 1);
    expect(context.wake.snapshot().enabled).toBe(false);
  });
});

describe('C2 advisory microphone signal reporting', () => {
  it('surfaces the latest level and problem without changing the running state', async () => {
    const current = setup();
    await current.enable();
    expect(current.wake.snapshot().signal).toBeUndefined();
    current.child().packet({ kind: 'signal', level: 31, problem: 'TooSoft' });
    expect(current.wake.snapshot()).toMatchObject({ state: 'listening', enabled: true, microphoneActive: true, signal: { level: 31, problem: 'TooSoft' } });
    current.child().packet({ kind: 'signal', level: 64, problem: 'none' });
    expect(current.wake.snapshot()).toMatchObject({ state: 'listening', microphoneActive: true, signal: { level: 64, problem: 'none' } });
    expect(current.wake.snapshot().reason).toBeUndefined();
  });

  it.each([
    ['level above range', { kind: 'signal', level: 101, problem: 'none' }],
    ['negative level', { kind: 'signal', level: -1, problem: 'none' }],
    ['fractional level', { kind: 'signal', level: 12.5, problem: 'none' }],
    ['unknown problem', { kind: 'signal', level: 20, problem: 'TooQuiet' }],
    ['missing problem', { kind: 'signal', level: 20 }],
    ['missing level', { kind: 'signal', problem: 'none' }],
    ['non-object payload', { kind: 'signal', level: '20', problem: 'none' }],
  ])('ignores a malformed signal (%s) and keeps the operation healthy', async (_label, payload) => {
    const current = setup();
    await current.enable();
    current.child().packet(payload);
    expect(current.wake.snapshot()).toMatchObject({ state: 'listening', microphoneActive: true });
    expect(current.wake.snapshot().signal).toBeUndefined();
    expect(current.onState).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'error' }));
    expect(current.wake.snapshot().enabled).toBe(true);
  });

  it('keeps a dictation transcript authoritative while signal events arrive', async () => {
    const current = setup({ closeOnStop: false, closeOnKill: false });
    const result = current.wake.dictate({ actor: 'owner', confirmed: true });
    current.child().packet({ kind: 'signal', level: 8, problem: 'TooNoisy' });
    expect(current.wake.snapshot()).toMatchObject({ state: 'question', signal: { level: 8, problem: 'TooNoisy' } });
    current.child().question('把字体调大');
    current.child().close();
    await expect(result).resolves.toMatchObject({ status: 'complete', text: '把字体调大' });
  });

  it('emits the advisory signal from the polling loop and never from an audio callback', () => {
    const helper = readFileSync('apps/desktop/wake/windows-local-wake.ps1', 'utf8');
    const loop = helper.slice(helper.indexOf('while ($running)'), helper.indexOf('Start-Sleep -Milliseconds 20'));
    expect(helper).toContain('add_AudioLevelUpdated');
    expect(helper).toContain('add_AudioSignalProblemOccurred');
    expect(loop).toContain("kind = 'signal'");
    // audio callbacks may only record state; writing protocol lines from them would interleave stdout
    for (const match of helper.matchAll(/add_Audio(?:LevelUpdated|SignalProblemOccurred)\(\{([^}]*)\}/g)) {
      expect(match[1]).not.toContain('Write-ProtocolEvent');
    }
    expect(loop).toContain('$script:SignalNextEmitAt');
  });
});
