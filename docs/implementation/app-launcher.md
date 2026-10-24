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

## 支持范围

### 一、本机开始菜单发现的软件（动态清单，2026-10-24 起）

首次打开该功能时会扫描两个开始菜单目录（`%APPDATA%\Microsoft\Windows\Start Menu\Programs` 与 `%ProgramData%\Microsoft\Windows\Start Menu\Programs`）里的 `.lnk`/`.url`/`.exe`，得到"本机可打开项"清单（本机实测 160 条，上限 400 条）。用户既可以一句话让模型在清单里选，也可以直接点"**从本机列表选择**"从清单里挑（**这条路径完全不调用模型**）。

- 清单项 id 形如 `sm:0123456789ab`（路径哈希），**页面与模型都拿不到真实路径**。
- 打开方式：`shell.openPath(开始菜单快捷方式)`，等价于你在开始菜单里点它；不接受任何其它路径。
- **危险/管理类条目在扫描阶段就被排除**：卸载/更新/修复、管理工具、命令提示符、PowerShell、cmd、注册表编辑器、系统配置、服务、磁盘管理、设备管理器、任务计划程序、组策略、终端/WSL、任务管理器、控制面板、设置等（中英文与所在文件夹都匹配）；System32/SysWOW64 管理工具目录同样排除。
- 清单项只支持打开主界面；不支持跳内部界面。首次打开仍需确认，确认过一次且开启"自动执行"后才免确认。

### 二、固定登记软件

| appId | 软件 | 可用目标 | 说明 |
| --- | --- | --- | --- |
| `calculator` | 计算器 | `default` | 低风险 |
| `notepad` | 记事本 | `default` | 低风险 |
| `explorer` | 文件资源管理器 | `default`、`folder` | `folder` 需本人用系统目录选择器选目录 |
| `browser` | 浏览器 | `default`、`url` | `url` 只允许 http/https |
| `vscode` | Visual Studio Code | `default`、`folder` | 未安装时明确"未找到可用启动方式" |
| `wechat` | 微信 | `default` | 只打开主界面 |

**明确不支持（会如实告知，不伪造成功）**：微信的 `settings`/`chat`/`moments` 等内部界面——没有稳定官方深链接时不跳转内部页面，只提示"该软件暂不支持直接打开这个界面，只能打开主界面"。

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
| `nuanban:pet-open-app:inventory` | `{}` | 本机可打开项清单（只回 `id` 与显示名，**不含真实路径**） |
| `nuanban:pet-open-app:pick` | `{ id }` | 本人从清单直接选择：**不调用模型**，直接生成计划，仍需确认 |
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

## 验证记录（2026-10-24 · 含动态清单）

- 单元与集成（8 个文件，**600 passed / 0 failed**）：`desktop-app-inventory`（扫描/去重/上限/id 不含路径/危险项排除/本地匹配/refresh）、`desktop-app-launcher-registry`（90 例）、`desktop-app-launcher`（150 例）、`desktop-app-launcher-intent`、`desktop-app-launcher-bridge`、`desktop-app-launcher-integration`（真实注册表 + 真实启动器 + 假 spawn/openPath）、`desktop-pet-ui`（225 例）、`desktop-standalone-host`。
- 现有功能回归（14 个文件，**691 passed / 0 failed**）：独立宿主、智能查询/AnySearch、录屏可见性、单帧与连续指引、观察策略、本地唤醒、语音会话、听写桥、provider。
- `tsc --noEmit`：**0 错误**。
- Electron 冒烟 `node scripts/check-app-launcher-electron.cjs`（真实 ipcMain + 真实 preload + 真实 pet.html + 假启动器）：卡片与页面可见、`window.require/process` 为 `undefined`、`window.nuanbanOpenApp` 恰好 9 个方法、固定项确认卡片、**确认前 0 次执行**、确认后 1 次 `calc.exe args:[]`、开启自动执行后免确认、**本机清单显示 2 项并可从列表直选**（`pick` 不走模型）、选中项经 `kind:'shortcut'` 打开 `Apifox.lnk`、非受信窗口调用被拒、屏幕/麦克风权限请求 0 次、无 pageerror。
- 本机真实只读演示（不启动任何软件）：开始菜单可打开项 **106 条**（Android Studio、Apifox、Blender、Docker Desktop、WPS Office、微信、Google Chrome、DataGrip…）；`打开 Apifox` / `打开 Blender` / `打开 WPS` 本地匹配 100/94/83 分并解析出对应 `.lnk`；`卸载`/`命令提示符`/`任务管理器`/`磁盘管理`/`服务` 等危险类在目录中命中 0 条。注意 `match()` 是**模糊搜索**（"卸载工具"会命中名称含"工具"的正常条目），真正的安全过滤在扫描期与 `resolve()`，两者都生效。
- 未接入项：Windows `App Paths` 注册表读取尚未接线（固定注册表默认只用固定绝对候选；`createAppLauncherRegistry({ appPaths })` 预留注入点）。动态清单只覆盖开始菜单条目，不含 Store/UWP 应用与"开始"菜单之外的绿色软件。