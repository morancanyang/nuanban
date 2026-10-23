# 独立桌宠实时 3D 悬浮形象（spike + 集成）

> 状态：**离线可编译、可打包、策略与数据层用例全绿；真机渲染/帧率/内存/耗电尚未测量**。
> `deviceVerified=false`、`captureExecuted=false`、`cloudExecuted=false`、`networkExecuted=false`。
> 本机没有 Android 设备或 AVD（`adb devices` 为空），本文不包含任何推算出来的性能数字；需要真机数据时按第 7 节执行。

涉及任务：task-4（方案 D）。写范围：`apps/android/standalone/**`、`apps/android/app/src/standalone/**`、`tests/platform/android-3d-*.test.ts`、本文件。
未改动：`apps/android/app/src/main/java/**`（会话/桥接由其他同事负责）、权限清单、任何网络或额外权限。

## 1. 勘察结论（决定了方案与资产做法）

1. 被 git 跟踪的桌面模型是 `apps/web/public/models/lumi/Lumi_Magical_Kitten.glb`：
   `byteSize=5411364`、`sha256=3ec165a265d28d00bec78c6262d4909542d9d5e8759759cc00cdb07fd7f95f90`，
   与 `apps/web/src/three-d/builtin-models.ts` 里 `lumiModel.sha256`、以及 `character_manifest.json` 的 `runtime.sha256` 完全一致。
2. `apps/android/app/src/main/assets/ui/models/lumi/*.glb` 是 **被 `.gitignore` 忽略的构建产物**，其摘要是 `7fbe808f…`，
   恰好等于桌面代码里记录的 `lumiModel.previousSha256`，即**上一版模型**。因此本次不依赖该目录，改由构建期从被跟踪的 public 模型复制。
3. 该模型的实际结构（由本仓库离线用例真读得到，见第 6 节）：
   `glTF 2.0`、`mesh=148`、`primitive=149`、`node=149`、`skin=0`、`material=19`、内嵌 `image=3`、`texture=5`、
   `triangle=97978`、`vertex=95586`、动画只有 1 条 **idle**（1 个 translation 通道，对象位移）、
   `extensionsRequired=["KHR_texture_transform"]`、自包含（无外部 URI）。
4. Lili 的 manifest 明确写了 `glbPurpose` 是"身份/持久化/完整性"，桌面端默认显示用 `createLiliModel` 的程序化几何，且该 GLB `animations=0`。
   所以独立桌宠的实时 3D 以 **Lumi GLB** 为渲染对象；Lili 不进渲染链（要支持需另立任务）。

## 2. 两个 spike 的设计

两个候选都做了**最小可运行样例**：加载随包 GLB、循环动画、拖动、单击打开原生面板、`FLAG_SECURE` 保留。
"保留"的实现方式：`FLAG_SECURE` 与 `filterTouchesWhenObscured` 一直在**浮层窗口/宿主视图**上（不在渲染视图上），
因此两个 spike 都不需要、也没有改动安全属性；3D 子视图被设为不可点击、不可聚焦，触摸事件全部由宿主处理。

### spike (a) 原生 GLSurfaceView + 轻量 GLB 渲染

| 文件 | 作用 |
| --- | --- |
| `Pet3dGlbDocument.kt` | 纯 Kotlin 的 GLB/glTF 2.0 读取层：chunk 校验、最小 JSON 解析、accessor 解码（含 byteStride/归一化）、节点/材质/动画视图。**失败即封闭**：外部 buffer/贴图、sparse accessor、非 2.0、越界读取都抛异常。 |
| `Pet3dGlRenderer.kt` | GLES2 渲染器：三角形图元、POSITION/NORMAL、`baseColorFactor` 平色 + 单向光 + 边缘光、节点 TRS 层级（含 `matrix`）、动画 translation/rotation/scale 的 LINEAR/STEP 采样（含四元数 slerp），按包围盒归一化取景。 |
| `Pet3dGlView.kt` | 浮层里的 GLES2 表面：`TRANSLUCENT` + `setZOrderOnTop(true)`，首帧后回调 `onReady`。 |

- **能做到**：真几何、真节点动画、内存与耗电理论上最低（无第二个渲染进程、无 JS 引擎）。
- **做不到（明确失败封闭，不静默画错）**：蒙皮网格、形变目标、`CUBICSPLINE`、PBR 贴图/法线贴图与 `KHR_*` 材质扩展 —— 随包 Lumi 恰好是"无蒙皮 + 无贴图以外扩展"的模型，因此可渲染，但**材质只是平色近似**，与桌面端观感不等价。
- **风险（真机才能确认）**：`SurfaceView`（GLSurfaceView 的基类）在 `TYPE_APPLICATION_OVERLAY` 浮层里的透明合成在不同 OEM 上表现不一；若出现黑底/不透明，8 秒 watchdog 会回退（届时可改用 `TextureView` 方案）。

### spike (b) 受控 WebView + three.js

| 文件 | 作用 |
| --- | --- |
| `Pet3dWebView.kt` | 受控 WebView：应用内拦截合成 https 源（`https://pet3d.nuanban.invalid/pet3d/...`）映射到 `assets/pet3d`；非本源请求一律 403、导航一律拒绝；关闭文件访问/内容访问/DOM Storage/地理位置/多窗口；页面日志不回显；桥只有 `ready/failed/stats` 三个方法并把入参收敛成短代码。 |
| `assets/pet3d/index.html` | 透明背景最小页面 + importmap（`three` → 本地 ESM）。 |
| `assets/pet3d/viewer/pet3d-viewer.js` | 与 `apps/web/src/three-d/viewer.ts` 对齐的加载/渲染策略：同摘要校验（`crypto.subtle`，合成 https 源是安全上下文）、`LoadingManager` 只允许 `blob:`/`data:`（出现外部贴图即失败）、`alpha`+`antialias`+`low-power`、`pixelRatio` 上限 1.5、`SRGB`+`ACESFilmic`、Box 归一化取景、`idle` 循环、每 5 秒回传帧统计、首帧 `readPixels` 自检"是否真的画出非透明像素"。 |
| `assets/pet3d/viewer/{three.module.js,three.core.js,loaders/GLTFLoader.js,utils/*.js}` | 从 `node_modules/three@0.186.1` 逐字节复制的 MIT 运行时（含 `THREE-LICENSE.txt`），由离线用例比对 SHA-256 防止漂移。 |

- **能做到**：与桌面端**同一份模型 + 同一 three 版本 + 同一 GLTFLoader**，材质/贴图/动画保真度最高；渲染进程独立，崩溃不带走驻留服务。
- **做不到 / 风险（真机才能确认）**：WebView 渲染进程的内存与耗电开销；在 Service 上下文创建 WebView 的 OEM 差异；透明合成；`importmap` 需要 WebView 主版本 ≥ 90（策略里作为硬门槛）。

### 两个 spike 的共同点

- 都不新增权限、不新增网络能力：页面与脚本内不出现外部主机名（用例守护），WebView 侧对非本源请求 403；
- 都在加载前用固定 SHA-256 校验随包 GLB，校验不过就不渲染；
- 都在首帧/就绪超时或报错时按策略回退，不无限重试。

## 3. 选型结论：三层策略（默认 WebView 优先，原生 GL 兜底，PNG 终态）

`Pet3dRenderPolicy`（纯 Kotlin，可离线跑用例）按以下顺序选层，常量与阈值都在源码里可查：

| 条件 | 结果 | 原因码 |
| --- | --- | --- |
| 本人关闭实时 3D | `STATIC_PNG` | `user_disabled_real_time_3d` |
| 随包模型缺失 | `STATIC_PNG` | `bundled_model_missing` |
| 模型摘要与固定值不一致 | `STATIC_PNG` | `bundled_model_digest_mismatch` |
| 连续失败 ≥ 2 次 | `STATIC_PNG` | `renderer_failure_fail_closed` |
| WebView 可用且主版本 ≥ 90、非 low-RAM、总内存 ≥ 4096MB | `CONTROLLED_WEBVIEW` | `webview_three_js_selected` |
| GLES ≥ 2.0 且总内存 ≥ 2048MB | `NATIVE_GL` | `native_gl_webview_unavailable` / `native_gl_after_webview_failure` |
| 其余 | `STATIC_PNG` | `no_viable_renderer_static_png` |

**理由（基于代码事实与设计权衡，不是基于实测）**：

1. **保真度与维护成本**：产品要的是"和桌面端同一个形象"，WebView 路径直接复用同一 three 版本/同一个 GLTFLoader/同一份模型与摘要；原生路径只能做到平色近似，且要自己维护 ~600 行图形与 glTF 代码。
2. **低端机与不可用情形**：WebView 不可用/版本过低/内存不足时，原生 GL 比"直接退静态图"更接近目标；但它不是等价物，所以只作兜底层。
3. **失败封闭**：任何一层不可用都不会让悬浮窗变空——静态 PNG 常驻屏幕，8 秒内没有首帧就升层，连续 2 次失败即停止尝试 3D，避免在低端机上反复起渲染进程。
4. **可切换**：面板新增"切换为实时 3D / 静态形象"按钮（**仅进程内偏好，不落盘**），便于本人按体感/省电选择，也便于真机对比测量。

**真机数据可能推翻默认顺序**：若测量显示 WebView 的 PSS 增量 > 80MB 或 p95 帧间隔 > 40ms（判据见第 7 节），
则应把 `NATIVE_GL` 提为首选——改动只需调整 `Pet3dRenderPolicy` 的判定顺序与阈值，其余代码与测试不用动。

## 4. 回退与安全语义（已实现）

- 静态 PNG 是浮层宿主的**常驻子视图**：3D 就绪前显示它，3D 失败时摘除 3D 子视图即回到它；
- 资产校验（读 5.4MB + SHA-256 + GLB 结构）在后台单线程执行，主线程只做视图挂载；
- 首帧 watchdog `READY_TIMEOUT_MS = 8000`；创建异常、页面/GL 报错、`readPixels` 空白帧、`webglcontextlost` 都走升层；
- 失败层进入 `failedModes` 不再重试；`consecutiveFailures ≥ 2` 直接封闭到静态图；本人重新开启实时 3D 时清空失败记录再试一次；
- 面板打开期间暂停渲染（省电），关闭面板恢复；服务销毁时先销毁 3D 表面（释放 GL 上下文 / `WebView.destroy()`）再移除浮层；
- 帧统计只写 logcat（tag `NuanbanPet3d`，每 5 秒一条），不联网、不上报。

## 5. 刻意保持不变的行为

| 行为 | 状态 |
| --- | --- |
| 拖动移动浮层 | 保留（同一套 `rawX/rawY` 逻辑，改挂在宿主视图上） |
| 单击打开原生面板 | 保留（`ACTION_UP` 且未拖动时 `performClick()`） |
| `FLAG_SECURE` | 保留（仍在 `parameters()` 的窗口属性里） |
| `filterTouchesWhenObscured` | 保留（浮层宿主 + 回退图 + 面板按钮） |
| 随包静态 PNG | 保留，且成为常驻回退层（`drawable-nodpi/nuanban_pet_preview.png` 未改动） |
| 通知停止/退出、熄屏与锁屏封闭、`handler.removeCallbacksAndMessages(null)` | 保留 |
| `PetRuntimeService` 的既有源码约束（既有测试要求它出现 `ImageView(this)`/`R.drawable.nuanban_pet_preview`、且不出现 `WebView`） | 满足：渲染细节全在新文件里，服务只调用 `Pet3dOverlay` 的接口 |
| 权限 | 本次改动不涉及权限清单；pet3d 代码不声明、不申请任何权限（用例守护）。独立包权限集合的其他变化来自其他任务，不在本任务范围 |

## 6. 已完成的离线验证（可复现的命令与结果）

1. **独立包 Kotlin 编译**
   `apps/android/gradlew.bat -p apps/android :standalone:compileDebugKotlin --offline --no-daemon` → `BUILD SUCCESSFUL`（唯一警告来自他人文件 `MainActivity.kt` 的 deprecated override）。
2. **独立包 APK 打包与随包模型摘要一致**
   `apps/android/gradlew.bat -p apps/android :standalone:assembleDebug --offline --no-daemon` → `BUILD SUCCESSFUL`；
   解包比对 APK 内 `assets/pet3d/models/lumi/Lumi_Magical_Kitten.glb` 的 SHA-256 =
   `3ec165a265d28d00bec78c6262d4909542d9d5e8759759cc00cdb07fd7f95f90` = 桌面端 `public` 模型 = 桌面代码 pin。
   （debug APK 体积 91 MB，其中绝大部分是随包的 39 个 ML Kit 本地模型；本次新增未压缩资产约 7.7MB：5.4MB 模型 + 2.3MB 内嵌 three 运行时。）
3. **隔离/打包校验（既有脚本，未改动）**
   `powershell -NoProfile -ExecutionPolicy Bypass -File apps/android/check-standalone-packaging.ps1` → `passed=true`、`caseCount=94` 全绿
   （该数字含其他同事新增的用例；本任务开始时的基线是 89）。其中 `normal_has_no_pet_preview_asset`、`normal_source_set_does_not_include_standalone`、
   `standalone_has_all_39_bundled_model_assets`、`standalone_model_bytes_match_runtime_fingerprint` 都仍然通过，说明新增资产没有破坏普通包隔离与模型指纹。
4. **本任务新增的离线用例（不联网、不需要设备）**
   `powershell -NoProfile -ExecutionPolicy Bypass -File apps/android/standalone/tools/pet3d/check-pet3d.ps1` → `passed=true`、`caseCount=40`：
   - 16 条策略用例（含"能力足够选 WebView"、"低端机选原生 GL"、"内存过小/无 GLES 退静态"、"模型缺失/摘要不符退静态"、"本人关闭退静态"、"WebView 失败升原生 GL"、"原生失败升静态"、"连续 2 次失败封闭"、"已失败层不被重选"、"层级链以静态结尾"）；
   - 9 条针对**真实随包 GLB** 的数据层用例（结构事实、摘要与 manifest 一致、idle 动画、贴图内嵌与 `KHR_texture_transform`、前 12 个 primitive 的位置/法线/索引解码有限且索引不越界、包围盒合理）；
   - 9 条畸形/不支持输入的封闭用例（坏 magic、版本、长度不符、外部 buffer/贴图、sparse accessor、越界读取、缺 asset/version、缺 POSITION、JSON 语法错）；
   - 6 条工程用例（Android 源文件对 `android.jar` 类型检查通过、随包模型与 public/manifest/桌面 pin/Kotlin pin 四处摘要一致、资产路径声明、内嵌 three 与 `node_modules/three` 逐字节一致）。
5. **前端/仓库级检查**
   `pnpm typecheck` 与 `pnpm exec vitest run tests/platform/android-3d-render-policy.test.ts tests/platform/android-3d-assets.test.ts tests/platform/android-3d-overlay.test.ts` 全绿（结果见提交说明）。

> 以上只证明"**可编译、可打包、数据层与策略正确**"。**没有**证明渲染画面正确、透明合成正确、也没有任何真机性能数据。

## 7. 真机测量步骤与判据（待执行）

脚本：`apps/android/standalone/tools/pet3d/measure-pet3d.ps1`（只依赖 adb；没有设备时会明确失败并写出 `deviceVerified=false`，不会估算）。

### 7.1 准备

1. 真机打开开发者选项与 USB 调试；`adb devices` 能看到设备；
2. 安装本仓库构建的独立包（debug 包仅供测量，**不上传、不发布**）：
   `adb install -r apps/android/standalone/build/outputs/apk/debug/standalone-debug.apk`；
3. 打开独立桌宠、授予"显示在其他应用上层"与通知权限、启动驻留；把屏幕亮度固定、关闭自动亮度，尽量同一网络/充电状态；
4. 每个形态各测一轮：面板里用"切换为实时 3D / 静态形象"按钮切到目标形态（脚本参数 `-Phase` 只是记录，形态由人确认）。

### 7.2 采集命令（脚本内部逐条执行）

```powershell
adb -s <serial> shell dumpsys batterystats --reset
adb -s <serial> shell dumpsys gfxinfo org.nuanban.assistant.standalone reset
adb -s <serial> logcat -c
adb -s <serial> logcat -s NuanbanPet3d:I '*:S'          # 每 5 秒一条：avgFps / p95FrameMs / worstFrameMs
adb -s <serial> shell dumpsys gfxinfo org.nuanban.assistant.standalone framestats   # Janky frames 百分比
adb -s <serial> shell dumpsys meminfo org.nuanban.assistant.standalone              # TOTAL PSS / RSS
adb -s <serial> shell dumpsys batterystats --charged org.nuanban.assistant.standalone
adb -s <serial> shell dumpsys thermalservice
```

一次完整的单形态采集：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/android/standalone/tools/pet3d/measure-pet3d.ps1 `
  -Serial <serial> -Phase webview_three_js -DurationSeconds 600 -OutputPath .\pet3d-webview.json
# 再切到 native_gl / static_png 各跑一次
```

输出 JSON 含：设备信息（型号/版本/总内存/WebView 版本）、`frameStatSamples`（logcat 原始窗口统计）、
`totalPssKb`、`gfxJankyPercent`、`estimatedPowerMah`、判据表 `thresholds`、以及所有原始文件路径（便于复核）。

### 7.3 判据（三个形态同设备、同亮度、同时长、同会话对比）

| 指标 | 期望（暂定） | 不达标时的动作 |
| --- | --- | --- |
| 持续 `avgFps` | ≥ 24 | 3D 层降级为原生 GL，或缩短渲染时长 |
| `p95FrameMs` | ≤ 40ms | 同上；并检查是否触发了连续失败封闭 |
| `Janky frames` | ≤ 10% | 同上 |
| PSS 增量（相对 `static_png`） | WebView ≤ 80MB；原生 GL ≤ 30MB | 超标即换层或提高策略门槛 |
| `Estimated power use` 增量 | ≤ 3%/10min（相对 `static_png`） | 超标即换层或降低帧率/在面板默认静态 |
| 首帧时间 | < 8 秒（watchdog 阈值） | 提高门槛或回退静态 |
| 透明合成 | 浮层背景透明、无黑底/白底 | 原生 GL 换 `TextureView`；WebView 检查窗口 alpha |
| 触摸 | 拖动跟手、单击打开面板、被遮挡时拒收 | 立即回退静态图，记录机型与系统版本 |
| 安全属性 | `dumpsys window` 中浮层窗口带 `SECURE`，触摸被遮挡不响应 | 视为阻塞缺陷，不得发布 |

### 7.4 记录要求

- 每个形态一条 JSON + 原始文件；结论必须写成"某机型某系统版本上，某形态的某指标 = 某值"；
- 未测的项保持"未测"，不得用估算值填补；
- 若只在模拟器上跑过，必须标注"模拟器"，不能当作真机验收。

## 8. 未验证清单（诚实边界）

- 渲染画面正确性（几何、材质、动画观感）——只有真机能看；
- 浮层透明合成（原生 `SurfaceView` 与 WebView 两条路径都有 OEM 差异风险）；
- 在 Service 上下文创建 WebView 的兼容性；
- 真机帧率/内存/耗电（本文没有任何这类数据）；
- `importmap` 与 WebGL2 在设备 WebView 版本矩阵上的实际命中率；
- 低端机（`isLowRamDevice`）与 2GB/3GB 内存机型上的行为；
- Android 8～16 各版本、各家 ROM 的差异。

## 9. 后续可做（未做）

1. 拿到真机后按第 7 节测量，并按结果调整 `Pet3dRenderPolicy` 的顺序/阈值（数据驱动，而不是拍脑袋）；
2. 若原生 GL 成为首选：改用 `TextureView` 承载、给几何加 VBO 复用与贴图支持；
3. 若要把 Lili 也做成实时 3D，需要单独方案（其 GLB 无动画，桌面端默认是程序化几何）；
4. 模型升级流程：更换 `apps/web/public/models/lumi/*.glb` 时，需同步 `builtin-models.ts`、`character_manifest.json`、
   `Pet3dAssets.PINNED_MODEL_SHA256` 与 `assets/pet3d/viewer/pet3d-viewer.js` 里的摘要；`check-pet3d.ps1` 与新增用例会因摘要不一致而失败，属预期保护。

## 10. 变更文件一览

新增（Kotlin，`:standalone` 专用源集）：

- `app/src/standalone/java/org/nuanban/assistant/nativehost/Pet3dRenderPolicy.kt`（纯策略）
- `.../Pet3dGlbDocument.kt`（GLB/glTF 读取层）
- `.../Pet3dAssets.kt`（随包资产校验 + 能力探测）
- `.../Pet3dFrameStats.kt`（帧统计 → logcat）
- `.../Pet3dGlRenderer.kt`、`.../Pet3dGlView.kt`（spike a）
- `.../Pet3dWebView.kt`（spike b）
- `.../Pet3dBubbleView.kt`、`.../Pet3dOverlay.kt`（宿主与编排）

新增（资产与工具）：

- `app/src/standalone/assets/pet3d/{index.html,README.md,viewer/*}`（页面 + 内嵌 three 运行时 + MIT 许可证）
- `standalone/tools/pet3d/{check-pet3d.ps1,Pet3dChecks.kt,measure-pet3d.ps1}`

修改：

- `app/src/standalone/java/org/nuanban/assistant/nativehost/PetRuntimeService.kt`（浮层挂载 `Pet3dOverlay`、状态文本加形象层级、面板加切换按钮、面板期间暂停渲染、销毁顺序）
- `standalone/build.gradle.kts`（`assets.srcDir(app/src/standalone/assets)` + `syncPet3dModelAssets` 构建期复制模型）
- `tests/platform/android-3d-{render-policy,assets,overlay}.test.ts`（新增）
- 本文件