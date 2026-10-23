# 安卓受控模型通道（B1 服务端协议）

> 文档同步：2026-10-23。本文描述服务端 B1 交付的**协议、限制与威胁模型**。
> 状态标记：`deployed=false`、`deviceVerified=false`、`externalProviderVerified=false`。
> 本文只对应本次源码 + 合成测试批次；**未部署到任何服务器、未真机验收、未用真实密钥做端到端图片问答**。
> 相关：所有者决策见 [android-model-and-3d-plan.md](android-model-and-3d-plan.md)（B + C + D）；旧桌面通道见 [real-ai-provider.md](real-ai-provider.md)。

## 收口状态（2026-10-23 所有者决策）

- **B 工作流整体暂缓，等 HTTPS**：桌面端与安卓端的服务端客户端都只接受 HTTPS 或本机回环地址，而当前试验服务器是 **HTTP（IP:80）**，因此 B 无法端到端可用。所有者选择「暂缓 B 等 HTTPS」。
- **B1（本文）已按原范围实现并验证**，不部署即无风险；本次**不再扩展新端点、不做部署准备**。
- **task-5（B3，收窄旧免签刷新）与 task-6（B4，一次性配对码）已标记【暂缓·待 HTTPS】，未开始**；B2 代码（commit `d039013`）保留在仓库中但未启用（未配置即 fail-closed）。
- **端到端可用性的前置条件**：后端提供 **HTTPS**（含证书与域名，或明确的受信回环部署）。在 HTTPS 就绪前，真机与桌面客户端都必须继续按既有安全约定**拒绝非 HTTPS、非回环地址**，不得为连通性放宽该检查。
- 重启条件：所有者具备域名/证书、后端 HTTPS 可用后，再按 §4/§5 做部署级与真机验收；在此之前本文所有能力一律视为「未接入」。

## 0. 交付范围与明确未覆盖项

已实现（`apps/server/src/**`，`tests/server/**` 覆盖）：

1. **设备会话**：签发 / 设备签名刷新 / 撤销 + 限流，短期、可撤销、与设备绑定，复用既有 device-challenge 与 session 语义。
2. **图片问答端点**：接收客户端已脱敏的 PNG + 文本问题，复用既有 provider 配置与 `TextConversationService`（含会话隔离、请求事件流、取消、代次）。

未实现 / 未验证（不得据此声称可用）：

- 未部署：没有任何 ECS/IIS/公网变更；协议未在真实网络路径上验证。
- 未真机验收：Android 原生会话存储与桥接属于 B2（任务板 task-2），本次不涉及；`deviceVerified=false`。
- 未用真实供应商做图片问答端到端验证：测试全部使用合成 provider（`tests/server/image-question-http.test.ts`）。
- 未改 `apps/android`、`apps/web`、`apps/desktop`；Windows 桌面 IPC（`nuanbanTextQuestion`/`nuanbanImageQuestion`）语义保持不变。
- **设备绑定入口缺失**：B1 没有提供配对码/邀请码签发端点；真机目前**无法完成首次绑定**（fail-closed）。所有者已决定采用「桌面显示一次性配对码」，服务端部分登记为任务板 **task-6（B4）**（见 §10）。
- `packages/contracts` 未为新端点生成 OpenAPI/JSON Schema/Kotlin DTO：契约包不在本任务写范围。新增路由尚未进入生成契约，`contracts:check` 因此不受影响，但客户端无法从生成物获得这些端点。
- 限流额度目前只能通过 `createApplication({ deviceSession: { limits } })` 编程覆盖；`main.ts` 未接对应环境变量（见 §8 后续项）。

## 1. 信任边界与角色

```
共享 Web UI（WebView / React）
   │  受限桥接：只暴露「提问 / 图片提问 / 取消 / 状态」，严格字段白名单
   ▼
Android 原生宿主（B2）
   │  会话令牌只存原生加密存储（EncryptedSharedPreferences / Keystore 包装）
   │  Authorization: Bearer <access_token>
   ▼
nuanban-server（本次交付的 B1）
   │  服务端只认 Bearer 令牌；令牌不写日志、不回显、不进通用 hooks
   ▼
OpenAI 兼容 provider（NUANBAN_AI_*）
```

- **令牌不进 JS**：桥接不返回 `access_token` / `refresh_token`，也不暴露任意 HTTP 能力；JS 只能发起「提问/取消」并读取文本结果与状态。
- **脱敏在客户端**：图片必须先在设备本机完成脱敏 / 门控才允许上传；服务端**无法验证**脱敏是否真的发生，只能校验结构、体积、校验和与客户端断言（见 §7.7）。
- **服务端不做演示回退**：未配置 provider、未授权、会话失效、超限一律结构化拒绝，绝不返回固定答案或伪造回答。

## 2. 通用约定

- 传输：HTTP/1.1 + JSON；请求体上限默认 1 MiB，图片问答路由 3 MiB，`/v1/standalone/guidance/analyze` 3 MiB，`/internal/desktop/voice/call` 96 KiB。
- 成功信封：`{ "data": <payload>, "request_id": "<uuid 或客户端 X-Request-ID>", "schema_version": "0.2.0" }`。
- 错误信封：`{ "error": { "code": "<ServiceErrorCode>", "message": "<人类可读>", "retryable": <bool>, "details"?: { "retry_after_seconds"?: number } }, "request_id": "...", "schema_version": "0.2.0" }`。
- 鉴权：`Authorization: Bearer <access_token>`。令牌不在 URL、查询串、Cookie 或响应头中传递。
- 401 语义：`AUTH_FAILED` = 令牌无效/已撤销/未提供；`AUTH_EXPIRED` = 令牌或挑战已过期，或设备绑定不再有效。客户端收到任一 401 都应先尝试签名刷新（§4），刷新失败则清空本地会话并把 UI 置为「未接入 / 已失效」。
- 429 语义：`RATE_LIMITED`，`retryable=true`，响应头 `Retry-After: <秒>`，同时 `details.retry_after_seconds`。
- 限流键：默认取 TCP 对端地址。部署在反向代理（如 IIS ARR）后面时，必须显式设置 `NUANBAN_TRUST_PROXY_HEADERS=true` 才采信 `X-Forwarded-For` 的**首段裸 IP**；否则所有客户端共用一个限流桶（见 §7.11）。
- 限流是**进程内固定窗口**、重启清零、非分布式配额；只用于防滥用与成本控制，不作为授权依据。

## 3. 设备会话端点

### 3.1 `POST /v1/device-sessions/challenges`（签发挑战，无需令牌）

请求体（严格字段，二选一）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `binding_id` | string | 已绑定设备 ID；用于首次登录（复用 `auth.issueDeviceChallenge`） |
| `refresh_token` | string | 有效刷新令牌；用于刷新前取签名挑战（服务端据此解析设备，复用 `auth.issueSessionChallenge`） |

响应 `201`：

```json
{
  "data": {
    "challenge_id": "8f1c…-uuid",
    "challenge": "<base64url 32 字节随机 nonce>",
    "expires_at": "2026-10-23T01:02:03.000Z",
    "signature_algorithm": "hmac-sha256-hex"
  },
  "request_id": "…",
  "schema_version": "0.2.0"
}
```

- 挑战**一次性**（`used_at`），有效期 2 分钟（`AuthOptions.challengeTtlMs` 默认 `2*60*1000`）。
- `signature_algorithm` 固定为 `hmac-sha256-hex`：`HMAC-SHA256(key = device_secret 的 UTF-8 字节, message = challenge 字符串的 UTF-8 字节)`，输出**小写 hex（64 字符）**。

### 3.2 `POST /v1/device-sessions`（签发会话，无需令牌）

请求体：`{ "challenge_id": "<uuid>", "signature": "<64 位小写 hex>" }`

响应 `201`：

```json
{
  "data": {
    "session": {
      "access_token": "nb_access_…",
      "refresh_token": "nb_refresh_…",
      "token_type": "Bearer",
      "expires_in": 600,
      "refresh_expires_in": 1209600,
      "account_id": "…",
      "device_id": "…",
      "platform": "android"
    }
  },
  "request_id": "…",
  "schema_version": "0.2.0"
}
```

- 生命周期（`defaultDeviceSessionLimits`）：access token **10 分钟**，refresh token **14 天**；每次请求都会实时校验会话记录与设备绑定状态，因此撤销立即生效。
- 会话与设备绑定（`device_id` + `platform`）绑定；设备被撤销后其所有会话立即失效。
- 客户端应据 `expires_in` / `refresh_expires_in` 提前刷新；不要在 UI 中展示令牌。

### 3.3 `POST /v1/device-sessions/refresh`（设备签名刷新）

请求体：`{ "refresh_token": "nb_refresh_…", "challenge_id": "<uuid>", "signature": "<64 位小写 hex>" }`

响应 `201`：同 3.2 的 `session` 结构（新令牌；**旧 refresh_token 立即被轮换吊销**）。

### 3.4 `POST /v1/device-sessions/revoke`（撤销）

请求体：`{ "refresh_token": "nb_refresh_…", "revoke_device": false }`（`revoke_device` 可选，默认 `false`）

响应 `200`：`{ "data": { "revoked": true, "device_revoked": false } }`

- 仅撤销该 refresh token 对应的会话（access + refresh 一起失效）。
- 幂等：重复调用、或对已过期但已知的令牌调用，仍返回 `revoked: true`（拒绝型操作，不需要签名）。
- `revoke_device: true` 会额外撤销**整个设备绑定**（该设备的所有会话，与既有 `DELETE /v1/devices/{id}` 等效），但要求会话本身仍然有效，否则 `401 AUTH_EXPIRED`。
- 未知 `refresh_token`（格式合法但服务端没有记录）：`401 AUTH_FAILED`，且错误消息不回显令牌内容。

### 3.5 限流额度（每进程，固定窗口）

| 键 | 额度 | 触发点 |
| --- | --- | --- |
| `challenge:client:<ip>` | 30 / 60s | 任意挑战签发 |
| `challenge:device:<device_id>` | 10 / 60s | 挑战签发（含 refresh_token 形式） |
| `exchange:client:<ip>` | 20 / 60s | 3.2 会话签发 |
| `refresh:client:<ip>` | 20 / 60s | 3.3 刷新 |
| `refresh:device:<device_id>` | 10 / 60s | 3.3 刷新 |
| `revoke:client:<ip>` | 10 / 60s | 3.4 撤销 |

设备级额度在**轮换之前**检查，因此被限流的刷新不会吊销调用方手上的有效令牌（可重试）。

## 4. 刷新与吊销流程

刷新（access token 过期或被拒后）：

1. 业务请求返回 `401 AUTH_EXPIRED`（或 `AUTH_FAILED`）。
2. 原生层 `POST /v1/device-sessions/challenges`，体为 `{ "refresh_token": "<当前 refresh_token>" }` → 得到 `challenge`。
3. 原生层用**设备私钥派生密钥**（`device_secret`）做 HMAC-SHA256 签名（§3.1 算法）。
4. `POST /v1/device-sessions/refresh` → 新 `access_token` + 新 `refresh_token`；旧 refresh token 立即失效。
5. 失败分支：
   - 签名错误 / 挑战不属于该设备 / 挑战已用：`401 AUTH_FAILED`，**旧 refresh token 保持有效**，可重新取挑战重试。
   - 挑战过期：`401 AUTH_EXPIRED`，重新取挑战。
   - refresh token 过期 / 已轮换 / 设备已撤销：`401 AUTH_EXPIRED`，本地清空会话并显示「已失效」。
   - 超出设备额度：`429 RATE_LIMITED`，按 `Retry-After` 退避；令牌未被消耗。
6. 刷新成功后，原生层用新令牌重放**一次**被拒的业务请求；不得自动无限重试。

吊销（退出登录 / 用户关闭 AI / 疑似泄漏）：

1. 原生层 `POST /v1/device-sessions/revoke`，体为 `{ "refresh_token": "<当前 refresh_token>" }`。
2. 服务端立即把该会话标记为已撤销；后续任何 `Bearer` 请求在鉴权阶段即被拒（`401 AUTH_FAILED`）。
3. 需要连设备绑定一起撤销（换机、卸载、丢失设备）时带 `"revoke_device": true`。
4. 撤销后本地必须清除令牌与任何缓存状态；重新使用需重新绑定设备（走既有绑定流程 + 3.1/3.2）。
5. 家属/账号侧仍可用既有的 `DELETE /v1/devices/{device_id}`（需该账号的令牌）撤销设备。

## 5. 图片问答端点

### 5.1 会话准备与文本问答（复用既有路由，逐字固化）

**`POST /v1/conversations`**

- 请求体：`{ "mode": "elder" | "child" | "accessible" }`（其他值 → `400 INVALID_REQUEST`，消息 `mode must be elder, child, or accessible`）
- 响应 `201`：`{ "data": { "session_id": "<uuid>" } }`

**`POST /v1/conversations/{session_id}/responses`**（文本问答，与 B2 现有实现一致）

| 字段 | 类型 | 约束 | 违反时 |
| --- | --- | --- | --- |
| `input_id` | string | UUID（幂等键） | `400 INVALID_REQUEST` `input_id must be a UUID` |
| `generation` | integer | ≥ 0 的安全整数（客户端停止代次） | `400 INVALID_REQUEST` `generation must be a non-negative integer` |
| `text` | string | 去空白后 1–1500 字符；服务端按 trim 后文本入库与提问 | `400 INVALID_REQUEST` `text must contain 1 to 1500 characters` |
| `media_refs` | — | **不接受**：文本路由不支持媒体引用 | `400 INVALID_REQUEST` `media_refs are not supported by the text conversation route` |

- 响应 `201`：`{ "data": { "request_id": "<uuid>", "stream_path": "/v1/requests/<uuid>/events" } }`
- 幂等：相同 `input_id` + 相同 `text` + 相同 `generation` → 返回同一 `request_id`，不重复调用 provider；`input_id` 被用于不同内容 → `400 INVALID_REQUEST` `input_id was already used for a different request`。
- 文本与图片共享同一 `input_id` 命名空间：同一 `input_id` 先用于文本再用于图片（或反向）同样按“不同请求”拒绝。

**`GET /v1/conversations/{session_id}/messages`**

- 响应 `200`：`{ "data": { "items": [ { "message_id": "<uuid>", "role": "user" | "assistant", "text": "<string>", "state": "completed" | "interrupted" | "cancelled", "created_at": "<ISO>" } ], "next_cursor": null } }`
- 图片问答只在此处留下**问题文本**与助手文本，永远不含图片字节。

**`POST /v1/requests/{request_id}/cancel`**

- 请求体：`{}`（可省略）
- 响应 `200`：`{ "data": { "status": "cancelled" } }`；未完成的请求会追加一条 `state=cancelled` 的助手消息并发出 `response.cancelled` 事件；已完成/已取消的请求不再重复发事件。

### 5.2 `POST /v1/conversations/{session_id}/image-responses`（新增）

请求体（**严格字段**，出现多余字段即 400）：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `input_id` | string | UUID；幂等键 |
| `generation` | integer | ≥ 0 的安全整数；客户端「停止代次」，随事件回传 |
| `question` | string | 去空白后 1–1500 字符；拒绝控制字符 / 零宽 / 双向控制符 |
| `image.mime` | string | 必须为 `image/png` |
| `image.base64` | string | 规范 base64（无 data URL 前缀、无换行、`= ` 填充规范） |
| `sanitized_sha256` | string | 脱敏后 PNG 字节的小写 SHA-256（64 hex） |
| `redaction_attested` | boolean | 必须为 `true`：客户端断言本机脱敏/门控已完成 |

示例：

```json
{
  "input_id": "0f0e0d0c-0b0a-4a49-8c8b-0a0908070605",
  "generation": 3,
  "question": "这个页面上的按钮是做什么的？",
  "image": { "mime": "image/png", "base64": "iVBORw0KGgo…" },
  "sanitized_sha256": "9f2c…64hex",
  "redaction_attested": true
}
```

响应 `201`：`{ "data": { "request_id": "<uuid>", "stream_path": "/v1/requests/<uuid>/events" } }`

- 相同 `input_id` + 相同问题/代次重复提交：幂等返回同一 `request_id`，不会二次调用 provider；若 `input_id` 被用于不同内容（包括先用文本路由再用图片路由）→ `400 INVALID_REQUEST`。

### 5.3 事件流（复用既有路由，逐字固化）

`GET /v1/requests/{request_id}/events` → `200`，`content-type: text/event-stream; charset=utf-8`；
每条记录一行为 `data: <ServiceStreamEvent JSON>`，记录之间以空行分隔（`\n\n`），连接在终态事件后结束。

`ServiceStreamEvent` 字段：`request_id`、`session_id`、`event_id`、`seq`（从 0 递增）、`generation`（回显请求的 `generation`）、`type`、`payload`。

| `type`（逐字） | 载荷 | 说明 |
| --- | --- | --- |
| `response.started` | `{}` | 已受理 |
| `caption.segment` | `{ "segment_id": "<uuid>", "index": <int>, "text": "<string>" }` | 按 4000 字符切片；按 `index` 顺序拼接即答案 |
| `response.completed` | `{ "final_segment_count": <int> }` | 正常结束 |
| `response.failed` | `{ "code": "TIMEOUT" \| "RATE_LIMITED" \| "PROVIDER_UNAVAILABLE", "retryable": <bool> }` | provider 失败；**不产生任何回答文本**，助手消息为 `state=interrupted, text=""` |
| `response.cancelled` | `{ "reason": "user_stop" }` | 由取消路由触发 |

桥接层必须按 `generation` 丢弃过期事件（停止后到达的结果不得渲染）。请求记录在结束后保留 5 分钟（`retentionMs`），随后删除。

### 5.4 校验顺序（全部在调用 provider 之前）

1. 鉴权（Bearer）→ `401`。
2. 会话归属（`session_id` 必须属于该账号）→ `403 PERMISSION_DENIED`；非 UUID → `400 INVALID_REQUEST`。
3. 字段集合 / 类型 / 长度 / 断言（含 `redaction_attested`、`question` 长度与控制字符）→ `400 INVALID_REQUEST`。
4. 高风险提问门（支付、密码、验证码、转账、远程控制、自动点击等，与单帧指引共用词表）→ `403 RISK_PAUSED`。
5. provider 图片能力（配置 + 模型）→ `503 PROVIDER_UNAVAILABLE`。
6. 每设备图片额度（20 / 60s）→ `429 RATE_LIMITED`。
7. PNG 结构校验（容器、CRC、无元数据块、尺寸、行滤波、inflate 精确长度）→ `400 INVALID_REQUEST`。
8. `sanitized_sha256` 与实际字节比对 → `400 INVALID_REQUEST`。
9. 创建请求并异步调用 provider。

### 5.5 上限

| 项目 | 上限 | 来源 |
| --- | --- | --- |
| PNG 字节数 | 2,000,000 | `redactedImageLimits` |
| base64 字符数 | 2,700,000 | `redactedImageLimits` |
| 单边像素 | 4096 | `redactedImageLimits` |
| 总像素 | 8,388,608 | `redactedImageLimits` |
| 问题长度 | 1500 字符 | `imageQuestionLimits` |
| 请求体 | 3 MiB | `http.ts` |
| 每设备图片请求 | 20 / 60s | `imageQuestionLimits.rateLimit` |
| provider 超时 | 45s（构造可覆盖，1–60000ms） | `text-conversation.ts` |
| provider 响应体 | 192 KiB；回答 ≤ 24,000 字符 | `text-conversation.ts` |

### 5.6 图片数据的使用与丢弃

- 图片字节**只**在请求生命周期内驻留内存：不写入会话消息、不写入任何事件、不回显在响应体、完成后立即从请求记录清除（请求记录本身 5 分钟后删除）。
- `/v1/conversations/{id}/messages` 只包含问题文本与助手文本，永远不含图片。
- 图片**不进入通用 hooks**：该路由在 `onRequest` / `onRoute` / `resolveActor` 中看到的请求体被替换为 `{ "image_response": true }`；设备会话路由同理替换为 `{ "device_session": true }`，其响应在 `onResponse` 中被替换为 `{ "device_session": true, "request_id": "…" }`，避免部署侧日志记录令牌。
- 服务端**不落盘**图片；图片会被发送到已配置的 provider 网关（HTTPS）。provider 侧的保留与训练策略由其自身条款决定，本项目未验证。

## 6. 错误码总表

| HTTP | code | 触发条件 | retryable | 客户端建议 |
| --- | --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | 字段缺失/多余、类型或长度错误、`redaction_attested` 非 true、PNG 非法或超限、SHA-256 不符、UUID 非法、请求体过大 | false | 修正请求；不要重试同一字节 |
| 401 | `AUTH_FAILED` | 未带令牌、令牌已撤销、挑战未知/重复/签名错误 | false | 走 §4 刷新；刷新被拒则清空会话 |
| 401 | `AUTH_EXPIRED` | access/refresh/挑战过期、设备绑定不再有效 | false | 走 §4 刷新或重新绑定 |
| 403 | `PERMISSION_DENIED` | 会话不属于当前账号 | false | 不要重试 |
| 403 | `RISK_PAUSED` | 提问涉及高风险操作 | false | 本地提示暂停，不上传 |
| 429 | `RATE_LIMITED` | 请求过快（见 §3.5 / §5.5） | true | 按 `Retry-After` 退避 |
| 503 | `PROVIDER_UNAVAILABLE` | 服务端未配置 provider 或未配置图片能力 | false | UI 显示「未接入」，不回退演示 |
| 404 | `INVALID_REQUEST` | 路由不存在 | false | — |
| 500 | `PARTIAL_FAILURE` | 未预期内部错误（不回显上游正文） | true | 有限重试 |

事件流内的 `response.failed.code` 使用同一词表的一个子集：`TIMEOUT` / `RATE_LIMITED` / `PROVIDER_UNAVAILABLE`。

## 7. 威胁模型

资产：设备密钥（`device_secret`）、设备会话令牌、脱敏后的 PNG、问题文本、账号 ID。

| # | 威胁 | 缓解（本次实现） | 残余风险 |
| --- | --- | --- | --- |
| 7.1 | 令牌经 WebView/JS 泄漏（本方案的核心动机） | 桥接白名单只暴露提问/取消/状态；令牌只存原生加密存储；服务端不回显令牌 | 桥接实现质量属 B2，未真机验证 |
| 7.2 | 令牌进入服务端日志/遥测 hooks | 设备会话请求体与响应体在通用 hooks 中被掩码；错误消息从不包含令牌或上游正文 | 部署侧若自行打印原始 HTTP 仍可能泄漏；未部署验证 |
| 7.3 | 挑战重放 | 挑战一次性（`used_at`）、2 分钟 TTL、绑定单一设备与账号 | 无（重放路径已被拒绝） |
| 7.4 | 刷新令牌被盗后无限续期 | 新通道刷新**必须**提供设备签名（挑战绑定同一设备）；每次刷新轮换 refresh token；旧令牌立即失效 | 见 §7.14 已知缺口（旧免签刷新路由仍在） |
| 7.5 | 暴力猜测签名 | HMAC-SHA256（256 位密钥）+ 挑战一次性 + 每设备/每客户端限流 | 无实际可行路径 |
| 7.6 | 被盗令牌刷取 provider 额度（成本攻击） | access 10 分钟、刷新轮换、每设备图片 20/60s、刷新 10/60s | 多设备/多 IP 分布式滥用只能靠上游配额 |
| 7.7 | 未脱敏图片上传 | `redaction_attested` 断言 + `sanitized_sha256` 绑定 + 结构/体积/元数据校验 | **服务端无法验证脱敏本身**；这是客户端断言，真机脱敏效果必须由 B2/C 与线下验收证明 |
| 7.8 | 图片在服务端长期驻留 | 请求完成即清除字节，不落盘、不进消息、不进 hooks；请求记录 5 分钟后删除 | 进程内存转储、core dump 等宿主机级风险不在本层防护内 |
| 7.9 | 静默回退到演示数据 | 无任何 fallback 分支：未配置/无能力 = `503`；provider 失败 = `response.failed`，助手消息 `state=interrupted` 且 `text=""` | 无（测试断言覆盖） |
| 7.10 | 恶意/畸形 PNG 导致解码 DoS | base64 与字节双上限、边长与像素上限、CRC 校验、拒绝元数据块、`inflateSync` 限定 `maxOutputLength`、3 MiB 请求体上限、每设备限流 | 4096×4096 级合法图的解码开销仍存在，由限流约束 |
| 7.11 | 限流被绕过或误伤（代理后所有客户端同一 IP） | 默认用 socket 对端地址；`NUANBAN_TRUST_PROXY_HEADERS=true` 时采信 `X-Forwarded-For` 首段裸 IP 并校验为合法 IP | 反向代理未开启该开关时，限流会退化为全局桶；部署时必须显式选择 |
| 7.12 | 撤销后令牌继续可用 | 每次请求都实时查会话记录与设备状态；撤销立即生效（access token 也不例外） | 多实例部署需共享存储（当前会话在 SQLite/内存中，进程内一致） |
| 7.13 | 上游错误正文/密钥泄漏到客户端 | provider 错误被归一为固定错误码；错误消息为服务端常量，不含上游正文、密钥、令牌 | 无（测试断言覆盖） |
| 7.14 | **已知缺口（后续项）**：旧 `/v1/auth/refresh` 不要求设备签名 | 仅影响**旧桌面/网页通道**（为兼容现有客户端保留，行为未改动）；新设备会话通道强制设备签名；B2 适配器**只允许**走 `/v1/device-sessions/*`，不得回退旧刷新路径 | 持有 refresh token 的一方仍可通过旧路由轮换（少了设备密钥这一因素）。彻底收窄需给会话记录加策略标记（`legacy-allowed` / `device-signature-required`），涉及 SQLite 表结构 + 迁移 + `packages/contracts` 生成物，已登记为任务板 **task-5（B3）**，不在本次写范围内 |

## 8. 配置与部署前置（本次未执行）

运行期环境变量（服务端进程，不得写入 `VITE_*`、仓库或前端产物）：

| 变量 | 作用 |
| --- | --- |
| `NUANBAN_AI_BASE_URL` | OpenAI 兼容网关（必须 https，自动补 `/chat/completions`） |
| `NUANBAN_AI_MODEL` | 文本模型 |
| `NUANBAN_AI_VISION_MODEL` | 可选，图片模型；缺省用 `NUANBAN_AI_MODEL`；非法值回退到基础模型而不是关闭通道 |
| `NUANBAN_AI_API_KEY` | 密钥（≥10 字符，只存在服务端） |
| `NUANBAN_TRUST_PROXY_HEADERS` | `true` 时才采信 `X-Forwarded-For`（仅在受信反代后开启）；由 `createApplication` 读取进程环境，也可用同名选项覆盖 |
| `NUANBAN_SERVER_STORAGE` / `NUANBAN_SERVER_DB_PATH` | 沿用既有存储选择（会话/挑战记录使用既有表结构，本次无 schema 变更） |

未配置 `NUANBAN_AI_*` 时：文本与图片问答均拒绝（文本走事件流失败、图片在提交阶段 `503`），不影响既有其他路由。

部署前置（由 lead 在所有者同意后进行，本次未做）：配置上述变量 → 重启服务 → 用合成账号跑一遍 §4/§5 流程 → 检查 `deviceVerified=false` 的真机项另行安排。

后续项：若部署需要不同的会话时长或限流额度，需在 `main.ts` 增加对应环境变量读取（当前只能通过 `createApplication` 选项覆盖）。

## 9. 测试与验收证据

命令与结果（本机合成请求，2026-10-23）：

- `pnpm typecheck` → exit 0。
- `pnpm exec vitest run tests/server` → 11 个文件、**335 个测试全部通过**（其中本次新增 64 个）。

本次新增测试：

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `tests/server/device-session.test.ts` | 25 | 签发/一次性挑战/错误签名/过期挑战/设备撤销、签名刷新与轮换、失败签名不消耗令牌、跨设备挑战拒绝、刷新过期、撤销幂等、`revoke_device`、令牌不回显、三类限流（含“限流不烧令牌”）、请求校验、服务端配置校验 |
| `tests/server/device-session-http.test.ts` | 5 | 真实 HTTP 全流程（签发→业务请求→签名刷新→旧令牌失效→撤销→401）、短 TTL 过期与恢复、hooks 不出现设备密钥/令牌、429 + `Retry-After` + 结构化 details、畸形 JSON/未知字段/未知挑战/错误签名/重复挑战的状态码与消息 |
| `tests/server/image-question-http.test.ts` | 34 | 已配置 provider 的完整问答与 SSE 事件、图片数据 URL 与问题透传、消息只存文本、hooks 掩码、幂等重放、provider 失败事件与 `interrupted` 消息、取消、未认证、过期/撤销会话、越权会话、16 类拒绝（含字节/边长/base64 超限、畸形 PNG、校验和不符、断言缺失、控制字符、超长问题）、高风险 `RISK_PAUSED`、未配置 `503`、无图片能力 `503`、图片限流 429、3 MiB/1 MiB 请求体边界、文本路由 `media_refs` 回归 |

未验证项（不得当成已验收）：真机 Android 桥接与加密存储（task-2）、真实供应商图片问答、部署后的真实 HTTP 路径、反代后的真实客户端 IP、长时间运行下的限流与内存行为。

### 9.1 已知的既有红灯（与 B1 无关，已在 HEAD 复现）

`tests/acceptance/release-readiness.test.ts` 的两个关闭性检查在本机 **HEAD 版本**上就是失败的，B1 未加剧也未修复：

- `SERVER_EXTERNAL_MODULES_UNMOUNTED`：该门禁要求 `main.ts` 中唯一的 `createApplication(...)` 只出现 `storage` 与 `standaloneGuidance` 两个属性；HEAD 的 `main.ts` 已含 `webOrigins`，因此判定为 false（与 B1 无关；本次交付把 `main.ts` 保持为 HEAD 内容不变）。
- `ANDROID_CLOSED`：门禁要求 `NativeCaptureRuntime.kt` 含 `val gate = LocalFrameGate()`、`NativeCaptureService.kt` 含 `gate.inspect(frame, null,`，当前 HEAD 的两处正则均不匹配。
- 以上判定在 HEAD 内容上用过同一套 TS AST / 正则复算确认；这两个检查覆盖的文件本次均未修改，门禁脚本与 acceptance 测试也不在本任务写范围内（未改动）。
- 另：`tests/platform`、`tests/e2e` 等目录当前存在其他同事在途改动导致的红灯，同样不属于 B1 交付范围。B1 的回归范围（`tests/server`、`tests/acceptance`、`tests/contract`、`tests/integration`、`tests/provider`）中，除上述两个既有项外全部通过（见 §9 表格与报告）。

## 10. 设备绑定入口（配对）缺口与前置条件

**现状（B1 交付时的显式缺口）**：B1 只提供 §3 的会话端点，它们都要求设备**已经绑定**——
`POST /v1/device-sessions/challenges` 的 `binding_id` 必须是已存在的 `device_id`（`auth.bindDevice` 的产物），
`device_secret` 也由绑定阶段产生。B1 **没有**任何配对码/邀请码签发端点，也没有面向真机的绑定引导路由。

因此：

- B2 的原生 `ModelAccessBinder.bind()` 目前只能在**已经拿到 `device_id` + `device_secret`** 的前提下工作；
  真机默认没有这两个值 → 绑定无法完成 → 会话无法签发 → UI 必须停留在「未接入」（fail-closed，符合预期，不是缺陷回退）。
- 服务端当前**没有**任何“一次性配对码 / 邀请码”端点；`/v1/relations/invitations` 是家属关系邀请，与设备绑定无关，不得复用为设备配对。

**所有者决策（2026-10-23）**：配对方式采用**桌面显示一次性配对码**，服务端部分由任务板 **task-6（B4）** 交付，
写范围与 B1 相同（`apps/server/src/**`、`tests/server/**`、本文档）。其接口位置与不变量（供 B2/桌面端对齐，尚未实现）：

| 端点 | 调用方 | 语义 |
| --- | --- | --- |
| `POST /v1/device-pairings`（建议路径，待 task-6 定稿） | 已认证的桌面/网页会话（Bearer） | 签发一次性配对码；**短期 ≤10 分钟**、一次性、限流、服务端只存哈希；明文码只在签发响应出现一次，之后不可再读 |
| `POST /v1/device-pairings/{code}/claim`（建议路径，待 task-6 定稿） | 安卓原生（无需既有令牌，携带新 `device_id` + 配对码 + 用 `device_secret` 做的 HMAC 签名） | 核销配对码并完成设备绑定；核销即失效；返回 §3.2 形态的受控会话 |

不变量（B1 已确立，task-6 必须沿用）：HMAC-SHA256 设备签名语义（§3.1）、结构化错误码（§6）、
限流与 `Retry-After`（§3.5）、令牌不回显/不进 hooks（§7.1、§7.2）、服务端不记录明文配对码（不得出现在日志、错误消息或证据文件里）、
未知/过期/已核销的码统一返回不泄露区分信息的结构化拒绝。

在 task-6 落地前，任何文档、APK 或验收记录都不得声称「安卓已能接入真实模型」；本节的缺口必须在 B4 完成后由新版本本文档替换。

## 11. 变更记录

- 2026-10-23：B1 首次实现（设备会话 + 图片问答 + 测试 + 本文档）。未部署、未真机验收。
- 2026-10-23（文档修订）：逐字固化文本/图片端点字段、SSE 事件名与 401 语义；登记「设备绑定入口缺失」缺口与 task-6（B4）配对接口位置。