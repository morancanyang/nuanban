import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const workspace = path.resolve(import.meta.dirname, '../..');
const fixturePrefix = path.join(tmpdir(), 'nuanban-client-startup-');
const fixtureRoots: string[] = [];
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

function powershell(source: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'));
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ${source}`, 'utf16le').toString('base64')],
  { encoding: 'utf8', windowsHide: true, timeout: 30_000, env });
  return JSON.parse(output.trim().split(/\r?\n/).at(-1)!);
}

function fixture(helperSource = readFileSync(path.join(workspace, 'scripts/desktop-runtime-integrity.ps1'), 'utf8')) {
  const root = mkdtempSync(fixturePrefix);
  fixtureRoots.push(root);
  const scripts = path.join(root, 'scripts');
  const runtimeDirectory = path.join(root, 'apps/desktop/node_modules/electron/dist');
  const runtime = path.join(runtimeDirectory, 'electron.exe');
  const ui = path.join(root, 'apps/web/dist/index.html');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(runtimeDirectory, { recursive: true });
  mkdirSync(path.dirname(ui), { recursive: true });
  writeFileSync(runtime, 'Synthetic runtime; never executed');
  writeFileSync(ui, '<title>Synthetic client</title>');
  writeFileSync(path.join(scripts, 'desktop-runtime-integrity.ps1'), helperSource);
  writeFileSync(path.join(scripts, 'start-desktop-client.ps1'), readFileSync(path.join(workspace, 'scripts/start-desktop-client.ps1')));
  return { root, scripts, runtimeDirectory, runtime };
}

function launchProbe(options: { exitCode?: number; compatible?: boolean; protectPet?: boolean; repairFailure?: boolean; launchFailure?: boolean } = {}) {
  const current = fixture(options.repairFailure ? "function Repair-DesktopRuntimeIntegrity { throw 'Synthetic integrity failure' }" : undefined);
  return powershell(`
    $options = ConvertFrom-Json ${quote(JSON.stringify(options))}
    $env:ELECTRON_RUN_AS_NODE = 'synthetic-existing-value'
    $global:launchRecord = $null
    $global:probeOptions = $options
    function Start-Process {
      param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$PassThru)
      $global:launchRecord = @{ runtime = $FilePath; arguments = $ArgumentList; windowStyle = $WindowStyle; runAsNode = $env:ELECTRON_RUN_AS_NODE }
      if ($global:probeOptions.launchFailure) { throw 'Synthetic process creation failure' }
      $process = [pscustomobject]@{ Id = 1234; ExitCode = $global:probeOptions.exitCode }
      $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($milliseconds) return $null -ne $global:probeOptions.exitCode }
      return $process
    }
    $errorText = $null
    try { & ${quote(path.join(current.scripts, 'start-desktop-client.ps1'))} -CompatibleDisplay:([bool]$options.compatible) -ProtectPet:([bool]$options.protectPet) | Out-Null }
    catch { $errorText = $_.Exception.Message }
    @{ error = $errorText; launch = $global:launchRecord; restoredRunAsNode = $env:ELECTRON_RUN_AS_NODE } | ConvertTo-Json -Depth 5 -Compress
  `);
}

describe.skipIf(process.platform !== 'win32')('Windows client startup integrity', () => {
  let integrity: { repaired: string[]; again: string[]; levels: Record<string, number>; daclPreserved: boolean };

  beforeAll(() => {
    const current = fixture();
    const files = {
      runtime: current.runtime,
      library: path.join(current.runtimeDirectory, 'ffmpeg.dll'),
      extraExecutable: path.join(current.runtimeDirectory, '辅助 runtime.exe'),
      healthyLibrary: path.join(current.runtimeDirectory, 'normal.dll'),
      resource: path.join(current.runtimeDirectory, 'resources.pak'),
      nestedLibrary: path.join(current.runtimeDirectory, 'nested/untouched.dll'),
      projectLibrary: path.join(current.root, 'untouched.dll'),
    };
    for (const file of Object.values(files)) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'Synthetic integrity fixture; never executed');
    }
    integrity = powershell(`
      . ${quote(path.join(current.scripts, 'desktop-runtime-integrity.ps1'))}
      $files = ConvertFrom-Json ${quote(JSON.stringify(files))}
      $before = @{}
      foreach ($entry in $files.PSObject.Properties) {
        $label = if ($entry.Name -eq 'healthyLibrary') { 'M' } else { 'L' }
        & (Join-Path $env:SystemRoot 'System32/icacls.exe') $entry.Value /setintegritylevel $label | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare synthetic integrity fixture' }
        $before[$entry.Name] = (Get-Acl -LiteralPath $entry.Value).Sddl
      }
      $repaired = @(Repair-DesktopRuntimeIntegrity -RuntimePath ${quote(current.runtime)})
      $again = @(Repair-DesktopRuntimeIntegrity -RuntimePath ${quote(current.runtime)})
      $levels = @{}
      $daclPreserved = $true
      foreach ($entry in $files.PSObject.Properties) {
        $levels[$entry.Name] = [Nuanban.Desktop.RuntimeIntegrity]::GetLevel($entry.Value)
        if ($before[$entry.Name] -ne (Get-Acl -LiteralPath $entry.Value).Sddl) { $daclPreserved = $false }
      }
      @{ repaired = $repaired; again = $again; levels = $levels; daclPreserved = $daclPreserved } | ConvertTo-Json -Depth 5 -Compress
    `);
  }, 30_000);

  afterAll(() => {
    for (const root of fixtureRoots) {
      if (!path.resolve(root).startsWith(fixturePrefix)) throw new Error('Refusing to remove a path outside the test fixture prefix');
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('repairs both low-integrity executables and renderer libraries to Medium', () => {
    expect(integrity.levels).toMatchObject({ runtime: 8192, library: 8192, extraExecutable: 8192 });
    expect(integrity.repaired.map(file => path.basename(file)).sort()).toEqual(['electron.exe', 'ffmpeg.dll', '辅助 runtime.exe'].sort());
  });

  it('preserves existing access permissions and leaves healthy binaries unchanged', () => {
    expect(integrity.daclPreserved).toBe(true);
    expect(integrity.levels.healthyLibrary).toBe(8192);
    expect(integrity.again).toEqual([]);
  });

  it('does not recursively relabel resources, project files or user data', () => {
    expect(integrity.levels).toMatchObject({ resource: 4096, nestedLibrary: 4096, projectLibrary: 4096 });
  });

  it('keeps the client flags, normal window and sandbox while clearing Node mode only during launch', () => {
    const result = launchProbe({ compatible: true });
    expect(result.error).toBeNull();
    expect(result.launch).toMatchObject({ windowStyle: 'Normal', runAsNode: null });
    expect(result.launch.arguments).toEqual([expect.stringContaining('apps\\desktop'), '--management', '--client-display-compatible', '--pet-display-compatible']);
    expect(result.restoredRunAsNode).toBe('synthetic-existing-value');
  });

  it('keeps optional display compatibility and pet protection explicit', () => {
    const result = launchProbe({ protectPet: true });
    expect(result.error).toBeNull();
    expect(result.launch.arguments).toEqual([expect.stringContaining('apps\\desktop'), '--management']);
  });

  it('refuses to launch when the runtime integrity check fails', () => {
    const result = launchProbe({ repairFailure: true });
    expect(result.error).toContain('Synthetic integrity failure');
    expect(result.launch).toBeNull();
    expect(result.restoredRunAsNode).toBe('synthetic-existing-value');
  });

  it('reports early native crashes without claiming launch success and restores the environment', () => {
    const result = launchProbe({ exitCode: 12 });
    expect(result.error).toContain('Client startup failed (exit code 12)');
    expect(result.restoredRunAsNode).toBe('synthetic-existing-value');
  });

  it('allows a normal second-instance handoff', () => {
    const result = launchProbe({ exitCode: 0 });
    expect(result.error).toBeNull();
    expect(result.restoredRunAsNode).toBe('synthetic-existing-value');
  });

  it('restores the environment if process creation itself fails', () => {
    const result = launchProbe({ launchFailure: true });
    expect(result.error).toContain('Synthetic process creation failure');
    expect(result.restoredRunAsNode).toBe('synthetic-existing-value');
  });
});
