import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, CalendarCheck, Check, Eye, LockKeyhole, MessageCircle, Monitor, PawPrint } from 'lucide-react';
import { useApp } from '../store';
import { PageTitle } from '../components';
import { ScreenObservationPanel } from '../screen-observation';
import { ProviderStatusPanel } from '../provider-status';
import './home.css';

export function HomePage() {
  const snapshot = useApp(state => state.snapshot!);
  const notes = snapshot.notes.filter(note => !note.deletedAt);
  const todos = snapshot.todos.filter(todo => !todo.deletedAt && !todo.completedAt);
  return <>
    <PageTitle eyebrow="不用着急，我们慢慢来" title="今天想学点什么？" subtitle="从你的问题开始。不会预置学习记录，也不会替你点击电脑。" />
    <section className="home-start" aria-label="开始使用暖伴">
      <div className="home-start-copy">
        <h2>暖伴在这里，陪你一步一步学会。</h2>
        <p>可以打字、选图片，或通过独立桌宠在本人确认后观察真实软件。</p>
        <div className="home-actions">
          <Link className="button primary" to="/chat/new"><MessageCircle size={20} />和暖伴说说</Link>
          <Link className="button secondary" to="/overlay/guide"><Monitor size={20} />真实软件教学</Link>
        </div>
      </div>
      <dl className="home-stats">
        <div className="home-stat">
          <dt>学习记录</dt>
          <dd>{notes.length}</dd>
          <Link to="/notes">查看笔记<ArrowRight size={15} /></Link>
        </div>
        <div className="home-stat">
          <dt>待办与复习</dt>
          <dd>{todos.length}</dd>
          <Link to="/todos">查看待办<ArrowRight size={15} /></Link>
        </div>
      </dl>
    </section>
    <div className="home-cards">
      <Link className="home-card" to="/notes">
        <span className="home-card-icon"><BookOpen size={26} /></span>
        <h3>我的学习笔记</h3>
        <p>{notes.length ? `已保存 ${notes.length} 条学习记录` : '还没有学习记录，从一次真实提问开始。'}</p>
        <span className="home-card-foot">打开笔记<ArrowRight size={16} /></span>
      </Link>
      <Link className="home-card" to="/todos">
        <span className="home-card-icon"><CalendarCheck size={26} /></span>
        <h3>待办与复习</h3>
        <p>{todos.length ? `${todos.length} 项待办未完成` : '没有待办，可按需要亲手创建。'}</p>
        <span className="home-card-foot">打开待办<ArrowRight size={16} /></span>
      </Link>
      <Link className="home-card" to="/pets">
        <span className="home-card-icon"><PawPrint size={26} /></span>
        <h3>我的小伙伴</h3>
        <p>使用内置形象、自己的画稿或本机模型。</p>
        <span className="home-card-foot">打开小伙伴<ArrowRight size={16} /></span>
      </Link>
    </div>
    <div className="home-lower">
      <section className="panel home-guide" aria-labelledby="home-guide-title">
        <span className="eyebrow">开始之前</span>
        <h2 id="home-guide-title">只在你的允许范围内帮忙</h2>
        <p>没有预置记录，也不会替你操作电脑。</p>
        <ul>
          <li><Eye size={20} aria-hidden="true" /><span><strong>屏幕与麦克风默认关闭</strong>只有你本人选择范围并确认用途后，桌宠才会观察。</span></li>
          <li><LockKeyhole size={20} aria-hidden="true" /><span><strong>密钥只留在本机受信进程</strong>图片需单次确认，并在本机检测脱敏后再发送。</span></li>
          <li><Check size={20} aria-hidden="true" /><span><strong>每一步都由你亲手完成</strong>教学只绘制高亮和箭头，点击与输入始终由你自己来。</span></li>
        </ul>
      </section>
      <ProviderStatusPanel />
    </div>
  </>;
}

export function GuidePage() {
  return <>
    <PageTitle eyebrow="真实软件，由你亲手操作" title="让桌宠陪你一步一步学" subtitle="不再使用应用内假手机或模拟核验。请在独立桌宠中选择范围、确认观察并提问。" />
    <section className="panel"><ScreenObservationPanel onPractice={() => { window.location.hash = '/chat/new'; }} /><p className="small-note">屏幕与麦克风默认关闭。未知、敏感或检测失败时暂停；模型不会获得点击、键盘或系统操作权限。</p></section>
  </>;
}
