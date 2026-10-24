# 桌宠 · 智能打开软件

> 文档同步：2026-10-24。产品显示名称为**微光指引**；[当前功能与平台边界](product-current-state.md)统一说明现行入口、已实现范围和待验证能力。

功能小屋新增“**智能打开软件**”：用户说“打开计算器”“打开浏览器看新闻”“打开 VS Code 的项目”，由已配置模型把口语目标解析成严格 JSON，主进程按**固定软件注册表**校验后打开，高风险目标一律拒绝，默认每次都要本人确认。

## 用户流程

1. 功能小屋 → 点“智能打开软件”卡片（或桌宠右键“智能打开软件…”）。
2. 输入目标（或先勾选“本次发送确认”）→ 点发送。
3. 模型只返回 JSON：`open_app` / `ask_clarification` / `unsupported` / `cancel`。
4. 主进程校验软件、目标界面、参数与新版本；默认显示确认卡片
   `即将打开：<软件>` / `目标界面：<界面>` / `是否继续？`
5. 点“打开”后主进程启动；点“取消”或“停止执行”不启动。
6. 最近记录只显示时间、软件、界面与结果。

## 支持范围（第一阶段）

| appId | 软件 | 可用目标 | 说明 |
| --- | --- | --- | --- |
| `calculator` | 计算器 | `default` | 低风险 |
| `notepad` | 记事本 | `default` | 低风险 |
| `explorer` | 文件资源管理器 | `default`、`folder` | `folder` 需本人用系统目录选择器选目录 |
| `browser` | 浏览器 | `default`、`url` | `url` 只允许 http/https |
| `vscode` | Visual Studio Code | `default`、`folder` | 未安装时明确“未找到可用启动方式” |
| `wechat` | 微信 | `default` | 只打开主界面 |

**明确不支持（会如实告知，不伪造成功）**：微信的 `settings`/`chat`/`moments` 等内部界面——没有稳定官方深链接时不跳转内部页面，只提示“该软件暂不支持直接打开这个界面，只能打开主界面”。QQ、钉钉等同理，未登记即拒绝。

注册表**不包含**任何高风险目标：卸载/删除、格式化、注册表编辑器、任务管理器、系统设置、管理员工具、命令提示符、PowerShell 等一律 `APP_UNKNOWN`/`TARGET_UNKNOWN`。

## 安全边界

- **模型不能直接执行命令**：模型输出只允许 JSON；出现 `powershell`、`cmd /c`、`start`、`node`、`python`、`.exe/.ps1/.bat/.cmd/.vbs`、盘符路径、UNC、反引号、`$( )`、`&&`、`||`、重定向等特征即 `UNSAFE_MODEL_OUTPUT`。
- **Renderer 不能起进程**：`pet-preload.cjs` 只暴露 `window.nuanbanOpenApp` 的 7 个方法；页面没有 `require`/`process`/`ipcRenderer`，所有启动都经主进程受信 IPC。
- **IPC 校验来源**：8 个通道（`status`/`parse`/`execute`/`pick-folder`/`cancel`/`history`/`auto`/`show`）全部要求受信 sender，payload 只接受严格白名单字段（多余字段直接抛错）。
- **不接受任意路径/参数/URL**：可执行文件只能来自注册表的固定绝对候选路径；参数只能是固定字符串数组或经校验的 http/https 网址；目录必须由本人在系统对话框中选择（模型给的路径一律 `PARAMETERS_FORBIDDEN`）。
- **不引入采集**：本功能不请求屏幕、麦克风、摄像头或 OCR，不新增敏感文字检测；冒烟测试断言权限请求数为 0。
- **记录最小化**：只写 `{ at, appId, target, success, errorCode }` 到 `userData/nuanban-app-launcher.json`，不保存问题原文、路径、屏幕内容或聊天隐私。
- 沙箱与上下文隔离保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`。

## 执行与自动执行

- 启动一律 `spawn(绝对路径, 参数数组, { shell: false, detached: true, stdio: 'ignore', windowsHide: true })`；网址走 `shell.openExternal`（仅 http/https）。
- **确认模式（默认）**：每次打开前显示确认卡片。
- **自动执行（默认关闭，用户主动开启）**：只对 `risk: 'low'` 且**本会话已确认过一次**的软件+目标免确认；首次使用、路径变化、目标变化、高风险目标（如打开网页、打开目录）仍需确认；可随时关闭；关闭后立即恢复逐次确认。
- 计划（planId）单次有效、60 秒过期；点“停止执行”会作废所有待确认计划并中止在途解析。
- 成功语义诚实：只确认“启动请求已发送”，**不声称软件内部页面已加载**。失败映射明确错误码：`EXECUTABLE_MISSING`（未安装/找不到启动方式）、`LAUNCH_FAILED`、`TARGET_UNSUPPORTED`、`FOLDER_NOT_ALLOWED`、`URL_PROTOCOL_BLOCKED`、`AUTO_EXECUTE_DENIED`、`CANCELLED`、`MODEL_UNAVAILABLE`、`MODEL_INVALID_JSON`、`UNSAFE_MODEL_OUTPUT` 等。

## 主进程接口（IPC）

| 通道 | 入参 | 说明 |
| --- | --- | --- |
| `nuanban:pet-open-app:status` | `{}` | 模型可用性、自动执行状态、软件目录 |
| `nuanban:pet-open-app:parse` | `{ goal, consent }` | 解析目标，返回计划/追问/不支持/失败 |
| `nuanban:pet-open-app:execute` | `{ planId, approved }` | 执行已验证计划（`approved:false` 表示未确认） |
| `nuanban:pet-open-app:pick-folder` | `{}` | 主进程目录选择器，结果进入会话白名单 |
| `nuanban:pet-open-app:cancel` | `{}` | 停止执行并作废计划 |
| `nuanban:pet-open-app:history` | `{}` | 最近记录（最多 20 条） |
| `nuanban:pet-open-app:auto` | `{ enabled }` | 开关自动执行 |
| `nuanban:pet-open-app:show` | `{}` | 打开该功能页 |

## 验证方式

~~~powershell
pnpm exec vitest run tests/platform/desktop-app-launcher-registry.test.ts tests/platform/desktop-app-launcher.test.ts tests/platform/desktop-app-launcher-intent.test.ts tests/platform/desktop-app-launcher-bridge.test.ts tests/platform/desktop-pet-ui.test.ts
node scripts/check-app-launcher-electron.cjs   # Electron 冒烟：真实 IPC + 真实页面 + 假启动器
~~~

单元测试全部使用假 `spawn`/假启动器/合成路径，**不会打开任何真实软件**；Electron 冒烟同样只记录启动请求。覆盖：合法 JSON 解析、Shell 命令拒绝、未登记软件/界面拒绝、任意路径与危险协议拒绝、Renderer 无进程能力、非受信 IPC 拒绝、默认确认模式不自动执行、关闭自动执行后不再自动启动、启动失败错误展示、现有功能不受影响。

## 已实现 / 未验证边界

- 已实现：注册表、启动器、模型意图解析、受信 IPC、确认与自动执行策略、最近记录、功能小屋页面与卡片、单元测试与 Electron 冒烟。
- **未验证**：未在真实用户桌面上逐一验证各软件是否安装/版本差异、未验证打开后的软件内部状态、未做真人可用性验收；`deviceVerified=false`。软件未安装时只会如实报告“未找到可用启动方式”，不会伪造成功。

## 验证记录（2026-10-24）

- 单元与集成：`desktop-app-launcher-registry` 84 例、`desktop-app-launcher` 105 例、`desktop-app-launcher-intent` 9 例、`desktop-app-launcher-bridge` 14 例、`desktop-app-launcher-integration` 8 例（真实注册表 + 真实启动器 + 假 spawn）、`desktop-pet-ui` 216 例；合计 **517 passed / 0 failed**（7 个文件）。`tsc --noEmit` 0 错误。
- 现有功能回归：宠物 UI、独立宿主、智能查询/AnySearch、录屏可见性、单帧指引、连续指引、观察策略、本地唤醒、语音会话、听写桥、provider 共 **892 passed / 0 failed**（15 个文件）。
- Electron 冒烟 `node scripts/check-app-launcher-electron.cjs`（真实 ipcMain + 真实 preload + 真实 pet.html + 假启动器）：卡片与页面可见、`window.require/process` 为 `undefined`、`window.nuanbanOpenApp` 恰好 7 个方法、确认卡片文案 `即将打开：计算器 / 目标界面：主界面 / 是否继续？`、**确认前 0 次执行**、确认后 1 次 `calc.exe args:[]`、开启自动执行后第二次免确认直接执行、非受信窗口调用被拒、屏幕/麦克风权限请求 0 次、页面无 pageerror。全程未启动任何真实软件（假 launcher 记录到 `C:\Windows\System32\calc.exe`，仅表示候选路径解析正确）。
- 本机实况（仅记录，不代表其他机器）：`calc.exe`/`notepad.exe`/`explorer.exe`/Edge 候选均命中；微信 4.x 可执行文件为 `Weixin.exe`（已在候选中）；**本机未安装 VS Code**，因此会返回 `EXECUTABLE_MISSING` 并提示“未找到可用启动方式”。真实 fs 冒烟还发现并修复了一个真实 bug：`fs.statSync().isDirectory` 是方法而非布尔字段，原先会导致目录永远判为 `FOLDER_MISSING`，已加回归用例。
- 未接入项：Windows `App Paths` 注册表读取尚未接线（注册表默认只用固定绝对候选；`createAppLauncherRegistry({ appPaths })` 预留了注入点，后续可按需接入，候选仍会做绝对路径/`.exe`/无 Shell 字符/存在性过滤）。