# 栗栗与露米：参考图外观候选稿 v3

更新日期：2026-10-24。目标是参考图中的小鹿与法师小猫，分别交付独立角色，不带海报背景、地面、展示台或第三个角色。

露米后续另有[自然版建模精修 v4](../lumi-natural-v4/README.md)，针对眼睑、连续口鼻、持杖爪和布料做进一步调整；本目录 v3 和栗栗保持不变。

## 提示词与预览

| 角色 | 独立完整提示词 | 透明主视图预览 | 面部细节预览 |
| --- | --- | --- | --- |
| 小鹿栗栗 Lili | [小鹿建模与基础动作提示词](./lili-modeling-prompt.md) | [小鹿主视图](./lili-hero-preview.png) | [小鹿脸部](./lili-detail-preview.png) |
| 法师小猫露米 Lumi | [小猫建模与基础动作提示词](./lumi-modeling-prompt.md) | [小猫主视图](./lumi-hero-preview.png) | [小猫脸部](./lumi-detail-preview.png) |

每份提示词包含中文外观细节、英文制作提示词、负面提示词、绑定要求和七个基础动作的帧级说明：呼吸、眨眼、倾听转头、招手、点头、指引、原地轻踏步。动作覆盖时长、关键姿态、左右手、眼神、耳朵、尾巴/围巾/披风的延迟、接触和防穿模要求。**动作清单是下一阶段制作目标，当前交付没有骨骼绑定或这些动画。**

动作风格按“自然一点”的反馈调整为安静、轻柔、有重量：减少呼吸幅度，眨眼独立调度，通常一次小招手/点头，视线先于头部，耳尾不持续摆动，配件随受力逐渐停稳，动作之间保留静止。表中时序是可微调的制作起点，不是固定节拍；自然感不能靠逐帧随机抖动获得。

## 本次实际使用的制作流程

选择已有原创 Blender 源工程精修，而不是用 Three.js 基础几何重做一遍，也没有将已有角色重新送到图生三维服务。产品已有 Three.js 实时展示链路，此时更需要保留原模型的身份、真实毛曲线和配件层次。

1. 在独立、隐藏的 Blender 进程中加载原始源工程，原件不覆盖。
2. 通过本机已安装的 Blender MCP 插件命令桥执行精修脚本，只监听 `127.0.0.1`。这是插件的本地桥接调用，**不是本会话原生连接器直接调用**。
3. 小鹿重建自然提灯手臂及接触手指，制作独立的金属/玻璃提灯，增加第二条针织围巾尾，调整鹿角、瞳孔和梳毛；小猫调整幼态比例、瞳孔与莓紫披风，替换为真实五角星刺绣，保留魔杖、胸针、挎包与尾巴。
4. 使用 Blender 5.2.2 LTS / Cycles / OPTIX 渲染，每张 160 samples，AgX 色彩管理。主视图、正面、侧面、背面各为 2400 × 2800，脸部特写为 2400 × 2400；全部是 16-bit RGBA 真透明 PNG。预览缩小为 8-bit RGBA，仍保留透明通道。
5. 校验候选 `.blend` 哈希、五视图元数据、透明通道和完整全身轮廓的画面留白，再打包本地交付文件。

本次未调用 AI 图像生成、AI 精修、ComfyUI、Tripo 或 Unity，也不冒充已使用这些服务。“电影级”是提示词的近景制作目标，不是自动获得的质量认证或移动端性能保证。

## 交付位置与当前边界

仓库提交提示词、精修/本地桥接/校验打包脚本、缩小预览和 `delivery-manifest.json`。较大的可编辑源工程与全分辨率渲染位于被 Git 忽略的本地 `work/`，**不会随本次 Git 提交上传**：

```text
work/character-reference-v3/
  lili/
    lili-reference-v3.blend
    lili-hero.png
    lili-front.png
    lili-side.png
    lili-back.png
    lili-detail.png
    candidate-manifest.json
  lumi/
    lumi-reference-v3.blend
    lumi-hero.png
    lumi-front.png
    lumi-side.png
    lumi-back.png
    lumi-detail.png
    candidate-manifest.json
  lili-reference-v3-delivery.zip
  lumi-reference-v3-delivery.zip
```

每个 ZIP 包含该角色 `.blend`、五张高清渲染、候选清单、完整提示词与交付说明。原始源工程的 SHA-256 和候选工程 SHA-256 均记录在清单中。`.blend` 保留可编辑几何、毛曲线、材质、相机与灯光；角色之外没有背景网格。

这批是**静态外观审阅候选稿**，不是已完成手工拓扑、蒙皮、布料动画、动作片段或实时烘焙的最终资产。没有替换 `apps/web/public/models/lili/`、`apps/web/public/models/lumi/` 中的正式 GLB；也没有把物体整体摆动标成骨骼动画。先确认外观，再按提示词绑定并验证动作，随后单独制作与验收移动端 GLB。

## 复现精修与渲染

前提：可访问两份原始 `.blend` 源工程、已安装支持这些毛曲线的 Blender 和 Blender MCP 插件。精修脚本使用 Blender 自带的 `bpy`、`mathutils` 与 NumPy；打包预览脚本另需 Python 3.11+ 和 Pillow。原工程不包含在 Git 仓库内，只有仓库克隆并不足以独立重建。

在 PowerShell 中按本机安装路径设置参数；下面先展示小鹿，小猫使用自己的原件、端口 `9892`、角色参数 `lumi` 和输出目录。使用独立进程，不连接或覆盖正在工作的其他 Blender 会话。

```powershell
$blender = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'
$addon = Join-Path $env:APPDATA 'Blender Foundation\Blender\5.2\scripts\addons\blender_mcp.py'
$sourceBlend = 'D:\your-original-models\microglow_deer_independent.blend'
$bridge = (Resolve-Path 'scripts/characters/blender-mcp-local.py').Path
$refine = (Resolve-Path 'scripts/characters/refine-reference-characters.py').Path
$output = Join-Path (Get-Location) 'work/character-reference-v3/lili'
$launchArgs = @('"' + $sourceBlend + '"', '--python', '"' + $bridge + '"', '--',
    'serve', '--addon', '"' + $addon + '"', '--port', '9891')
$process = Start-Process -FilePath $blender -ArgumentList $launchArgs -WindowStyle Hidden -PassThru
```

等待插件本地端口启动后执行：

```powershell
$renderArgs = ConvertTo-Json -Compress -InputObject @('--character', 'lili', '--output', $output,
    '--size', '2400', '--samples', '160', '--views', 'hero', 'front', 'side', 'back', 'detail')
python scripts/characters/blender-mcp-local.py call --port 9891 --timeout 1800 --script $refine --arguments $renderArgs
```

脚本必须从原工程开始，不允许在已精修候选工程上重复应用。仅渲染既有候选工程可加 `--render-only`；先保存外观而暂不渲染可使用 `--prepare-only`。默认会在各自输出目录写入新候选，不修改源工程。原件名称分别为 `microglow_deer_independent.blend`、`microglow_cat.blend`，需保留原始角色集合。

两角色五视图完成后，在仓库根目录运行：

```powershell
python scripts/characters/package-reference-review.py
pnpm exec vitest run tests/platform/lili-model.test.ts tests/platform/lumi-model.test.ts tests/platform/lumi-studio.test.ts
```

前一个命令校验实际图片/源工程并更新预览、清单和本地 ZIP；后一个命令只回归现有正式角色资产与展示逻辑，不代表新候选已完成绑定或移动端验收。任务完成后关闭专门启动的隐藏 Blender 进程，不长期暴露可执行代码的本地端口；不要停止不属于本任务的用户会话。
