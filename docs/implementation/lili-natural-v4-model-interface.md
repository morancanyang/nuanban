# 栗栗自然精修 v4 模型接入接口

## 入口与边界

- 模型 ID：`lili-natural-v4`，版本 `4.0.0-preview.2`，候选版，不替换默认的 `lili` 原版资源。
- 产品入口：伙伴收藏 → 小鹿栗栗（`/#/pets/lili`）→ 模型版本 → 自然精修 v4。
- 选择版本、旋转预览不会保存或替换桌宠；电脑客户端必须再次确认才调用。
- 浏览器可预览真实 GLB，但“在本页显示”只显示所选版本的透明立绘，不是系统 3D 悬浮桌宠。
- 本版含 18 根骨骼和 5 段基础动作，眼睑使用独立形变目标，不压扁眼球伪造眨眼。手机性能与 Android 系统悬浮接入尚未验收。
- 实时毛发采用采样网格，三股针织线简化为针脚带面，过程材质适配为内嵌纹理；离线 Cycles 电影打光不随 GLB 输出。

## Web / Three.js

```ts
import { liliNaturalModel, loadLiliNaturalModel } from './three-d/builtin-models';
import { createModelView } from './three-d/viewer';

const controller = new AbortController();
const source = await loadLiliNaturalModel(controller.signal);
const view = await createModelView(container, source, { interactive: true });

view.playAnimation('wave');
view.dispose();
controller.abort();
```

`source` 遵守已有的 `ModelSource`：`{ format: 'glb', bytes: Uint8Array }`。宿主需要负责版本切换、过期请求处理、视图销毁以及错误展示；产品内的 `LiliCard` 已处理这些生命周期。

Web 从 Vite `BASE_URL` 下的 `models/lili-natural-v4/Lili_Natural_v4.glb` 读取；桌面优先走本机桥。两条路径均校验固定 SHA-256。加载失败会报错，不会悄悄把原版或立绘当作 v4 三维模型。

描述信息由 `liliNaturalModel` 提供，含模型地址、参考立绘、manifest 和 `capabilities`。立绘是离线参考图，不能用它判断实时 GLB 的最终画质。

## 动作绑定

| 动作 ID | 产品名称 | 行为 |
| --- | --- | --- |
| `idle` | 自然待机 | 6 秒循环，上胸轻微呼吸，耳朵、围巾与灯笼小幅跟随，脚底固定。 |
| `blink` | 轻轻眨眼 | 约 0.3 秒，上下眼睑独立闭合再睁开；待机约每 5 秒自动触发。 |
| `look` | 左右看看 | 约 4.2 秒，颈部与头部分层小幅转动，之后回到待机。 |
| `wave` | 轻轻招手 | 约 2.8 秒，只抬空闲手臂，持灯手不脱离灯笼；之后回到待机。 |
| `nod` | 点头回应 | 约 2.1 秒，小幅双点头，之后回到待机。 |

动作已经写入 GLB，Three.js 使用 `AnimationMixer` 播放真实蒙皮及形变轨道，不依赖图片序列或 CSS 移动。产品预览出现 5 个动作按钮；每次切换使用既有 0.18 秒过渡。系统“减少动态效果”时不会在加载模型后自动启动动作；用户仍可主动点选动作，单次动作结束后回到待机。

桌宠窗口复用 `nuanban:avatar-interaction`，单击角色会招手。可信本机渲染器也可调用下列同窗口事件；仅当前选中的 v4 模型响应白名单动作，不作为跨窗口或外部网络 API：

```ts
window.dispatchEvent(new CustomEvent('nuanban:model-action', { detail: { action: 'nod' } }));
```

该事件在桌宠窗口中调用；管理页应使用预览的 `view.playAnimation`，不会偷偷替换用户的桌宠。此次未将旧 2D 栗栗的 `nuanbanLili.command` 接口冒充为 3D 动作接口，未提供走路、跑跳、口型或完整表情捕捉。

## Electron 本机桥

```ts
const source = await window.nuanbanModel!.readBuiltin!('lili-natural-v4');
const current = await window.nuanbanModel!.applyBuiltin!('lili-natural-v4');
const restored = await window.nuanbanModel!.applyBuiltin!('lili');
```

上例三行分别表示只读预览、确认后应用、手动切回原版，不应在初始化时连续执行。只有受信任的管理窗口允许调用这些操作；桌宠窗口不能写入。接口不接收路径、URL 或额外参数，不上传模型。

应用前检查文件大小、固定哈希和容器结构，并在隔离的渲染器内执行既有真实解码验证；完成后保存到本地模型库并发布模型变更事件。文件缺失、篡改或验证失败不覆盖当前模型。重启后由原有本地模型恢复链路加载，不依赖 Blender。

旧版客户端不认识新 ID，需要构建或更新桌面客户端；可通过选择“原版”继续使用旧模型。此次没有自动调用、覆盖生产资源或生成安装包。

## 资产与再导出

- GLB：`apps/web/public/models/lili-natural-v4/Lili_Natural_v4.glb`。
- SHA-256：`331f66f6748bf78a390f60a2092c8ce884113698418087d0881cbe1f6feacd8f`。
- 文件大小：9,863,528 字节；98,762 个三角面；89 个解码子网格；18 根骨骼、5 段动画。
- 源模型 SHA-256：`02a69fd97777769544955586eec861396438444e2a17fc89d67ab702d5d3351b`。
- 源模型 194,719 根毛发采样为 20,811 根网格毛发；3,208 个针脚简化为实时带面。
- 不包含相机、灯光、背景板、地面或外置纹理依赖。GLB、manifest 和参考立绘随 Web 构建复制，也随现有桌面构建链路交付。
- 大体积 `.blend`、电影渲染母版及审阅 ZIP 保留在离线交付目录，不放入产品运行包或 Git。

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --factory-startup --background '<已审阅的 lili-natural-v4.blend>' --python scripts/export-lili-runtime.py -- '<输出目录>' --natural-v4
```

导出器校验已审阅源模型的哈希，通过 `scripts/characters/rig-lili-natural.py` 在内存中加入骨骼、蒙皮权重、眼睑形变和动作，不保存或改写源 `.blend`；默认不带 `--natural-v4` 时仍按原版静态导出。形变使用完整访问器，以遵守原有容器验证器的稀疏数据限制。更新资产后必须同步固定哈希、字节数与测试断言，不能只修改 manifest 绕过校验。

## 验证

```powershell
pnpm exec vitest run tests/platform/lili-natural-model.test.ts tests/platform/lili-model.test.ts tests/platform/desktop-local-model.test.ts
pnpm typecheck
pnpm --filter @nuanban/web build
pnpm exec playwright test tests/e2e/lili-natural-model.spec.ts
node scripts/check-lili-model-electron.cjs --natural-v4
```

单元验证覆盖独立资源身份、真实几何预算、骨骼与蒙皮权重、脚底固定、独立空手动作、真实眼睑形变、单次动作返回待机，以及浏览器和桌面读取、权限白名单、篡改拒绝、失败保留和取消加载。Playwright 覆盖真实 GLB 首帧、5 段动作切换、版本切换、浏览器立绘边界与损坏资源回退。Electron 验收使用专用缓存配置，禁止真实屏幕采集，检查预览与桌宠动作、单击招手、确认应用、重启恢复、再次召唤和切回原版；结果与截图仅保存在 `.cache`，不提交。
