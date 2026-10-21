type BrandMarkProps = {
  className?: string;
  size?: number;
};

/**
 * 暖伴品牌标识：陶土色圆角方底 + 四趾心形肉垫爪印。
 * 爪印代表桌宠的陪伴，心形肉垫代表耐心与照顾；整体轻微左倾，保留手作感。
 * 与 apps/web/public/favicon.svg 共用同一套几何，改动时两处一起改。
 */
export function BrandMark({ className, size = 48 }: BrandMarkProps) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="18" fill="#A64B2A" />
      <g transform="rotate(-5 32 32)" fill="#FFF8EF">
        <ellipse cx="15.8" cy="23.6" rx="5" ry="6.1" transform="rotate(-24 15.8 23.6)" />
        <ellipse cx="26.4" cy="17.4" rx="5.3" ry="6.5" transform="rotate(-8 26.4 17.4)" />
        <ellipse cx="37.6" cy="17.4" rx="5.3" ry="6.5" transform="rotate(8 37.6 17.4)" />
        <ellipse cx="48.2" cy="23.6" rx="5" ry="6.1" transform="rotate(24 48.2 23.6)" />
        <path d="M32 52.4c-7.8-5.9-13.5-10.7-13.5-16.4 0-4.5 3.5-7.8 7.5-7.8 2.5 0 4.7 1.4 6 3.5 1.3-2.1 3.5-3.5 6-3.5 4 0 7.5 3.3 7.5 7.8 0 5.7-5.6 10.5-13.5 16.4Z" />
      </g>
    </svg>
  );
}
