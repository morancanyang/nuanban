# 微光指引 · Windows 桌面客户端下载产物（未签名开发包）

> **2026-10-23 r15：** 修复"云分析服务暂不可用"。现场 trace 显示请求 11 秒后以 `providerCode=PROVIDER_UNAVAILABLE` 失败，而同一分钟本机实测网关 `GET /models` 与连续三次对话请求均 200（另有 GitHub TLS 握手失败），属于**偶发 5xx/网络抖动**。模型端口现在只对**可恢复失败**做有界重试：网络异常、HTTP 429/5xx、响应中断最多重试 2 次（退避 0.6s/1.6s，共享原有 60s 超时预算）；鉴权失败、非法请求、取消与超时仍只尝试一次。文案与 trace 会说明"已做有界自动重试"并记录 `attempts`；`retryAttempts`/`retryDelaysMs` 可配置。验证：17 个相关测试文件 **1178/1178** 通过、`tsc --noEmit` 0、打包校验 `matches: true`，r14→r15 的 zip 条目仅 `resources/app.asar`（+2,130 字节）变化。旧 r14 包已从下载目录移除。
>
> **同批 Android 包（2026-10-23 21:10 发布）：** 独立桌宠包修复了"打开桌宠只有'微光指引'四个字、没有形象"——悬浮层由 `TextView` 改为 `ImageView` 并随包携带产品默认"花环水獭"本地静态形象（`res/drawable-nodpi/nuanban_pet_preview.png`，资源只进独立源集，普通包不携带）；两包同时同步了最新共享 UI（14 个文件，含 Lili/Lumi 资源）。打包隔离校验 **89/89**（新增"普通包无形象资源/独立包有形象资源"两项）。
>
> **来源与可复现性说明：** 这一对 APK 由并行同事在含**未提交改动**的工作区中构建（其 Android 形象修复当时未提交 git；共享 UI 里含 Codex 的 Lili/Lumi 未提交改动），因此**无法仅凭 HEAD 精确复现**；且 debug 签名包含构建时间戳，**每次重编哈希都会变化**（21:11 本地重编即为 `b14803ed…/3b196f0a…`，与线上这对不同）。上表记录的是**线上实际文件**的哈希与大小。两包仍为 debug、未做真机安装/悬浮窗/麦克风验收（`deviceVerified=false`）。
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
| 便携 zip（推荐分发物） | `C:\Users\33864\Desktop\nuanban\apps\desktop\out\dist\NuanbanDemo-0.1.0-win32-x64-portable-20261023-r15.zip` | 182,120,748 字节（173.652 MiB） | `5f547288f2da5cbe5dbe5e8a601a6f9e584801acbecc83a704c36e29cc642e8d` |
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
   `(Get-FileHash 'C:\Users\33864\Desktop\nuanban\apps\desktop\out\dist\NuanbanDemo-0.1.0-win32-x64-portable-20261023-r15.zip' -Algorithm SHA256).Hash`
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
& $sevenZip a -tzip -mx=5 'dist\NuanbanDemo-0.1.0-win32-x64-portable-20261023-r15.zip' 'NuanbanDemo-win32-x64'
Pop-Location

# 4) 校验
(Get-FileHash 'apps\desktop\out\dist\NuanbanDemo-0.1.0-win32-x64-portable-20261023-r15.zip' -Algorithm SHA256).Hash
node scripts/check-d03-candidate.mjs
```

> 本文件记录的是 2026-10-22 这一次构建的产物；重新构建后路径/大小/哈希都会变化，需要重新生成 `SHA256SUMS.txt` 与本说明。若产物内容或版本变化，本文件的“未签名、未真机验收、不是正式发布”结论必须重新评估。

## 10. Android 构建产物（冻结版：2026-10-23 21:10 线上发布，debug 包）

> 冻结版为 **2026-10-23 21:10 通过一次性上传通道发布到试验服务器的那一对**；下表大小与哈希记录的是**线上实际文件**。**debug 签名、未做 release 签名、未做真机验收**，与第 1 节的“未签名/未验收”边界一致。

| 产物 | 绝对路径 | 大小 | SHA256 | 变体 |
| --- | --- | --- | --- | --- |
| 普通客户端 `:app` | `apps\android\app\build\outputs\apk\debug\app-debug.apk` | 7,570,810 字节（7.22 MiB） | `5AE9627325135EFB74281DAE8DDA2883C97355DAE924BE109E66AEC9817545F9` | debug，包名 `org.nuanban.assistant` |
| 独立桌宠宿主 `:standalone` | `apps\android\standalone\build\outputs\apk\debug\standalone-debug.apk` | 90,449,913 字节（86.26 MiB） | `1428CEB8C6A021D212B7789BFFB7E3E3897F465476AFBD1ED9249DB6B042E6DB` | debug，包名 `org.nuanban.assistant.standalone` |

- 构建来源（2026-10-23）：`node scripts/sync-android.mjs` 把 `apps/web/dist`（2026-10-23 20:54 构建，14 个文件，含 Lili/Lumi 资源）同步到 `app/src/main/assets/ui`；随后离线执行 `apps/android/check-standalone-packaging.ps1` 重编 `:app` 与 `:standalone` 并做打包隔离校验（`BUILD SUCCESSFUL in 39s`）。构建完成后未再改动 APK。
- 两者均通过 `apksigner verify`（v2 scheme）与 `zipalign -c 4`；签名证书为构建机 `~/.android/debug.keystore` 的 Android Debug 证书，不能用于正式分发。
- 共享 UI：构建时使用的 `assets/ui` 快照共 **14 个文件**（含 Lili/Lumi 资源；`index.html` 引用 `assets/index-DZjAi1Wj.js`、`assets/index-CeTjnOdW.css`），该快照仍保存在 `apps/android/app/src/main/assets/ui`，可离线复核。注意：2026-10-23 21:11 本地另有一次重编，注入了更新的未提交共享 UI（`assets/index-BWNOxrR6.js` 等），**不属于本冻结版**。
- **真机验收条件不具备**：无真机/模拟器连接，未安装、未抓屏、未录音、未调用云服务；通知、精确闹钟、悬浮窗、MediaProjection 前台服务、OCR/后台提醒均未验证。构建成功不等于真机可用。
- 距可发布仍缺：release 签名与 release 构建（无 signingConfigs/minify/AAB）、版本号仍为 demo/validation、商店政策与隐私合规、standalone 86.26 MiB 体积优化。
- 与桌面端相同：**不要把 APK 提交到 git**（`build/` 已被忽略）。2026-10-23 已通过一次性上传通道发布到 `http://59.110.19.225/downloads/nuanban-android-app-debug.apk` 与 `http://59.110.19.225/downloads/nuanban-android-standalone-debug.apk`，服务器端逐个校验 SHA256 一致。
- 打包隔离校验（`apps/android/check-standalone-packaging.ps1`）通过 **89/89**：普通包不含 `INTERNET`/悬浮窗/前台服务/采屏权限与 nativehost 类，独立包含全部相关权限与 6 个组件，独立包 39 个 OCR/人脸模型资产指纹与 `AndroidScreenPolicy.MODEL_FINGERPRINT` 一致，普通包不含桌宠形象资源、独立包含该资源，且不含自动 CCT 传输后端。
- **冻结说明**：本表冻结版为线上已发布的一对（`5ae96273…` / `1428ceb8…`）。2026-10-23 21:11 本地重编得到 `b14803ed…` / `3b196f0a…`，与线上双包内容不同（含更新的未提交共享 UI），**不是发布版本，不得对外分发**；debug 包每次重编哈希都会变化，冻结后不再重编、不再重新上传。
- `zipalign -c 4` 与 `apksigner verify` 对两个包均返回 0（v2 scheme，单一 debug 签名者）。
