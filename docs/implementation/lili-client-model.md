# 栗栗：客户端实时三维建模

更新日期：2026-10-23（Asia/Shanghai）。这是客户端程序化静态模型，不是把 Blender 参考渲染图当作实时三维，也不宣称达到离线电影渲染的画质。

## 使用入口

- “我的小伙伴” → “小鹿栗栗” → “预览小鹿 3D 模型”：本地生成几何，可拖动旋转、滚轮缩放；预览不替换桌宠。
- Windows 桌面客户端点击“请栗栗到桌面”并确认后，校验、保存本机小鹿资源，再使用现有透明桌宠窗口显示；正常重启后恢复，可再次召唤。
- “选择内置伙伴”中的“调用栗栗 3D 桌宠”走相同模型调用链；保存／撤回候选外观不自动调用桌宠。
- 浏览器可以旋转预览，但页面陪伴使用透明参考立绘，不替换系统悬浮桌宠。
- 三维小鹿只有本体，没有背景、地面或模型自带灯光，不包含骨骼、动作、表情动画。场景的灯光、相机由客户端 viewer 提供。

## 实现与资源身份

`apps/web/src/three-d/lili-model.ts` 的 `createLiliModel()` 每次创建独立的 Three.js 几何与材质，返回 `format: 'procedural-lili'`、`id: 'lili'` 和空动画列表。细节包括暖棕身体、奶油口鼻与腹部、琥珀分层眼睛及虹膜纹理、分叉鹿角、内耳、背部斑点、尾巴、蹄缝和条纹针织围巾。

详情页、模型管理面板及系统桌宠使用同一建模工厂。眼睛、围巾等细节使用几何、材质或顶点色，不依赖远程纹理；关闭预览时释放控件、WebGL renderer、几何及材质。露米仍使用原有工厂和动画。

内置 `apps/web/public/models/lili/Lili_Independent_Deer.glb` 保留为受信资源身份、持久化载荷和原生检查对象，不是默认显示几何。固定资源为 1,601,548 字节，SHA-256：

```text
35c40f0c66b08fab749f7b711e97dc12dfd911003f375b9a77445c16928d7327
```

该 GLB 有 76,752 个三角形、39 个 Blender 网格，经 Three.js 按材质分拆为 43 个网格；这些数字描述 GLB，不描述客户端生成的几何。`character_manifest.json` 分别记录导出资产和运行时用途。

`poster.png` 是 Blender 透明参考立绘，仅用于未展开三维预览时的占位和浏览器页面陪伴；不把它标称为客户端实时画面。

## 本机边界

`window.nuanbanModel.readBuiltin/applyBuiltin` 只接受固定的 `lumi` 或 `lili` 标识；磁盘读取限制为可信根目录内的固定普通文件，并检查字节数、SHA-256 和模型容器。应用操作只允许可信管理窗口，不接受任意 URL、目录或额外参数。

确认调用后复用原有本机模型存储与变更广播，切回现有模型桌宠路径；不会启动 Blender、第二套桌宠进程、屏幕／麦克风采集或资源上传。旧二维动作角色保留为显式[兼容入口](lili-desktop.md)，不是三维小鹿的动画。

## 验证

```powershell
pnpm typecheck
pnpm exec vitest run tests/platform/desktop-local-model.test.ts tests/platform/lumi-model.test.ts tests/platform/lili-model.test.ts tests/platform/management-companion-bridge.test.ts
pnpm --filter @nuanban/web build
$env:PLAYWRIGHT_CHANNEL = 'msedge'
pnpm exec playwright test tests/e2e/companion-pages.spec.ts tests/e2e/lumi-companion.spec.ts tests/e2e/pet-appearance.spec.ts --workers=2
node scripts/check-lili-model-electron.cjs
```

平台测试检查几何预算、有限顶点／法线、无动画、实例隔离、固定资源完整性和原生 IPC 拒绝路径。浏览器测试覆盖真实 WebGL 旋转、确认／重试、候选设置及露米回归。

Electron 脚本必须在 Web 和桌宠模型运行时构建后运行，复用隔离测试宿主，使用独立 `.cache/lili-model-electron-*/profile`；不会关闭或修改用户现有客户端。验证原生预览、从兼容二维切换、静态三维渲染、重启恢复及再次召唤，截图与结果写入同一缓存目录；捕获桌面计数必须为零。
