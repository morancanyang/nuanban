import { useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check } from 'lucide-react';
import { BrandMark } from '../brand-mark';
import { Ambient } from '../ambient';
import { LoginScene } from '../login-scene';
import { config } from '../composition';
import { readEntry, writeEntry } from '../entry';
import { useApp } from '../store';
import './welcome.css';

const proofs = ['不收手机号、验证码', '资料只存本机', '免费公益，不催促'] as const;

const loginState = config.apiMode === 'real'
  ? {
      title: '已连接远程业务服务',
      detail: '账号注册与设备绑定入口尚未开放，登录能力仍不可用；不会生成任何凭证。',
    }
  : {
      title: '当前是本机模式',
      detail: '账号服务没有接通，登录能力尚未开放；不会生成任何凭证。',
    };

export function WelcomePage() {
  const navigate = useNavigate();
  const reducedMotion = useApp(state => state.snapshot?.preferences.reducedMotion ?? false);
  const fontScale = useApp(state => state.snapshot?.preferences.fontScale ?? 1);
  const [loginOpen, setLoginOpen] = useState(false);
  const returning = readEntry() !== null;

  const enterAsGuest = () => {
    writeEntry('guest');
    navigate('/', { replace: true });
  };

  return <div className={'welcome' + (reducedMotion ? ' reduce-motion' : '')} style={{ '--font-scale': fontScale } as CSSProperties}>
    <Ambient variant="full" />
    <main className="welcome-main">
      <section className="welcome-intro">
        <p className="welcome-brand">
          <BrandMark className="welcome-mark" size={44} />
          <span><strong>暖伴</strong><small>陪你慢慢学会</small></span>
        </p>
        <h1>先坐一会儿，<br /><span className="welcome-h1-accent">我们慢慢开始。</span></h1>
        <p className="welcome-lead">不用注册也能用。笔记和待办只留在这台电脑上，不会替你点按钮。</p>
        <div className="welcome-scene-wrap">
          <LoginScene />
          <span className="welcome-scene-note">今天也可以只学一点点</span>
        </div>
        <ul className="welcome-proof">
          {proofs.map(item => <li key={item}><Check size={14} aria-hidden="true" />{item}</li>)}
        </ul>
      </section>

      <section className="welcome-card" aria-label="进入暖伴">
        <span className="welcome-status"><i aria-hidden="true" />本机模式 · 不上传</span>
        <h2>{returning ? '欢迎回来' : '进入暖伴'}</h2>
        <p className="welcome-card-lead">{returning ? '上次是以游客身份进入的，可以继续。' : '先用游客身份进来，笔记和待办只留在这台电脑。'}</p>
        <button className="button primary full" type="button" onClick={enterAsGuest}>
          {returning ? '继续以游客身份进入' : '游客模式，直接进入'}
        </button>
        <button className="button secondary full" type="button" aria-expanded={loginOpen} onClick={() => setLoginOpen(open => !open)}>
          {loginOpen ? '收起登录说明' : '登录暖伴账号'}
        </button>
        {loginOpen && <div className="welcome-login" role="region" aria-label="账号服务状态">
          <strong>{loginState.title}</strong>
          <p>{loginState.detail}</p>
          <p className="welcome-login-safe">本页不收集手机号、验证码、人脸或任何登录凭证。</p>
          <Link to="/onboarding/login" className="welcome-login-link">查看账号服务状态</Link>
        </div>}
        <p className="welcome-note">游客模式不建立账号，资料保存在本机，可在「设置与隐私」里清空。</p>
      </section>
    </main>
    <footer className="welcome-foot">暖伴公益助手 · 本机资料 · 真实模型接口</footer>
  </div>;
}
