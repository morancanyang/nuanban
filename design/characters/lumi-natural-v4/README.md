# 露米自然版建模精修 v4

更新日期：2026-10-24。仅精修小猫露米，保留奶油色绒毛、蓝绿眼睛、紫莓色披风、金色五角星、椭圆胸针、棕色斜挎包与魔杖；小鹿栗栗和正式产品 GLB 均不改变。角色独立输出，背景透明，没有场景、底板或展示台。

## 本轮外观修改

- 调整眼睛比例和蓝绿虹膜，瞳孔保持柔和张开；眼球按脸部弧度安放，眼睑加入细绒毛过渡，眉毛和眼线渐尖，减少生硬的白色眼圈。
- 口鼻与头部合成连续网格并重新梳毛，减轻独立白色球块和下巴贴片的感觉；鼻头改为软倒三角，微笑线和胡须更细。
- 持杖爪改为连续雕刻网格，三枚圆润爪指与拇指环握杖柄；按实际杖柄曲线切出接触通道，重新生成短毛，而不是添加两个白色圆球。
- 披风改用低反光交织布料，保留内衬和实体厚度；领口改为较薄的柔软翻折面，加入独立细针脚，五角星与金边随轻微褶皱一起变形。
- 耳内增加轻微凹陷、柔和透光与稀疏细毛，调整摄影棚反射，保留奶油毛色和干净眼神。

## 预览与交付

| 视图 | 仓库中的透明缩小预览 | 本地 16 位 RGBA 母版 |
| --- | --- | --- |
| 三分之四主视图 | [主视图](./lumi-hero-preview.png) | `work/lumi-natural-v4/lumi-hero.png`，2400 × 2800 |
| 正面 | [正面](./lumi-front-preview.png) | `work/lumi-natural-v4/lumi-front.png`，2400 × 2800 |
| 右侧面 | [侧面](./lumi-side-preview.png) | `work/lumi-natural-v4/lumi-side.png`，2400 × 2800 |
| 背面 | [背面](./lumi-back-preview.png) | `work/lumi-natural-v4/lumi-back.png`，2400 × 2800 |
| 脸部近景 | [脸部](./lumi-detail-preview.png) | `work/lumi-natural-v4/lumi-detail.png`，2400 × 2400 |
| 握杖近景 | [爪子](./lumi-grip-preview.png) | `work/lumi-natural-v4/lumi-grip.png`，2400 × 2400 |

六张图片均从同一模型使用 Blender Cycles 输出，没有通过二维改图替代三维修改。可编辑源工程在 `work/lumi-natural-v4/lumi-natural-v4.blend`；本地完整交付包为 `work/lumi-natural-v4/lumi-natural-v4-delivery.zip`。交付包包含源工程、六张高清图、候选清单、说明和下一阶段动作规格。`delivery-manifest.json` 记录源文件与候选文件的 SHA-256、实际毛曲线数量、图片尺寸、透明边界和打包校验值。

本次母版为 Cycles 192 采样，保留 215,319 条毛曲线。头部与握杖爪均通过单连通网格、无非流形边和正体积校验；这只说明静态雕刻网格连通，不等于完成动画变形拓扑或全角色动态防穿模验收。

**大体积源工程、母版和 ZIP 保存在 Git 忽略的本地 `work/`，没有上传到 GitHub。** 仓库提交的是可复现脚本、说明、清单和六张缩小预览。v3 工程和预览保留，不覆盖原始模型。

## 当前边界

后续交付（2026-10-24）：已从本静态源另行制作[自然动作版 GLB、七个绑定动作与产品接口](../../../docs/implementation/lumi-animated-v4-interface.md)。该版本独立登记为 `lumi-animated-v4`，不覆盖本目录的静态源和历史预览；下述边界描述的是本轮静态外观精修交付。

这是静态外观精修候选，不是最终绑定资产。未新增骨骼、表情形态键、七个动作片段或移动端 GLB，未以整体浮动冒充呼吸。基础动作仍以[完整外观与自然动作规格](../reference-v3/lumi-modeling-prompt.md)为后续目标，确认外观后才能继续绑定和穿模验收。

本轮通过已安装的 Blender MCP 插件在独立隐藏进程中提供本机环回桥接，并实际执行 `bpy` 建模与 Cycles 渲染；不是原生 MCP 连接器调用，也没有使用未连接的 AI 精修、ComfyUI、Tripo 或 Unity 服务。不能将本轮预览等同于已完成电影制作全流程或已通过手机性能验收。

## 复现

需要本地 v3 源工程 `work/character-reference-v3/lumi/lumi-reference-v3.blend`、兼容这些毛曲线的 Blender、已安装的 Blender MCP 插件，以及 Python 3.11+ / Pillow。仅克隆仓库不含原工程，无法单独重建。

从仓库根目录在 PowerShell 中运行，按本机安装情况调整路径：

```powershell
$blender = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'
$source = (Resolve-Path 'work/character-reference-v3/lumi/lumi-reference-v3.blend').Path
$bridge = (Resolve-Path 'scripts/characters/blender-mcp-local.py').Path
$addon = Join-Path $env:APPDATA 'Blender Foundation\Blender\5.2\scripts\addons\blender_mcp.py'
$output = Join-Path (Get-Location) 'work/lumi-natural-v4'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$arguments = '--factory-startup "{0}" --python "{1}" -- serve --port 9892 --addon "{2}"' -f $source, $bridge, $addon
$process = Start-Process -FilePath $blender -ArgumentList $arguments -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $output 'blender-run.log') `
  -RedirectStandardError (Join-Path $output 'blender-error.log')
```

确认日志中已监听 `127.0.0.1:9892` 后执行；如果端口已被其他会话使用，请为新进程和客户端一致选择另一个空闲端口。不要连接、覆盖或停止其他人的 Blender 工作。

```powershell
python scripts/characters/blender-mcp-local.py call --port 9892 --timeout 180 --script scripts/characters/refine-lumi-natural.py --arguments '["--prepare-only"]'
python scripts/characters/blender-mcp-local.py call --port 9892 --timeout 900 --script scripts/characters/refine-lumi-natural.py --arguments '["--render-only"]'
python scripts/characters/package-lumi-natural-review.py
pnpm exec vitest run tests/platform/lili-model.test.ts tests/platform/lumi-model.test.ts tests/platform/lumi-studio.test.ts
```

精修脚本只接受尚未精修的 v3 小猫源工程，另存 v4，不允许对已精修场景重复叠加修改。渲染阶段使用保存的 v4；可传 `--draft --size 960 --samples 48 --views hero detail grip` 输出带 `draft-` 前缀的试渲染，不把试渲染列为高清母版。打包脚本拒绝缺图、非 2400 像素母版、位深不符、缺失透明通道、全身裁切、低采样和源文件校验不符的交付。

测试只回归现有正式角色资产和展示逻辑，不代表候选完成绑定。完成后关闭本任务专用的隐藏 Blender 进程，释放可执行代码的环回端口：

```powershell
python scripts/characters/blender-mcp-local.py call --port 9892 --code 'import bpy; bpy.app.timers.register(lambda: bpy.ops.wm.quit_blender(), first_interval=1.0)'
```
