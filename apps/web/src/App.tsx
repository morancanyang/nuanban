import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Route, Routes, Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Home as HomeIcon, MessageCircle, BookOpen, CalendarCheck, PawPrint, Settings, ShieldCheck, Square, ArrowUpRight, Bell, X, Menu } from 'lucide-react';
import { useApp, announce, safely } from './store';
import { config, platform, services } from './composition';
import { bindLifecycleEvents, LifecycleCoordinator, ReminderRuntime, type LifecycleCleanupReport } from '@nuanban/platform-ports';
import { Pet, MuteButton } from './components';
import { BrandMark } from './brand-mark';
import { FontScaleControls } from './font-controls';
import { Ambient } from './ambient';
import { readEntry } from './entry';
import './motion/index.css';
import { useMotionPreference } from './motion/use-motion-preference';
import { useMotionPause } from './motion/use-motion-pause';
import { useRouteMotion } from './motion/use-route-motion';
import { usePresence } from './motion/use-presence';
import { pageKey } from './motion/page-key';
import { useCompactLayout } from './use-compact-layout';
import { useDocumentTitle } from './document-title';
import { WelcomePage } from './pages/welcome';
import { DesktopPetButton } from './desktop-pet-button';
import { BrowserCompanionOverlay } from './browser-companion';
import { PetWorkspaceHeader, useDesktopWorkspace } from './pet-workspace';
import { HomePage, GuidePage } from './pages/core';
import { ChatPage } from './pages/chat';
import { PetJobPage } from './pages/pet-job';
import { CompanionPage } from './pages/companions';
import { ConflictsPage } from './pages/conflicts';
import { AccountPage } from './pages/account';
import { NotesPage, NotePage, TodosPage, ReviewPage } from './pages/learning';
import { PetsPage, DrawingPage, SettingsPage, OnboardingPage } from './pages/support';
const navigation=[{to:'/',label:'微光指引首页',icon:HomeIcon},{to:'/chat/new',label:'和微光指引说说',icon:MessageCircle},{to:'/notes',label:'我的学习笔记',icon:BookOpen},{to:'/todos',label:'待办与复习',icon:CalendarCheck},{to:'/pets',label:'我的小伙伴',icon:PawPrint}];
function reportLifecycleFailure(report: LifecycleCleanupReport): void {
  if (report.restartBlocked) useApp.setState({error:'本页流程已停止，但原生停止未确认。请检查系统权限；不会自动恢复。'});
}
export function App(){
  const workspace = useDesktopWorkspace();
  const petTool = workspace.mode === 'pet-tool';
  const state=useApp(); const location=useLocation(); const navigate=useNavigate(); const [menu,setMenu]=useState(false);
  const previousRoute = useRef<string | null>(null);
  const compactLayout = useCompactLayout();
  const drawerOpen = compactLayout && menu;
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const drawerWasOpen = useRef(false);
  useDocumentTitle(location.pathname, state.ready);
  const reducedMotion = useMotionPreference();
  useMotionPause();
  const attachMain = useRouteMotion(location.pathname, reducedMotion);
  const backdrop = usePresence<HTMLButtonElement>(menu, reducedMotion);
  const toast = usePresence<HTMLDivElement>(Boolean(state.toast), reducedMotion);
  const [lastToast, setLastToast] = useState<string | null>(null);
  useEffect(() => { if (state.toast) setLastToast(state.toast); }, [state.toast]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(false); };
    document.addEventListener('keydown', onKeyDown);
    navRef.current?.querySelector<HTMLAnchorElement>('.nav-item')?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);
  useEffect(() => {
    if (drawerOpen) { drawerWasOpen.current = true; return; }
    if (!drawerWasOpen.current) return;
    drawerWasOpen.current = false;
    menuButtonRef.current?.focus();
  }, [drawerOpen]);
  const reminderRuntime = useMemo(() => new ReminderRuntime(services.ownerId, platform, {
    onDue: ({ todo, request }) => {
      announce('复习时间到了：' + todo.title);
        if (platform.capabilities.platform !== 'browser' && platform.notifyReminderDue) {
          void platform.notifyReminderDue(request).catch(error => useApp.setState({ error: error instanceof Error ? error.message : '原生提醒派发失败，已保留本地待办。' }));
        }
      if (platform.capabilities.platform === 'browser' && platform.capabilities.notifications && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const notification = new Notification('微光指引 · 复习提醒', { body: '有一项提醒到期，请打开微光指引查看。', tag: request.instanceId });
        notification.onclick = () => {
          window.focus();
          window.location.hash = todo.noteId ? '/review/' + todo.noteId : '/todos/edit/' + todo.id;
          notification.close();
        };
      }
    },
  }), [navigate]);
  const lifecycleCoordinator = useMemo(() => {
    const nativePlatform = platform.capabilities.platform;
    if (nativePlatform === 'browser') return null;
    const coordinator = new LifecycleCoordinator(nativePlatform, {
      closeOutlets: () => platform.stopAll(),
      clearQueue: async () => { window.dispatchEvent(new Event('nuanban:stop')); },
      stopTrack: async () => { if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); },
      hideOverlay: async () => { window.dispatchEvent(new Event('nuanban:host-cleanup')); },
    });
    coordinator.start(1);
    return coordinator;
  }, []);
  useEffect(()=>{setMenu(false);if(previousRoute.current === null){previousRoute.current=location.pathname;return;}if(previousRoute.current !== location.pathname){previousRoute.current=location.pathname;const main=document.getElementById('main-content');main?.focus();}},[location.pathname]);
  useEffect(()=>{
    const openReminder=(event: Event)=>{
      const detail=(event as CustomEvent<{deepLink?:unknown}>).detail;
      if(typeof detail?.deepLink!=='string')return;
      const deepLink=detail.deepLink;
      const route=deepLink.startsWith('nuanban://review/')?'/review/'+deepLink.slice('nuanban://review/'.length):deepLink.startsWith('nuanban://todo/')?'/todos/edit/'+deepLink.slice('nuanban://todo/'.length):deepLink;
      if(/^\/(?:review|todos(?:\/edit)?)(?:\/[a-zA-Z0-9-]{1,80})?$/.test(route))navigate(route);
    };
    window.addEventListener('nuanban:reminder-open',openReminder);
    return()=>window.removeEventListener('nuanban:reminder-open',openReminder);
  },[navigate]);
  useEffect(()=>{
    if (lifecycleCoordinator) {
      const binding=bindLifecycleEvents(lifecycleCoordinator,window,{onCleanup:reportLifecycleFailure,onError:error=>useApp.setState({error:error instanceof Error?error.message:'生命周期事件处理失败，已保持停止。'})});
      const hide=()=>{if(document.hidden)void lifecycleCoordinator.signal('lock').then(reportLifecycleFailure).catch(()=>undefined);};
      document.addEventListener('visibilitychange',hide);
      return()=>{document.removeEventListener('visibilitychange',hide);binding.dispose();};
    }
    const stopForHost=()=>{window.dispatchEvent(new Event('nuanban:stop'));void platform.stopAll().catch(()=>useApp.setState({error:'本页流程已停止，但原生停止未确认。请检查系统权限；不会自动恢复。'}));};
    const hide=()=>{if(document.hidden)stopForHost();};
    document.addEventListener('visibilitychange',hide);
    window.addEventListener('nuanban:host-pause',stopForHost);
    return()=>{document.removeEventListener('visibilitychange',hide);window.removeEventListener('nuanban:host-pause',stopForHost);};
  },[lifecycleCoordinator]);
  useEffect(()=>{if(!state.toast)return;const timer=setTimeout(()=>useApp.setState({toast:null}),6500);return()=>clearTimeout(timer);},[state.toast]);
  useEffect(()=>{
    const sync=()=>{void reminderRuntime.sync(useApp.getState().snapshot?.todos ?? []);};
    sync();
    const timer=setInterval(sync,15000);
    const stopOnPageHide=()=>{void reminderRuntime.stop();};
    window.addEventListener('pagehide',stopOnPageHide);
    return()=>{clearInterval(timer);window.removeEventListener('pagehide',stopOnPageHide);};
  },[reminderRuntime]);
  if(workspace.error)return <div className="loading-screen" role="alert"><Pet/><h1>桌宠工具暂时无法打开</h1><p>{workspace.error}</p><button className="button primary" onClick={()=>window.location.reload()}>重新尝试</button></div>;
  if(!state.ready || workspace.mode === null)return <div className="loading-screen"><Pet/><h1>微光指引正在准备你的学习小天地…</h1></div>;
  if(!state.snapshot)return <div className="loading-screen"><h1>本地资料暂时无法打开</h1><p>{state.error}</p><button className="button primary" onClick={()=>window.location.reload()}>重新尝试</button></div>;
  const preferences=state.snapshot.preferences;
  if(location.pathname === '/welcome')return <WelcomePage/>;
  if(!petTool && location.pathname === '/' && readEntry() === null)return <Navigate to="/welcome" replace/>;
  const stop=()=>{window.dispatchEvent(new Event('nuanban:stop'));void platform.stopAll().catch(()=>useApp.setState({error:'本页流程已停止，但原生停止未确认。请检查系统权限；不会自动恢复。'}));announce('已停止本页讲解和教学，不会自动恢复。');};
  return <div className={'app mode-'+preferences.mode+(petTool?' pet-tool-workspace':'')} style={{'--font-scale':preferences.fontScale,'--caption-size':preferences.captionSize+'px'} as React.CSSProperties}>
    <Ambient/>
    <BrowserCompanionOverlay/>
    {petTool&&<PetWorkspaceHeader/>}
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>跳到主要内容</a>
    <aside id="app-sidebar" className={'sidebar'+(menu?' is-open':'')} inert={compactLayout && !menu}>{compactLayout&&<button className="icon-button sidebar-close" type="button" aria-label="收起导航" onClick={()=>setMenu(false)}><X size={22}/></button>}<Link className="brand" to="/" aria-label="微光指引首页"><BrandMark className="brand-mark"/><div><strong>微光指引</strong><small>陪你慢慢学会</small></div></Link><div className="sidebar-section-label">你的学习小天地</div><nav aria-label="主要导航" ref={navRef}>{navigation.map(item=><NavLink key={item.to} to={item.to} end={item.to==='/'} className={({isActive})=>'nav-item'+(isActive?' active':'')}><item.icon size={22}/><span>{item.label}</span></NavLink>)}<NavLink className="nav-item" to="/settings"><Settings size={22}/>设置与隐私</NavLink><DesktopPetButton onOpened={()=>setMenu(false)}/></nav><div className="sidebar-bottom"><div className="sidebar-foot"><span className="online-dot"/>本机资料 · 真实模型接口</div></div></aside>
    {backdrop.mounted&&<button ref={backdrop.ref} className="sidebar-backdrop" aria-label="收起导航" onClick={()=>setMenu(false)}/>}
    <div className="workspace" inert={drawerOpen}><header className="topbar"><div className="topbar-left"><button ref={menuButtonRef} className="icon-button mobile-menu" aria-label="展开导航" aria-expanded={menu} aria-controls="app-sidebar" onClick={()=>setMenu(!menu)}><Menu/></button><span className="status-pill"><ShieldCheck size={17}/>安全陪伴，不替你操作</span></div><div className="topbar-actions"><FontScaleControls/><MuteButton/><Link className="icon-button" to="/todos" aria-label="查看提醒"><Bell size={21}/></Link><button className="stop-button" onClick={stop}><Square size={15} fill="currentColor"/>随时停止</button><Link className="profile-chip" to="/onboarding/mode"><span>暖</span><div>{preferences.mode==='child'?'儿童模式':preferences.mode==='accessible'?'无障碍模式':'长辈模式'}<small>本机用户</small></div></Link></div></header>
    <div className="demo-ribbon"><span>本机资料</span>文字按需交给已配置模型；图片与屏幕须先经本机检查。<Link to="/settings/status">查看接口与能力状态 <ArrowUpRight size={14}/></Link></div>
    {!!state.snapshot?.conflicts?.length&&<div className="conflict-banner" role="status">有 {state.snapshot.conflicts.length} 份修改尚未保存，草稿已保留。<Link to="/sync/conflicts">比较并选择冲突内容</Link></div>}<main id="main-content" tabIndex={-1} ref={attachMain} aria-label="主要内容" data-page={pageKey(location.pathname)}><Routes><Route path="/onboarding/login" element={<AccountPage/>}/><Route path="/sync/conflicts" element={<ConflictsPage/>}/><Route path="/" element={<HomePage/>}/><Route path="/chat/:sessionId" element={<ChatPage/>}/><Route path="/overlay/guide" element={<GuidePage/>}/><Route path="/notes" element={<NotesPage/>}/><Route path="/notes/:id" element={<NotePage/>}/><Route path="/review/:id" element={<ReviewPage/>}/><Route path="/todos" element={<TodosPage/>}/><Route path="/todos/edit/:id" element={<TodosPage/>}/><Route path="/pets" element={<PetsPage/>}/><Route path="/pets/lili" element={<CompanionPage companion="lili"/>}/><Route path="/pets/lumi" element={<CompanionPage companion="lumi"/>}/><Route path="/pets/draw" element={<DrawingPage/>}/><Route path="/pets/import-3d" element={<PetsPage/>}/><Route path="/pets/jobs/:id" element={<PetJobPage/>}/><Route path="/settings/*" element={<SettingsPage/>}/><Route path="/onboarding/*" element={<OnboardingPage/>}/><Route path="/overlay/pet" element={<PetsPage/>}/><Route path="/overlay/captions" element={<ChatPage/>}/><Route path="*" element={<div className="empty"><h1>这个页面不在这里</h1><Link className="button primary" to="/">回微光指引首页</Link></div>}/></Routes></main><footer className="page-footer"><span>一份耐心的陪伴，免费，也不催促。</span><span>微光指引公益助手 · 本机真实模型接口</span></footer></div>
    {state.error&&<div className="toast error" role="alert"><span>{state.error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={state.clearError}><X size={18}/></button></div>}
    {toast.mounted&&!state.error&&<div ref={toast.ref} className="toast" role="status"><ShieldCheck size={22}/><span>{lastToast}</span><button className="icon-button" aria-label="关闭提示" onClick={()=>useApp.setState({toast:null})}><X size={18}/></button></div>}
  </div>;
}
