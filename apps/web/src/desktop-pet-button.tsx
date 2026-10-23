import { useState } from 'react';
import { ArrowUpRight, PawPrint } from 'lucide-react';
import { localObservationBridge } from './local-observation';
import { announce, useApp } from './store';
import { showBrowserCompanion } from './browser-companion';
import { liliModel } from './three-d/builtin-models';
import './desktop-pet-button.css';

export function DesktopPetButton({ onOpened }: { onOpened(): void }) {
  const [opening, setOpening] = useState(false);

  async function openPet() {
    if (opening) return;
    const bridge = localObservationBridge();
    if (!bridge) {
      const preferences = useApp.getState().snapshot?.preferences;
      const kind = preferences?.pet ?? 'cat';
      const labels = { cat: '小橘猫', rabbit: '小白兔', dog: '小暖狗', lili: '栗栗' } as const;
      showBrowserCompanion(kind === 'lili' ? { kind, label: labels[kind], imageUrl: liliModel.posterUrl } : { kind, label: labels[kind] });
      onOpened();
      announce(`${labels[kind]}已显示在当前页面；系统悬浮桌宠仍需使用桌面客户端。`);
      return;
    }
    setOpening(true);
    try {
      await bridge.showPet();
      onOpened();
      announce('桌宠已显示在桌面。');
    } catch (error) {
      useApp.setState({ error: error instanceof Error ? error.message : '桌宠未能打开，请重试。' });
    } finally {
      setOpening(false);
    }
  }

  return <button type="button" className="nav-item desktop-pet-button" onClick={() => void openPet()}
    disabled={opening} aria-busy={opening} title="显示桌宠，已最小化或关闭也可重新打开">
    <PawPrint size={22} aria-hidden="true"/><span>{opening ? '正在打开桌宠…' : '打开桌宠'}</span>
    <ArrowUpRight size={17} className="desktop-pet-open-icon" aria-hidden="true"/>
  </button>;
}
