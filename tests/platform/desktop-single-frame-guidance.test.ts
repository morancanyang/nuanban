import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateLocalFrame, evaluateSelectedFrame } from '../../apps/desktop/observation-policy.cjs';
import { syntheticDetection, syntheticFrame, syntheticPng } from '../helpers/standalone-frame';

const { createSingleFrameGuidance, parseSingleFrameResult, mapSingleFrameTarget, sameTargetPixels } = createRequire(import.meta.url)('../../apps/desktop/single-frame-guidance.cjs');
const geometry = { coordinateSpace: 'screen-dip', x: -1600, y: -200, width: 640, height: 480, scaleFactor: 1.25 };
const step = { kind: 'step', instruction: '请亲手双击此图标', label: '微信', rect: { x: 100, y: 120, width: 60, height: 50 }, confidence: 0.96 };
const cleanups: Array<() => Promise<void>> = [];

function pngShade(bytes: Buffer) {
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  return inflateSync(Buffer.concat(chunks))[1];
}

const nativeImage = { createFromBuffer: (bytes: Buffer) => ({ isEmpty: () => false, crop: (rect: { width: number; height: number }) => ({
  toBitmap: () => { const bitmap = Buffer.alloc(rect.width * rect.height * 4, pngShade(bytes)); for (let offset = 3; offset < bitmap.length; offset += 4) bitmap[offset] = 255; return bitmap; },
}) }) };

function fixture(overrides: Record<string, unknown> = {}) {
  let shade = 48;
  let secret = false;
  let identity = 'same-screen';
  const source = {
    listSources: vi.fn(async () => [{ id: 'screen:1:0', name: '合成测试屏幕', type: 'screen', geometry }]),
    capture: vi.fn(async () => Object.assign(syntheticFrame(geometry, (overrides.now as (() => number) | undefined)?.() ?? Date.now()), { sourceId: 'screen:1:0', sourceIdentity: identity })),
    detect: vi.fn(async (frame: ReturnType<typeof syntheticFrame>) => ({ ...syntheticDetection(frame, secret ? ['密码'] : ['非白名单图标']), sanitizedPng: syntheticPng(shade) })),
    stop: vi.fn(async () => undefined),
  };
  const provider = { answer: vi.fn(async (_input: Record<string, unknown>): Promise<{ text: string }> => ({ text: JSON.stringify(step) })) };
  const selectSource = vi.fn(async () => ({ sourceId: 'screen:1:0' }));
  const onTarget = vi.fn(() => true);
  const onState = vi.fn();
  const clearTarget = vi.fn();
  const service = createSingleFrameGuidance({ source, provider, nativeImage, selectSource, onTarget, onState, clearTarget, ...overrides });
  cleanups.push(() => service.cancel());
  return { service, source, provider, selectSource, onTarget, onState, clearTarget,
    setShade: (value: number) => { shade = value; }, setSecret: () => { secret = true; }, setIdentity: (value: string) => { identity = value; } };
}

afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe('显式单帧策略，不改变连续观察门控', () => {
  it('保留实际脱敏图而非将图标换成控件布局', () => {
    const frame = syntheticFrame(geometry);
    const detection = { ...syntheticDetection(frame, ['非白名单图标']), sanitizedPng: syntheticPng(48) };
    expect(evaluateLocalFrame(frame, detection)).toMatchObject({ decision: 'pause', reason: 'unclassified_screen' });
    const admitted = evaluateSelectedFrame(frame, detection);
    expect(admitted).toMatchObject({ decision: 'allow', scene: 'selected_frame' });
    if (admitted.decision === 'allow') expect(admitted.sanitizedPng.equals(detection.sanitizedPng)).toBe(true);
  });
  it('允许已完成本地检测但只有图标、没有 OCR 文字的单帧', () => {
    const frame = syntheticFrame(geometry);
    const detection = { ...syntheticDetection(frame, []), sanitizedPng: Buffer.from(frame.png) };
    expect(evaluateSelectedFrame(frame, detection).decision).toBe('allow');
    expect(evaluateLocalFrame(frame, detection).decision).toBe('pause');
  });
  it.each(['密码', '银行卡', 'sk-12345678901234567890'])('仍拒绝敏感内容：%s', label => {
    const frame = syntheticFrame(geometry);
    expect(evaluateSelectedFrame(frame, syntheticDetection(frame, [label]))).toMatchObject({ decision: 'pause', reason: 'sensitive_screen' });
  });
  it('拒绝未完成本地检测或有文字但没有脱敏的图片', () => {
    const frame = syntheticFrame(geometry);
    const detection = syntheticDetection(frame);
    expect(evaluateSelectedFrame(frame, { ...detection, status: 'failed' }).decision).toBe('pause');
    expect(evaluateSelectedFrame(frame, { ...detection, sanitizedPng: Buffer.from(frame.png) })).toMatchObject({ decision: 'pause', reason: 'unredacted_frame' });
  });
});

describe('图片坐标解析与多显示器映射', () => {
  it('按图片像素映射至负原点、125% DPI 的屏幕 DIP 坐标', () => {
    expect(mapSingleFrameTarget(syntheticFrame(geometry), step.rect)).toEqual({ x: -1520, y: -104, width: 48, height: 40 });
  });
  it('框选截图的 geometry 已含区域偏移，不重复相加', () => {
    const frame = syntheticFrame({ ...geometry, x: 100, y: 200, width: 400, height: 300 });
    expect(mapSingleFrameTarget(frame, step.rect)).toEqual({ x: 150, y: 260, width: 30, height: 25 });
  });
  it.each([
    { ...step, rect: { x: -1, y: 1, width: 20, height: 20 } },
    { ...step, rect: { x: 799, y: 1, width: 20, height: 20 } },
    { ...step, rect: { x: 1, y: 1, width: 0, height: 20 } },
    { ...step, rect: { x: 1, y: 1, width: 20, height: 20, unit: 'dip' } },
    { ...step, confidence: null }, { ...step, target_id: 'anything' }, { kind: 'clarify', instruction: '请补充', rect: step.rect },
  ])('拒绝非法格式与边界：%j', result => {
    expect(() => parseSingleFrameResult(JSON.stringify(result), 800, 600)).toThrow();
  });
  it('不把包裹文字、截断 JSON 或低置信度当作可靠位置', () => {
    expect(() => parseSingleFrameResult('```json\n{}\n```', 800, 600)).toThrow();
    expect(() => parseSingleFrameResult('{"kind":', 800, 600)).toThrow();
    expect(parseSingleFrameResult(JSON.stringify({ ...step, confidence: 0.5 }), 800, 600).kind).toBe('clarify');
  });
  it('不显示已变化或全黑遮盖区域的旧坐标', () => {
    const first = { ...syntheticFrame(geometry), sanitizedPng: syntheticPng(48) };
    expect(sameTargetPixels(nativeImage, first, { ...first, sanitizedPng: syntheticPng(48) }, step.rect)).toBe(true);
    expect(sameTargetPixels(nativeImage, first, { ...first, sanitizedPng: syntheticPng(90) }, step.rect)).toBe(false);
    const black = { ...first, sanitizedPng: syntheticPng(0) };
    expect(sameTargetPixels(nativeImage, black, black, step.rect)).toBe(false);
  });
});

describe('单帧完整链路与权限隔离', () => {
  it('预览不触发 AI，发送与预览逐字节一致，只发一次并停止采集后绘制', async () => {
    const current = fixture();
    const captured = await current.service.capture();
    expect(current.provider.answer).not.toHaveBeenCalled();
    expect(current.source.stop).toHaveBeenCalledOnce();
    expect(current.service.canCapture({ sourceId: 'screen:1:0' })).toBe(false);
    let uploaded: Buffer | undefined;
    current.provider.answer.mockImplementation(async input => {
      uploaded = Buffer.from((input.image as { bytes: Buffer }).bytes);
      expect(current.source.stop).toHaveBeenCalledOnce();
      return { text: JSON.stringify(step) };
    });
    const result = await current.service.analyze({ previewId: captured.preview.id, question: '找到微信图标' });
    expect(result.state).toBe('shown');
    expect(uploaded?.toString('base64')).toBe(captured.preview.dataUrl.split(',')[1]);
    expect(current.source.capture).toHaveBeenCalledTimes(2);
    expect(current.provider.answer).toHaveBeenCalledOnce();
    expect(current.onTarget).toHaveBeenCalledWith(expect.objectContaining({ visible: true, presentation: 'uncertain_candidate', rect: { x: -1520, y: -104, width: 48, height: 40 } }));
    await expect(current.service.analyze({ previewId: captured.preview.id, question: '再次定位' })).rejects.toThrow('预览无效');
  });
  it('本地敏感阻断，不上传也不显示箭头', async () => {
    const current = fixture(); current.setSecret();
    await expect(current.service.capture()).rejects.toThrow('sensitive_screen');
    expect(current.provider.answer).not.toHaveBeenCalled();
    expect(current.onTarget).not.toHaveBeenCalled();
  });
  it('过期预览或错误预览标识不能上传', async () => {
    let now = Date.now();
    const current = fixture({ now: () => now });
    const captured = await current.service.capture();
    await expect(current.service.analyze({ previewId: 'wrong', question: '找到微信' })).rejects.toThrow();
    now += 120_001;
    await expect(current.service.analyze({ previewId: captured.preview.id, question: '找到微信' })).rejects.toThrow();
    expect(current.provider.answer).not.toHaveBeenCalled();
  });
  it.each(['pixels', 'identity', 'sensitive'])('AI 返回后本地复核失败不画旧位置：%s', async mode => {
    const current = fixture(); const captured = await current.service.capture();
    current.provider.answer.mockImplementation(async () => {
      if (mode === 'pixels') current.setShade(180);
      if (mode === 'identity') current.setIdentity('new-screen');
      if (mode === 'sensitive') current.setSecret();
      return { text: JSON.stringify(step) };
    });
    await expect(current.service.analyze({ previewId: captured.preview.id, question: '找到微信' })).rejects.toThrow();
    expect(current.provider.answer).toHaveBeenCalledOnce();
    expect(current.onTarget).not.toHaveBeenCalled();
  });
  it('低置信度仅澄清，不采集额外帧，不画箭头', async () => {
    const current = fixture(); const captured = await current.service.capture();
    current.provider.answer.mockResolvedValue({ text: JSON.stringify({ ...step, confidence: 0.4 }) });
    expect((await current.service.analyze({ previewId: captured.preview.id, question: '找到微信' })).state).toBe('clarify');
    expect(current.source.capture).toHaveBeenCalledOnce();
    expect(current.onTarget).not.toHaveBeenCalled();
  });
  it('overlay 未显示则明确报错，不伪报已成功', async () => {
    const current = fixture({ onTarget: () => false }); const captured = await current.service.capture();
    await expect(current.service.analyze({ previewId: captured.preview.id, question: '找到微信' })).rejects.toThrow('指引窗口未能显示');
    expect(current.service.snapshot().state).toBe('error');
  });
  it('取消后迟到 AI 回复不能触发采集或绘制，并拒绝并发请求', async () => {
    const current = fixture(); const captured = await current.service.capture();
    let finish: (value: { text: string }) => void = () => undefined;
    current.provider.answer.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const analysis = current.service.analyze({ previewId: captured.preview.id, question: '找到微信' });
    const rejected = expect(analysis).rejects.toThrow('取消');
    await vi.waitFor(() => expect(current.provider.answer).toHaveBeenCalledOnce());
    await expect(current.service.capture()).rejects.toThrow('尚未结束');
    await current.service.cancel();
    finish({ text: JSON.stringify(step) });
    await rejected;
    expect(current.onTarget).not.toHaveBeenCalled();
    expect(current.source.capture).toHaveBeenCalledOnce();
    expect(current.service.snapshot().state).toBe('idle');
  });
  it('网络超时退出等待状态，不接受迟到响应', async () => {
    const current = fixture({ timeoutMs: 100 }); const captured = await current.service.capture();
    current.provider.answer.mockImplementation(() => new Promise(() => undefined));
    await expect(current.service.analyze({ previewId: captured.preview.id, question: '找到微信' })).rejects.toThrow('超时');
    expect(current.service.snapshot().state).toBe('error');
    expect(current.onTarget).not.toHaveBeenCalled();
  });
  it('截帧停止失败时不保留待发送图，不允许上传', async () => {
    const current = fixture();
    current.source.stop.mockRejectedValueOnce(new Error('synthetic stop failure'));
    await expect(current.service.capture()).rejects.toThrow('stop failure');
    expect(current.service.snapshot()).toMatchObject({ state: 'error', hasPreview: false });
    expect(current.service.canCapture({ sourceId: 'screen:1:0' })).toBe(false);
    expect(current.provider.answer).not.toHaveBeenCalled();
  });
  it('取消清理失败会明确报错，仍清除预览并撤销捕获权限', async () => {
    const current = fixture(); await current.service.capture();
    current.source.stop.mockRejectedValueOnce(new Error('synthetic stop failure'));
    await expect(current.service.cancel()).rejects.toThrow('stop failure');
    expect(current.service.snapshot()).toMatchObject({ state: 'error', hasPreview: false });
    expect(current.service.canCapture({ sourceId: 'screen:1:0' })).toBe(false);
    expect(current.clearTarget).toHaveBeenCalled();
  });
});

describe('可信 preload 单帧接口', () => {
  it('只允许固定通道，校验调用参数，投影结果不泄漏额外数据', async () => {
    const exposed: Record<string, Record<string, (...args: unknown[]) => unknown>> = {};
    const invoke = vi.fn(async () => ({ state: 'preview', message: '可预览', hasPreview: true, secret: 'not-exposed' }));
    runInNewContext(readFileSync(new URL('../../apps/desktop/pet-preload.cjs', import.meta.url), 'utf8'), {
      require: () => ({ contextBridge: { exposeInMainWorld: (name: string, value: typeof exposed[string]) => { exposed[name] = value; } }, ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() } }),
    });
    const api = exposed.nuanbanSingleFrame;
    expect(await api.snapshot()).toEqual({ state: 'preview', message: '可预览', hasPreview: true });
    expect(() => api.analyze({ previewId: 'wrong', question: '找到微信' })).toThrow();
    expect(invoke).toHaveBeenCalledOnce();
  });
});

describe('单帧大图降采样与模型超时提示', () => {
  it('模型超时映射为中文提示，不再透传 TIMEOUT', async () => {
    const failure = Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' });
    const provider = { answer: vi.fn(async () => { throw failure; }) };
    const current = fixture({ provider });
    const captured = await current.service.capture() as { preview: { id: string } };
    await expect(current.service.analyze({ previewId: captured.preview.id, question: '帮我找到设置' }))
      .rejects.toThrow('模型响应超时');
    expect(current.onTarget).not.toHaveBeenCalled();
  });

  it('大图发送缩放副本，模型返回的缩放坐标按原图恢复后再核验绘制', async () => {
    const uploaded: Buffer[] = [];
    const provider = { answer: vi.fn(async (input: { image: { bytes: Buffer } }) => {
      uploaded.push(Buffer.from(input.image.bytes));
      return { text: JSON.stringify({ ...step, rect: { x: 50, y: 60, width: 30, height: 25 } }) };
    }) };
    const scaled = Buffer.from(syntheticPng(48, 320, 240));
    const expectedUpload = Buffer.from(scaled);
    const current = fixture({ provider, resizeAnalysisImage: () => ({ image: { mime: 'image/png', bytes: scaled, width: 320, height: 240 } }) });
    const captured = await current.service.capture() as { preview: { id: string } };
    const result = await current.service.analyze({ previewId: captured.preview.id, question: '帮我找到设置' });
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.equals(expectedUpload)).toBe(true);
    // 800×600 原图 / 320×240 上传：坐标与尺寸各放大 2.5 倍后映射到负原点、125% DPI 的屏幕 DIP。
    expect(current.onTarget).toHaveBeenLastCalledWith(expect.objectContaining({
      visible: true, label: '微信', rect: { x: -1500, y: -80, width: 60, height: 50 },
    }));
    expect(result).toMatchObject({ state: 'shown' });
  });
});
