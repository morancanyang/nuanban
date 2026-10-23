# 微光指引 · Android Kotlin 普通管理包与隔离独立桌宠

> 文档同步：2026-10-22。产品显示名称为**微光指引**；[当前功能与平台边界](../../docs/implementation/product-current-state.md)统一说明现行入口、已实现范围和待验证能力。本文已有测试数字与生成日期仍只对应原批次，不因文档更新自动视为重新验收。

## 当前 Android 范围（2026-10-22）

产品显示名称为微光指引，普通管理包、独立桌宠包与原生隔离实验仍保留各自包 ID、存储和授权边界。Android 有原生桌宠、捕获及桥接源码，不据此承诺已具备 Windows 的所有语音、单帧 AI 或桌面图标定位能力；应逐项核对独立运行时和设备实测。Debug 编译、JVM 或浏览器通过都不等于真机授权、后台通知或跨应用浮层通过。

共享 Web 管理页在手机浏览器或未装配 Windows 桌面桥的 WebView 中，桌宠入口会在当前页面显示“页面陪伴伙伴”。这不是 Android 系统悬浮窗，也不会替换系统桌宠、申请屏幕/麦克风权限或上传角色资源；需要系统级浮层时，使用独立 `:standalone` 原生包并按设备权限与真机记录验收。浏览器移动视口测试只证明页面交互，不证明 Android 原生桌宠能力。

先在根目录执行 pnpm android:sync，把共享 UI 复制到 app/src/main/assets/ui。

使用 Android Studio 打开本目录，配置 JDK 17 和 Android SDK 36。普通包明确构建 `gradlew.bat :app:assembleDebug`；独立桌宠必须显式构建 `gradlew.bat :standalone:assembleDebug`。不要以无模块前缀的 `assembleDebug` 区分权限边界。最低 Android 26 是待评审候选，不是已验证支持范围。

普通 `:app` 保持 `org.nuanban.assistant`、`MainActivity` 启动入口，以及仅通知/精确闹钟权限。它不声明采集/浮层/前台服务权限，也不编译桌宠与捕获实现。独立 `:standalone` 使用 `org.nuanban.assistant.standalone`、独立 Manifest 和 `app/src/standalone/java` 源集，显式构建才产出含悬浮窗与 `specialUse` / `mediaProjection` 服务的独立调试包；不会通过普通包升级增加这些权限。两个模块复用共享管理/提醒源码，但普通包只使用 `app/src/normal/java` 的不可采集宿主。

独立包默认入口为原生 `PetControlActivity`；本人显式启动后由 `PetRuntimeService` 持有桌宠、小输入面板和停止通知，关闭管理页不退出桌宠。默认不抓屏、不录音、不自动申请权限。已接随包 OCR/人脸模型的校验、同帧本地检测/脱敏、独立当次云同意、加密设备会话、真实按需分析客户端和只读教学浮层；模型未就绪、未知/敏感画面或授权不足仍封闭。真实设备/供应、软件覆盖、离线唤醒与完整学习闭环尚未验收，不宣称任意软件可用。详细边界见 [独立桌宠实现说明](standalone-runtime.md)。

共享 JS 的 `nuanbanBridge` 仍只在 appassets HTTPS 主框架启用，使用 `ActiveBridgeRequest` 严格白名单接收提醒、能力查询和旧管理停止；不允许 WebView 直接捕获或申请原生观察。管理暂停/销毁不再等同设备锁屏/进程终止，旧 `stop_all` 不能影响独立桌宠会话或谎报全局清理；真实停止由桌宠面板/原生控制页/通知完成。提醒仍只接受受限字段、应用内深链和非敏感 payload，Room 在单线程 executor 处理。

Android 源集包含 packages/contracts/kotlin 下生成的强类型 DTO 与校验器。根目录执行 `pnpm contracts:generate` 后，用 `pnpm contracts:kotlin:check` 跑 118 定义的 7,631 组 JVM/Ajv 对照及 28 组活动桥对照。真实 WebView/设备尚未运行验收；Chrome 合成通道、JVM 通过或 DEX 存在契约类都不是 NV 设备通过证据。

正常演示包已接入 Room 2.8.5 本地提醒实体/DAO/3 版迁移和事务仓储，并通过受限 WebView 桥接排程、取消和到期提交；到期状态先幂等认领，通知回调写入 `delivered`，点击携带随机一次性令牌并同时校验账号、实例、深链和已投递状态后才写入 `opened`，重复或外部伪造 Intent 不触发路由，Activity 销毁时避免后台 Room 操作与数据库关闭竞态。加入通知渠道、`POST_NOTIFICATIONS`、精确闹钟检查及保守拒绝适配器，但没有开机恢复。2026-10-16 使用本机 Android SDK 36 和 Gradle 构建 Debug APK；这只证明源码与 Room 代码生成可编译，没有设备安装、权限结果、后台投递或真机验收证据。详见 `docs/implementation/c07-c08-android-room.md`。

C01 的独立 `native-lab` 模块（`org.nuanban.nativelab`）保留为隔离实验，其 35 个捕获状态机用例、提醒策略和待执行设备记录仍见 [独立样例说明](native-lab/README.md)。本次 `app` 的原生桌宠适配不修改该实验模块，不把实验、JVM 或可编译结果记作 NV 真机通过。

根目录可执行 `pnpm android:build`，自动同步最新共享界面并构建 Debug APK。`pnpm android:build -Offline` 使用本机已缓存依赖。脚本优先使用 Android Studio 的 JBR，SDK 默认读取环境变量或本机标准目录；也可直接调用脚本传入 `-SdkRoot`、`-JavaHome`。

`pnpm android:room:check` 检查 Room 依赖、实体主键/索引、事务状态机、一次性点击令牌、迁移入口和通知拒绝路径，并在本机 Node SQLite 中预演 1→3 迁移；它记录 `roomMigrationPreflightVerified=true`，但仍保持 `deviceVerified=false`、`systemSchedulerVerified=false`，不安装 APK、不申请权限、不触发系统提醒。

普通输出：`app/build/outputs/apk/debug/app-debug.apk`；独立输出：`standalone/build/outputs/apk/debug/standalone-debug.apk`。两者均为调试包，不是签名发布版。`check-standalone-packaging.ps1` 离线编译两个模块并用本机 `aapt2` 与实际 APK DEX 检查权限、包名、启动入口、服务注册及代码隔离；`-SkipBuild` 仅检查已有产物。构建的 Kotlin DSL/SDK XML 弃用提示不构成真机通过证据。

## 2026-10-23 重新构建记录（共享 UI 更新后）

- 流程：`pnpm android:build -Offline`（内部 `pnpm build` + `node scripts/sync-android.mjs` → `apps/web/dist` 全量复制到 `app/src/main/assets/ui` → `:app:assembleDebug`）；随后 `apps/android/check-standalone-packaging.ps1` 同时构建 `:app` 与 `:standalone`。
- 产物：`app-debug.apk` 5,734,485 字节 `642d365d45c68b91a7793cbd93214d614631cc5b43db7d24375d82d0aab6fefc`；`standalone-debug.apk` 88,194,952 字节 `33b65a98f90e0e20324e5e10d8db53c1ffff9f47e0a276f7018e84e96ab3a27d`。
- 校验：两个 APK 内 `assets/ui/**` 12 个文件与同批 `apps/web/dist/**` 逐文件 SHA256 一致；打包隔离校验 87/87 通过；`zipalign -c 4` 与 `apksigner verify` 均通过（v2、debug 证书）。
- 边界：Android 端本次只更新了**共享 Web 界面**与重新出包。Windows 侧的连续共享、光标指引稳定性、模型网关图片缩放等改动属于 Electron 主进程实现，**不在 Android 端**；Android 自身能力（原生桌宠、采屏/悬浮窗、独立包本地 OCR/人脸与云出口）沿用原有实现，未在本次改动。仍为 debug 包、未做真机安装/权限/后台/悬浮窗验收，`deviceVerified=false`。

## 2026-10-23 独立桌宠形象修复（文字占位 → 角色静态形象）

- 问题：独立桌宠悬浮层此前用 `TextView` 显示“微光\n指引”四个字，没有角色形象；用户反馈“打开桌宠是微光指引四个字，没有建模”。普通管理包的页面陪伴入口不受影响。
- 修改：`PetRuntimeService.addBubble()` 改为 `ImageView` + 随包 `res/drawable-nodpi/nuanban_pet_preview.png`（400×560 透明 PNG，SHA256 `a0b637938f866d4bbc0a24ad1d9158d3bdd30139c123a76d8c4915ad422ed947`，取自 `apps/desktop/assets/xingyun-floral-otter-preview.png`，即产品默认花环水獭的本地静态预览）；保留拖动、单击打开原生面板、`FLAG_SECURE`、`filterTouchesWhenObscured`，轻摇动效遵守系统动画开关。资源放入独立源集 `app/src/standalone/res`，普通包不携带；打包校验新增 `normal_has_no_pet_preview_asset` 与 `standalone_has_pet_preview_asset`。
- 边界：这是**本地静态形象，不是实时 3D 建模**；不连接星云、不抓屏、不联网。实时 3D 形象仍只在 Windows 端实现；Android 端如要做实时 3D 需单独设计并做真机性能/触摸/浮层验收，本次未做。
- 模型说明：Android 管理页的文字模型仍未接入。服务端已配置文本供应商，但公共 HTTP 面只有 device-challenge/exchange/refresh，没有安全的账户/设备会话开通路径；把令牌打进 APK 的 JS 会违反既有安全边界（`infra/windows/README.md` 已记录）。本次没有伪造“模型已连接”，需要产品/安全决策后再做受控会话引导。
- 同步与构建：`node scripts/sync-android.mjs` 把最新 `apps/web/dist`（2026-10-23 20:54，含 Lili/Lumi 与页面陪伴改动，14 个文件）复制到 `app/src/main/assets/ui`；`apps/android/check-standalone-packaging.ps1` 离线重编**双包 BUILD SUCCESSFUL in 39s**，打包隔离 **89/89** 通过，`deviceVerified=false, captureExecuted=false, cloudExecuted=false`。
- 产物（debug，未签名发布版）：
  - `app/build/outputs/apk/debug/app-debug.apk`：7,570,810 字节（7.22 MiB），SHA256 `5AE9627325135EFB74281DAE8DDA2883C97355DAE924BE109E66AEC9817545F9`。
  - `standalone/build/outputs/apk/debug/standalone-debug.apk`：90,449,913 字节（86.26 MiB），SHA256 `1428CEB8C6A021D212B7789BFFB7E3E3897F465476AFBD1ED9249DB6B042E6DB`；包内 `res/drawable-nodpi-v4/nuanban_pet_preview.png` 存在，普通包不含该资源。
- 校验：两包均为 Android Debug v2 证书，`zipalign -c 4` 通过；39 个随包 OCR/人脸模型资产清单 SHA-256 仍为 `4f5fa874d4808f27f9afca0ccb6a69debc0f8ab67d59ece2981704f4a54224a6`（与运行时信任锚一致）。
- 未做：本机 `adb devices` 为空且没有可用 AVD，未安装运行、未申请悬浮窗/通知权限、未截图或真机验收；服务器下载目录中的旧 APK 需负责人确认后再重新上传，不能以本地重编声称线上已更新。

## 2026-10-23 WebView 宿主修复：图片选择器与系统 TTS（未解决的产品边界另列）

- 反馈与定位：“安卓端图片传不上去、语音功能无法使用”。实测代码根因是 `MainActivity` **没有设置 `WebChromeClient`**：聊天页的隐藏 `<input type="file">` 点“选图片”时不会弹出任何系统文件选择器（WebView 静默忽略），这是“图片传不上去”的直接原因；同一 WebView 也没有 `window.speechSynthesis`（Android WebView 不实现 Web Speech API），所以朗读/“再讲一遍”只能走“系统没有可用的语音播放”降级。
- 宿主修复（**零新增权限**，普通包权限仍只有 `POST_NOTIFICATIONS`/`SCHEDULE_EXACT_ALARM`）：
  - `MainActivity` 新增 `WebChromeClient.onShowFileChooser`：按 `acceptTypes` 用 `Intent.ACTION_GET_CONTENT` + `CATEGORY_OPENABLE` 打开系统文件选择器（图片时 `image/*`，支持多选），结果经 `WebChromeClient.FileChooserParams.parseResult` 回填；`onActivityResult`/`onDestroy` 释放未完成回调。`onPermissionRequest` 明确 `deny()`，网页内容不能直接申请相机/麦克风。
  - 系统 `TextToSpeech`（`zh-CN`，本地引擎）经 `addJavascriptInterface("nuanbanTts")` + `WebViewCompat.addDocumentStartJavaScript` 注入最小 `SpeechSynthesisUtterance`/`speechSynthesis` 垫片；原生 `UtteranceProgressListener` 驱动 `onend`/`onerror`，`cancel()` 调 `stop()`，`setSpeechRate` 映射语速。TTS 引擎缺失/中文语言不可用时 `speechSynthesis` 保持 `undefined`，网页继续显示“没有可用语音播放”的降级提示，不假装成功。TTS 仅本机朗读字幕，无网络、无麦克风。
  - 新增静态回归断言（`tests/platform/android-standalone-runtime.test.ts`）：要求文件选择器/TTS 垫片存在，且 `MainActivity` 不得出现 `RECORD_AUDIO`/`CAMERA`/`SpeechRecognizer`/`getUserMedia`/`MediaRecorder`。
- 仍未解决（**产品边界缺口，不是 WebView 缺陷**，不能按“已修复”对外说明）：
  - 图片“上传给模型”仍不可用：图片问答端口只接受 Windows 桌面 IPC（`window.nuanbanImageQuestion`）。文件选择器修好后可选图、预览并明确提示“当前没有可用的桌面图片接口”，但**不会上传、也不会假装识别**。
  - 语音听写当时仍不可用：普通包继续不声明 `RECORD_AUDIO`/`CAMERA`；独立桌宠包已按所有者决策在下一节（C）新增 `RECORD_AUDIO`，只使用系统离线识别，仍需真机验收。
  - 文字 AI 同样未接入 Android：共享 UI 为 local 模式且无 `nuanbanTextQuestion` 桥；要同 Windows 能力需接服务端受控设备会话（见上一节模型说明）。
- 构建与验证：`apps/android/check-standalone-packaging.ps1`（离线）`BUILD SUCCESSFUL in 1m 5s`，打包隔离 **89/89** 通过；`zipalign -c 4`、`apksigner verify`（v2、debug 证书）通过；新增 vitest 断言通过；TTS 垫片在 Node 模拟 `window`/host 下验证可用性、speak/语速、cancel、onend、onerror、引擎未就绪时 `undefined` 六条语义。
- 产物（debug、未签名发布版；与上一节尺寸/哈希不同是因为本次构建含本节宿主改动）：
  - `app/build/outputs/apk/debug/app-debug.apk`：7,570,810 字节（7.22 MiB），SHA256 `B14803EDDBECE1AD73735D2F6AD84882CA2FA8173CB36EA4D62E4753EDA8609F`。
  - `standalone/build/outputs/apk/debug/standalone-debug.apk`：90,481,515 字节（86.29 MiB），SHA256 `3B196F0AD7FEC45D03708E243D4A884822E276459D84C1BC2F55B6261F8FE53D`。
- 未做：没有连接真机/模拟器，**未安装、未点击真实文件选择器、未播放真实 TTS**，`deviceVerified=false`；上述宿主修复只证明可编译、DEX/权限隔离与 JS 垫片语义，真实机型文件选择器行为、TTS 引擎可用性与朗读音质仍需真机验收。C17/验收门禁指纹因 `MainActivity.kt` 变更需按仓库流程重跑后再作为证据。

## 2026-10-23 独立包本地听写（C，所有者决策后实施）

- 决策：所有者选择 **C**（额外开放麦克风听写），同时明确**普通管理包保持无网络**、**Android 图片问答暂不做**；配对方式为“桌面显示一次性配对码”（另见 `docs/implementation/android-model-and-3d-plan.md`）。
- 权限边界改动（仅独立桌宠包）：`standalone/src/main/AndroidManifest.xml` 新增 `RECORD_AUDIO`；**普通包继续不声明** `RECORD_AUDIO`/`CAMERA`。打包隔离校验相应改为 `normal_no_RECORD_AUDIO` + `standalone_has_RECORD_AUDIO`，并新增 4 条 DEX 断言：普通包不得含听写桥 `nuanbanVoiceHost`、不得含 `Landroid/speech/SpeechRecognizer;`，独立包必须同时包含两者；另有 `AndroidLocalDictation` 类级别的普通包排除/独立包包含断言。
- 实现（`app/src/standalone/.../AndroidLocalDictation.kt`，仅独立源集编译）：
  - 只用系统**离线**识别（`createOnDeviceSpeechRecognizer`，API 31+；API 33+ 先查 `isOnDeviceRecognitionAvailable`）；不可用时明确报不可用，**不回退云端识别、不假装成功**。
  - 低置信度策略与 Windows 端一致：阈值 `0.6`，置信度缺失或低于阈值 → `uncertain`，**不携带文本**、不写入草稿、不进入模型、不执行动作，只提示重说；`tests/domain/speech.test.ts` 新增 4 项断言固化该契约（`uncertain` 的文本被丢弃、`microphoneActive` 必须为 false）。
  - 麦克风只在本人点击“开始语音输入”后开启，一次一句话，结束立即关闭；20 秒超时；文本上限 500 字；不使用常驻唤醒监听。
  - 桥接：`WebViewCompat.addWebMessageListener`（名字 `nuanbanVoiceHost`，origin 限定 `https://appassets.androidplatform.net`，仅主框架、payload ≤4096）暴露 `status`/`dictate`/`cancelDictation`/`enable`/`disable`/`openSettings`；`localOnly: true`、结束后 `microphoneActive: false`；音频仅本机处理，不上传不保存。
- 验证：`tests/domain/speech.test.ts` + `tests/platform/android-standalone-runtime.test.ts` **19/19 通过**；`:standalone:compileDebugKotlin` **BUILD SUCCESSFUL**（需 `JAVA_HOME=<Android Studio jbr>` 与 `ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk`）。
- 未做/待办：**未做真机验收**（无设备/AVD，未申请真实麦克风权限、未跑真实离线识别），`deviceVerified=false`；完整的 `check-standalone-packaging.ps1` 重编校验待 3D 工作流落地后统一复跑（用例数将由 89 上升）；权限边界变更使 C17/验收类门禁指纹需按仓库流程重跑。
