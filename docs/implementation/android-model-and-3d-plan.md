# 安卓模型接入与实时 3D 桌宠（2026-10-23 所有者决策：B + C + D）

> 决策来源：所有者明确选择 **B（接入服务端真实模型）+ C（额外开放麦克风听写）** 与 **D（实时 3D 桌宠）**。
> 本文是实施计划与验收边界；**不代表这些能力已经可用**。每个工作流完成后必须单独验收，真机部分在当前环境不可执行。

## 0. 现状（已发布，可先验证）

| 能力 | 状态 |
| --- | --- |
| Windows 桌面：偶发网关失败的**有界重试**（r15） | 已发布并验证（1178/1178 测试、ASAR 仅 `app.asar` 变化） |
| 安卓桌宠形象 | 已发布：悬浮层由文字占位改为随包"花环水獭"**本地静态 PNG**（非 3D） |
| 安卓 WebView 宿主 | 已发布：`onShowFileChooser`（系统文件选择器，零权限）+ 系统 `TextToSpeech` 注入的 `speechSynthesis` 垫片 |
| 安卓图片上传给模型 / 文字 AI / 语音听写 | **仍不可用**（本次 B/C 的目标） |
| 安卓实时 3D 形象 | **未开始**（本次 D 的目标） |

## 1. 工作流 B：安卓接入真实模型（服务端 + 原生会话）

### 1.1 目标
- 共享 Web UI 在 Android WebView 中通过**受限桥接**获得文字问答与图片问答能力。
- **令牌不进 JS**：设备会话凭证只保存在 Android 原生加密存储（`EncryptedSharedPreferences` 或 Android Keystore 包装），桥接只暴露"提问/取消/状态"。
- 服务端新增：设备会话签发/刷新 + 图片问答端点（复用现有 provider 配置与 `TextConversation` 服务）。

### 1.2 关键约束（不得违反）
1. 图片必须先在 Android 端完成**本地脱敏/门控**才允许上传；不可把原始截图直接送云端。
2. 会话凭证：短期、可撤销、与设备绑定；服务端限流；刷新需设备私钥签名（device-challenge 语义）。
3. 未配置/未授权/凭证失效时 **fail-closed**，UI 文案明确"未接入"，不得回退演示数据。
4. 现有 Windows 端 IPC（`nuanbanTextQuestion`/`nuanbanImageQuestion`）语义保持不变；Android 走新通道，不伪装成桌面桥。

### 1.3 交付物
- 服务端：`apps/server/src/**` 新增会话与图片端点 + `tests/server/**` 覆盖（含拒绝路径）。
- Android：原生会话存储 + 桥接（`nuanbanBridge` 扩展或新 bridge）+ Web 适配器（`apps/web/src/**`），仅在 Android 宿主启用。
- 文档：`docs/implementation/android-model-access.md`（协议、威胁模型、验收步骤）。

## 2. 工作流 C：安卓麦克风听写

### 2.1 目标
- 在**独立桌宠包**内提供本地听写（`SpeechRecognizer` 或本地引擎），复用 Windows 端"低置信度不执行"策略：不确定 → 只提示重说，不进入模型、不执行动作。

### 2.2 必须同步改动（否则门禁会失败）
- `apps/android/app/src/main/AndroidManifest.xml`、`apps/android/standalone` 清单：新增 `RECORD_AUDIO`（仅独立包）。
- `apps/android/check-standalone-packaging.ps1`：把"两包均无 `RECORD_AUDIO`"改为"普通包无、独立包含"，并新增 `SpeechRecognizer` 的包含/排除断言。
- `tests/platform/android-standalone-runtime.test.ts`、`tests/domain/speech.test.ts` 等断言同步。
- 文档：`apps/android/README.md`、`docs/implementation/product-current-state.md` 的权限边界描述。

### 2.3 风险
- 权限边界属产品/安全改动：必须真机验证授权/拒绝/撤销、后台行为与通知；**当前无设备/AVD，只能做到源码 + 离线校验**。

## 3. 工作流 D：实时 3D 桌宠（Android 悬浮层）

### 3.1 目标
- 独立桌宠包悬浮窗渲染 3D 形象（GLB），替代静态 PNG；同一模型资产与桌面端一致。

### 3.2 方案候选（先做技术验证，再定）
| 方案 | 优点 | 风险 |
| --- | --- | --- |
| 原生 GLSurfaceView + 轻量 GLB 渲染 | 无 WebView 依赖、性能可控 | 需自研/引入渲染库、动画与触摸适配成本高 |
| 悬浮窗内受控 WebView + three.js | 复用桌面已生成的模型代码 | WebView 悬浮层性能/耗电、触摸穿透与安全需实测 |

**先做 spike**：在两个候选里各做一个最小可运行样例（仅本地静态 GLB 循环动画 + 拖动 + 单击打开面板），测帧率/内存/耗电，再定最终方案。

### 3.3 边界
- 不得为 3D 引入网络或额外权限；不得影响"单击打开面板/拖动/FLAG_SECURE"等既有行为。
- 真机验收项：帧率、内存、耗电、触摸、遮挡、`FLAG_SECURE`、低端机表现。

## 4. 验收门（每个工作流独立执行）
1. 源码级：`pnpm typecheck` + 相关 vitest 全绿。
2. 打包级：`apps/android/check-standalone-packaging.ps1` 全绿（用例数会随 C 增加）。
3. 服务端：本地起服 + 合成请求覆盖签发/刷新/拒绝/限流；**部署到试验 ECS 后**再做一次真实 HTTP 验证（由 lead 执行，需所有者同意部署窗口）。
4. 真机：安装、权限、悬浮窗、前后台、断网、拒绝授权、模型真实回答。**当前环境无设备，必须由所有者或线下设备完成**；未完成前一律标注 `deviceVerified=false`。

## 4.5 所有者决策（2026-10-23 第二批，已定稿）

| 决策点 | 结论 | 影响 |
| --- | --- | --- |
| 普通管理包是否放开 `INTERNET` | **保持无网络**（A） | 普通包继续只做管理；模型能力只在独立桌宠包可用，打包隔离断言不变 |
| Android 图片问答 | **暂不做**（A） | 不引入 ML Kit/视觉资产；`:app` 的 `REDACTION_UNAVAILABLE` 路径改为明确文案“Android 暂不支持图片问答”，仍不上传 |
| 设备配对入口 | **桌面显示一次性配对码**（A） | 新增 B4：服务端签发/核销（task-6）→ 桌面展示（task-7）→ 安卓输入绑定（task-8）；配对码短期、一次性、限流、只存哈希，不落盘/不进日志 |

**当前实现状态（勿误认为已可用）**：B1（服务端会话 + 图片端点）、B2（安卓原生会话 + 桥接 + Web 适配器，commit `d039013`）已落地代码与测试；但**设备绑定入口未完成**（B4 在排队）、**未部署**、**未真机验收**，因此真机上文字问答仍显示“未配置”。

## 5. 实施顺序
1. **B1 服务端**（会话 + 图片端点 + 测试）与 **B2 Android 会话/桥接** 并行；B2 依赖 B1 的协议定稿。
2. **C 听写**在 B2 之后（同一批 Android 文件，避免冲突）。
3. **D 3D spike** 可并行，但只允许改独立包的渲染相关文件。
4. 全部就绪后由 lead 统一重编两包、发布、更新文档哈希。