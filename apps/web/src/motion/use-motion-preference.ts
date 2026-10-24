import { useEffect, useState } from 'react';
import { useApp } from '../store';

const query = '(prefers-reduced-motion: reduce)';

function prefersReduced(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/**
 * 有效「减少动态」= 设置页开关 ∨ 系统偏好。
 * 结果写到 <html>，这样 Radix Portal、欢迎页和背景层都被同一套规则覆盖。
 */
export function useMotionPreference(): boolean {
  const preference = useApp(state => state.snapshot?.preferences.reducedMotion ?? false);
  const [system, setSystem] = useState(prefersReduced);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = (event: MediaQueryListEvent) => setSystem(event.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const reduced = preference || system;
  useEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', reduced);
  }, [reduced]);
  return reduced;
}
