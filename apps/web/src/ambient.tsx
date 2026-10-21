import './ambient.css';

/**
 * 「日出暖光」背景层：纸纹 + 底部暖阳 + 缓慢旋转的光束 + 扫过的柔光。
 * 欢迎页用 full 变体（暖阳 + 光束齐全），应用内用 page 变体（更淡、无光束）。
 * 减少动态由全局 .reduce-motion / prefers-reduced-motion 规则接管，只保留静态纸纹与暖阳。
 * 纯装饰，aria-hidden 且 pointer-events:none，不参与任何交互。
 */
export function Ambient({ variant = 'page' }: { variant?: 'page' | 'full' }) {
  return <div className={'ambient' + (variant === 'full' ? ' ambient--full' : '')} aria-hidden="true">
    <span className="ambient-sun" />
    <span className="ambient-rays" />
  </div>;
}
