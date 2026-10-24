// 把 AnySearch 密钥写入本机 DPAPI 加密存储（%APPDATA%\@nuanban\desktop\nuanban-anysearch-key.bin）。
// 明文只经环境变量或密钥文件读入内存，不写日志、不进仓库、不进安装包。
// 必须用 Electron 运行（safeStorage 只在 Electron 主进程可用）：
//   scripts/set-anysearch-key.ps1 会调用本文件；也可手动：
//   $env:NUANBAN_ANYSEARCH_API_KEY='...'; electron scripts/provision-anysearch-key.cjs
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createAnySearchKeyStore } = require('../apps/desktop/anysearch-settings.cjs');

function readKey() {
  const supplied = process.env.NUANBAN_ANYSEARCH_API_KEY;
  if (typeof supplied === 'string' && supplied.trim()) return supplied.trim();
  const keyFile = process.argv[2];
  if (typeof keyFile === 'string' && keyFile && fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim();
  return undefined;
}

const key = readKey();
if (!key) {
  console.error('未提供 AnySearch 密钥：请设置 NUANBAN_ANYSEARCH_API_KEY，或把密钥文件路径作为第一个参数。');
  process.exit(2);
}

const appData = process.env.APPDATA;
if (typeof appData !== 'string' || !appData) {
  console.error('未找到 %APPDATA%，无法定位桌宠用户目录。');
  process.exit(2);
}
const userDataPath = path.join(appData, '@nuanban', 'desktop');
app.setPath('userData', userDataPath);
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const store = createAnySearchKeyStore({ userDataPath: app.getPath('userData'), safeStorage });
  store.save(key);
  const stored = store.read();
  console.log('已写入加密存储：', path.join(app.getPath('userData'), 'nuanban-anysearch-key.bin'));
  console.log('加密可用：', safeStorage.isEncryptionAvailable(), '| 读回校验：', stored === key, '| 密钥长度：', stored?.length);
  app.quit();
}).catch(error => { console.error('写入失败：', error.message); app.exit(1); });