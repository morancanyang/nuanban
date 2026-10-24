# 微光指引 · Web 端必修无障碍修复

> 文档同步：2026-10-24。范围 `apps/web` + `packages/design-tokens`，不涉及 domain/contracts/存储迁移。

## 修了什么

| 项 | 修复前 | 修复后 |
|---|---|---|
| 次要文字对比度 | 32 处低于 WCAG AA，最低 2.69:1 | 0 处低于 4.5:1（大字 3:1） |
| 窄窗隐藏侧边栏 | 关闭时仍可被 Tab 聚焦，6 个屏幕外焦点位；无 Esc；无 `aria-expanded` | 关闭时 `inert`，Tab 不进入；打开后焦点进入抽屉、Esc 关闭并回焦菜单按钮 |
| 渲染异常 | 整屏白屏 | 兜底页「页面出了点问题 + 重新加载」，不清理本机资料 |
| 页面标题 | 所有路由同一个标题 | `{页面 H1} · 微光指引`；欢迎页保留品牌标题 |
| 触达尺寸 | 顶部说明链接 23px、用户菜单 41px | 28px / 44px |

## 关键改动

- `packages/design-tokens/src/tokens.css`：`--muted` 由 `#8A7966` 调深为 `#6F6152`，
  在纸色、白卡、浅灰底上分别为 5.68 / 5.62 / 5.0+，仍保持暖棕。
- 19 处硬编码浅灰（`styles.css`、`support.css`、`pages/welcome.css`、`pages/home.css`、`pages/companions.css`）
  统一改为 `var(--muted)`；`.nav-item` 未选中色由 `#706351` 调至 `#665A4A`，避免切换时落在选中底色上不达标。
- 装饰性字形（空态 ✳、复习卡花）加 `aria-hidden="true"`，不再当作正文参与对比度要求。
- `apps/web/src/use-compact-layout.ts`：760px 断点监听，与 `responsive.css` 同步。
- `apps/web/src/App.tsx`：`aside` 关闭时 `inert`；抽屉打开时 `workspace` 加 `inert` 形成焦点闭环；
  Esc 关闭；新增 48px「收起导航」按钮；菜单按钮补 `aria-expanded` / `aria-controls`。
- `apps/web/src/error-boundary.tsx` + `bootstrap.tsx`：渲染兜底，仅 `console.error`，不采集不上报。
- `apps/web/src/document-title.ts`：`ready` 就绪后按 H1 更新 `document.title`，欢迎页保留品牌标题。
- `main` 增加 `aria-label="主要内容"`。

## 如何复跑

```powershell
$env:PLAYWRIGHT_CHANNEL='chrome'
pnpm exec playwright test tests/e2e/a11y-basics.spec.ts --project=desktop-chromium
pnpm exec playwright test tests/e2e/a11y-basics.spec.ts --project=mobile-chromium
```

`tests/e2e/a11y-basics.spec.ts` 覆盖：8 条路由的对比度扫描（跳过 `aria-hidden`）、标题跟随 H1、
窄窗抽屉的键盘顺序/Esc/焦点回收、渲染兜底（注入 `matchMedia` 抛错）、触达尺寸。
对比度实现见 `tests/helpers/contrast.ts`，只读计算样式，不依赖截图。

## 本轮没做（按选择保留）

移动端聊天重排（输入框与大字字幕在首屏外）、设计 token 收敛（168 色/21 圆角/28 字号）、
删除 35% 死 CSS、路由级分包、设置页开关样式、空态与文案去重、深色主题。
