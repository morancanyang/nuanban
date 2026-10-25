# 默认花环水獭桌宠与星云 SDK 接入

> 文档同步：2026-10-22。产品显示名称为**微光指引**；[当前功能与平台边界](product-current-state.md)统一说明现行入口、已实现范围和待验证能力。本文已有测试数字与生成日期仍只对应原批次，不因文档更新自动视为重新验收。

## 默认形象

独立桌宠的产品默认形象改为用户 2026-10-19 新截图中戴花环、穿叶裙的角色，产品内命名为“花环水獭”，标识为 `xingyun-floral-otter`，定义在 `apps/desktop/default-pet.json`。对应星云工作台应用 188337。只调整桌宠形象与功能页，不改变客户端页面布局。

- 启动即显示新角色的本地透明静态预览，不再默认显示旧猴子或小橘猫。预览直接从用户第二张截图旋转、裁切并去除背景，没有生成或伪造新的 3D 文件；旧猴子预览资产保留但不再作为默认入口引用。
- 预览图由用户提供的星云编辑器截图裁出，仅包含角色本体，已移除周围白色背景；不含浏览器、账户、接口凭证或编辑器界面。
- 静态预览不是 GLB/VRM/FBX 文件，不支持离线旋转、口型或实时 3D 动作。页面和悬浮形象明确标注显示模式。
- 本人手动启用星云服务并成功加载后，实时形象替换静态预览。停止、失败或断网后恢复本机形象；仅当本地预览资源损坏时，才使用原小橘猫应急。
- 保留已有用户原画、本地模型和选择，不因修改产品默认值删除或覆盖用户资产。

默认形象不等于默认同意联网计费。`autoConnect` 默认为 `false`；不自动连接或重连，不因展开面板创建会话。

## 新默认的应用切换

- 默认配置记录新应用的工作台编号 188337 和截图中可辨认的 App ID 前缀 `031ce3cd`，不记录 App Secret。前缀仅用于防止误用旧形象应用，不替代完整凭证或平台鉴权，也不能证明后台角色未发生变化。
- 服务端和桌宠页面均阻止不匹配的本机应用创建会话，显示“待切换至应用 · 188337”。即使勾选联网确认，也不会连接旧猴子应用。
- 初次切换时，本机加密配置仍属于旧应用，早期截图的凭证被反光遮住，因此没有猜填或发起新应用会话。2026-10-19 用户补充清晰截图后，已通过标准输入调用本机配置脚本，保存新应用的 Windows DPAPI 加密凭证；没有将密钥写入源代码、命令行参数或诊断产物。
- 需要在本机使用下述脚本录入新应用的完整 App ID，并在隐藏输入中填写密钥；不要把密钥写入代码、日志或聊天。保存后在结束当前工作及会话后重启宿主。
- 新截图显示工作台应用 188337 处于“已连接”状态，但这不等于本产品已经完成新应用的真实渲染验收。旧猴子应用的 1008 记录不能直接套用于新应用。

## 实时对话模式（星云原生链路，2026-10-24 新增）

所有者已选 A：星云 ASR + 星云 Brain + 星云 TTS + 口型。该模式是独立的显式入口，默认关闭；不开启时与既能行为完全一致（`setVolume(0)`、不调用 ASR/ask、不开麦）。

### 两种模式的差异

| | render（默认） | conversation（实时对话） |
| --- | --- | --- |
| 触发 | “启用花环水獭”+ 联网确认勾选 | “开启实时对话”+ 原生确认框 |
| 网关 request_id | 沿用，一次授权一次 POST | 同左 |
| `features` | `auto_send_asr_to_llm: false`、`speech_frontend: { enabled: false }` | `auto_send_asr_to_llm: true`、`speech_frontend: { enabled: true, enable_aec: false }` |
| SDK 入口 | `import('@xmov/avatar')` → 基类 `XmovAvatar` | `import('@xmov/avatar/agent')` → `XingyunAvatarAgent` |
| 实时通道（E2E） | 不使用；不建立 `wss://e2emp.xingyun3d.com` 会话 | 建立并使用 E2E 会话（ASR/Brain/TTS） |
| `session_speak_req_id` / `config` | `1` / 固定版本号 + 页面布尔 `raw_audio` | 同左 |
| 麦克风 | 不开麦，`audio.inputEnabled: false` | 本人在场确认后开麦，`audio.inputEnabled: true` |
| 输出音量 | `setVolume(0)` | `setVolume(1)` |
| 音频与提问去向 | 不出本机 | 交给星云（ASR + Brain + TTS），按其平台规则计费 |

页面传入的 `features`、`asr_id`/`llm_id`/`tts_config`/`brain_config`/`extras`、`gateway_type`、`session_speak_req_id`、任意 URL 与未知键都不透传；主进程仍按白名单重建，`config.raw_audio` 仍必须是布尔值，否则在联网前拒绝。响应中的 `data.e2e_resp`（含 `ws_url`/`e2e_token`）按原样经 `exchange` 回给页面，无需额外代理。

**为什么对话模式必须 `enable_aec: false`（2026-10-24 实测，未修复项）**：桌宠窗口用 `file://` 加载，页面的 blob URL 源是不透明源（`blob:file:///…`）。Chromium 拒绝为这种源加载 AudioWorklet 模块，实测在真实桌宠页面上报：

```text
Loading the script 'blob:file:///<id>' violates the following Content Security Policy directive: "script-src 'self'"…
Failed to load worklet module script: blob:file:///<id> (CORS or access check error)
```

即 AEC 所需的 worklet 在两个层面都不可用（CSP 未放行 `blob:` 脚本 + 不透明源自身的访问检查）。本次不改 CSP（放行 `blob:` 会扩大脚本白名单），而是按平台支持的 `enable_aec: false` 建会话；星云平台尊重该值（实测回包 `speech_frontend: { enabled: true, enable_aec: false }`，`error_code 0`），麦克风上行仍走 MediaRecorder/MSE（Electron 下 `raw_audio` 为 `false`，不需要 worklet）。**要有 AEC 的后续项（未做）**：把桌宠窗口从 `file://` 换成自定义协议或本地 http 源，使 blob URL 具备可用的源，再重新评估 `enable_aec: true`；在那之前不得声称支持回声消除。

### 用户操作与确认

桌宠功能小屋 →“实时对话 · 星云原生”，或形象页内的“开启实时对话”。点击后先弹出**原生确认框**（主进程 `dialog.showMessageBox`，默认按钮为“取消”），写明：麦克风音频会上传星云做识别、提问由星云模型回答、语音由星云合成、按星云平台规则计费、停止即结束会话、不自动重连。只有本人选择“开启实时对话”后，主进程才创建会话并放行麦克风；取消则麦克风保持关闭。

对话中显示聆听/思考/说话状态、识别文字与回答，并提供“暂停聆听/继续聆听”“打断说话”。点击“停止实时对话”即结束本次会话并确认星云会话关闭；不自动重连，下次启动不会自动恢复。识别文字与回答只通过页面事件 `nuanban:avatar-conversation` 暴露，控制事件为 `nuanban:avatar-conversation-command`（`start-asr`/`stop-asr`/`interrupt`）。

### 麦克风权限边界

- 默认会话仍是默认拒绝：`main.cjs` 安装 `xingyun-permission-guard.cjs` 的闸门，对非桌宠窗口、非 `media` 权限、`media` 中的视频请求一律拒绝，屏幕采集始终拒绝；不存在全局放开。
- 放行需同时满足：`permission === 'media'`、`webContents` 就是开启对话时的桌宠窗口、页面 URL 与会话开启时一致、主 frame、媒体类型只含音频/未知，且**运行时“本人已开启对话”标志为真**。`setPermissionCheckHandler` 与 `setPermissionRequestHandler` 用同一谓词判定。
- 该标志与会话代次绑定：停止、失败、销毁、关闭窗口或退出时立即撤销；停止后迟到的权限请求一律拒绝（防“停止后仍被开麦”）。
- 渲染端销毁路径先 `stopASR()` 再 `destroy()`，所有 SDK 回调按 generation 丢弃迟到结果。

### 失败分级与取证方式

现场只看到“花环水獭资源或连接加载失败，已恢复本机桌宠；请检查网络后手动重试。”时无法判断失败在哪一环，因此把失败拆成**阶段 + 真实原因**并落盘取证。设计目标：现场不必再猜，也不需要复现会话。

**失败阶段**（`apps/desktop/xingyun-renderer.js` 的 `FAILURE_STAGES`）与上屏文案：

| 阶段 | 含义 | 判定来源 | 状态文案 |
| --- | --- | --- | --- |
| `session` | 会话建立（`begin`/`exchange`/`bridge.ready` 被拒） | `bridge.begin` 抛错、`ready()` 的 Promise 被拒 | “会话建立：…”，接管为 `load_failed` |
| `resource` | 形象资源下载/初始化（SDK `init()`） | `init()` 抛错、动态 `import`/实例化抛错 | “形象资源：…” |
| `realtime` | 实时通道（socket/agent/E2E） | SDK `onMessage`/`onError`、`onSocketStateChange`、`onAgentStateChange`、网络离线 | “实时通道：code=… / socket=… / agent=…” |
| `render` | 形象渲染未发生（`onRenderChange` 未到） | 120s 兜底计时器 | “等待超时：等待形象就绪超过 120 秒” |
| `permission` | 麦克风开启失败（`startASR`） | `startASR()` 抛错 | “麦克风权限：…”（对话状态栏） |

原因文本取自 SDK 原始错误的 `code`/`message`/`error_reason`（`errorReason()` 兼容多版本字段），经 `cleanReason()` 截断到 200 字并脱敏，再随 `bridge.fail(lease, kind, detail)` 交主进程；主进程用 `sanitizeReason()` + `redactSecret()` **二次脱敏**后并入状态文案。失败时仍沿用既有语义：销毁本机实例、`DELETE` 确认远端会话关闭、不自动重连。

**取证日志**：`app.getPath('userData')/avatar-trace.log`（`createAvatarTraceLog`）。

- 写入者：preload 捕获的页面 `error`/`unhandledrejection`（经受限 IPC `nuanban:avatar:trace`）、渲染端显式上报的阶段（`bridge.trace`）、主进程捕获的 `console-message`（含 CSP 违规原文）、`render-process-gone`、以及会话状态每次变化（`phase=… mode=… conversation=… message=…`）。
- 形状受限：只接受 `kind`（白名单 `stage`/`error`/`unhandledrejection`/`console`/`renderer-gone`/`preload`/`load`）、`message`（≤500 字）、`source`（≤160 字）、`line`；其余字段一律丢弃。IPC 只注册 `nuanban:avatar:trace` 一个通道，且只接受真实桌宠窗口（`trusted(event, petWindow, petPath)`）。
- 大小上限 256 KiB；超限时保留最新的一半（按行截断），不会无限增长。
- 脱敏：`token`/`secret`/`appSecret`/`authorization`/`lease`/`signature`/`session_id`/`request_id` 赋值、UUID、≥32 位长标识、URL 一律替换为 `[已隐藏]`/`[标识已隐藏]`/`[地址已隐藏]`；App Secret 另做整串替换。**永不写入 token、密钥、租约与会话标识**，由 `tests/platform/desktop-xingyun-diagnostics.test.ts` 断言。
- 日志只在本机，不上传；排查时读取该文件即可看到失败阶段、SDK 原始错误与 CSP/网络原文。

### 未验证

- 真实会话只在本机隐藏窗口装置里跑过：render 1 次、conversation 1 次（外加修复前各 1 次诊断），均有 `session_id` 与 `DELETE` 结果记录；**没有真机开麦验收**，`wss://e2emp.xingyun3d.com` 的实际音频链路、口型同步与计费口径未验证。
- 对话模式在 `enable_aec: false` 下的音质/回声表现未验证（见上文，AEC 是未做项）。
- 桌面窗口可见、系统/驱动拒绝麦克风、代理或杀软拦截长连接等现场条件未覆盖；这些失败会按上表分级并落入 `avatar-trace.log`，但尚未在真实故障机上验证过分级准确性。

## 使用与配置

桌宠右键 → “星云花环水獭 · 3D 形象”，或功能小屋 → “默认花环水獭 · 3D”，进入专属页面。本机应用匹配后，确认联网服务说明并点击“启用花环水獭”。使用页面按钮或右键“停止星云形象（恢复本机桌宠）”结束服务。收起面板不代表远端会话停止。同一页面还提供“开启实时对话”入口，必须经原生确认框同意后才会开麦并把音频与提问交给星云，详见上文“实时对话模式”。

根目录执行以下命令并替换 App ID；App Secret 通过隐藏输入获取，不作为命令行参数：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/configure-xingyun-avatar.ps1 -AppId "替换为你的AppId"
pnpm desktop:avatar:build
```

凭证以 Windows DPAPI CurrentUser 加密保存到 `%LOCALAPPDATA%/Nuanban/xingyun-avatar.json`，不存入仓库或前端。更换配置后，在保存工作后重启微光指引生效；不会自动重启正在使用的进程。公开分发前，应独立确定应用权限、额度及角色素材使用授权，不应把开发者长期 App Secret 打包给其他用户。

## 安全与生命周期

- 使用锁定的 `@xmov/avatar@2.4.1`，SDK 预打包进桌宠 `avatar-runtime`，不依赖浮动 CDN。
- 页面只得到 App ID、一次性授权和短期会话信息。真实 App Secret 只由主进程解密与代签。
- 仅代签固定星云 HTTPS 会话接口的 POST/DELETE；不提供任意 URL 代理或签名接口，不透传页面传入的截图、问题、ASR 或 Brain 配置。
- 使用 `/user/v1/ttsa_v2/session`，不额外添加 `tag`；只接收 SDK 检测得到的布尔型 `config.raw_audio`，不覆盖为固定格式。该字段只用于输出音频格式协商，不代表麦克风授权；缺失或非布尔值在联网前拒绝，其他配置仍由主进程白名单重建。
- 签名遵循官方 SDK 的 Unicode 码点递归排序、非 ASCII JSON 转义和 MD5 算法。
- 每次显式授权最多一次 POST。Agent 重连关闭，旧授权及重复 POST 被主进程拒绝；失败只能重新确认后手动重试。
- **按模式选 SDK 类（2026-10-24 修复回归）**：render 模式只 `import('@xmov/avatar')` 用基类 `XmovAvatar`，不实例化 `XingyunAvatarAgent`，因而不建立 Agent 的 E2E/ASR/Brain 管线，实时通道抖动或 E2E 握手失败不会把仅形象会话判为失败；conversation 模式才用 `XingyunAvatarAgent`（`agentCallbacks` 只在对话模式存在）。render 模式不调用 `startASR` 或 `ask`；输入音频、自动 ASR→LLM、Sentry 上报关闭，`setVolume(0)`。原有问答与语音使用原来的独立权限和服务。两种模式互斥，默认仍是 render。
- 会话会收发 SDK 必需的设备/性能信息、资源及控制数据；不是完全离线服务。
- 仅桌宠 CSP 允许星云资源及实际会话返回的固定资源域名 `https://public-xmov.oss-cn-hangzhou.aliyuncs.com`；该 OSS 域名只加入图片、连接和媒体白名单，不允许任意 OSS 域名、远程脚本或 `unsafe-eval`。HTML 元策略与主进程响应头策略一致，客户端 CSP 不放宽，客户端 preload 不暴露会话桥接。
- 关闭、退出、Renderer 故障及全局停止均清理远端会话。在途创建先等待返回，再以 request/session ID 关闭，防止孤儿会话。停止失败如实提示并阻止新会话。

## 验证边界

### 真实动作与静态预览

本地 PNG 预览及其 CSS 轻摇不包含星云应用的动作资源。重启后默认不联网，因此不能把静态预览没有动作判断为后台动作被删除。本人启用实时 3D 后，仍由当前应用返回完整资源包和配置；集成不调用后台动作编辑或删除接口。

渲染端使用已安装 `@xmov/avatar@2.4.1` 的公开 API。SDK 自己在会话启动时进入交互待机状态，因此初始化完成后不额外覆盖它；单击角色调用 `interactiveidle()`，拖动结束不触发互动。独立 3D 功能页还提供 `idle()`、`interactiveidle()`、`listen()`、`think()` 四个状态入口，只有会话 `ready` 才能操作。它们是 SDK 状态，不是虚构的自定义动作名称；具体动画仍取决于平台当前已发布的角色配置，`listen()` 不调用 `startASR()` 或请求麦克风。失败或停止后不创建新会话，不自动重连。没有用 CSS 代替云端骨骼动作，也没有把页面切换或普通拖动接成联网授权。

```powershell
pnpm exec vitest run tests/platform/desktop-xingyun-avatar.test.ts
$env:PLAYWRIGHT_CHANNEL='msedge'
pnpm exec playwright test --config tests/helpers/desktop-pet-playwright.config.ts desktop-pet-avatar.spec.ts
node scripts/test-xingyun-avatar.mjs
node scripts/test-xingyun-avatar.mjs --simulate
```

专项检查覆盖默认花环水獭、新默认资源与页面一致性、旧应用禁止创建会话、签名与权限、密钥隔离、重复请求、取消、停止失败、退出、独立页面、零尺寸保护、形象互斥、迟到初始化，以及客户端导航和草稿不被影响。`--simulate` 仅在隔离测试宿主注入合成凭证与错误响应，不连接星云，不是产品实现的替身。

2026-10-19 新默认回归：形象单测 31 项通过，400×760 与 330×520 的界面回归合计 10 项通过，`pnpm desktop:avatar:build` 成功。合成会话桌面冒烟报告位于 `.cache/xingyun-avatar-check-1792378612800/report.json`，只验证合成错误的单次请求及清理；实际本机配置的离线桌面冒烟报告位于 `.cache/xingyun-avatar-check-1792378616521/report.json`，确认新角色预览可见、旧应用被拦截、零会话请求、客户端草稿与导航未变。两者都不是新应用的实时 3D 成功证据。

只有显式传入 `--live` 才创建真实会话，可能消耗平台额度。结束前请求 DELETE。产物保存在 `.cache/xingyun-avatar-check-*/`；记录脱敏状态，不记录 App Secret 或短期会话令牌。

## 新应用真实 3D 验证（2026-10-19）

- 新凭证首次实测，POST 已返回 HTTP 200、业务码 0 及真实 `resource_pack`，没有出现旧应用的 1008；但本机 CSP 遗漏官方资源包引用的 `public-xmov.oss-cn-hangzhou.aliyuncs.com`，导致资源加载失败。一次 POST 后以一次 DELETE 成功释放会话，记录在 `.cache/xingyun-avatar-check-1792379675214/report.json`。
- 补充这个固定资源域名后，手动执行第二次独立验证，成功加载真实形象并进入 `ready`，检查可见 Canvas，并人工查看透明桌宠截图。不是静态图或合成 SDK 验证。报告在 `.cache/xingyun-avatar-check-1792379963442/report.json`，画面在同目录 `live-desktop-pet.png`。
- 第二次验证同样只有一次 POST、一次 DELETE，均返回业务码 0；无失败的资源请求、无页面异常、无抓屏、无麦克风、无自动重连，独立测试客户端的路由与草稿保持不变。两次均由开发者显式发起，未自动循环尝试。
- SDK 存在被 CSP 阻止的 `eval` 能力探测，真实形象仍成功渲染；未因此开启 `unsafe-eval` 或远程脚本。诊断只记录失败请求域名、资源类型、标准网络错误及 CSP 指令，不记录带令牌的完整 URL。
- 测试会话已关闭，成功验证不代表现有产品进程一直联网。正在使用的旧进程未被强制重启；保存工作并退出重开后，桌宠右键进入专属 3D 页面，确认本次联网再启用。未测试麦克风、自动问答、语音口型或其他业务功能，不把形象验收扩大为全功能验收。

## 直接拖动与真实动作回归（2026-10-19）

- 真实用户配置下复现了远程注入的页面指针位置与系统鼠标位置不一致，旧实现因此拒绝开始拖动。修复后使用受信桌宠窗口的有限指针坐标，并保留起点窗口范围校验、工作区约束与无坐标旧请求的系统光标兜底。实机记录位于 `.cache/real-pet-drag-1792402424711/report.json`：远程注入准确移动 `(-65, -35)`，三轮原生鼠标拖动均准确移动 `(-80, -40)`，尺寸不变。
- 使用真实 SDK 和本机加密配置完成一次实时动作验证：待机、互动待机、聆听、思考四种状态均发送到实际 WebSocket，收到 7 个动作数据包与 60 个二进制数据包，四次形象截图哈希各不相同。报告位于 `.cache/xingyun-avatar-check-1792402233347/report.json`，透明桌宠截图位于同目录 `live-desktop-pet.png`。这验证了真实状态切换和动态渲染，不等于逐一验收后台所有自定义动作或未发布的编辑器配置。
- 本次真实验证只有一次 POST、一次 DELETE，均为 HTTP 200、业务码 0，测试会话已正常释放；无自动重连、麦克风或屏幕采集。重开产品仍为本地预览，必须本人在独立 3D 页面确认后启用，不因测试成功而静默恢复计费会话。
- 桌宠界面两种视口回归共 20 项通过，相关平台测试 248 项通过，类型检查和形象构建通过。动作入口只放在桌宠独立 3D 页面，普通悬浮态和管理客户端界面不增加控制项。

## 实时对话的实现验证（2026-10-24，无真实会话）

- 单测：`pnpm exec vitest run tests/platform/desktop-xingyun-avatar.test.ts tests/platform/desktop-xingyun-conversation.test.ts tests/platform/desktop-management-voice.test.ts` → 31 + 16 + 19 = 66 项通过；相关桌宠宿主与页面回归 `desktop-standalone-host.test.ts`（79）、`desktop-pet-ui.test.ts`（203）一并通过。
- 页面功能回归（合成 SDK 与假桥，不联网、不启真麦）：`$env:PLAYWRIGHT_CHANNEL='msedge'; pnpm exec playwright test --config tests/helpers/desktop-pet-playwright.config.ts desktop-pet-avatar.spec.ts` → 26 项通过（13 用例 × 400×760 / 330×520 两种视口）。新增 3 项实时对话用例：原生确认取消后不开会话、不开麦；确认后 `setVolume(1)`、`audio.inputEnabled: true`、`startASR` 一次、状态机日志出现 `listening→speaking`、识别文字与回答上屏、停止后 `stopASR` 与 `destroy` 各一次；停止后迟到的 ASR/回答/断线回调被 generation 丢弃。
- 权限闸门单测覆盖：未开启对话全拒、只放行 `media` 音频、必须同一桌宠窗口与同一页面、`isMainFrame`/`requestingUrl`/视频/子框架被拒、停止后立即失效、迟到撤销不会注销新会话、屏幕采集始终拒绝。
- `pnpm exec tsc --noEmit` 退出码 0；`pnpm desktop:avatar:build` 成功。
- **未执行**：任何真实星云会话（额度/计费）、真实麦克风开麦、打包后的 Electron 桌面运行。上述结果全部是合成/本地验证，不构成实时对话的真机验收。

## 真实 Electron 复现与修复（2026-10-24，含真实会话）

现场（r27，用户机）在“启用花环水獭”与“实时对话”都看到 `load_failed` 兜底文案。用隐藏窗口装置（复用真实 `pet.html` + `pet-preload.cjs` + `avatar-runtime` 构建产物，真实 `createXingyunAvatarService` 与 DPAPI 凭证，真实 CSP）复现，结论如下。

- **未能复现现场 `load_failed`**：本机装置里 render 与 conversation **都**能走到 `phase: ready`（含资源下载、WebSocket、`bridge.ready` 被接受），因此现场原因仍未确认，不能声称已定位。已改用“失败可诊断”保证下次现场可取证（见“失败分级与取证方式”）。
- **确证的独立缺陷 1（worklet/AEC）**：对话模式在真实 `file://` 页面加载 blob AudioWorklet 被拦（CSP `script-src 'self'` + 不透明源访问检查），已改为 `enable_aec: false`；平台回包确认 `enable_aec: false`，会话 `error_code 0` 并就绪。
- **确证的独立缺陷 2（仅形象的实时通道耦合）**：修复前 render 也实例化 `XingyunAvatarAgent`，会连带建立 `wss://e2emp.xingyun3d.com` E2E 会话，任一实时通道异常都会走 `fail('load_failed')`；修复后 render 只用基类 `XmovAvatar`，装置里 render 会话只建立 `ttsa-gateway-lite` 一条 WebSocket，不再依赖 E2E 通道。
- **副作用修复**：修复前 render 的 `DELETE` 被平台以 `error_code: 1`（`ttsa request error: 无效的session`）拒绝，界面误报“星云未确认会话关闭（cleanup_failed）”；修复后同流程 `DELETE` 返回 `error_code: 0`，`stopped: true`。
- 真实会话共 4 次，全部发出 `DELETE`：修复前 conversation `6061-ba2e…`（`error_code 0`）、修复前 render `13081-499e…`（`error_code 1`，复验 `DELETE` 返回“无效的session”，确认已关闭）、修复后 render `22272-8586…`（`error_code 0`）、修复后 conversation `22872-c187…`（`error_code 0`）。
- 装置证据（脱敏 JSON）保存在 `.cache/avatar-load-repro/out-*/report.json` 与 `run.log`；装置脚本在 `.cache/avatar-load-repro/`（`electron.exe .cache/avatar-load-repro --conversation-only --attempts=1` 可重跑，注意先清除 `ELECTRON_RUN_AS_NODE`）。
- 测试：`tests/platform/desktop-xingyun-*` 60 项通过；`pnpm typecheck` 0；`desktop-pet-avatar.spec.ts`（合成 SDK，msedge）28 项通过。
- **未验证**：现场故障机本身；可见窗口/真机开麦；代理、杀软或显卡驱动差异导致的失败仍未归因。

## 失效系统代理的应用内回退（2026-10-25，`deviceVerified=false`）

现场故障：启用花环水獭报“资源或连接加载失败…失败阶段与原因：**实时通道：code=10002 Error: socket连接失败**”（render 模式）。实测根因是用户系统配了**已停止的代理**（`ProxyEnable=1`、`ProxyServer=127.0.0.1:6518`，该端口无进程监听、连接被拒）；Chromium 默认遵循系统代理，于是星云会话与实时通道全部发往死代理 → SDK 报 10002。对照验证：Node 直连 `e2emp.xingyun3d.com` / `nebula-agent.xingyun3d.com` 的 TLS 正常（TLSv1.3、证书有效、145~166ms），DNS 正常 → 星云服务无问题。

**回退策略（应用内、只影响承载形象的 session，绝不改用户系统设置）**

1. 发会话 POST **之前**，用 Electron 自己的 `session.resolveProxy(GATEWAY)` 读出该地址实际会用的代理（**不读注册表、不写注册表**）；返回 `DIRECT` 或无法解析时保持系统设置不动。
2. 解析到 `host:port` 后，对该端口做一次**极短超时（默认 300ms）的 TCP 探测**：只有确认为不可达（连接被拒 / 超时 / 解析失败）才继续。
3. 确认不可达 → 仅对承载形象的 session（桌宠窗口的 session，实时通道 WS 与资源下载同源）调用 `session.setProxy({ mode: 'direct' })`，本次会话改走直连；其他网络功能不受影响（切换只作用于该 session，且在会话结束时恢复）。
4. 直连后**仍然失败**（POST 失败，或渲染端后来报实时通道失败）→ 立刻 `session.setProxy({ mode: 'system' })` 恢复系统设置，并在失败文案里如实说明"直连仍失败，已恢复系统代理设置"。会话正常停止、退出（`dispose`）也恢复 system。
5. 代理可达、未配置代理、`resolveProxy` 抛错、`setProxy` 失败等一切无法判定或无法切换的情况**保持 system**（fail closed，不做任何改动）。

**失败文案**（沿用既有 `fail(kind, detail)` 链路与 `avatar-trace.log`）：

```text
花环水獭资源或连接加载失败，已恢复本机桌宠；请检查网络后手动重试。失败阶段与原因：实时通道：code=10002 socket连接失败。检测到系统代理 127.0.0.1:6518 无法连接（可能已停止）；可启动代理软件或在系统设置里关闭代理后重试；已自动改为直连尝试。直连仍失败，已恢复系统代理设置。
```

trace 只记录 `avatar_proxy{state: reachable|unreachable_direct|direct_unavailable, label, outcome}`（host:port 与探测结果），不含密钥、令牌、会话标识。

**安全语义不变**：不修改注册表或系统代理设置、不涉及 `netsh`/`reg`；仍然一次授权一次 POST、不自动重连；探测与切换都是本地行为，不抓屏、不外发任何额外信息；切换只使用 `direct`/`system` 两种模式，不注入自定义 `proxyRules` 或 PAC。

**测试**：`tests/platform/desktop-xingyun-proxy-fallback.test.ts`（13 项，假 session/假探针，不碰真实网络）：代理可达→system 且不调用 `setProxy`；未配代理→连探针都不调用、行为与今天一致；代理被拒→只切 direct 且文案含“检测到系统代理 … 无法连接 / 已自动改为直连尝试”；直连仍失败→如实报错并恢复 system、一次会话仍只发一次 POST；正常停止也恢复 system；`resolveProxy` 抛错/切换失败/未注入端口一律保持 system；静态断言无注册表写入、无抓屏 API、切换只允许 direct/system。相关 5 个套件共 **161 项通过**，`pnpm typecheck` 0。

**未验证（`deviceVerified=false`）**：真机需所有者复测：(a) 关闭失效代理后点“启用花环水獭”应能连上；(b) 若重新启动代理软件，应仍走代理且正常（探测到端口可达 → 不改设置）；(c) 用一个“配置了但没启动”的代理复现时，应看到自动直连提示且能连上。本轮只有假 session/假探针的合成测试，没有真机代理环境；宿主层的实际 `setProxy` 生效范围（桌宠窗口 session）与主进程 `fetch` 是否共用该代理设置未在本机实测。

## 旧猴子应用历史记录

旧猴子应用的 2026-10-18 真实接口记录返回 `1008`：`ttsa request error: 请求参数不完整,请检查传入参数(如角色、音色等)`，未获得 `resource_pack`；随后 DELETE 返回 `error_code: 0`。用户此前提供的配置截图已显示角色“小猴子”、音色“运动男孩”、自动保存，不能再仅凭此错误认定角色或音色未选择、未保存。2026-10-19 重新核对旧调试截图发现页面显示“重新连接”、输入框和“提问”按钮不可用；对应公开工作台源码的未连接预览分支，不能将画面中存在猴子认定为内部会话连接成功。顶部自动连接说明不是实时连接成功状态。这些历史证据不代表新花环水獭应用的调用结果。

2026-10-19 修正本地请求重建时额外添加 `tag` 和强制 `raw_audio: false` 的偏差，并通过合成会话检查 SDK 音频格式传递、一次授权一次 POST、1008 失败后 DELETE 清理及不重连。这是本地协议对齐，不证明上述偏差就是 1008 的唯一根因，也不等于真实 3D 已验收。

同日，用户明确要求直接调用后，使用本机 DPAPI 加密配置执行了一次 `node scripts/test-xingyun-avatar.mjs --live`。修正后的请求没有额外 `tag`，`raw_audio` 与 SDK 检测结果一致；真实接口 HTTP 200，但业务错误仍为 `1008`，未返回 `resource_pack`。总计一次 POST、一次 DELETE，DELETE 返回 `error_code: 0`；没有自动重连、抓屏或启用麦克风，客户端导航及草稿检查通过。脱敏报告保存在 `.cache/xingyun-avatar-check-1792367970070/report.json`。此次实测未解决 1008，也未完成真实 3D 验收，后续排查不能把上述本地协议偏差认定为已确认根因。

本地 App ID 与此前实际请求及用户的 SDK 接入截图一致。进一步以合成凭证直接运行已锁定的 `@xmov/avatar@2.4.1` 原始请求构造及签名函数，离线对比了两种布尔音频格式的请求体与签名，以及 Unicode POST 和 DELETE 签名，结果一致；没有读取明文密钥，也没有增加云端会话。该检查不验证后台保存结果、应用授权、额度或密钥是否仍有效，详见 `docs/implementation/xingyun-avatar-1008-diagnostic.md`。

此前在聊天或截图中展示过的 App Secret 仍建议在星云后台轮换，再通过本机配置脚本的隐藏输入保存；后续真实测试应使用轮换后的凭证并重新取得授权。旧猴子应用如需恢复，可向星云平台反馈“外部 `ttsa_v2/session` 返回 1008，已有后台调试截图同样处于未连接状态”，请平台核查旧应用保存的角色/音色/表演配置、调用权限及参数兼容性。不要再将“内部调试正常”作为已确认前提，也不要在反馈或日志中包含密钥、短期令牌或原始资源包。旧应用的历史失败不影响上述新应用真实渲染结论；新应用的语音口型及业务动作仍未验收。
