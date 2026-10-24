function Get-PublicShellControls {
    param($Geometry)
    $controls = New-Object System.Collections.ArrayList
    $previousDpi = [IntPtr]::Zero
    try {
        if (-not ('NuanbanShellDpiContext' -as [type])) {
            Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NuanbanShellDpiContext { [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context); }'
        }
        $previousDpi = [NuanbanShellDpiContext]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
        if ($previousDpi -eq [IntPtr]::Zero) { return @() }
        $labels = '{"wechat":"\u5fae\u4fe1","start":"\u5f00\u59cb","search":"\u641c\u7d22","computer":"\u6b64\u7535\u8111","thisComputer":"\u8fd9\u53f0\u7535\u8111","myComputer":"\u6211\u7684\u7535\u8111","recycle":"\u56de\u6536\u7ad9","panel":"\u63a7\u5236\u9762\u677f","running":"\u4e2a\u8fd0\u884c\u7a97\u53e3"}' | ConvertFrom-Json
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -AssemblyName UIAutomationTypes
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
        if ($windows.Count -gt 128) { return @() }
        foreach ($window in $windows) {
            if ($window.Current.ClassName -notin @('Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Progman', 'WorkerW')) { continue }
            $owner = Get-Process -Id $window.Current.ProcessId -ErrorAction Stop
            if ($owner.Path -ine (Join-Path $env:WINDIR 'explorer.exe')) { continue }
            $surface = if ($window.Current.ClassName -in @('Shell_TrayWnd', 'Shell_SecondaryTrayWnd')) { 'taskbar' } else { 'desktop' }
            $controlType = if ($surface -eq 'taskbar') { [System.Windows.Automation.ControlType]::Button } else { [System.Windows.Automation.ControlType]::ListItem }
            $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType)
            $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
            if ($elements.Count -gt 1024) { continue }
            # Candidates are no longer a fixed whitelist. Every qualified shell element found inside an
            # explorer-owned shell window is reported with its own local UI Automation Name; names are
            # cleaned below and only friendly aliases for well-known entries are still mapped. One name
            # at one position inside one window is reported once.
            $seen = @{}
            foreach ($element in $elements) {
                if ($element.Current.ProcessId -ne $window.Current.ProcessId -or $element.Current.IsOffscreen -or -not $element.Current.IsEnabled) { continue }
                $bounds = $element.Current.BoundingRectangle
                $values = @($bounds.X, $bounds.Y, $bounds.Width, $bounds.Height)
                if (@($values | Where-Object { [double]::IsNaN($_) -or [double]::IsInfinity($_) }).Count -gt 0 -or $bounds.Width -le 0 -or $bounds.Height -le 0) { continue }
                if ($bounds.X -lt $Geometry.pixelX -or $bounds.Y -lt $Geometry.pixelY -or $bounds.Right -gt ($Geometry.pixelX + $Geometry.pixelWidth) -or $bounds.Bottom -gt ($Geometry.pixelY + $Geometry.pixelHeight)) { continue }
                $name = $element.Current.Name
                $label = ''
                if ($null -ne $name) { $label = ([string]$name) -replace '[\x00-\x1f\x7f-\x9f]', ' ' }
                $label = ($label -replace '\s+', ' ').Trim()
                if ($label.Length -gt 64) { $label = $label.Substring(0, 64).Trim() }
                if ($surface -eq 'desktop') { $label = ($label -replace '(?i)\.lnk$', '').Trim() }
                # Entries whose name is empty, blank or made only of symbols cannot identify an entry.
                if ($label -eq '' -or $label -notmatch '[\p{L}\p{N}]') { continue }
                $friendly = ''
                if ($surface -eq 'taskbar') {
                    if ($label -match "^($($labels.wechat)|WeChat|Weixin)(?:\s*-\s*\d+\s*(?:$($labels.running)|running windows?))?`$") { $friendly = $labels.wechat }
                    elseif ($label -match "^($($labels.start)|Start)`$") { $friendly = $labels.start }
                    elseif ($label -match "^($($labels.search)|Search)`$") { $friendly = $labels.search }
                } else {
                    if ($label -match "^($($labels.wechat)|WeChat|Weixin)`$") { $friendly = $labels.wechat }
                    elseif ($label -match "^($($labels.computer)|$($labels.thisComputer)|$($labels.myComputer)|This PC|My Computer)`$") { $friendly = $labels.computer }
                    elseif ($label -match "^($($labels.recycle)|Recycle Bin)`$") { $friendly = $labels.recycle }
                    elseif ($label -match "^($($labels.panel)|Control Panel)`$") { $friendly = $labels.panel }
                }
                if ($friendly -ne '') { $label = $friendly }
                $key = '{0}|{1},{2},{3},{4}' -f $label, [int][Math]::Round($bounds.X), [int][Math]::Round($bounds.Y), [int][Math]::Round($bounds.Width), [int][Math]::Round($bounds.Height)
                if ($seen.ContainsKey($key)) { continue }
                $seen[$key] = $true
                $point = New-Object System.Windows.Point(($bounds.X + $bounds.Width / 2), ($bounds.Y + $bounds.Height / 2))
                $hit = [System.Windows.Automation.AutomationElement]::FromPoint($point)
                $verifiedHit = $false
                for ($depth = 0; $depth -lt 8 -and $null -ne $hit; $depth++) {
                    if ($hit.Equals($element) -or ($surface -eq 'taskbar' -and $hit.Equals($window))) { $verifiedHit = $true; break }
                    $hit = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($hit)
                }
                if (-not $verifiedHit) { continue }
                $null = $controls.Add(@{ label = $label; surface = $surface; rect = @{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height } })
                if ($controls.Count -ge 128) { return @($controls.ToArray()) }
            }
        }
    } catch {
        return @()
    } finally {
        if ($previousDpi -ne [IntPtr]::Zero) { $null = [NuanbanShellDpiContext]::SetThreadDpiAwarenessContext($previousDpi) }
    }
    return @($controls.ToArray())
}
