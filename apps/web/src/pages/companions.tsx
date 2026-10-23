import { Link, NavLink } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, Box, Leaf, ShieldCheck, Sparkles } from 'lucide-react';
import { PageTitle, Pet } from '../components';
import { lumiModel } from '../three-d/builtin-models';
import { LiliCard } from '../three-d/lili-card';
import { LumiCard } from '../three-d/lumi-card';
import './companions.css';

export function CompanionCatalog() {
  return <section className="companion-catalog" aria-label="小鹿与小猫伙伴收藏">
    <Link className="companion-card companion-card-lili" to="/pets/lili">
      <div className="companion-card-art">
        <span className="companion-number">01 / 森林里的小伙伴</span>
        <Pet kind="lili" />
        <span className="companion-format"><Box size={15} aria-hidden="true" />本地 3D 模型</span>
      </div>
      <div className="companion-card-copy">
        <span className="eyebrow">LILI · 栗栗小鹿</span>
        <h2>围一条暖围巾，陪你慢慢来。</h2>
        <p>琥珀大眼、分叉鹿角和橙黄条纹围巾。客户端实时建模，可旋转预览，静态 3D 无需上传。</p>
        <span className="companion-card-link">认识小鹿栗栗<ArrowUpRight size={20} aria-hidden="true" /></span>
      </div>
    </Link>
    <Link className="companion-card companion-card-lumi" to="/pets/lumi">
      <div className="companion-card-art">
        <span className="companion-number">02 / 日常里的小魔法</span>
        <img src={lumiModel.posterUrl} alt="露米小猫，穿着紫色披风、手持星星魔杖" width="1000" height="1250" />
        <span className="companion-format"><Box size={15} aria-hidden="true" />本地 3D 模型</span>
      </div>
      <div className="companion-card-copy">
        <span className="eyebrow">LUMI · 露米小猫</span>
        <h2>把每一天，变成小魔法。</h2>
        <p>真实三维模型，可以转一转、打招呼，试试九个动作。预览不会替换当前桌宠。</p>
        <span className="companion-card-link">认识小猫露米<ArrowUpRight size={20} aria-hidden="true" /></span>
      </div>
    </Link>
  </section>;
}

export function CompanionPage({ companion }: { companion: 'lili' | 'lumi' }) {
  const isLili = companion === 'lili';
  return <>
    <PageTitle eyebrow="每个小伙伴，都有自己的小天地" title={isLili ? '小鹿栗栗' : '小猫露米'} subtitle={isLili ? '客户端实时生成的静态三维小鹿。先旋转预览，再决定是否请到桌面。' : '一只把陪伴变成小魔法的猫。在这里预览真实 3D 与动作，再决定是否请到桌面。'}>
      <Link className="button secondary" to="/pets"><ArrowLeft size={18} aria-hidden="true" />返回伙伴收藏</Link>
    </PageTitle>
    <nav className="companion-switch" aria-label="选择伙伴详情">
      <NavLink to="/pets/lili" className={({ isActive }) => isActive ? 'active' : ''}><Leaf size={18} aria-hidden="true" />小鹿栗栗<span>本地 3D 模型</span></NavLink>
      <NavLink to="/pets/lumi" className={({ isActive }) => isActive ? 'active' : ''}><Sparkles size={18} aria-hidden="true" />小猫露米<span>本地 3D 模型</span></NavLink>
    </nav>
    {isLili ? <LiliCard /> : <LumiCard />}
    <div className="companion-management"><Link className="button secondary" to="/pets/import-3d"><Box size={18} aria-hidden="true" />管理本机模型与切回原画</Link></div>
    <p className="companion-local-note"><ShieldCheck size={18} aria-hidden="true" />浏览与预览仅在本机进行；切换桌宠需要你亲手确认，不会自动授权屏幕或麦克风。</p>
  </>;
}
