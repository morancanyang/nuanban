# 微光指引 · Android 独立桌宠实现边界

> 文档同步：2026-10-22。产品显示名称为**微光指引**；[当前功能与平台边界](../../docs/implementation/product-current-state.md)统一说明现行入口、已实现范围和待验证能力。本文已有测试数字与生成日期仍只对应原批次，不因文档更新自动视为重新验收。

## 原生入口与所有权

- 普通 `:app` 的 `app/src/main/AndroidManifest.xml` 恢复仅通知/精确闹钟与管理 Launcher；不含捕获/浮层/FGS 权限或桌宠/捕获组件。`app/src/normal/java/AndroidHostRuntime` 仅报告不可采集，不导入捕获实现。
- 独立 `:standalone` 模块使用 `standalone/src/main/AndroidManifest.xml`、`app/src/standalone/java` 和单独 applicationId `org.nuanban.assistant.standalone`。捕获/桌宠服务及状态机只进入这个模块，不依赖普通 app APK，也不依赖 C01 native-lab。只有无系统 API 的 `FrameRisk` / `GateDecision` DTO 为共享 `FlowAdapter` 保留在 main。
- Launcher 进入 `PetControlActivity`，默认不启动服务、不申请权限、不抓屏、不录音。本人点击启动、悬浮权限与可见停止通知齐备后，`PetRuntimeService` 使用 `specialUse` 前台服务及 `TYPE_APPLICATION_OVERLAY` 持有桌宠。
- 点击/拖动本地静态形象浮层、原生小输入面板、停止教学、停止全部观察/教学、打开管理与退出均不依赖 WebView。问题输入不落盘，提交后清空；常驻通知提供原生停止和退出。
- `MainActivity` 是管理端，暂停/关闭只发 `nuanban:management-pause` / `nuanban:management-destroy`，不再冒充锁屏或进程终止。原生服务才处理真实熄屏、锁屏和权限丢失。
- 共享 WebView 仍可能因 `visibilitychange` 发送旧 `stop_all`；Android 的 `PetManagementBoundary` 拒绝其影响独立观察/教学及未释放的 Pet-owned 捕获。旧桥没有 scoped-stop/stop-error 合约，保护分支返回 `bridge_error`，现有严格 JS 校验会拒绝为未确认停止，**不谎报全局已停止**。管理页原生按钮可以打开桌宠控制页。无独立会话时只停止旧管理捕获，资源清理完成才返回精确的旧成功结构。

## 观察、教学与恢复

- `PetSessions` 与 `AndroidTeachingState` 分开维护观察和教学代际；停止教学取消该次分析及标记，不停止仍有效的观察。观察同意和可选云分析同意分别默认关闭、当次勾选、使用后清空，不随进程或页面恢复。
- 观察必须由本机原生界面本人本次勾选同意；此勾选不保存且点击后清空。只有浮层/通知、锁屏检查与本地检测器预检通过，才创建新的系统 MediaProjection 请求。授权 ticket 带随机 nonce、代际，只能消费一次，进程重启和隐私暂停均不恢复。
- `NativeCaptureService` / `CaptureSession` 在创建 VirtualDisplay 前注册系统 callback；私有 worker 每 600ms 至多检查一帧，使用随包中文/Latin OCR 与人脸模型，在内存中同帧分类、遮盖全部识别文字和人脸；不将原始画面落盘或传云。未知/敏感、检测故障、缺证明、显示变化和清理失败均封闭。检测总预算 300ms、发送前准入 500ms，不因性能不足放宽。
- 本人先点击“检查本地 OCR 与隐私模型（不抓屏）”，校验 APK 中 39 个模型资产的 Ordinal 排序清单 SHA-256，并用合成图预热；未就绪时仍在系统捕获授权前拒绝。准入是私有对象身份与真实同帧检测结果，不是把 detector ready 常量改为 true。
- 教学连接由非 exported 原生页本人确认后，经 AndroidKeyStore/AES-GCM 的既有 `AndroidSecretStore` 加密保存；只接受 HTTPS 微光指引服务与设备会话，不在 renderer 放供应密钥。保存连接不启用观察或云分析；更改或清除连接先停止已有观察。
- 当次云同意、有效观察、新安全帧和设备会话均满足后，提问、有效控件结构变化或“我点好了”触发 `StandaloneGuidanceClient` 的真实 POST。默认拒绝、单飞、无重试、拒绝重定向；请求 3MiB/响应 32KB/总调用 12 秒上限，停止时 disconnect。缺配置或调用失败只报告不可用，没有固定步骤或 Mock 回退。
- `AndroidGuidanceAdapter` 将已验证回复送入教学状态机。目标仅取当前本地控件；候选明确不确定。下一步/完成都要前一步预期标签在新的本地安全画面中新出现，并与回复证据匹配；旧标签、布局变化和按钮点击本身不构成完成。自动页面分析保守要求相对前一步基线出现新控件；仅消失/布局变化或恢复基线不会循环上传、重画旧标记，须本人核验。慢结果仍须最新安全上下文相同，标记无新帧 1.2 秒失效；复习建议没有自动排程。
- 教学标记和字幕为 `FLAG_NOT_TOUCHABLE` / `FLAG_SECURE` 原生浮层。源尺寸与缩小帧尺寸分别校验；Android 14+ 回调确认前不处理画面，单应用区域、旋转或窗口原点不能可信映射时拒绝，不画猜测坐标。控制页和输入面板可见期间暂不取帧/分析自身 UI；收起后须重新通过本地检查，不解除隐私暂停。
- 隐私或停止时先使会话/出口失效，再释放 reader/display/projection 与浮层。停止不通过重新启动 FGS 实现。旧捕获资源未释放或清理失败时，新的系统授权会话仍被拒绝。恢复必须重新本人同意及新的系统授权，页面/家属/模型不能恢复。
- 不使用 Accessibility、自动点击、自动输入/登录、启动第三方应用、麦克风或云 ASR，也没有开机/后台自动恢复观察。

## 当前不可用边界

1. 已有真实本地检测与教学代码不等于安全覆盖已通过真机验收。本地策略仅保守识别部分设置、浏览器与编辑器控件结构，不按软件名白名单；未知、敏感、模型校验/性能失败仍停采。桌面、任意第三方软件、单应用捕获及不同厂商不能宣称全部支持。
2. 本轮没有设备安装、本人系统授权、真实屏幕、真实设备会话或实际云供应调用；TLS/断连的平台行为、OCR 漏检率、端到端教学质量及真实浮层穿透/坐标均待真机测试。二进制 Manifest 已移除 SDK 自动 CCT 发送后端，不把库初始化遥测当作本人同意的教学请求；实际设备网络行为仍须单独复核。
3. 没有本地离线 wake 引擎，状态为 `unavailable_no_offline_wake_engine`；不申请录音，不用系统 SpeechRecognizer 冒充离线唤醒。
4. 教学笔记、本人掌握确认、AI 复习建议确认、家属媒体邀请、真实跨应用教学效果未实现或未接线。没有伪造完整支持。
5. FGS `specialUse` 的分发审批、Android/厂商后台限制、键盘/浮层、锁屏/撤权实际时序、电量/性能均待真机验证。声明服务和离线编译不构成商店审批或设备支持承诺。
6. 独立桌宠的悬浮形象是随包打包的产品角色**本地静态预览**（`nuanban_pet_preview.png`，含 400×560 透明 PNG，来源于 Windows 端同款花环水獭静态预览），不是实时 3D 建模，也不连接星云、不抓屏、不联网。实时 3D 形象仍只在 Windows 端；Android 端如后续要做实时 3D，需要单独设计并完成真机性能、触摸与浮层验收，本次没有实现。管理页文字模型同样未接入 Android（服务端受控会话引导未实现），不以此声称模型已连接。

## 离线验证

本机可用 Android SDK 36、JDK 17、Gradle 8.14.3，app 为 minSdk 26 / compileSdk 36 / targetSdk 36。命令仅编译与测试，不自动安装/启动/授权或获取任何画面：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/android/check-standalone.ps1
pnpm exec vitest run tests/platform/android-standalone-runtime.test.ts tests/platform/android-message-host.test.ts tests/platform/native-host.test.ts tests/native/android-lab.test.ts
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
Set-Location apps/android
.\gradlew.bat :app:assembleDebug :standalone:assembleDebug --offline --no-daemon
powershell -NoProfile -ExecutionPolicy Bypass -File .\check-standalone-packaging.ps1 -SkipBuild
```

`check-standalone.ps1` 仅调用本机 Gradle 缓存的 Kotlin 编译器，执行真实纯 JVM 会话/门控/资源清理逻辑，返回 `deviceVerified=false,captureExecuted=false,cloudExecuted=false`。Vitest 包含此实际执行，并另作 Android 接线结构断言；这些结构断言不是设备行为测试。非 Windows 环境明确跳过这个 PowerShell JVM runner，而非伪报执行。普通 Debug APK 在 `app/build/outputs/apk/debug/app-debug.apk`，独立包在 `standalone/build/outputs/apk/debug/standalone-debug.apk`。

`check-standalone-packaging.ps1` 默认以 offline Gradle 构建两包，然后用 Android SDK 的 aapt2 检查实际二进制 Manifest 权限/包名/Launcher/组件，并从 APK 解压 DEX 确认普通包不包含捕获/桌宠实现类而独立包含。`-SkipBuild` 只检查已有 APK，不把纯文本 Manifest 检查冒充最终打包隔离。

Android 官方核对依据（2026-10-18）：
- https://developer.android.com/media/grow/media-projection
- https://developer.android.com/develop/background-work/services/fgs/service-types#special-use
- https://developer.android.com/build/build-variants

Android 14+ MediaProjection 每次会话需新本人系统授权、token/VirtualDisplay 单次使用，并声明 mediaProjection FGS 权限与类型；驻留桌宠单独使用 specialUse 并说明用途，不把闲置驻留伪装为屏幕采集。

## 本轮最新本机验证（2026-10-18）

- 真实纯 Kotlin/JVM 检查 264/264 通过，覆盖会话/资源、模型准入策略、独立云同意、教学新帧证据、几何映射、请求适配、严格协议及浮层遮挡防重复分析；日志 `.cache/android-guidance-jvm-final.log`。这些用例没有执行 Android ML 原生引擎、真实 TLS 或设备捕获。
- Android 接线专项 Vitest 13/13；包含实际 JVM runner，不与 264 相加。最终跨 Windows/Android/服务端/契约/隐私专项 15 文件、791/791，通过，结果 `.cache/standalone-core-final-report.json`。
- 双包离线 Gradle `assembleDebug` 实际成功（25 秒，78 任务）；对实际 APK 的权限、Launcher、组件、20 个独立实现类、ML 接口 DEX、模型资产及自动 CCT 后端禁用检查 87/87。普通包仍无 INTERNET/捕获/浮层/FGS 权限、独立实现类或 ML 模型。日志 `.cache/android-guidance-packaging-final.log`。
- 模型资产 39 个；Ordinal 清单 SHA-256 为 `4f5fa874d4808f27f9afca0ccb6a69debc0f8ab67d59ece2981704f4a54224a6`，与运行时信任锚一致。
- 最新普通 APK SHA-256：`882FBC1E23A17FB5938679278F32256A8FF983226C9BE59D3DA2170462B0EA2A`；最新独立 APK SHA-256：`42B2C68CD36B0DD1F3BFE132E484776EAD5BB97A433D586094A7BF6C718B442E`。历史段落中的哈希不能代表本次产物。
- 屏幕、麦克风、实际云调用及设备启动均未执行；`deviceVerified=false,captureExecuted=false,cloudExecuted=false`。新增捕获功能仍需本人操作和系统授权，不能由代理代替。
- 整仓 `pnpm check` 在 17:19～17:22 快照为 106 文件、1895 项中 1852 通过、43 失败，失败均在 8 个 acceptance 门禁文件。并行“移除 Mock”改动已删除 `packages/config/src/scenarios.ts`，C17 还引用旧生产 Mock/UnconnectedRepository 标记；新动态检测链也未满足旧 `ANDROID_CLOSED` 的空构造器静态规则。不是设备待项导致的纯外部阻断。门禁仍 `DEV_BLOCKED/BLOCKED`，不能以专项通过声称整仓或正式发布通过。
- 最后补正 Android 26～29 的真实全屏 metrics，并限制浮层遮挡/控件消失导致的自动分析回环；随后重新编译双包并通过上述 87 项检查及 791 项专项。没有用专项报告覆盖整仓失败的 `docs/implementation/evidence/unit-results.json`。

## 历史快照：前序本机结果

- 隔离后的 `:app:assembleDebug :standalone:assembleDebug --offline --no-daemon`：BUILD SUCCESSFUL，47 秒，76 个任务；首次迁移发现共享 FlowAdapter 的纯类型依赖，拆分为共享 `GuidanceSafetyTypes.kt` 后重编通过。
- `check-standalone.ps1` 实际 JVM 逻辑场景 41/41 通过；四个定向 Vitest 文件 41/41 通过，其中包含 JVM runner 与原有 normal/native-lab 权限边界回归。两组数字不相加宣称独立覆盖。
- `check-standalone-packaging.ps1 -SkipBuild` 对两个实际 APK 检查 54/54 通过：普通权限/入口保留，独立包名，实际二进制 Manifest 组件和 DEX 中 10 个桌宠/捕获类的排除/包含均验证。
- 普通 APK SHA-256：`9D36A7884DB5D97F31CB4E3529A57639BA2856B311C1A2D4D5B6E9E7F7131E37`。
- 独立 APK SHA-256：`B64CD221CEBE05E2D98D2C8B98FDBC12EEE459B03D7D29F4BEAB10B8F9E65ACD`。
- 没有执行设备安装、App 启动、系统授权、抓取用户屏幕、录音或云请求；`deviceVerified=false,captureExecuted=false,cloudExecuted=false`。编译仍有既有 SDK XML、Kotlin DSL 与 Android API 弃用提示，未据此声称真机通过。

主线程在加入 61 操作/127 定义的最新公共契约后，再执行 `check-standalone-packaging.ps1`（不传 SkipBuild）：双 APK 离线重编 BUILD SUCCESSFUL（46 秒，76 任务），实际 APK 隔离检查 54/54。此次普通 APK SHA-256 为 `882FBC1E23A17FB5938679278F32256A8FF983226C9BE59D3DA2170462B0EA2A`，独立 APK 为 `A6228E75F84684A347E770FCD60EA303992945401965C1DC4407A76C952CCF6B`；替代前一快照作为本轮最新编译字节，但仍没有设备/采集/云端验收。日志位于工作区 `.cache/standalone-android-packaging-final.log`。
