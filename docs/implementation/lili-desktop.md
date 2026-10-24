# 栗栗 × 微光指引：兼容二维桌宠接入

> 文档同步：2026-10-23。管理客户端的栗栗入口已改为[原版 Blender 三维模型](lili-client-model.md)。本文保留旧二维角色的启动、动作与资源说明；已有测试数字与生成日期仍只对应原批次，不因文档更新自动视为重新验收。

确认的目标仓库为 `C:\Users\33864\Desktop\nuanban`。栗栗作为微光指引现有透明桌宠窗口中的可选角色，不启动第二套 Electron 桌宠进程，不替换已有花环水獭、原画、本地模型或星云授权流程。

## 当前入口与二维兼容边界

“我的小伙伴” → “小鹿栗栗”现在加载参考图对应的原版 Blender GLB 并在本机渲染，不再由程序化几何替换造型；确认“请栗栗到桌面”后保存到本机模型存储并显示在现有透明桌宠窗口，正常重启后恢复。不再由这个入口调用旧二维 PNG 动画角色。

- 新三维栗栗是静态模型，不继承本文中的六动作、六表情；可旋转预览不等于具有角色动画。
- 浏览器可预览同一套三维几何；页面陪伴降级为透明参考立绘，不声称能更换系统桌宠。
- 外观设置的候选保存／撤回与“调用栗栗 3D 桌宠”仍是分开的操作。实际三维桌宠由本机模型存储恢复，候选设置不会自动调用。
- 旧二维角色仍可通过右键菜单“栗栗 · 兼容二维小鹿”、`--pet-lili` 或后文独立桥启用。它与三维桌宠不能同时作为当前显示角色。

旧二维兼容桥 `await window.nuanbanCompanion.showLili()` 仍存在，成功只返回 `{ id: 'lili', version: '1.0.0' }`。它只接受可信管理窗口主框架、拒绝额外参数，不允许 renderer 传入任意文件路径或桌宠命令；它不是新三维入口使用的 `window.nuanbanModel.applyBuiltin('lili')`。

页面陪伴不调用上述二维桥，不写入桌面角色设置，不启动独立窗口，也不打开屏幕、麦克风或云端资源请求。

旧二维预览 `apps/web/src/assets/lili.png` 从现有图集的首个待机帧与微笑表情合成，384×384 RGBA，保持脚底锚点。更换旧资源后，可执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/export-lili-preview.ps1` 重新导出；它不用于新三维预览，也不是 Blender 源工程的替代品。

新三维入口的真实 Windows 隔离验收使用 `node scripts/check-lili-model-electron.cjs`。旧 `scripts/test-lili-companion.mjs` 对应更改前的二维管理入口，不能作为新三维验收；二维独立宿主仍可使用后文的桌面测试。各类测试分别记录，不互相冒充。

## 启动与操作

双击仓库根目录的 `启动暖伴栗栗.cmd`，或在仓库根目录运行：

```powershell
pnpm desktop:lili
```

已安装的 Electron 位于 `apps/desktop/node_modules/electron/dist/electron.exe`；本仓库使用 hoisted 安装时位于仓库根 `node_modules/electron/dist/electron.exe`，`scripts/start-lili-desktop.ps1` 会自动选择存在的路径。此入口不下载依赖，不启动 Blender，不要求先构建管理端页面。若需要重新安装开发依赖，另行执行 `pnpm install --frozen-lockfile`。

- 点击栗栗会招手并展开微光指引原有功能面板；拖动后释放不会误开面板。
- 右键菜单的“角色”可切换栗栗与原有形象。栗栗不冒充 `cat`、`rabbit` 或 `dog`。
- “栗栗动作”“栗栗表情”“栗栗大小”可手动查看资源；支持暂停和减少动态。
- 隐藏、鼠标穿透仍可从菜单控制。隐藏或穿透后，从栗栗托盘图标恢复；托盘不可用时拒绝隐藏与穿透，返回 `tray_unavailable`。
- 桌宠展开时不置顶：打开其他软件或桌宠失焦时立即收起，空闲 5 秒也会自动收起为悬浮球；收起后的悬浮球是唯一保持最上层的窗口，避免被别的软件完全挡住。悬浮球可拖动，拖到屏幕边缘吸附成露出一半的贴边球，拖到中间保持完整可见；点击悬浮球或本地语音唤醒可立即取回。右键菜单的“取回桌宠 / 收起为悬浮球”可手动切换。
- 大小、位置、透明度、动画与置顶偏好写入当前微光指引用户数据目录的 `lili-pet-preferences.json`；`alwaysOnTop` 偏好在桌宠侧不再改变展开窗口的层级。鼠标穿透和隐藏不在下次启动自动恢复。
- 启动参数为 `--pet-lili`；环境变量 `NUANBAN_DESKTOP_PET=lili` 也可启用。`--pet-default` 显式选回原有形象。默认启动路径不强制选栗栗。
- 已经运行的旧进程不会热加载新的主进程或 preload 文件。保存当前工作并正常退出微光指引后再启动，不能靠第二次启动升级内存中的旧代码；新版进程支持单实例角色切换请求。

默认保留微光指引的内容保护策略。远程演示需要显示桌宠时，可使用 `scripts/start-lili-desktop.ps1 -CompatibleDisplay`；观察期间仍遵守原有保护规则。启动栗栗不自动开启观察、麦克风、AI 或星云服务。

## 四层边界

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 资源 | `apps/desktop/assets/lili/manifest.json`、`lili-resource.cjs` | 角色标识、版本、能力、PNG 图集和帧坐标校验 |
| 动画 | `apps/desktop/lili-animation.cjs` | 循环、一次性动作、优先级、排队、打断、表情与暂停 |
| 窗口与绘制 | `lili-host.cjs`、`lili-renderer.js`、`standalone-host.cjs` | 图集懒加载、Canvas 表情合成、窗口控制、托盘与偏好 |
| 微光指引适配 | `apps/desktop/lili-adapter.cjs` | 将本机微光指引状态或语义事件映射为角色表现 |

制作源工程独立保留于 `C:\Users\33864\Documents\ChatGPT\12\lili-desktop\blender\lili_studio_v1.0.blend`。微光指引运行目录只包含实际使用的图集、清单和托盘图标，没有复制设定表或 744 张逐帧 PNG 作为运行时依赖。

## 受信控制桥

固定桌宠页面通过 `window.nuanbanLili` 使用桥接。主进程同时校验窗口、实际主 frame 和固定本地页面，不向管理页、子 frame 或其他窗口开放。Renderer 继续禁用 Node、开启隔离和沙盒，CSP 不因栗栗放宽。

| 调用 | 已实现语义 |
| --- | --- |
| `bootstrap()` | 当前选择、资源清单、图集本地 URL、展示和动画快照 |
| `select(true / false)` | 在本机角色之间选择；启用栗栗前若有星云会话，先等待原服务确认停止 |
| `command({type:'resource.describe'})` | 查询 `lili`、`1.0.0`、尺寸、锚点、动作与表情能力 |
| `command({type:'state.get'})` | 当前动作片段、帧、表情、队列、展示偏好与失败状态 |
| `command({type:'action.play', action, options})` | 播放动作；`options` 可指定 `priority: 0..100`、`enqueue: boolean` |
| `command({type:'action.stop'})` | 清队列并返回待机；举牌和休息过渡等待安全结束 |
| `command({type:'expression.set', expression, intensity})` | 六种表情，强度 `0..1`；`expression:null` 恢复动作默认 |
| `command({type:'expression.reset'})` | 恢复动作默认表情 |
| `command({type:'animation.configure', options})` | `paused`、`reducedMotion` 布尔设置 |
| `command({type:'semantic.send', name, text})` | 语义事件；可带不超过 500 字的纯文本气泡 |
| `command({type:'ui.bubble', text})` | 显示纯文本，12 秒后消失；空字符串立即隐藏 |
| `command({type:'display.set', options})` | `x,y`（Windows DIP）、`size`（64..320）、`opacity`（0.2..1）、`alwaysOnTop`（桌宠侧不再改变展开窗口层级；悬浮球状态由宿主统一保持最上层）、`clickThrough`、`visible`、`facing:'front'` |
| `onState(listener)`、`onResource(listener)`、`onEvent(listener)` | 订阅状态、资源或动作/交互事件，返回取消订阅函数 |

所有命令检查允许字段；未选栗栗的控制请求返回 `lili_not_selected`。未知动作、表情、方向或非法数值不假报成功。首版只支持正面方向，左右转向返回 `unsupported_facing`，不镜像持灯侧。

事件包括 `action.started`、`action.completed`、`action.coalesced`、`state.changed`、`resource.changed`、`resource.loaded`、`resource.load_failed`、`display.changed`、`interaction.clicked` 和 `lifecycle.destroyed`。完成原因区分 `finished`、`interrupted`、`stopped`、`cancelled_before_start`。休息由多个片段组成，完成事件包含 `clip`，进入休息循环不代表整段休息已结束。

## 最小接入示例

可复用示例位于 `apps/desktop/examples/lili-control.js`，接收桥对象，不访问 AI 或云端：

```javascript
import { runLiliExample } from './examples/lili-control.js';

const control = await runLiliExample(window.nuanbanLili, event => {
  if (event.type === 'action.completed') console.log(event.action, event.reason);
});
control.unsubscribe();
```

调用者应在业务结束或页面销毁时取消订阅。示例实际执行角色选择、能力查询、招手、倾听及文字气泡；窗口自动化验收会导入并执行这个文件，检查动作完成事件，不把文档中的代码当作已联调证据。

主进程业务代码也可通过 `createStandaloneHost()` 返回值中的 `host.selectLili()` 与 `host.lili.command()` 控制同一个角色，不需要访问 Renderer DOM。其他独立进程若需控制桌宠，使用独立栗栗项目已有的本机 HTTP/SSE 适配层；本次嵌入接入没有再为微光指引新增网络监听端口。

## 动作与资源约定

资源标识 `lili`，版本 `1.0.0`，24 FPS，384×384 RGBA，脚底锚点 `[192,336]`。身体图集 30 张，1920×1920；表情图集 512×480。面部按每帧变换叠加，图集最多缓存四张并预取下一张。切换片段使用短暂淡化，脚底不因动作切换重新布局。64 像素版本保留角、围巾、灯的识别特征。

| 动作 | 程序片段 | 时长 | 循环 | 默认优先级 |
| --- | --- | --- | --- | --- |
| 待机 | `idle`，96 帧 | 4 秒 | 是 | 0 |
| 招手 | `wave`，72 帧 | 3 秒 | 否 | 20 |
| 提灯指路 | `guide`，72 帧 | 3 秒 | 否 | 30 |
| 举牌 | `sign`，192 帧 | 8 秒 | 否，不允许中途打断 | 40 |
| 成功反馈 | `success`，72 帧 | 3 秒 | 否 | 50 |
| 夜间休息 | `rest_enter` / `rest_loop` / `rest_exit`，72 / 96 / 72 帧 | 3 / 4 / 3 秒 | 仅中段循环 | 10 |

较高优先级可打断允许中断的动作；显式排队或较低优先级进入有界队列，按优先级、同级先后执行。相同当前或待播动作合并，队列上限四个。一次性动作默认返回待机；用户已选择休息时，临时动作在起身后执行，再返回休息。

灯由角色右前蹄持有；举牌完整保留放灯和提灯过程。减少动态时待机固定关键帧，招手与指路使用代表姿态但保留完成计时；涉及道具与坐下的安全交接仍完成。暂停时停止推进帧。PNG 失败后显示原有形象并发出错误事件，重新选择栗栗会重试资源，不留下空白角色。

## 语义映射

| 输入 | 表现 |
| --- | --- |
| `listening` | 认真倾听表情 |
| `success` | 恢复动作表情并播放成功反馈 |
| `reminder` | 平静担心表情和提灯动作 |
| `greeting` | 温和招手 |
| `rest` | 坐下、平滑暗灯、休息循环 |
| `clear` | 恢复默认表情并安全返回待机 |

微光指引真实状态 `analyzing` / `verifying` 映射倾听，`awaiting_action` 映射指路，`completed` 映射成功，`needs_help` 映射平静提醒。新助手文字可显示为气泡；隐私暂停期间不复制新业务文字。语音与本地唤醒只提供状态，不把录音或供应商调用搬入角色层。重复状态发布不重复入队。

## 验证与未完成边界

在 Windows 11 当前本机、Electron 44.7.2 验证。复现命令：

```powershell
pnpm typecheck
pnpm exec vitest run tests/platform/desktop-lili.test.ts tests/platform/desktop-standalone-host.test.ts tests/platform/desktop-pet-ui.test.ts tests/platform/desktop-xingyun-avatar.test.ts
pnpm desktop:lili:check
```

窗口验收使用独立 `.cache/lili-smoke-<时间戳>` 用户数据，不读取生产会话、不启用模型问答、不采集真实屏幕或麦克风。它实际验证首帧与透明通道、动作、表情、业务状态与最小示例、系统鼠标拖动、窗口属性、隐藏恢复、右键菜单、原有花环水獭回归及页面错误。报告和截图保存于同一目录。

尚未验证或首版未提供：Windows 10 实机、多显示器真实热插拔、穿透到其他实际业务软件的点击、用户手动操作系统托盘、线上模型/麦克风/星云会话、签名发布包、微光指引正式设置页的持久角色选择、任意第三方角色包加载和多朝向动画。这些不是本次“完成”的占位接口。资源和 Blender 的早期验证证据保留在独立项目，微光指引联调证据单独记录，不混用。
