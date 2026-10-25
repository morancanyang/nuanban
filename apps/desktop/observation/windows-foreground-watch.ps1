# Low frequency tracking of the "most recent non-self foreground window" - metadata only
# (hwnd / process name / window title).
# Semantics and privacy boundary:
#   - only user32 GetForegroundWindow / GetWindowThreadProcessId / GetWindowTextLengthW /
#     GetWindowTextW / IsWindow are called;
#   - no screen capture, no pixels, no control tree enumeration, no window content, no UIAutomation;
#   - one NDJSON line (kind=foreground) per changed foreground window, until stdin closes or the
#     parent process kills this helper;
#   - isSelf is derived from excludedProcessIds here, and the Node side recomputes it as well.
function Get-ForegroundWindowInfo {
    param($Request)

    $intervalMs = 750
    if ($null -ne $Request.intervalMs) { try { $candidate = [int]$Request.intervalMs } catch { $candidate = 0 }; if ($candidate -ge 250 -and $candidate -le 5000) { $intervalMs = $candidate } }
    $excludedProcessIds = @()
    if ($null -ne $Request.excludedProcessIds) { foreach ($value in @($Request.excludedProcessIds)) { try { $excludedProcessIds += [int]$value } catch {} } }

    if (-not ('NuanbanForegroundWatchNative' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NuanbanForegroundWatchNative {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
}
'@
    }

    $names = @{}
    $previous = ''
    while ($true) {
        try {
            $handle = [NuanbanForegroundWatchNative]::GetForegroundWindow()
            if ($handle -eq [IntPtr]::Zero) {
                Start-Sleep -Milliseconds $intervalMs
                continue
            }
            $processId = [uint32]0
            $null = [NuanbanForegroundWatchNative]::GetWindowThreadProcessId($handle, [ref]$processId)
            if ($processId -eq 0) {
                Start-Sleep -Milliseconds $intervalMs
                continue
            }
            $title = ''
            try {
                $length = [NuanbanForegroundWatchNative]::GetWindowTextLengthW($handle)
                if ($length -gt 0) {
                    $buffer = New-Object System.Text.StringBuilder ([Math]::Min(512, $length + 1))
                    $null = [NuanbanForegroundWatchNative]::GetWindowTextW($handle, $buffer, $buffer.Capacity)
                    $title = $buffer.ToString()
                }
            } catch { $title = '' }
            # Cleaning is display only: strip control characters, collapse whitespace, cap the length.
            $title = ([string]$title) -replace '[\x00-\x1f\x7f-\x9f]', ' '
            $title = ($title -replace '\s+', ' ').Trim()
            if ($title.Length -gt 160) { $title = $title.Substring(0, 160).Trim() }
            $processName = ''
            if ($names.ContainsKey([int]$processId)) { $processName = $names[[int]$processId] }
            else {
                try { $processName = [string](Get-Process -Id ([int]$processId) -ErrorAction Stop).ProcessName } catch { $processName = '' }
                if ($processName.Length -gt 80) { $processName = $processName.Substring(0, 80) }
                if ($names.Count -lt 64) { $names[[int]$processId] = $processName }
            }
            $isSelf = $excludedProcessIds -contains [int]$processId
            $signature = ('{0}|{1}|{2}|{3}' -f [int64]$handle, [int]$processId, $processName, $title)
            if ($signature -ne $previous) {
                $previous = $signature
                $event = @{ protocol = 1; kind = 'foreground'; hwnd = [int64]$handle; processId = [int]$processId;
                    processName = $processName; title = $title; isSelf = [bool]$isSelf }
                [Console]::Out.Write(($event | ConvertTo-Json -Compress) + "`n")
                [Console]::Out.Flush()
            }
        } catch {
            # A single failed read must not stop tracking or block guidance: just retry on the next tick.
        }
        Start-Sleep -Milliseconds $intervalMs
    }
}

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $builder = New-Object System.Text.StringBuilder
    $characters = New-Object char[] 4096
    $read = [Console]::In.Read($characters, 0, $characters.Length)
    if ($read -gt 0) { $null = $builder.Append($characters, 0, $read) }
    $request = $builder.ToString() | ConvertFrom-Json
    if ($request.protocol -ne 1 -or $request.operation -ne 'watch-foreground') {
        [Console]::Out.Write('{"protocol":1,"status":"failed","reason":"watch_protocol_invalid"}')
        [Console]::Out.Flush()
        exit 0
    }
    Get-ForegroundWindowInfo $request
} catch {
    try {
        [Console]::Out.Write('{"protocol":1,"status":"failed","reason":"watch_request_failed"}')
        [Console]::Out.Flush()
    } catch {}
}