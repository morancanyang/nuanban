import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const androidRoot = fileURLToPath(new URL('../../apps/android/', import.meta.url));
const nativeRoot = androidRoot + 'app/src/standalone/java/org/nuanban/assistant/nativehost/';
const assetRoot = androidRoot + 'app/src/standalone/assets/pet3d/';
const readAndroid = (relativePath: string) => readFileSync(androidRoot + relativePath, 'utf8');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('Android 独立桌宠实时 3D：随包资产与权限边界', () => {
  it('随包 GLB 来自被跟踪的桌面模型，四处摘要一致且构建期复制而非仓库内再存一份', () => {
    const modelPath = androidRoot + '../web/public/models/lumi/Lumi_Magical_Kitten.glb';
    const manifestPath = androidRoot + '../web/public/models/lumi/character_manifest.json';
    expect(existsSync(modelPath)).toBe(true);
    const digest = sha256(readFileSync(modelPath));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { runtime: { sha256: string; fileBytes: number } };
    const desktopPin = /sha256: '([a-f0-9]{64})'/.exec(readAndroid('../web/src/three-d/builtin-models.ts'))?.[1];
    const kotlinPin = /PINNED_MODEL_SHA256 = "([a-f0-9]{64})"/.exec(readAndroid('app/src/standalone/java/org/nuanban/assistant/nativehost/Pet3dAssets.kt'))?.[1];
    expect(manifest.runtime.sha256).toBe(digest);
    expect(desktopPin).toBe(digest);
    expect(kotlinPin).toBe(digest);
    expect(manifest.runtime.fileBytes).toBe(readFileSync(modelPath).byteLength);
    // 仓库内不新增模型副本：pet3d/models 只由构建期任务生成。
    expect(existsSync(assetRoot + 'models')).toBe(false);

    const build = readAndroid('standalone/build.gradle.kts');
    expect(build).toContain('syncPet3dModelAssets');
    expect(build).toContain('apps/web/public/models/lumi');
    expect(build).toContain('Lumi_Magical_Kitten.glb');
    expect(build).toContain('character_manifest.json');
    expect(build).toContain('app/src/standalone/assets');
    expect(build).toContain('generated/pet3dAssets');
    expect(build).toMatch(/merge.*Assets.*dependsOn|dependsOn\(pet3dModelAssets\)/);
    expect(build).not.toMatch(/https?:\/\//);
  });

  it('普通 :app 包不含 3D 资产与 pet3d 代码；实时 3D 本身不申请任何权限', () => {
    const normalBuild = readAndroid('app/build.gradle.kts');
    expect(normalBuild).not.toContain('src/standalone');
    expect(normalBuild).not.toContain('pet3d');
    expect(normalBuild).not.toContain('project(":standalone")');
    expect(readAndroid('app/src/main/AndroidManifest.xml')).not.toMatch(/pet3d|Pet3d/);

    // 独立包的完整权限集合由其他任务负责（本任务开始后它新增了语音相关权限），这里只守护本任务的两条边界：
    // 1) 浮层所需权限仍在；2) pet3d 代码不声明、不申请任何权限（不新增网络/采集能力）。
    const manifest = readAndroid('standalone/src/main/AndroidManifest.xml');
    for (const permission of [
      'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.HIDE_OVERLAY_WINDOWS',
      'android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
      'android.permission.POST_NOTIFICATIONS',
    ]) expect(manifest).toContain(`<uses-permission android:name="${permission}" />`);
    expect(manifest).not.toMatch(/ACCESS_NETWORK_STATE|ACCESS_WIFI_STATE|CHANGE_NETWORK_STATE|QUERY_ALL_PACKAGES|READ_CONTACTS|READ_SMS|BLUETOOTH|NFC/);

    for (const file of [
      'Pet3dAssets.kt', 'Pet3dFrameStats.kt', 'Pet3dGlRenderer.kt', 'Pet3dGlView.kt',
      'Pet3dWebView.kt', 'Pet3dBubbleView.kt', 'Pet3dOverlay.kt', 'Pet3dGlbDocument.kt', 'Pet3dRenderPolicy.kt',
    ]) {
      const source = readAndroid('app/src/standalone/java/org/nuanban/assistant/nativehost/' + file);
      expect(source).not.toMatch(/uses-permission|android\.Manifest\.permission|checkSelfPermission|requestPermissions|addJavascriptInterface\((?!Bridge)/);
    }

    // WebView 3D 路径不引入任何网络调用或文件访问。
    const web = readAndroid('app/src/standalone/java/org/nuanban/assistant/nativehost/Pet3dWebView.kt');
    expect(web).not.toMatch(/HttpURLConnection|OkHttp|Socket\(|URLConnection|openConnection|DownloadManager|WebViewAssetLoader/);
    expect(web).toContain('allowFileAccess = false');
    expect(web).toContain('allowContentAccess = false');
    expect(web).toContain('domStorageEnabled = false');
    expect(web).toContain('setGeolocationEnabled(false)');
    expect(web).toContain('shouldOverrideUrlLoading');
    expect(web).toContain('simpleResponse(403, "Forbidden")');
    expect(web).toContain('simpleResponse(404, "Not Found")');
    expect(web).toContain('relative.contains("..")');
    expect(web).toContain('index.html');
  });

  it('页面与脚本只引用本地资源，模型摘要与桌面端一致，且不出现外部主机名', () => {
    const html = readFileSync(assetRoot + 'index.html', 'utf8');
    const script = readFileSync(assetRoot + 'viewer/pet3d-viewer.js', 'utf8');
    expect(html).toContain('background: transparent');
    expect(html).toContain('"three": "./viewer/three.module.js"');
    expect(html).toContain('./viewer/pet3d-viewer.js');
    expect(html).not.toMatch(/https?:\/\/(?!pet3d\.nuanban\.invalid)/);
    expect(script).toContain("MODEL_SHA256 = '3ec165a265d28d00bec78c6262d4909542d9d5e8759759cc00cdb07fd7f95f90'");
    expect(script).toContain("import.meta.url");
    expect(script).toContain("crypto.subtle.digest('SHA-256'");
    expect(script).toContain('setClearColor(0x000000, 0)');
    expect(script).toContain("powerPreference: 'low-power'");
    expect(script).toContain('Math.min(window.devicePixelRatio || 1, 1.5)');
    expect(script).toContain('nuanbanPet3d');
    expect(script).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon|localStorage|sessionStorage|indexedDB/);
    expect(script).not.toMatch(/https?:\/\//);
    expect(script).not.toMatch(/\beval\(|new Function\(/);
    // 只有 three 与相对路径两种模块来源（桌面端同版本内嵌运行时）。
    const specifiers = [...script.matchAll(/from '([^']+)'/g)].map(match => match[1]);
    expect(specifiers.sort()).toEqual(['./loaders/GLTFLoader.js', 'three']);

    const vendored = [
      'viewer/three.module.js', 'viewer/three.core.js', 'viewer/loaders/GLTFLoader.js',
      'viewer/utils/BufferGeometryUtils.js', 'viewer/utils/SkeletonUtils.js',
    ];
    for (const file of vendored) {
      const text = readFileSync(assetRoot + file, 'utf8');
      // 只看真正的 import 语句：three 的注释里有示例 CDN 地址，不构成运行时依赖。
      const sources = [...text.matchAll(/^import[^;]*?from\s+'([^']+)'/gm)].map(match => match[1]);
      expect(sources.filter(source => /^https?:/.test(source))).toEqual([]);
      expect(sources.every(source => source.startsWith('./') || source.startsWith('../') || source === 'three')).toBe(true);
    }
    // three.core.js 是基础模块（无 import）；另外几个必须是真的 ESM 且有本地/`three` 来源。
    expect([...readFileSync(assetRoot + 'viewer/loaders/GLTFLoader.js', 'utf8').matchAll(/^import[^;]*?from\s+'([^']+)'/gm)].map(match => match[1]).sort())
      .toEqual(['../utils/BufferGeometryUtils.js', '../utils/SkeletonUtils.js', 'three']);
    expect([...readFileSync(assetRoot + 'viewer/three.module.js', 'utf8').matchAll(/^import[^;]*?from\s+'([^']+)'/gm)].map(match => match[1]))
      .toEqual(['./three.core.js']);
    expect(existsSync(assetRoot + 'viewer/THREE-LICENSE.txt')).toBe(true);
  });

  it('离线校验脚本可从 Windows PowerShell 5.1 解析（UTF-8 BOM）且自带真机测量与验收脚本', () => {
    for (const script of [
      'standalone/tools/pet3d/check-pet3d.ps1',
      'standalone/tools/pet3d/measure-pet3d.ps1',
      'standalone/tools/pet3d/accept-pet3d.ps1',
    ]) {
      const bytes = readFileSync(androidRoot + script);
      expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
      expect(bytes.byteLength).toBeGreaterThan(500);
    }
    const measure = readAndroid('standalone/tools/pet3d/measure-pet3d.ps1');
    expect(measure).toContain('dumpsys');
    expect(measure).toContain('gfxinfo');
    expect(measure).toContain('meminfo');
    expect(measure).toContain('batterystats');
    expect(measure).toContain('thermalservice');
    expect(measure).toContain('no_device_attached');
    expect(measure).toContain('deviceVerified = $false');
    expect(measure).toContain('NuanbanPet3d');
    expect(measure).not.toMatch(/https?:\/\//);

    const accept = readAndroid('standalone/tools/pet3d/accept-pet3d.ps1');
    for (const step of ['devices', 'install', 'grants', 'verify', 'fallback-missing', 'fallback-corrupt', 'restore', 'tiering-webview-off', 'tiering-webview-on', 'perf']) {
      expect(accept).toContain(`'${step}'`);
    }
    expect(accept).toContain("ValidateSet('devices', 'install', 'grants', 'verify'");
    expect(accept).toContain('adb');
    expect(accept).toContain('appops');
    expect(accept).toContain('screencap');
    expect(accept).toContain('overlayRegionUniformBlack');
    expect(accept).toContain('measure-pet3d.ps1');
    expect(accept).toContain('manualSteps');
    // 不允许把人工项当通过，也不允许无条件声明已验收。
    expect(accept).toContain('Note-Manual');
    expect(accept).toContain('deviceVerified = $script:deviceVerifiedByThisRun');
    expect(accept).not.toMatch(/deviceVerified = \$true/);
    expect(accept).not.toMatch(/https?:\/\//);
  });

  it.skipIf(process.platform !== 'win32')('三个 PowerShell 脚本在 Windows PowerShell 5.1 下语法可解析（不接受 PS7 专有语法）', () => {
    const script = `
$files = @(
  'apps/android/standalone/tools/pet3d/check-pet3d.ps1',
  'apps/android/standalone/tools/pet3d/measure-pet3d.ps1',
  'apps/android/standalone/tools/pet3d/accept-pet3d.ps1'
)
foreach ($f in $files) {
  $tokens = $null; $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $f).Path, [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { Write-Output ($f + ' FAIL ' + ($errors | ForEach-Object { $_.Message }) -join ' | ') } else { Write-Output ($f + ' OK') }
}`;
    const scriptPath = androidRoot + 'standalone/tools/pet3d/build/parse-check.ps1';
    mkdirSync(androidRoot + 'standalone/tools/pet3d/build', { recursive: true });
    writeFileSync(scriptPath, script, 'utf8');
    const output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd: workspaceRoot, encoding: 'utf8', timeout: 60_000, windowsHide: true,
    });
    expect(output).not.toContain('FAIL');
    expect(output.match(/OK/g)?.length).toBe(3);
  }, 120_000);

  it('构建期模型变体只影响验收用构建，默认仍复制与桌面端一致的完整模型', () => {
    const build = readAndroid('standalone/build.gradle.kts');
    expect(build).toContain('pet3dModelVariant');
    expect(build).toContain('full\", \"missing\", \"corrupt');
    expect(build).toContain('"missing" -> fileSystem.delete');
    expect(build).toContain('bytes.copyOf(bytes.size / 2)');
    expect(build).toContain('require(pet3dModelVariant in setOf("full", "missing", "corrupt"))');
    expect(build).toContain('(findProperty("pet3dModelVariant") as String?) ?: "full"');
  });
});