import { useLayoutEffect, useRef } from 'react';

const flipDuration = 220;
const flipEasing = 'cubic-bezier(.22,.61,.36,1)';

function keyOf(node: HTMLElement, index: number): string {
  return node.dataset.flipKey ?? `index-${index}`;
}

/**
 * 列表增删的位置补偿（FLIP）：只对留下的行做 transform 补间，
 * 新行/被删行交给各自的入场动画与重排，不猜高度、不动 layout 属性。
 * signature 用列表 id 拼接，变化即表示列表结构变了。
 */
export function useFlipList<T extends HTMLElement>(signature: string) {
  const containerRef = useRef<T | null>(null);
  const previous = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const reduced = document.documentElement.classList.contains('reduce-motion');
    const nodes = Array.from(container.children).filter(
      (node): node is HTMLElement => node instanceof HTMLElement,
    );
    const next = new Map<string, number>();
    nodes.forEach((node, index) => next.set(keyOf(node, index), node.getBoundingClientRect().top));
    if (!reduced) {
      nodes.forEach((node, index) => {
        const key = keyOf(node, index);
        const before = previous.current.get(key);
        const after = next.get(key);
        if (before === undefined || after === undefined) return;
        const delta = before - after;
        if (Math.abs(delta) < 2) return;
        node.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], {
          duration: flipDuration,
          easing: flipEasing,
        });
      });
    }
    previous.current = next;
  }, [signature]);
  return containerRef;
}
