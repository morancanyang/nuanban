param([string]$KeyFile)

# 把 AnySearch 密钥写入本机 DPAPI 加密存储，供桌宠“智能查询”实时检索使用。
# 明文只存在于当前进程的内存与环境变量中，不写磁盘、不进仓库、不进安装包。
#   .\scripts\set-anysearch-key.ps1                     # 交互输入（不回显）
#   .\scripts\set-anysearch-key.ps1 -KeyFile C:\key.txt # 从文件读取
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $workspace 'apps\desktop\node_modules\electron\dist\electron.exe'
$provision = Join-Path $PSScriptRoot 'provision-anysearch-key.cjs'
if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) { throw '未找到 Electron 运行时，请先在仓库根目录执行 pnpm install --frozen-lockfile。' }
if (-not (Test-Path -LiteralPath $provision -PathType Leaf)) { throw "未找到写入脚本：$provision" }

if ($KeyFile) {
    if (-not (Test-Path -LiteralPath $KeyFile -PathType Leaf)) { throw "密钥文件不存在：$KeyFile" }
    $env:NUANBAN_ANYSEARCH_API_KEY = (Get-Content -LiteralPath $KeyFile -Raw).Trim()
}
else {
    $secure = Read-Host -Prompt '粘贴 AnySearch 密钥（输入不回显，不会写入磁盘）' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $env:NUANBAN_ANYSEARCH_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
if (-not $env:NUANBAN_ANYSEARCH_API_KEY) { throw '未输入密钥，未做任何修改。' }

try {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    & $electron $provision
    if ($LASTEXITCODE -ne 0) { throw "写入失败（退出码 $LASTEXITCODE）。" }
}
finally { Remove-Item Env:NUANBAN_ANYSEARCH_API_KEY -ErrorAction SilentlyContinue }
Write-Output '完成。重新启动桌宠后“智能查询”会使用 AnySearch 实时检索；未配置密钥的机器仍回退本机模型并标注未联网。'