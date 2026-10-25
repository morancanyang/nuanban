function Get-ForegroundControlInventory {
    param($Request)
    $previousDpi = [IntPtr]::Zero
    try {
        if (-not ('NuanbanUiaInventoryNative' -as [type])) {
            Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NuanbanUiaInventoryNative { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context); }'
        }
        $previousDpi = [NuanbanUiaInventoryNative]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
        if ($previousDpi -eq [IntPtr]::Zero) { return @{ protocol = 1; status = 'unavailable'; reason = 'dpi_context_unavailable' } }
        $maxDepth = 8
        $maxControls = 400
        $timeBudgetMs = 3000
        if ($null -ne $Request.maxDepth) { try { $candidate = [int]$Request.maxDepth } catch { $candidate = 0 }; if ($candidate -ge 1 -and $candidate -le 10) { $maxDepth = $candidate } }
        if ($null -ne $Request.maxControls) { try { $candidate = [int]$Request.maxControls } catch { $candidate = 0 }; if ($candidate -ge 1 -and $candidate -le 512) { $maxControls = $candidate } }
        if ($null -ne $Request.timeBudgetMs) { try { $candidate = [int]$Request.timeBudgetMs } catch { $candidate = 0 }; if ($candidate -ge 200 -and $candidate -le 10000) { $timeBudgetMs = $candidate } }
        $excludedProcessIds = @()
        if ($null -ne $Request.excludedProcessIds) { foreach ($value in @($Request.excludedProcessIds)) { try { $excludedProcessIds += [int]$value } catch {} } }
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $handle = [NuanbanUiaInventoryNative]::GetForegroundWindow()
        if ($handle -eq [IntPtr]::Zero) { return @{ protocol = 1; status = 'unavailable'; reason = 'foreground_window_unavailable' } }
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
        if ($null -eq $root) { return @{ protocol = 1; status = 'unavailable'; reason = 'foreground_window_unavailable' } }
        # The foreground window can be Nuanban's own pet/panel window; in that case the list would only
        # describe our own UI, not the software the owner wants to operate. Report it explicitly and let
        # the owner click the target window first - never guess and never silently fall back.
        $foregroundProcessId = $root.Current.ProcessId
        if ($excludedProcessIds -contains $foregroundProcessId) {
            return @{ protocol = 1; status = 'unavailable'; reason = 'foreground_is_self'; processId = $foregroundProcessId }
        }
        $title = ''
        if ($null -ne $root.Current.Name) { $title = [string]$root.Current.Name }
        $className = ''
        if ($null -ne $root.Current.ClassName) { $className = [string]$root.Current.ClassName }
        $controls = New-Object System.Collections.ArrayList
        $state = @{ truncated = $false; depthLimited = $false; deadlineReached = $false; focusedIndex = 0 }
        $deadline = [Environment]::TickCount + $timeBudgetMs
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

        function Read-Name($element) {
            $name = $null
            try { $name = $element.Current.Name } catch { return '' }
            if ($null -eq $name) { return '' }
            $label = ([string]$name) -replace '[\x00-\x1f\x7f-\x9f]', ' '
            $label = ($label -replace '\s+', ' ').Trim()
            if ($label.Length -gt 64) { $label = $label.Substring(0, 64).Trim() }
            return $label
        }

        function Add-Control($element, $depth) {
            if ($state.truncated) { return }
            if ($controls.Count -ge $maxControls) { $state.truncated = $true; return }
            if ([Environment]::TickCount -ge $deadline) { $state.deadlineReached = $true; $state.truncated = $true; return }
            $bounds = $null
            $controlType = ''
            $enabled = $false
            $offscreen = $true
            $focus = $false
            try {
                $bounds = $element.Current.BoundingRectangle
                $controlType = [string]$element.Current.ControlType.ProgrammaticName
                $enabled = [bool]$element.Current.IsEnabled
                $offscreen = [bool]$element.Current.IsOffscreen
                $focus = [bool]$element.Current.HasKeyboardFocus
            } catch { return }
            if ($null -eq $bounds) { return }
            $values = @($bounds.X, $bounds.Y, $bounds.Width, $bounds.Height)
            if (@($values | Where-Object { [double]::IsNaN($_) -or [double]::IsInfinity($_) }).Count -gt 0) { return }
            $index = $controls.Count + 1
            if ($focus -and $state.focusedIndex -eq 0) { $state.focusedIndex = $index }
            $null = $controls.Add(@{ index = $index; name = (Read-Name $element); controlType = $controlType; depth = $depth;
                enabled = $enabled; offscreen = $offscreen; focus = $focus;
                x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height })
        }

        function Add-Children($element, $depth) {
            if ($state.truncated) { return }
            if ($depth -gt $maxDepth) { $state.depthLimited = $true; return }
            $child = $null
            try { $child = $walker.GetFirstChild($element) } catch { return }
            while ($null -ne $child) {
                Add-Control $child $depth
                if ($state.truncated) { return }
                Add-Children $child ($depth + 1)
                if ($state.truncated) { return }
                try { $child = $walker.GetNextSibling($child) } catch { return }
            }
        }

        Add-Children $root 1
        return @{ protocol = 1; status = 'complete'; truncated = $state.truncated; depthLimited = $state.depthLimited;
            deadlineReached = $state.deadlineReached; focusedIndex = $state.focusedIndex;
            window = @{ processId = $foregroundProcessId; className = $className; title = $title };
            count = $controls.Count; maxDepth = $maxDepth; maxControls = $maxControls; controls = @($controls.ToArray()) }
    } catch {
        $cause = $_.Exception.GetBaseException()
        return @{ protocol = 1; status = 'failed'; reason = ('uia_inventory_failed:{0}:0x{1:X8}' -f $cause.GetType().Name, $cause.HResult) }
    } finally {
        if ($previousDpi -ne [IntPtr]::Zero) { $null = [NuanbanUiaInventoryNative]::SetThreadDpiAwarenessContext($previousDpi) }
    }
}

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = $null
$reply = $null
try {
    $builder = New-Object System.Text.StringBuilder
    $characters = New-Object char[] 4096
    while (($read = [Console]::In.Read($characters, 0, $characters.Length)) -gt 0) {
        if ($builder.Length + $read -gt 1048576) { throw [System.IO.InvalidDataException]::new('request_limit') }
        $null = $builder.Append($characters, 0, $read)
    }
    $request = $builder.ToString() | ConvertFrom-Json
    if ($request.protocol -ne 1 -or $request.operation -ne 'inventory') { throw [System.IO.InvalidDataException]::new('protocol_invalid') }
    $reply = Get-ForegroundControlInventory $request
} catch {
    $cause = $_.Exception.GetBaseException()
    $reply = @{ protocol = 1; status = 'failed'; reason = ('inventory_request_failed:{0}:0x{1:X8}' -f $cause.GetType().Name, $cause.HResult) }
}
$outputText = $reply | ConvertTo-Json -Compress -Depth 6
if ([System.Text.Encoding]::UTF8.GetByteCount($outputText) -gt 1048576) {
    $outputText = '{"protocol":1,"status":"failed","reason":"inventory_output_limit"}'
}
[Console]::Out.Write($outputText)