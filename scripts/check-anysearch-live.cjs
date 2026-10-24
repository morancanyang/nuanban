// 一次真实 AnySearch 调用核对：读取本机 DPAPI 存储中的密钥，经桌宠同一组合链路发起检索。
// 不打印密钥、不写入任何文件；必须用 Electron 运行（safeStorage 只在 Electron 主进程可用）：
//   apps\desktop\node_modules\electron\dist\electron.exe scripts/check-anysearch-live.cjs
const { app, safeStorage } = require('electron');
const path = require('node:path');
const { createAnySearchKeyStore } = require('../apps/desktop/anysearch-settings.cjs');
const { createAnySearchClient } = require('../apps/desktop/anysearch-client.cjs');
const { createPetSearchClient } = require('../apps/desktop/pet-search-client.cjs');

const appData = process.env.APPDATA;
if (typeof appData !== 'string' || !appData) { console.error('未找到 %APPDATA%。'); process.exit(2); }
app.setPath('userData', path.join(appData, '@nuanban', 'desktop'));
app.disableHardwareAcceleration();

const query = process.argv[2] && !process.argv[2].endsWith('.cjs') ? process.argv[2] : '今天北京天气';

app.whenReady().then(async () => {
  const store = createAnySearchKeyStore({ userDataPath: app.getPath('userData'), safeStorage });
  let modelCalls = 0;
  const model = { status: () => ({ provider: 'ConfiguredModel', configured: true }),
    search: async () => { modelCalls += 1; return { kind: 'model-answer', webSearch: false, answer: '模型回答', results: [] }; } };
  const client = createPetSearchClient({ anySearch: createAnySearchClient({ getApiKey: () => store.read() }), model });
  const status = client.status();
  console.log('状态：', JSON.stringify(status));
  if (status.webSearch !== true) { console.error('未读到 AnySearch 密钥：请先运行 scripts/set-anysearch-key.ps1。'); app.exit(3); return; }
  const results = await client.search(query);
  console.log('查询：', query);
  console.log('结果条数：', results.length, '| 模型调用次数：', modelCalls);
  console.log('首条：', JSON.stringify({ title: results[0]?.title?.slice(0, 60), source: results[0]?.source, hasSnippet: Boolean(results[0]?.snippet) }));
  console.log('全部 HTTPS：', results.every(item => item.url.startsWith('https://')), '| 去重后条数：', new Set(results.map(item => item.url)).size);
  app.quit();
}).catch(error => { console.error('真实检索失败：', error.code ?? error.message); app.exit(1); });