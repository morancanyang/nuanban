param([string]$SdkRoot, [string]$JavaHome, [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
if (-not $SdkRoot) { $SdkRoot = $env:ANDROID_HOME }
if (-not $SdkRoot) { $SdkRoot = $env:ANDROID_SDK_ROOT }
if (-not $SdkRoot) { $SdkRoot = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
if (-not $JavaHome) { $JavaHome = Join-Path $env:ProgramFiles 'Android/Android Studio/jbr' }
if (-not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin/java.exe'))) { $JavaHome = $env:JAVA_HOME }
if (-not $JavaHome) { throw 'A local JDK is required.' }
$env:JAVA_HOME = $JavaHome
$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'gradlew.bat') -p $PSScriptRoot :app:assembleDebug :standalone:assembleDebug --offline --no-daemon | Out-Host
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$tools = Get-ChildItem -LiteralPath (Join-Path $SdkRoot 'build-tools') -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $tools) { throw 'Cached Android build-tools are required.' }
$aapt = Join-Path $tools.FullName 'aapt2.exe'
if (-not (Test-Path -LiteralPath $aapt)) { throw 'Local aapt2.exe is required.' }
$normalApk = Join-Path $PSScriptRoot 'app/build/outputs/apk/debug/app-debug.apk'
$standaloneApk = Join-Path $PSScriptRoot 'standalone/build/outputs/apk/debug/standalone-debug.apk'
foreach ($artifact in @($normalApk, $standaloneApk)) {
    if (-not (Test-Path -LiteralPath $artifact)) { throw ('Missing built APK: ' + $artifact) }
}
function Invoke-Aapt([string[]]$Arguments) {
    $result = & $aapt @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw ('aapt2 inspection failed: ' + ($result -join ' ')) }
    return $result -join [Environment]::NewLine
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Read-DexText([string]$Apk) {
    $archive = [IO.Compression.ZipFile]::OpenRead($Apk)
    $result = [Text.StringBuilder]::new()
    try {
        $entries = @($archive.Entries | Where-Object { $_.FullName -match '^classes\d*\.dex$' })
        if ($entries.Count -lt 1) { throw ('APK has no DEX: ' + $Apk) }
        foreach ($entry in $entries) {
            $source = $entry.Open()
            $buffer = [IO.MemoryStream]::new()
            try {
                $source.CopyTo($buffer)
                [void]$result.Append([Text.Encoding]::ASCII.GetString($buffer.ToArray()))
            } finally { $source.Dispose(); $buffer.Dispose() }
        }
    } finally { $archive.Dispose() }
    return $result.ToString()
}
$cases = [Collections.Generic.List[string]]::new()
function Assert-Case([string]$Name, [bool]$Passed) {
    if (-not $Passed) { throw ('Packaging isolation failed: ' + $Name) }
    $cases.Add($Name)
}
$normalPermissions = Invoke-Aapt @('dump', 'permissions', $normalApk)
$standalonePermissions = Invoke-Aapt @('dump', 'permissions', $standaloneApk)
$normalBadging = Invoke-Aapt @('dump', 'badging', $normalApk)
$standaloneBadging = Invoke-Aapt @('dump', 'badging', $standaloneApk)
$normalManifest = Invoke-Aapt @('dump', 'xmltree', $normalApk, '--file', 'AndroidManifest.xml')
$standaloneManifest = Invoke-Aapt @('dump', 'xmltree', $standaloneApk, '--file', 'AndroidManifest.xml')
$normalDex = Read-DexText $normalApk
$standaloneDex = Read-DexText $standaloneApk
foreach ($permission in @('INTERNET', 'SYSTEM_ALERT_WINDOW', 'HIDE_OVERLAY_WINDOWS', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_MEDIA_PROJECTION', 'FOREGROUND_SERVICE_SPECIAL_USE')) {
    Assert-Case ('normal_no_' + $permission) (-not $normalPermissions.Contains("'android.permission." + $permission + "'"))
    Assert-Case ('standalone_has_' + $permission) ($standalonePermissions.Contains("'android.permission." + $permission + "'"))
}
# C：本地听写麦克风权限仅独立包允许；相机/无障碍/开机自启两包均禁止。
Assert-Case 'normal_no_RECORD_AUDIO' (-not $normalPermissions.Contains("'android.permission.RECORD_AUDIO'"))
Assert-Case 'standalone_has_RECORD_AUDIO' ($standalonePermissions.Contains("'android.permission.RECORD_AUDIO'"))
foreach ($permission in @('CAMERA', 'BIND_ACCESSIBILITY_SERVICE', 'RECEIVE_BOOT_COMPLETED')) {
    Assert-Case ('normal_no_' + $permission) (-not $normalPermissions.Contains("'android.permission." + $permission + "'"))
    Assert-Case ('standalone_no_' + $permission) (-not $standalonePermissions.Contains("'android.permission." + $permission + "'"))
}
Assert-Case 'normal_dex_excludes_local_dictation_bridge' (-not $normalDex.Contains('nuanbanVoiceHost'))
Assert-Case 'standalone_dex_contains_local_dictation_bridge' ($standaloneDex.Contains('nuanbanVoiceHost'))
Assert-Case 'standalone_dex_uses_speech_recognizer' ($standaloneDex.Contains('Landroid/speech/SpeechRecognizer;'))
Assert-Case 'normal_dex_excludes_speech_recognizer' (-not $normalDex.Contains('Landroid/speech/SpeechRecognizer;'))
Assert-Case 'normal_original_application_id' ($normalBadging.Contains("package: name='org.nuanban.assistant'"))
Assert-Case 'standalone_separate_application_id' ($standaloneBadging.Contains("package: name='org.nuanban.assistant.standalone'"))
Assert-Case 'normal_original_launcher' ($normalBadging.Contains("launchable-activity: name='org.nuanban.assistant.MainActivity'"))
Assert-Case 'standalone_native_launcher' ($standaloneBadging.Contains("launchable-activity: name='org.nuanban.assistant.nativehost.PetControlActivity'"))
foreach ($component in @('PetRuntimeService', 'NativeCaptureService', 'PetControlActivity', 'NativeCaptureControlActivity', 'PetStopReceiver', 'GuidanceConnectionActivity')) {
    Assert-Case ('normal_manifest_excludes_' + $component) (-not $normalManifest.Contains('org.nuanban.assistant.nativehost.' + $component))
    Assert-Case ('standalone_manifest_registers_' + $component) ($standaloneManifest.Contains('org.nuanban.assistant.nativehost.' + $component))
}
foreach ($className in @('PetRuntimeService', 'NativeCaptureService', 'PetControlActivity', 'NativeCaptureControlActivity', 'PetRuntime', 'PetSessions', 'PetManagementBoundary', 'CaptureSession', 'LocalFrameGate', 'NativeCaptureRuntime', 'AndroidLocalScreenDetector', 'AndroidScreenPolicy', 'AndroidTeachingState', 'AndroidGuidanceRuntime', 'AndroidGuidanceAdapter', 'AndroidGuidanceOverlay', 'AndroidGuidanceConnection', 'StandaloneGuidanceProtocol', 'StandaloneGuidanceClient', 'AndroidCaptureGeometry', 'AndroidLocalDictation')) {
    $descriptor = 'Lorg/nuanban/assistant/nativehost/' + $className + ';'
    Assert-Case ('normal_dex_excludes_' + $className) (-not $normalDex.Contains($descriptor))
    Assert-Case ('standalone_dex_contains_' + $className) ($standaloneDex.Contains($descriptor))
}
Assert-Case 'standalone_no_automatic_cct_transport_backend' (-not $standaloneManifest.Contains('backend:com.google.android.datatransport.cct.CctBackendFactory'))
Assert-Case 'standalone_no_transport_backend_discovery_component' (-not $standaloneManifest.Contains('com.google.android.datatransport.runtime.backends.TransportBackendDiscovery'))
function Read-ModelManifest([string]$Apk) {
    $archive = [IO.Compression.ZipFile]::OpenRead($Apk)
    $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
    try {
        [string[]]$paths = @($archive.Entries | Where-Object { $_.FullName -match '^assets/(mlkit-google-ocr-models|models_bundled)/' -and $_.Length -gt 0 } | ForEach-Object { $_.FullName })
        [Array]::Sort($paths, [StringComparer]::Ordinal)
        $manifest = [Text.StringBuilder]::new()
        foreach ($path in $paths) {
            $stream = $archive.GetEntry($path).Open()
            try { $digest = [BitConverter]::ToString($hashAlgorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $stream.Dispose() }
            [void]$manifest.Append($path.Substring(7)).Append([char]0).Append($digest).Append("`n")
        }
        $digest = [BitConverter]::ToString($hashAlgorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($manifest.ToString()))).Replace('-', '').ToLowerInvariant()
        return @{ count = $paths.Count; sha256 = $digest }
    } finally { $hashAlgorithm.Dispose(); $archive.Dispose() }
}
$normalModels = Read-ModelManifest $normalApk
$standaloneModels = Read-ModelManifest $standaloneApk
$screenPolicy = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'app/src/standalone/java/org/nuanban/assistant/nativehost/AndroidScreenPolicy.kt') -Raw
$modelFingerprint = [regex]::Match($screenPolicy, 'MODEL_FINGERPRINT = "([a-f0-9]{64})"').Groups[1].Value
Assert-Case 'normal_has_no_vision_model_assets' ($normalModels.count -eq 0)
Assert-Case 'standalone_has_all_39_bundled_model_assets' ($standaloneModels.count -eq 39)
Assert-Case 'standalone_model_bytes_match_runtime_fingerprint' ($standaloneModels.sha256 -eq $modelFingerprint -and $modelFingerprint.Length -eq 64)
foreach ($descriptor in @('Lcom/google/mlkit/vision/text/TextRecognizer;', 'Lcom/google/mlkit/vision/face/FaceDetector;')) {
    Assert-Case ('normal_excludes_' + $descriptor) (-not $normalDex.Contains($descriptor))
    Assert-Case ('standalone_contains_' + $descriptor) ($standaloneDex.Contains($descriptor))
}
function Read-ApkEntryNames([string]$Apk) {
    $archive = [IO.Compression.ZipFile]::OpenRead($Apk)
    try { return @($archive.Entries | ForEach-Object { $_.FullName }) } finally { $archive.Dispose() }
}
$normalEntries = Read-ApkEntryNames $normalApk
$standaloneEntries = Read-ApkEntryNames $standaloneApk
$normalPetAsset = @($normalEntries | Where-Object { $_ -match 'nuanban_pet_preview' })
$standalonePetAsset = @($standaloneEntries | Where-Object { $_ -match 'nuanban_pet_preview' })
Assert-Case 'normal_has_no_pet_preview_asset' ($normalPetAsset.Count -eq 0)
Assert-Case 'standalone_has_pet_preview_asset' ($standalonePetAsset.Count -ge 1)
$normalBuild = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'app/build.gradle.kts') -Raw
Assert-Case 'normal_source_set_does_not_include_standalone' (-not $normalBuild.Contains('src/standalone'))
Assert-Case 'normal_has_no_standalone_project_dependency' (-not $normalBuild.Contains('project(":standalone")'))
[ordered]@{
    passed = $true
    caseCount = $cases.Count
    cases = @($cases.ToArray())
    normalApk = $normalApk
    normalSha256 = (Get-FileHash -LiteralPath $normalApk -Algorithm SHA256).Hash
    standaloneApk = $standaloneApk
    standaloneSha256 = (Get-FileHash -LiteralPath $standaloneApk -Algorithm SHA256).Hash
    bundledModelCount = $standaloneModels.count
    bundledModelSha256 = $standaloneModels.sha256
    deviceVerified = $false
    captureExecuted = $false
    cloudExecuted = $false
} | ConvertTo-Json -Depth 4 -Compress
