import { useEffect, useState } from 'react';
import { androidModelBridge, checkedAndroidModelStatus } from './android-model';

export function ProviderStatusPanel() {
  const [status, setStatus] = useState<{ available: boolean } | null>(null);
  useEffect(() => {
    let mounted = true;
    const androidBridge = androidModelBridge();
    const bridge = window.nuanbanTextQuestion;
    if (!androidBridge && (!bridge || typeof bridge.status !== 'function')) { setStatus({ available: false }); return; }
    const timer = setTimeout(() => { if (mounted) setStatus({ available: false }); }, 2500);
    const read = androidBridge
      ? Promise.resolve().then(() => androidBridge.status()).then(value => ({ available: checkedAndroidModelStatus(value).available }))
      : Promise.resolve().then(() => bridge!.status()).then(value => ({ available: value?.available === true }));
    void read.then(value => {
      if (!mounted) return;
      clearTimeout(timer);
      setStatus({ available: value?.available === true });
    }).catch(() => { if (mounted) { clearTimeout(timer); setStatus({ available: false }); } });
    return () => { mounted = false; clearTimeout(timer); };
  }, []);
  return <section className="panel" aria-label="智能服务状态"><h2>智能服务</h2><p role="status">{!status ? '正在读取服务状态…' : status.available ? '服务已配置。连接结果以实际请求为准。' : '服务未配置或暂不可用。不会使用固定回答或假装连接成功。'}</p><p className="small-note">发送文字会将本次问题交给已配置的云端服务；图片须单次确认并在本机检测脱敏后发送。密钥或设备会话只留在客户端受信原生层，不显示在页面中。</p></section>;
}
