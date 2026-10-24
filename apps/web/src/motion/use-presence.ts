import { useEffect, useRef, useState } from 'react';

const exitDuration = 160;

/**
 * 退出动画后再卸载：目前只用于 Toast（Modal 交给 Radix 的 data-state）。
 * 减少动态时立刻卸载，不留 160ms 的空窗。
 */
export function usePresence<T extends HTMLElement>(open: boolean, reduced: boolean) {
  const [mounted, setMounted] = useState(open);
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    const node = ref.current;
    if (reduced || !node || typeof node.animate !== 'function') {
      setMounted(false);
      return;
    }
    const animation = node.animate(
      [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(8px)' }],
      { duration: exitDuration, easing: 'cubic-bezier(.22,.61,.36,1)' },
    );
    const finish = () => setMounted(false);
    animation.finished.then(finish, finish);
    return () => animation.cancel();
  }, [open, reduced, mounted]);
  return { mounted, ref };
}
