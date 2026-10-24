import { useEffect } from 'react';

/**
 * 路由变化或数据就绪后，按页面 H1 更新 document.title，
 * 让多标签、历史和读屏都能区分页面；标题只表达页面名，不带任何数据。
 * ready 参与依赖：首帧只有一个加载中的 H1，就绪后必须重算一次。
 */
export function useDocumentTitle(route: string, ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    const frame = requestAnimationFrame(() => {
      // 欢迎页的 H1 是标语而不是页面名，保留品牌标题更利于识别标签页。
      const heading = route.startsWith('/welcome') ? null : document.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim();
      document.title = heading ? `${heading} · 微光指引` : '微光指引 · 陪你慢慢学会';
    });
    return () => cancelAnimationFrame(frame);
  }, [route, ready]);
}
