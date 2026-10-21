import { useApp, announce, safely } from './store';

export const FONT_SCALES = [1, 1.1, 1.25] as const;

function nearestIndex(value: number): number {
  let best = 0;
  FONT_SCALES.forEach((scale, index) => {
    if (Math.abs(scale - value) < Math.abs(FONT_SCALES[best] - value)) best = index;
  });
  return best;
}

/**
 * 顶栏字号快捷控件：在 100% / 110% / 125% 三档之间切换，与设置页共用 preferences.fontScale。
 * 只改字号，不改图标与布局；所有文字通过 CSS 的 --font-scale 一起缩放。
 */
export function FontScaleControls() {
  const fontScale = useApp(state => state.snapshot?.preferences.fontScale ?? 1);
  const index = nearestIndex(fontScale);

  const apply = (next: number) => {
    safely(useApp.getState().preferences({ fontScale: next }));
    announce('文字大小：' + Math.round(next * 100) + '%');
  };

  return <div className="font-controls" role="group" aria-label="文字大小">
    <button className="font-button" type="button" aria-label="缩小文字" disabled={index === 0} onClick={() => apply(FONT_SCALES[index - 1])}>A−</button>
    <button className="font-button" type="button" aria-label="放大文字" disabled={index === FONT_SCALES.length - 1} onClick={() => apply(FONT_SCALES[index + 1])}>A+</button>
  </div>;
}
