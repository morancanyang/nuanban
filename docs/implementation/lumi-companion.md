# 露米 Lumi 原版小猫接入

更新：2026-10-23。产品名称为「微光指引」，角色资产版本为 `2.0.0`。

## 造型来源与修正

当前小猫来自用户确认的 `microglow_cat.blend`，原角色集合为 `MICROGLOW_CAT_ONLY`。保留原有头脸与身体比例、奶油白皮毛、蓝青虹膜、紫金披风、青绿胸针、星形法杖和棕色斜挎包。只导出小猫本体与配饰，不导出其他角色、相机、灯光、背景、地面或展示台。

此前预览与桌宠曾用 `createLumiModel()` 生成另一套程序化简化造型，导致页面展示与用户确认的图片不一致。现在预览通过 `loadLumiModel(signal)` 读取并校验真实 GLB；桌宠直接显示已保存的真实模型，不再用该替代造型覆盖。识别到旧版内置小猫的固定哈希时，显示新版随包 GLB；用户再次召唤后才将新版保存到本机，不自动改写个人导入模型。

## 资源与运行预算

资源位于 `apps/web/public/models/lumi/`，Web 构建时复制至 `dist/models/lumi/`，桌面打包时复制至 `ui/models/lumi/`。

| 文件 | 用途 |
| --- | --- |
| `Lumi_Magical_Kitten.glb` | 自包含实时角色，内嵌材质、纹理和轻微待机动画 |
| `character_manifest.json` | 原工程 SHA-256、运行文件哈希、实际面数、纹理与转换限制 |
| `poster.png` | 同一原工程的透明背景预览，用于静态展示和页面陪伴 |

运行模型为 97,978 个三角面、148 个 glTF mesh、149 个可渲染 primitive、19 个材质，仍遵守桌面端既有 100,000 三角面上限。文件 5,411,364 字节，不放宽 50 MiB 文件限制、256 MiB 解码限制或任何模型安全检查。

三张内嵌 PNG 分别提供短毛法线、披风织纹法线和从原材质烘焙的蓝色虹膜。源工程的 173,800 根曲线毛发按原生长方向采样成 12,364 根渐细三角网格毛束，并辅以短毛法线；这是实时适配，不是影视毛发无损导出。材质使用标准 glTF PBR 及查看器已支持的扩展，金属、角膜和宝石仍遵循实时渲染限制，不能承诺与离线电影渲染逐像素一致。

源工程没有骨骼绑定、面部形变或动画拓扑。本次只增加整体轻微起伏的 `idle`，界面只开放「陪伴」，不再宣称九个身体动作、三十根骨骼或面部表情。后续需在同一原模型上独立完成绑定后才能开放挥手、走路、眨眼等动作。

## 本机与网页路径

- 「预览 3D 与动作」显示真实模型，支持旋转和缩放；收起时释放 WebGL 资源。
- Windows「设为桌面小伙伴」需用户确认，随后执行白名单读取、文件哈希检查、隔离渲染验证，再写入本机 SQLite。取消或验证失败不替换原伙伴。
- 旧版内置小猫已经选中时可「再次召唤桌宠」以保存新版，重启后恢复。个人导入模型不参与旧版迁移。
- 手机和没有原生桥的网页可预览，页面陪伴使用同源 `poster.png`，不写本机桌宠数据库，也不把模型上传至网络服务。

`apps/web/src/three-d/builtin-models.ts` 和 `apps/desktop/local-model.cjs` 分别固定运行哈希；更新资产时需同步更新两处及相应测试。桌面只读 IPC `readBuiltin('lumi')` 不开放任意路径或 URL，不放宽 CSP。

## 可复现转换与验证

使用 Blender 在独立后台进程打开原工程，避免操作其他正在建模的场景。脚本不保存或覆盖原 `.blend`：

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background '<microglow_cat.blend>' --python scripts/export-lumi-runtime.py -- '<output-directory>'
```

确认预览后，将输出的 GLB、manifest 与 poster 一起替换随包资源，更新固定哈希和文件长度。

```text
pnpm typecheck
pnpm exec vitest run tests/platform/lumi-model.test.ts tests/platform/desktop-local-model.test.ts
pnpm exec playwright test tests/e2e/lumi-companion.spec.ts
pnpm --filter @nuanban/web build
node scripts/check-lumi-electron.cjs
```

单元测试检查原始来源、单角色结构、嵌入贴图、面数与动画边界；无 DOM 环境下仅移除材质贴图引用以解析几何，真实贴图解码和首帧可见性由浏览器与 Electron 验收覆盖。`scripts/prepare-lumi-model.mjs` 只适用于历史带稀疏表情访问器的旧文件，不能用于把旧简化模型覆盖回当前版本。
