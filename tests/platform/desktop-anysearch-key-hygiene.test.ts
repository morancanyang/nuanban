import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 任何真实密钥都不得进入仓库：这里扫描本次改动相关的目录，确保没有 as_sk_ 形式的密钥被写入
// 源码、脚本、测试或文档（测试自身用拼接方式构造模式，避免误报自己）。
const keyPattern = new RegExp(`${'as'}_${'sk'}_[A-Za-z0-9]{16,}`, 'u');
const roots = ['apps/desktop', 'apps/web/src', 'scripts', 'tests', 'docs/implementation'];
const textExtensions = new Set(['.cjs', '.mjs', '.js', '.ts', '.tsx', '.json', '.md', '.ps1', '.html', '.css', '.kt']);

function collect(directory: string, found: string[] = []) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const details = statSync(full);
    if (details.isDirectory()) { collect(full, found); continue; }
    if (textExtensions.has(extname(entry))) found.push(full);
  }
  return found;
}

describe('AnySearch 密钥不入仓库', () => {
  it('源码、脚本、测试与文档中不存在真实密钥字面量', () => {
    const offenders = roots.flatMap(root => collect(root)).filter(file => keyPattern.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('写入脚本只从环境变量或显式密钥文件读取，不内置默认密钥', () => {
    const provision = readFileSync(new URL('../../scripts/provision-anysearch-key.cjs', import.meta.url), 'utf8');
    expect(provision).toContain('NUANBAN_ANYSEARCH_API_KEY');
    expect(provision).not.toMatch(/=\s*['"][A-Za-z0-9_-]{20,}['"]/u);
    const settings = readFileSync(new URL('../../apps/desktop/anysearch-settings.cjs', import.meta.url), 'utf8');
    expect(settings).not.toMatch(keyPattern);
  });

  it('桌宠搜索链路只经加密存储读取密钥，不把密钥返回页面', () => {
    const host = readFileSync(new URL('../../apps/desktop/standalone-host.cjs', import.meta.url), 'utf8');
    expect(host).toContain('anysearchKeyStore?.read()');
    const bridge = readFileSync(new URL('../../apps/desktop/pet-search-bridge.cjs', import.meta.url), 'utf8');
    expect(bridge).not.toContain('apiKey');
    expect(bridge).toContain('webSearch: current.webSearch === true');
    const client = readFileSync(new URL('../../apps/desktop/anysearch-client.cjs', import.meta.url), 'utf8');
    expect(client).toContain("status: () => ({ provider: 'AnySearch', configured: typeof fetchSearch === 'function' && Boolean(apiKey()) })");
  });
});