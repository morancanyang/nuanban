# 微光指引 · Windows 本地离线唤醒

> 文档同步：2026-10-22。产品显示名称为**微光指引**；[当前功能与平台边界](../../../docs/implementation/product-current-state.md)统一说明现行入口、已实现范围和待验证能力。本文已有测试数字与生成日期仍只对应原批次，不因文档更新自动视为重新验收。

`windows-local-wake.cjs` 导出 `createWindowsLocalWake`，只使用本机 Windows PowerShell 5.1、System.Speech 与已安装的 zh-CN SpeechRecognitionEngine。没有云端常听替代、不安装语言包、不更改 Windows 隐私设置。构造默认 disabled，不启动 helper、不打开麦克风、不恢复上一次授权。

## 稳定接口

```js
const { createWindowsLocalWake } = require('./windows-local-wake.cjs');
const wake = createWindowsLocalWake({ onWake, onQuestion, onState });
const capabilities = await wake.probe({ signal });
const current = wake.snapshot();
await wake.disable();
```

- `probe({ signal }?)`：只枚举/构造已安装的本地引擎、载入唤醒与可选听写语法并使用 `SetInputToNull`。不调用 `SetInputToDefaultAudioDevice` 或 `RecognizeAsync`，等待真实 helper 退出后返回 `{ status: 'complete', recognizers: [{ culture, name, id }], dictationAvailable, dictationReason?, microphoneOpened: false, localOnly: true }`；失败返回 `{ status: 'unavailable', reason }`，不得伪造支持。probe 不改变 disabled 开关。
- `enable({ actor: 'owner', confirmed: true, signal })`：仅在 host 本人原生用途确认后调用；这些字段是调用契约，不代替 host 的身份/同意核验。缺少确认、已取消、非 Windows 或另有 worker 时拒绝，不排队。仅该分支才打开默认麦克风并执行一次 `RecognizeAsync(Multiple)`。Promise 在 ready 后返回状态；失败则等待进程真实退出后抛出带 `code` 的脱敏错误。
- `disable()`：立即使旧 generation 失效，不再发送任何唤醒/提问；先发 stop，500 毫秒内未退出则 kill。Promise 只在真实子进程 `close` 后完成；重复调用共享等待并再次尝试 kill。系统拒绝终止时保持 pending，不能超时伪装停麦，不能新建第二个进程。已关闭时幂等。
- `snapshot()` 与 `onState(state)`：`{ state, enabled, microphoneActive, generation, reason?, localOnly: true, dictationAvailable }`，其中 state 为 `disabled | starting | listening | question | stopping | unavailable | error`。`enabled`/`microphoneActive` 是保守的“可能仍持麦”，不是精确硬件测量：从 enable 启动阶段（包括 ready 前）起，到 stopping/故障但尚未真实退出时都为 true，仅实际 close 后为 false。probe-only 始终为 false。host 必须等待 disable 且两字段都为 false 才展示已停麦。
- `onWake({ localOnly: true, generation, dictationAvailable })`：仅严格本地语法 `暖伴`、`暖伴暖伴`、`小暖` 命中才回调，未唤醒语音不输出正文。host 可打开桌宠输入区，不得据此恢复屏幕采集或代替用户执行第三方操作。
- `onQuestion(text)`：可选本地听写的一轮字符串，最多 500 个 UTF-16 单元；每轮独立 questionId。听写置信度不足时不会输出候选文字：直接听写返回 `uncertain` 并停麦，唤醒后的听写回到严格唤醒状态。未唤醒、旧进程/旧轮次、超时/撤权后结果不传出。无听写支持时只 onWake，不伪造问题。此模块不联网，host 对提问文字的后续 runtime.ask/云端用途须另守自身授权边界；不提供音频出口。

host 负责锁屏、挂起、本人撤权、渲染失效和退出时调用并等待 disable；屏幕停止与语音开关相互独立。失败/权限拒绝/进程退出绝不自动重连，恢复必须本人新的明确动作。

## 有界和隐私

每个适配器 probe/enable 共用一个 worker 槽位；hidden、无 profile、非交互启动，`windowsHide: true`、`shell: false`，仅 stdin/stdout/stderr 管道。随机 token + generation 绑定每个命令/事件，严格 UTF-8 解码（包括进程退出时末尾校验），不把异常消息、识别正文或原始 stderr 放入状态/console。

默认启动/probe 超时 8000 毫秒，可设 500..60000；单轮问题默认 8000 毫秒，可设 1000..30000。host 和 helper 均有问题期限，超时回到严格唤醒语法，不发送问题。helper 队列最多 16 个事件，stdin 命令最多 4096 字节，Node 每进程累计 stdout 默认 65536 字节、可设 256..262144，stderr 最多 8192 字节。累计输出达到上限会 fail closed 并停进程，需要本人重新 enable，不静默重启以绕过上限。

仅使用内存本地识别，不访问 RecognitionResult.Audio，不录制音频 buffer、不写音频/转录/日志文件、不传云。语音引擎内部为实时识别所需的系统内存不是可供调用方导出的录音；托管文本字符串无法承诺立即清零，helper 退出时释放。PowerShell 文件保持 ASCII，以代码点组装中文短语，避免 Windows PowerShell 5.1 的无 BOM 编码问题。

常见 reason：`wake_zh_cn_recognizer_unavailable` / `wake_speech_assembly_unavailable` 提示本机缺少离线支持；`wake_dictation_unavailable` 只禁用听写、不禁用唤醒；`wake_microphone_access_denied` 提示系统拒绝麦克风访问并停止，不能自动修改授权；`wake_start_timeout` / `wake_output_limit` / `wake_helper_exited` 提示本地唤醒已故障。错误中的两项持麦标记在实际退出前仍为 true，不能仅凭 state 为 error 就展示已关闭。

## 安全验证（不启麦）

从仓库根目录运行：

```powershell
pnpm exec vitest run tests/platform/desktop-local-wake.test.ts
node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck tests/platform/desktop-local-wake.test.ts
node -e "(async()=>{const {createWindowsLocalWake}=require('./apps/desktop/wake/windows-local-wake.cjs');const wake=createWindowsLocalWake({timeoutMs:12000});try{console.log(JSON.stringify({probe:await wake.probe(),snapshot:wake.snapshot()}));}finally{await wake.disable();}})().catch(()=>{process.exitCode=1;})"
```

单元测试注入合成进程/事件，不启动真实 PowerShell 麦克风识别；真实 probe 命令只探测安装能力，成功必须含 `microphoneOpened: false`，snapshot 的两项持麦标记必须为 false。无实际语音、屏幕或转录数据输出。

2026-10-18 的本机无麦 probe 真实返回 zh-CN 引擎 `MS-2052-80-DESK`、dictationAvailable true，状态保持 disabled。这不等于已经验证麦克风权限、实际唤醒率、实际听写或噪声表现；这些必须本人新确认后另行手工验收，本轮没有启麦测试。

## 麦克风信号提示（C2，2026-10-23）

现场实测：内置麦克风阵列音量 87% 且未静音、离线 zh-CN 引擎在位、helper 进程在运行，但拾音电平仅 31/100，引擎报 `TooSoft/TooNoisy/TooSlow`，识别置信度只有 0.03~0.05 → 被判为不确定而拒绝，界面**完全静默**。为此新增**建议性**信号事件，让"没反应"变成"看得到原因"：

- 协议事件：`{ kind: 'signal', level: 0..100, problem: 'none'|'TooNoisy'|'NoSignal'|'TooLoud'|'TooSoft'|'TooFast'|'TooSlow'|'Unknown' }`。
- 采集方式：`AudioLevelUpdated` / `AudioSignalProblemOccurred` 回调**只写脚本变量**（回调线程不写 stdout，避免协议行交错）；由主轮询循环按 500ms 节流发出，仅在 problem 变化或电平变化 ≥5 时发送。
- 桥接侧：`windows-local-wake.cjs` 校验 `level` 为 0..100 整数且 problem 在白名单内，合法则写入 `status.signal` 并重新发布状态；**非法载荷一律忽略**，永不因此判定操作失败，也不改变 `enabled`/`microphoneActive`/`dictationAvailable` 语义。
- UI 侧：`local-voice-panel.tsx` 显示实时电平条与 `micSignalHint()` 建议（信号过弱→靠近麦克风/提高输入音量；环境噪声→关闭噪声源或用耳机麦；语速或停顿→连贯说一句）。
- **边界**：不改动 0.6/0.78 置信度阈值，不引入云端识别，信号提示不代表已识别成功；真实机型与真实房间的唤醒率/听写率仍需本人现场验收。

## 官方 API 核对

- Microsoft SpeechRecognitionEngine、InstalledRecognizers、RecognizeAsync、SetInputToDefaultAudioDevice：https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine?view=netframework-4.8.1
- Microsoft Grammar.Enabled（语法加载和启用独立）：https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.grammar.enabled?view=netframework-4.8.1
- Microsoft DictationGrammar：https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.dictationgrammar?view=netframework-4.8.1
- Microsoft RecognizeAsyncCancel：https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine.recognizeasynccancel?view=netframework-4.8.1
- Microsoft PowerShell Register-ObjectEvent：https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/register-objectevent?view=powershell-5.1
