import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopRuntime, type AnalysisInput, type AnalysisResult, type DesktopRuntime, type RuntimeOptions } from '../../apps/desktop/runtime-coordinator.cjs';
import type { LocalDetection, ScreenGeometry } from '../../apps/desktop/observation-policy.cjs';
import { syntheticDetection, syntheticFrame } from '../helpers/standalone-frame';

const runtimes: DesktopRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
  vi.useRealTimers();
});

function identity(input: AnalysisInput) {
  return { observation_id: input.observationId, guide_id: input.guideId, observation_generation: input.observationGeneration,
    task_generation: input.taskGeneration, trigger_id: input.triggerId, frame_id: input.frame.frameId };
}

function fixture(surface: 'taskbar' | 'desktop' = 'taskbar', label = '微信') {
  vi.useFakeTimers();
  const controls = { time: Date.now(), labels: ['设置', '显示', '文本大小', '返回', '中'],
    geometry: { x: 0, y: 0, width: 800, height: 600, scaleFactor: 1 } as ScreenGeometry,
    sourceId: 'screen:test:0', displayId: 'test-display', delay: 0, status: 'complete' as LocalDetection['status'],
    shell: [{ label, surface, rect: { x: 220, y: 540, width: 44, height: 44 } }] as NonNullable<LocalDetection['shellControls']> };
  const source = {
    capture: vi.fn(async () => {
      controls.time = Math.max(controls.time + 1, Date.now());
      return { ...syntheticFrame(controls.geometry, controls.time), sourceId: controls.sourceId, displayId: controls.displayId };
    }),
    detect: vi.fn<RuntimeOptions['source']['detect']>(async frame => {
      const detection = { ...syntheticDetection(frame, controls.labels), sourceId: frame.sourceId,
        status: controls.status, shellControls: controls.shell.map(control => ({ ...control, rect: { ...control.rect } })) };
      controls.time += controls.delay;
      return detection;
    }),
    stop: vi.fn(async () => undefined),
  };
  const analyze = vi.fn<(input: AnalysisInput) => Promise<AnalysisResult>>(async input => input.previousStep
    ? { ...identity(input), kind: 'unsupported', instruction: '当前变化尚未核验。' }
    : { ...identity(input), kind: 'step', instruction: `请亲手打开${label}。`, presentation: 'confirmed',
      target_id: input.frame.elements.find(element => element.surface === surface && element.label === label)!.id,
      expected_labels: ['字体大小'] });
  const onTarget = vi.fn();
  const recordTeaching = vi.fn();
  const runtime = createDesktopRuntime({ source, analyzer: { analyze }, onTarget, recordTeaching,
    intervalMs: 1000, now: () => Math.max(controls.time, Date.now()) });
  runtimes.push(runtime);
  const begin = async () => {
    await runtime.startObservation({ actor: 'owner', confirmed: true, sourceId: controls.sourceId, cloudConsent: true });
    await runtime.whenIdle();
    await runtime.ask('请指向微信入口，让我自己打开');
    await runtime.whenIdle();
    expect(runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    onTarget.mockClear();
  };
  const nextFrame = async () => {
    await vi.advanceTimersByTimeAsync(1100);
    await runtime.whenIdle();
  };
  return { controls, source, analyze, onTarget, recordTeaching, runtime, begin, nextFrame };
}

describe('已核验系统入口不被无关画面变化清掉', () => {
  it.each(['taskbar', 'desktop'] as const)('%s 入口经过多帧完整复核，续显箭头而不重复出云', async surface => {
    const setup = fixture(surface);
    await setup.begin();
    for (const label of ['帮助', '文件', '编辑']) {
      setup.controls.labels.push(label);
      await setup.nextFrame();
      expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    }
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.onTarget).toHaveBeenCalledTimes(3);
    expect(setup.onTarget.mock.calls.every(([target]) => target?.visible === true)).toBe(true);
    expect(setup.recordTeaching).not.toHaveBeenCalled();
  });

  it('任意非白名单桌面入口（WeGame）同样进入候选、被本机核验并续显箭头', async () => {
    const setup = fixture('desktop', 'WeGame');
    await setup.begin();
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    expect(setup.analyze.mock.calls[0]![0].frame.elements.map(element => element.label)).toContain('WeGame');
    setup.controls.labels.push('帮助');
    await setup.nextFrame();
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    expect(setup.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, label: 'WeGame', rect: setup.controls.shell[0]!.rect }));
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.recordTeaching).not.toHaveBeenCalled();
  });

  it('任务栏输入法标识位移不改变已核验入口的位置或触发第二次云分析', async () => {
    const setup = fixture();
    await setup.begin();
    setup.source.detect.mockImplementationOnce(async frame => {
      const detection = syntheticDetection(frame, setup.controls.labels);
      detection.words.find(word => word.text === '中')!.rect.x += 42;
      return { ...detection, sourceId: frame.sourceId, shellControls: setup.controls.shell };
    });
    await setup.nextFrame();
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, label: '微信', rect: setup.controls.shell[0].rect }));
    expect(setup.onTarget).not.toHaveBeenCalledWith(null);
  });

  it('本人请求核验但没有新证据，只续显同一个入口，不误报完成或继续出云', async () => {
    const setup = fixture();
    await setup.begin();
    setup.controls.labels.push('帮助');
    await setup.runtime.verify();
    await setup.runtime.whenIdle();
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    expect(setup.runtime.snapshot().analysis.message).toContain('尚未观察到预期变化');
    expect(setup.recordTeaching).not.toHaveBeenCalled();
  });

  it('新预期控件出现时仍进入真实变化核验，而非因任务栏入口仍在就永远停留', async () => {
    const setup = fixture();
    await setup.begin();
    setup.analyze.mockImplementationOnce(async input => ({ ...identity(input), kind: 'completed', instruction: '新的预期控件已出现。', evidence_labels: ['字体大小'] }));
    setup.controls.labels.push('字体大小');
    await setup.nextFrame();
    expect(setup.analyze).toHaveBeenCalledTimes(2);
    expect(setup.analyze.mock.lastCall![0].reason).toBe('page_changed');
    expect(setup.runtime.snapshot().task.state).toBe('completed');
    expect(setup.recordTeaching).toHaveBeenCalledOnce();
    expect(setup.onTarget).toHaveBeenCalledWith(null);
  });

  it.each(['missing', 'surface', 'duplicate', 'x', 'y', 'width', 'height', 'source', 'display', 'geometry'] as const)(
    '入口或观察范围变化 %s 时清掉旧箭头，不能沿用旧位置', async change => {
      const setup = fixture();
      await setup.begin();
      setup.controls.labels.push('帮助');
      if (change === 'missing') setup.controls.shell = [];
      else if (change === 'surface') setup.controls.shell[0].surface = 'desktop';
      else if (change === 'duplicate') setup.controls.shell.push({ ...setup.controls.shell[0], rect: { ...setup.controls.shell[0].rect, x: 222 } });
      else if (change === 'source') setup.controls.sourceId = 'screen:other:0';
      else if (change === 'display') setup.controls.displayId = 'other-display';
      else if (change === 'geometry') setup.controls.geometry.x += 100;
      else setup.controls.shell[0].rect[change] += 10;
      await setup.nextFrame();
      expect(setup.onTarget).toHaveBeenCalledWith(null);
      expect(setup.runtime.snapshot().task.targetState).not.toBe('visible');
      expect(setup.recordTeaching).not.toHaveBeenCalled();
    });

  it('只有同位置 OCR 标签不能冒充已经失去本机 UIA 核验的入口', async () => {
    const setup = fixture();
    await setup.begin();
    setup.controls.shell = [];
    setup.source.detect.mockImplementation(async frame => {
      const detection = syntheticDetection(frame, setup.controls.labels);
      detection.words.push({ text: '微信', rect: { x: 220, y: 540, width: 44, height: 44 } });
      return detection;
    });
    await setup.nextFrame();
    expect(setup.onTarget).toHaveBeenCalledWith(null);
    expect(setup.runtime.snapshot().task.targetState).not.toBe('visible');
  });

  it.each(['sensitive', 'failed', 'stale'] as const)('入口仍在但 %s 时仍关闭箭头，不绕过隐私、完整性与时效检查', async condition => {
    const setup = fixture();
    await setup.begin();
    if (condition === 'sensitive') setup.controls.labels.push('私人聊天');
    if (condition === 'failed') setup.controls.status = 'failed';
    if (condition === 'stale') setup.controls.delay = 6000;
    await setup.nextFrame();
    expect(setup.onTarget).toHaveBeenCalledWith(null);
    expect(setup.runtime.snapshot().task.targetState).not.toBe('visible');
    expect(setup.analyze).toHaveBeenCalledOnce();
    expect(setup.recordTeaching).not.toHaveBeenCalled();
  });

  it('没有后续新鲜帧时仍按五秒到期隐藏，停止观察撤销授权', async () => {
    const setup = fixture();
    await setup.begin();
    setup.source.capture.mockImplementationOnce(() => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(5100);
    expect(setup.onTarget).toHaveBeenCalledWith(null);
    expect(setup.runtime.snapshot().task.targetState).toBe('stale');
    await setup.runtime.stopObservation();
    expect(setup.runtime.snapshot().observation).toMatchObject({ captureActive: false, cloudConsent: false });
  });

  it('后续本地处理耗时较长时按采集时刻安排下一帧，不叠加间隔导致安全箭头反复过期', async () => {
    const setup = fixture();
    await setup.begin();
    setup.source.detect.mockImplementation(async frame => {
      await new Promise(resolve => setTimeout(resolve, 2200));
      setup.controls.time = Math.max(setup.controls.time, Date.now());
      return { ...syntheticDetection(frame, setup.controls.labels), sourceId: frame.sourceId, shellControls: setup.controls.shell };
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(setup.source.detect.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(setup.onTarget.mock.calls.filter(([target]) => target?.visible)).toHaveLength(4);
    expect(setup.onTarget).not.toHaveBeenCalledWith(null);
    expect(setup.analyze).toHaveBeenCalledOnce();
    await setup.runtime.stopObservation();
  });

  it('完整检测慢于续显预算时如实隐藏过期箭头，不延长旧位置有效期或停止观察', async () => {
    const setup = fixture();
    await setup.begin();
    setup.source.detect.mockImplementation(async frame => {
      await new Promise(resolve => setTimeout(resolve, 3100));
      setup.controls.time = Math.max(setup.controls.time, Date.now());
      return { ...syntheticDetection(frame, setup.controls.labels), sourceId: frame.sourceId, shellControls: setup.controls.shell };
    });
    await vi.advanceTimersByTimeAsync(6200);
    expect(setup.runtime.snapshot().observation).toMatchObject({ state: 'observing', captureActive: true, cloudConsent: true });
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'stale' });
    expect(setup.onTarget).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(1100);
    expect(setup.runtime.snapshot().task).toMatchObject({ state: 'awaiting_action', targetState: 'visible' });
    expect(setup.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, label: '微信' }));
    expect(setup.analyze).toHaveBeenCalledOnce();
    await setup.runtime.stopObservation();
  });
});
