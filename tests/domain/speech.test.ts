import { describe, expect, it } from 'vitest';
import { speechAvailable } from '../../apps/web/src/components';
import { checkedDictationResult, checkedVoiceStatus } from '../../apps/web/src/local-voice';

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

  it('状态契约要求 localOnly=true，disabled 时不得声称麦克风开启', () => {
    const status = { phase: 'disabled', enabled: false, microphoneActive: false, dictationAvailable: true, localOnly: true, message: '未开启' };
    expect(checkedVoiceStatus(status)).toEqual(status);
    expect(() => checkedVoiceStatus({ ...status, localOnly: false })).toThrow();
    expect(() => checkedVoiceStatus({ ...status, enabled: true })).toThrow();
    expect(() => checkedVoiceStatus({ ...status, phase: 'unavailable', message: '本机没有可用的离线中文语音识别，未开启麦克风。' })).not.toThrow();
  });
});
