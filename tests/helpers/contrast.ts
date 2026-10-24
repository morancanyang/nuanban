import type { Page } from '@playwright/test';

export interface ContrastViolation {
  selector: string;
  size: number;
  ratio: number;
  text: string;
}

/**
 * 扫描当前页面所有可见文本节点的实际对比度，返回低于 WCAG AA 的项。
 * 只按计算样式判断，不依赖截图；装饰元素应由 aria-hidden 显式排除。
 */
export async function findContrastViolations(page: Page): Promise<ContrastViolation[]> {
  return page.evaluate(() => {
    const parse = (value: string) => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(',').map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
    };
    const luminance = (color: { r: number; g: number; b: number }) => {
      const channels = [color.r, color.g, color.b].map(value => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const background = (element: Element) => {
      let node: Element | null = element;
      while (node) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color && color.a > 0.9) return color;
        node = node.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const ratio = (foreground: { r: number; g: number; b: number }, back: { r: number; g: number; b: number }) => {
      const first = luminance(foreground) + 0.05;
      const second = luminance(back) + 0.05;
      return first > second ? first / second : second / first;
    };
    const describe = (element: Element) => {
      const parts: string[] = [];
      let node: Element | null = element;
      while (node && parts.length < 3) {
        const name = node.className && typeof node.className === 'string' ? '.' + node.className.split(/\s+/)[0] : '';
        parts.unshift(node.tagName.toLowerCase() + name);
        node = node.parentElement;
      }
      return parts.join('>');
    };
    const violations: ContrastViolation[] = [];
    for (const element of Array.from(document.querySelectorAll('body *'))) {
      if (element.children.length > 0) continue;
      if (element.closest('[aria-hidden="true"]')) continue;
      const text = (element.textContent ?? '').trim();
      if (!text) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.5) continue;
      const foreground = parse(style.color);
      if (!foreground) continue;
      const size = Number.parseFloat(style.fontSize);
      const weight = Number.parseInt(style.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const value = ratio(foreground, background(element));
      if (value < (large ? 3 : 4.5)) {
        violations.push({ selector: describe(element), size, ratio: Math.round(value * 100) / 100, text: text.slice(0, 20) });
      }
    }
    return violations;
  }) as Promise<ContrastViolation[]>;
}
