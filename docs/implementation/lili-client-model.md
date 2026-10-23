# 栗栗：原版 Blender 模型的客户端显示

更新日期：2026-10-23（Asia/Shanghai）。v2 修复了客户端小鹿与参考图造型不一致的问题：不再用另一套程序化几何覆盖原模型，而是显示生成参考图的 Blender 工程导出的角色。

## 使用入口

- “我的小伙伴” → “小鹿栗栗” → “预览小鹿 3D 模型”：加载随包 GLB，可拖动旋转、滚轮缩放；预览不替换桌宠。
- Windows 桌面客户端点击“请栗栗到桌面”并确认后，校验、保存小鹿资源，在现有透明桌宠窗口显示；正常重启后恢复，可再次召唤。
- “选择内置伙伴”中的“调用栗栗 3D 桌宠”使用相同模型；保存／撤回候选外观不自动调用桌宠。
- 浏览器可以旋转预览；页面陪伴仍使用明确标注的透明参考立绘，不替换系统悬浮桌宠。
- 只有小鹿本体，没有背景、地面、模型自带灯光、骨骼、动作或表情动画。相机和不显示在背景中的柔光由 viewer 提供。

## 造型来源与修复

原版工程为 `microglow_deer_independent.blend`，场景为 `MICROGLOW_DEER_STANDALONE`。角色保留原来的头身比例、耳廓、圆润分叉鹿角、眼睛位置、手臂与身体的连续轮廓、口鼻、奶油腹部及围巾垂落位置。`character_manifest.json` 记录源工程 SHA-256 和每个原始部件，不把导出资产描述为重新生成的角色。

`scripts/export-lili-runtime.py` 从角色及围巾集合导出，限制各部件的拓扑预算，保留全部 2,112 个原始针织针脚，将原始 184,587 根毛发抽样成 21,855 根实时三角纤维，并内嵌琥珀虹膜烘焙、短绒／纱线法线及绒面颜色纹理。渐隐腮红保留顶点 Alpha。未导出摄影机、灯光、背景、外部 URL 或文件依赖。

导出方法（源工程不随仓库分发）：

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' -b '<源工程绝对路径>\microglow_deer_independent.blend' --python-exit-code 1 --python scripts/export-lili-runtime.py -- apps/web/public/models/lili
```

导出后必须同步前端资源身份、原生固定资源清单及测试中的字节数和摘要，不能绕过完整性检查。

## 随包资产

`apps/web/public/models/lili/Lili_Independent_Deer.glb` 既是持久化载荷，也是实际显示几何，不再仅作为身份占位。

- 版本：2.0.0；7,171,212 字节。
- 97,992 个三角形，59 个 glTF 网格，按材质解码为 63 个 Three.js 网格。
- 6 张内嵌图片，11 个纹理配置；无动画、骨骼或外部资源。
- SHA-256：`8b5b3adce1d8995a0c754aed5d89360ec56fb35f7cf6d570052594de508fb35c`。

详情页、模型管理预览和透明桌宠均读取 GLB。此前保存的 v1 内置小鹿摘要被明确识别，显示时读取 v2 原版资源，不静默修改本机保存的模型或覆盖用户导入的其他模型；再次确认召唤才保存新版本。`poster.png` 保持为原始离线透明参考图，仅作预览占位与浏览器页面陪伴。

viewer 对带 `lili-original-v2` 标识的角色使用无背景环境反射、主光与轮廓光，并按模型实际长宽适配取景。关闭预览时取消读取，释放控件、几何、材质、纹理、环境渲染目标及 WebGL 上下文。其他角色沿用自己的显示链，不改变其灯光。

## 画质与本机边界

原版造型已恢复，但这不是离线电影渲染的无损复制。原工程的全部毛发、程序化着色与摄影棚照明无法原样带入轻量实时模型；实时短绒密度、光泽、透明角膜及明暗仍会与参考图不同。页面如实标注这个边界，不以离线 PNG 冒充三维画面。

`window.nuanbanModel.readBuiltin/applyBuiltin` 只接受固定的 `lumi` 或 `lili` 标识；磁盘读取限制为可信根目录的固定普通文件，并验证字节数、SHA-256、模型容器及解码预算。应用操作只允许可信管理窗口，不接受任意 URL、目录或额外参数。

运行与确认召唤均不启动 Blender、第二套桌宠进程、资源上传或屏幕／麦克风采集。旧二维动作角色保留为显式[兼容入口](lili-desktop.md)，不是这个静态模型的动作。

## 验证

```powershell
pnpm typecheck
pnpm exec vitest run tests/platform/desktop-local-model.test.ts tests/platform/desktop-model-validator.test.ts tests/platform/desktop-lili.test.ts tests/platform/desktop-pet-ui.test.ts tests/platform/desktop-pet-workspace.test.ts tests/platform/desktop-pet-tool-window.test.ts tests/platform/lumi-model.test.ts tests/platform/lili-model.test.ts tests/platform/management-companion-bridge.test.ts
pnpm check:boundaries
pnpm --filter @nuanban/web build
$env:PLAYWRIGHT_CHANNEL = 'msedge'
pnpm exec playwright test tests/e2e/companion-pages.spec.ts tests/e2e/lumi-companion.spec.ts tests/e2e/pet-appearance.spec.ts --workers=2
node scripts/check-lili-model-electron.cjs
```

平台测试检查资源完整性、来源、GLB 真实几何解码、头部比例、针脚／渐隐腮红、有限顶点、无动画、实例隔离、同源读取、中止及原生权限。Node 几何测试不解码 PNG；带纹理的完整实际加载由浏览器 WebGL 和原生 Electron 验证，不将几何检查冒充纹理解码检查。

Electron 脚本使用独立 `.cache/lili-model-electron-*/profile`，不关闭或修改用户现有客户端。验证原生预览、从旧二维切换、静态三维显示、重启恢复及再次召唤；截图与结果保存到同一缓存目录，屏幕采集调用必须为零。
