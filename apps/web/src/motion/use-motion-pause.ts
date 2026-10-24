import { useEffect } from 'react';

/**
 * 页面隐藏或窗口失焦时暂停全部循环动画：省电，也避免透明桌宠窗空转 GPU。
 * 只切一个 html 上的类，由 reduced.css 统一声明暂停规则。
 */
export function useMotionPause(): void {
  useEffect(() => {
    const root = document.documentElement;
    const setPaused = (value: boolean) => root.classList.toggle('motion-paused', value);
    const onVisibility = () => setPaused(document.hidden);
    const onBlur = () => setPaused(true);
    const onFocus = () => setPaused(false);
    setPaused(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      setPaused(false);
    };
  }, []);
}
