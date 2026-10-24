import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCloudDictationSettings } from '../../apps/desktop/voice/cloud-dictation-settings.cjs';
import { createCloudRecorder } from '../../apps/desktop/voice/cloud-recorder.cjs';

const scratch = mkdtempSync(join(tmpdir(), 'nuanban-cloud-voice-'));
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); mkdirSync(scratch, { recursive: true }); });

function wavBytes(size = 256) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.write('WAVE', 8, 'ascii');
  return Buffer.concat([header, Buffer.alloc(size - 44, 3)]);
}

type Plan = (child: FakeChild, args: string[]) => void;

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill = vi.fn(() => { this.killed = true; queueMicrotask(() => this.emit('close', 1)); return true; });
  constructor(readonly plan: Plan) { super(); }
}

function recorderFixture(plan: Plan, options: Record<string, unknown> = {}) {
  const children: Array<{ child: FakeChild; command: string; args: string[] }> = [];
  const scriptPath = join(scratch, 'windows-cloud-dictation.ps1');
  const naudio = join(scratch, 'NAudio.dll');
  writeFileSync(scriptPath, '# helper');
  writeFileSync(naudio, 'dll');
  const spawn = vi.fn((...callArguments: unknown[]) => {
    const command = String(callArguments[0]);
    const args = (callArguments[1] ?? []) as string[];
    const child = new FakeChild(plan);
    children.push({ child, command, args });
    queueMicrotask(() => plan(child, args));
    return child;
  });
  const recorder = createCloudRecorder({ spawn: spawn as unknown as typeof import('node:child_process').spawn, scriptPath, platform: 'win32', timeoutMs: 5_000, ...options });
  return { recorder, spawn, children, scriptPath, naudio };
}

describe('云端听写录音器（助手只录音，绝不联网）', () => {
  it('按协议读取录音结果并把归一化后的 WAV 交给调用方，随后删除临时文件', async () => {
    const target = join(scratch, 'utterance.wav');
    const normalised = `${target}.normalised.wav`;
    const fixture = recorderFixture((child) => {
      child.stdout.write('{"kind":"ready"}\n');
      writeFileSync(normalised, wavBytes());
      child.stdout.write(`${JSON.stringify({ kind: 'recorded', detail: { path: normalised, seconds: 3.2, peak: 0.04, gain: 20 } })}\n`);
      child.emit('close', 0);
    });
    const result = await fixture.recorder.record({ outFile: target });
    expect(result.wav.length).toBe(256);
    expect(result).toMatchObject({ seconds: 3.2, peak: 0.04, gain: 20 });
    expect(existsSync(normalised)).toBe(false);
    const { command, args } = fixture.children[0];
    expect(command).toContain('powershell');
    expect(args.join(' ')).toContain('windows-cloud-dictation.ps1');
    expect(args.join(' ')).toContain('NAudio.dll');
    expect(args.join(' ')).toContain('-OutFile');
    expect(fixture.spawn).toHaveBeenCalledOnce();
  });

  it('把助手的错误事件映射为安全错误码', async () => {
    for (const [reason, code] of [['cloud_dictation_no_speech', 'cloud_dictation_no_speech'],
      ['cloud_dictation_failed', 'cloud_dictation_failed'], ['cloud_dictation_naudio_missing', 'cloud_dictation_naudio_missing']] as const) {
      const fixture = recorderFixture((child) => { child.stdout.write(`${JSON.stringify({ kind: 'error', reason })}\n`); child.emit('close', 2); });
      await expect(fixture.recorder.record({ outFile: join(scratch, `${code}.wav`) })).rejects.toMatchObject({ code });
    }
  });

  it('未识别的错误原因回落到通用失败码，异常协议行被忽略', async () => {
    const fixture = recorderFixture((child) => {
      child.stdout.write('not json\n');
      child.stdout.write(`${JSON.stringify({ kind: 'error', reason: 'cloud_dictation_wat' })}\n`);
      child.emit('close', 2);
    });
    await expect(fixture.recorder.record({ outFile: join(scratch, 'odd.wav') })).rejects.toMatchObject({ code: 'cloud_dictation_failed' });
  });

  it('超时与取消都会结束助手进程', async () => {
    // A clean exit without a recorded event means the helper broke protocol, not that the user stayed silent.
    const silent = recorderFixture(() => {});
    const quiet = silent.recorder.record({ outFile: join(scratch, 'quiet.wav') });
    silent.children[0].child.emit('close', 0);
    await expect(quiet).rejects.toMatchObject({ code: 'cloud_dictation_failed' });
    expect(silent.children[0].child.kill).not.toHaveBeenCalled();

    const hanging = recorderFixture(() => {});
    const controller = new AbortController();
    const pending = hanging.recorder.record({ outFile: join(scratch, 'cancel.wav'), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cloud_dictation_unavailable' });
    expect(hanging.children[0].child.kill).toHaveBeenCalled();
  });

  it('非 Windows 平台明确不可用，脚本路径非法时拒绝构造', () => {
    const other = createCloudRecorder({ platform: 'darwin', scriptPath: join(scratch, 'x.ps1') });
    expect(other.available).toBe(false);
    expect(() => createCloudRecorder({ scriptPath: join(scratch, 'helper.txt'), platform: 'win32' })).toThrow();
    expect(() => createCloudRecorder({ scriptPath: join(scratch, 'x.ps1'), platform: 'win32', maxSeconds: 99 })).toThrow();
  });
});

describe('云端听写开关（默认关闭，不保存音频）', () => {
  it('缺省关闭，写入后可读回', () => {
    const store = createCloudDictationSettings({ userDataPath: scratch });
    expect(store.read()).toEqual({ enabled: false });
    expect(store.write({ enabled: true })).toEqual({ enabled: true });
    expect(store.read()).toEqual({ enabled: true });
    expect(store.write({ enabled: false })).toEqual({ enabled: false });
    expect(store.read()).toEqual({ enabled: false });
    const raw = readFileSync(store.filePath, 'utf8');
    expect(raw).not.toContain('wav');
    expect(JSON.parse(raw)).toMatchObject({ version: 1, enabled: false });
  });

  it('损坏或非布尔内容一律视为关闭', () => {
    const store = createCloudDictationSettings({ userDataPath: scratch });
    writeFileSync(store.filePath, '{ not json');
    expect(store.read()).toEqual({ enabled: false });
    writeFileSync(store.filePath, JSON.stringify({ enabled: 'yes' }));
    expect(store.read()).toEqual({ enabled: false });
    expect(() => store.write({ enabled: 'yes' } as never)).toThrow();
    expect(() => createCloudDictationSettings({ userDataPath: 'relative' })).toThrow();
  });
});