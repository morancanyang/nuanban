param([string]$JavaHome, [string]$SdkRoot)
$ErrorActionPreference = 'Stop'
# 用例失败信息含中文，统一按 UTF-8 读取子进程输出，避免 JSON 变成乱码。
$utf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false
try { [Console]::OutputEncoding = $utf8 } catch { }
$OutputEncoding = $utf8
# 独立桌宠实时 3D 的离线校验：不联网、不需要设备、不构建 APK。
# 1) 用与 check-standalone.ps1 相同的离线 kotlinc 依赖编译纯 Kotlin 策略/GLB 层并执行用例；
# 2) 用 android.jar 对依赖 Android API 的 pet3d 源文件做类型检查（证明可编译，不声称已在设备上渲染）；
# 3) 校验随包 GLB 与桌面端模型/摘要一致，以及内嵌 three.js 与 node_modules 版本一致。
if (-not $JavaHome) {
    $candidates = @()
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Android/Android Studio/jbr') }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs/Android Studio/jbr') }
    if ($env:JAVA_HOME) { $candidates += $env:JAVA_HOME }
    $JavaHome = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'bin/java.exe')) } | Select-Object -First 1
}
if (-not $JavaHome) { throw 'A local JDK is required (pass -JavaHome or set JAVA_HOME).' }
if (-not $SdkRoot) { $SdkRoot = $env:ANDROID_HOME }
if (-not $SdkRoot) { $SdkRoot = $env:ANDROID_SDK_ROOT }
if (-not $SdkRoot) { $SdkRoot = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
$java = Join-Path $JavaHome 'bin/java.exe'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../../../..')).Path
$androidRoot = Join-Path $root 'apps/android'
$nativeRoot = Join-Path $androidRoot 'app/src/standalone/java/org/nuanban/assistant/nativehost'
$assetsRoot = Join-Path $androidRoot 'app/src/standalone/assets/pet3d'
$webModelRoot = Join-Path $root 'apps/web/public/models/lumi'
$gradleHome = if ($env:GRADLE_USER_HOME) { $env:GRADLE_USER_HOME } else { Join-Path $HOME '.gradle' }
$output = Join-Path $PSScriptRoot 'build/classes'
New-Item -ItemType Directory -Force -Path $output | Out-Null

$extraCases = [Collections.Generic.List[string]]::new()
$failures = [ordered]@{}
function Assert-Case([string]$Name, [bool]$Passed, [string]$Detail) {
    $extraCases.Add($Name)
    if (-not $Passed) { $failures[$Name] = $Detail }
}

$coordinates = @(
    'org.jetbrains.kotlin/kotlin-compiler-embeddable/2.2.20',
    'org.jetbrains.kotlin/kotlin-stdlib/2.2.20',
    'org.jetbrains.kotlin/kotlin-script-runtime/2.2.20',
    'org.jetbrains.kotlin/kotlin-reflect/1.6.10',
    'org.jetbrains.kotlin/kotlin-daemon-embeddable/2.2.20',
    'org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm/1.8.0',
    'org.jetbrains/annotations/13.0'
)
$jars = foreach ($coordinate in $coordinates) {
    $directory = Join-Path $gradleHome ('caches/modules-2/files-2.1/' + $coordinate)
    $jar = Get-ChildItem -LiteralPath $directory -Filter '*.jar' -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch '-(sources|javadoc)\.jar$' } | Select-Object -First 1
    if (-not $jar) { throw ('Missing offline compiler dependency: ' + $coordinate) }
    $jar.FullName
}
$classpath = $jars -join ';'

# --- 1) 纯 Kotlin 策略 + GLB 数据层用例 ---
$pureSources = @(
    (Join-Path $nativeRoot 'Pet3dRenderPolicy.kt'),
    (Join-Path $nativeRoot 'Pet3dGlbDocument.kt'),
    (Join-Path $PSScriptRoot 'Pet3dChecks.kt')
)
$modelPath = Join-Path $webModelRoot 'Lumi_Magical_Kitten.glb'
$manifestPath = Join-Path $webModelRoot 'character_manifest.json'
if (-not (Test-Path -LiteralPath $modelPath)) { throw ('Missing desktop-consistent bundled model source: ' + $modelPath) }
& $java -cp $classpath org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -classpath $classpath -jvm-target 17 -d $output @pureSources
if ($LASTEXITCODE -ne 0) { throw 'Pure Kotlin pet3d sources failed to compile.' }
$rawChecks = & $java '-Dfile.encoding=UTF-8' -cp ((@($output) + $jars) -join ';') org.nuanban.assistant.nativehost.Pet3dChecks $modelPath $manifestPath
$checksExit = $LASTEXITCODE
$checks = $rawChecks | Out-String
$parsed = $checks | ConvertFrom-Json

# --- 2) 依赖 Android API 的 pet3d 源文件类型检查（android.jar，离线） ---
$platforms = Get-ChildItem -LiteralPath (Join-Path $SdkRoot 'platforms') -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^android-\d+(\.\d+)?$' } | Sort-Object Name -Descending
$androidJar = $null
foreach ($platform in $platforms) {
    $candidate = Join-Path $platform.FullName 'android.jar'
    if (Test-Path -LiteralPath $candidate) { $androidJar = $candidate; break }
}
if (-not $androidJar) { throw 'A local android.jar is required for the pet3d type check.' }
$androidSources = @(
    'Pet3dRenderPolicy.kt', 'Pet3dGlbDocument.kt', 'Pet3dAssets.kt', 'Pet3dFrameStats.kt',
    'Pet3dGlRenderer.kt', 'Pet3dGlView.kt', 'Pet3dWebView.kt', 'Pet3dBubbleView.kt', 'Pet3dOverlay.kt'
) | ForEach-Object { Join-Path $nativeRoot $_ }
$missing = @($androidSources | Where-Object { -not (Test-Path -LiteralPath $_) })
if ($missing.Count -gt 0) { throw ('Missing pet3d Android sources: ' + ($missing -join ', ')) }
$androidOutput = Join-Path $PSScriptRoot 'build/android-classes'
New-Item -ItemType Directory -Force -Path $androidOutput | Out-Null
$androidLog = & $java -cp $classpath org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -classpath (($jars + @($androidJar)) -join ';') -jvm-target 17 -d $androidOutput @androidSources 2>&1
$androidOk = $LASTEXITCODE -eq 0
Assert-Case 'pet3d_android_sources_typecheck_against_android_jar' $androidOk (($androidLog | Out-String).Trim())

# --- 3) 资产一致性：随包 GLB 与桌面端 pin、内嵌 three.js 与 node_modules ---
$modelHash = (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash.ToLowerInvariant()
$modelBytes = (Get-Item -LiteralPath $modelPath).Length
$desktopPin = [regex]::Match((Get-Content -LiteralPath (Join-Path $root 'apps/web/src/three-d/builtin-models.ts') -Raw), "sha256: '([a-f0-9]{64})'").Groups[1].Value
$kotlinPin = [regex]::Match((Get-Content -LiteralPath (Join-Path $nativeRoot 'Pet3dAssets.kt') -Raw), 'PINNED_MODEL_SHA256 = "([a-f0-9]{64})"').Groups[1].Value
$apkAssetPath = Join-Path $nativeRoot 'Pet3dAssets.kt'
$assetRelative = [regex]::Match((Get-Content -LiteralPath $apkAssetPath -Raw), 'MODEL_ASSET_PATH = "([^"]+)"').Groups[1].Value
$manifestHash = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).runtime.sha256
Assert-Case 'bundled_model_matches_web_public_digest' ($modelHash -eq $parsed.bundledModel.sha256) ('file=' + $modelHash + ' parsed=' + $parsed.bundledModel.sha256)
Assert-Case 'bundled_model_matches_character_manifest_digest' ($modelHash -eq $manifestHash) ('file=' + $modelHash + ' manifest=' + $manifestHash)
Assert-Case 'bundled_model_matches_desktop_model_pin' ($desktopPin.Length -eq 64 -and $desktopPin -eq $modelHash) ('desktop=' + $desktopPin + ' file=' + $modelHash)
Assert-Case 'bundled_model_matches_kotlin_runtime_pin' ($kotlinPin.Length -eq 64 -and $kotlinPin -eq $modelHash) ('kotlin=' + $kotlinPin + ' file=' + $modelHash)
Assert-Case 'bundled_model_asset_path_is_declared' ($assetRelative -eq 'pet3d/models/lumi/Lumi_Magical_Kitten.glb') ('assetPath=' + $assetRelative)

$threeRoot = Join-Path $root 'node_modules/three'
$vendoredChecked = $false
$vendoredOk = $true
$vendoredDetail = 'node_modules/three 不存在，跳过漂移校验'
$vendoredFiles = @()
if (Test-Path -LiteralPath (Join-Path $threeRoot 'package.json')) {
    $threeVersion = (Get-Content -LiteralPath (Join-Path $threeRoot 'package.json') -Raw | ConvertFrom-Json).version
    $pairs = @(
        @{ source = 'build/three.module.js'; target = 'viewer/three.module.js' },
        @{ source = 'build/three.core.js'; target = 'viewer/three.core.js' },
        @{ source = 'examples/jsm/loaders/GLTFLoader.js'; target = 'viewer/loaders/GLTFLoader.js' },
        @{ source = 'examples/jsm/utils/BufferGeometryUtils.js'; target = 'viewer/utils/BufferGeometryUtils.js' },
        @{ source = 'examples/jsm/utils/SkeletonUtils.js'; target = 'viewer/utils/SkeletonUtils.js' }
    )
    foreach ($pair in $pairs) {
        $from = Join-Path $threeRoot $pair.source
        $to = Join-Path $assetsRoot $pair.target
        if (-not (Test-Path -LiteralPath $from) -or -not (Test-Path -LiteralPath $to)) {
            $vendoredOk = $false
            $vendoredDetail = 'missing: ' + $pair.source + ' -> ' + $pair.target
            continue
        }
        $fromHash = (Get-FileHash -LiteralPath $from -Algorithm SHA256).Hash
        $toHash = (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash
        $vendoredFiles += [ordered]@{ file = $pair.target; matches = ($fromHash -eq $toHash); sha256 = $toHash.ToLowerInvariant() }
        if ($fromHash -ne $toHash) { $vendoredOk = $false; $vendoredDetail = 'drift: ' + $pair.target }
    }
    $vendoredChecked = $true
    if ($vendoredOk) { $vendoredDetail = 'checked_' + $vendoredFiles.Count + '_files_against_node_modules_three' }
    Assert-Case 'vendored_three_runtime_matches_node_modules' $vendoredOk $vendoredDetail
}

$kotlinCases = @($parsed.cases)
$allCases = @($kotlinCases + $extraCases.ToArray())
foreach ($key in $parsed.failures.PSObject.Properties.Name) { $failures[$key] = $parsed.failures.$key }
$passed = ($failures.Count -eq 0) -and $checksExit -eq 0
[ordered]@{
    passed = $passed
    caseCount = $allCases.Count
    kotlinCaseCount = $kotlinCases.Count
    cases = $allCases
    failures = $failures
    bundledModel = $parsed.bundledModel
    policyThresholds = $parsed.policyThresholds
    assetParity = [ordered]@{
        bundledModelSha256 = $modelHash
        bundledModelBytes = $modelBytes
        desktopModelPin = $desktopPin
        kotlinRuntimePin = $kotlinPin
        characterManifestSha256 = $manifestHash
        apkAssetPath = $assetRelative
    }
    vendoredThree = [ordered]@{ checked = $vendoredChecked; matches = $vendoredOk; files = $vendoredFiles; detail = $vendoredDetail }
    androidTypecheck = [ordered]@{ ok = $androidOk; sources = @($androidSources | ForEach-Object { Split-Path $_ -Leaf }) }
    deviceVerified = $false
    captureExecuted = $false
    cloudExecuted = $false
    networkExecuted = $false
} | ConvertTo-Json -Depth 8 -Compress
if (-not $passed) { exit 1 }