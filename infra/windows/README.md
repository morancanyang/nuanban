# 微光指引 · Windows Server 部署（阿里云 ECS 试验托管）

> 文档日期：2026-10-22。这是**所有者在自有 ECS 上运行的试验托管**脚手架，不是正式发布，也不构成 D07/F19 的部署签收。产品能力边界以 [product-current-state.md](../../docs/implementation/product-current-state.md) 和 [external-capabilities.md](../../docs/implementation/external-capabilities.md) 为准。

## 目标形态

```
公网 :80 (IIS)
├─ /                     静态站点 = apps/web/dist（HashRouter，无 SPA 回退需求）
└─ /healthz, /v1/*       同源反向代理 → 127.0.0.1:3000（Node API，SQLite）
   /internal/*           不代理，不对外暴露
```

- **静态站点**：`apps/web/dist` 使用相对路径（`base: './'`），可部署在站点根或任意子路径。
- **后端**：`apps/server` 直接用 `node --experimental-transform-types src/main.ts` 运行，无 node_modules 依赖；源码相对引用 `packages/*/src`，因此部署目录保持同级结构。
- **存储**：`NUANBAN_SERVER_STORAGE=sqlite`，数据库固定在 `C:\nuanban\data\server.sqlite`（仓库外）。
- **开机自启**：计划任务 `NuanbanServer`（SYSTEM，开机触发，无限时长）。任务运行 `start-server.ps1`：它持有 `Global\NuanbanServer` 互斥量（防重复实例），并在内部守护 Node 进程——崩溃后 5 秒（连续失败退避到 15/30 秒）自动重启。本机实测杀进程后约 3 秒恢复。
- **反向代理**：需要 IIS URL Rewrite + Application Request Routing（ARR）。两者装不上时后端只监听回环，站点仍可访问，部署脚本会记录 `proxyNote`。

## 目录约定（服务器上）

```
C:\nuanban\
├─ web\            当前静态站点（IIS 物理路径，上一版保留为 web.prev）
├─ app\            当前后端源码树（上一版保留为 app.prev）
├─ scripts\        deploy-server.ps1 / start-server.ps1
├─ data\           server.sqlite
├─ logs\           deploy-*.log、deploy-result.json、server.log
└─ staging\        payload.zip、chunks-<stamp>\（传输中转）
```

## 部署流程

1. **准备产物**（本机）

```powershell
pnpm --filter @nuanban/web build     # 生成 apps/web/dist
node infra/windows/tools/package-payload.mjs
```

2. **准备凭据**（本机，不提交）

RAM 用户只授予所需 ECS 权限，写入 `.cache/aliyun-ak.json`（已被 `.gitignore` 忽略）或使用环境变量：

```powershell
$env:ALIYUN_ACCESS_KEY_ID='<id>'
$env:ALIYUN_ACCESS_KEY_SECRET='<secret>'
```

最小权限策略（临时授予，部署完成后删除 AK）：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeInstances",
        "ecs:DescribeCloudAssistantStatus",
        "ecs:DescribeSecurityGroupAttribute",
        "ecs:AuthorizeSecurityGroup",
        "ecs:DescribeSendFileResults",
        "ecs:SendFile",
        "ecs:RunCommand",
        "ecs:DescribeInvocationResults"
      ],
      "Resource": "*"
    }
  ]
}
```

3. **先只读检查**（不写任何东西）

```powershell
node infra/windows/tools/deploy-windows.mjs --instance i-2zedkag2x1e9e610v8jh --inspect-only
```

输出实例状态、OS、公网 IP、安全组 80 端口是否开放、云助手在线状态。

4. **正式部署**

```powershell
node infra/windows/tools/deploy-windows.mjs --instance i-2zedkag2x1e9e610v8jh --open-port
```

- `--open-port` 会在安全组放行 `tcp/80`（`0.0.0.0/0`）；不加该参数时若 80 未开放会直接失败，不会偷偷改安全组。
- `--skip-proxy` 跳过 ARR/URL Rewrite 安装，后端仅限回环。
- 传输方式：`SendFile` 分块（单次内容 base64 ≤ 32 KB），每块 20 000 字节，约 100 块，并发 4。

5. **服务器上手动重跑**（排障用）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\nuanban\scripts\deploy-server.ps1 -Root C:\nuanban
Get-Content C:\nuanban\logs\deploy-result.json -Raw
```

## 验证

| 检查 | 期望 |
| --- | --- |
| `http://<公网IP>/` | 200，`<div id="root">`，静态资源 200 |
| `http://<公网IP>/models/lumi/character_manifest.json` | 200，`application/json` |
| `http://<公网IP>/healthz` | 200，`storage=sqlite`（需代理成功） |
| `http://<公网IP>/v1/relations`（无令牌） | 401 |
| `http://<公网IP>/internal/desktop/voice/status` | 不代理，返回静态 404 |
| `C:\nuanban\logs\server.log` | 有监听日志，无崩溃重启循环 |

## 回滚

```powershell
# 只回滚静态站点
Move-Item C:\nuanban\web C:\nuanban\web.broken -Force
Move-Item C:\nuanban\web.prev C:\nuanban\web -Force
iisreset /noforce

# 回滚后端
Stop-ScheduledTask -TaskName NuanbanServer
Move-Item C:\nuanban\app C:\nuanban\app.broken -Force
Move-Item C:\nuanban\app.prev C:\nuanban\app -Force
Start-ScheduledTask -TaskName NuanbanServer
```

数据库不做自动回滚：`data\server.sqlite` 在升级前请手工复制备份。

## 安全与边界

- 后端只绑定 `127.0.0.1`，公网仅经 IIS 代理；`/internal/*` 不代理。
- 公网前端按 `VITE_API_MODE=local` 构建：不内联 `VITE_API_TOKEN`，不启用真实供应、屏幕采集、麦克风或云分析。桌面端能力不因这次部署而改变。
- 站点 `web.config` 已关闭目录浏览、补齐 `.glb/.vrm` MIME、加 `nosniff` 与 `Referrer-Policy`。
- 凭据只存在于本机 `.cache/aliyun-ak.json` 或进程环境变量；仓库与产物中不含密钥。
- 本部署**不**等于：正式发布、生产数据库、真实账号/供应、备份恢复演练、签名与回滚演练、D07 Go。

## 已知限制

- ARR/URL Rewrite 的 MSI 来自 `download.microsoft.com`；若 ECS 出网受限，代理会跳过，需手工安装后重跑部署脚本。
- Node.js LTS MSI 优先从 `cdn.npmmirror.com` 下载（国内可达性更好），失败后退到 `nodejs.org`。
- 计划任务不是 Windows 服务：`start-server.ps1` 自带守护循环与互斥量，能在 Node 进程崩溃时拉起；但任务本身被停掉时不会自愈，需要重新 `Start-ScheduledTask`。
- **IIS kernel-mode 输出缓存**：IIS 默认开启内核缓存，会按 URL 记住 `/`（默认文档）的响应，导致换版后仍返回旧 `index.html`（实测：新文件已就位但 `/` 返回 599 字节旧页，`/index.html` 正常）。部署脚本现在会在站点级关闭 `enableKernelCache` 并在每次部署后 `iisreset /noforce`；`infra/iis/web.config*` 也显式写了 `<caching enabled="true" enableKernelCache="false" />`。若手工换文件，记得回收 IIS 或关掉内核缓存。
- 日志 `server.log` 为 UTF-8 追加，Node 的 stdout/stderr 都合并进去；`logger` 侧不做轮转，只在启动时把超过 20 MB 的旧日志改名为 `server.log.1`。
- 首次部署需要 ECS 出网（Node MSI、可选代理 MSI）；离线主机可用 `-SkipNodeInstall` 并把 MSI 预先放到 `C:\nuanban\staging`。

## 服务端真实模型网关（可选，默认关闭）

服务端有两条能力需要供应商：浏览器/服务端文本对话（读 `NUANBAN_AI_BASE_URL`、`NUANBAN_AI_MODEL`、`NUANBAN_AI_API_KEY`）和单帧指引（读 `NUANBAN_VISION_*`）。未配置时两条路由都返回 503，不回落固定答案或模拟对话。

配置方式（密钥只落服务器，不进仓库/前端/产物）：

```powershell
# 首选项：从环境变量读取密钥，避免 shell 历史
$env:NUANBAN_VISION_API_KEY='<key>'
node infra/windows/tools/configure-vision-provider.mjs `
  --instance i-2zedkag2x1e9e610v8jh `
  --base-url https://<openai-compatible-gateway>/v1 `
  --model <text-model> --vision-model <vision-model>
```

工具行为：把 `{baseUrl, model, visionModel, apiKey}` 经云助手 `SendFile` 写到 `C:\nuanban\config\vision-provider.json`，用 `icacls` 锁成 `SYSTEM`/`Administrators` 可读，然后重启守护任务，由 [start-server.ps1](start-server.ps1) 在启动时读入并映射为 `NUANBAN_AI_*` 与 `NUANBAN_VISION_*` 环境变量。日志只记录 base/model，不记录密钥。

- 约束：`--base-url` 必须 HTTPS；服务端自己还会拒绝 URL 内凭证、query、fragment、私网/回环主机与 IP 字面量（见 `apps/server/src/standalone-guidance.ts`）。
- 轮换：重跑上面的命令即可（会覆盖并重启）。清除：加 `--clear`，服务重启后路由回到 503。
- 说明：`NUANBAN_AI_*` 对应的工作区对话实现尚未提交（见仓库当前未提交改动）；已部署的提交版后端只使用 `NUANBAN_VISION_*` 的单帧指引路由。
- 计费与合规：真实供应商会产生费用并接收脱敏后的文本/单帧图像，属于所有者自担的外部条件，不能写成已验收供应。

**当前线上状态（2026-10-22 22:39，Asia/Shanghai）**：已配置真实供应商 `https://api.openai-next.com/v1`，文本与视觉模型均为 `gpt-4o-mini`；密钥只存在于服务器 `C:\nuanban\config\vision-provider.json`（`SYSTEM`/`Administrators` 可读），服务日志只记录 base 与 model。实测：ECS 本机 `GET /models` 与 `POST /chat/completions` 均返回 200（服务器出网访问该网关正常）；`/v1/standalone/guidance/analyze`、`/v1/conversations` 无令牌均返回 401。**浏览器端仍无法自建会话**：公网 HTTP 表面只有 `device-challenges`/`device-exchange`/`refresh`，没有账号或设备引导路由，网页在 `VITE_API_MODE=local` 下继续按设计报“没有桌面模型接口”。要让网页 AI 可用，需要新增受控的会话引导（邀请码 + 速率限制 + 本地保存令牌/刷新）并重新构建前端，属于产品代码改动，未包含在本次部署。

## 下载分发（`/downloads`，无需 OSS）

大文件（桌面包 173.6 MiB、Android 包 88 MiB）不通过云助手分块传输，而是临时开一条**只在部署机侧经过 IIS 反代、接收端只监听 127.0.0.1 且带随机令牌**的上传通道：

```powershell
node infra/windows/tools/push-downloads.mjs --instance i-2zedkag2x1e9e610v8jh
```

流程与安全属性（[push-downloads.mjs](tools/push-downloads.mjs)、[upload-receiver.mjs](tools/upload-receiver.mjs)）：

1. `SendFile` 下发 150 行左右的接收进程、随机令牌与临时 `web.config`（只给 `/_upload/*` 加一条反代规则，并提高该次请求的体积上限与代理超时）；
2. 本机把产物流式 POST 到 `http://<公网IP>/_upload/<name>`，带令牌头；接收端校验文件名、流式落盘并返回大小与 SHA256；
3. 服务器端重新计算 SHA256 并与本机比对，不一致立即失败；
4. 无论成败都恢复原 `web.config`、停掉接收进程、`iisreset`、删除令牌文件；成功时把文件移入 `C:\nuanban\web\downloads\` 并生成下载页；
5. 之后只通过只读静态目录对外提供下载，`.zip`/`.apk` MIME 已在 `infra/iis/web.config*` 中补齐。

本次已发布（2026-10-22 起；Android 两包于 2026-10-23 用最新共享 UI 重新构建并覆盖发布）：

| 产物 | URL | 大小（字节） | SHA256 |
| --- | --- | --- | --- |
| Windows 桌面便携包（未签名） | `http://59.110.19.225/downloads/NuanbanDemo-0.1.0-win32-x64-portable-20261024-r24.zip` | 197342127 | `8b50b68b53d00d4b993e8ef8f1eb607ed834a3931f30fa8d15ed50bf3aba2c5a` |
| Android 普通客户端（debug） | `http://59.110.19.225/downloads/nuanban-android-app-debug.apk` | 7,299,930 | `1edbb6b70fa5fe70bd69e41d2565d57af1845116994d773a5a75916424f9517b` |
| Android 独立桌宠（debug） | `http://59.110.19.225/downloads/nuanban-android-standalone-debug.apk` | 90,449,909 | `0b5b0e3daf440b27a9fb6b4e09a08c3006995555883718ce3e48ab9a0ea3449c` |
| 下载页 | `http://59.110.19.225/downloads/` | — | 页面内联同样哈希 |

注意：产物**未签名、未做真机/安装验收**；Windows 会有 SmartScreen 警告；不要把下载目录当可执行目录（IIS 只做静态读取）。上传通道是一次性的，成功/失败都会自动关闭，不要把它当成长期上传入口。

## 实际部署记录（2026-10-22，Asia/Shanghai）

本节记录**本次真实执行过的一次部署**及其实测结果，不是发布签收。

| 项 | 值 |
| --- | --- |
| 实例 | `i-2zedkag2x1e9e610v8jh` / `izx1e9e610v8jhZ`，cn-beijing，Windows Server 2022 数据中心版 64 位中文版 |
| 公网 / 私网 | `59.110.19.225` / `172.28.202.135` |
| 安全组 | `sg-2zedkag2x1e9e611a1l3`：新增入方向 `tcp/80`（`0.0.0.0/0`）；原有 22、3389、ICMP |
| Web 服务器 | IIS 10.0，`Default Web Site` → `C:\nuanban\web`，端口 80 |
| Node | v24.22.1（`cdn.npmmirror.com` LTS MSI 静默安装） |
| 反代 | URL Rewrite 2.1 + ARR 3.0，服务器级 proxy 已启用；仅 `/healthz`、`/v1/*` 反代到 `127.0.0.1:3000` |
| API | 127.0.0.1:3000，SQLite `C:\nuanban\data\server.sqlite`（`NUANBAN_SERVER_ENV=production`） |
| 服务 | 计划任务 `NuanbanServer`，开机触发，SYSTEM/Highest，守护循环 + `Global\NuanbanServer` 互斥量 |
| 部署包 | 90 个文件 / 2.07 MB，104 个 20 000 字节分块经 `SendFile` 下发，约 6 秒 |

实测结果（从本机对 `http://59.110.19.225` 发起，10/10 通过）：

| 请求 | 结果 |
| --- | --- |
| `/` | 200 `text/html`，含 `<div id="root">` |
| `/assets/index-*.js`、`index-*.css`、`viewer-*.js` | 200，MIME 正确 |
| `/models/lumi/Lumi_Magical_Kitten.glb` | 200 `model/gltf-binary` |
| `/models/lumi/poster.png` | 200 `image/png` |
| `/healthz` | 200 `{"status":"ok","service":"nuanban-server","storage":"sqlite"}`（经 IIS→ARR 同源代理） |
| `/v1/relations`（无令牌） | 401 JSON |
| `/internal/desktop/voice/status` | 404（未代理，符合预期） |
| 响应头 | `X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin` |

其他实测：杀掉 API 进程后守护循环约 3 秒拉起（单进程、单监听）；一次目录交换失败的真实事故中，部署脚本的失败自恢复把 `web.prev`/`app.prev` 还原并重启 W3SVC，站点恢复 200；部署后磁盘剩余 24.7 GB。

**本次没有做、也不代表**：域名与 HTTPS、备份/恢复演练、真实账号与供应商、性能与并发压测、签名安装包、D07 Go 或 F19 签收。公网前端仍按 `VITE_API_MODE=local` 构建，浏览器端不启用真实模型、屏幕采集或麦克风（fail closed）。

**部署批次备注（2026-10-22 22:29）**：该批次按所有者要求，把工作区中另一条会话的未提交改动（网页端对话接后端、browser companion、ID fallback 等）一并构建上线，同时包含本次 `createWebId` 修复、服务端供应商配置通道与 IIS 内核缓存修复。由于工作区 dirty，产物**不能仅凭 manifest 里的 commit `3280ad7` 重建**；正式留档前应先提交这些改动再重新部署。实测：`/` 返回新构建（618 字节），待办创建成功且无 `crypto.randomUUID` 报错，`/v1/requests/<id>/events` 未认证返回 401（新路由已生效），`/internal/*` 仍不代理。浏览器对话在 `local` 模式下仍显示“当前没有桌面模型接口”，因为 `RemoteConversation` 只在 `VITE_API_MODE=real` 且配置了访问令牌时启用，而把设备令牌打进公开 JS 不符合安全边界。

**遗留清理项**：安全组 3389 仍对 `0.0.0.0/0` 开放，建议改为固定出口 IP；本次使用的临时 RAM AccessKey（用户 `zhaosheng`）应在确认不再部署后禁用或删除。
