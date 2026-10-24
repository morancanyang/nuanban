param([switch]$Management, [switch]$CompatibleDisplay, [switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$desktop = Join-Path $workspace 'apps\desktop'
$runtime = Join-Path $desktop 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $runtime -PathType Leaf)) { $runtime = Join-Path $workspace 'node_modules\electron\dist\electron.exe' }
foreach ($required in @($runtime, (Join-Path $desktop 'main.cjs'), (Join-Path $desktop 'assets\lili\manifest.json'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required local file not found: $required. Run pnpm install --frozen-lockfile if the Electron runtime is missing."
    }
}
if ($CheckOnly) {
    Write-Output "Ready: $runtime"
    Write-Output "Project: $desktop"
    exit 0
}
$launchArguments = @("`"$desktop`"", '--pet-lili')
if ($Management) { $launchArguments += '--management' }
if ($CompatibleDisplay) { $launchArguments += '--pet-display-compatible' }
$previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
try {
    Remove-Item -LiteralPath Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $client = Start-Process -FilePath $runtime -ArgumentList $launchArguments -WorkingDirectory $workspace -WindowStyle Hidden -PassThru
    Write-Output "Lili launch requested (PID $($client.Id)). An existing updated Nuanban instance receives the character-selection request."
} finally {
    if ($null -ne $previousRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode }
}
