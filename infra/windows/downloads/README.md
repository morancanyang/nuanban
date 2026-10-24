# 微光指引 · Windows 桌面客户端下载产物（未签名开发包）

> **2026-10-24 r27：** 功能小屋新增“**智能打开软件**”（`3a24f55`）。用户说“打开计算器/浏览器看新闻/打开 VS Code 的项目”，由已配置模型解析成**严格 JSON**，主进程按固定注册表校验后打开：首批 `calculator`、`notepad`、`explorer`（可打开本人选择的目录）、`browser`（仅 http/https）、`vscode`（本机未安装则如实报 EXECUTABLE_MISSING）、`wechat`（只打开主界面；`settings`/`chat`/`moments` 明确不支持，不伪造跳转）。默认**每次都要本人确认**（确认卡片“即将打开：… / 目标界面：… / 是否继续？”）；自动执行默认关闭，仅对低风险且本会话确认过一次的目标免确认，可随时关闭。模型输出出现 `powershell`/`cmd /c`/`start`/`node`/`python`/`.exe`/`.ps1`/盘符路径等即拒绝；参数只接受白名单键，目录必须由本人用系统对话框选择；启动一律固定绝对 exe + 字符串数组、`shell:false`，网址只走 `shell.openExternal`。Renderer 无 `require`/`process`，所有启动经受信 IPC（8 个通道、严格字段白名单）；最近记录只存时间/appId/target/结果；本功能不请求屏幕、麦克风、摄像头或 OCR。验证：相关套件 **517 passed / 0 failed**（7 个文件，含真实注册表+真实启动器的集成测试），现有功能回归 **892 passed / 0 failed**（15 个文件），`tsc --noEmit` 0；Electron 冒烟（真实 ipcMain + preload + 页面、假启动器，不打开真实软件）确认：确认前 0 次执行、确认后 1 次 `calc.exe args:[]`、开启自动执行后免确认、非受信窗口被拒、屏幕/麦克风请求 0 次。构建来自独立干净工作树（HEAD `3a24f55`）。旧 r26 包已从下载目录移除。


> **2026-10-24 r24：** 桌宠“智能查询”改回 **AnySearch 实时检索**（`d22fa08`）。2026-10-18 起该入口只复用本机模型、不联网，因而回答不了实时问题。现在新增 `pet-search-client.cjs` 组合供应：**配置密钥就调 `POST https://api.anysearch.com/v1/search`**（Bearer），展示来源标题/摘要与可打开原文的 HTTPS 链接，页面标注“AnySearch 实时检索”；**没有密钥**才回退本机模型并标注“未联网核验”；**AnySearch 已配置但失败时直接报错，不静默改走模型冒充检索结果**。密钥只存本机 DPAPI 加密文件（`%APPDATA%\@nuanban\desktop\nuanban-anysearch-key.bin`，69 字节密文）或环境变量，**不进仓库、不进安装包**，用 `scripts/set-anysearch-key.ps1` 写入；新增 `scripts/check-anysearch-live.cjs` 做真实调用核对，并有防泄漏测试扫描源码/脚本/测试/文档。构建来自独立干净工作树（HEAD `d22fa08`，先变基到最新远端并保留对方提交）：`tsc --noEmit` 0，相关套件 415 passed。真实调用记录：“今天北京天气”7 条、“上海今天天气怎么样”7 条、“人民币 美元 汇率”9 条结果，全部 HTTPS、来源各异，模型调用 0 次。Android 两包未重出（另一会话正在改 Android/Web，当前 Web 构建与其已发布 APK 已不一致），下载页保留此前逐文件核验过的 APK 行；旧 r23 包与页面行已移除。

> **2026-10-24 r29：** 修复"共享整屏时 WeGame 等软件图标无法被指引（没有光标）"。根因：`apps/desktop/observation/windows-shell-controls.ps1` 枚举了桌面/任务栏元素，但**只给 6 项写死白名单打标签**（桌面：微信/此电脑/我的电脑/回收站/控制面板；任务栏：微信/开始/搜索），其余名称直接跳过，因此 WeGame 之类图标**根本不会成为候选**。现在改为**每个合格 shell 元素都用本机 UIA 名称上报**：名称清洗（Trim、去控制字符、折叠空白、≤64 截断、桌面去 `.lnk`、空名/纯符号跳过、同名同位置去重），白名单仅保留用于友好名映射；**既有过滤一条未放宽**（explorer 拥有的 shell 窗口、DPI、IsOffscreen/IsEnabled、必须落在观察范围内、FromPoint 命中、窗口 ≤128 / 元素 ≤1024 / 控件 ≤128）。回包在 `windows-shell-controls.cjs` 按同一规则再校验（NFKC、≤64 截断、>256 硬拒绝），`observation-policy.cjs` 由白名单改为结构校验并**让 shell 名称同样过敏感文本门控**（命中隐私词的候选不上报、不成箭头目标、也不因此停止已授权共享），`policyVersion` v10→v11。**如实说明**：UIA 名为空的图标仍走既有 `visual-controls` 的"未标注图标"图形候选，**OCR 就近匹配兜底未实现**；真机验收 `deviceVerified=false`。r28 按上一版约定**继续保留**（页面同时列出 r28 与 r29），便于旧链接不 404。

> **产物核验（r29）**：`NuanbanDemo-0.1.0-win32-x64-portable-20261024-r29.zip` 215,383,209 字节（205.41 MiB），SHA256 `307f197b748434ad2676600aba296b7308ec3996cd76f53eb2c18d11025638f6`；主机按字节核验一致，公开 HEAD 200。包内 13 项核对全过：shell helper 随包且**保持纯 ASCII**、泛化标签逻辑在位、无"白名单否则跳过"的旧分支、友好名映射保留、客户端 `isBoundedShellControlLabel` 校验在位、`policyVersion v11` 且 shell 名称过 `isRestrictedText`、星云按模式选类与对话模式 `enable_aec: false`、品牌文案仍是"微光指引"、权限闸门与云听写录音组件仍在。

> **验证范围与诚实边界（r29）**：`pnpm typecheck` 0；`desktop-shell-controls` 10 + `desktop-observation-source` 232 + `desktop-observation-policy` 122 = **364 passed / 0 failed**；观测相关 9 文件 673 项中 663 passed，10 项失败**在 HEAD 上就存在**（`desktop-shell-target-stability`：旧断言要求"单帧丢目标立刻清箭头"，而实现是有意的"连续两帧丢失才判失效"，本轮未擅自改断言）。PowerShell `ParseFile` 0 错误、脚本 0 个非 ASCII 字节，清洗/截断/符号拒绝/友好名映射已在真实 PS 5.1 逐条验证。**未验证**：真机整屏共享下的验收——需要用户点"重新识别当前画面"后确认桌面第二列顶部的 WeGame 出现箭头且位置吻合；另外上游新增的 `relaxedSafety`（最大权限）与"名称级敏感过滤"的一致性尚未接线，默认与遮盖模式为 fail-closed。


> **2026-10-24 r28：** 修复"启用花环水獭（仅形象）与实时对话都失败"。现场反馈两种模式都失败后，我们用**真实 Electron 隐藏窗口 + 真实 pet.html/preload/CSP + 真实凭证与会话**做了取证装置（真实会话 4 次，全部 DELETE），确证并修掉两个缺陷：
> 1. **仅形象被实时通道连坐**（这是"仅形象也坏"的成因）：修复前两种模式都实例化 `XingyunAvatarAgent`，仅形象也会额外建立 `wss://e2emp.xingyun3d.com` E2E 连接，任一 socket/agent 异常直接 `fail('load_failed')`。现在**按模式选类**：`render` → 基类 `@xmov/avatar`（只建 `ttsa-gateway-lite` 一条 WS，不依赖 E2E、不调用 ASR/ask、`setVolume(0)`）；`conversation` → `@xmov/avatar/agent`。
> 2. **对话模式无法加载 AudioWorklet**：真实页面报 `Loading the script 'blob:file:///<id>' violates … "script-src 'self'"`（file:// 不透明源），因对话模式启用 AEC 需要 worklet。现在对话会话体改为 `speech_frontend: { enabled: true, enable_aec: false }`（平台原样接受，`error_code 0`，未放宽 CSP）。**代价**：暂不启用回声消除，桌宠自己的声音可能被麦克风再次拾取；恢复 AEC 需要把桌宠窗口换成自定义协议/本地 http 源，已登记为后续项。
> 附带修好：修复前仅形象的 `DELETE` 会被平台拒（`error_code 1 无效的session`）导致界面误报"清理未确认"，现在同流程 `error_code 0`。
> **未能复现**：现场那台机器上 `load_failed` 的真实触发条件（网络/代理/杀软/显卡差异）在装置里没有复现出来——所以本版同时把失败做成**可诊断**：失败阶段（会话/资源/实时通道/渲染/权限/超时）与 SDK 原始 code/message 脱敏后上屏，并写入 `%APPDATA%\@nuanban\desktop\avatar-trace.log`（含 CSP 违规与 render-process-gone，256 KiB 上限、不含密钥/token）。若仍失败，把那份日志发我即可定位。旧 r27 包已撤下。

> **产物核验（r28）**：`NuanbanDemo-0.1.0-win32-x64-portable-20261024-r28.zip` 215,374,854 字节（205.4 MiB），SHA256 `505b676411a56fb31314a36b07f20fc69f093aa34cb0f8134f4dcc6ca5ad2810`；主机按字节核验一致，公开 HEAD 200。包内 15 项核对全过：源码 render 用 `import('@xmov/avatar')`、conversation 用 `import('@xmov/avatar/agent')`、会话体含 `enable_aec: false` 且 render 体不变、`createAvatarTraceLog`/`sanitizeReason` 随包、preload 暴露唯一 `nuanban:avatar:trace`、宿主写 `avatar-trace.log` 并捕获 `console-message`、失败 detail 贯通、权限闸门随包、`main.cjs` 无 `callback(true)`、CSP 未放宽、云听写录音组件仍在、品牌文案仍是"微光指引"。构建产物 `avatar-runtime/xingyun-renderer.js` 1,209,900 字节。

> **验证范围（r28）**：`pnpm typecheck` 0；`desktop-xingyun-*` **60 passed**；合并后 `desktop-standalone-host` 81 + `desktop-pet-ui` 220 = **361 passed**；合成 SDK 的 `desktop-pet-avatar.spec.ts`（msedge）**28 passed**（含 render=基类 / conversation=Agent / 失败原因上屏断言）。装置实测：修复后仅形象 `ready` 且只建一条 WS、`DELETE error_code 0`；修复后对话 `ready` + 麦克风权限闸门 `armed` + ASR 启动 + 无 worklet 报错 + `DELETE error_code 0`。**未验证**：现场故障机本身、`avatar-trace.log` 生产接线的真实落盘、真机开麦与无 AEC 的音质/回声、口型同步、计费口径。


> **2026-10-24 r27：** 修复"星云实时对话无法点击"（现场反馈）。原因：`avatar-conversation-start` 的禁用条件包含"已有会话或本地实例"，因此**只要仅形象会话在运行（用户已启用花环水獭），对话入口就永久不可点，界面也不说明原因、没有切换路径**。现在：仅形象会话就绪时按钮保持可用并把文案改为 **"切换到实时对话"**，同区说明改为"会先停止这个仅形象会话并确认远端关闭，再建立实时对话会话"；`start('conversation')` 在**本人于原生对话框确认之后**先 `stop()` 结束仅形象会话，再建立对话会话（取消确认则完全不动现有形象）。r26→r27 条目 87→87、新增 0、删除 0，**唯一变化是 `resources/app.asar`（77,011,923 → 77,116,099 字节，+104,176 = 重建后的 `avatar-runtime/xingyun-renderer.js`）**。旧 r26 包已撤下。

> **产物核验（r27）**：`NuanbanDemo-0.1.0-win32-x64-portable-20261024-r27.zip` 215,370,602 字节（205.39 MiB），SHA256 `1e31114902e4ed2849c9a35c318b134e5548385e65669a16d5640f224771beff`；主机按字节核验一致，公开 HEAD 200。包内核对：构建产物含"切换到实时对话"与切换说明文案、源码含 `switchingFromRender`/`await stop()`、render 会话体（`auto_send_asr_to_llm:false`）与对话会话体（`true`）各自完整、权限闸门随包、`main.cjs` 无 `callback(true)`、品牌文案仍是"微光指引"、解包目录含录音助手与 `NAudio.dll`。

> **验证范围（r27）**：`pnpm typecheck` 0；星云与桌宠单测 **263 passed**；`desktop-pet-avatar.spec.ts`（合成 SDK，msedge）**28 passed**（14 用例 × 2 视口），其中新增用例"仅形象会话运行中也能进入实时对话"覆盖：按钮可用与文案、点击前不改变形象、确认后先停形象（`stops=1 destroyed=1`）再建对话会话（`modes=['render','conversation']`、`asrStarts=1`、`volume=1`）、停止后 `asr=idle`。**未验证**：仍无真机开麦与真实星云会话验收（口型/延迟/计费口径未实测）。



> **2026-10-24 r21：** 合并上游前端仓库 [101274017/mobiwusi](https://github.com/101274017/mobiwusi) 的界面更新并重出 Windows 客户端。

> **2026-10-24 r26：** 修掉另一会话 `3f0946c` 留在 `apps/desktop/main.cjs` 两处配置对话框里的旧产品名"暖伴"（品牌名回归，`b1ffc61`）：`请从仓库源码目录启动暖伴…` → `…启动微光指引…`，`现在重启暖伴以启用吗？` → `现在重启微光指引以启用吗？`。这是相对 r25 的**唯一代码变化**：r25→r26 条目 87→87、新增 0、删除 0、**变化条目只有 `resources/app.asar`（77,011,911 → 77,011,923 字节，+12 = 两处各 +6）**。功能与 r25 完全一致（星云原生实时对话、云端听写修复、AnySearch 检索、栗栗/露米等均沿用 r25）。旧 r25 包已从下载目录撤下。

> **产物核验（r26）**：`NuanbanDemo-0.1.0-win32-x64-portable-20261024-r26.zip` 215,369,016 字节（205.392 MiB），SHA256 `c8b096523f9f270f9d4be1ed91af39b1411d98757cd04339246f94ca762197cf`；主机按字节核验一致，公开 HEAD 200。包内 12 项逐项核对全部通过：`main.cjs` 已无"暖伴"且含"微光指引"、`xingyun-avatar.cjs` 两模式与对话字段、`xingyun-permission-guard.cjs` 只放行 `media`、`main.cjs` 无任何 `callback(true)` 字面量、桌宠页面含"实时对话"入口、`avatar-runtime/xingyun-renderer.js` 含 Agent/`startASR`/`stopASR`、解包目录含 `voice/windows-cloud-dictation.ps1` 与 `NAudio.dll`、`voice/cloud-recorder.cjs` 含 `tempDir` 修复。

> **验证范围（r26）**：`pnpm typecheck` 0；`tests/platform/product-branding.test.ts` **188/188 通过**（修复前为红）；发布版（b1ffc61 系）全量非 acceptance 为 **3041 passed / 14 failed**，其中品牌 1 项已由本版修复，其余 13 项为既有红测（`android-3d-assets`、`android-3d-render-policy`、`desktop-shell-target-stability`，均为其他会话在途工作）。**未验证**：仍没有真机开麦与真实星云会话验收，实时链路/口型/延迟/计费口径未实测（同 r25）。


> **2026-10-24 r25：** 接入**星云原生实时对话**（所有者选择"模式 A"：星云 ASR + 星云 Brain + 星云 TTS + 口型），默认仍是"仅形象渲染"，对话必须由本人在原生窗口逐次开启。平台侧由 lead 先实测确认：对话模式会话 POST（`features:{auto_send_asr_to_llm:true, speech_frontend:{enabled:true, enable_aec:true}}`）返回 `error_code 0`、`resource_pack` 与 **`e2e_resp.{ws_url:'wss://e2emp.xingyun3d.com/...', e2e_token, features}`**，探测会话随后关闭（重复 DELETE 返回"无效的 session"，未留下计费会话）。实现要点：`begin(consent, mode)` 只接受 `render|conversation`；对话模式的会话体由**主进程白名单重建**（页面传入的 features/ids/config 一律丢弃，`raw_audio` 仍须布尔）；新增 `xingyun-permission-guard.cjs`——默认会话仍全拒，只有"本人已开启对话的那一次会话/那个桌宠窗口/那个页面/仅 media 音频"放行，停止、窗口关闭、销毁或退出立即撤销且对迟到撤销免疫；渲染端对话模式才实例化 `XingyunAvatarAgent`（`setVolume(1)`、`startASR/stopASR/interrupt`、回调按代次丢弃、销毁先 `stopASR` 再 `destroy`），render 模式与旧版一致（`setVolume(0)`、不调用 ASR/ask）；桌宠页面新增"实时对话"入口与原生确认框（写明音频上传、由星云模型回答、按其平台计费、停止即结束），对话中显示聆听/思考/说话与识别文字。旧 r24 包已从下载目录撤下。

> **产物核验（r25）**：`NuanbanDemo-0.1.0-win32-x64-portable-20261024-r25.zip` 215,346,710 字节（205.392 MiB），SHA256 `ed0e9e7b55619a479fcf077549058f2019c924020802ca4e8a8d350bbef6e406`；主机按字节核验一致，公开 HEAD 200。包内逐项核对（解包 ASAR 读取）：`xingyun-avatar.cjs` 含 `SESSION_MODES=['render','conversation']` 与两套会话体、`xingyun-permission-guard.cjs` 只放行 `media`、`main.cjs` 安装闸门且**无任何 `callback(true)` 字面量**、`standalone-host.cjs` 具备 arm/disarm、桌宠页面含"实时对话"入口、`avatar-runtime/xingyun-renderer.js`（1,217,205 字节）内含 Agent/startASR/stopASR/destroy/对话事件/代次守卫；`PET_AVATAR_CSP` 未放宽（仍只允许 `https://*.xingyun3d.com`、`wss://*.xingyun3d.com` 与既有 OSS 域）。

> **验证范围与诚实边界（r25）**：`pnpm typecheck` 0；星云相关 66 passed（xingyun-avatar 31 + conversation 16 + management-voice 19）、`desktop-pet-ui` 204 passed、`desktop-standalone-host` 81 passed；合成 SDK 的 E2E 26 passed（13 用例 × 2 视口，含取消不开麦、确认后开麦与停止后不残留 ASR、迟到回调被丢弃）。**未验证**：没有在应用内发起任何真实星云会话（额度未消耗），因此实时链路 `wss://e2emp.xingyun3d.com`、口型同步、端到端延迟与计费口径均**未实测**；打包后 `file://` 页面开麦的运行时条件也未真机验收（若失败优先排查系统麦克风隐私设置与两个权限处理器）。包体从 r24 的 188.2 MiB 增至 205.392 MiB，含本日累积的已提交工作（r24 检索、栗栗/露米形象、桌宠自动收边球等），非单一改动所致。

>
> **并入的提交**：`af987fd`（为 Web 管理端补齐全站动效层：CSS + 轻量 WAAPI）、`bd17a5d`（修复 Web 端必修无障碍缺陷：对比度、抽屉焦点、渲染兜底、页面标题）。合并基点是我们自己的 `48c3121`，即对方分支只比我们多这 2 个提交；合并提交为 `2753a0c`（`git merge mobiwusi/main`，35 个本地提交保留）。
>

> **2026-10-24 r23：** 修复 r22 里"云端听写必定失败（`cloud_dictation_failed`）"——**根因是我自己的 bug**：录音器把 WAV 默认写到脚本所在目录，而正式环境脚本位于 `app.asar` **内部**（asar 是文件、不是目录），助手写不出文件即抛错。现在录音落到临时目录（Electron 传 `app.getPath('temp')`），asar 内路径在派生进程前就被拒绝，助手 stderr 随错误带出便于定位。同时新增：**近静音（峰值 < 0.015）不再上传**（避免识别器幻觉），并给出可操作提示且不再白跑一次本机离线识别。另外把语音弹窗标题从"本地语音输入"改为"语音输入"（里面有上传开关，原名不准确）。r22 已从下载目录撤下。

> **产物核验（r24）**：`NuanbanDemo-0.1.0-win32-x64-portable-20261024-r24.zip` 197,342,127 字节（188.2 MiB），SHA256 `8b50b68b53d00d4b993e8ef8f1eb607ed834a3931f30fa8d15ed50bf3aba2c5a`；上传后按字节核验一致，公开 HEAD 200。包内核对（解包 ASAR 后逐项读取）：解包脚本含 `peak < 0.015` 静音门限且保持纯 ASCII；`cloud-recorder.cjs` 含 `tempDir`/`os.tmpdir()`、`insideArchive(target)` 拒绝与 `detail: stderrTail`；`main.cjs` 传 `tempDir: app.getPath('temp')`；宿主含"这次几乎没有收到声音"提示并跳过离线回退；前端弹窗标题已是"语音输入"。

> **验证范围（r23）**：`pnpm typecheck` 0；本次触及套件（云听写上传/录音器/宿主/管理端/语音桥）**142 passed**；生产同构端到端：脚本经 `app.asar` 路径交给录音器（实际执行 `app.asar.unpacked` 副本）→ **14.7 秒录音、437 KB WAV、增益 ×13、临时文件自动清理**。诚实边界：**仍未做真人语音验收**；用系统 TTS 对喇叭朗读做闭环时识别成"东方的广场。"（空气传播后峰值仅 0.069），因此**不能声称识别准确**，需要用户靠近麦克风（约 10~15 厘米）实测。


> **2026-10-24 r22：** 修复“说话它听不见”——现场实测内置麦克风阵列拾音仅 **−27 dBFS**（近场 0.12~0.17），Windows 离线中文引擎对这种弱信号只给出 0.03~0.05 置信度的乱码，因此新增**可选、默认关闭的云端听写**（所有者批准）：录音（NAudio 16 kHz 单声道、语音门限自动停、**自动增益归一到 ≈ −3 dBFS**）→ 上传到已配置网关 `/audio/transcriptions`（默认 `gpt-4o-transcribe`，429/5xx 有界退避重试）。开启需本人在原生窗口确认；**每次语音输入仍单独弹窗写明本次录音会上传**，识别后立即丢弃、不在本机保存；云端失败自动回退本机离线识别并在语音状态说明原因。未开启时音频不出机。r21 已从下载目录撤下。

> **产物核验（r22）**：`NuanbanDemo-0.1.0-win32-x64-portable-20261024-r22.zip` 197,335,820 字节（188.19 MiB），SHA256 `b847416e9afa9925c0fcfed04822e81fab1ca5353d22c222b17c8cbc69b7983d`；主机上传后按字节核验一致，公开 HEAD 200。包内核对：`app.asar.unpacked/voice/windows-cloud-dictation.ps1`、`app.asar.unpacked/voice/NAudio.dll`（PE，513,536 字节）均在 asar 之外；r21→r22 条目 85→87（**仅新增这 2 个解包文件**），变化条目只有 `resources/app.asar`（51,184,539 → 51,214,703 字节，+30,164）。录音助手脚本经静态核对**不含任何联网调用**；NAudio 1.10 为 MIT，许可文本随包内 `voice/NAudio-LICENSE.txt`（在 asar 内）。

> **验证范围（r22）**：`pnpm typecheck` 0；非 acceptance 全量 **2972 passed / 18 failed**，18 项失败全部落在既有红测（`android-3d-assets`、`android-3d-render-policy`、`android-model-access`、`desktop-shell-target-stability`，均为其他会话在途工作）；云听写相关新增测试 18 项（上传/重试/限额/取消/不落盘/不联网、录音器协议与错误映射、开关持久化）+ 语音桥与管理端用例全绿。**未做真机语音验收**：以上不证明"在本人机器上识别准确"，需用户在 r22 里亲自试。


> **冲突与解决**（仅 2 处，均为"双方各自新增"）：`apps/web/src/responsive.css`（我们新增的输入框窄窗规则 + 对方新增的抽屉关闭入口规则 → 两块**都保留**）；`apps/web/src/pages/pet-settings.tsx`（我方 `localModelBridge/liliModel` 与对方 `stagger/localCompanionBridge/showLiliCompanion` 的 import → **两组都保留**，故两边的宠物设置能力都不丢）。
>
> **合并前后严格对照（都在干净工作树上，排除他人在途改动）**：
> - 非 acceptance 全量：合并前 `14 failed / 2929`，合并后 `14 failed / 2945`（**+16 个用例全部通过**，失败文件集合完全相同：desktop-lab、android-3d-assets、android-3d-render-policy、desktop-shell-target-stability，均为既有在途问题）。
> - acceptance 门禁：合并前后均为 `28 failed / 135`（证据指纹类，既有红灯）。
> - `pnpm typecheck` → 0。
> - **新增前端 e2e 全部通过**：`motion.spec.ts` + `a11y-basics.spec.ts` 在 desktop-chromium **12/12 passed（18.2s）**，涵盖按卡片错峰入场、减少动画即时生效、系统级 reduce 偏好、路由转场、弹窗开合与失焦暂停、对比度 4.5:1、标题跟随 H1、抽屉键盘可达与 Esc 回焦、渲染异常兜底、触达尺寸。
>
> **产物核验**：打包脚本 exit 0；包内已确认含动效模块、`prefers-reduced-motion`、标题跟随、错误兜底、抽屉关闭入口，且**我们原有的输入框窄窗规则仍在**；r20→r21 仅 `resources/app.asar` 变化（+14,469 字节）。
>
> **边界**：仍为未签名内部试用包，未做安装验收；Android 两个 APK 本次**未重编、未上传**（仍是 21:24 那一版），Android 合并后的 UI 需另行出包。


> **2026-10-23 r20：** 修复 r19 **自身引入的听写回归**（如实记录，r19 已从下载目录撤下）。r19 用 `add_AudioLevelUpdated` / `add_AudioSignalProblemOccurred` 直接挂 .NET 事件委托；在 PowerShell 5.1 非交互脚本里这类脚本块会在识别引擎线程上执行并抛错，结果是听写助手**约 10 秒后异常退出（exit 2）且连错误事件都没发出**，宿主只能落到兜底文案"本次语音输入失败，请检查 Windows 默认输入设备、麦克风权限和离线中文语音引擎。"。
>
> **定位方式**：用与宿主相同的协议直接驱动助手做 A/B——r18 助手：`ready` → 20 秒内如实返回 `uncertain`/`wake_dictation_timeout` → exit 0；r19 助手：exit 2、无错误事件。差异即结论。
>
> **修复**：音频事件改为 `Register-ObjectEvent` 排队（与该脚本既有的 SpeechRecognized/RecognizeCompleted 同一套已验证模式），由主轮询循环取出并更新电平/问题变量，再由主线程按 500ms 节流发出 `signal` 事件；协议行始终单线程写入。**打包内助手**复测：听写 `ready → signal → uncertain → exit 0`，连续唤醒 `ready → signal → stop → exit 0`，两种模式均无错误事件。
>
> **核验**：`pnpm typecheck` 0；`desktop-local-wake` + `speech` + `desktop-pet-ui` 共 **312/312** 通过；新增静态回归守卫禁止再用 `add_Audio*` 跨线程委托，并要求循环内 `Get-Event` 排空与解注册完整。r19→r20 除助手与相关 UI/测试外的其余内容来自其他会话在本窗口内已提交的改动。
>
> **仍然成立的环境结论**：拾音电平偏低（实测 31/100、`TooSoft/TooNoisy`）需要本人靠近麦克风、提高输入音量/加强或改用耳机麦；代码负责把"静默失败"变成"看得见的原因"并如实报错。


> **2026-10-23 r19：** 修复“语音功能听不见我说话”。现场实测：麦克风阵列音量 87% 且未静音、离线 zh-CN 引擎（`MS-2052-80-DESK`）在位、听写 helper 进程在运行，但拾音电平只有 **31/100**，引擎报 `TooSoft/TooNoisy/TooSlow`，识别置信度仅 **0.03~0.05**（乱码）→ 按既有策略判为不确定而拒绝，而界面**完全静默**，用户看不到任何原因。
>
> **改动**：唤醒脚本新增**建议性**信号事件 `{ kind: 'signal', level: 0..100, problem }`（音频回调只写变量、由主轮询循环按 500ms 节流发出，协议行不会交错）；桥接校验后写入 `status.signal`，非法载荷一律忽略且永不让操作失败；语音面板新增**实时电平条**与可操作建议（信号过弱→靠近麦克风/提高输入音量；环境噪声→关闭噪声源或用耳机麦；语速/停顿→连贯说一句）。**不改** 0.6/0.78 阈值、不引入云端识别、音频仍只在本机处理。
>
> **核验**：`pnpm typecheck` 0；`tests/platform/desktop-local-wake.test.ts` + `tests/domain/speech.test.ts` + `tests/platform/desktop-pet-ui.test.ts` 共 **312/312** 通过（新增 13 项：信号解析/非法载荷忽略/听写结果不受影响/PS1 静态断言/状态校验/文案映射）；包内三处均已确认（桥接 `event.kind === 'signal'`、解包 `windows-local-wake.ps1` 含 `kind = 'signal'`、UI bundle 含“麦克风信号过弱”等文案）；r18→r19 仅 `resources/app.asar` 与 `app.asar.unpacked/wake/windows-local-wake.ps1` 变化。旧 r18 已从下载目录移除。
>
> **仍属环境问题（未由代码解决）**：拾音电平偏低是笔记本内置阵列离嘴远/环境噪声导致，需要靠近麦克风、提高输入音量/麦克风加强或改用耳机麦；代码只是把“静默失败”变成“看得见的原因”。若近场/耳麦下识别仍不理想，需另立“换现代本地 ASR（whisper.cpp / sherpa-onnx）”评估。


> **2026-10-23 r18：** 把 r17 之后**已提交**的 Win 侧修复全部打进安装包，仍从独立干净工作树构建（HEAD `3b108d0`）。内容：`f17e5a1` 恢复原始 Blender 小鹿作为桌面形象（含更大的原始 GLB）、`89b2728` 隔离共享查看器与未完成 studio 改动；r15 起的有界重试与单帧超时修复一并保留。
>
> **核验**：包内模型与仓库跟踪文件**逐字节一致**（`Lumi_Magical_Kitten.glb` 5,411,364 B sha256 `3ec165a2…`、`Lili_Independent_Deer.glb` 7,171,212 B sha256 `8b5b3adc…`；两者的 `character_manifest.json` 仅压缩格式不同、字段值一致）；r17→r18 的 zip 条目**仅 `resources/app.asar` 变化**（36,860,498 → 45,685,329，+8.8 MB，来自原始模型与相关资源）；打包脚本（含 UI/ASAR 字节核对）exit 0。
>
> **未包含（有意）**：当前仍**未提交**的 studio 相关改动（`apps/web/src/three-d/viewer.ts`、未跟踪的 `lumi-studio.ts`）不在包内——按惯例不打包半成品；待其提交后可出 r19。
>
> **发布方式改进**：`infra/windows/tools/push-downloads.mjs` 新增 `--keep-published`（Windows-only 发布时在服务器端列出目录并对**每个文件**做 SHA256，页面保留已发布的 Android 行、不重传 APK），并在生成页面时跳过 `.html` 自身条目。本次发布后下载页为 3 行（Windows r18 + 两个 Android debug 包），旧的 r17 已从下载目录移除。
>
> **边界**：仍未做代码签名与安装/真机验收；Android 两个 APK 仍是 2026-10-23 21:24 那一版（本次未重编、未上传）。


> **2026-10-23 r17：** 修复"模型只认文字、认不出图标，浏览器入口报未识别"。两处断点：① 本机控件词表里没有任何应用名，OCR 读到的 `Google Chrome` / `Microsoft Edge` / `浏览器` 被当成未知正文整条丢弃；② 无文字图标的候选要求四周接近纯色（`flatSurround`），壁纸上的桌面快捷方式因此全部被否掉。现在词表加入浏览器、微信/QQ/钉钉、Office/WPS、记事本/计算器/任务管理器等常见应用与入口名，并参与桌面场景判定；视觉候选新增"图标网格"通道，只有与同列、同尺寸量级、间距像图标网格的邻居成对出现时才接受，照片纹理仍被拒绝。提示词同时要求模型优先使用 `surface=visual` / 应用名条目按位置指引，不再直接回答"识别范围有限"。构建来自独立干净工作树（HEAD `8e088e4`），`tsc --noEmit` 退出 0，相关测试 424/424（9 个文件）通过；包内已确认含新词表、网格候选与提示词。Android 两包与最新 Web 产物仍逐文件一致（14/14），未重出。旧 r16 包已从下载目录移除。


> **2026-10-23 r16：** 在 r15 之后落地的提交一并打包，并修复"截图/录屏拍不到桌宠和界面"。内容：`5e15bc9`（Lili 小鹿模型，包内 `ui/models/lili/Lili_Independent_Deer.glb` 等 3 个资源）、`9dfa22e`/`77516be`（Android WebView 文件选择、本地 TTS 与内置形象）、`89fa899`（模型网关可恢复失败的有界重试）以及本次 `731b2fd`：Windows `setContentProtection` 会经 `SetWindowDisplayAffinity` 把窗口排除出截图/录屏，旧默认只有启动参数才可见，直接运行 `nuanban.exe` 时桌宠与管理界面会从 Snipping Tool / Game Bar / OBS 里消失。新的 `capture-visibility.cjs` 让桌宠、工具小屋、语音气泡与管理界面**默认可被截图和录屏捕获**，屏幕观察/单帧采集活动时自动恢复保护；`--protect-pet`/`--protect-client`/`--protect-display` 保留旧行为，字幕与指引箭头仍始终保护。构建来自独立干净工作树（HEAD `731b2fd`），r15→r16 的 zip 条目差异为 `resources/app.asar` 与新增的 Lili 资源；相关测试 619/619（17 个文件）通过。Android 两包与最新 Web 产物逐文件一致（14/14，含 Lili 与 Lumi），未重出，哈希保持不变。旧 r15 包已从下载目录移除。


> **2026-10-23 r15：** 修复"云分析服务暂不可用"。现场 trace 显示请求 11 秒后以 `providerCode=PROVIDER_UNAVAILABLE` 失败，而同一分钟本机实测网关 `GET /models` 与连续三次对话请求均 200（另有 GitHub TLS 握手失败），属于**偶发 5xx/网络抖动**。模型端口现在只对**可恢复失败**做有界重试：网络异常、HTTP 429/5xx、响应中断最多重试 2 次（退避 0.6s/1.6s，共享原有 60s 超时预算）；鉴权失败、非法请求、取消与超时仍只尝试一次。文案与 trace 会说明"已做有界自动重试"并记录 `attempts`；`retryAttempts`/`retryDelaysMs` 可配置。验证：17 个相关测试文件 **1178/1178** 通过、`tsc --noEmit` 0、打包校验 `matches: true`，r14→r15 的 zip 条目仅 `resources/app.asar`（+2,130 字节）变化。旧 r14 包已从下载目录移除。
>
> **同批 Android 包（2026-10-23 21:24 最终发布，从 HEAD `9dfa22e` 干净构建）：** 独立桌宠包修复"打开桌宠只有'微光指引'四个字、没有形象"——悬浮层由 `TextView` 改为 `ImageView` 并随包携带产品默认"花环水獭"本地静态形象（`res/drawable-nodpi/nuanban_pet_preview.png`，只进独立源集，普通包不携带）；两包同时恢复 WebView 宿主能力：`onShowFileChooser`（系统文件选择器，零权限）与系统 `TextToSpeech` 注入的 `speechSynthesis` 垫片（无网络、无麦克风，引擎不可用时保持降级）；并纳入已提交的 Lili/Lumi 模型与最新共享 UI。
>
> **来源与可复现性说明：** 这一对由**已提交的 HEAD `9dfa22e`** 在独立干净工作树中构建（`pnpm android:sync` + `check-standalone-packaging.ps1`），不含任何未提交改动，可从该 commit 重建；debug 签名含构建时间戳，**每次重编哈希都会变化**，但包内容一致。上表记录的是**线上实际文件**的哈希与大小。两包仍为 debug、未做真机安装/悬浮窗/麦克风验收（`deviceVerified=false`）。
>
> **Android 能力边界（未变）：** 管理页没有模型通道（无 `nuanbanTextQuestion`/`nuanbanImageQuestion` 桥），图片问答与文字 AI 不可用；听写/麦克风按权限边界保持关闭（无 `RECORD_AUDIO`）。要让 Android 接入真实模型需要"受控会话接入"（服务端会话/设备绑定 + Android 原生加密存储 + 桥接，令牌不进 JS），属独立立项。


> **2026-10-23 r14：** 桌面包含语音误触发修复（`a8ece51`，r13 起已在包内）与新的 **Lumi 小猫模型**（`c444732`，客户端本地生成，包内可见 `ui/models/lumi/Lumi_Magical_Kitten.glb` + 清单/海报）；单帧 `TIMEOUT` 修复保持不变。仍从**独立干净工作树**构建（HEAD `c444732`），r13→r14 的 zip 条目仅 `resources/app.asar` 变化（+83,098 字节）。Android 两个包同批重出：Web UI 12/12 逐文件一致（含 Lumi 资源），打包隔离校验 87/87；本次干净构建同时**剔除了此前混入的未提交 Lili 资源**，因此包体积变小（普通包 5.13 MiB、独立包 83.93 MiB）。发布前相关测试 1117/1117（16 个文件）通过。旧 r13 包已从下载目录移除。


> **2026-10-23 r13：** 在 r12 的单帧 `TIMEOUT` 修复（provider 60s / 单帧 90s / 上传降采样 + 坐标还原 / 错误码中文提示）之上，纳入当日晚些时候提交的 `a8ece51`（本地语音听写在不确定时不执行）。仍从**独立干净工作树**构建（HEAD `63fc4bb`），与 r12 的 zip 条目逐项比对只有 `resources/app.asar`（+2,616 字节）与解包脚本 `wake/windows-local-wake.ps1`（+1,291 字节）变化，无新增/删除文件；发布前跑完 15 个相关测试文件 **1112/1112 通过**。r12 已被 r13 取代并从下载目录移除。


> **2026-10-23 r12：** 修复单帧图片指引报 `Error: TIMEOUT`：桌面提供方默认超时 45s→60s（`ai-provider.json` 可用 `timeoutMs` 下调，环境变量 `NUANBAN_AI_TIMEOUT_MS` 同样生效），单帧流程超时窗口 50s→90s，单帧上传复用连续模式的图片降采样（超过约 1.4 MB 时发送缩放副本，并把模型返回的缩放坐标按原图比例还原后再本机核验），`TIMEOUT`/`PROVIDER_UNAVAILABLE` 等错误码改为中文提示，不再透传原始错误。
>
> 本包在**独立干净工作树**（HEAD `322ac84` + 本次桌面修复）中构建：与 r11 的 zip 条目逐项比对只有 `resources/app.asar` 变化（-6,168 字节），确认没有把仓库里其他未提交的语音/唤醒 WIP 打进包。验证：桌面相关测试 984/984、`tsc --noEmit` 0、打包校验 `matches: true`、ASAR 内含 `analysis-image.cjs`、`mapProviderFailure`、`timeoutMs = 90_000`、provider 默认 60000。旧 r11 包已从下载目录移除。


> **2026-10-23 r11：** Windows 包升级到包含后续桌面提交的版本：`48c3121`（实况共享中识别纯图标控件：新增 `observation/visual-controls.cjs` 与 `analysis-elements.cjs`，普通 OCR 标签缺失的图标目标也能核验）与 `c621ac7`（桌宠/伴随改进、移动端聊天与服务端文本会话等桌面侧改动）。桌面套件 906/906 测试通过、打包校验 `matches: true`、ASAR 内确认包含 `visual-controls.cjs`/`analysis-elements.cjs`/`prepareImage`。Android 两包无需重出（同一批 Web UI，逐文件一致）。旧 r10 包已从下载目录移除。


> **2026-10-23 r10：** 修复全屏 4.6 MB PNG 缩放 0.7 秒把帧龄推过发送门的问题：缩放改为 `prepareImage()` 惰性执行（先过 5 秒发送门再缩放上传）；OCR 降采样上限 1400→1080；提供方错误不再因帧龄被误报成「画面已过期」。旧 r9 包已从下载目录移除。


> **2026-10-23 r9：** 修复全屏共享下慢模型回复被误判「画面已过期」：安装不再额外要求帧龄 ≤ maxAge-500，只要求采集范围一致 + 当前帧已准入（≤5 秒），过期则最多重采四次；过期帧重采上限 2→3。r8 的 trace 显示全屏帧龄已降到 3.1~4.7 秒，剩下的问题是这条多余阈值。旧 r8 包已从下载目录移除。


> **2026-10-23 r8：** 修复大区域共享报「本地画面处理超时」：长边超过 1400px 时本地 OCR 先降采样（词框坐标映射回原图），把检测时间压回五秒准入窗口内；小区域仍按原分辨率。现场实测 2000×1200 的 OCR 坐标映射误差 1~3px。旧 r7 包已从下载目录移除。


> **2026-10-23 r7：** 修复「本次分析未获得可核验的结果」：全屏脱敏 PNG 超过桌面提供方 2 MB 图片上限，被本地校验拒绝后映射成 ANALYSIS_FAILED。发送前超过约 1.4 MB 时用 nativeImage 等比缩小副本上传（target_id 映射不变）；ANALYSIS_FAILED 现在有明确文案；trace 增加 analysis_request/analysis_image_scaled 与 providerCode。旧 r6 包已从下载目录移除。


> **2026-10-23 r6：** 采集链路提速：抓屏前源枚举缓存 6 秒（每帧最多一次真实枚举）、放大 OCR 第二遍默认关闭（大屏约省一半 OCR 时间）、trace 增加 captureMs/detectMs。目的：把本机每轮 3.4~4.0 秒压下来，让连续指引更接近实时。旧 r5 包已从下载目录移除。


> **2026-10-23 r5：** 日志显示本机「采集+本机检测」一轮约 3.4~4.0 秒，r4 的 2.5 秒新鲜度门槛导致安装始终被拒（`install_freshness fresh:false ageMs≈3.5s`）。r5 在五秒安全窗口内安装，并把箭头显示窗口改为从本地核验完成时间起算五秒、由后续准入帧续期；新增 `capture_cycle` 等诊断事件。旧 r4 包已从下载目录移除。


> **2026-10-23 r4：** 修复「分析返回时画面已过期或观察范围发生变化」误报：模型返回后不再要求当前帧 OCR 签名与上传帧完全一致，改为采集作用域一致 + 最新安全帧新鲜 + 目标在新帧按标签/4px 本机重定位；完成类结果仍要求已验证的 DIP 几何与显示器标识。旧 r3 包已从下载目录移除。


> **2026-10-23 r3：** 修复箭头出现不到一秒就消失：慢响应返回时先取新鲜安全帧再计算显示窗口（旧帧会让有效期只剩几百毫秒），并在等待操作时对单帧 OCR 丢失给一个轮询间隔的容错；新增本机 `guidance-trace.log` 诊断日志。旧 r2 包已从下载目录移除。


> **2026-10-22 r2：** 修复授权连续共享下真实屏幕持续刷新导致模型结果被反复中止、箭头无法定位的问题（安全帧签名改为只覆盖可识别控件，已显示箭头按作用域+标签+4px 重新核验）。旧便携包已从下载目录移除，仅保留本 r2。


> 文档生成：2026-10-22 22:12（Asia/Shanghai）。构建命令 `pnpm desktop:package`，退出码 0。

## ⚠️ 发布状态（先读）

**本产物未签名、未做代码签名、未做真机验收、不是正式发布。**

- 没有代码签名证书，未做 Authenticode / EV / OV 签名，未加时间戳；`Get-AuthenticodeSignature` 结果为 `NotSigned`。
- 没有在其他 Windows 版本、真实显示器/多屏/DPI、真实账号、真实模型供应商或真实桌面上做过安装验收。
- 本目录及本文只描述一次本机构建产物，不构成 D07/F19 发布签收，也不能用于对外正式分发或宣称功能已验收。
- 产物只用于内部试用/联调，分发前必须由负责人重新确认范围与风险。

## 1. 产物清单（绝对路径）

| 产物 | 绝对路径 | 大小 | SHA256 |
| --- | --- | --- | --- |
| 便携 zip（推荐分发物） | `C:\Users\33864\Desktop\nuanban\apps\desktop\out\dist\NuanbanDemo-0.1.0-win32-x64-portable-20261024-r29.zip` | 215,369,016 字节（205.392 MiB） | `c8b096523f9f270f9d4be1ed91af39b1411d98757cd04339246f94ca762197cf` |
| 可执行目录 | `C:\Users\33864\Desktop\nuanban\apps\desktop\out\NuanbanDemo-win32-x64\` | 78 个文件 / 418,924,042 字节（399.517 MiB） | 见下方目录清单 |
| 主程序 | `...\out\NuanbanDemo-win32-x64\nuanban.exe` | 245,621,248 字节（234.243 MiB） | `c7af6cbe5ec98eecc72c512fac6b7bdb92fc9ed559e0458772dadb24ae611753` |
| 应用归档 | `...\out\NuanbanDemo-win32-x64\resources\app.asar` | 34,169,465 字节（32.587 MiB） | `3696c3bdf9f31cccc87d3088523981284b60c77e328f252e30497aef665bed7d` |
| 校验和清单 | `...\out\dist\SHA256SUMS.txt` | 620 字节 | 内含以上三个 SHA256 |
| 目录全量文件清单 | `...\out\dist\NuanbanDemo-win32-x64-files.sha256` | 6,669 字节（78 行） | 清单文件自身 SHA256：`cb1de5812268829965731f008da9207118393edaf6aae9ce517c25b6eabdb067` |

- zip 内顶层目录为 `NuanbanDemo-win32-x64/`，条目名使用正斜杠（符合 ZIP 规范），可直接解压到任意位置。
- **没有安装包**：`apps/desktop/out/make/squirrel.windows/x64/` 为空，无 `Setup.exe`。原因见第 7 节。
- **未上传到任何服务器，也未部署**：以上路径只存在于本构建机。

## 2. 构建信息

| 项 | 值 |
| --- | --- |
| 执行命令 | `pnpm desktop:package`（根目录，`scripts/desktop-package.ps1`） |
| 退出码 | 0（成功） |
| 构建时间 | 2026-10-22 22:07:16 开始，官方命令 22:08:10 完成（D03 报告 `generatedAt=2026-10-22T14:08:10.557Z`）；最终目录 mtime 2026-10-22 22:09:57–22:09:58（见下方说明） |
| 构建机 | Windows 11 家庭版 中文版，10.0.26200，64 位；Windows PowerShell 5.1.26100.9711 |
| Node / pnpm | Node v24.21.0 / pnpm 9.12.0 |
| Electron | 44.7.2（`resources/version` = `44.7.2`，`electron.exe`/`nuanban.exe` PE ProductVersion 一致） |
| 打包工具 | electron-forge 8.0.1、@electron-forge/maker-squirrel 8.0.1、electron-winstaller 5.4.4、@electron/asar 4.3.1 |
| Electron 来源 | 本机离线缓存 `.cache/electron/electron-v44.7.2-win32-x64.zip`（174,965,874 字节），打包阶段未下载 Electron |
| 产品版本 | 0.1.0（`apps/desktop/package.json`）；exe FileVersion/ProductVersion = 0.1.0 |
| 源码状态 | git HEAD `1f178aa92592648b418a4d6518450c5439f5d342`（分支 `main`），**工作区 dirty**（含未提交改动），产物不能仅凭该 commit 重建 |
| 产品/文件名 | 显示名“微光指引”；打包名 `NuanbanDemo`，可执行文件 `nuanban.exe` |

说明：官方命令失败后的可选 `electron-forge make` 尝试各重跑了一次 `electron-forge package`，因此最终目录时间戳晚于 22:08:10；`resources/app.asar` SHA256 与 22:08:10 的 D03 报告完全一致（`3696c3bd…bed7d`），内容未变。

## 3. 未签名与 Windows SmartScreen 预期

- 本产物**没有任何签名**，不是“已签名但证书不受信任”，而是完全没有 Authenticode 签名。
- 用户首次运行 `nuanban.exe` 时的预期行为：
  - 可能出现 SmartScreen 提示 **“Windows 已保护你的电脑 / Windows protected your PC”**，发布者显示“未知发布者”；需要选择“更多信息 → 仍要运行”才能继续（这是 Windows 对未签名程序的默认提示，不是本包特有缺陷）。
  - 可能弹出 **UAC“未知发布者”** 提示，因为 exe 未签名。
  - Windows Defender/杀毒软件可能对 245 MB 未签名 Electron 可执行文件做首次扫描，导致启动偏慢或临时拦截。
- 运行前先核对 SHA256（见第 6 节），确认文件未被篡改；哈希不一致时**不得运行**。
- **禁止**为了运行本包而安装根证书、关闭 SmartScreen/Defender 或修改任何系统安全设置。若所在组织策略不允许运行未签名程序，请勿分发或运行本包。
- 未签名意味着无法证明发布者身份、无法防篡改，也**不是正式发布**依据；对外分发需要负责人先完成签名（OV/EV + 时间戳）与真机验收。

## 4. 安装 / 运行（便携版）

本产物是**便携目录 + zip**，不是安装器，不写注册表、不装服务、不需要管理员权限。

1. 校验 zip：在 PowerShell 中执行
   `(Get-FileHash 'C:\Users\33864\Desktop\nuanban\apps\desktop\out\dist\NuanbanDemo-0.1.0-win32-x64-portable-20261024-r29.zip' -Algorithm SHA256).Hash`
   应为 `42C5609E88CD6905BD4161622F39E6DF3CB15314E3ABDF595E9A8C09C34B4FB0`。
2. 解压 zip 到本地固定目录（不要在压缩包内直接运行，也不要在 Program Files 等受保护目录内运行）：
   例如 `C:\Users\<用户名>\Apps\NuanbanDemo-0.1.0\`，解压后应存在 `NuanbanDemo-win32-x64\nuanban.exe`。
3. 双击 `NuanbanDemo-win32-x64\nuanban.exe` 启动。启动后默认是独立悬浮桌宠，管理窗口按需打开；不会自动抓屏、不会自动开麦、不会自动连接业务后端或模型供应商。
4. 首次运行会在 `%APPDATA%\@nuanban\desktop` 建立本机数据目录（Electron 默认 userData，路径来自包内 `package.json` name `@nuanban/desktop`），其中可能包含本机学习档案、提醒、加密后的配置等本地数据；不会上传。
5. 组件完整性可离线核对：`resources\version` 内容为 `44.7.2`，`resources\app.asar` 与 `app.asar.unpacked` 存在，后者含 5 个 PowerShell 脚本（含 `wake\windows-local-wake.ps1` 等），缺失会导致相关功能不可用而不是“静默成功”。

## 5. 卸载

1. 在客户端/桌宠中正常退出（含托盘退出），确认进程 `nuanban.exe` 已结束。
2. 直接删除解压出来的整个 `NuanbanDemo-win32-x64` 目录即可；没有安装器、“程序和功能”卸载项、服务、计划任务或注册表项需要清理。
3. 可选：删除 `%APPDATA%\@nuanban\desktop` 以清除本机数据。**注意**：这会删除本机学习档案、提醒、加密配置/凭证引用等，删除前自行备份；不删则数据保留。
4. 不要删除 `%APPDATA%\electron` 等可能被其他 Electron 程序共用的目录。

## 6. 冒烟检查结果（离线；未启动 GUI、未采集、未开麦、未联网）

| 检查 | 结果 |
| --- | --- |
| `node scripts/check-d03-candidate.mjs` | `success=true`、`status=matched`、`extraPackagedFiles=[]`、退出码 0；`apps/web/dist` 与包内 `ui/` 全部文件逐字节一致，归档 SHA256 `3696c3bd…bed7d` |
| ASAR 完整性 | `resources/app.asar` 193 个条目 / 169 个文件全部成功提取并计算哈希，0 失败；19 个目录条目；`app.asar.unpacked` 含 5 个 `.ps1` 与 `read-provider-secret.ps1` |
| Electron/版本 | `resources/version` = `44.7.2`；exe FileVersion/ProductVersion = `0.1.0`；`Get-AuthenticodeSignature` = `NotSigned` |
| zip 完整性 | 7-Zip `t` 测试 `Everything is Ok`；78 个文件 / 7 个目录，解压后 418,924,042 字节；zip 内 `nuanban.exe`、`resources/app.asar` 的 SHA256 与目录中的文件一致 |
| 目录文件清单 | 78 个文件全部记录在 `NuanbanDemo-win32-x64-files.sha256`，清单文件 SHA256 `cb1de581…b067` |

明确**没有做**（因此不能当作验收依据）：未启动可见 GUI 窗口（避免干扰使用中的桌面）、未启用屏幕采集/麦克风/本地唤醒、未连接任何真实模型供应商或业务后端、未点击任何系统授权、未安装到另一台真机、未测试多屏/混合 DPI/远程桌面/无障碍、未测试安装器（不存在）、未做长时间运行与崩溃恢复。

## 7. 已知问题与需要负责人决策的事项

1. **没有安装包（Squirrel Setup.exe 失败）**：两次执行
   `pnpm --filter @nuanban/desktop exec electron-forge make` 均在 “Making a squirrel distributable for win32/x64” 阶段失败，错误为
   `Fatal error: Unable to commit changes`（来自 electron-winstaller 5.4.4 自带的 `rcedit.exe`，在给打包副本设置图标时失败）；`out/make/squirrel.windows/x64/` 为空。
   官方 `pnpm desktop:package` 本身只做 `electron-forge package`，按 `apps/desktop/README.md` 的说明不创建正式安装器，因此本次交付便携版。
   如需 Setup.exe：需要改打包配置（如 maker 选项/跳过图标更新）或升级/替换 electron-winstaller 后重新验证，属于打包配置修改，需负责人批准后再做。
2. **签名证书缺失**：本机无代码签名证书，未尝试签名、未安装任何证书。正式对外分发前需由负责人提供证书并签名+时间戳。
3. **体积**：zip 173.65 MiB，解压后 399.52 MiB（Electron 运行时约 245 MB 的 `nuanban.exe` 占主要部分）；首次下载、解压和 SmartScreen/杀软扫描都会偏慢，服务器带宽/对象存储上传需要预留。
4. **exe 元数据仍是 Electron 默认值**：`CompanyName=GitHub, Inc.`、`FileDescription/ProductName=NuanbanDemo`，未改为“微光指引”；对外分发可能造成发布者困惑并加重 SmartScreen 不信任提示，属于正式发布前应修复项。
5. **源码工作区 dirty**：产物包含未提交改动，不能由 HEAD `1f178aa` 单独重建；需要可复现构建时应先固定提交。
6. **未做真机验收**：没有任何机器安装/运行验收记录；本文件只证明产物结构与字节完整性。
7. **无自动更新**：未配置自动更新通道，升级需手动替换便携目录或后续安装器方案。

## 8. 服务端边界（只提供下载和 API，不运行客户端）

- 服务端（`C:\nuanban` 的 IIS 静态站点 + 本机 Node API，见 `infra/windows/README.md`）**只提供静态文件下载和 API**，**不在服务器上运行、安装或代理 Windows 客户端**：不运行 Electron、不启动 `nuanban.exe`、不执行客户端的采集/语音/模型功能。
- 客户端始终在用户自己的 Windows 电脑上运行；API 与静态站点是两回事，客户端是否可用不因部署了 Web/API 而改变。
- 建议分发方式（本次**已执行**）：产物已通过一次性上传通道发布到试验服务器 `http://59.110.19.225/downloads/`（详见 `infra/windows/README.md` 的「下载分发」一节）。服务器只做只读静态下载，不运行客户端、不执行 `.exe`/`.apk`；分发哈希以上表与下载页为准，哈希不一致的副本不得分发。
- **不要把任何分发产物提交到 git**：`apps/desktop/out/` 已在根 `.gitignore` 中忽略；本目录新增 `.gitignore` 仅用于防止 `infra/windows/downloads/` 中未来放入的二进制被误提交。
- 下载校验以本文件第 1 节 SHA256 为准；服务器/CDN 上的文件若哈希不一致，不得分发。

## 9. 复现与校验命令（构建机）

```powershell
cd C:\Users\33864\Desktop\nuanban

# 1) 官方打包（含 web/avatar 构建；需要已安装 Electron 44.7.2 与 .cache/electron 缓存）
pnpm desktop:package

# 2) 包内 UI 与当前 web 构建逐字节核对
node scripts/check-d03-candidate.mjs

# 3) 重新生成便携 zip（本机使用 electron-winstaller 自带的 7z-x64.exe；
#    不同压缩工具/级别会得到不同 SHA256，正式分发的哈希以第 1 节为准）
$sevenZip = (Resolve-Path 'node_modules/.pnpm/electron-winstaller@5.4.4/node_modules/electron-winstaller/vendor/7z-x64.exe').Path
Push-Location apps\desktop\out
& $sevenZip a -tzip -mx=5 'dist\NuanbanDemo-0.1.0-win32-x64-portable-20261024-r29.zip' 'NuanbanDemo-win32-x64'
Pop-Location

# 4) 校验
(Get-FileHash 'apps\desktop\out\dist\NuanbanDemo-0.1.0-win32-x64-portable-20261024-r29.zip' -Algorithm SHA256).Hash
node scripts/check-d03-candidate.mjs
```

> 本文件记录的是 2026-10-22 这一次构建的产物；重新构建后路径/大小/哈希都会变化，需要重新生成 `SHA256SUMS.txt` 与本说明。若产物内容或版本变化，本文件的“未签名、未真机验收、不是正式发布”结论必须重新评估。

## 10. Android 构建产物（冻结版：2026-10-23 21:24 线上发布，debug 包）

> 冻结版为 **2026-10-23 21:24 通过一次性上传通道发布到试验服务器的那一对**（从 HEAD `9dfa22e` 干净构建）；下表大小与哈希记录的是**线上实际文件**。**debug 签名、未做 release 签名、未做真机验收**。此前 21:10 发布的一对（`5ae96273…` / `1428ceb8…`）不含已提交的 WebView 宿主修复（文件选择器/TTS），已被本版取代。

| 产物 | 绝对路径 | 大小 | SHA256 | 变体 |
| --- | --- | --- | --- | --- |
| 普通客户端 `:app` | `apps\android\app\build\outputs\apk\debug\app-debug.apk` | 7,299,930 字节（6.962 MiB） | `1EDBB6B70FA5FE70BD69E41D2565D57AF1845116994D773A5A75916424F9517B` | debug，包名 `org.nuanban.assistant` |
| 独立桌宠宿主 `:standalone` | `apps\android\standalone\build\outputs\apk\debug\standalone-debug.apk` | 90,449,909 字节（86.260 MiB） | `0B5B0E3DAF440B27A9FB6B4E09A08C3006995555883718CE3E48AB9A0EA3449C` | debug，包名 `org.nuanban.assistant.standalone` |

- 构建来源（2026-10-23）：`node scripts/sync-android.mjs` 把 `apps/web/dist`（2026-10-23 20:54 构建，14 个文件，含 Lili/Lumi 资源）同步到 `app/src/main/assets/ui`；随后离线执行 `apps/android/check-standalone-packaging.ps1` 重编 `:app` 与 `:standalone` 并做打包隔离校验（`BUILD SUCCESSFUL in 39s`）。构建完成后未再改动 APK。
- 两者均通过 `apksigner verify`（v2 scheme）与 `zipalign -c 4`；签名证书为构建机 `~/.android/debug.keystore` 的 Android Debug 证书，不能用于正式分发。
- 共享 UI：构建时使用的 `assets/ui` 快照共 **14 个文件**（含 Lili/Lumi 资源；`index.html` 引用 `assets/index-BWNOxrR6.js`、`assets/index-CeTjnOdW.css`），已逐文件与同批 `apps/web/dist` 比对一致（0 缺失 / 0 多余 / 0 不一致），`onTarget`/`assets/ui` 与两包内嵌资源同源。
- **真机验收条件不具备**：无真机/模拟器连接，未安装、未抓屏、未录音、未调用云服务；通知、精确闹钟、悬浮窗、MediaProjection 前台服务、OCR/后台提醒均未验证。构建成功不等于真机可用。
- 距可发布仍缺：release 签名与 release 构建（无 signingConfigs/minify/AAB）、版本号仍为 demo/validation、商店政策与隐私合规、standalone 86.26 MiB 体积优化。
- 与桌面端相同：**不要把 APK 提交到 git**（`build/` 已被忽略）。2026-10-23 已通过一次性上传通道发布到 `http://59.110.19.225/downloads/nuanban-android-app-debug.apk` 与 `http://59.110.19.225/downloads/nuanban-android-standalone-debug.apk`，服务器端逐个校验 SHA256 一致。
- 打包隔离校验（`apps/android/check-standalone-packaging.ps1`）通过 **89/89**：普通包不含 `INTERNET`/悬浮窗/前台服务/采屏权限与 nativehost 类，独立包含全部相关权限与 6 个组件，独立包 39 个 OCR/人脸模型资产指纹与 `AndroidScreenPolicy.MODEL_FINGERPRINT` 一致，普通包不含桌宠形象资源、独立包含该资源，且不含自动 CCT 传输后端。
- **冻结说明**：本表冻结版为 2026-10-23 21:24 线上发布的一对（`1edbb6b7…` / `0b5b0e3d…`），由 HEAD `9dfa22e` 干净构建；21:10 旧对与 21:11 本地重编对均已作废，不得对外分发。
- `zipalign -c 4` 与 `apksigner verify` 对两个包均返回 0（v2 scheme，单一 debug 签名者）。
