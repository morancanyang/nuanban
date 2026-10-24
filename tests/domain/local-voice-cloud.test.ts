import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkedCloudDictationToggle, checkedDictationResult, checkedVoiceStatus, cloudDictationHint,
  cloudDictationState, dictationPathNotice, type LocalVoiceStatus } from '../../apps/web/src/local-voice';

const cloudComplete = { status: 'complete', text: '帮我看看药盒上的字', localOnly: false, recognition: 'cloud', microphoneActive: false } as const;
const localComplete = { status: 'complete', text: '帮我看看药盒上的字', localOnly: true, microphoneActive: false } as const;
const disabled = { phase: 'disabled', enabled: false, microphoneActive: false, dictationAvailable: true, localOnly: true, message: '本地语音未开启' };

describe('云端听写路径提示（必须说清音频去向）', () => {
  it('云端结果说明已上传且本机未保存，本机结果说明未上传', () => {
    expect(dictationPathNotice(checkedDictationResult(cloudComplete))).toBe('本次由云端识别，音频已上传且未在本机保存。');
    expect(dictationPathNotice(checkedDictationResult(localComplete))).toBe('本次由本机离线识别，音频未上传。');
    expect(dictationPathNotice(checkedDictationResult({ status: 'uncertain', localOnly: true, microphoneActive: false })))
      .toBe('本次由本机离线识别，音频未上传。');
    expect(dictationPathNotice(checkedDictationResult({ status: 'cancelled', localOnly: true }))).not.toContain('已上传');
  });

  it('本机提示不声称上传，云端提示不声称在本机留档', () => {
    const local = dictationPathNotice(checkedDictationResult(localComplete));
    const cloud = dictationPathNotice(checkedDictationResult(cloudComplete));
    expect(local).toContain('音频未上传');
    expect(local).not.toContain('已上传');
    expect(cloud).toContain('已上传');
    expect(cloud).toContain('未在本机保存');
  });
});

describe('云端听写状态（缺省一律 fail-closed）', () => {
  it('缺省、旧宿主或未上报的状态按未开启且不可用处理', () => {
    expect(cloudDictationState(null)).toEqual({ enabled: false, available: false });
    expect(cloudDictationState(undefined)).toEqual({ enabled: false, available: false });
    expect(cloudDictationState(checkedVoiceStatus(disabled))).toEqual({ enabled: false, available: false });
  });

  it('透出原生上报的布尔状态，任何非 true 的值都不当作已开启/可用', () => {
    const status = checkedVoiceStatus({ ...disabled, cloudDictation: { enabled: true, available: true } });
    expect(cloudDictationState(status)).toEqual({ enabled: true, available: true });
    const untrusted = { ...status, cloudDictation: { enabled: 'yes', available: 1 } } as unknown as LocalVoiceStatus;
    expect(cloudDictationState(untrusted)).toEqual({ enabled: false, available: false });
  });

  it('已开启但网关不可用时仍报告不可用，不把开关当成可用', () => {
    const status = checkedVoiceStatus({ ...disabled, cloudDictation: { enabled: true, available: false } });
    expect(cloudDictationState(status)).toEqual({ enabled: true, available: false });
    expect(cloudDictationHint(cloudDictationState(status))).toContain('未配置模型网关，云端听写不可用');
  });
});

describe('云端听写开关（只按原生返回值刷新）', () => {
  it('只接受布尔 enabled，并剔除模型名等额外字段', () => {
    expect(checkedCloudDictationToggle({ enabled: true })).toEqual({ enabled: true });
    expect(checkedCloudDictationToggle({ enabled: false })).toEqual({ enabled: false });
    expect(checkedCloudDictationToggle({ enabled: true, model: 'gpt-4o-transcribe' })).toEqual({ enabled: true });
  });

  it('缺字段或非布尔一律抛错，用户取消（enabled:false）不显示为成功', () => {
    for (const invalid of [undefined, null, {}, { enabled: 'true' }, { enabled: 1 }, { enabled: 0 }, 'enabled', true, []]) {
      expect(() => checkedCloudDictationToggle(invalid)).toThrow('未确认');
    }
    expect(checkedCloudDictationToggle({ enabled: false })).toEqual({ enabled: false });
  });
});

describe('云端听写可用性提示（不可用时说明原因）', () => {
  it('未配置模型网关时给出原因，可用时区分开/关状态', () => {
    expect(cloudDictationHint({ enabled: false, available: false })).toContain('未配置模型网关，云端听写不可用');
    expect(cloudDictationHint({ enabled: true, available: false })).toContain('未配置模型网关，云端听写不可用');
    expect(cloudDictationHint({ enabled: false, available: true })).toContain('默认关闭');
    expect(cloudDictationHint({ enabled: true, available: true })).toContain('已开启');
    expect(cloudDictationHint({ enabled: false, available: false }, false)).toContain('更新客户端');
  });
});

describe('面板接线（云端开关与路径提示）', () => {
  const panel = readFileSync(new URL('../../apps/web/src/local-voice-panel.tsx', import.meta.url), 'utf8');

  it('复选框标签写明录音会上传，并在不可用时禁用', () => {
    expect(panel).toContain('云端听写（本次录音会上传到已配置的模型网关）');
    expect(panel).toContain('disabled={!cloudUsable');
    expect(panel).toContain('cloudDictationHint(cloud, cloudHostSupported)');
  });

  it('切换只采用原生返回值，听写结束按结果提示路径', () => {
    expect(panel).toContain('checkedCloudDictationToggle');
    expect(panel).toContain('setCloudDictation.call(bridge, cloudEnabled === true)');
    expect(panel).toContain('dictationPathNotice(result)');
  });
});