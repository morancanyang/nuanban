# 微光指引 · Web 管理端动效系统

> 文档同步：2026-10-23。范围仅限 `apps/web`（管理端页面与外壳）。
> 独立桌宠窗、字幕/指引 Electron 浮层、3D 模型内部动画不在本文范围。

## 目标

给每个模块补三层动效：**入场编排 / 状态转场 / 微交互**；基调「晨光呼吸」——慢、暖、不炫技。
技术路线是 CSS 动效层 + 轻量 WAAPI 编排，**不新增 npm 依赖**。

## 分层

| 层 | 位置 | 职责 |
|---|---|---|
| 令牌 | `packages/design-tokens/src/tokens.css` | 时长、缓动、位移、错峰间隔；只增不改 |
| 基础 | `apps/web/src/motion/base.css` | keyframes `mf-*` 与工具类 `.mf-rise/.mf-fade/.mf-pop` |
| 外壳 | `apps/web/src/motion/shell.css` | 路由转场、侧边栏、抽屉、顶栏、Toast、Modal、加载屏 |
| 页面 | `apps/web/src/motion/pages.css` | 各页面的入场编排与状态转场 |
| 组件 | `apps/web/src/motion/widgets.css` | 按钮、宠物、空态、卡片抬升 |
| 降级 | `apps/web/src/motion/reduced.css` | 减少动态总开关、后台暂停 |
| 入口 | `apps/web/src/motion/index.css` | 按 基础→外壳→页面→组件→降级 顺序聚合 |

JS 编排层（每个文件 ≤200 行）：

| 文件 | 职责 |
|---|---|
| `use-motion-preference.ts` | 有效减少动态 = 设置开关 ∨ 系统偏好，写 `html.reduce-motion` |
| `use-motion-pause.ts` | 页面隐藏 / 窗口失焦写 `html.motion-paused` |
| `use-route-motion.ts` | callback ref + `route-enter` 类，路由切换重放转场 |
| `use-presence.ts` | 退出动画后再卸载（Toast、抽屉幕布） |
| `use-flip-list.ts` | 列表增删的位置补偿（笔记网格、待办列表） |
| `stagger.ts` | 行内 `--i` 错峰序号 |
| `page-key.ts` | 路由 → `<main data-page>`，样式与测试共用的模块键 |

## 令牌

| 令牌 | 值 | 用途 |
|---|---|---|
| `--motion-1` | 120ms | 悬停、按下、勾选 |
| `--motion-2` | 220ms | 消息、展开、提示 |
| `--motion-3` | 340ms | 区块入场 |
| `--motion-4` | 520ms | 页面级编排上限 |
| `--motion-stagger` | 55ms | 列表错峰 |
| `--motion-rise` | 14px | 入场位移 |
| `--motion-lift` | -3px | 卡片悬停抬升 |
| `--motion-ease` | `cubic-bezier(.22,.61,.36,1)` | 主缓动 |
| `--motion-ease-in-out` | `cubic-bezier(.45,.05,.55,.95)` | 呼吸类循环 |
| `--motion-spring` | `cubic-bezier(.34,1.28,.64,1)` | 仅 ≤40px 小元素 |

性能约束：只动 `transform` / `opacity`；颜色与阴影过渡只限小面积且 ≤220ms；不写宽高、`top`、`left` 动画；合成层 ≤3（背景暖阳 + 文字层 + 宠物）。

入场动画一律用 `animation-fill-mode: backwards` 而不是 `both`：结束帧等于基础样式（`opacity:1; transform:none`），
用 `both` 会把动画层的 `transform` 永久压在元素上，导致 `.home-card:hover`、`.note-card:hover` 这类悬停位移失效。
弹窗的开合动画仍用 `both`，因为它需要覆盖 `.modal` 自带的 `translate(-50%,-50%)` 居中并在关闭时保持末帧。

## 模块矩阵

| 模块 | 入场 | 状态转场 | 微交互 |
|---|---|---|---|
| 外壳 | 主内容 `mf-route` | 抽屉滑入、幕布淡入 | 导航图标抬升、选中竖条 |
| 欢迎页 | 6 段错峰 `mf-rise` | 登录说明展开 | 卡片悬停 |
| 首页 | 起始区 + 3 卡 + 下两栏错峰 | 统计数字淡入 | 卡片抬升、箭头右移 |
| 聊天 | 消息按角色左右滑入 | `data-state=streaming` 三点脉冲 | 建议错峰、媒体预览弹入 |
| 笔记 | 前 8 张错峰 | 增删 FLIP 补偿 | 卡片抬升 |
| 待办 | 行动错峰 | 勾选过渡 + 完成后 FLIP 上移 | 危险操作描边 |
| 复习 | 卡片与按钮错峰 | 已记录状态 | 按钮按压 |
| 小伙伴 | 形象按钮错峰 | 选中态弹入 | 宠物呼吸 + 眨眼 |
| 栗栗/露米 | 收藏卡错峰 | 舞台淡入 | 卡片抬升 |
| 画稿 | 面板淡入 | 预览与「已应用」弹入 | 调色圈选中放大 |
| 设置 | 分区淡入 | 危险按钮描边 | 开关过渡 |
| 引导 | 模式卡错峰 | 选中图标弹入 | 卡片抬升 |
| 教学 | 观察面板淡入 | 步骤点弹入、真实高亮呼吸 | 无装饰动效 |
| 冲突 | 卡片错峰 | 选择态过渡 | 按钮按压 |
| 账号 | 标题 + 空态淡入 | — | — |
| 工具小屋 | 头部与快捷入口淡入 | — | 返回按钮悬停 |

`<Pet>` 的 `action-idle` 呼吸 5.2s、眼睛 6.4s 眨一次；`greeting/celebrating` 姿态弹入一次。

## 减少动态语义

- 生效条件：设置页「减少动画」勾选，**或**系统 `prefers-reduced-motion: reduce`。
- 实现：`animation-duration/.transition-duration` 压到 `.001ms`，`animation-delay` 归零，循环只跑一轮。
  这样保留终态，不会因为 `backwards` 填充把内容留在不可见状态；实测 Chromium 会把这种零时长动画的
  `animation-name` 计算为 `none`，内容直接可见。
- 作用面：挂在 `<html>`，因此 Radix Portal 弹窗、欢迎页、背景层一并覆盖。
- 后台暂停：`visibilitychange` 与窗口 `blur` 时写 `html.motion-paused`，全部动画 `animation-play-state: paused`。

## 验收

```powershell
pnpm typecheck
pnpm check:boundaries
pnpm build
$env:PLAYWRIGHT_CHANNEL='chrome'
pnpm exec playwright test tests/e2e/motion.spec.ts tests/e2e/accessibility.spec.ts tests/e2e/welcome.spec.ts --project=desktop-chromium
```

`tests/e2e/motion.spec.ts` 覆盖：

1. 13 条主路由的 `data-page`、`route-enter` 与 `.page-title` 入场；
2. 首页卡片 `animation-delay` 递增；
3. 设置开关即时写入 `html.reduce-motion`，卡片时长 < 0.01s 且透明度为 1；
4. 系统 `emulateMedia({ reducedMotion: 'reduce' })` 无需开关即生效，背景扫光 `animation-name: none`；
5. 路由点击后转场重放且主内容获得焦点；
6. 弹窗开合动画与关闭后不残留；
7. 窗口失焦暂停、恢复焦点取消暂停。

## 已知边界

- 独立桌宠窗（`apps/desktop/pet.*`）已有自己的 `pet-idle` 与语音态动效，本轮未改动；如需统一令牌是后续独立任务。
- 3D 视图内部（`three-d/viewer.ts`、`animation-controller.ts`）继续按 `prefers-reduced-motion` 决定是否自动播放，不含在本次 CSS 层内。
- 两个既有 e2e 用例（`tests/e2e/pet-appearance.spec.ts` 第 3、52 行）在当前 HEAD 上即失败，原因是用例期望「调用栗栗桌宠」，而实现按浏览器能力渲染「在本页显示栗栗」，与动效无关。
- `pnpm test` 在当前机器上有 203 项环境性失败（原生宿主/打包类用例），改动前后计数一致。
