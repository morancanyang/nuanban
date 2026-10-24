import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkedShellControls, isBoundedShellControlLabel, isPublicShellControlLabel, normalizedShellLabel, SHELL_LABEL_MAX_LENGTH } from '../../apps/desktop/observation/windows-shell-controls.cjs';
import type { ObservationGeometry } from '../../apps/desktop/observation/windows-local-detector.cjs';

const geometry: ObservationGeometry = { coordinateSpace: 'screen-dip', x: -800, y: 0, width: 800, height: 600,
  pixelX: -800, pixelY: 0, pixelWidth: 800, pixelHeight: 600, scaleFactor: 1, rotation: 0 };
const at = (x = -788, y = 20) => ({ x, y, width: 24, height: 24 });
const control = (label: unknown, surface: unknown = 'desktop', rect: unknown = at()) => ({ label, surface, rect });
const script = readFileSync(new URL('../../apps/desktop/observation/windows-shell-controls.ps1', import.meta.url), 'utf8');

describe('本地 shell 候选不再限于白名单（合成单测，不读取真实桌面）', () => {
  it('候选名称来自本机 UIA Name：任意软件名都通过结构校验，白名单不再是前提', () => {
    expect(isPublicShellControlLabel('WeGame')).toBe(true);
    expect(isPublicShellControlLabel('原神')).toBe(true);
    expect(isPublicShellControlLabel('Google Chrome')).toBe(true);
    expect(isPublicShellControlLabel('我的软件 2.0')).toBe(true);
    expect(isPublicShellControlLabel('A'.repeat(SHELL_LABEL_MAX_LENGTH))).toBe(true);
    expect(isBoundedShellControlLabel('WeGame')).toBe(true);
    expect(isBoundedShellControlLabel(' WeGame ')).toBe(false);
  });

  it('超长名称按上限截断，异常超长与非字符串仍被拒绝', () => {
    expect(normalizedShellLabel('A'.repeat(SHELL_LABEL_MAX_LENGTH + 1))).toBe('A'.repeat(SHELL_LABEL_MAX_LENGTH));
    expect(checkedShellControls([control('B'.repeat(200))], geometry)[0]!.label).toBe('B'.repeat(SHELL_LABEL_MAX_LENGTH));
    for (const rejected of ['', '   ', '\t\n ', '---', '...', '··——', '\u0000\u0007\u001f', 'A'.repeat(300), 42, null, undefined, {}]) {
      expect(normalizedShellLabel(rejected)).toBeNull();
      expect(isPublicShellControlLabel(rejected)).toBe(false);
      expect(() => checkedShellControls([control(rejected)], geometry)).toThrowError('shell_controls_invalid');
    }
  });

  it('名称清洗：去控制字符、折叠空白、Trim 并按 NFKC 归一，本地读取不外发原始屏幕', () => {
    expect(normalizedShellLabel('  WeGame\u0007  ')).toBe('WeGame');
    expect(normalizedShellLabel('我的\u0000 软件')).toBe('我的 软件');
    expect(normalizedShellLabel('ＷｅＧａｍｅ')).toBe('WeGame');
    expect(normalizedShellLabel('WeGame\n桌面')).toBe('WeGame 桌面');
  });

  it('任意名称的候选映射到本帧坐标，保留 surface，不夹带私有字段', () => {
    expect(checkedShellControls([control('WeGame', 'desktop', at(-788, 20))], geometry))
      .toEqual([{ label: 'WeGame', surface: 'desktop', rect: { x: 12, y: 20, width: 24, height: 24 } }]);
    expect(checkedShellControls([control('原神', 'taskbar', at(-760, 540))], geometry))
      .toEqual([{ label: '原神', surface: 'taskbar', rect: { x: 40, y: 540, width: 24, height: 24 } }]);
    const forged = checkedShellControls([{ ...control('WeGame'), privateTitle: 'never-return-this' }], geometry);
    expect(JSON.stringify(forged)).not.toContain('never-return-this');
  });

  it('范围、面、数量与请求门控全部保留', () => {
    expect(checkedShellControls(undefined, geometry)).toEqual([]);
    expect(checkedShellControls([], geometry)).toEqual([]);
    expect(() => checkedShellControls({}, geometry)).toThrowError('shell_controls_invalid');
    expect(() => checkedShellControls([control('WeGame')], null)).toThrowError('shell_controls_unrequested');
    expect(() => checkedShellControls(Array.from({ length: 129 }, () => control('WeGame')), geometry)).toThrowError('shell_controls_invalid');
    expect(() => checkedShellControls([control('WeGame', 'private-window')], geometry)).toThrowError('shell_controls_invalid');
    expect(() => checkedShellControls([control('WeGame', 'desktop', at(-801, 20))], geometry)).toThrowError('shell_controls_out_of_bounds');
    expect(() => checkedShellControls([control('WeGame', 'desktop', { x: -788, y: 20, width: 0, height: 24 })], geometry)).toThrowError('shell_controls_out_of_bounds');
    expect(() => checkedShellControls([control('WeGame', 'desktop', { x: -788, y: 20, width: Number.NaN, height: 24 })], geometry)).toThrowError('shell_controls_out_of_bounds');
    expect(() => checkedShellControls([control('WeGame', 'desktop', { x: -788, y: 20, width: 24, height: 24, extra: 1 })], geometry)).not.toThrow();
  });

  it('同名同位置重复项只上报一次，同名不同位置仍然各自成为候选', () => {
    const duplicated = checkedShellControls([control('WeGame'), control('WeGame'), control('WeGame', 'desktop', at(-700, 20))], geometry);
    expect(duplicated.map(item => item.label)).toEqual(['WeGame', 'WeGame']);
    expect(duplicated[0]!.rect.x).toBe(12);
    expect(duplicated[1]!.rect.x).toBe(100);
  });

  it('原生脚本对每个合格元素都取 UIA Name，不再按白名单丢弃', () => {
    expect(script).not.toContain('$label = $null');
    expect(script).toContain('$label = ([string]$name) -replace');
    expect(script).toContain("$label -notmatch '[\\p{L}\\p{N}]'");
    expect(script).toContain('$label.Length -gt 64');
    expect(script).toContain('$seen.ContainsKey($key)');
    expect(script).not.toMatch(/if \(\$null -eq \$label\) \{ continue \}/);
  });

  it('已知项仍映射友好名，且不因泛化而放弃本地 UIA 校验', () => {
    expect(script).toContain('"wechat":"\\u5fae\\u4fe1"');
    expect(script).toContain('"start":"\\u5f00\\u59cb"');
    expect(script).toContain('"search":"\\u641c\\u7d22"');
    expect(script).toContain('"computer":"\\u6b64\\u7535\\u8111"');
    expect(script).toContain('"recycle":"\\u56de\\u6536\\u7ad9"');
    expect(script).toContain('"panel":"\\u63a7\\u5236\\u9762\\u677f"');
    expect(script).toContain('$element.Current.ProcessId -ne $window.Current.ProcessId');
    expect(script).toContain('$element.Current.IsOffscreen');
    expect(script).toContain('$element.Current.IsEnabled');
    expect(script).toContain("Join-Path $env:WINDIR 'explorer.exe'");
    expect(script).toContain('$windows.Count -gt 128');
    expect(script).toContain('$elements.Count -gt 1024');
    expect(script).toContain('$controls.Count -ge 128');
    expect(script).toContain('AutomationElement]::FromPoint');
  });

  it('仍然先校验框选/屏幕范围，再读取元素名称', () => {
    expect(script.indexOf('if ($bounds.X -lt $Geometry.pixelX')).toBeGreaterThan(0);
    expect(script.indexOf('if ($bounds.X -lt $Geometry.pixelX')).toBeLessThan(script.indexOf('$name = $element.Current.Name'));
  });

  it('原生脚本保持纯 ASCII，Windows PowerShell 5 不会因中文无 BOM 解析失败', () => {
    expect(script).not.toMatch(/[^\x00-\x7f]/u);
  });
});