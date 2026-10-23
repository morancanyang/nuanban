param(
    [string]$Serial,
    [string]$Package = 'org.nuanban.assistant.standalone',
    [ValidateSet('devices', 'install', 'grants', 'verify', 'fallback-missing', 'fallback-corrupt', 'restore', 'tiering-webview-off', 'tiering-webview-on', 'perf', 'all')]
    [string]$Step = 'devices',
    [int]$PerfSeconds = 600,
    [ValidateSet('webview_three_js', 'native_gl', 'static_png')]
    [string]$Phase = 'webview_three_js',
    [string]$ReportPath = '',
    [switch]$Build
)
$ErrorActionPreference = 'Stop'
# 独立桌宠实时 3D 的真机验收脚本：邀请所有者执行，由 lead 记录结果。
#
# 只做两件事：① 用 adb 执行可自动判定的检查并落盘 JSON；② 把必须人眼确认的项按 MANUAL 打印出来，
# **不会**把人工项标记为通过，也不会在缺少设备时给出任何"已验证"结论（deviceVerified=false）。
#
# 典型用法（设备已连接、已授权 USB 调试）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File apps/android/standalone/tools/pet3d/accept-pet3d.ps1 -Step all -Build -Serial <serial> -ReportPath .\pet3d-acceptance.json
#
# 默认包路径：apps/android/standalone/build/outputs/apk/debug/standalone-debug.apk（debug 证书，覆盖安装即可）。

$utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
try { [Console]::OutputEncoding = $utf8 } catch { }
$OutputEncoding = $utf8

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../../..')).Path
$androidRoot = Join-Path $repoRoot 'apps/android'
$apkPath = Join-Path $androidRoot 'standalone/build/outputs/apk/debug/standalone-debug.apk'
$logTag = 'NuanbanPet3d'
$script:deviceVerifiedByThisRun = $false

$adbCommand = Get-Command adb -ErrorAction SilentlyContinue
$adb = if ($adbCommand) { $adbCommand.Source } else { $null }
if (-not $adb) {
    $sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
    $candidate = Join-Path $sdk 'platform-tools/adb.exe'
    if (Test-Path -LiteralPath $candidate) { $adb = $candidate }
}
if (-not $adb) { throw '需要 adb（Android platform-tools）。' }

$results = [ordered]@{}
$manual = [Collections.Generic.List[string]]::new()
$failures = [Collections.Generic.List[string]]::new()

function Note-Manual([string]$Text) { $manual.Add($Text); Write-Host ('MANUAL: ' + $Text) -ForegroundColor Yellow }
function Record([string]$Name, $Value) { $results[$Name] = $Value; Write-Host ('  ' + $Name + ' = ' + ($Value | Out-String).Trim()) }

function Get-Devices {
    return @(& $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match '\s(device|unauthorized|offline)$' } | ForEach-Object {
        $parts = $_ -split '\s+'
        [ordered]@{ serial = $parts[0]; state = $parts[1] }
    })
}

function Require-Device {
    $devices = @(Get-Devices)
    $online = @($devices | Where-Object { $_.state -eq 'device' })
    if (-not $Serial) { $Serial = $online | Select-Object -First 1 | ForEach-Object { $_.serial } }
    $ok = [bool]$Serial -and ($online.serial -contains $Serial)
    Record 'deviceDetected' $ok
    Record 'devices' $devices
    if (-not $ok) { throw ('没有可用的在线设备（serial=' + $Serial + '）。请在设备上允许 USB 调试后重试。') }
    $script:deviceVerifiedByThisRun = $true
}

function Invoke-Adb([string[]]$Arguments, [switch]$AllowFailure) {
    $output = & $adb '-s' $Serial @Arguments 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) { throw ('adb 失败：' + ($Arguments -join ' ') + ' -> ' + ($output -join ' ')) }
    return ($output -join [Environment]::NewLine)
}

function Build-Apk([string]$Variant) {
    $javaHome = $null
    $candidates = @()
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Android/Android Studio/jbr') }
    if ($env:JAVA_HOME) { $candidates += $env:JAVA_HOME }
    $javaHome = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'bin/java.exe')) } | Select-Object -First 1
    if (-not $javaHome) { throw '构建需要本机 JDK（Android Studio 自带 jbr 或 JAVA_HOME）。' }
    $env:JAVA_HOME = $javaHome
    if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA 'Android/Sdk' } }
    $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
    $arguments = @('-p', $androidRoot, ':standalone:assembleDebug', '--offline', '--no-daemon')
    if ($Variant -and $Variant -ne 'full') { $arguments += ('-Ppet3dModelVariant=' + $Variant) }
    & (Join-Path $androidRoot 'gradlew.bat') @arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw ('构建失败：' + ($arguments -join ' ')) }
    $variantLabel = if ($Variant) { $Variant } else { 'full' }
    Record 'builtVariant' $variantLabel
}

function Install-Apk {
    if (-not (Test-Path -LiteralPath $apkPath)) { throw ('缺少 APK：' + $apkPath + '（先跑 -Build 或自行构建）') }
    $installed = Invoke-Adb @('install', '-r', '-d', $apkPath) -AllowFailure
    Record 'installOutput' $installed.Trim()
    if ($installed -notmatch 'Success') { throw '安装失败，请检查上面 adb 输出（debug 证书不一致时需先卸载）。' }
    Record 'packagePath' ((Invoke-Adb @('shell', 'pm', 'path', $Package)).Trim())
    $version = Invoke-Adb @('shell', 'dumpsys', 'package', $Package)
    Record 'versionName' ([regex]::Match($version, 'versionName=([^\s]+)').Groups[1].Value)
    Record 'apkSha256' ((Get-FileHash -LiteralPath $apkPath -Algorithm SHA256).Hash.ToLowerInvariant())
}

function Start-Pet {
    # 与在应用内点按"本人开启观察"等价；服务需要已授予浮层与通知权限，否则会自行停止。
    $output = Invoke-Adb @('shell', 'am', 'start-foreground-service', '-n', ($Package + '/org.nuanban.assistant.nativehost.PetRuntimeService'), '-a', 'org.nuanban.assistant.START_PET_BY_USER') -AllowFailure
    Record 'startPetOutput' $output.Trim()
    Start-Sleep -Seconds 12
}

function Stop-Pet {
    Invoke-Adb @('shell', 'am', 'force-stop', $Package) -AllowFailure | Out-Null
    Start-Sleep -Seconds 2
}

function Read-Pet3dLog([int]$Lines = 200) {
    $raw = Invoke-Adb @('logcat', '-d', '-t', "$Lines", '-s', ($logTag + ':V')) -AllowFailure
    return @($raw -split "`n" | Where-Object { $_ -match $logTag })
}

function Get-LogFacts([string[]]$LogLines) {
    $modes = @($LogLines | ForEach-Object { [regex]::Match($_, 'mode=([A-Za-z_]+)').Groups[1].Value } | Where-Object { $_ })
    $reasons = @($LogLines | ForEach-Object { [regex]::Match($_, 'reason=([A-Za-z0-9_:.]+)').Groups[1].Value } | Where-Object { $_ })
    $rendererFailures = @($LogLines | ForEach-Object { [regex]::Match($_, 'renderer_failed reason=([A-Za-z0-9_:.]+)').Groups[1].Value } | Where-Object { $_ })
    $ready = @($LogLines | Where-Object { $_ -match 'first_frame_ready' })
    return [ordered]@{ modes = $modes; reasons = $reasons; rendererFailures = $rendererFailures; readyLines = $ready.Count }
}

function Assert-Logged([string]$Name, [bool]$Condition, [string]$Detail) {
    Record $Name $Condition
    if (-not $Condition) { $failures.Add($Name + ' -> ' + $Detail) }
}

function Get-OverlayWindows {
    $dump = Invoke-Adb @('shell', 'dumpsys', 'window', 'windows') -AllowFailure
    return @($dump -split "`n" | Where-Object { $_ -match [regex]::Escape($Package) })
}

function Test-SecureScreenshot {
    # FLAG_SECURE 的浮层在截图中应为黑（不可见）。这里只报事实：区域是否为纯黑、非黑像素占比。
    $outDir = if ($ReportPath) { Split-Path -Parent $ReportPath } else { Join-Path $env:TEMP ('pet3d-accept-' + (Get-Date).ToString('yyyyMMdd-HHmmss')) }
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    $shot = Join-Path $outDir 'screenshot.png'
    & cmd /c ('"' + $adb + '" -s ' + $Serial + ' exec-out screencap -p > "' + $shot + '"') 2>&1 | Out-Null
    if (-not (Test-Path -LiteralPath $shot) -or (Get-Item -LiteralPath $shot).Length -lt 1000) {
        Record 'screenshotTaken' $false
        return
    }
    Record 'screenshotTaken' $true
    Record 'screenshotPath' $shot
    Add-Type -AssemblyName System.Drawing
    $size = (Invoke-Adb @('shell', 'wm', 'size')) -join ' '
    $density = (Invoke-Adb @('shell', 'wm', 'density')) -join ' '
    $screen = [regex]::Match($size, '(\d+)x(\d+)'); $dpi = [regex]::Match($density, '(\d+)')
    if (-not $screen.Success -or -not $dpi.Success) { Record 'overlayRegionSampled' $false; return }
    $bitmap = [System.Drawing.Bitmap]::FromFile($shot)
    try {
        $scale = [double]$dpi.Groups[1].Value / 160.0
        $petWidth = [int](88 * $scale); $petHeight = [int](123 * $scale)
        $x = $bitmap.Width - [int](16 * $scale) - $petWidth
        $y = [int](160 * $scale)
        $nonBlack = 0; $sampled = 0
        for ($px = [Math]::Max(0, $x); $px -lt [Math]::Min($bitmap.Width, $x + $petWidth); $px += 4) {
            for ($py = [Math]::Max(0, $y); $py -lt [Math]::Min($bitmap.Height, $y + $petHeight); $py += 4) {
                $color = $bitmap.GetPixel($px, $py); $sampled++
                if ($color.R -gt 8 -or $color.G -gt 8 -or $color.B -gt 8) { $nonBlack++ }
            }
        }
        Record 'overlayRegionSampled' $true
        Record 'overlayRegionPixels' $sampled
        Record 'overlayRegionNonBlackPixels' $nonBlack
        Record 'overlayRegionUniformBlack' ($sampled -gt 0 -and $nonBlack -eq 0)
    } finally { $bitmap.Dispose() }
}

function Invoke-DeviceInfo {
    Record 'deviceModel' ((Invoke-Adb @('shell', 'getprop', 'ro.product.model')).Trim())
    Record 'deviceRelease' ((Invoke-Adb @('shell', 'getprop', 'ro.build.version.release')).Trim())
    Record 'deviceSdk' ((Invoke-Adb @('shell', 'getprop', 'ro.build.version.sdk')).Trim())
    Record 'webViewUpdate' ((Invoke-Adb @('shell', 'dumpsys', 'webviewupdate') | Select-String 'Current WebView package' | ForEach-Object { $_.Line.Trim() }) -join ' ')
}

switch ($Step) {
    'devices' {
        Record 'devices' @(Get-Devices)
    }
    'install' {
        Require-Device
        if ($Build) { Build-Apk 'full' } else { Record 'builtVariant' 'reused-existing-apk' }
        Install-Apk
        Invoke-DeviceInfo
        Note-Manual '在设备上打开"微光指引 · 独立桌宠验证"，授予"显示在其他应用上层"（SYSTEM_ALERT_WINDOW）与通知权限，然后点按启动桌宠。'
        Note-Manual '也可用 adb 授权（部分 ROM 有效）：adb shell appops set <pkg> SYSTEM_ALERT_WINDOW allow；adb shell pm grant <pkg> android.permission.POST_NOTIFICATIONS'
    }
    'grants' {
        Require-Device
        Record 'overlayAppOp' ((Invoke-Adb @('shell', 'appops', 'get', $Package, 'SYSTEM_ALERT_WINDOW') -AllowFailure).Trim())
        Record 'notificationPermission' ((Invoke-Adb @('shell', 'dumpsys', 'package', $Package) | Select-String 'POST_NOTIFICATIONS' | ForEach-Object { $_.Line.Trim() }) -join ' ')
        Note-Manual '确认系统设置里"显示在其他应用上层"为允许；通知渠道"微光指引独立桌宠与停止入口"未被关闭（关闭会按既有隐私逻辑停止桌宠）。'
    }
    'verify' {
        Require-Device
        Invoke-DeviceInfo
        Record 'overlayWindows' @(Get-OverlayWindows)
        $facts = Get-LogFacts (Read-Pet3dLog)
        Record 'logFacts' $facts
        Assert-Logged 'overlayWindowPresent' (@(Get-OverlayWindows).Count -gt 0) 'dumpsys window 中没有该包的窗口'
        Test-SecureScreenshot
        Note-Manual '3D 形象是否加载完成并持续动画（不是静止帧、不是空白/黑块）？面板状态应显示"形象：实时 3D · …"。'
        Note-Manual '拖动是否跟手、单击是否打开原生面板、面板按钮是否可用？'
        Note-Manual '截图中浮层区域应为黑色（FLAG_SECURE 生效）；若能看到 3D 形象则视为安全缺陷，停止验收。'
        Note-Manual '被其他应用悬浮窗遮挡时点击应被拒收（filterTouchesWhenObscured）。'
    }
    'fallback-missing' {
        Require-Device
        Build-Apk 'missing'
        Install-Apk
        Stop-Pet; Invoke-Adb @('logcat', '-c') -AllowFailure | Out-Null; Start-Pet
        $facts = Get-LogFacts (Read-Pet3dLog)
        Record 'logFacts' $facts
        Assert-Logged 'fallback_missing_logged' ($facts.reasons -contains 'bundled_model_missing') 'logcat 未出现 reason=bundled_model_missing'
        Note-Manual '面板状态应显示"形象：随包静态形象（bundled_model_missing）"，且静态 PNG 可见、拖动与单击仍正常。'
        Note-Manual '验收完请执行 -Step restore 恢复完整包。'
    }
    'fallback-corrupt' {
        Require-Device
        Build-Apk 'corrupt'
        Install-Apk
        Stop-Pet; Invoke-Adb @('logcat', '-c') -AllowFailure | Out-Null; Start-Pet
        $facts = Get-LogFacts (Read-Pet3dLog)
        Record 'logFacts' $facts
        Assert-Logged 'fallback_corrupt_logged' ($facts.reasons -contains 'bundled_model_digest_mismatch') 'logcat 未出现 reason=bundled_model_digest_mismatch'
        Note-Manual '面板状态应显示"形象：随包静态形象（bundled_model_digest_mismatch）"：摘要不符时绝不渲染未校验字节。'
        Note-Manual '验收完请执行 -Step restore 恢复完整包。'
    }
    'restore' {
        Require-Device
        Build-Apk 'full'
        Install-Apk
        Stop-Pet; Invoke-Adb @('logcat', '-c') -AllowFailure | Out-Null; Start-Pet
        $facts = Get-LogFacts (Read-Pet3dLog)
        Record 'logFacts' $facts
        Assert-Logged 'restored_real_time_3d_logged' (@($facts.modes | Where-Object { $_ -ne 'STATIC_PNG' }).Count -gt 0) '恢复完整包后没有选择 3D 层级'
    }
    'tiering-webview-off' {
        Require-Device
        $webviewPackage = ([regex]::Match((Invoke-Adb @('shell', 'dumpsys', 'webviewupdate')), 'Current WebView package \(([^)]+)\)')).Groups[1].Value
        Record 'webViewPackage' $webviewPackage
        if (-not $webviewPackage) { throw '无法从 dumpsys webviewupdate 解析当前 WebView 包名。' }
        $disable = Invoke-Adb @('shell', 'pm', 'disable-user', '--user', '0', $webviewPackage) -AllowFailure
        Record 'disableOutput' $disable.Trim()
        Stop-Pet; Invoke-Adb @('logcat', '-c') -AllowFailure | Out-Null; Start-Pet
        $facts = Get-LogFacts (Read-Pet3dLog)
        Record 'logFacts' $facts
        Assert-Logged 'tiering_native_gl_logged' ($facts.modes -contains 'NATIVE_GL') 'WebView 停用后没有选择 NATIVE_GL'
        Invoke-Adb @('shell', 'pm', 'enable', $webviewPackage) -AllowFailure | Out-Null
        Record 'webViewReEnabled' $true
        Note-Manual 'WebView 停用期间原生 GL 层的观感（平色近似）是否可接受？帧率与发热是否明显更好？（可选记录）'
        Note-Manual '停用 WebView 会影响设备上其他应用的网页功能，验收后务必确认已恢复（脚本已尝试重新启用）。'
    }
    'tiering-webview-on' {
        Require-Device
        $webviewPackage = ([regex]::Match((Invoke-Adb @('shell', 'dumpsys', 'webviewupdate')), 'Current WebView package \(([^)]+)\)')).Groups[1].Value
        if ($webviewPackage) { Invoke-Adb @('shell', 'pm', 'enable', $webviewPackage) -AllowFailure | Out-Null }
        Stop-Pet; Invoke-Adb @('logcat', '-c') -AllowFailure | Out-Null; Start-Pet
        $facts = Get-LogFacts (Read-Pet3dLog)
        Record 'logFacts' $facts
        Assert-Logged 'tiering_webview_logged' ($facts.modes -contains 'CONTROLLED_WEBVIEW') 'WebView 恢复后没有选择 CONTROLLED_WEBVIEW'
    }
    'perf' {
        Require-Device
        $measure = Join-Path $PSScriptRoot 'measure-pet3d.ps1'
        $perfReport = if ($ReportPath) { $ReportPath } else { Join-Path $env:TEMP ('pet3d-perf-' + $Phase + '.json') }
        & powershell -NoProfile -ExecutionPolicy Bypass -File $measure -Serial $Serial -Package $Package -Phase $Phase -DurationSeconds $PerfSeconds -OutputPath $perfReport
        Record 'perfReportPath' $perfReport
    }
    'all' {
        Require-Device
        Invoke-DeviceInfo
        if ($Build) { Build-Apk 'full' } else { Record 'builtVariant' 'reused-existing-apk' }
        Install-Apk
        Record 'overlayAppOp' ((Invoke-Adb @('shell', 'appops', 'get', $Package, 'SYSTEM_ALERT_WINDOW') -AllowFailure).Trim())
        Note-Manual '[1/6] 打开应用，授予浮层与通知权限，启动桌宠（或等待 adb 启动的服务自行驻留）。'
        Stop-Pet; Invoke-Adb @('logcat', '-c') -AllowFailure | Out-Null; Start-Pet
        Record 'overlayWindows' @(Get-OverlayWindows)
        Record 'logFacts' (Get-LogFacts (Read-Pet3dLog))
        Test-SecureScreenshot
        Note-Manual '[2/6] 3D 加载/动画、拖动、单击打开面板、截图中浮层为黑（FLAG_SECURE）、遮挡拒收。'
        Note-Manual '[3/6] 切后台（回到桌面）：悬浮形象应继续存在；下拉通知应有停止/退出入口。'
        Note-Manual '[4/6] 锁屏：按既有隐私逻辑桌宠应停止（通知消失、浮层消失），解锁后需本人再次启动；这是预期行为。'
        Note-Manual '[5/6] 旋转屏幕：浮层应仍在屏内（脚本已做坐标夹取），拖动与单击保持可用。'
        Note-Manual '[6/6] 关闭系统动画（开发者选项动画缩放 0）：静态回退形象不应上下浮动；3D 应继续渲染；低电量模式下行为不变但耗电更高。'
        Note-Manual '性能采样：-Step perf -Phase webview_three_js / native_gl / static_png 各跑一次（判据见 docs/implementation/android-3d-pet.md）。'
        Note-Manual '回退验收：-Step fallback-missing 与 -Step fallback-corrupt，结束后 -Step restore。'
    }
}

$payload = [ordered]@{
    step = $Step
    package = $Package
    serial = $Serial
    generatedAt = (Get-Date).ToString('o')
    executedBy = 'invited owner (adb), results recorded by lead'
    results = $results
    failedChecks = @($failures)
    manualSteps = @($manual)
    deviceVerified = $script:deviceVerifiedByThisRun
    deviceVerifiedClaim = 'covers only the automated checks above on an attached device; manual items stay unrecorded until the lead fills them in'
    captureExecuted = $false
    cloudExecuted = $false
    networkExecuted = $false
}
if ($ReportPath) { $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding UTF8 }
$payload | ConvertTo-Json -Depth 8 -Compress
if ($failures.Count -gt 0) { Write-Error ('自动判定未通过的项：' + ($failures -join '; ')); exit 1 }