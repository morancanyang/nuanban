// Push the built desktop/Android artifacts to the 微光指引 trial host without OSS.
//
// Flow (all temporary changes are reverted by the final cleanup command):
//   1. SendFile a tiny upload receiver + random token to the host;
//   2. add a temporary IIS rewrite rule /_upload/* -> 127.0.0.1:3999, raise request limits and
//      proxy timeout, recycle IIS, start the receiver as a hidden process;
//   3. stream each artifact to http://<publicIp>/_upload/<name> with the token header;
//   4. verify SHA-256 on the host, restore the original web.config, stop the receiver, recycle
//      IIS and move the files into C:\nuanban\web\downloads;
//   5. publish a downloads/index.html with names, sizes and hashes, then verify public URLs.
//
// Usage:
//   node infra/windows/tools/push-downloads.mjs --instance i-xxx [--port 80]
//        [--skip-desktop] [--skip-android] [--keep-files] [--keep-published]

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createClient, loadCredentials } from './aliyun-ecs-api.mjs';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const UPLOAD_DIR = 'C:\\nuanban\\staging\\uploads';
const TEMP_DIR = 'C:\\nuanban\\temp';
const WEB_DIR = 'C:\\nuanban\\web';
const DOWNLOAD_DIR = 'C:\\nuanban\\web\\downloads';

const artifacts = {
  desktopZip: {
    local: path.join(root, 'apps', 'desktop', 'out', 'dist', 'NuanbanDemo-0.1.0-win32-x64-portable-20261022.zip'),
    remote: 'NuanbanDemo-0.1.0-win32-x64-portable-20261022.zip',
    label: 'Windows 桌面便携包（未签名）',
  },
  androidApp: {
    local: path.join(root, 'apps', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
    remote: 'nuanban-android-app-debug.apk',
    label: 'Android 普通客户端（debug）',
  },
  androidStandalone: {
    local: path.join(root, 'apps', 'android', 'standalone', 'build', 'outputs', 'apk', 'debug', 'standalone-debug.apk'),
    remote: 'nuanban-android-standalone-debug.apk',
    label: 'Android 独立桌宠（debug）',
  },
};

function parseArgs(argv) {
  const args = { region: 'cn-beijing', port: 80, skipDesktop: false, skipAndroid: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case '--instance': args.instanceId = next(); break;
      case '--region': args.region = next(); break;
      case '--port': args.port = Number.parseInt(next(), 10); break;
      case '--desktop-zip': args.desktopZip = next(); break;
      case '--desktop-remote': args.desktopRemote = next(); break;
      case '--skip-desktop': args.skipDesktop = true; break;
      case '--skip-android': args.skipAndroid = true; break;
      case '--keep-files': args.keepFiles = true; break;
      case '--keep-published': args.keepPublished = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.instanceId) throw new Error('--instance is required');
  return args;
}
function labelFor(remote) {
  if (/^NuanbanDemo-.*-portable-.*\.zip$/.test(remote)) return 'Windows 桌面便携包（未签名）';
  const known = Object.values(artifacts).find((artifact) => artifact.remote === remote);
  return known ? known.label : remote;
}

function log(message) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${message}`);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function decodeOutput(output) {
  if (!output) return '';
  const trimmed = output.trim();
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed)) return output;
  try {
    return Buffer.from(trimmed, 'base64').toString('utf8');
  } catch {
    return output;
  }
}

async function runCommand(client, instanceId, script, name, timeout = 300) {
  const command = await client.runCommand({ instanceId, script, timeout, name });
  log(`command ${name}: ${command.InvokeId}`);
  for (let i = 0; i < Math.ceil(timeout / 5); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const results = await client.describeInvocationResults(command.InvokeId);
    const invocation = results[0];
    if (invocation && !['Pending', 'Running'].includes(invocation.InvocationStatus)) {
      const text = decodeOutput(invocation.Output ?? '');
      return { status: invocation.InvocationStatus, exitCode: invocation.ExitCode, output: text };
    }
  }
  throw new Error(`command ${name} timed out`);
}

function uploadFile(url, file, token) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(file).size;
    const request = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'x-upload-token': token,
          'content-type': 'application/octet-stream',
          'content-length': String(size),
        },
        timeout: 0,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode !== 200) {
            reject(new Error(`upload failed HTTP ${response.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`upload returned non-JSON: ${body.slice(0, 200)}`));
          }
        });
      }
    );
    request.on('error', reject);
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.pipe(request);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const client = createClient({ credentials: loadCredentials(), regionId: args.region });
  const instance = await client.describeInstance(args.instanceId);
  const publicIp = instance.PublicIpAddress?.IpAddress?.[0];
  if (!publicIp) throw new Error('instance has no public IP');
  log(`instance ${args.instanceId} public ${publicIp}, status ${instance.Status}`);

  if (args.desktopZip) artifacts.desktopZip.local = path.resolve(args.desktopZip);
  if (args.desktopRemote) artifacts.desktopZip.remote = args.desktopRemote;

  const selected = [];
  if (!args.skipDesktop) selected.push(['desktop', artifacts.desktopZip]);
  if (!args.skipAndroid) selected.push(['android-app', artifacts.androidApp], ['android-standalone', artifacts.androidStandalone]);
  for (const [key, artifact] of selected) {
    if (!fs.existsSync(artifact.local)) throw new Error(`missing local artifact (${key}): ${artifact.local}`);
    artifact.size = fs.statSync(artifact.local).size;
    artifact.sha256 = await sha256File(artifact.local);
    log(`${key}: ${artifact.remote} ${artifact.size} bytes sha256=${artifact.sha256}`);
  }

  const token = crypto.randomBytes(32).toString('hex');
  const receiverSource = fs.readFileSync(path.join(root, 'infra', 'windows', 'tools', 'upload-receiver.mjs'));
  const publishableSelected = selected.map(([, a]) => a);
  const expected = publishableSelected.map((a) => ({ name: a.remote, sha256: a.sha256, size: a.size }));
  let publishedFiles = null;

  // ---- 1. push small helper files
  await client.sendFile({
    instanceId: args.instanceId,
    name: 'upload-receiver.mjs',
    contentBase64: receiverSource.toString('base64'),
    targetDir: TEMP_DIR,
    timeout: 120,
    overwrite: true,
  });
  await client.sendFile({
    instanceId: args.instanceId,
    name: 'upload-token.txt',
    contentBase64: Buffer.from(token, 'utf8').toString('base64'),
    targetDir: TEMP_DIR,
    timeout: 120,
    overwrite: true,
  });
  const uploadConfig = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <directoryBrowse enabled="false" />
    <staticContent>
      <remove fileExtension=".glb" /><mimeMap fileExtension=".glb" mimeType="model/gltf-binary" />
      <remove fileExtension=".vrm" /><mimeMap fileExtension=".vrm" mimeType="model/gltf-binary" />
    </staticContent>
    <httpProtocol>
      <customHeaders>
        <remove name="X-Content-Type-Options" /><add name="X-Content-Type-Options" value="nosniff" />
        <remove name="Referrer-Policy" /><add name="Referrer-Policy" value="strict-origin-when-cross-origin" />
        <!-- 下载页每次发布都会重写；浏览器若缓存旧页面，用户会点到已撤下的文件名而得到 IIS 404。
             因此整站禁止缓存：页面始终是当前列表，历史包不会再被旧页面引用。 -->
        <remove name="Cache-Control" /><add name="Cache-Control" value="no-store, must-revalidate" />
      </customHeaders>
    </httpProtocol>
    <defaultDocument><files><clear /><add value="index.html" /></files></defaultDocument>
    <caching enabled="true" enableKernelCache="false" />
    <security><requestFiltering><requestLimits maxAllowedContentLength="1073741824" /></requestFiltering></security>
    <rewrite>
      <rules>
        <rule name="NuanbanTempUpload" stopProcessing="true">
          <match url="^_upload/(.*)$" />
          <action type="Rewrite" url="http://127.0.0.1:3999/_upload/{R:1}" appendQueryString="true" />
        </rule>
        <rule name="NuanbanApiSameOrigin" stopProcessing="true">
          <match url="^(healthz|v1/.*)$" />
          <action type="Rewrite" url="http://127.0.0.1:3000/{R:0}" appendQueryString="true" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
`;
  await client.sendFile({
    instanceId: args.instanceId,
    name: 'web.config.upload',
    contentBase64: Buffer.from(uploadConfig, 'utf8').toString('base64'),
    targetDir: TEMP_DIR,
    timeout: 120,
    overwrite: true,
  });
  log('upload receiver, token and temporary web.config dispatched');
  await new Promise((resolve) => setTimeout(resolve, 4000));

  // ---- 2. enable the temporary channel
  const setup = `$ErrorActionPreference = 'Stop'
$temp = 'C:\\nuanban\\temp'
$web = 'C:\\nuanban\\web'
New-Item -ItemType Directory -Path $temp -Force | Out-Null
New-Item -ItemType Directory -Path 'C:\\nuanban\\staging\\uploads' -Force | Out-Null
if (Test-Path (Join-Path $web 'web.config.preupload')) { Remove-Item (Join-Path $web 'web.config.preupload') -Force }
Copy-Item (Join-Path $web 'web.config') (Join-Path $web 'web.config.preupload') -Force
Copy-Item (Join-Path $temp 'web.config.upload') (Join-Path $web 'web.config') -Force
& "$env:SystemRoot\\System32\\inetsrv\\appcmd.exe" set config -section:system.webServer/proxy /timeout:'00:30:00' /commit:apphost | Out-Null
& iisreset.exe /noforce | Out-Null
Start-Sleep -Seconds 3
if ((Get-Service W3SVC).Status -ne 'Running') { Start-Service W3SVC }
$existing = Get-NetTCPConnection -LocalPort 3999 -State Listen -ErrorAction SilentlyContinue
if ($existing) { Stop-Process -Id $existing.OwningProcess -Force -ErrorAction SilentlyContinue }
$proc = Start-Process -FilePath 'C:\\Program Files\\nodejs\\node.exe' -ArgumentList @((Join-Path $temp 'upload-receiver.mjs'), 'C:\\nuanban\\staging\\uploads', (Join-Path $temp 'upload-token.txt'), '3999') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $temp 'receiver.out.log') -RedirectStandardError (Join-Path $temp 'receiver.err.log')
New-Item -ItemType File -Path (Join-Path $temp 'receiver.pid') -Force | Out-Null
Set-Content -Path (Join-Path $temp 'receiver.pid') -Value $proc.Id -Encoding ASCII
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3999/_ping' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch { }
}
Write-Host ('receiver ready: ' + $ready + ', pid=' + $proc.Id)
try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1/_upload/ping' -UseBasicParsing -TimeoutSec 5 -Method POST -Headers @{ 'x-upload-token' = 'invalid' } } catch { Write-Host ('public channel reachable (403 expected): ' + $_.Exception.Message) }
if (-not $ready) { exit 1 }
`;
  const setupResult = await runCommand(client, args.instanceId, setup, 'nuanban-upload-setup', 300);
  console.log(setupResult.output);
  if (setupResult.status !== 'Success') throw new Error('temporary upload channel setup failed');

  const cleanup = `$ErrorActionPreference = 'Continue'
$temp = 'C:\\nuanban\\temp'
$web = 'C:\\nuanban\\web'
$pidFile = Join-Path $temp 'receiver.pid'
if (Test-Path -LiteralPath $pidFile) {
  $receiverPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
  Stop-Process -Id $receiverPid -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
& "$env:SystemRoot\\System32\\inetsrv\\appcmd.exe" set config -section:system.webServer/proxy /timeout:'00:02:00' /commit:apphost | Out-Null
if (Test-Path -LiteralPath (Join-Path $web 'web.config.preupload')) {
  Copy-Item -LiteralPath (Join-Path $web 'web.config.preupload') (Join-Path $web 'web.config') -Force
  Remove-Item -LiteralPath (Join-Path $web 'web.config.preupload') -Force
}
& iisreset.exe /noforce | Out-Null
Start-Sleep -Seconds 3
if ((Get-Service W3SVC).Status -ne 'Running') { Start-Service W3SVC }
Remove-Item -LiteralPath (Join-Path $temp 'upload-token.txt') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $temp 'web.config.upload') -Force -ErrorAction SilentlyContinue
Write-Host 'temporary upload channel closed'
`;

  // ---- 3. stream the artifacts
  const base = `http://${publicIp}${args.port === 80 ? '' : `:${args.port}`}`;
  try {
    for (const artifact of publishableSelected) {
      const started = Date.now();
      log(`uploading ${artifact.remote} (${(artifact.size / 1024 / 1024).toFixed(1)} MiB)`);
      const result = await uploadFile(`${base}/_upload/${encodeURIComponent(artifact.remote)}`, artifact.local, token);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (result.size !== artifact.size || result.sha256 !== artifact.sha256) {
        throw new Error(`hash mismatch for ${artifact.remote}: remote ${result.size}/${result.sha256} vs local ${artifact.size}/${artifact.sha256}`);
      }
      log(`  ok in ${seconds}s: ${result.size} bytes sha256=${result.sha256}`);
    }

    // ---- 4. verify, revert, publish
    const expectedJson = JSON.stringify(expected);
    const finalize = `$ErrorActionPreference = 'Stop'
$temp = 'C:\\nuanban\\temp'
$web = 'C:\\nuanban\\web'
$uploads = 'C:\\nuanban\\staging\\uploads'
$downloads = Join-Path $web 'downloads'
$expected = '${Buffer.from(expectedJson, 'utf8').toString('base64')}'
$list = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($expected)) | ConvertFrom-Json
foreach ($item in $list) {
  $file = Join-Path $uploads $item.name
  if (-not (Test-Path -LiteralPath $file)) { throw ('uploaded file missing: ' + $item.name) }
  $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $item.sha256.ToLower()) { throw ('hash mismatch: ' + $item.name + ' ' + $actual) }
  Write-Host ('verified ' + $item.name + ' ' + $item.size + ' bytes ' + $actual)
}
$pidFile = Join-Path $temp 'receiver.pid'
if (Test-Path -LiteralPath $pidFile) {
  $receiverPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
  Stop-Process -Id $receiverPid -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}
& "$env:SystemRoot\\System32\\inetsrv\\appcmd.exe" set config -section:system.webServer/proxy /timeout:'00:02:00' /commit:apphost | Out-Null
if (Test-Path -LiteralPath (Join-Path $web 'web.config.preupload')) {
  Copy-Item -LiteralPath (Join-Path $web 'web.config.preupload') (Join-Path $web 'web.config') -Force
  Remove-Item -LiteralPath (Join-Path $web 'web.config.preupload') -Force
}
New-Item -ItemType Directory -Path $downloads -Force | Out-Null
foreach ($item in $list) {
  Copy-Item -LiteralPath (Join-Path $uploads $item.name) (Join-Path $downloads $item.name) -Force
}
& icacls.exe $downloads /grant 'IIS_IUSRS:(OI)(CI)(RX)' /T /Q | Out-Null
& iisreset.exe /noforce | Out-Null
Start-Sleep -Seconds 3
if ((Get-Service W3SVC).Status -ne 'Running') { Start-Service W3SVC }
Remove-Item -LiteralPath (Join-Path $uploads '*') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $temp 'web.config.upload') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $temp 'upload-token.txt') -Force -ErrorAction SilentlyContinue
Write-Host 'temporary upload channel closed, files published'
Get-ChildItem $downloads -File | Select-Object Name, Length | Format-Table -AutoSize | Out-String | Write-Host
`;
    const listPublished = `$ErrorActionPreference = 'Stop'
$downloads = 'C:\\nuanban\\web\\downloads'
$items = Get-ChildItem -LiteralPath $downloads -File | Where-Object { $_.Extension -ne '.html' } | Sort-Object Name | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; size = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower() }
}
ConvertTo-Json -InputObject @($items) -Compress
`;
    const finalizeResult = await runCommand(client, args.instanceId, finalize, 'nuanban-upload-finalize', 300);
    console.log(finalizeResult.output);
    if (finalizeResult.status !== 'Success') throw new Error('finalize step failed');
    if (args.keepPublished) {
      // Windows-only releases must not drop the Android rows that are already published, and must not
      // republish APKs built by someone else: list the directory and hash every file on the host.
      const listingResult = await runCommand(client, args.instanceId, listPublished, 'nuanban-downloads-listing', 180);
      if (listingResult.status !== 'Success') throw new Error('downloads listing failed');
      const parsed = JSON.parse(decodeOutput(listingResult.output).trim());
      publishedFiles = (Array.isArray(parsed) ? parsed : [parsed])
        .filter((item) => item && item.name)
        .map((item) => ({ remote: item.name, size: Number(item.size), sha256: String(item.sha256).toLowerCase() }));
      if (!publishedFiles.length) throw new Error('downloads listing returned no files');
      log(`keeping ${publishedFiles.length} published file(s) in the page listing`);
    }
  } catch (error) {
    log(`upload failed, cleaning up the temporary channel: ${error.message}`);
    try {
      const cleanupResult = await runCommand(client, args.instanceId, cleanup, 'nuanban-upload-cleanup', 180);
      console.log(cleanupResult.output);
    } catch (cleanupError) {
      log(`cleanup also failed: ${cleanupError.message}`);
    }
    throw error;
  }

  // ---- 5. download page
  const pageEntries = publishedFiles ?? publishableSelected.map((a) => ({ remote: a.remote, size: a.size, sha256: a.sha256 }));
  const rows = pageEntries
    .map(
      (a) => `        <tr><td>${a.label ?? labelFor(a.remote)}</td><td><a href="./${a.remote}">${a.remote}</a></td><td>${(a.size / 1024 / 1024).toFixed(1)} MiB</td><td><code>${a.sha256}</code></td></tr>`
    )
    .join('\n');
  const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1.0" />
<title>微光指引 · 下载（未签名开发包）</title>
<style>
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; margin: 2rem auto; max-width: 62rem; padding: 0 1rem; color: #2b2b2b; background: #fff8ef; }
  h1 { font-size: 1.5rem; }
  .warn { background: #fff1e0; border: 1px solid #e7c9a6; padding: .8rem 1rem; border-radius: .6rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1.2rem; font-size: .92rem; }
  th, td { border-bottom: 1px solid #e7d6c3; padding: .55rem .4rem; text-align: left; vertical-align: top; }
  code { font-size: .78rem; word-break: break-all; }
  .note { color: #6b5b4b; font-size: .88rem; margin-top: 1rem; }
</style>
</head>
<body>
  <h1>微光指引 · 下载</h1>
  <p class="warn"><strong>未签名开发包，不是正式发布。</strong>Windows 客户端没有代码签名（SmartScreen 会警告），Android 包是 debug 签名；均未做真机/安装验收。仅供内部试用与联调，分发前请自行评估风险。</p>
  <table>
    <thead><tr><th>产物</th><th>文件</th><th>大小</th><th>SHA256</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p class="note">校验方式：下载后计算 SHA256 与本表一致再使用。服务端只提供文件下载和 API，不在服务器上运行客户端。生成时间：${new Date().toISOString()}</p>
  <p class="note"><a href="/">返回微光指引</a></p>
</body>
</html>
`;
  await client.sendFile({
    instanceId: args.instanceId,
    name: 'index.html',
    contentBase64: Buffer.from(page, 'utf8').toString('base64'),
    targetDir: DOWNLOAD_DIR,
    timeout: 120,
    overwrite: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 4000));
  log('download page dispatched');

  // ---- 6. public verification (first bytes only; full hash was verified on the host)
  for (const a of (publishedFiles ?? publishableSelected)) {
    const url = `${base}/downloads/${encodeURIComponent(a.remote)}`;
    const head = await new Promise((resolve) => {
      const req = http.request(url, { method: 'HEAD', timeout: 20000 }, (res) => {
        res.resume();
        resolve({ status: res.statusCode, length: res.headers['content-length'], type: res.headers['content-type'] });
      });
      req.on('error', (e) => resolve({ status: 0, error: e.code }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
      req.end();
    });
    log(`public HEAD /downloads/${a.remote} -> ${head.status} ${head.length ?? head.error}`);
  }
  const page1 = await new Promise((resolve) => {
    const req = http.get(`${base}/downloads/`, { timeout: 20000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
  log(`public /downloads/ -> ${page1.status} ${page1.status === 200 ? 'page ok' : page1.error ?? ''}`);
  if (page1.status !== 200) throw new Error('download page not reachable');
}

main().catch((error) => {
  console.error(`push-downloads failed: ${error.message}`);
  process.exitCode = 1;
});
