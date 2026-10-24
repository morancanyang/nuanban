# 桌宠智能查询 · AnySearch 实时检索

> 文档同步：2026-10-24。产品显示名称为**微光指引**；[当前功能与平台边界](product-current-state.md)统一说明现行入口、已实现范围和待验证能力。本文已有测试数字与生成日期仍只对应原批次，不因文档更新自动视为重新验收。

2026-10-18 曾把桌宠搜索入口临时改为只复用本机模型（不联网检索）。**2026-10-24 起改回 AnySearch 实时检索**：桌宠底部“搜索”、功能页“智能查询”和右键菜单“智能查询”都走同一条链路；用户要的是能核验的实时信息，模型知识回答只在没有密钥时作为如实标注的降级路径。

## 供应选择

| 状态 | 行为 | 页面标注 |
| --- | --- | --- |
| 已配置 AnySearch 密钥 | 调用 `POST https://api.anysearch.com/v1/search`（Bearer 鉴权），展示来源标题/摘要/链接 | “已接入 AnySearch 实时检索 · 结果来自公开网页，可打开原文核对” |
| 无任何密钥，但本机模型可用 | 复用本机已配置模型回答，不上网检索 | “已复用现有模型 · 未接入实时检索；回答不代表已联网核验” |
| 两者都不可用 | 拒绝发送并提示配置 | “AnySearch 实时检索尚未配置密钥 …” 或 “实时检索与本机模型都未就绪 …” |

- AnySearch **已配置但调用失败**（鉴权、额度、超时、畸形回包）时直接报错，不会静默改走模型，避免把模型生成内容冒充检索结果。
- 每次调用按当次读取的密钥判断供应，密钥在运行中配置后无需重启。
- 状态只返回固定供应类型、`configured` 与 `webSearch` 布尔值，不把密钥、网关或上游错误正文返回页面。

## 密钥配置（不入仓库、不入安装包）

密钥明文只允许出现在进程环境变量或本机 DPAPI 加密存储中：

~~~powershell
# 交互输入（不回显，不落盘）
.\scripts\set-anysearch-key.ps1
# 或从密钥文件读取
.\scripts\set-anysearch-key.ps1 -KeyFile C:\path\to\key.txt
~~~

存储位置：`%APPDATA%\@nuanban\desktop\nuanban-anysearch-key.bin`（DPAPI，仅当前 Windows 用户可解密，约 69 字节密文）。环境变量 `NUANBAN_ANYSEARCH_API_KEY`（或官方 `ANYSEARCH_API_KEY`）优先于存储，用于临时验证；两者都不存在时不发匿名请求。

`tests/platform/desktop-anysearch-key-hygiene.test.ts` 会扫描源码、脚本、测试与实现文档，确保没有 `as_sk_` 形式的真实密钥被提交；请勿把密钥写入任何会进版本库的文件。

## 发送与展示

- 打开页面不请求接口。用户手动输入问题并勾选本次发送确认，再点击“请模型回答”才会发送当前问题文本。
- 只发送当前手动问题与固定参数（`max_results: 10`、`language: zh-CN`）；不附带屏幕、麦克风、图片、教学记录、学习档案或搜索历史，不启动观察、语音或其他窗口。
- 本机继续拒绝常见个人号码、密码和密钥格式；这不代表能识别所有隐私。
- 结果只接受本次返回的 **HTTPS** 地址（禁止明文、内网、本机与 IP 直连地址），去重后最多 10 条；标题/摘要做长度与控制字符清洗。
- 链接需用户点击才由系统浏览器打开，页面不执行 HTML/脚本、不自动打开、不提供模型编造的来源按钮。
- 对实时、最新、价格、天气等问题的回答来自检索来源，**仍需用户打开原文核对**；医疗、法律、金融问题仍需可靠原始来源或专业人士确认。

## 停止与失败

- 单次检索 15 秒超时；新查询、停止、离开功能页、停止全部采集和退出都会取消在途请求，迟到结果不能恢复页面或覆盖新结果。
- 鉴权失败、额度不足、超时、取消与畸形回包映射为固定中文提示，无 Mock 或匿名回退。
- 收起或离开页面后撤销本次发送确认，重新打开不会自动发送。取消不保证撤销上游计费。

## 验证方式

~~~powershell
pnpm exec vitest run tests/platform/desktop-pet-search-client.test.ts tests/platform/desktop-anysearch.test.ts tests/platform/desktop-anysearch-settings.test.ts tests/platform/desktop-anysearch-key-hygiene.test.ts tests/platform/desktop-model-search.test.ts tests/platform/desktop-standalone-host.test.ts tests/platform/desktop-pet-ui.test.ts
# 配置密钥后的一次真实调用核对（不打印密钥；可用第二个参数换问题）
apps\desktop\node_modules\electron\dist\electron.exe scripts/check-anysearch-live.cjs "今天北京天气"
~~~

单元与接线测试使用合成供应，验证供应优先级、如实标注、无匿名请求、无静默回退、密钥不回传页面；**不证明真实检索质量**。

2026-10-24 真实调用记录：用本机 DPAPI 存储中的密钥，经 `createPetSearchClient` 组合链路查询“今天北京天气”返回 7 条、查询“2026年10月24日 人民币 美元 汇率”返回 9 条结果，全部为 HTTPS 且来源各异，模型调用次数为 0，状态为 `{provider: AnySearch, configured: true, webSearch: true}`。这只证明该次第三方检索请求成功、结果可投影，不证明内容准确性、持续可用性、额度或所有问题的回答质量，也不能据此改写发布结论。