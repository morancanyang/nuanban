import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { buildControlList, checkedControlItems, checkedLimits, controlTypeLabel, createUiaInventoryReader, uiaCandidates, UIA_LIMITS, windowKey } from '../../apps/desktop/observation/uia-inventory.cjs';
import { physicalToDipRect } from '../../apps/desktop/observation/uia-coordinates.cjs';

// 无截屏指引的清单构造（假 helper，不读真实桌面、不抓屏）。

type HelperChild = InstanceType<typeof FakeChild>;
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  request: Record<string, unknown> | null = null;
  kill = vi.fn(() => { setImmediate(() => this.emit('close', 1)); return true; });
  reply(payload: unknown, code = 0) {
    this.stdout.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    setImmediate(() => this.emit('close', code));
  }
}

function item(index: number, overrides: Record<string, unknown> = {}) {
  return { index, name: `控件${index}`, controlType: 'ControlType.Button', enabled: true, offscreen: false, focus: false, depth: 2,
    x: 10 * index, y: 20, width: 80, height: 30, ...overrides };
}

function inventoryReply(controls: unknown[], overrides: Record<string, unknown> = {}) {
  return { protocol: 1, status: 'complete', truncated: false, depthLimited: false, deadlineReached: false, focusedIndex: 0,
    window: { processId: 4242, className: 'Notepad', title: '机密文档.txt - 记事本' }, count: (controls as unknown[]).length, controls, ...overrides };
}

function helperSetup(respond: (request: Record<string, unknown>, child: HelperChild) => void = (request, child) => child.reply(inventoryReply([item(1)]))) {
  const children: HelperChild[] = [];
  const spawn = vi.fn(() => {
    const child = new FakeChild();
    const chunks: Buffer[] = [];
    child.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
    child.stdin.on('finish', () => {
      child.request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      setImmediate(() => respond(child.request!, child));
    });
    children.push(child);
    return child;
  });
  return { children, spawn, reader: (options: Record<string, unknown> = {}) => createUiaInventoryReader({ spawn: spawn as never, platform: 'win32', ...options }) };
}

describe('无截屏指引：前台窗口 UIA 清单构造（合成，不读真实桌面）', () => {
  it('只上报名称/类型/矩形等文本，窗口标题不进返回值', async () => {
    const setup = helperSetup();
    const result = await setup.reader().read();
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') throw new Error('expected complete inventory');
    expect(result.controls).toHaveLength(1);
    expect(result.controls[0]).toMatchObject({ name: '控件1', controlType: 'ControlType.Button', label: '按钮', enabled: true, offscreen: false });
    expect(result.controls[0]!.rect).toEqual({ x: 10, y: 20, width: 80, height: 30 });
    expect(result.counts).toEqual({ total: 1, limit: UIA_LIMITS.maxControls });
    expect(result.truncated).toBe(false);
    expect(result.windowKey).toMatch(/^[a-f0-9]{16}$/);
    // 窗口标题（可能含文件名）只在本机参与 windowKey，不作为任何返回值外泄。
    expect(JSON.stringify(result)).not.toContain('机密文档');
    expect(setup.children[0]!.request).toMatchObject({ protocol: 1, operation: 'inventory', maxDepth: UIA_LIMITS.maxDepth, maxControls: UIA_LIMITS.maxControls });
  });

  it('数量/深度/时间任一截断都标记 truncated，并按上限发送请求', async () => {
    const truncated = helperSetup((_request, child) => child.reply(inventoryReply([item(1)], { truncated: true, count: 400 })));
    expect((await truncated.reader().read()).truncated).toBe(true);
    const depthLimited = helperSetup((_request, child) => child.reply(inventoryReply([item(1)], { depthLimited: true })));
    expect((await depthLimited.reader().read()).truncated).toBe(true);
    const deadline = helperSetup((_request, child) => child.reply(inventoryReply([item(1)], { deadlineReached: true })));
    expect((await deadline.reader().read()).truncated).toBe(true);
    const limited = helperSetup();
    await limited.reader({ limits: { maxControls: 12, maxDepth: 3 } }).read();
    expect(limited.children[0]!.request).toMatchObject({ maxControls: 12, maxDepth: 3 });
  });

  it('上限只能收紧不能突破，形状不合法的清单按读不到处理', async () => {
    expect(() => checkedLimits({ maxControls: UIA_LIMITS.maxControlsLimit + 1 })).toThrowError('invalid_uia_limits');
    expect(() => checkedLimits({ maxDepth: UIA_LIMITS.maxDepthLimit + 1 })).toThrowError('invalid_uia_limits');
    expect(() => checkedLimits({ maxControls: 0 })).toThrowError('invalid_uia_limits');
    const tooMany = helperSetup((_request, child) => child.reply(inventoryReply(Array.from({ length: 3 }, (_value, index) => item(index + 1)))));
    const overflow = await tooMany.reader({ limits: { maxControls: 2 } }).read();
    expect(overflow.status).toBe('unavailable');
    expect(overflow.reason).toBe('uia_controls_invalid');
    const malformed = helperSetup((_request, child) => child.reply(inventoryReply([{ index: 1, name: 'x', controlType: 42, enabled: true, offscreen: false, depth: 1, x: 1, y: 1, width: 1, height: 1 }])));
    expect((await malformed.reader().read()).reason).toBe('uia_controls_invalid');
    const notJson = helperSetup((_request, child) => child.reply('not-json'));
    expect((await notJson.reader().read()).status).toBe('unavailable');
  });

  it('前台窗口是本机自己或不提供 UIA 时明确返回原因，不猜', async () => {
    const self = helperSetup((_request, child) => child.reply({ protocol: 1, status: 'unavailable', reason: 'foreground_is_self' }));
    expect(await self.reader().read()).toMatchObject({ status: 'unavailable', reason: 'foreground_is_self' });
    const none = helperSetup((_request, child) => child.reply({ protocol: 1, status: 'failed', reason: 'foreground_window_unavailable' }));
    expect(await none.reader().read()).toMatchObject({ status: 'unavailable', reason: 'foreground_window_unavailable' });
    const excluded = helperSetup();
    await excluded.reader({ excludedProcessIds: () => [4242] }).read();
    expect(excluded.children[0]!.request).toMatchObject({ excludedProcessIds: [4242] });
  });

  it('候选只保留有名、可用、在屏且矩形有效的控件，并重新编号', () => {
    const controls = checkedControlItems([item(1), item(2, { offscreen: true }), item(3, { enabled: false }),
      item(4, { name: '...' }), item(5, { width: 0, height: 0 }), item(6, { name: '设置', controlType: 'ControlType.MenuItem' })], { ...UIA_LIMITS });
    const candidates = uiaCandidates(controls);
    expect(candidates.map(candidate => candidate.name)).toEqual(['控件1', '设置']);
    expect(candidates.map(candidate => candidate.number)).toEqual([1, 2]);
    expect(candidates[1]!.label).toBe('菜单项');
  });

  it('清单只发给模型文本：敏感名称在离开本机前被隐藏，且行内只有序号/名称/类型/矩形', () => {
    const controls = checkedControlItems([item(1, { name: '设置' }), item(2, { name: '银行卡密码.txt' }), item(3, { name: '微信' })], { ...UIA_LIMITS });
    const list = buildControlList(uiaCandidates(controls), { isRestrictedText: value => /密码|银行卡/.test(String(value)) });
    expect(list.lines).toHaveLength(3);
    expect(list.lines[1]).toContain('（名称已隐藏）');
    expect(list.lines.join('\n')).not.toContain('银行卡密码');
    expect(list.lines[0]).toMatch(/^1\. 设置 · 按钮 · 矩形\(\d+,\d+,\d+,\d+\)$/);
    expect(list.redactedNames).toBe(1);
    expect(list.readableNames).toBe(2);
    expect(list.listTruncated).toBe(false);
    const short = buildControlList(uiaCandidates(controls), { isRestrictedText: () => false, maxLines: 2 });
    expect(short.lines).toHaveLength(2);
    expect(short.listTruncated).toBe(true);
  });

  it('控件类型有中文标签，未知类型回退为安全短名', () => {
    expect(controlTypeLabel('ControlType.Button')).toBe('按钮');
    expect(controlTypeLabel('ControlType.Edit')).toBe('输入框');
    expect(controlTypeLabel('ControlType.Custom')).toBe('自定义控件');
    expect(controlTypeLabel('SomethingLong')).toBe('SomethingLong');
    expect(controlTypeLabel('bad value!')).toBe('控件');
    expect(controlTypeLabel(undefined)).toBe('控件');
  });

  it('windowKey 只由本机计算，字段不全时为 null', () => {
    expect(windowKey({ processId: 1, className: 'A', title: 'B' })).toMatch(/^[a-f0-9]{16}$/);
    expect(windowKey({ processId: 1, className: 'A', title: 'C' })).not.toBe(windowKey({ processId: 1, className: 'A', title: 'B' }));
    expect(windowKey({ processId: 1, className: 'A' })).toBeNull();
    expect(windowKey(null)).toBeNull();
  });

  it('物理像素只有在能证明 DIP 映射时才换算，否则不给坐标', () => {
    const rect = { x: -1150, y: 60, width: 150, height: 30 };
    const display = { id: 7, bounds: { x: -800, y: 0, width: 800, height: 600, displayId: '' }, scaleFactor: 1.5 };
    const proven = { getAllDisplays: () => [display], dipToScreenRect: () => ({ x: -1200, y: 0, width: 1200, height: 900, displayId: '7' }) };
    expect(physicalToDipRect(rect, { screen: proven })).toMatchObject({ x: -800 + 50 / 1.5, y: 40, width: 100, height: 20, displayId: '7' });
    const unproven = { getAllDisplays: () => [{ ...display, nativeOrigin: undefined }] };
    expect(physicalToDipRect(rect, { screen: unproven })).toBeNull();
    const nativeOrigin = { getAllDisplays: () => [{ ...display, nativeOrigin: { x: -1200, y: 0 } }] };
    expect(physicalToDipRect(rect, { screen: nativeOrigin })).toMatchObject({ y: 40, width: 100 });
    expect(physicalToDipRect({ ...rect, width: 0 }, { screen: proven })).toBeNull();
    expect(physicalToDipRect(rect, { screen: { getAllDisplays: () => [] } })).toBeNull();
    // 目标中心不在任何已证明的显示器物理范围内时不换算，交由上层 fail closed。
    expect(physicalToDipRect({ x: 500, y: 60, width: 40, height: 30 }, { screen: proven })).toBeNull();
  });
});

describe('无截屏路径的源码约束（静态检查）', () => {
  const inventory = readFileSync(new URL('../../apps/desktop/observation/uia-inventory.cjs', import.meta.url), 'utf8');
  const guidance = readFileSync(new URL('../../apps/desktop/observation/uia-guidance.cjs', import.meta.url), 'utf8');
  const coordinates = readFileSync(new URL('../../apps/desktop/observation/uia-coordinates.cjs', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../../apps/desktop/observation/windows-uia-inventory.ps1', import.meta.url), 'utf8');

  it('Node 侧不引用任何截屏/图像/像素通道', () => {
    for (const source of [inventory, guidance, coordinates]) {
      expect(source).not.toContain('sanitizedPng');
      expect(source).not.toContain('nativeImage');
      expect(source).not.toContain('desktopCapturer');
      expect(source).not.toContain('analysis-image');
      expect(source).not.toContain('createFromBuffer');
      expect(source).not.toContain('pngBase64');
    }
  });

  it('原生脚本只读前台窗口的 UIA 树，不抓屏、不解码图片', () => {
    expect(script).not.toMatch(/[^\x00-\x7f]/u);
    expect(script).toContain('GetForegroundWindow');
    expect(script).toContain('AutomationElement]::FromHandle');
    expect(script).toContain('ControlViewWalker');
    expect(script).toContain('SetThreadDpiAwarenessContext');
    expect(script).toContain('$maxControls = 400');
    expect(script).toContain('$maxDepth = 8');
    expect(script).toContain('$candidate -le 512');
    expect(script).toContain('$candidate -le 10');
    expect(script).toContain('truncated');
    expect(script).toContain('foreground_is_self');
    // 不出现任何截图/像素/图像 API 或数据通道。
    expect(script).not.toMatch(/CopyFromScreen|BitBlt|System\.Drawing|Graphics|screenshot|PNG|pngBase64|base64|Bitmap/i);
  });

  it('helper 只允许本目录内的固定脚本名，不接受任意路径', () => {
    const helper = readFileSync(new URL('../../apps/desktop/observation/windows-helper-process.cjs', import.meta.url), 'utf8');
    expect(helper).toContain('invalid_helper_script');
    expect(() => createUiaInventoryReader({ platform: 'win32', limits: { maxControls: 1 } })).not.toThrow();
  });
});