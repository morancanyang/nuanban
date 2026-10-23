param([switch]$CompatibleDisplay, [switch]$ProtectPet)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$desktop = Join-Path $workspace 'apps\desktop'
$runtime = Join-Path $desktop 'node_modules\electron\dist\electron.exe'
$developmentUi = Join-Path $workspace 'apps\web\dist\index.html'
$packagedUi = Join-Path $desktop 'ui\index.html'
if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) {
    throw 'Installed Electron runtime not found. Run pnpm install --frozen-lockfile first.'
}
if (-not ((Test-Path -LiteralPath $developmentUi -PathType Leaf) -or (Test-Path -LiteralPath $packagedUi -PathType Leaf))) {
    throw 'Built client UI not found. Run pnpm build first.'
}
. (Join-Path $PSScriptRoot 'desktop-runtime-integrity.ps1')
$repairedRuntimeFiles = @(Repair-DesktopRuntimeIntegrity -RuntimePath $runtime)
if ($repairedRuntimeFiles.Count -gt 0) {
    Write-Output "Restored normal integrity labels for $($repairedRuntimeFiles.Count) Electron runtime file(s); sandbox protection remains enabled."
}
$launchArguments = @("`"$desktop`"", '--management')
if ($CompatibleDisplay) { $launchArguments += '--client-display-compatible' }
if (-not $ProtectPet) { $launchArguments += '--pet-display-compatible' }
$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
try {
    Remove-Item -LiteralPath Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $client = Start-Process -FilePath $runtime -ArgumentList $launchArguments -WorkingDirectory $workspace -WindowStyle Normal -PassThru
    if ($client.WaitForExit(1500) -and $client.ExitCode -ne 0) {
        throw "Client startup failed (exit code $($client.ExitCode)). Check the local Electron runtime and client dependencies."
    }
    Write-Output "Client launch requested (PID $($client.Id)); an existing instance will restore its management window."
} finally {
    if ($null -ne $previousRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode }
}
