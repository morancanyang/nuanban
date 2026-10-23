if (-not ('Nuanban.Desktop.RuntimeIntegrity' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace Nuanban.Desktop {
    public static class RuntimeIntegrity {
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetNamedSecurityInfoW")]
        private static extern uint GetNamedSecurityInfo(string name, int objectType, uint securityInformation,
            out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetAce(IntPtr acl, uint index, out IntPtr ace);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);

        public static int GetLevel(string path) {
            IntPtr owner, group, dacl, sacl, descriptor;
            uint result = GetNamedSecurityInfo(path, 1, 0x10, out owner, out group, out dacl, out sacl, out descriptor);
            if (result != 0) throw new Win32Exception((int)result, "Cannot inspect runtime integrity: " + path);
            try {
                if (sacl == IntPtr.Zero) return 0x2000;
                int count = (ushort)Marshal.ReadInt16(sacl, 4);
                for (uint index = 0; index < count; index++) {
                    IntPtr ace;
                    if (!GetAce(sacl, index, out ace)) throw new Win32Exception();
                    if (Marshal.ReadByte(ace) != 0x11 || (Marshal.ReadByte(ace, 1) & 0x08) != 0) continue;
                    string identifier = new SecurityIdentifier(IntPtr.Add(ace, 8)).Value;
                    return int.Parse(identifier.Substring("S-1-16-".Length), CultureInfo.InvariantCulture);
                }
                return 0x2000;
            } finally {
                LocalFree(descriptor);
            }
        }
    }
}
'@
}

function Repair-DesktopRuntimeIntegrity {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$RuntimePath)

    $runtimeDirectory = (Get-Item -LiteralPath $RuntimePath -ErrorAction Stop).Directory.FullName
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    $binaries = Get-ChildItem -LiteralPath $runtimeDirectory -File | Where-Object { $_.Extension -in @('.exe', '.dll') }
    foreach ($binary in $binaries) {
        if ([Nuanban.Desktop.RuntimeIntegrity]::GetLevel($binary.FullName) -ge 0x2000) { continue }
        $diagnostics = & $icacls $binary.FullName /setintegritylevel M 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Cannot restore Electron runtime integrity for '$($binary.FullName)': $diagnostics"
        }
        if ([Nuanban.Desktop.RuntimeIntegrity]::GetLevel($binary.FullName) -lt 0x2000) {
            throw "Electron runtime still has a low integrity label: $($binary.FullName)"
        }
        Write-Output $binary.FullName
    }
}
