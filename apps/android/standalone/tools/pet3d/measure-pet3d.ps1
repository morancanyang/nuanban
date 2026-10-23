param(
    [string]$Serial,
    [string]$Package = 'org.nuanban.assistant.standalone',
    [ValidateSet('webview_three_js', 'native_gl', 'static_png')]
    [string]$Phase = 'webview_three_js',
    [int]$DurationSeconds = 600,
    [string]$OutputPath = '',
    [switch]$SkipBatteryReset
)
$ErrorActionPreference = 'Stop'
# 独立桌宠实时 3D 的真机测量脚本（本地离线执行，只依赖 adb；不联网、不上传）。
#
# 本仓库开发机没有 Android 设备/AVD，因此这里**没有**任何实测结果：脚本只负责在真机上采集并落盘原始数据，
# 判据在 docs/implementation/android-3d-pet.md。没有设备时明确失败并写出 deviceVerified=false，绝不估算成事实。
#
# 用法（每个形态各跑一次，跑之前请在本机面板里切到对应形态）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File apps/android/standalone/tools/pet3d/measure-pet3d.ps1 `
#     -Serial <device-serial> -Phase webview_three_js -DurationSeconds 600 -OutputPath <json>
$adb = (Get-Command adb -ErrorAction SilentlyContinue)?.Source
if (-not $adb) {
    $sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
    if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
    $candidate = Join-Path $sdk 'platform-tools/adb.exe'
    if (Test-Path -LiteralPath $candidate) { $adb = $candidate }
}
if (-not $adb) { throw '需要 adb（Android platform-tools）。本机未找到，测量无法进行。' }

$devices = & $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match '\sdevice$' } | ForEach-Object { ($_ -split '\s+')[0] }
if (-not $Serial) { $Serial = $devices | Select-Object -First 1 }
$devicePresent = [bool]$Serial -and ($devices -contains $Serial)
if (-not $devicePresent) {
    $payload = [ordered]@{
        deviceVerified = $false
        executed = $false
        reason = 'no_device_attached'
        detectedDevices = @($devices)
        phase = $Phase
        measuredAt = (Get-Date).ToString('o')
    }
    if ($OutputPath) { $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputPath -Encoding UTF8 }
    $payload | ConvertTo-Json -Depth 5 -Compress
    Write-Error '没有可用的 Android 设备（adb devices 为空）：测量未执行，deviceVerified=false。'
    exit 1
}

function Invoke-Adb([string[]]$Arguments) {
    $result = & $adb '-s' $Serial @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw ('adb 失败：' + ($Arguments -join ' ') + ' -> ' + ($result -join ' ')) }
    return ($result -join [Environment]::NewLine)
}

$workRoot = if ($OutputPath) { Split-Path -Parent $OutputPath } else { Join-Path $env:TEMP ('nuanban-pet3d-' + (Get-Date).ToString('yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
$logcatPath = Join-Path $workRoot ("logcat-pet3d-$Phase.txt")
$gfxBeforePath = Join-Path $workRoot ("gfxinfo-before-$Phase.txt")
$gfxAfterPath = Join-Path $workRoot ("gfxinfo-after-$Phase.txt")
$memPath = Join-Path $workRoot ("meminfo-$Phase.txt")
$batteryPath = Join-Path $workRoot ("batterystats-$Phase.txt")
$thermalPath = Join-Path $workRoot ("thermalservice-$Phase.txt")

$deviceInfo = [ordered]@{
    serial = $Serial
    release = (Invoke-Adb @('shell', 'getprop', 'ro.build.version.release')).Trim()
    sdk = (Invoke-Adb @('shell', 'getprop', 'ro.build.version.sdk')).Trim()
    model = (Invoke-Adb @('shell', 'getprop', 'ro.product.model')).Trim()
    totalRamMb = (Invoke-Adb @('shell', 'cat', '/proc/meminfo') | Select-String '^MemTotal:' | ForEach-Object { [int](($_.Line -replace '\D', '') ) } | Select-Object -First 1)
    webViewVersion = (Invoke-Adb @('shell', 'dumpsys', 'webviewupdate') | Select-String 'Current WebView package' | ForEach-Object { $_.Line.Trim() } | Select-Object -First 1)
}

# 1) 基线：重置电池统计、清空 gfxinfo 与 logcat，再采一次"运行前"快照。
if (-not $SkipBatteryReset) { Invoke-Adb @('shell', 'dumpsys', 'batterystats', '--reset') | Out-Null }
Invoke-Adb @('shell', 'dumpsys', 'gfxinfo', $Package, 'reset') | Out-Null
Invoke-Adb @('logcat', '-c') | Out-Null
(Invoke-Adb @('shell', 'dumpsys', 'gfxinfo', $Package)) | Set-Content -LiteralPath $gfxBeforePath -Encoding UTF8

Write-Host ("请在设备上确认独立桌宠已在运行，并在面板里切到形态：" + $Phase + "；开始采集 " + $DurationSeconds + " 秒。")
$logcatJob = Start-Job -ScriptBlock {
    param($adbPath, $serial, $package, $outPath)
    & $adbPath '-s' $serial logcat -s 'NuanbanPet3d:I' '*:S' | Out-File -LiteralPath $outPath -Encoding utf8
} -ArgumentList $adb, $Serial, $Package, $logcatPath
Start-Sleep -Seconds ([Math]::Max(1, $DurationSeconds))

# 2) 结束采集：停 logcat，取 gfxinfo / meminfo / batterystats / 温度。
Stop-Job -Job $logcatJob -ErrorAction SilentlyContinue
Remove-Job -Job $logcatJob -Force -ErrorAction SilentlyContinue
(Invoke-Adb @('shell', 'dumpsys', 'gfxinfo', $Package, 'framestats')) | Set-Content -LiteralPath $gfxAfterPath -Encoding UTF8
(Invoke-Adb @('shell', 'dumpsys', 'meminfo', $Package)) | Set-Content -LiteralPath $memPath -Encoding UTF8
(Invoke-Adb @('shell', 'dumpsys', 'batterystats', '--charged', $Package)) | Set-Content -LiteralPath $batteryPath -Encoding UTF8
(Invoke-Adb @('shell', 'dumpsys', 'thermalservice')) | Set-Content -LiteralPath $thermalPath -Encoding UTF8

# 3) 只做"搬运 + 提取"，不做估算：取不到就是 null。
$logLines = if (Test-Path -LiteralPath $logcatPath) { Get-Content -LiteralPath $logcatPath | Where-Object { $_ -match 'mode=' } } else { @() }
$statsSamples = @($logLines | ForEach-Object {
    $line = $_
    $average = [regex]::Match($line, 'avgFps=([0-9.]+)').Groups[1].Value
    $p95 = [regex]::Match($line, 'p95FrameMs=([0-9.]+)').Groups[1].Value
    $worst = [regex]::Match($line, 'worstFrameMs=([0-9.]+)').Groups[1].Value
    $mode = [regex]::Match($line, 'mode=([a-z_]+)').Groups[1].Value
    if ($average) { [ordered]@{ mode = $mode; avgFps = [double]$average; p95FrameMs = [double]$p95; worstFrameMs = [double]$worst } }
} | Where-Object { $_ })
$memText = if (Test-Path -LiteralPath $memPath) { Get-Content -LiteralPath $memPath -Raw } else { '' }
$totalPss = [regex]::Match($memText, 'TOTAL PSS:\s*([0-9,]+)').Groups[1].Value -replace ',', ''
$totalRss = [regex]::Match($memText, 'TOTAL RSS:\s*([0-9,]+)').Groups[1].Value -replace ',', ''
$janky = [regex]::Match((Get-Content -LiteralPath $gfxAfterPath -Raw -ErrorAction SilentlyContinue), 'Janky frames:\s*([0-9]+)\s*\(([0-9.]+)%\)')
$batteryText = if (Test-Path -LiteralPath $batteryPath) { Get-Content -LiteralPath $batteryPath -Raw } else { '' }
$estimatedPower = [regex]::Match($batteryText, 'Estimated power use \(mAh\):\s*([0-9.]+)').Groups[1].Value

$observedFps = if ($statsSamples.Count -gt 0) { ($statsSamples | Measure-Object -Property avgFps -Average).Average } else { $null }
$observedP95 = if ($statsSamples.Count -gt 0) { ($statsSamples | Measure-Object -Property p95FrameMs -Average).Average } else { $null }

$thresholds = [ordered]@{
    sustainedAvgFpsMin = 24
    p95FrameMsMax = 40
    jankyFramesPercentMax = 10
    pssDeltaMbMaxWebView = 80
    pssDeltaMbMaxNativeGl = 30
    batteryDrainPercentPer10MinMax = 3
}
$payload = [ordered]@{
    deviceVerified = $true
    executed = $true
    phase = $Phase
    measuredAt = (Get-Date).ToString('o')
    durationSeconds = $DurationSeconds
    device = $deviceInfo
    observed = [ordered]@{
        frameStatSamples = $statsSamples
        averageOfSamplesAvgFps = $observedFps
        averageOfSamplesP95FrameMs = $observedP95
        totalPssKb = if ($totalPss) { [int]$totalPss } else { $null }
        totalRssKb = if ($totalRss) { [int]$totalRss } else { $null }
        gfxJankyFrames = if ($janky.Success) { [int]$janky.Groups[1].Value } else { $null }
        gfxJankyPercent = if ($janky.Success) { [double]$janky.Groups[2].Value } else { $null }
        estimatedPowerMah = if ($estimatedPower) { [double]$estimatedPower } else { $null }
    }
    thresholds = $thresholds
    rawFiles = [ordered]@{
        logcat = $logcatPath
        gfxinfoBefore = $gfxBeforePath
        gfxinfoAfterFramestats = $gfxAfterPath
        meminfo = $memPath
        batterystats = $batteryPath
        thermalservice = $thermalPath
    }
    notes = @(
        'PSS 增量需要与 static_png 形态的同一脚本结果相减（同设备、同亮度、同会话时长）。',
        'Estimated power use 是系统估算值，需与 static_png 形态对比后判断耗电差异，不要当成绝对功耗。',
        'avgFps / p95FrameMs 取自本机 logcat 的 NuanbanPet3d 窗口统计（每 5 秒一条），不是插值或估算。',
        '形态切换需人工在悬浮面板中完成；脚本只记录 Phase 参数，不代替人判断当前实际形态。'
    )
    deviceVerifiedClaim = 'data collected from a physical device run by this script'
}
if ($OutputPath) { $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding UTF8 }
$payload | ConvertTo-Json -Depth 8 -Compress