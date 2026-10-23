# 独立桌宠悬浮层 3D 资产（随包）

本目录只服务 `:standalone` 包（`apps/android/standalone/**`），不会进入普通 `:app`（普通包不包含 `app/src/standalone`）。

## 目录

| 路径 | 来源 | 说明 |
| --- | --- | --- |
| `index.html` | 本仓库自写 | 透明背景的最小页面，只引用同目录下的本地文件 |
| `viewer/pet3d-viewer.js` | 本仓库自写 | 与 `apps/web/src/three-d/viewer.ts` 对齐的加载/渲染策略（同摘要校验、仅允许 blob:/data: 贴图、SRGB + ACESFilmic、Box 归一化取景） |
| `viewer/three.module.js`、`viewer/three.core.js` | `node_modules/three@0.186.1/build/` | three.js ESM 运行时，逐字节复制，未修改 |
| `viewer/loaders/GLTFLoader.js` | `node_modules/three@0.186.1/examples/jsm/loaders/` | 与桌面端同一个 GLTFLoader，未修改 |
| `viewer/utils/BufferGeometryUtils.js`、`viewer/utils/SkeletonUtils.js` | `node_modules/three@0.186.1/examples/jsm/utils/` | GLTFLoader 的相对依赖，未修改 |
| `viewer/THREE-LICENSE.txt` | `node_modules/three/LICENSE` | MIT 许可证原文 |
| `models/lumi/Lumi_Magical_Kitten.glb`、`models/lumi/character_manifest.json` | 构建期由 `standalone/build.gradle.kts` 的 `syncPet3dModelAssets` 从 `apps/web/public/models/lumi/` 复制 | **不在 git 中**，保证与桌面端被跟踪的模型逐字节一致 |

## 为什么内嵌 three 运行时而不是复用 `assets/ui` 里的构建产物

`app/src/main/assets/ui/**` 是 `pnpm android:sync`（`pnpm build` + `scripts/sync-android.mjs`）的产物且被 `.gitignore` 忽略，其 chunk 名带内容哈希、
内容也可能落后于当前桌面模型（当前该目录里的 Lumi GLB 摘要就是桌面端的 `previousSha256`）。
独立桌宠的实时 3D 若依赖它，会出现"干净检出时行为与本地不同"的隐性差异，因此这里内嵌与 `node_modules/three` 同版本的运行时，
并由 `tools/pet3d/check-pet3d.ps1` 逐个文件比对 SHA-256 来防止漂移。

升级 three 时：更新 `apps/web/package.json` 的依赖后，重新从 `node_modules/three` 复制上述文件，并重跑 `check-pet3d.ps1`（会校验字节一致）。

## 安全约束（由 `tests/platform/android-3d-assets.test.ts` 守护）

- 页面与脚本里不出现外部主机名；WebView 侧对非本源的请求一律 403、导航一律拒绝；
- 不使用文件访问、内容访问、DOM Storage、地理位置、多窗口；
- 模型在页面与原生两侧都用固定 SHA-256 校验，不一致即回退静态 PNG。