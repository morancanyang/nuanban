import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { deflateSync, inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowsObservationSource, ObservationError, type DesktopCapturerApi, type LocalImage, type NativeImageApi, type ObservationFrame, type ObservationGeometry, type RawDesktopSource } from '../../apps/desktop/observation/windows-observation-source.cjs';
import { createWindowsLocalDetector } from '../../apps/desktop/observation/windows-local-detector.cjs';

function crc32(bytes: Buffer) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) checksum = checksum >>> 1 ^ (checksum & 1 ? 0xedb88320 : 0);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function encodePng(bitmap: Buffer, width: number, height: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const sourceOffset = (row * width + column) * 4;
      const targetOffset = row * (width * 4 + 1) + 1 + column * 4;
      rows[targetOffset] = bitmap[sourceOffset + 2]!;
      rows[targetOffset + 1] = bitmap[sourceOffset + 1]!;
      rows[targetOffset + 2] = bitmap[sourceOffset]!;
      rows[targetOffset + 3] = bitmap[sourceOffset + 3]!;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

function decodePng(png: Buffer) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < png.length; offset += png.readUInt32BE(offset) + 12) {
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + png.readUInt32BE(offset)));
  }
  const rows = inflateSync(Buffer.concat(compressed));
  const bitmap = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const sourceOffset = row * (width * 4 + 1) + 1 + column * 4;
      const targetOffset = (row * width + column) * 4;
      bitmap[targetOffset] = rows[sourceOffset + 2]!;
      bitmap[targetOffset + 1] = rows[sourceOffset + 1]!;
      bitmap[targetOffset + 2] = rows[sourceOffset]!;
      bitmap[targetOffset + 3] = rows[sourceOffset + 3]!;
    }
  }
  return { width, height, bitmap };
}

function memoryImage(bitmap: Buffer, width: number, height: number): LocalImage {
  const pixels = Buffer.from(bitmap);
  return { isEmpty: () => false, getSize: () => ({ width, height }), toPNG: () => encodePng(pixels, width, height), toBitmap: () => Buffer.from(pixels) };
}

const nativeImage: NativeImageApi = {
  createFromBuffer(png) {
    const decoded = decodePng(png);
    return memoryImage(decoded.bitmap, decoded.width, decoded.height);
  },
  createFromBitmap(bitmap, { width, height }) { return memoryImage(bitmap, width, height); },
};

function geometry(overrides: Partial<ObservationGeometry> = {}): ObservationGeometry {
  return { coordinateSpace: 'screen-dip', x: -64, y: -48, width: 64, height: 48, pixelX: -64, pixelY: -48, pixelWidth: 64, pixelHeight: 48, scaleFactor: 1, rotation: 0, ...overrides };
}

function frame(overrides: Partial<ObservationFrame> = {}): ObservationFrame {
  const bitmap = Buffer.alloc(64 * 48 * 4);
  bitmap.fill(Buffer.from([40, 70, 90, 255]));
  const png = encodePng(bitmap, 64, 48);
  return { sourceId: 'screen:1:0', sourceIdentity: '1'.repeat(64), displayId: '7', frameHash: createHash('sha256').update(png).digest('hex'), capturedAt: 1234, width: 64, height: 48, geometry: geometry(), png, ...overrides };
}

type WorkerConfiguration = { token: string; channel: string; generation: number; sourceId: string; sourceIdentity: string; width: number; height: number };
type MediaRequest = { frame: unknown; videoRequested: boolean; audioRequested: boolean; userGesture: boolean };
type MediaGrant = { video: { id: string; name: string } } | null;

function mediaSetup(width: number, height: number) {
  const ipcMain = new EventEmitter();
  const windows: FakeWindow[] = [];
  const sessions: FakeSession[] = [];
  const grants: MediaGrant[] = [];
  const controls = { autoFrame: true, autoStop: true, delayClose: false, failSetup: false, now: Date.now, beforeFrame: () => {}, afterFrame: () => {}, requestChanges: {} as Partial<MediaRequest>, packetChanges: {} as Record<string, unknown>, framePng: encodePng(Buffer.alloc(width * height * 4, 255), width, height), readyWidth: width, readyHeight: height, frameWidth: width, frameHeight: height, lastPixels: null as Uint8Array | null };
  class FakeSession {
    displayHandler!: (request: MediaRequest, callback: (grant: MediaGrant) => void) => void;
    permissionCheck!: (...args: unknown[]) => boolean;
    permissionRequest!: (...args: unknown[]) => void;
    requestHandler!: (details: Record<string, unknown>, callback: (reply: { cancel: boolean }) => void) => void;
    webRequest = { onBeforeRequest: vi.fn((filter, handler) => { this.requestHandler = handler; }) };
    enableNetworkEmulation = vi.fn();
    on = vi.fn();
    setPermissionCheckHandler(handler: FakeSession['permissionCheck']) { this.permissionCheck = handler; }
    setPermissionRequestHandler(handler: FakeSession['permissionRequest']) { this.permissionRequest = handler; }
    setDisplayMediaRequestHandler = vi.fn((handler: FakeSession['displayHandler'], options?: { useSystemPicker: boolean }) => { this.displayHandler = handler; });
  }
  class FakeWindow extends EventEmitter {
    destroyed = false;
    configuration: WorkerConfiguration;
    options: Record<string, unknown>;
    webContents: EventEmitter & { id: number; session: FakeSession; mainFrame: { url: string }; isDestroyed: () => boolean; setWebRTCIPHandlingPolicy: ReturnType<typeof vi.fn>; setWindowOpenHandler: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; executeJavaScript: ReturnType<typeof vi.fn> };
    constructor(options: { webPreferences: { session: FakeSession; additionalArguments: string[] } }) {
      super();
      this.options = options;
      this.configuration = JSON.parse(options.webPreferences.additionalArguments[0]!.slice('--nuanban-capture='.length));
      this.webContents = Object.assign(new EventEmitter(), { id: windows.length + 1, session: options.webPreferences.session, mainFrame: { url: '' }, isDestroyed: () => this.destroyed, setWebRTCIPHandlingPolicy: vi.fn(() => { if (controls.failSetup) throw new Error('private-error'); }), setWindowOpenHandler: vi.fn(), send: vi.fn((channel: string, command: { kind: string; requestId: string }) => {
        if (command.kind === 'stop' && controls.autoStop) setImmediate(() => this.packet({ kind: 'stopped' }));
        if (command.kind === 'capture' && controls.autoFrame) setImmediate(() => this.frame(command.requestId));
       }), executeJavaScript: vi.fn(async () => {
        const allowed = await new Promise<boolean>(resolve => this.webContents.session.permissionRequest(this.webContents, 'media', resolve, {
          isMainFrame: true, mediaTypes: [], requestingUrl: this.webContents.mainFrame.url, securityOrigin: 'file:///',
        }));
        if (!allowed) {
          setImmediate(() => this.packet({ kind: 'error', reason: 'capture_permission_denied' }));
          return false;
        }
        await new Promise<void>(resolve => this.webContents.session.displayHandler({ frame: this.webContents.mainFrame, videoRequested: true, audioRequested: false, userGesture: true, ...controls.requestChanges }, grant => {
          grants.push(grant);
          if (grant) setImmediate(() => this.packet({ kind: 'ready', width: controls.readyWidth, height: controls.readyHeight }));
          else setImmediate(() => this.packet({ kind: 'error', reason: 'capture_permission_denied' }));
          resolve();
        }));
        return true;
      }) });
      windows.push(this);
    }
    async loadFile(filePath: string) { this.webContents.mainFrame.url = new URL(`file:///${filePath.replaceAll('\\', '/')}`).href; }
    isDestroyed() { return this.destroyed; }
    destroy() { if (controls.delayClose) return; this.closeNow(); }
    closeNow() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
    packet(packet: Record<string, unknown>, event: Record<string, unknown> = {}) {
      ipcMain.emit(this.configuration.channel, { sender: this.webContents, senderFrame: this.webContents.mainFrame, ...event }, { ...this.configuration, ...packet });
    }
    frame(requestId: string, packet: Record<string, unknown> = {}, event: Record<string, unknown> = {}) {
      const bytes = Uint8Array.from(controls.framePng);
      controls.lastPixels = bytes;
      controls.beforeFrame();
      this.packet({ kind: 'frame', requestId, capturedAt: controls.now(), width: controls.frameWidth, height: controls.frameHeight, png: bytes.buffer, ...controls.packetChanges, ...packet }, event);
      controls.afterFrame();
    }
  }
  const session = { fromPartition: vi.fn(() => { const created = new FakeSession(); sessions.push(created); return created; }) };
  type SourceOptions = NonNullable<Parameters<typeof createWindowsObservationSource>[0]>;
  const ports = { BrowserWindow: FakeWindow as unknown as SourceOptions['BrowserWindow'], ipcMain: ipcMain as unknown as SourceOptions['ipcMain'], session: session as unknown as SourceOptions['session'] };
  return { ports, windows, sessions, grants, controls, session, ipcMain };
}

const openedSources: Array<ReturnType<typeof createWindowsObservationSource>> = [];
afterEach(async () => { await Promise.all(openedSources.splice(0).map(source => source.stop())); });

function sourceSetup(options: { consent?: boolean; scale?: number; size?: { width: number; height: number }; timeoutMs?: number; now?: () => number; withoutMedia?: boolean; limits?: { maxPngBytes: number } } = {}) {
  const scaleFactor = options.scale ?? 1;
  const display = { id: 7, bounds: { x: -64, y: -48, width: 64, height: 48, ...options.size }, scaleFactor, rotation: 0, nativeOrigin: { x: -64 * scaleFactor, y: -48 * scaleFactor }, workArea: { x: 0, y: 0, width: 1, height: 1 } };
  const width = Math.round(display.bounds.width * scaleFactor);
  const height = Math.round(display.bounds.height * scaleFactor);
  const thumbnail = memoryImage(Buffer.alloc(width * height * 4, 255), width, height);
  let sources: RawDesktopSource[] = [{ id: 'screen:1:0', name: '外部桌面', display_id: '7', thumbnail }, { id: 'window:42:0', name: '外部记事本', display_id: '', thumbnail }];
  const getSources = vi.fn(async (request: Parameters<DesktopCapturerApi['getSources']>[0]) => sources);
  const screen = { getAllDisplays: vi.fn(() => [display]), dipToScreenRect: vi.fn(() => ({ ...display.nativeOrigin, width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) })) };
  let consent = options.consent ?? true;
  const canCapture = vi.fn(() => consent);
  const media = mediaSetup(width, height);
  media.controls.now = options.now ?? (() => 1234);
  const onCaptureInvalidated = vi.fn();
  const source = createWindowsObservationSource({ desktopCapturer: { getSources }, screen, nativeImage, canCapture, platform: 'win32', now: options.now ?? (() => 1234), timeoutMs: options.timeoutMs, limits: options.limits, onCaptureInvalidated, ...(options.withoutMedia ? {} : media.ports) });
  openedSources.push(source);
  return { source, getSources, screen, display, thumbnail, canCapture, media, onCaptureInvalidated, setConsent(value: boolean) { consent = value; }, setSources(value: RawDesktopSource[]) { sources = value; } };
}

type HelperRequest = { protocol: number; operation: string; sourceId: string; sourceIdentity: string | null; frameHash: string; width: number; height: number; pngBase64: string; shellGeometry?: ObservationGeometry };
type HelperReply = Record<string, unknown>;

function completeReply(request: HelperRequest): HelperReply {
  return { protocol: 1, status: 'complete', sourceId: request.sourceId, sourceIdentity: request.sourceIdentity, frameHash: request.frameHash, width: request.width, height: request.height, ocrStatus: 'complete', faceStatus: 'complete', textAngle: null, words: [], faces: [] };
}

function scaledOcrPass(overrides: HelperReply = {}) {
  return { width: 128, height: 96, textAngle: null, words: [{ text: '微信', rect: { x: 40, y: 20, width: 16, height: 12 } }], ...overrides };
}

class HelperChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  closed = false;
  autoCloseOnKill = true;
  request: HelperRequest | null = null;
  kill = vi.fn(() => {
    if (this.autoCloseOnKill) setImmediate(() => this.close(1));
    return true;
  });
  close(code = 0) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code);
  }
  reply(reply: HelperReply | Buffer | string) {
    this.stdout.write(Buffer.isBuffer(reply) ? reply : typeof reply === 'string' ? reply : JSON.stringify(reply));
    this.close();
  }
}

function helperSetup(respond: ((request: HelperRequest, child: HelperChild) => void) | null = (request, child) => child.reply(completeReply(request))) {
  const children: HelperChild[] = [];
  const spawn = vi.fn(() => {
    const child = new HelperChild();
    const chunks: Buffer[] = [];
    child.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
    child.stdin.on('finish', () => {
      child.request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HelperRequest;
      setImmediate(() => respond?.(child.request!, child));
    });
    children.push(child);
    return child as unknown as ReturnType<typeof nodeSpawn>;
  });
  const detector = (options: Parameters<typeof createWindowsLocalDetector>[0] = {}) => createWindowsLocalDetector({ nativeImage, spawn: spawn as unknown as typeof nodeSpawn, platform: 'win32', ...options });
  return { children, spawn, detector };
}

async function nextTurn() { await new Promise<void>(resolve => setImmediate(resolve)); }

describe('Windows 真实外部采集的授权与来源边界', () => {
  it('构造默认不枚举、不抓屏、不启动 helper', async () => {
    const { source, getSources, canCapture } = sourceSetup();
    expect(getSources).not.toHaveBeenCalled();
    expect(canCapture).not.toHaveBeenCalled();
    await source.stop();
    expect(getSources).not.toHaveBeenCalled();
  });

  it('列举只请求零缩略图、无图标，返回最小本地元数据', async () => {
    const { source, getSources, thumbnail } = sourceSetup();
    const toPNG = vi.spyOn(thumbnail, 'toPNG');
    const sources = await source.listSources();
    expect(getSources).toHaveBeenCalledWith({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    expect(toPNG).not.toHaveBeenCalled();
    expect(sources[0]).toEqual({ id: 'screen:1:0', name: '外部桌面', type: 'screen', displayId: '7', geometry: geometry() });
    expect(sources[1]).toMatchObject({ type: 'window', geometry: null, unavailableReason: 'window_geometry_unproven' });
    expect(JSON.stringify(sources)).not.toContain('thumbnail');
  });

  it('缺省无同意回调时，即使列举后也不采集', async () => {
    const setup = sourceSetup();
    const source = createWindowsObservationSource({ desktopCapturer: { getSources: setup.getSources }, screen: setup.screen, platform: 'win32' });
    await source.listSources();
    await expect(source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'consent_required' });
    expect(setup.getSources).toHaveBeenCalledTimes(1);
  });

  it('未列举选择的 ID 不触发原生捕获', async () => {
    const { source, getSources } = sourceSetup();
    await expect(source.capture({ sourceId: 'screen:99:0' })).rejects.toMatchObject({ code: 'source_not_selected' });
    expect(getSources).not.toHaveBeenCalled();
  });

  it('拒绝不能证明 DWM/裁剪映射的 window，不冒充屏幕坐标', async () => {
    const { source, getSources } = sourceSetup();
    await source.listSources();
    await expect(source.capture({ sourceId: 'window:42:0' })).rejects.toMatchObject({ code: 'window_geometry_unproven' });
    expect(getSources).toHaveBeenCalledTimes(1);
  });

  it.each([1, 1.5, 2])('全屏而非 workArea，保留负 DIP 与 %s 倍 DPI 的真实宽高', async scale => {
    const { source, getSources } = sourceSetup({ scale });
    await source.listSources();
    const captured = await source.capture({ sourceId: 'screen:1:0' });
    expect(captured).toMatchObject({ sourceId: 'screen:1:0', displayId: '7', sourceName: '外部桌面', width: 64 * scale, height: 48 * scale, capturedAt: 1234, geometry: { x: -64, y: -48, width: 64, height: 48, scaleFactor: scale } });
    expect(captured.frameHash).toBe(createHash('sha256').update(captured.png).digest('hex'));
    expect(captured.sourceIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(captured).not.toHaveProperty('thumbnail');
    expect(getSources.mock.calls.every(([request]) => request.thumbnailSize.width === 0 && request.thumbnailSize.height === 0)).toBe(true);
  });

  it.each([1.25, 1.5, 1.75])('非整数 DIP 在 %s 倍缩放下使用真实媒体像素，连续帧不重新授权', async scale => {
    const size = { width: 65, height: 49 };
    const setup = sourceSetup({ scale, size });
    const width = Math.floor(size.width * scale);
    const height = Math.floor(size.height * scale);
    Object.assign(setup.media.controls, { readyWidth: width, readyHeight: height, frameWidth: width, frameHeight: height,
      framePng: encodePng(Buffer.alloc(width * height * 4, 255), width, height) });
    await setup.source.listSources();
    const first = await setup.source.capture({ sourceId: 'screen:1:0' });
    const second = await setup.source.capture({ sourceId: 'screen:1:0' });
    expect(first).toMatchObject({ width, height, geometry: { ...size, scaleFactor: scale, pixelWidth: width, pixelHeight: height } });
    expect(second.geometry).toEqual(first.geometry);
    expect(second.sourceIdentity).toBe(first.sourceIdentity);
    expect(second.frameId).not.toBe(first.frameId);
    expect(setup.media.grants).toHaveLength(1);
    expect(setup.media.windows).toHaveLength(1);
  });

  it.each([-2, 2])('DPI 取整不能放过超出物理边界的 %s 像素差异', async difference => {
    const setup = sourceSetup({ scale: 1.5, size: { width: 65, height: 49 } });
    setup.media.controls.readyWidth += difference;
    await setup.source.listSources();
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'capture_dimensions_unproven' });
    await setup.source.stop();
    expect(setup.media.windows[0]!.isDestroyed()).toBe(true);
  });

  it('同一流建立后即使一像素尺寸漂移也失效，不复用旧坐标', async () => {
    const setup = sourceSetup({ scale: 1.5, size: { width: 65, height: 49 } });
    await setup.source.listSources();
    await setup.source.capture({ sourceId: 'screen:1:0' });
    setup.media.controls.frameWidth -= 1;
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'capture_dimensions_unproven' });
    await setup.source.stop();
    expect(setup.media.windows[0]!.isDestroyed()).toBe(true);
  });

  it.each([-1, 1])('整数物理尺寸不允许以 DPI 取整为由接受 %s 像素偏差', async difference => {
    const setup = sourceSetup({ scale: 1.5 });
    setup.media.controls.readyWidth += difference;
    await setup.source.listSources();
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'capture_dimensions_unproven' });
    await setup.source.stop();
    expect(setup.media.windows[0]!.isDestroyed()).toBe(true);
  });

  it('物理矩形边缘取整不污染媒体请求尺寸或整数 DIP 的严格校验', async () => {
    const setup = sourceSetup({ scale: 1.5 });
    setup.screen.dipToScreenRect.mockReturnValue({ ...setup.display.nativeOrigin, width: 97, height: 73 });
    await setup.source.listSources();
    const captured = await setup.source.capture({ sourceId: 'screen:1:0' });
    expect(captured).toMatchObject({ width: 96, height: 72, geometry: { pixelWidth: 96, pixelHeight: 72 } });
    expect(setup.media.windows[0]!.configuration).toMatchObject({ width: 96, height: 72 });
  });

  it('再枚举前已丢失来源则拒绝，不启动像素采集', async () => {
    const setup = sourceSetup();
    await setup.source.listSources();
    setup.setSources([]);
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'source_lost' });
    expect(setup.getSources).toHaveBeenCalledTimes(2);
  });

  it('多屏时精确匹配 display_id，不采用主屏的缩放或坐标', async () => {
    const setup = sourceSetup({ scale: 1.5 });
    const primary = { ...setup.display, id: 1, bounds: { x: 0, y: 0, width: 128, height: 96 }, scaleFactor: 2, nativeOrigin: { x: 0, y: 0 } };
    setup.screen.getAllDisplays.mockReturnValue([primary, setup.display]);
    await setup.source.listSources();
    const captured = await setup.source.capture({ sourceId: 'screen:1:0' });
    expect(captured).toMatchObject({ displayId: '7', width: 96, height: 72, geometry: { x: -64, y: -48, width: 64, height: 48, scaleFactor: 1.5, pixelX: -96, pixelY: -72 } });
  });

  it('capturedAt 使用帧生成时间，不把请求排队时间算作帧龄', async () => {
    let timestamp = 1000;
    const setup = sourceSetup({ now: () => timestamp });
    await setup.source.listSources();
    setup.media.controls.beforeFrame = () => { timestamp = 2000; };
    setup.media.controls.afterFrame = () => { timestamp = 9000; };
    expect((await setup.source.capture({ sourceId: 'screen:1:0' })).capturedAt).toBe(2000);
  });

  it.each([1000, 1235, Number.NaN, '1234'])('拒绝超出请求时间范围的帧时间戳：%s', async capturedAt => {
    const setup = sourceSetup();
    await setup.source.listSources();
    setup.media.controls.packetChanges = { capturedAt };
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'capture_time_invalid' });
    await nextTurn();
    expect(setup.media.windows[0]!.isDestroyed()).toBe(true);
  });

  it('抓到像素后来源消失也不能返回旧帧，失败 PNG 必须清零', async () => {
    const setup = sourceSetup();
    await setup.source.listSources();
    setup.media.controls.beforeFrame = () => setup.setSources([]);
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'source_lost' });
    expect(setup.media.controls.lastPixels!.every(byte => byte === 0)).toBe(true);
  });

  it('采集过程 abort 后不能再读取或返回晚到缩略图', async () => {
    const setup = sourceSetup();
    await setup.source.listSources();
    let resolveNative!: (sources: RawDesktopSource[]) => void;
    const getSize = vi.spyOn(setup.thumbnail, 'getSize');
    setup.getSources.mockImplementationOnce(async () => [{ id: 'screen:1:0', name: '外部桌面', display_id: '7', thumbnail: setup.thumbnail }]);
    setup.getSources.mockImplementationOnce(() => new Promise(resolve => { resolveNative = resolve; }));
    const controller = new AbortController();
    const capture = setup.source.capture({ sourceId: 'screen:1:0', signal: controller.signal });
    await nextTurn();
    controller.abort();
    await expect(capture).rejects.toMatchObject({ code: 'aborted' });
    resolveNative([{ id: 'screen:1:0', name: '外部桌面', display_id: '7', thumbnail: setup.thumbnail }]);
    await nextTurn();
    expect(getSize).not.toHaveBeenCalled();
  });

  it.each(['display', 'scale', 'name'])('来源的 %s 发生变化必须重新选择', async field => {
    const setup = sourceSetup();
    await setup.source.listSources();
    if (field === 'display') setup.display.id = 8;
    if (field === 'scale') setup.display.scaleFactor = 2;
    if (field === 'name') setup.setSources([{ id: 'screen:1:0', name: 'changed', display_id: '7', thumbnail: setup.thumbnail }]);
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'source_changed' });
    expect(setup.getSources).toHaveBeenCalledTimes(2);
  });

  it('不能把缩小的媒体帧当成实际像素尺寸', async () => {
    const setup = sourceSetup();
    await setup.source.listSources();
    setup.media.controls.frameWidth = 32;
    setup.media.controls.frameHeight = 24;
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'capture_dimensions_unproven' });
  });

  it('PNG 自述尺寸与媒体帧不一致时拒绝', async () => {
    const setup = sourceSetup();
    await setup.source.listSources();
    setup.media.controls.framePng = encodePng(Buffer.alloc(32 * 24 * 4), 32, 24);
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'capture_dimensions_unproven' });
  });

  it('撤回同意后不返回画面，清零已生成 PNG', async () => {
    const setup = sourceSetup();
    await setup.source.listSources();
    setup.media.controls.beforeFrame = () => setup.setConsent(false);
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'consent_required' });
    expect(setup.media.controls.lastPixels!.every(byte => byte === 0)).toBe(true);
  });

  it('无法证明物理原点的显示器列出不可用而不伪造 geometry', async () => {
    const getSources = vi.fn(async () => [{ id: 'screen:1:0', name: 'screen', display_id: '7' }]);
    const source = createWindowsObservationSource({ desktopCapturer: { getSources }, screen: { getAllDisplays: () => [{ id: 7, bounds: { x: -64, y: 0, width: 64, height: 48 }, scaleFactor: 1, rotation: 0 }] }, canCapture: () => true, platform: 'win32' });
    expect(await source.listSources()).toMatchObject([{ geometry: null, unavailableReason: 'physical_origin_unproven' }]);
    await expect(source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'physical_origin_unproven' });
  });

  it('捕获限额在像素请求前生效', async () => {
    const setup = sourceSetup();
    setup.display.bounds.width = 10000;
    expect(await setup.source.listSources()).toMatchObject([{ geometry: null, unavailableReason: 'image_dimensions_invalid' }, {}]);
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'image_dimensions_invalid' });
    expect(setup.getSources).toHaveBeenCalledTimes(1);
  });

  it('多屏仅授权选定 source，任何来源 thumbnail 均不读取', async () => {
    const setup = sourceSetup();
    const readPixels = vi.spyOn(setup.thumbnail, 'toPNG').mockImplementation(() => { throw new Error('unselected-pixel-read'); });
    const readSize = vi.spyOn(setup.thumbnail, 'getSize');
    setup.setSources(Array.from({ length: 3 }, (_, index) => ({ id: `screen:${index + 1}:0`, name: '外部桌面', display_id: '7', thumbnail: setup.thumbnail })));
    await setup.source.listSources();
    await setup.source.capture({ sourceId: 'screen:1:0' });
    expect(setup.media.grants).toEqual([{ video: { id: 'screen:1:0', name: '外部桌面' } }]);
    expect(readPixels).not.toHaveBeenCalled();
    expect(readSize).not.toHaveBeenCalled();
    expect(setup.getSources.mock.calls.every(([request]) => request.thumbnailSize.width === 0 && request.thumbnailSize.height === 0)).toBe(true);
  });

  it.each([1, 1.25, 1.5, 1.75, 2])('本人框选区域在 %s 倍 DPI 下只返回区域像素并保留全局映射', async scale => {
    const setup = sourceSetup({ scale });
    const width = Math.round(64 * scale);
    const height = Math.round(48 * scale);
    const pixels = Buffer.alloc(width * height * 4, 255);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        pixels[(row * width + column) * 4] = column;
        pixels[(row * width + column) * 4 + 1] = row;
      }
    }
    setup.media.controls.framePng = encodePng(pixels, width, height);
    await setup.source.listSources();
    const region = { x: 8, y: 6, width: 24, height: 16 };
    const captured = await setup.source.capture({ sourceId: 'screen:1:0', region });
    expect(captured).toMatchObject({ region, width: Math.round(24 * scale), height: Math.round(16 * scale), sourceName: '外部桌面（框选区域）',
      geometry: { x: -56, y: -42, width: 24, height: 16, pixelX: -64 * scale + Math.round(8 * scale), pixelY: -48 * scale + Math.round(6 * scale) } });
    const cropped = decodePng(captured.png);
    expect([...cropped.bitmap.subarray(0, 2)]).toEqual([Math.round(8 * scale), Math.round(6 * scale)]);
    expect([...cropped.bitmap.subarray(cropped.bitmap.length - 4, cropped.bitmap.length - 2)]).toEqual([Math.round(8 * scale) + captured.width - 1, Math.round(6 * scale) + captured.height - 1]);
    expect(captured.frameHash).toBe(createHash('sha256').update(captured.png).digest('hex'));
    expect(setup.media.windows).toHaveLength(1);
    const next = await setup.source.capture({ sourceId: 'screen:1:0', region: { ...region } });
    expect(next.sourceIdentity).toBe(captured.sourceIdentity);
    expect(next.frameId).not.toBe(captured.frameId);
  });

  it.each([
    { x: -1, y: 0, width: 20, height: 20 },
    { x: 60, y: 0, width: 20, height: 20 },
    { x: 0, y: 40, width: 20, height: 20 },
    { x: 0, y: 0, width: 0, height: 20 },
    { x: 0.5, y: 0, width: 20, height: 20 },
    { x: 0, y: 0, width: 20, height: 20, extra: true },
  ])('越界、非整数或多余字段的区域在采集之前拒绝：%j', async region => {
    const setup = sourceSetup();
    await setup.source.listSources();
    await expect(setup.source.capture({ sourceId: 'screen:1:0', region })).rejects.toMatchObject({ code: 'capture_region_invalid' });
    expect(setup.media.windows).toHaveLength(0);
  });

  it.each([undefined, { x: 4, y: 4, width: 40, height: 30 }])('同一授权不能扩大、移动或取消框选范围：%j', async region => {
    const setup = sourceSetup();
    await setup.source.listSources();
    await setup.source.capture({ sourceId: 'screen:1:0', region: { x: 8, y: 6, width: 24, height: 16 } });
    await expect(setup.source.capture({ sourceId: 'screen:1:0', region })).rejects.toMatchObject({ code: 'capture_region_changed' });
    expect(setup.media.windows).toHaveLength(1);
    expect(setup.media.windows[0].destroyed).toBe(true);
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'source_not_selected' });
  });

  it.each([-1, -10])('Windows 未知/合并显示器 ID %s 不放行', async invalidId => {
    const setup = sourceSetup();
    setup.display.id = invalidId;
    setup.setSources([{ id: 'screen:1:0', name: '外部桌面', display_id: String(invalidId), thumbnail: setup.thumbnail }]);
    expect(await setup.source.listSources()).toMatchObject([{ geometry: null, unavailableReason: 'display_identity_unproven' }]);
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'display_identity_unproven' });
  });

  it('已 abort 时完全不枚举', async () => {
    const { source, getSources } = sourceSetup();
    await expect(source.listSources({ signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'aborted' });
    expect(getSources).not.toHaveBeenCalled();
  });

  it('未完成的原生请求不排队；abort 后晚到结果不复活采集', async () => {
    const setup = sourceSetup();
    let resolveNative!: (sources: RawDesktopSource[]) => void;
    setup.getSources.mockImplementationOnce(() => new Promise(resolve => { resolveNative = resolve; }));
    const controller = new AbortController();
    const listing = setup.source.listSources({ signal: controller.signal });
    await nextTurn();
    await expect(setup.source.listSources()).rejects.toMatchObject({ code: 'busy' });
    controller.abort();
    await expect(listing).rejects.toMatchObject({ code: 'aborted' });
    await expect(setup.source.listSources()).rejects.toMatchObject({ code: 'busy' });
    resolveNative([{ id: 'screen:1:0', name: 'screen', display_id: '7' }]);
    await nextTurn();
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'source_not_selected' });
  });

  it('原生挂起有超时，stop 清除已选择来源且可幂等', async () => {
    const setup = sourceSetup({ timeoutMs: 15 });
    let resolveNative!: (sources: RawDesktopSource[]) => void;
    setup.getSources.mockImplementationOnce(() => new Promise(resolve => { resolveNative = resolve; }));
    await expect(setup.source.listSources()).rejects.toMatchObject({ code: 'timeout' });
    await setup.source.stop();
    await setup.source.stop();
    resolveNative([]);
    await nextTurn();
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'source_not_selected' });
  });

  it('不把原生异常正文暴露为错误信息', async () => {
    const setup = sourceSetup();
    setup.getSources.mockRejectedValueOnce(new Error('private-window-title'));
    await expect(setup.source.listSources()).rejects.toMatchObject({ code: 'source_enumeration_failed', message: 'source_enumeration_failed' });
  });
});

describe('隔离媒体 worker 的单屏权限与生命周期', () => {
  async function beginPending() {
    const setup = sourceSetup();
    setup.media.controls.autoFrame = false;
    await setup.source.listSources();
    const operation = setup.source.capture({ sourceId: 'screen:1:0' });
    await nextTurn();
    await nextTurn();
    await nextTurn();
    const worker = setup.media.windows[0]!;
    const command = worker.webContents.send.mock.calls.find(([, message]) => message.kind === 'capture')![1];
    return { ...setup, worker, operation, requestId: command.requestId };
  }

  it('默认与列举不创建媒体窗口，缺端口明确拒绝且没有 thumbnail 回退', async () => {
    const setup = sourceSetup({ withoutMedia: true });
    expect(setup.media.windows).toHaveLength(0);
    await setup.source.listSources();
    expect(setup.media.windows).toHaveLength(0);
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'controlled_capture_unavailable' });
    expect(setup.media.windows).toHaveLength(0);
    expect(setup.getSources.mock.calls.every(([request]) => request.thumbnailSize.width === 0 && request.thumbnailSize.height === 0)).toBe(true);
  });

  it('内存 partition、sandbox、contextIsolation、无 Node，与管理 renderer 分离', async () => {
    const setup = sourceSetup();
    await setup.source.listSources();
    await setup.source.capture({ sourceId: 'screen:1:0' });
    const worker = setup.media.windows[0]!;
    expect(worker.options).toMatchObject({ show: false, focusable: false, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, devTools: false, webviewTag: false } });
    expect(setup.media.session.fromPartition.mock.calls[0]).toEqual([expect.stringMatching(/^nuanban-capture-/), { cache: false }]);
    expect(worker.webContents.executeJavaScript).toHaveBeenCalledWith('window.nuanbanCapture.start()', true);
    expect(setup.media.sessions[0]!.setDisplayMediaRequestHandler.mock.calls[0]![1]).toEqual({ useSystemPicker: false });
  });

  it.each([{ audioRequested: true }, { videoRequested: false }, { userGesture: false }, { frame: null }, { frame: { url: 'file:///foreign.html' } }])('仅精确 worker、视频、用户动作可授权：%j', async requestChanges => {
    const setup = sourceSetup();
    setup.media.controls.requestChanges = requestChanges;
    await setup.source.listSources();
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toBeInstanceOf(ObservationError);
    await setup.source.stop();
    expect(setup.media.grants).toEqual([null]);
    expect(setup.media.windows[0]!.isDestroyed()).toBe(true);
  });

  it('显示捕获前置权限仅接受已授权 worker 的空 mediaTypes，拒绝麦克风/摄像头/子帧与重复 grant', async () => {
    const setup = sourceSetup();
    await setup.source.listSources();
    await setup.source.capture({ sourceId: 'screen:1:0' });
    const worker = setup.media.windows[0]!;
    const privateSession = setup.media.sessions[0]!;
    const details = { isMainFrame: true, requestingUrl: worker.webContents.mainFrame.url };
    expect(privateSession.permissionCheck(worker.webContents, 'display-capture', 'file://', details)).toBe(true);
    expect(privateSession.permissionCheck(worker.webContents, 'media', 'file://', { ...details, mediaTypes: [] })).toBe(true);
    const permitted = vi.fn();
    privateSession.permissionRequest(worker.webContents, 'media', permitted, { ...details, mediaTypes: [] });
    expect(permitted).toHaveBeenCalledExactlyOnceWith(true);
    for (const permission of ['audioCapture', 'videoCapture', 'notifications', 'geolocation']) expect(privateSession.permissionCheck(worker.webContents, permission, 'file://', details)).toBe(false);
    expect(privateSession.permissionCheck(worker.webContents, 'media', 'file://', { ...details, mediaTypes: ['audio'] })).toBe(false);
    expect(privateSession.permissionCheck(worker.webContents, 'media', 'file://', { ...details, mediaTypes: ['video'] })).toBe(false);
    expect(privateSession.permissionCheck(worker.webContents, 'display-capture', 'file://', { ...details, isMainFrame: false })).toBe(false);
    expect(privateSession.permissionCheck(worker.webContents, 'display-capture', 'file://', { ...details, requestingUrl: 'file:///foreign.html' })).toBe(false);
    const decision = vi.fn();
    privateSession.displayHandler({ frame: worker.webContents.mainFrame, videoRequested: true, audioRequested: false, userGesture: true }, decision);
    expect(decision).toHaveBeenCalledExactlyOnceWith(null);
    await setup.source.stop();
    expect(worker.isDestroyed()).toBe(true);
  });

  it.each([
    {}, { mediaTypes: null }, { mediaTypes: 'video' }, { mediaTypes: {} }, { mediaTypes: ['audio'] },
    { mediaTypes: ['video'] }, { mediaTypes: ['audio', 'video'] }, { mediaTypes: ['unknown'] },
    { mediaTypes: [], isMainFrame: false }, { mediaTypes: [], requestingUrl: 'file:///foreign.html' },
  ])('显示捕获前置权限拒绝设备媒体、缺失或不可信详情：%j', async changes => {
    const setup = sourceSetup();
    await setup.source.listSources();
    await setup.source.capture({ sourceId: 'screen:1:0' });
    const worker = setup.media.windows[0]!;
    const privateSession = setup.media.sessions[0]!;
    const details = { isMainFrame: true, requestingUrl: worker.webContents.mainFrame.url, ...changes };
    expect(privateSession.permissionCheck(worker.webContents, 'media', 'file://', details)).toBe(false);
    const decision = vi.fn();
    privateSession.permissionRequest(worker.webContents, 'media', decision, details);
    expect(decision).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('空 mediaTypes 不能替代本人同意，也不能借用其他窗口', async () => {
    const setup = sourceSetup();
    await setup.source.listSources();
    await setup.source.capture({ sourceId: 'screen:1:0' });
    const worker = setup.media.windows[0]!;
    const privateSession = setup.media.sessions[0]!;
    const details = { isMainFrame: true, requestingUrl: worker.webContents.mainFrame.url, mediaTypes: [] };
    const foreignDecision = vi.fn();
    privateSession.permissionRequest({}, 'media', foreignDecision, details);
    expect(foreignDecision).toHaveBeenCalledExactlyOnceWith(false);
    setup.setConsent(false);
    expect(privateSession.permissionCheck(worker.webContents, 'media', 'file://', details)).toBe(false);
    const revokedDecision = vi.fn();
    privateSession.permissionRequest(worker.webContents, 'media', revokedDecision, details);
    expect(revokedDecision).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('网络离线且仅可加载自身 HTML/JS，拒绝外网与其他 file URL', async () => {
    const setup = sourceSetup();
    await setup.source.listSources();
    await setup.source.capture({ sourceId: 'screen:1:0' });
    const worker = setup.media.windows[0]!;
    const privateSession = setup.media.sessions[0]!;
    expect(privateSession.enableNetworkEmulation).toHaveBeenCalledWith({ offline: true });
    for (const url of ['https://example.invalid/raw', 'http://localhost:3000/raw', 'wss://example.invalid', 'file:///C:/secret.png']) {
      const decision = vi.fn();
      privateSession.requestHandler({ webContentsId: worker.webContents.id, method: 'GET', url, resourceType: 'mainFrame' }, decision);
      expect(decision).toHaveBeenCalledWith({ cancel: true });
    }
    const allowed = vi.fn();
    privateSession.requestHandler({ webContentsId: worker.webContents.id, method: 'GET', url: worker.webContents.mainFrame.url, resourceType: 'mainFrame' }, allowed);
    expect(allowed).toHaveBeenCalledWith({ cancel: false });
    const foreign = vi.fn();
    privateSession.requestHandler({ webContentsId: 900, method: 'GET', url: worker.webContents.mainFrame.url, resourceType: 'mainFrame' }, foreign);
    expect(foreign).toHaveBeenCalledWith({ cancel: true });
  });

  it.each(['token', 'generation', 'sourceId', 'sourceIdentity', 'requestId', 'sender', 'senderFrame'])('拒绝旧帧/跨源/跨 renderer 的 %s 且清零来包', async field => {
    const setup = await beginPending();
    const changes = { [field]: field === 'generation' ? -1 : 'foreign' };
    setup.worker.frame(setup.requestId, ['sender', 'senderFrame'].includes(field) ? {} : changes, ['sender', 'senderFrame'].includes(field) ? changes : {});
    expect(setup.media.controls.lastPixels!.every(byte => byte === 0)).toBe(true);
    let settled = false;
    void setup.operation.then(() => { settled = true; });
    await nextTurn();
    expect(settled).toBe(false);
    setup.worker.frame(setup.requestId);
    const captured = await setup.operation;
    expect(captured.frameId).toBe(setup.requestId);
    expect(captured.frameHash).toBe(createHash('sha256').update(captured.png).digest('hex'));
  });

  it('IPC 原始 PNG 超限立即失效、清零、停止，无再次自动捕获', async () => {
    const setup = sourceSetup({ limits: { maxPngBytes: 64 } });
    await setup.source.listSources();
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'capture_ipc_limit' });
    expect(setup.media.controls.lastPixels!.every(byte => byte === 0)).toBe(true);
    expect(setup.onCaptureInvalidated).toHaveBeenCalledWith({ reason: 'capture_ipc_limit', sourceId: 'screen:1:0', generation: 1 });
    await setup.source.stop();
    await nextTurn();
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'source_not_selected' });
    expect(setup.media.windows).toHaveLength(1);
  });

  it.each(['ended', 'renderer-gone', 'navigation', 'error'])('%s 立即失效停流，不自动重连', async event => {
    const setup = sourceSetup();
    await setup.source.listSources();
    await setup.source.capture({ sourceId: 'screen:1:0' });
    const worker = setup.media.windows[0]!;
    if (event === 'renderer-gone') worker.webContents.emit('render-process-gone');
    else if (event === 'navigation') worker.webContents.emit('will-frame-navigate', { preventDefault: vi.fn() });
    else worker.packet({ kind: event, reason: 'capture_worker_failed' });
    await setup.source.stop();
    expect(worker.isDestroyed()).toBe(true);
    expect(setup.onCaptureInvalidated).toHaveBeenCalledTimes(1);
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'source_not_selected' });
    expect(setup.media.windows).toHaveLength(1);
  });

  it.each(['consent', 'source-lost'])('已有流在前置 %s 失败时同样关闭', async failure => {
    const setup = sourceSetup();
    await setup.source.listSources();
    await setup.source.capture({ sourceId: 'screen:1:0' });
    if (failure === 'consent') setup.setConsent(false);
    else setup.setSources([]);
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: failure === 'consent' ? 'consent_required' : 'source_lost' });
    expect(setup.media.windows[0]!.isDestroyed()).toBe(true);
  });

  it('初始化失败也清理窗口与上下文，必须显式列举才能重新启动', async () => {
    const setup = sourceSetup();
    setup.media.controls.failSetup = true;
    await setup.source.listSources();
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'controlled_capture_unavailable' });
    await setup.source.stop();
    await nextTurn();
    expect(setup.media.windows[0]!.isDestroyed()).toBe(true);
    setup.media.controls.failSetup = false;
    await setup.source.listSources();
    await setup.source.capture({ sourceId: 'screen:1:0' });
    expect(setup.media.windows).toHaveLength(2);
  });

  it('pending capture 不排队，abort 停止并等待实际关闭，晚回包无法复活', async () => {
    const setup = await beginPending();
    const rejected = expect(setup.operation).rejects.toMatchObject({ code: 'aborted' });
    await expect(setup.source.capture({ sourceId: 'screen:1:0' })).rejects.toMatchObject({ code: 'busy' });
    setup.media.controls.delayClose = true;
    let stopped = false;
    const stop = setup.source.stop().then(() => { stopped = true; });
    await nextTurn();
    expect(stopped).toBe(false);
    setup.worker.frame(setup.requestId);
    setup.worker.closeNow();
    await stop;
    await rejected;
    expect(stopped).toBe(true);
    expect(setup.media.ipcMain.listenerCount(setup.worker.configuration.channel)).toBe(0);
    await setup.source.stop();
  });

  it('worker 源码无网络/文件/第三方注入，音频始终 false，CSP 关闭出口', () => {
    const worker = readFileSync('apps/desktop/observation/capture-worker.js', 'utf8');
    const preload = readFileSync('apps/desktop/observation/capture-worker-preload.cjs', 'utf8');
    const html = readFileSync('apps/desktop/observation/capture-worker.html', 'utf8');
    expect(worker).toContain('getDisplayMedia({ audio: false');
    expect(worker).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|writeFile|capturePage|desktopCapturer|console\./);
    expect(preload).not.toMatch(/fetch\(|writeFile|console\.|exposeInMainWorld\('(?:ipcRenderer|require)'/);
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("default-src 'none'");
  });
});

describe('捕获 worker 的真实页面脚本时序（合成媒体，不读取桌面）', () => {
  function workerSetup() {
    let frameSequence = 0;
    const clock = { now: 1234, delayEncoding: false, pendingEncoding: null as (() => void) | null };
    let command: (input: { kind: string; requestId?: string }) => void = () => {};
    const configuration = { width: 98, height: 74, minWidth: 97, maxWidth: 98, minHeight: 73, maxHeight: 74, maxDimension: 8192, maxPixels: 16_777_216, maxPngBytes: 24 * 1024 * 1024 };
    const track = { readyState: 'live', applyConstraints: vi.fn(async (_input: unknown) => {}), stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
    const video = { videoWidth: 97, videoHeight: 73, srcObject: null, muted: false, play: vi.fn(async () => {}), pause: vi.fn(),
      requestVideoFrameCallback: vi.fn((callback: () => void) => { setImmediate(callback); return ++frameSequence; }), cancelVideoFrameCallback: vi.fn() };
    const drawing = { drawImage: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: () => drawing, toBlob: (callback: (blob: unknown) => void) => {
      const blob = { size: 33, arrayBuffer: async () => new ArrayBuffer(33) };
      if (clock.delayEncoding) clock.pendingEncoding = () => callback(blob);
      else callback(blob);
    } };
    const host = { configuration, post: vi.fn(), onCommand: (callback: typeof command) => { command = callback; } };
    const window = { captureHost: host, addEventListener: vi.fn(), nuanbanCapture: undefined as { start(): Promise<boolean>; stop(): boolean } | undefined };
    const getDisplayMedia = vi.fn(async (_input: unknown) => stream);
    class ControlledDate extends Date { static now() { return clock.now; } }
    runInNewContext(readFileSync('apps/desktop/observation/capture-worker.js', 'utf8'), { window, document: { getElementById: (identifier: string) => identifier === 'capture-video' ? video : canvas }, navigator: { mediaDevices: { getDisplayMedia } }, ArrayBuffer, Uint8Array, Date: ControlledDate });
    return { worker: window.nuanbanCapture!, track, video, host, getDisplayMedia, clock, command: (input: Parameters<typeof command>[0]) => command(input) };
  }

  it('取得授权流后才申请低帧率刷新，静止画面不依赖页面动画或第二次共享授权', async () => {
    const setup = workerSetup();
    expect(await setup.worker.start()).toBe(true);
    expect(setup.getDisplayMedia).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ audio: false }));
    expect(setup.track.applyConstraints).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ frameRate: { min: 2, ideal: 2, max: 5 }, resizeMode: 'none' }));
    expect(setup.host.post).toHaveBeenCalledWith('ready', { width: 97, height: 73 });
    setup.command({ kind: 'capture', requestId: 'first' });
    await nextTurn();
    expect(setup.host.post).toHaveBeenCalledWith('frame', expect.objectContaining({ requestId: 'first', width: 97, height: 73 }));
    setup.command({ kind: 'capture', requestId: 'second' });
    await nextTurn();
    expect(setup.host.post).toHaveBeenCalledWith('frame', expect.objectContaining({ requestId: 'second', width: 97, height: 73 }));
    expect(setup.getDisplayMedia).toHaveBeenCalledOnce();
    setup.worker.stop();
    expect(setup.track.stop).toHaveBeenCalledOnce();
  });

  it('帧时间固定在视频帧到达时，不被后续 PNG 编码等待刷新', async () => {
    const setup = workerSetup();
    expect(await setup.worker.start()).toBe(true);
    setup.clock.now = 2000;
    setup.clock.delayEncoding = true;
    setup.command({ kind: 'capture', requestId: 'first' });
    await vi.waitFor(() => expect(setup.clock.pendingEncoding).toBeTypeOf('function'));
    setup.clock.now = 9000;
    setup.clock.pendingEncoding!();
    await nextTurn();
    expect(setup.host.post).toHaveBeenCalledWith('frame', expect.objectContaining({ requestId: 'first', capturedAt: 2000 }));
    setup.worker.stop();
  });

  it('刷新约束未完成前不播放或报告 ready，撤销后不能晚到恢复', async () => {
    const setup = workerSetup();
    let resolveConstraints!: () => void;
    setup.track.applyConstraints.mockImplementationOnce(() => new Promise<void>(resolve => { resolveConstraints = resolve; }));
    const starting = setup.worker.start();
    await nextTurn();
    expect(setup.video.play).not.toHaveBeenCalled();
    expect(setup.host.post).not.toHaveBeenCalledWith('ready', expect.anything());
    setup.worker.stop();
    resolveConstraints();
    expect(await starting).toBe(false);
    expect(setup.video.play).not.toHaveBeenCalled();
    expect(setup.track.stop).toHaveBeenCalledOnce();
  });

  it('无法取得持续新帧时停止真实流，不以旧截图或异常正文掩盖失败', async () => {
    const setup = workerSetup();
    setup.track.applyConstraints.mockRejectedValueOnce(new Error('private-error-content'));
    expect(await setup.worker.start()).toBe(false);
    expect(setup.host.post).toHaveBeenCalledWith('error', { reason: 'capture_refresh_unavailable' });
    expect(setup.video.play).not.toHaveBeenCalled();
    expect(setup.track.stop).toHaveBeenCalledOnce();
    expect(JSON.stringify(setup.host.post.mock.calls)).not.toContain('private-error-content');
  });
});

describe('Windows 本地 OCR/人脸检测与内存脱敏', () => {
  it('未授权的检测、附件与窗口不读取系统桌面或任务栏', async () => {
    const setup = helperSetup();
    await setup.detector().detect(frame());
    expect(setup.children[0]!.request).not.toHaveProperty('shellGeometry');
    const detector = setup.detector({ canReadShellControls: () => true });
    await detector.detectAttachment(frame({ sourceId: 'attachment:12345678-1234-4234-8234-123456789abc', sourceIdentity: undefined, geometry: null }));
    expect(setup.children[1]!.request).not.toHaveProperty('shellGeometry');
    await detector.detect(frame({ sourceId: 'window:1:0' }));
    expect(setup.children[2]!.request).not.toHaveProperty('shellGeometry');
  });

  it('只读取本次授权真实采集的帧，停止、重新列出来源和伪造副本不借用桌面权限', async () => {
    const setup = helperSetup();
    const source = sourceSetup();
    const port = createWindowsObservationSource({ nativeImage, platform: 'win32', desktopCapturer: { getSources: source.getSources }, screen: source.screen,
      ...source.media.ports, now: () => 1234, canCapture: source.canCapture, detectorOptions: { spawn: setup.spawn as unknown as typeof nodeSpawn } });
    openedSources.push(port);
    await port.listSources();
    const captured = await port.capture({ sourceId: 'screen:1:0' });
    await port.detect({ ...captured });
    expect(setup.children.at(-1)!.request).not.toHaveProperty('shellGeometry');
    await port.detect(captured);
    expect(setup.children.at(-1)!.request!.shellGeometry).toEqual(captured.geometry);
    await port.detect(captured);
    expect(setup.children.at(-1)!.request).not.toHaveProperty('shellGeometry');
    const obsolete = await port.capture({ sourceId: 'screen:1:0' });
    await port.stop();
    await port.listSources();
    await port.detect(obsolete);
    expect(setup.children.at(-1)!.request).not.toHaveProperty('shellGeometry');
  });

  it.each([1, 1.5, 2])('原生公共图标坐标在 %s 倍缩放和负屏幕原点下映射到本帧，不透出私有属性', async scale => {
    const input = frame({ geometry: geometry({ width: Math.round(64 / scale), height: Math.round(48 / scale), scaleFactor: scale }) });
    const bounds = { x: input.geometry!.pixelX + 12, y: input.geometry!.pixelY + 20, width: 24, height: 24 };
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), shellControls: [{ label: '微信', surface: 'taskbar', rect: bounds, privateTitle: 'never-return-this' }] }));
    const result = await setup.detector({ canReadShellControls: () => true }).detect(input);
    expect(result).toMatchObject({ status: 'complete', shellControls: [{ label: '微信', surface: 'taskbar', rect: { x: 12, y: 20, width: 24, height: 24 } }] });
    expect(JSON.stringify(result)).not.toContain('never-return-this');
  });

  it.each(['WeGame', '原神', 'Google Chrome', '这一条软件名称仍在六十四字以内'.repeat(2)] as const)('任意 UIA 名称都作为候选上报，不再要求白名单：%s', async rawLabel => {
    const input = frame({ geometry: geometry({ width: 64, height: 48, scaleFactor: 1 }) });
    const bounds = { x: input.geometry!.pixelX + 12, y: input.geometry!.pixelY + 20, width: 24, height: 24 };
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), shellControls: [{ label: rawLabel, surface: 'desktop', rect: bounds }] }));
    const result = await setup.detector({ canReadShellControls: () => true }).detect(input);
    expect(result).toMatchObject({ status: 'complete', shellControls: [{ label: rawLabel, surface: 'desktop', rect: { x: 12, y: 20, width: 24, height: 24 } }] });
  });

  it('名称清洗后再上报：去控制字符、折叠空白并按 NFKC 归一，同名同位置只上报一次', async () => {
    const input = frame();
    const bounds = { x: input.geometry!.pixelX + 12, y: input.geometry!.pixelY + 20, width: 24, height: 24 };
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), shellControls: [
      { label: '  WeGame\u0007  ', surface: 'desktop', rect: bounds },
      { label: '  WeGame\u0007  ', surface: 'desktop', rect: bounds },
      { label: 'ＷｅＧａｍｅ', surface: 'desktop', rect: bounds },
      { label: 'ＡＢＣ', surface: 'desktop', rect: { ...bounds, x: bounds.x + 28 } },
      { label: 'C'.repeat(80), surface: 'taskbar', rect: { x: bounds.x, y: input.geometry!.pixelY + 4, width: 24, height: 24 } },
    ] }));
    const result = await setup.detector({ canReadShellControls: () => true }).detect(input);
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') throw new Error('expected complete detection');
    expect(result.shellControls).toEqual([
      { label: 'WeGame', surface: 'desktop', rect: { x: 12, y: 20, width: 24, height: 24 } },
      { label: 'ABC', surface: 'desktop', rect: { x: 40, y: 20, width: 24, height: 24 } },
      { label: 'C'.repeat(64), surface: 'taskbar', rect: { x: 12, y: 4, width: 24, height: 24 } },
    ]);
  });

  it.each(['unrequested', 'blank', 'symbols', 'control', 'overlong', 'nonstring', 'surface', 'bounds', 'nonfinite', 'overflow', 'array'] as const)('拒绝伪造或越过授权范围的图标：%s', async condition => {
    const input = frame();
    const control: { label: unknown; surface: unknown; rect: { x: number; y: number; width: number; height: number } } = { label: '微信', surface: 'taskbar', rect: { x: input.geometry!.pixelX + 12, y: input.geometry!.pixelY + 12, width: 24, height: 24 } };
    if (condition === 'blank') control.label = '   ';
    if (condition === 'symbols') control.label = '...';
    if (condition === 'control') control.label = '\u0000\u0007\u001f';
    if (condition === 'overlong') control.label = 'WeGame'.repeat(50);
    if (condition === 'nonstring') control.label = 42;
    if (condition === 'surface') control.surface = 'private-window';
    if (condition === 'bounds') control.rect.x = input.geometry!.pixelX - 1;
    if (condition === 'nonfinite') control.rect.width = Number.NaN;
    const controls = condition === 'overflow' ? Array.from({ length: 129 }, () => control) : condition === 'array' ? {} : [control];
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), shellControls: controls }));
    const result = await setup.detector({ canReadShellControls: () => condition !== 'unrequested' }).detect(input);
    expect(result.status).toBe('failed');
    expect(result).not.toHaveProperty('sanitizedPng');
  });

  it('所有原生脚本均能由 Windows PowerShell 5 按 ASCII 读取，不因中文无 BOM 导致解析失败', () => {
    expect(readFileSync(new URL('../../apps/desktop/observation/windows-shell-controls.ps1', import.meta.url), 'utf8')).not.toMatch(/[^\x00-\x7f]/u);
  });

  it('先验证框选/屏幕范围再读取控件名称，不读取范围外软件入口的完整名称', () => {
    const script = readFileSync(new URL('../../apps/desktop/observation/windows-shell-controls.ps1', import.meta.url), 'utf8');
    const scopeCheck = script.indexOf('if ($bounds.X -lt $Geometry.pixelX');
    const nameRead = script.indexOf('$name = $element.Current.Name');
    expect(scopeCheck).toBeGreaterThan(0);
    expect(scopeCheck).toBeLessThan(nameRead);
  });

  it('在加载 Shell 检测函数前初始化 Windows PowerShell 5 的 UI Automation 类型', () => {
    const script = readFileSync(new URL('../../apps/desktop/observation/windows-local-analysis.ps1', import.meta.url), 'utf8');
    const geometryCheck = script.indexOf("throw [System.IO.InvalidDataException]::new('shell_geometry_invalid')");
    const clientLoad = script.indexOf('Add-Type -AssemblyName UIAutomationClient');
    const typesLoad = script.indexOf('Add-Type -AssemblyName UIAutomationTypes');
    const detectorLoad = script.indexOf(". (Join-Path $PSScriptRoot 'windows-shell-controls.ps1')");
    expect(geometryCheck).toBeGreaterThan(0);
    expect(clientLoad).toBeGreaterThan(geometryCheck);
    expect(typesLoad).toBeGreaterThan(geometryCheck);
    expect(detectorLoad).toBeGreaterThan(clientLoad);
    expect(detectorLoad).toBeGreaterThan(typesLoad);
  });

  it('选图通过独立附件入口检测，不冒充屏幕或借用屏幕坐标', async () => {
    const setup = helperSetup();
    const detector = setup.detector();
    const attachment = frame({ sourceId: 'attachment:12345678-1234-4234-8234-123456789abc', sourceIdentity: undefined, geometry: null });
    expect(await detector.detect(attachment)).toMatchObject({ status: 'failed', reason: 'frame_invalid' });
    expect(setup.spawn).not.toHaveBeenCalled();
    expect(await detector.detectAttachment(attachment)).toMatchObject({ status: 'complete', sourceId: attachment.sourceId });
    expect(await detector.detectAttachment({ ...attachment, geometry: geometry() })).toMatchObject({ status: 'failed', reason: 'attachment_source_invalid' });
    expect(await detector.detectAttachment(frame())).toMatchObject({ status: 'failed', reason: 'frame_invalid' });
  });

  it('完整但空的检测不人为修改图像求取不同哈希', async () => {
    const setup = helperSetup();
    const input = frame();
    const result = await setup.detector().detect(input);
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') throw new Error('missing complete detection');
    expect(result.words).toEqual([]);
    expect(result.faces).toEqual([]);
    expect(result.sanitizedPng).toEqual(input.png);
    expect(result.sanitizedFrameHash).toBe(input.frameHash);
    expect(result).not.toHaveProperty('safe');
  });

  it('全帧原始 PNG 只经隐藏 helper stdin，正文与图像不进入进程参数', async () => {
    const setup = helperSetup();
    const input = frame();
    const detector = setup.detector();
    const result = await detector.detect(input);
    expect(result.status).toBe('complete');
    const request = setup.children[0]!.request!;
    expect(Buffer.from(request.pngBase64, 'base64')).toEqual(input.png);
    expect(request).toMatchObject({ sourceId: input.sourceId, frameHash: input.frameHash, width: 64, height: 48 });
    const call = setup.spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(call[0]).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    expect(call[1]).toContain('Hidden');
    expect(call[1]).toContain('-NoProfile');
    expect(call[1].join(' ')).not.toContain(request.pngBase64);
    expect(call[2]).toMatchObject({ shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it('遮盖全部 OCR 文字和全帧右下人脸；非文字结构保留、原 PNG 不变', async () => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), words: [{ text: '普通按钮也遮盖', rect: { x: 4, y: 5, width: 8, height: 6 } }], faces: [{ rect: { x: 54, y: 38, width: 10, height: 10 } }] }));
    const input = frame();
    const original = Buffer.from(input.png);
    const result = await setup.detector().detect(input);
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') throw new Error('missing complete detection');
    const pixels = decodePng(result.sanitizedPng).bitmap;
    const pixelAt = (column: number, row: number) => [...pixels.subarray((row * 64 + column) * 4, (row * 64 + column) * 4 + 4)];
    expect(pixelAt(5, 6)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(63, 47)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(30, 20)).toEqual([40, 70, 90, 255]);
    expect(result.redaction).toEqual({ text: true, faces: true });
    expect(result.frameHash).toBe(input.frameHash);
    expect(result.sanitizedFrameHash).toBe(createHash('sha256').update(result.sanitizedPng).digest('hex'));
    expect(input.png).toEqual(original);
    expect(result).not.toHaveProperty('safe');
    expect(result).not.toHaveProperty('outboundAllowed');
  });

  it('像素矩形映射至负 DIP，而不是把负全局坐标当越界', async () => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), words: [{ text: '打开', rect: { x: 20, y: 10, width: 8, height: 6 } }] }));
    const input = frame({ geometry: geometry({ width: 32, height: 24, scaleFactor: 2 }) });
    const result = await setup.detector().detect(input);
    expect(result).toMatchObject({ status: 'complete', words: [{ rect: { x: 20, y: 10, width: 8, height: 6 }, globalRect: { x: -54, y: -43, width: 4, height: 3 } }] });
  });

  it('DPI 边界取整后的控件按真实媒体像素比例映射至完整 DIP', async () => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), words: [{ text: '打开', rect: { x: 16, y: 12, width: 32, height: 24 } }] }));
    const input = frame({ geometry: geometry({ width: 43, height: 32, scaleFactor: 1.5 }) });
    const result = await setup.detector().detect(input);
    expect(result).toMatchObject({ status: 'complete', words: [{ globalRect: { x: -53.25, y: -40, width: 21.5, height: 16 } }] });
  });

  it('geometry:null 时仍可完成全图检测，但绝不捏造全局映射', async () => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), faces: [{ rect: { x: 10, y: 10, width: 10, height: 10 } }] }));
    const result = await setup.detector().detect(frame({ geometry: null }));
    expect(result.status).toBe('complete');
    expect(result.faces[0]).not.toHaveProperty('globalRect');
  });

  it.each([
    { ocrStatus: 'unavailable' },
    { faceStatus: 'unavailable' },
    { words: undefined },
    { faces: undefined },
  ])('缺失任一检测不得伪装 complete：%j', async changes => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), ...changes }));
    const result = await setup.detector().detect(frame());
    expect(result).toMatchObject({ status: 'failed', reason: 'detector_incomplete', redaction: { text: false, faces: false } });
    expect(result).not.toHaveProperty('sanitizedPng');
  });

  it.each([
    { frameHash: 'f'.repeat(64) },
    { sourceId: 'screen:2:0' },
    { sourceIdentity: '2'.repeat(64) },
  ])('不同帧/源的结果不能复用：%j', async changes => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), ...changes }));
    const result = await setup.detector().detect(frame());
    expect(result).toMatchObject({ status: 'failed', reason: 'detector_frame_mismatch' });
    expect(result).not.toHaveProperty('sanitizedPng');
  });

  it.each([{ width: 63 }, { height: 47 }])('helper 图像尺寸不一致拒绝：%j', async changes => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), ...changes }));
    expect(await setup.detector().detect(frame())).toMatchObject({ status: 'failed', reason: 'detector_dimensions_mismatch' });
  });

  it.each([
    { x: -1, y: 0, width: 5, height: 5 },
    { x: 0, y: -1, width: 5, height: 5 },
    { x: 63, y: 0, width: 2, height: 5 },
    { x: 0, y: 47, width: 5, height: 2 },
    { x: 0, y: 0, width: 0, height: 5 },
    { x: 0, y: 0, width: 5, height: Number.POSITIVE_INFINITY },
  ])('OCR 像素矩形越界/无效拒绝：%j', async rect => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), words: [{ text: '文字', rect }] }));
    const result = await setup.detector().detect(frame());
    expect(result).toMatchObject({ status: 'failed', reason: 'detection_rect_out_of_bounds' });
    expect(result).not.toHaveProperty('sanitizedPng');
  });

  it('人脸矩形也必须在完整原帧内', async () => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), faces: [{ rect: { x: 60, y: 40, width: 8, height: 8 } }] }));
    expect(await setup.detector().detect(frame())).toMatchObject({ status: 'failed', reason: 'detection_rect_out_of_bounds' });
  });

  it.each([
    { status: 'unavailable', reason: 'ocr_language_unavailable' },
    { status: 'unavailable', reason: 'face_detection_unavailable' },
    { status: 'failed', reason: 'ocr_detect:MethodInvocationException:0x80131604' },
  ])('真实服务不可用/异常保留具体原因：%j', async response => {
    const setup = helperSetup((_request, child) => child.reply({ protocol: 1, ...response }));
    const input = frame();
    const result = await setup.detector().detect(input);
    expect(result).toMatchObject({ ...response, frameHash: input.frameHash, words: [], faces: [] });
    expect(result).not.toHaveProperty('sanitizedPng');
  });

  it.each([
    ['frame_hash_mismatch', () => frame({ frameHash: '0'.repeat(64) })],
    ['image_dimensions_mismatch', () => frame({ width: 63 })],
    ['geometry_unproven', () => frame({ geometry: geometry({ scaleFactor: 2 }) })],
    ['png_invalid', () => frame({ png: Buffer.from('not-png') })],
  ] as const)('输入 %s 在 helper 启动前拒绝', async (reason, makeFrame) => {
    const setup = helperSetup();
    const result = await setup.detector().detect(makeFrame());
    expect(result).toMatchObject({ status: 'failed', reason });
    expect(setup.spawn).not.toHaveBeenCalled();
  });

  it('缺少 NativeImage 直接不可用，不启动 helper', async () => {
    const setup = helperSetup();
    expect(await setup.detector({ nativeImage: undefined }).detect(frame())).toMatchObject({ status: 'unavailable', reason: 'native_image_unavailable' });
    expect(setup.spawn).not.toHaveBeenCalled();
  });

  it('对正在检测的输入作内存快照，不因调用方清零而检测别帧', async () => {
    const setup = helperSetup(null);
    const input = frame();
    const original = Buffer.from(input.png);
    const pending = setup.detector().detect(input);
    await nextTurn();
    input.png.fill(0);
    const child = setup.children[0]!;
    expect(Buffer.from(child.request!.pngBase64, 'base64')).toEqual(original);
    child.reply(completeReply(child.request!));
    expect(await pending).toMatchObject({ status: 'complete', frameHash: input.frameHash });
  });

  it('NativeImage 解码后真实尺寸/bitmap 长度再次核验', async () => {
    const setup = helperSetup();
    const badNative = { ...nativeImage, createFromBuffer: () => ({ ...nativeImage.createFromBuffer(frame().png), toBitmap: () => Buffer.alloc(1) }) };
    expect(await setup.detector({ nativeImage: badNative }).detect(frame())).toMatchObject({ status: 'failed', reason: 'bitmap_dimensions_mismatch' });
  });

  it('输出 PNG 宽高与原帧不一致时拒绝', async () => {
    const setup = helperSetup();
    const invalidPng = encodePng(Buffer.alloc(4), 1, 1);
    const badNative = { ...nativeImage, createFromBitmap: () => ({ ...memoryImage(Buffer.alloc(4), 1, 1), toPNG: () => invalidPng }) };
    expect(await setup.detector({ nativeImage: badNative }).detect(frame())).toMatchObject({ status: 'failed', reason: 'redaction_dimensions_mismatch' });
    expect(invalidPng.every(byte => byte === 0)).toBe(true);
  });

  it('拒绝无界 OCR/人脸输出', async () => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), faces: Array.from({ length: 513 }, () => ({ rect: { x: 0, y: 0, width: 1, height: 1 } })) }));
    expect(await setup.detector().detect(frame())).toMatchObject({ status: 'failed', reason: 'detector_output_limit' });
  });

  it('probe 仅探测 WinRT，不要求授权、不枚举或抓取屏幕', async () => {
    const setup = helperSetup((request, child) => {
      expect(request.operation).toBe('probe');
      expect(request).not.toHaveProperty('pngBase64');
      child.reply({ protocol: 1, status: 'complete', ocrStatus: 'available', faceStatus: 'available', languages: ['zh-Hans-CN'], recognizerLanguage: 'zh-Hans-CN', maxImageDimension: 10000, faceFormats: ['Gray8'], powershellVersion: '5.1.26100.9711' });
    });
    expect(await setup.detector({ nativeImage: undefined }).probe()).toMatchObject({ status: 'complete', ocr: { status: 'available', languages: ['zh-Hans-CN'] }, face: { status: 'available' } });
  });

  it('非 Windows 绝不假称可用', async () => {
    const setup = helperSetup();
    expect(await setup.detector({ platform: 'linux' }).probe()).toEqual({ status: 'unavailable', reason: 'windows_analysis_unavailable' });
    expect(setup.spawn).not.toHaveBeenCalled();
  });

  it('helper 无法启动时保留不可用原因，不生成模拟检测', async () => {
    const detector = createWindowsLocalDetector({ nativeImage, platform: 'win32', spawn: (() => { throw new Error('private-error'); }) as unknown as typeof nodeSpawn });
    const result = await detector.detect(frame());
    expect(result).toMatchObject({ status: 'unavailable', reason: 'helper_spawn_unavailable', redaction: { text: false, faces: false } });
    expect(result).not.toHaveProperty('sanitizedPng');
  });
});

describe('Windows 多尺度本地 OCR（合成 helper，不读取桌面）', () => {
  it('2 倍词框映回原帧及负 DIP，全部尺度文字与人脸均遮盖且原 PNG 不变', async () => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request),
      words: [{ text: '原尺度文字', rect: { x: 4, y: 5, width: 8, height: 6 } }],
      ocrPasses: [scaledOcrPass({ words: [
        { text: '微信', rect: { x: 81, y: 41, width: 15, height: 11 } },
        { text: '非控件文字', rect: { x: 112, y: 84, width: 16, height: 12 } },
      ] })], faces: [{ rect: { x: 4, y: 34, width: 4, height: 4 } }] }));
    const input = frame({ geometry: geometry({ width: 32, height: 24, scaleFactor: 2 }) });
    const original = Buffer.from(input.png);
    const result = await setup.detector().detect(input);
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') throw new Error('missing multiscale detection');
    expect(result.words).toEqual([
      { text: '原尺度文字', rect: { x: 4, y: 5, width: 8, height: 6 }, globalRect: { x: -62, y: -45.5, width: 4, height: 3 } },
      { text: '微信', ocrPass: 1, textAngle: 0, rect: { x: 40.5, y: 20.5, width: 7.5, height: 5.5 }, globalRect: { x: -43.75, y: -37.75, width: 3.75, height: 2.75 } },
      { text: '非控件文字', ocrPass: 1, textAngle: 0, rect: { x: 56, y: 42, width: 8, height: 6 }, globalRect: { x: -36, y: -27, width: 4, height: 3 } },
    ]);
    const sanitized = decodePng(result.sanitizedPng);
    expect(sanitized).toMatchObject({ width: 64, height: 48 });
    const pixelAt = (column: number, row: number) => [...sanitized.bitmap.subarray((row * 64 + column) * 4, (row * 64 + column) * 4 + 4)];
    for (const rect of [
      { x: 1, y: 2, width: 14, height: 12 },
      { x: 37, y: 17, width: 14, height: 12 },
      { x: 53, y: 39, width: 11, height: 9 },
      { x: 0, y: 30, width: 12, height: 12 },
    ]) {
      for (let row = rect.y; row < rect.y + rect.height; row += 1) {
        for (let column = rect.x; column < rect.x + rect.width; column += 1) expect(pixelAt(column, row)).toEqual([0, 0, 0, 255]);
      }
    }
    expect(pixelAt(25, 20)).toEqual([40, 70, 90, 255]);
    expect(result.redaction).toEqual({ text: true, faces: true });
    expect(result.frameHash).toBe(input.frameHash);
    expect(result.sanitizedFrameHash).toBe(createHash('sha256').update(result.sanitizedPng).digest('hex'));
    expect(result.sanitizedPng).not.toEqual(original);
    expect(input.png).toEqual(original);
    expect(setup.spawn).toHaveBeenCalledTimes(1);
  });

  it.each([[80, 60], [95, 71], [127, 95], [128, 96]])('受限缩放 %s × %s 的取整词框按各轴真实尺寸映回原帧边缘', async (width, height) => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), ocrPasses: [scaledOcrPass({ width, height,
      words: [{ text: '微信', rect: { x: width - 9, y: height - 7, width: 9, height: 7 } }] })] }));
    const result = await setup.detector().detect(frame());
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') throw new Error('missing rounded scale detection');
    expect(result.words).toHaveLength(1);
    const rect = result.words[0]!.rect;
    expect(rect.x).toBeCloseTo((width - 9) * 64 / width);
    expect(rect.y).toBeCloseTo((height - 7) * 48 / height);
    expect(rect.width).toBeCloseTo(9 * 64 / width);
    expect(rect.height).toBeCloseTo(7 * 48 / height);
    expect(rect.x + rect.width).toBeCloseTo(64);
    expect(rect.y + rect.height).toBeCloseTo(48);
  });

  it('放大补识别没有 geometry 时不生成全局坐标', async () => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), ocrPasses: [scaledOcrPass()] }));
    const result = await setup.detector().detect(frame({ geometry: null }));
    expect(result).toMatchObject({ status: 'complete', words: [{ text: '微信', ocrPass: 1, rect: { x: 20, y: 10, width: 8, height: 6 } }] });
    expect(result.words[0]).not.toHaveProperty('globalRect');
  });

  it.each([{ ocrPasses: undefined }, { ocrPasses: [] }, { ocrPasses: [scaledOcrPass({ words: [] })] }])('缺少补识别或补识别无词时保留原尺度结果：%j', async changes => {
    const word = { text: '设置', rect: { x: 4, y: 5, width: 8, height: 6 } };
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), words: [word], ...changes }));
    const result = await setup.detector().detect(frame());
    expect(result.status).toBe('complete');
    expect(result.words).toEqual([{ ...word, globalRect: { x: -60, y: -43, width: 8, height: 6 } }]);
  });

  it.each([[0, 90], [90, 0], [0, -90]])('各尺度独立使用角度（原尺度 %s，补识别 %s），不漏遮盖或继承另一尺度旋转', async (baseAngle, passAngle) => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), textAngle: baseAngle,
      words: [{ text: '设置', rect: { x: 30, y: 22, width: 4, height: 4 } }],
      ocrPasses: [scaledOcrPass({ textAngle: passAngle, words: [{ text: '微信', rect: { x: 100, y: 40, width: 8, height: 8 } }] })] }));
    const result = await setup.detector().detect(frame());
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') throw new Error('missing rotated scale detection');
    const pixels = decodePng(result.sanitizedPng).bitmap;
    const pixelAt = (column: number, row: number) => [...pixels.subarray((row * 64 + column) * 4, (row * 64 + column) * 4 + 4)];
    expect(result.words[1]).toMatchObject({ ocrPass: 1, textAngle: passAngle, rect: { x: 50, y: 20, width: 4, height: 4 } });
    expect(pixelAt(51, 21)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(30, 4)).toEqual(passAngle === 0 ? [40, 70, 90, 255] : [0, 0, 0, 255]);
    expect(pixelAt(10, 10)).toEqual([40, 70, 90, 255]);
  });

  it.each([
    { name: '对象', passes: {} },
    { name: '字符串', passes: 'invalid' },
    { name: '布尔值', passes: false },
    { name: '数字', passes: 1 },
    { name: '空 pass', passes: [null] },
    { name: '缺字段 pass', passes: [{}] },
    { name: '超过一个 pass', passes: [scaledOcrPass(), scaledOcrPass()] },
  ])('无效 ocrPasses 结构本地拒绝：$name', async ({ passes }) => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), ocrPasses: passes }));
    const result = await setup.detector().detect(frame());
    expect(result).toMatchObject({ status: 'failed', reason: 'ocr_pass_invalid', words: [], redaction: { text: false, faces: false } });
    expect(result).not.toHaveProperty('sanitizedPng');
  });

  it.each([
    { width: undefined }, { height: undefined }, { width: '128' }, { width: 128.5 }, { height: 95.5 },
    { width: 0 }, { height: 0 }, { width: 64, height: 48 }, { width: 32, height: 24 },
    { width: 128, height: 48 }, { width: 64, height: 96 }, { width: 129, height: 96 }, { width: 128, height: 97 },
    { width: 128, height: 80 }, { width: 80, height: 96 },
  ])('补识别必须是同宽高比且不超过 2 倍的整数放大尺寸：%j', async changes => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), ocrPasses: [scaledOcrPass(changes)] }));
    const result = await setup.detector().detect(frame());
    expect(result).toMatchObject({ status: 'failed', reason: 'ocr_pass_invalid', words: [], redaction: { text: false, faces: false } });
    expect(result).not.toHaveProperty('sanitizedPng');
  });

  it('补识别像素数不能绕过本地 maxPixels 限额', async () => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), ocrPasses: [scaledOcrPass()] }));
    const result = await setup.detector({ limits: { maxPixels: 10_000 } }).detect(frame());
    expect(result).toMatchObject({ status: 'failed', reason: 'ocr_pass_invalid' });
    expect(result).not.toHaveProperty('sanitizedPng');
  });

  it.each([{ words: undefined }, { words: null }, { words: 'invalid' }, { words: {} }])('补识别词列表必须为数组：%j', async changes => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), ocrPasses: [scaledOcrPass(changes)] }));
    const result = await setup.detector().detect(frame());
    expect(result).toMatchObject({ status: 'failed', reason: 'ocr_pass_invalid' });
    expect(result).not.toHaveProperty('sanitizedPng');
  });

  it.each([null, {}, { text: '', rect: { x: 0, y: 0, width: 8, height: 6 } },
    { text: 123, rect: { x: 0, y: 0, width: 8, height: 6 } },
    { text: '字'.repeat(513), rect: { x: 0, y: 0, width: 8, height: 6 } },
  ])('补识别中的无效文字不生成脱敏图：%j', async word => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), ocrPasses: [scaledOcrPass({ words: [word] })] }));
    const result = await setup.detector().detect(frame());
    expect(result).toMatchObject({ status: 'failed', reason: 'ocr_word_invalid' });
    expect(result).not.toHaveProperty('sanitizedPng');
  });

  it.each([
    null, {}, { x: -1, y: 0, width: 8, height: 6 }, { x: 0, y: -1, width: 8, height: 6 },
    { x: 127, y: 0, width: 2, height: 6 }, { x: 0, y: 95, width: 8, height: 2 },
    { x: 0, y: 0, width: 0, height: 6 }, { x: 0, y: 0, width: 8, height: -1 },
    { x: '0', y: 0, width: 8, height: 6 }, { x: null, y: 0, width: 8, height: 6 },
  ])('放大词框在映射前必须完整位于放大画面内，不能裁剪放行：%j', async rect => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), ocrPasses: [scaledOcrPass({ words: [{ text: '微信', rect }] })] }));
    const result = await setup.detector().detect(frame());
    expect(result).toMatchObject({ status: 'failed', reason: 'detection_rect_out_of_bounds', words: [], redaction: { text: false, faces: false } });
    expect(result).not.toHaveProperty('sanitizedPng');
  });

  it.each([{ textAngle: 181 }, { textAngle: -181 }, { textAngle: '90' }, { textAngle: true }, { textAngle: {} }, { textAngle: [] }])('补识别无效旋转角度本地拒绝：%j', async changes => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request), ocrPasses: [scaledOcrPass(changes)] }));
    const result = await setup.detector().detect(frame());
    expect(result).toMatchObject({ status: 'failed', reason: 'ocr_rotation_invalid' });
    expect(result).not.toHaveProperty('sanitizedPng');
  });

  it.each(['1e309', '-1e309'])('JSON 数字溢出成非有限角度 %s 仍拒绝', async angle => {
    const setup = helperSetup((request, child) => child.reply(JSON.stringify({ ...completeReply(request),
      ocrPasses: [scaledOcrPass({ textAngle: 'overflow-angle' })] }).replace('"overflow-angle"', angle)));
    const result = await setup.detector().detect(frame());
    expect(result).toMatchObject({ status: 'failed', reason: 'ocr_rotation_invalid' });
    expect(result).not.toHaveProperty('sanitizedPng');
  });

  it.each([8192, 8193])('两尺度合计 %s 个词按同一 8192 限额检查，不分别截断', async totalWords => {
    const setup = helperSetup((request, child) => child.reply({ ...completeReply(request),
      words: [{ text: '原词', rect: { x: 4, y: 4, width: 1, height: 1 } }],
      ocrPasses: [scaledOcrPass({ words: Array.from({ length: totalWords - 1 }, () => ({ text: '字', rect: { x: 40, y: 20, width: 2, height: 2 } })) })] }));
    const result = await setup.detector().detect(frame());
    if (totalWords > 8192) {
      expect(result).toMatchObject({ status: 'failed', reason: 'ocr_pass_invalid', words: [], redaction: { text: false, faces: false } });
      expect(result).not.toHaveProperty('sanitizedPng');
    } else {
      expect(result.status).toBe('complete');
      expect(result.words).toHaveLength(8192);
      expect(result.words[8191]).toMatchObject({ text: '字', ocrPass: 1 });
    }
  });
});

describe('Windows helper 取消、限额与无队列生命周期', () => {
  it('预先 abort 不启动本地进程', async () => {
    const setup = helperSetup();
    expect(await setup.detector().detect(frame(), { signal: AbortSignal.abort() })).toMatchObject({ status: 'failed', reason: 'aborted' });
    expect(setup.spawn).not.toHaveBeenCalled();
  });

  it('单 helper 不排队，abort 必须 kill 并等待 close 后才可释放', async () => {
    const setup = helperSetup(null);
    const detector = setup.detector();
    const controller = new AbortController();
    const pending = detector.detect(frame(), { signal: controller.signal });
    await nextTurn();
    const child = setup.children[0]!;
    child.autoCloseOnKill = false;
    expect(await detector.detect(frame())).toMatchObject({ status: 'failed', reason: 'busy' });
    expect(await detector.probe()).toEqual({ status: 'failed', reason: 'busy' });
    controller.abort();
    expect(child.kill).toHaveBeenCalled();
    expect(await detector.detect(frame())).toMatchObject({ status: 'failed', reason: 'busy' });
    let stopped = false;
    const stopping = detector.stop().then(() => { stopped = true; });
    await nextTurn();
    expect(stopped).toBe(false);
    child.close(1);
    expect(await pending).toMatchObject({ status: 'failed', reason: 'aborted' });
    await stopping;
    expect(stopped).toBe(true);
    await detector.stop();
    expect(setup.spawn).toHaveBeenCalledTimes(1);
  });

  it('超时 kill 本地进程，失败结果绝无 sanitizedPng', async () => {
    const setup = helperSetup(null);
    const result = await setup.detector({ timeoutMs: 15 }).detect(frame());
    expect(result).toMatchObject({ status: 'failed', reason: 'helper_timeout' });
    expect(result).not.toHaveProperty('sanitizedPng');
    expect(setup.children[0]!.kill).toHaveBeenCalled();
  });

  it('stdout 超限立即 kill，不解析或透出正文', async () => {
    const setup = helperSetup((_request, child) => child.stdout.write(Buffer.alloc(256, 65)));
    const result = await setup.detector({ maxOutputBytes: 128 }).detect(frame());
    expect(result).toMatchObject({ status: 'failed', reason: 'helper_output_limit' });
    expect(setup.children[0]!.kill).toHaveBeenCalled();
    expect(result).not.toHaveProperty('sanitizedPng');
  });

  it.each(['not-json', Buffer.from([0xff, 0xfe])])('非法 JSON/UTF8 不回退成 complete', async output => {
    const setup = helperSetup((_request, child) => child.reply(output));
    expect(await setup.detector().detect(frame())).toMatchObject({ status: 'failed', reason: 'helper_output_invalid' });
  });

  it('stderr 不泄露到 console 或返回 reason', async () => {
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    try {
      const setup = helperSetup((request, child) => { child.stderr.write('private-text-never-log'); child.reply(completeReply(request)); });
      const result = await setup.detector().detect(frame());
      expect(result).toMatchObject({ status: 'failed', reason: 'helper_process_failed' });
      expect(JSON.stringify(result)).not.toContain('private-text-never-log');
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('stderr 超限也会 kill，而不是无限缓冲', async () => {
    const setup = helperSetup((_request, child) => child.stderr.write(Buffer.alloc(8193, 65)));
    expect(await setup.detector().detect(frame())).toMatchObject({ status: 'failed', reason: 'helper_stderr_limit' });
    expect(setup.children[0]!.kill).toHaveBeenCalled();
  });

  it('source.stop() 也取消并 await 内置 detector/helper，且不自动重启', async () => {
    const setup = helperSetup(null);
    const source = createWindowsObservationSource({ nativeImage, platform: 'win32', detectorOptions: { spawn: setup.spawn as unknown as typeof nodeSpawn } });
    const pending = source.detect(frame());
    await nextTurn();
    await source.stop();
    expect(await pending).toMatchObject({ status: 'failed', reason: 'aborted' });
    expect(setup.children[0]!.closed).toBe(true);
    await source.stop();
    expect(setup.spawn).toHaveBeenCalledTimes(1);
  });
});

describe('性能：本地观察链路开销', () => {
  it('前置来源枚举短 TTL 内复用，每帧最多一次真实枚举；过期后重新校验', async () => {
    let timestamp = 1000;
    const setup = sourceSetup({ now: () => timestamp });
    await setup.source.listSources();
    const afterList = setup.getSources.mock.calls.length;
    await setup.source.capture({ sourceId: 'screen:1:0' });
    const firstCaptureCalls = setup.getSources.mock.calls.length - afterList;
    timestamp += 1000;
    await setup.source.capture({ sourceId: 'screen:1:0' });
    // 前置枚举命中缓存；抓屏后的真实枚举保留，用于证明来源没在拷贝期间消失。
    const cachedCaptureCalls = setup.getSources.mock.calls.length - afterList - firstCaptureCalls;
    expect(cachedCaptureCalls).toBeLessThan(firstCaptureCalls);
    timestamp += 7000;
    await setup.source.capture({ sourceId: 'screen:1:0' });
    const refreshedCaptureCalls = setup.getSources.mock.calls.length - afterList - firstCaptureCalls - cachedCaptureCalls;
    expect(refreshedCaptureCalls).toBeGreaterThan(cachedCaptureCalls);
  });

  it('检测请求默认不启用放大 OCR 遍，显式开启时才发送 scaledPass', async () => {
    const setup = helperSetup();
    const baseline = setup.detector();
    const accelerated = setup.detector({ scaledPass: true });
    try {
      await baseline.detect(frame());
      await accelerated.detect(frame());
      expect((setup.children[0]!.request as Record<string, unknown>).scaledPass).toBe(false);
      expect((setup.children[1]!.request as Record<string, unknown>).scaledPass).toBe(true);
      // 大区域按默认上限降采样 OCR，避免本机检测超过五秒准入窗口。
      expect((setup.children[0]!.request as Record<string, unknown>).ocrMaxDimension).toBe(1080);
    } finally {
      await Promise.all([baseline.stop(), accelerated.stop()]);
    }
  });
});
