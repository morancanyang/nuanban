import type { CSSProperties } from 'react';

/** 行内错峰序号：交给 CSS 的 calc(var(--i) * var(--motion-stagger))。 */
export function stagger(index: number, max = 8): CSSProperties {
  return { '--i': Math.min(index, max) } as CSSProperties;
}
