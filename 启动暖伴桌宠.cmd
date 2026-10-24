@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
if not exist "node_modules\electron\dist\electron.exe" goto missing
if not exist "apps\web\dist\index.html" echo Note: run "corepack pnpm build" once if you need the management window.
start "" "node_modules\electron\dist\electron.exe" "apps\desktop"
exit /b 0
:missing
echo Electron runtime not found.
echo Run this first: corepack pnpm install --frozen-lockfile
pause
exit /b 1