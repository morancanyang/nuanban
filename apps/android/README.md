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
