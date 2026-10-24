import { useEffect, useState } from 'react';

/**
 * 路由入场：返回一个 callback ref，节点挂上时记下来；
 * 每次 pathname 变化都摘掉再挂回 route-enter，触发一次重放。
 * 类名保留在元素上（动画已结束也不移除），端到端测试因此可以稳定断言。
 * 用 callback ref 而不是 useRef，是因为 App 首帧只渲染加载屏，<main> 稍后才挂载。
 */
export function useRouteMotion(route: string, reduced: boolean): (node: HTMLElement | null) => void {
  const [node, setNode] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!node) return;
    node.classList.remove('route-enter');
    if (reduced) return;
    void node.offsetWidth;
    node.classList.add('route-enter');
  }, [node, route, reduced]);
  return setNode;
}
