import { useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import type { PetKind } from '@nuanban/domain';
import { Pet } from './components';
import './browser-companion.css';

export type BrowserCompanionRequest =
  | { kind: Exclude<PetKind, 'lili'>; label: string }
  | { kind: 'lumi' | 'lili' | 'drawing'; label: string; imageUrl: string };

let currentCompanion: BrowserCompanionRequest | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function showBrowserCompanion(companion: BrowserCompanionRequest): void {
  currentCompanion = companion;
  notify();
}

export function hideBrowserCompanion(): void {
  if (!currentCompanion) return;
  currentCompanion = null;
  notify();
}

export function useBrowserCompanion(): BrowserCompanionRequest | null {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => currentCompanion,
    () => null,
  );
}

export function BrowserCompanionOverlay() {
  const companion = useBrowserCompanion();
  if (!companion) return null;

  const imageCompanion = companion.kind === 'lumi' || companion.kind === 'lili' || companion.kind === 'drawing';
  return <aside className="browser-companion-layer" aria-label={`网页陪伴：${companion.label}`}>
    <div className="browser-companion-card" data-companion-kind={companion.kind}>
      <div className="browser-companion-heading">
        <span>当前页面陪伴</span>
        <button type="button" className="browser-companion-close" aria-label="关闭页面陪伴" onClick={hideBrowserCompanion}><X size={18} aria-hidden="true" /></button>
      </div>
      <div className="browser-companion-body">
        <div className="browser-companion-visual">
          {imageCompanion
            ? <img src={companion.imageUrl} alt={`${companion.label}，当前页面陪伴`} draggable={false} />
            : <Pet kind={companion.kind as PetKind} />}
        </div>
        <div className="browser-companion-copy">
          <strong>{companion.label}在这里陪你</strong>
          <p>手机浏览器中的页面陪伴</p>
        </div>
      </div>
      <p className="browser-companion-boundary">仅显示在当前页面，不会替换系统桌宠。</p>
    </div>
  </aside>;
}
