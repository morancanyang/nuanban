import { describe, expect, it } from 'vitest';
import { extractVisualControls, matchesVisualControl } from '../../apps/desktop/observation/visual-controls.cjs';
import type { Rect } from '../../apps/desktop/observation/observation-types.cjs';

function blank(width: number, height: number, shade = 238) {
  const bitmap = Buffer.alloc(width * height * 4, shade);
  for (let offset = 3; offset < bitmap.length; offset += 4) bitmap[offset] = 255;
  return bitmap;
}

function ring(bitmap: Buffer, width: number, rect: Rect, shade = 70) {
  const radius = rect.width / 2 - 1;
  for (let row = rect.y; row < rect.y + rect.height; row += 1) {
    for (let column = rect.x; column < rect.x + rect.width; column += 1) {
      const distance = Math.hypot(column - rect.x - rect.width / 2, row - rect.y - rect.height / 2);
      if (distance < radius - Math.max(2, rect.width / 10) || distance > radius) continue;
      const offset = (row * width + column) * 4;
      bitmap[offset] = shade;
      bitmap[offset + 1] = shade;
      bitmap[offset + 2] = shade;
    }
  }
}

function wallpaper(width: number, height: number) {
  const bitmap = Buffer.alloc(width * height * 4, 200);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = (row * width + column) * 4;
      const shade = Math.max(0, Math.min(255, Math.round(150 + 80 * Math.sin(column / 9 + row / 17))));
      bitmap[offset] = shade;
      bitmap[offset + 1] = shade;
      bitmap[offset + 2] = shade;
      bitmap[offset + 3] = 255;
    }
  }
  return bitmap;
}

function covers(outer: Rect, inner: Rect) {
  return outer.x <= inner.x && outer.y <= inner.y
    && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
}

describe('无文字图标的本地图形候选（合成画面，不代表微信真机验收）', () => {
  it.each([
    [800, 600, 70, 1, 238, 70],
    [1920, 1080, 450, 2, 32, 210],
    [3840, 2160, 1200, 3, 238, 70],
  ])('不同窗口位置、缩放和明暗主题仍提取无文字侧栏：%j', (width, height, railX, scale, background, foreground) => {
    const bitmap = blank(width, height, background);
    const icons = [1, 2, 3, 4].map(index => ({ x: railX, y: index * 56 * scale, width: 24 * scale, height: 24 * scale }));
    for (const rect of icons) ring(bitmap, width, rect, foreground);
    const controls = extractVisualControls({ bitmap, width, height });
    for (const rect of icons) expect(controls.some(control => covers(control.rect, rect))).toBe(true);
    expect(controls.every(control => control.label === '未标注图标' && control.surface === 'visual'
      && /^[a-f0-9]{64}$/.test(control.appearance))).toBe(true);
    expect(controls.some(control => control.label.includes('朋友圈'))).toBe(false);
    expect(bitmap.some(value => value !== 0)).toBe(true);
  });

  it('文字、人脸和脱敏黑块不作为可指引图标', () => {
    const bitmap = blank(800, 600);
    const icons = [60, 140, 220].map(y => ({ x: 50, y, width: 26, height: 26 }));
    for (const rect of icons) ring(bitmap, 800, rect);
    const exclusions = [icons[0], { x: 45, y: 135, width: 40, height: 40 }, { x: 200, y: 80, width: 160, height: 32 }];
    for (let row = 80; row < 112; row += 1) bitmap.fill(Buffer.from([0, 0, 0, 255]), (row * 800 + 200) * 4, (row * 800 + 360) * 4);
    const controls = extractVisualControls({ bitmap, width: 800, height: 600, exclusions });
    expect(controls).toHaveLength(1);
    expect(covers(controls[0].rect, icons[2])).toBe(true);
  });

  it('壁纸背景上成列的桌面快捷方式图标仍能作为候选指引', () => {
    const bitmap = wallpaper(800, 600);
    const icons = [60, 140, 220].map(y => ({ x: 60, y, width: 24, height: 24 }));
    for (const rect of icons) ring(bitmap, 800, rect);
    const controls = extractVisualControls({ bitmap, width: 800, height: 600 });
    // 壁纸渐变会让图标边缘弧段不完整，矩形不保证完全包住图标；指引只需候选中心对准图标。
    for (const rect of icons) {
      const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      expect(controls.some(control => Math.hypot(control.rect.x + control.rect.width / 2 - center.x,
        control.rect.y + control.rect.height / 2 - center.y) <= 8)).toBe(true);
    }
    expect(controls.length).toBeGreaterThanOrEqual(icons.length);
    expect(controls.every(control => control.label === '未标注图标' && control.surface === 'visual')).toBe(true);
  });

  it('壁纸上的孤立图形不当作按钮，避免把照片纹理当成图标', () => {
    const bitmap = wallpaper(800, 600);
    ring(bitmap, 800, { x: 60, y: 60, width: 24, height: 24 });
    expect(extractVisualControls({ bitmap, width: 800, height: 600 })).toEqual([]);
  });

  it('空白、整片背景纹理、过大的窗口边框不伪造成按钮', () => {
    expect(extractVisualControls({ bitmap: blank(800, 600), width: 800, height: 600 })).toEqual([]);
    const bitmap = blank(800, 600);
    ring(bitmap, 800, { x: 80, y: 80, width: 360, height: 360 });
    expect(extractVisualControls({ bitmap, width: 800, height: 600 })).toEqual([]);
    for (let offset = 0; offset < bitmap.length; offset += 4) {
      const shade = ((offset / 4) % 800 + Math.floor(offset / 3200)) % 2 ? 0 : 255;
      bitmap[offset] = shade;
      bitmap[offset + 1] = shade;
      bitmap[offset + 2] = shade;
    }
    expect(extractVisualControls({ bitmap, width: 800, height: 600 })).toEqual([]);
  });

  it('同位置换图标必须改变指纹；不会把中性标签相同当作同一控件', () => {
    const bitmap = blank(800, 600);
    const rect = { x: 60, y: 100, width: 24, height: 24 };
    ring(bitmap, 800, rect);
    const original = extractVisualControls({ bitmap, width: 800, height: 600 })[0];
    const repeated = extractVisualControls({ bitmap, width: 800, height: 600 })[0];
    expect(repeated).toEqual(original);
    ring(bitmap, 800, rect, 120);
    const changed = extractVisualControls({ bitmap, width: 800, height: 600 })[0];
    expect(changed.rect).toEqual(original.rect);
    expect(matchesVisualControl(original, repeated)).toBe(true);
    expect(matchesVisualControl(original, changed)).toBe(false);
    expect(matchesVisualControl(original, { ...original, appearance: undefined })).toBe(false);
    expect(matchesVisualControl(original, { ...original, surface: 'desktop' })).toBe(false);
  });

  it('候选数受限且支持取消，不接受越界遮盖或损坏位图', () => {
    const bitmap = blank(800, 600);
    for (let row = 0; row < 8; row += 1) {
      for (let column = 0; column < 10; column += 1) ring(bitmap, 800, { x: 25 + column * 70, y: 25 + row * 65, width: 20, height: 20 });
    }
    expect(extractVisualControls({ bitmap, width: 800, height: 600 })).toHaveLength(48);
    expect(() => extractVisualControls({ bitmap, width: 801, height: 600 })).toThrow('visual_input_invalid');
    expect(() => extractVisualControls({ bitmap, width: 800, height: 600, exclusions: [{ x: -1, y: 0, width: 10, height: 10 }] })).toThrow('visual_input_invalid');
    const controller = new AbortController();
    controller.abort();
    expect(() => extractVisualControls({ bitmap, width: 800, height: 600, signal: controller.signal })).toThrow();
  });
});
