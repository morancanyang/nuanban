# 微光指引 · Windows 本地观察适配

> 文档同步：2026-10-22。产品显示名称为**微光指引**；[当前功能与平台边界](../../../docs/implementation/product-current-state.md)统一说明现行入口、已实现范围和待验证能力。本文已有测试数字与生成日期仍只对应原批次，不因文档更新自动视为重新验收。

`windows-observation-source.cjs` 导出 `createWindowsObservationSource({ desktopCapturer, screen, nativeImage, BrowserWindow, ipcMain, session, canCapture, onCaptureInvalidated?, detectorOptions? })`。注入 Electron 主进程 API；构造不列举来源、不采集、不启动 helper、不创建窗口、不操作外部应用。无需关闭 Electron sandbox。缺少受控捕获端口时，capture 明确报 `controlled_capture_unavailable`，不会回退到缩略图抓屏；list/probe 仍可使用。

## 主进程接口

- `listSources({ signal }?)`：`[{ id, name, type: 'screen' | 'window', displayId, geometry, unavailableReason? }]`。仅以 `thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false` 列举。本地元数据不得转交云端。
- `capture({ sourceId, signal, region? }?)`：须先成功列举、由本人选定该 screen ID，且同步 `canCapture({ sourceId }) === true`；未提供回调默认拒绝。调用方须核验本人当次同意、用途与系统授权；每次采集前后及媒体授权时重新检查回调，不保存同意、不自动恢复。`region` 是本人在已选屏幕上固定框选的 DIP 区域，首次帧锁定后不能在同一次授权中移动、扩大或取消。返回 `{ sourceId, sourceName, displayId, sourceType, sourceIdentity, frameId, frameHash, capturedAt, width, height, png: Buffer, geometry, region? }`；提供 `region` 时，`png`、`width`、`height`、`geometry` 和哈希均对应裁剪区域。原始完整帧只存在于隔离捕获 worker 和主进程的临时内存，先在本机裁剪并清零，框外内容不进入 OCR、人脸检测或云分析；不进入管理窗口或桌宠 Renderer，不经网络、不落盘。
- `detect(frame, { signal }?)`：每个拟发送帧都须调用。成功返回 `{ status: 'complete', sourceId, sourceIdentity, frameHash, width, height, words: [{ text, rect, globalRect? }], faces: [{ rect, globalRect? }], sanitizedPng: Buffer, sanitizedFrameHash, redaction: { text: true, faces: true }, ocrStatus: 'complete', faceStatus: 'complete' }`。无服务、识别故障、身份/哈希/尺寸/坐标不一致返回 `unavailable | failed` 和固定原因，不含 `sanitizedPng`。
- `probe({ signal }?)`：创建真实 WinRT OCR 和人脸检测器，返回已安装语言、OCR 最大尺寸、支持像素格式、PowerShell 版本或具体不可用原因。绝不抓屏。
- `await stop()`：取消当前采集结果、清除选择；停止媒体轨道并等待捕获 worker 实际关闭，kill 检测 helper 并等待进程 `close` 和检测清理。幂等，无自动重启。Electron 原生零缩略图 `getSources` 不可被 AbortSignal 真正取消：已取消调用的晚到结果被丢弃，在原生请求结束前拒绝第二个请求，防止排队。
- `onCaptureInvalidated({ reason, sourceId, generation })`：媒体 ended、worker 崩溃/关闭、尺寸变化或权限失效时回调；不会附带原图或正文。host 须清除当次 consent/guide 并停止相应 observation；恢复必须本人新的明确操作。

`windows-local-detector.cjs` 也单独导出 `createWindowsLocalDetector({ nativeImage, timeoutMs?, maxOutputBytes?, spawn? })`，提供相同的 `detect/probe/stop`。`spawn` 只为依赖注入测试；生产使用固定的系统 Windows PowerShell 5.1 与固定 helper 文件。

## 几何与失败关闭

`geometry` 的 `x/y/width/height` 默认是完整屏幕 DIP，不使用 workArea；支持多屏负原点和不同 DPI。额外字段 `{ coordinateSpace: 'screen-dip', scaleFactor, pixelX, pixelY, pixelWidth, pixelHeight, rotation }` 是完整屏幕的校验凭证，传给 `detect` 时应完整保留。物理原点必须来自 Windows `screen.dipToScreenRect(null, bounds)` 或 `Display.nativeOrigin`；媒体视频尺寸、PNG IHDR 与 NativeImage 尺寸必须与选定显示器的完整物理尺寸相符，不能证明时拒绝。启用固定区域后，返回的 `geometry` 是区域对应的 DIP/物理像素映射，`words[].rect`、`faces[].rect` 是裁剪图像素坐标；需要全局定位时使用 `globalRect`。`capturedAt` 记录隔离 worker 收到新 `requestVideoFrameCallback` 的时间，并由主进程校验其不早于本次请求且不晚于回包时间；它不是底层曝光时间，运行核心仍须核验帧龄，不能用 PNG 编码、检测完成或 IPC 回包时间刷新旧帧。

模型回复与下一帧的本地 OCR/人脸检查可能重叠。如果回复到达时最新已准入帧超过五秒，但已有同范围的新帧正在检测，运行核心仅等待该次本地检查完成，不重复上传或刷新旧帧时间。`AnalysisInput.confirmCurrentFrame()` 为回复侧提供此等待能力；发送侧仍使用同步 `canSend()` 严格检查原始准入帧的新鲜度。只有新的真实采集帧通过本地准入、五秒边界、来源/显示器/几何/签名一致性和任务身份检查后才安装结果；没有在途采集、安全检查失败、停止、超时或上下文变化时不接受旧回复。等待计入原有十五秒分析时限，不能借等待自动重试请求。

Windows `window` 来源可列举但返回 `geometry: null, unavailableReason: 'window_geometry_unproven'`，当前明确拒绝 window 捕获，避免把 DWM、边框和裁剪猜测成指引坐标。用户可选择对应的真实 screen 来学习外部软件。来源丢失、重命名、显示器更换或 DPI/几何改变都要求重新选择，不能复用旧映射。

## 本人固定区域观察

桌宠在选定屏幕后可打开透明本地遮罩，由本人拖拽框选需要教学的区域；遮罩不显示屏幕预览、不抓取桌面，也不替本人点击或操作外部软件。确认区域后仍须本人再次确认系统屏幕授权。当前支持的是固定屏幕区域，不是跟随窗口的原生窗口捕获；移动目标窗口后，本人须停止观察并重新框选，程序不会跟踪窗口。显示器、DPI 或已授权区域变化仍要求停止并重新选择，不能静默退回整屏。

区域框外的内容在进入 OCR、人脸检测前就在本机内存中裁掉并清零；默认不出云，只有另外明确开启按需脱敏上云才允许发送已脱敏的裁剪结果。取消框选、选择器失败或区域无效都保持停止状态，不自动恢复整屏采集。

区域坐标以遮罩实际内容区为基准，而不是假定请求的窗口边界等于 Windows 创建后的边界。创建后重新定位遮罩，读取实际内容区，与已选屏幕求交；Renderer 只能在交集内拖拽，主进程再次校验并换算为屏幕内 DIP。这样处理任务栏挤压和高 DPI 取整，不使用放大容差来扩大授权；选择期间实际内容区移动或改变尺寸仍拒绝。取消、越界或坐标无法证明时，均不退回整屏。

## 仅选定来源的媒体路径

所有 `desktopCapturer.getSources` 均固定 `thumbnailSize: { width: 0, height: 0 }`、`fetchWindowIcons: false`，只枚举元数据，绝不以非零缩略图遍历同类型屏幕。通过独立、非持久化内存 partition 的隐藏 BrowserWindow 执行 `getDisplayMedia({ audio: false, video: ... })`；该窗口不是管理窗口，启用 `sandbox/contextIsolation`、禁用 node，关闭窗口即终止轨道。

私有 session 的 `setDisplayMediaRequestHandler` 只接受本 worker 的 exact mainFrame、固定本地 URL、当代 sourceId、仍有效的本人授权、video-only 和 userGesture，一次性只 grant 元数据重新核对过的同一 source。host 在明确 native dialog 授权后，对自己 worker 执行固定 start 函数并使用 Electron 官方 `executeJavaScript(code, true)` 用户手势参数，不向第三方应用注入脚本或操作。默认拒绝其他权限/音频请求；网络离线并以 webRequest/CSP 仅允许 worker 自身 HTML/JS，没有原图网络出口。

Canvas 只响应 host 单次请求，等待最新视频帧后读 PNG，不做截图队列。随机 IPC 通道、capability token、generation、sourceIdentity 和每帧 requestId 绑定 exact worker sender/frame，限制原始 IPC 字节并检查 PNG 实际尺寸；旧进程/旧帧/外部 sender 不被接受。出错、abort、track-ended、renderer-gone 立即使当前捕获失效、关闭轨道和窗口，不自动重连。不支持或无法证明的真实媒体行为保留明确错误，不退回 thumbnail/DOM/capturePage。

## 本地检测和内存

PowerShell 5.1 helper 以隐藏、无 profile、非交互进程启动；原图作为有大小上限的 JSON/base64 经 stdin，解码在 `InMemoryRandomAccessStream/SoftwareBitmap` 内，真实调用 `Windows.Media.Ocr.OcrEngine.RecognizeAsync` 与整个图像的 `Windows.Media.FaceAnalysis.FaceDetector.DetectFacesAsync`，不使用 searchArea 截断范围。不写截图/转录/日志、不联网、不输出识别正文到 console。异常只返回阶段、异常类型和 HRESULT，不回显异常消息。

单适配器同一时刻一个采集操作、一个检测操作，冲突立即 `busy`，不排长队。默认采集 10 秒、helper 15 秒超时，检测输出 2 MiB、stderr 8 KiB、输入 PNG/原始帧 IPC 24 MiB、单边 8192、单帧总像素 16,777,216；不再按未选择屏幕数量创建像素缩略图。配置只能收紧图像上限。OCR 结果最多 8192 词/每词 512 字、人脸最多 512 个；重叠遮盖也有工作量上限。OCR 不支持的尺寸不会缩小后假称完整检测，而是明确不可用。

检测结果必须与同一 sourceId/sourceIdentity/frameHash/width/height 一致；frameHash 是当前（完整屏幕或裁剪区域）PNG 的 SHA-256 小写十六进制。所有检测到的文字（不限于风险词）和人脸在 NativeImage BGRA 内存副本上加边距遮黑，旋转文字额外保守扩展；输出仍为同尺寸 PNG，非文字结构保留。内部可控的 PNG/bitmap/管道 Buffer 在清理时清零；托管字符串与 WinRT/NativeImage 的内部副本无法承诺立即清零，helper 每次退出释放。原帧与返回的脱敏 PNG 由调用方持有，用完负责清零。

`complete` 只表示两项真实检测均完整返回并完成遮盖，不表示场景安全、不表示出云授权，也不承诺 OCR/人脸算法无漏检。连续观察由本人授权后持续运行，不再按敏感文字、未知页面或没有文字自动暂停；系统撤权、来源断开或检测故障仍关闭出口并停止相应采集，恢复必须本人新的明确操作。OCR 原文、来源名称和原图不得作为检测成功的附带云端数据。

本地策略 `windows-local-ocr-v11` 为连续观察显式传入 `authorizedSharing: true`，仅在本人当次授权的所选范围内使用同帧文字、人脸脱敏图，准入场景和界面原因均为 `authorized_sharing`。该模式不再通过敏感文字或场景白名单决定是否持续共享，也不再因页面未知或大图而自动改成 `controls_only` 布局图。本人可随时在桌宠点击“停止共享”或从托盘停止；关闭管理窗口不会停止共享。未传入授权模式的策略调用和独立单帧路径仍保留各自原有风险门控，不将连续共享授权推广到其他用途。按需出云依然需要本人另外授权，并非连续云端视频流。

公共控件词表包含“微信 / WeChat / Weixin”“发现 / Discover”“朋友圈 / Moments”，仅保留本地 OCR 真实识别到的标签和位置，支持同行相邻分词合并，不导出联系人、聊天正文或未知文件名。连续观察不会按文字内容暂停，但导出的控件标签、用户教学请求和模型回答仍保留原有风险检查。发送最多 64 个控件前，优先保留问题或上一步核验相关的安全控件；内部功能尚未出现时，可先指引本人打开已经识别的软件入口，但不能生成未出现的菜单或坐标。光标指引页显示本人选定的屏幕或框选范围；不会自行切换到整屏或扩大授权范围。

## 2026-10-24 shell 候选不再限于白名单

现场问题：整屏共享时桌面上的 **WeGame** 等第三方快捷方式不会被识别为可指引控件，因为 `windows-shell-controls.ps1` 原先只给写死白名单（桌面：微信/此电脑/我的电脑/回收站/控制面板；任务栏：微信/开始/搜索）打标签，其余名称直接丢弃，图标根本不会成为候选。现在改为：**枚举到的每个合格 shell 元素都作为候选上报**，`label` 取该元素本机的 UI Automation `Name`。

- 名称清洗（本机完成，不联网）：Trim、去控制字符、折叠空白、NFKC 归一（JS 校验层）、长度上限 64（超长按上限截断，异常超长的 helper 回包直接拒绝）、去掉桌面快捷方式 `.lnk` 后缀；空名、纯空白、纯符号（如 `-`、`...`）跳过；同名同位置的重复项只上报一次。
- 已知项继续映射友好名（微信 / 开始 / 搜索 / 此电脑 / 回收站 / 控制面板），既有文案与用例不变；其它名称原样保留，例如 `WeGame`、`原神`、`Google Chrome`。
- 既有过滤全部保留：只枚举 explorer 拥有的 `Shell_TrayWnd` / `Shell_SecondaryTrayWnd` / `Progman` / `WorkerW`，每显示器 DPI 上下文，`IsOffscreen`/`IsEnabled`，矩形非零、必须完全落在本人观察范围内，屏幕命中测试（`FromPoint` + 8 层父级），窗口 ≤128、元素 ≤1024、控件 ≤128；不枚举整窗，不改权限。
- 安全语义不变：候选仍是**本地**信息，仍要经既有准入闸门（同一采集作用域、同帧、5 秒 maxAge、generation、模型置信度/presentation 校验）才会被使用；shell 名称同样过敏感文本门控，命中隐私词或个人信息的候选直接不上报、不会成为箭头目标（也不因此停止已授权的连续共享）；不新增自动点击/输入，不外发原始屏幕或音频。
- **OCR 兜底：未做（如实标注）**。UIA 名为空或纯符号的桌面/任务栏元素仍被跳过，没有用本地 OCR 结果做就近匹配。原因：本机 helper 在 OCR 之前就完成 shell 枚举，改为 OCR 之后匹配需要重排检测顺序，且最近邻匹配可能给图标贴上旁边文字的错误标签；无名图标的图形候选由既有 `visual-controls.cjs`（`未标注图标` + 外观指纹，仅本人框选/已授权共享路径）提供，不是 OCR 名称兜底。
- `deviceVerified=false`：上述均为合成单测与脚本静态校验，**真机验收未完成**。需要用户在整屏共享下点击“重新识别当前画面”，确认桌面第二列顶部的 WeGame 图标出现箭头，并核对箭头位置与图标一致；未做这一步前不得声称真实桌面已验收。

检测完整性与发送体积分别校验：完整本地结果与原生检测器一致，最多 8192 个词、每词 512 字及 512 个人脸，不能截断后冒充完整结果。总文字量与导出的 1024 个控件仍有独立上限。已完整脱敏的大图超过 2,000,000 字节时，授权本地共享仍保持，分析客户端以 `ANALYSIS_IMAGE_TOO_LARGE` 拒绝该次发送；请求体还须不超过 3,000,000 字节，不压缩保护为原图回退。超过检测工作量、脱敏不完整或检测故障仍停止采集，只有本人重新选择并授权才能恢复。桌宠显示具体本地原因代码和对应建议，不再统一误标为“云分析失败”；不会保存 OCR 正文或用户截图作为诊断日志。

运行 `node scripts/test-desktop-observation-continuity.mjs` 可在隔离 Electron 中，以应用自有合成画布验证真实 Windows OCR / 人脸检测：连续大图保留完整脱敏图且观察保持开启，合成敏感文字出现后共享仍持续；本人显式停止后等待检测器清理，不再继续采集或自动恢复。该检查禁止用户桌面捕获，不开麦、不接云端，仅在 `.cache` 保存耗时、字数、图像字节数、合成测试文字是否识别成功和状态代码，不保存画布截图或 OCR 正文。

**2026-10-22 连续共享稳定性修正：** 授权连续共享的安全帧签名改为只覆盖「本机可识别控件」集合，不再把时钟、光标、正文和 OCR 抖动算成新画面；否则真实屏幕每 1.5 秒轮询一次就会中止在途模型请求，箭头永远安装不上。安装结果仍要求同一采集作用域、五秒边界、任务身份和本机目标核验；已显示的箭头在等待操作期间按「作用域 + 标签 + 四像素」重新核验后保留，目标消失时立即隐藏且不会为每帧重复上云。相关回归见 tests/platform/desktop-runtime-coordinator.test.ts 的「连续共享下的画面抖动不打断指引」。

**2026-10-23 发送门先于缩放：** trace 显示全屏 4.6 MB PNG 缩放耗时约 0.7 秒，把帧龄从 4.68 秒推到 5.35 秒，发送前检查直接判过期（`OUTBOUND_CLOSED` 出现在 analysis_request 后 0.67 秒）。现在缩放改为分析器**通过 `prepareImage()` 惰性获取**：先以已准入的原始帧通过 5 秒发送门，再执行缩放并上传。OCR 降采样上限同时从 1400 收到 1080，进一步压低检测耗时。

**2026-10-23 全屏安装窗口：** 降采样后全屏链路实测帧龄 3.1~4.7 秒，但安装路径仍额外要求「帧龄 ≤ maxAge-500」，慢模型（20~45 秒）返回时刚好越过这条线，于是每帧都被判过期并报 `OUTBOUND_CLOSED`。安装现在只要求采集作用域一致 + 当前帧已准入（≤ 五秒）；若最新帧已超五秒，最多重采四次后安装。过期帧重采次数上限同时从 2 提到 3。

**2026-10-23 OCR 降采样：** 大共享区域（长边 >1400px）先在本地按比例缩小再 OCR，词框坐标除以缩放比映射回原图，避免本机检测超过五秒准入窗口导致“本地画面处理超时”。上限由 `detectorOptions.ocrMaxDimension` 控制（默认 1400，0 关闭）；小画面仍按原分辨率识别，放大第二遍仍需显式 `scaledPass`。

**2026-10-23 分析图片缩放：** 桌面提供方对本地上传图片有 2 MB 上限；全屏脱敏 PNG 可能超过该上限，表现为模型请求失败（`ANALYSIS_FAILED`，文案“未获得可核验的结果”）。发送前若 PNG 超过约 1.4 MB，运行核心用 Electron `nativeImage` 等比缩小并以缩放副本上传，目标仍由模型从本地元素列表选 `target_id`，因此坐标映射不受影响；`analysis_request`/`analysis_image_scaled` 事件记录原始与缩放后的字节数。`ANALYSIS_FAILED` 现在有独立文案。

**2026-10-23 采集链路提速：** ① 抓屏前的来源枚举默认缓存 6 秒（`sourceRefreshMs`），抓屏后的真实枚举保留用于证明来源未在拷贝期间消失；② 本地 OCR 的"放大再识别"第二遍改为默认关闭（`detectorOptions.scaledPass`，仅小字场景显式开启），大屏上可省掉接近一半 OCR 时间；③ `guidance-trace.log` 的 `capture_cycle` 现在分别记录 `captureMs` 与 `detectMs`。

**2026-10-23 慢采集链路的显示窗口：** 本机实测「采集 + 本地 OCR/UIA 检测 + 准入」一轮约 3.4~4.0 秒，因此在五秒安全上限内不再额外要求 2.5 秒新鲜度；安装成功后箭头显示窗口从**本地核验完成时间**起算五秒，并由后续每一帧已准入画面的重新核验续期；若五秒内没有新帧续期才隐藏。`guidance-trace.log` 增加 `capture_cycle`（每轮耗时/帧龄/控件数）与 `analysis_reply`/`analysis_error` 事件，用于定位慢阶段。

**2026-10-23 安装条件按采集范围核验：** 模型返回后不再要求「当前帧 OCR 签名与上传帧完全一致」——真实屏幕上几秒内必然出现控件增减或位移，旧条件会稳定报「分析返回时画面已过期…未显示箭头」。现在安装要求：采集作用域（来源/显示器/尺寸/坐标映射）一致、最新准入帧新鲜（≤2.5 秒且未过五秒上限）、模型目标能在新帧里按标签 + 四像素唯一重定位；完成类结果仍额外要求已验证的 DIP 几何与显示器标识。目标找不到或作用域变化时仍拒绝安装。

**箭头显示窗口与诊断：** 慢响应返回时若最新安全帧超过约 2.5 秒，运行核心会先触发一次新的本地采集，确保箭头按新帧计算有效期（否则按旧帧的采集时间只剩几百毫秒）。等待操作期间，单帧 OCR 丢失目标会保留一个轮询间隔（约 1.5 秒）后再隐藏，连续两帧丢失才判定失效，避免真实屏幕闪烁导致箭头抖动。诊断日志默认写入 `%APPDATA%\@nuanban\desktop\guidance-trace.log`（仅事件名、原因、时长与控件标签长度，不包含截图、用户文字或密钥；超过 512 KB 轮转为 `.1`，设置 `NUANBAN_GUIDANCE_TRACE=0` 可关闭）。

未启用本人授权连续共享的策略调用仍保留敏感词、个人信息与页面分类门控；不能生成安全布局时不回退原图，完全没有可识别通用控件的画面仍为 `unclassified_screen`。本人授权连续共享不使用这些内容门控，但检测不完整、同帧校验失败或脱敏缺失仍关闭出口并停止采集；过期帧被丢弃并重新采集，不刷新旧帧时间。布局图同样限制尺寸、像素数、控件数和绘制工作量；用完按既有帧生命周期清零。

已展示的任务栏或桌面系统入口会在后续完整、安全且未过期的新帧中重新核验。只有观察来源、显示器、尺寸和坐标映射不变，且同一入口的本机核验标签、surface 与位置尺寸仍在四像素容差内唯一匹配时，才可在无关控件变化（例如任务栏输入法标识位移）后续显箭头，不重复调用云分析，也不认定用户已经完成操作。入口消失、被遮挡、失去本机核验、位置尺寸超出容差或出现新的预期操作证据时，不沿用旧指引。等待操作时，后续采集间隔扣除已用的帧处理时间，避免在慢速本地处理后额外叠加等待；原有隐私检查、五秒过期、来源变更与慢响应门控仍保持有效，不会延长旧帧的有效期。

## 验证（不采集用户桌面）

针对性测试：`pnpm exec vitest run tests/platform/desktop-observation-region.test.ts tests/platform/desktop-observation-source.test.ts tests/platform/desktop-observation-policy.test.ts tests/platform/desktop-runtime-coordinator.test.ts tests/platform/management-observation-bridge.test.ts tests/platform/desktop-pet-ui.test.ts`。覆盖本人框选/取消、隔离 IPC、1× 至 2× DPI 的裁剪坐标、区域锁定、连续本地观察、未知/敏感场景熔断及桌宠状态；测试依赖注入不代表真实桌面验收。

2026-10-18 本机原生回归：保留系统 150% 缩放，仅捕获自建无边框测试窗口；预测 965×725，真实媒体 964×724，经有界尺寸校验后，动态与完全静止两种画面分别连续取得 5 个不同 frameId、稳定尺寸的新帧，并完成真实 WinRT OCR/人脸检测及本地安全策略检查。测试没有捕获用户桌面、保存画面或调用云端；不代表真实外部软件或用户完整屏幕已验收。

真实能力探测：`apps\desktop\node_modules\electron\dist\electron.exe apps\desktop\observation\probe-windows-observation.cjs`。添加 `--synthetic` 使用程序内存生成的字形图，真实执行 OCR/人脸分析及 NativeImage 遮盖，输出仅计数、布尔校验和能力元数据。没有 BrowserWindow，不引用真实 desktopCapturer，`captureCalls` 必须为 0；人脸计数 0 不代表已验证真人脸检出率。

## 显示捕获的前置权限

高 DPI 下，完整屏幕的 DIP 边界存在取整，不能把 `dipToScreenRect` 的预测宽高当成媒体流精确像素。worker 启动只在同一已授权来源、DIP×缩放的 floor/ceil 范围内核验一次真实媒体尺寸（每轴最多相差一像素，整数尺寸不放宽），preload 与主进程分别校验后锁定；后续每帧及 PNG 必须与首次真实尺寸精确一致。返回帧 geometry 使用真实像素尺寸，来源身份仍绑定最初选择的完整显示器元数据，换屏、缩放变化、撤权及后续尺寸漂移仍停止。检测器与主进程的图像上限不放宽，不缩小截图冒充完整检测。

捕获失败仅传播固定白名单错误码，并在桌宠显示中文恢复提示；异常正文、屏幕文字和未识别的异常字段不进入状态。停止教学不能覆盖采集故障提示，也不能在观察已停时提示“观察可继续”。

静止画面也需要新媒体帧。取得当次已授权的单屏视频轨道后，再通过 `track.applyConstraints` 请求最低 2、最高 5 fps；不在 `getDisplayMedia` 初始请求中使用禁止的 `min` 约束，也不重新请求共享。持续新帧不可用则明确报告 `capture_refresh_unavailable` 并停止轨道，不刷新旧截图时间、不用缓存帧冒充新画面。异步配置期间撤权仍立即停止，晚到完成不能重新播放。

Electron 的显示捕获会先发起 `media` 权限请求，其 `mediaTypes` 是空数组。该前置请求仅在同一受信任 worker 主框架、固定 URL 和本人当次授权仍有效时允许；缺失或非空的 `mediaTypes`（包括麦克风和摄像头）、子框架、其他窗口、撤权请求仍拒绝。真正授予媒体流时继续检查单屏来源和用户手势，不能仅凭前置权限读取屏幕。

专项单测按真实顺序先请求此前置权限，再请求显示捕获，防止只测试最终 grant 而漏掉启动失败。原生自检只使用自建合成窗口验证隐藏 worker 连续帧和本地 OCR/人脸检测；不采集用户桌面，不调用云端，不能替代真实外部软件、多屏和不同 DPI 的本人验收。

## 尚未执行的真实验收

Electron 从 Node 启动时应移除子进程环境变量 `ELECTRON_RUN_AS_NODE`。上述能力探测不启动真实屏幕媒体；单元测试中的多屏授权、track-ended 和帧回调使用合成进程/媒体事件，不代表真实外部软件验收。当前仍待本人明确授权后手工验证：选定屏幕的真实 `getDisplayMedia`、隐藏窗口新帧回调、不同 DPI/负原点显示器、区域遮罩的真实窗口边界以及系统拒绝权限。区域选择界面已在无头浏览器中以静态合成页面验证正反向拖拽、最小尺寸、Enter/按钮确认和 Esc 取消，尚不能替代真实 Windows 多屏框选验收。没有在本轮测试中自动抓取用户桌面。

**2026-10-24 新增待验收项（`deviceVerified=false`）：** 整屏共享下，桌面第二列顶部的 WeGame 图标（以及任意第三方快捷方式）应被本机 UIA 枚举为候选并在本人点击“重新识别当前画面”后出现箭头；这一条只有用户在实际设备、实际整屏共享下才能确认，本轮只完成合成单测与脚本静态校验。

## 官方 API 核对

- Electron desktopCapturer（零尺寸缩略图、来源枚举与大小限制）：https://www.electronjs.org/docs/latest/api/desktop-capturer
- Electron DesktopCapturerSource（id、display_id 的匹配语义）：https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source
- Electron session（setDisplayMediaRequestHandler、权限拒绝、隔离 partition）：https://www.electronjs.org/docs/latest/api/session
- Electron webContents（executeJavaScript 用户手势、mainFrame、renderer-gone）：https://www.electronjs.org/docs/latest/api/web-contents
- Electron screen / Display（DIP、物理像素、Windows nativeOrigin）：https://www.electronjs.org/docs/latest/api/screen 与 https://www.electronjs.org/docs/latest/api/structures/display
- Electron NativeImage（Windows BGRA bitmap）：https://www.electronjs.org/docs/latest/api/native-image
- Microsoft OcrEngine / RecognizeAsync：https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine 和 https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine.recognizeasync
- Microsoft FaceDetector / DetectFacesAsync（整帧与 Gray8）：https://learn.microsoft.com/en-us/uwp/api/windows.media.faceanalysis.facedetector 和 https://learn.microsoft.com/en-us/uwp/api/windows.media.faceanalysis.facedetector.detectfacesasync
- Microsoft InMemoryRandomAccessStream：https://learn.microsoft.com/en-us/uwp/api/windows.storage.streams.inmemoryrandomaccessstream
