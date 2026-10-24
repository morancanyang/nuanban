import { describe, expect, it } from 'vitest';
import { speechAvailable } from '../../apps/web/src/components';
import { checkedDictationResult, checkedVoiceSignal, checkedVoiceStatus, micSignalHint } from '../../apps/web/src/local-voice';

describe('语音播放能力边界', () => {
  it('只把存在 speechSynthesis 的环境视为可播放', () => {
    expect(speechAvailable({ speechSynthesis: {} as SpeechSynthesis })).toBe(true);
    expect(speechAvailable({ speechSynthesis: undefined as never })).toBe(false);
    expect(speechAvailable(undefined)).toBe(false);
  });
});

describe('本地听写结果边界（低置信度不执行）', () => {
  it('低置信度 uncertain 只允许提示重说，不携带文本、麦克风必须已关闭', () => {
    const result = checkedDictationResult({ status: 'uncertain', localOnly: true, microphoneActive: false });
    expect(result).toEqual({ status: 'uncertain', localOnly: true, microphoneActive: false });
    expect(() => checkedDictationResult({ status: 'uncertain', localOnly: true, microphoneActive: true })).toThrow();
    expect(() => checkedDictationResult({ status: 'uncertain', localOnly: false, microphoneActive: false })).toThrow();
    expect(checkedDictationResult({ status: 'uncertain', localOnly: true, microphoneActive: false, text: '猜测文字' })).toEqual({
      status: 'uncertain', localOnly: true, microphoneActive: false,
    });
  });

  it('complete 必须带 1～500 字文本且 localOnly/microphoneActive 严格一致', () => {
    expect(checkedDictationResult({ status: 'complete', text: '把手机字体调大', localOnly: true, microphoneActive: false })).toEqual({
      status: 'complete', text: '把手机字体调大', localOnly: true, microphoneActive: false,
    });
    expect(() => checkedDictationResult({ status: 'complete', text: '', localOnly: true, microphoneActive: false })).toThrow();
    expect(() => checkedDictationResult({ status: 'complete', text: 'x'.repeat(501), localOnly: true, microphoneActive: false })).toThrow();
    expect(() => checkedDictationResult({ status: 'complete', text: '文字', localOnly: true, microphoneActive: true })).toThrow();
    expect(() => checkedDictationResult({ status: 'complete', text: '文字', localOnly: false, microphoneActive: false })).toThrow();
  });

  it('cancelled 只允许 localOnly 结果，不携带文本', () => {
    expect(checkedDictationResult({ status: 'cancelled', localOnly: true })).toEqual({ status: 'cancelled', localOnly: true });
    expect(() => checkedDictationResult({ status: 'cancelled', localOnly: false })).toThrow();
  });

  it('云端 complete 只在 recognition=cloud 且麦克风已关闭时接受，文本仍限 1～500 字', () => {
    const cloud = { status: 'complete', text: '把手机字体调大', localOnly: false, recognition: 'cloud', microphoneActive: false } as const;
    expect(checkedDictationResult(cloud)).toEqual(cloud);
    expect(checkedDictationResult({ ...cloud, text: '  把手机字体调大  ', audio: 'discard' })).toEqual(cloud);
    expect(() => checkedDictationResult({ ...cloud, text: ' ' })).toThrow();
    expect(() => checkedDictationResult({ ...cloud, text: 'x'.repeat(501) })).toThrow();
    expect(() => checkedDictationResult({ ...cloud, microphoneActive: true })).toThrow();
  });

  it('任何其它 localOnly:false 一律拒绝（fail-closed）', () => {
    const cloud = { status: 'complete', text: '文字', localOnly: false, recognition: 'cloud', microphoneActive: false } as const;
    for (const invalid of [
      { ...cloud, recognition: undefined },
      { ...cloud, recognition: 'local' },
      { ...cloud, status: 'uncertain' },
      { ...cloud, status: 'cancelled' },
      { status: 'uncertain', localOnly: false, microphoneActive: false },
      { status: 'cancelled', localOnly: false },
      { ...cloud, localOnly: true },
    ]) expect(() => checkedDictationResult(invalid)).toThrow();
  });

  it('本机变体可携带 recognition=local，但不得谎报云端', () => {
    expect(checkedDictationResult({ status: 'complete', text: '文字', localOnly: true, microphoneActive: false, recognition: 'local' }))
      .toEqual({ status: 'complete', text: '文字', localOnly: true, microphoneActive: false, recognition: 'local' });
    expect(checkedDictationResult({ status: 'uncertain', localOnly: true, microphoneActive: false, recognition: 'local' }))
      .toEqual({ status: 'uncertain', localOnly: true, microphoneActive: false, recognition: 'local' });
    expect(checkedDictationResult({ status: 'cancelled', localOnly: true, recognition: 'local' }))
      .toEqual({ status: 'cancelled', localOnly: true });
    expect(() => checkedDictationResult({ status: 'complete', text: '文字', localOnly: true, microphoneActive: false, recognition: 'cloud' })).toThrow();
    expect(() => checkedDictationResult({ status: 'cancelled', localOnly: true, recognition: 'cloud' })).toThrow();
  });

  it('状态契约要求 localOnly=true，disabled 时不得声称麦克风开启', () => {
    const status = { phase: 'disabled', enabled: false, microphoneActive: false, dictationAvailable: true, localOnly: true, message: '未开启' };
    expect(checkedVoiceStatus(status)).toEqual(status);
    expect(() => checkedVoiceStatus({ ...status, localOnly: false })).toThrow();
    expect(() => checkedVoiceStatus({ ...status, enabled: true })).toThrow();
    expect(() => checkedVoiceStatus({ ...status, phase: 'unavailable', message: '本机没有可用的离线中文语音识别，未开启麦克风。' })).not.toThrow();
  });

  it('cloudDictation 缺省合法，出现时 enabled/available 必须是布尔', () => {
    const status = { phase: 'disabled', enabled: false, microphoneActive: false, dictationAvailable: true, localOnly: true, message: '未开启' };
    expect(checkedVoiceStatus(status)).toEqual(status);
    expect(checkedVoiceStatus({ ...status, cloudDictation: undefined })).toEqual(status);
    expect(checkedVoiceStatus({ ...status, cloudDictation: { enabled: false, available: false } }))
      .toEqual({ ...status, cloudDictation: { enabled: false, available: false } });
    expect(checkedVoiceStatus({ ...status, cloudDictation: { enabled: true, available: true }, transcript: 'do not project' }))
      .toMatchObject({ cloudDictation: { enabled: true, available: true } });
    for (const cloudDictation of [null, {}, { enabled: false }, { available: true }, { enabled: 'false', available: true },
      { enabled: true, available: 'yes' }, 'cloud', 1, []]) {
      expect(() => checkedVoiceStatus({ ...status, cloudDictation })).toThrow('未确认');
    }
  });
});

describe('麦克风信号提示（只提示原因，不改变判定策略）', () => {
  const listening = { phase: 'listening', enabled: true, microphoneActive: true, dictationAvailable: true, localOnly: true, message: '正在本机听写' } as const;

  it('接受合法信号快照，缺省时保持无信号', () => {
    expect(checkedVoiceSignal(undefined)).toBeUndefined();
    expect(checkedVoiceStatus(listening).signal).toBeUndefined();
    expect(checkedVoiceStatus({ ...listening, signal: { level: 31, problem: 'TooSoft' } })).toMatchObject({ signal: { level: 31, problem: 'TooSoft' } });
    expect(checkedVoiceStatus({ ...listening, signal: { level: 0, problem: 'none' } })).toMatchObject({ signal: { level: 0, problem: 'none' } });
  });

  it('拒绝越界电平、未知问题与非对象信号', () => {
    for (const signal of [{ level: 101, problem: 'none' }, { level: -1, problem: 'none' }, { level: 12.5, problem: 'none' },
      { level: 20, problem: 'Loud' }, { level: 20 }, { problem: 'none' }, 'loud', 42]) {
      expect(() => checkedVoiceStatus({ ...listening, signal })).toThrow();
    }
  });

  it('把信号问题映射成可操作提示，且不声称已识别成功', () => {
    expect(micSignalHint({ level: 31, problem: 'TooSoft' })).toContain('靠近麦克风');
    expect(micSignalHint({ level: 5, problem: 'none' })).toContain('信号过弱');
    expect(micSignalHint({ level: 80, problem: 'TooNoisy' })).toContain('噪声');
    expect(micSignalHint({ level: 80, problem: 'TooSlow' })).toContain('连贯');
    expect(micSignalHint({ level: 90, problem: 'TooLoud' })).toContain('失真');
    expect(micSignalHint({ level: 0, problem: 'NoSignal' })).toContain('没有收到任何声音');
    expect(micSignalHint({ level: 60, problem: 'none' })).toContain('电平 60/100');
    expect(micSignalHint(undefined)).toContain('正在读取');
    for (const hint of [micSignalHint({ level: 31, problem: 'TooSoft' }), micSignalHint({ level: 60, problem: 'none' })]) {
      expect(hint).not.toContain('已识别');
    }
  });
});
