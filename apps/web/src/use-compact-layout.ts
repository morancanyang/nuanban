import { useEffect, useState } from 'react';

const query = '(max-width: 760px)';

/** 是否处于窄窗（抽屉式侧边栏）布局：与 responsive.css 的断点保持一致。 */
export function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = (event: MediaQueryListEvent) => setCompact(event.matches);
    setCompact(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return compact;
}
