import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createAvatarTraceLog, registerAvatarTraceBridge, sanitizeReason, createXingyunAvatarService } = require('../../apps/desktop/xingyun-avatar.cjs');

const credentials = { appId: '031ce3cd-synthetic-application-id', appSecret: 'synthetic-secret-00000000' };
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const conversationRequest = () => ({ method: 'POST', body: { request_id: 'synthetic-request', config: { raw_audio: false } } });
const body = () => ({ error_code: 0, data: { session_id: 'synthetic-session', resource_pack: {},
  e2e_resp: { ws_url: 'wss://e2emp.xingyun3d.com/ws/session?synthetic', e2e_token: 'synthetic-e2e-token', features: {} } } });

type Handler = (...parameters: unknown[]) => unknown;

async function withTrace(run: (context: { filePath: string; trace: ReturnType<typeof createAvatarTraceLog> }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'nuanban-avatar-trace-'));
  const filePath = join(directory, 'avatar-trace.log');
  try { await run({ filePath, trace: createAvatarTraceLog({ filePath }) }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe('形象失败取证日志', () => {
  it('带时间戳写入受限字段，未知 kind 与超长文本被收窄', async () => {
    await withTrace(async ({ filePath, trace }) => {
      expect(trace.record({ kind: 'stage', message: 'fail kind=load_failed 会话建立', source: 'renderer', line: 42 })).toBe(true);
      trace.record({ kind: 'not-a-kind', message: 'x'.repeat(2000) });
      trace.record({ kind: 'console', message: 'ok', extra: 'discarded', nested: { a: 1 } });
      trace.record(null);
      const lines = (await readFile(filePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatchObject({ kind: 'stage', message: 'fail kind=load_failed 会话建立', source: 'renderer', line: 42 });
      expect(new Date(lines[0].t).toString()).not.toBe('Invalid Date');
      expect(lines[1].kind).toBe('unknown');
      expect(lines[1].message.length).toBeLessThanOrEqual(500);
      expect(lines[2]).toEqual({ t: lines[2].t, kind: 'console', message: 'ok' });
      expect(JSON.stringify(lines)).not.toContain('discarded');
    });
  });

  it('永不记录 token、密钥、租约与会话标识', async () => {
    await withTrace(async ({ filePath, trace }) => {
      trace.record({ kind: 'error', message: 'exchange failed e2e_token=' + 'A'.repeat(40) + ' appSecret=' + credentials.appSecret });
      trace.record({ kind: 'error', message: 'ws wss://e2emp.xingyun3d.com/ws/session?e2e_token=' + 'B'.repeat(32) + '&x=1' });
      trace.record({ kind: 'stage', message: 'session_id=6061-ba2e695bc3e142bfbfc54ac3a6917ec4 request_id=deadbeefdeadbeefdeadbeefdeadbeef' });
      trace.record({ kind: 'console', message: 'signature=' + 'C'.repeat(64) });
      const text = await readFile(filePath, 'utf8');
      expect(text).not.toContain('A'.repeat(40));
      expect(text).not.toContain('B'.repeat(32));
      expect(text).not.toContain('C'.repeat(64));
      expect(text).not.toContain(credentials.appSecret);
      expect(text).not.toContain('6061-ba2e695bc3e142bfbfc54ac3a6917ec4');
      expect(text).toContain('[已隐藏]');
    });
  });

  it('超过大小上限时收缩到上限的一半以内并保留最新记录', async () => {
    await withTrace(async ({ filePath, trace }) => {
      const limit = 2048;
      const bounded = createAvatarTraceLog({ filePath, limit });
      for (let index = 0; index < 60; index++) bounded.record({ kind: 'console', message: 'line-' + index + ' ' + 'x'.repeat(80) });
      const size = (await stat(filePath)).size;
      const text = await readFile(filePath, 'utf8');
      expect(size).toBeLessThanOrEqual(limit);
      expect(text).toContain('line-59');
      expect(text).not.toContain('line-0 ');
      expect(bounded.size()).toBeLessThanOrEqual(limit);
    });
  });

  it('取证 IPC 只接受受信桌宠，且不注册多余通道', async () => {
    const listeners = new Map<string, Handler>();
    const ipcMain = {
      on: (channel: string, handler: Handler) => listeners.set(channel, handler),
      removeListener: (channel: string) => listeners.delete(channel),
    };
    const trusted = {};
    const record = vi.fn();
    const bridge = registerAvatarTraceBridge({ ipcMain, trace: { record }, isTrusted: (event: unknown) => event === trusted });
    expect([...listeners.keys()]).toEqual(['nuanban:avatar:trace']);
    listeners.get('nuanban:avatar:trace')!({}, { kind: 'stage', message: 'untrusted' });
    expect(record).not.toHaveBeenCalled();
    listeners.get('nuanban:avatar:trace')!(trusted, { kind: 'stage', message: 'trusted' });
    expect(record).toHaveBeenCalledWith({ kind: 'stage', message: 'trusted' });
    bridge.dispose();
    expect(listeners.size).toBe(0);
  });
});

describe('失败原因透传到状态文案', () => {
  it('fail 把失败阶段与原因并入状态文案，且绝不包含密钥', async () => {
    const fetchRequest = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => response(options?.method === 'POST' ? body() : { error_code: 0, data: {} }));
    const onState = vi.fn();
    const service = createXingyunAvatarService({ credentials, fetch: fetchRequest, onState });
    const grant = service.begin(true, 'render');
    await service.exchange(grant.lease, conversationRequest());
    const status = await service.fail(grant.lease, 'load_failed', '实时通道：code=1006 socket=closed ' + credentials.appSecret + ' e2e_token=' + 'D'.repeat(32));
    expect(status.phase).toBe('error');
    expect(status.message).toContain('资源或连接加载失败');
    expect(status.message).toContain('失败阶段与原因：实时通道：code=1006 socket=closed');
    expect(status.message).not.toContain(credentials.appSecret);
    expect(status.message).not.toContain('D'.repeat(32));
    expect(JSON.stringify(status)).not.toContain(credentials.appSecret);
    expect(fetchRequest.mock.calls.map(([, call]) => call?.method)).toEqual(['POST', 'DELETE']);
  });

  it('fail 拒绝非字符串原因与时序不符的租约，不改变既有语义', async () => {
    const fetchRequest = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => response(options?.method === 'POST' ? body() : { error_code: 0, data: {} }));
    const service = createXingyunAvatarService({ credentials, fetch: fetchRequest, onState: () => {} });
    const grant = service.begin(true, 'render');
    await service.exchange(grant.lease, conversationRequest());
    const status = await service.fail(grant.lease, 'load_failed', { message: '对象原因必须被忽略' });
    expect(status.message).not.toContain('对象原因');
    expect(status.message).toContain('资源或连接加载失败');
    // 过期租约不改状态、不再发 DELETE、不追加原因。
    const before = service.status();
    expect(await service.fail('stale-lease', 'load_failed', 'stale')).toEqual(before);
    expect(fetchRequest.mock.calls.map(([, call]) => call?.method)).toEqual(['POST', 'DELETE']);
  });

  it('脱敏函数收窄控制字符、URL、长标识与等号赋值的敏感字段', () => {
    expect(sanitizeReason('a\u0000b\nc')).toBe('a b c');
    expect(sanitizeReason('see https://e2emp.xingyun3d.com/ws/session?e2e_token=abc')).not.toContain('https://');
    expect(sanitizeReason('id=' + 'E'.repeat(40))).not.toContain('E'.repeat(40));
    expect(sanitizeReason('x'.repeat(500)).length).toBeLessThanOrEqual(220);
    expect(sanitizeReason(undefined)).toBe('');
    expect(sanitizeReason({ message: 'nope' })).toBe('');
  });
});

describe('现场取证接线（源码守卫）', () => {
  const read = (name: string) => readFileSync(new URL('../../apps/desktop/' + name, import.meta.url), 'utf8');
  const host = read('standalone-host.cjs');
  const avatar = read('xingyun-avatar.cjs');
  const preload = read('pet-preload.cjs');

  it('主进程写 userData/avatar-trace.log，捕获 renderer console 与渲染进程异常', () => {
    expect(host).toContain("avatarTrace = createAvatarTraceLog({ filePath: path.join(options.userDataPath, 'avatar-trace.log') })");
    expect(host).toContain("petWindow.webContents.on('console-message'");
    expect(host).toContain("avatarTraceBridge = registerAvatarTraceBridge({ ipcMain, trace: avatarTrace, isTrusted: event => trusted(event, petWindow, petPath) })");
    expect(host).toContain("avatarTrace?.record({ kind: 'renderer-gone'");
    expect(host).toContain("avatarTrace?.record({ kind: 'stage', message: 'phase='");
    expect(host).toContain('avatarTraceBridge?.dispose();');
    expect(avatar).toContain('const AVATAR_TRACE_LIMIT = 256 * 1024;');
    expect(avatar).toContain("ipcMain.on('nuanban:avatar:trace', listener)");
  });

  it('取证通道不落地密钥，也不暴露任意写盘或任意读写文件', () => {
    expect(avatar).not.toMatch(/writeFileSync\([^)]*appSecret/);
    expect(preload).not.toMatch(/node:fs/);
    expect(avatar).toMatch(/function sanitizeReason\(value, limit = 220\)/);
    const traceBlock = avatar.slice(avatar.indexOf('function createAvatarTraceLog'), avatar.indexOf('function registerAvatarTraceBridge'));
    expect(traceBlock).toContain('sanitizeReason(entry.message, 500)');
    expect(traceBlock).toContain('AVATAR_TRACE_KINDS.includes(entry.kind)');
    expect(traceBlock).not.toContain('entry.extra');
  });

  it('只提交范围内的取证字段：token/密钥关键字不出现在写入路径', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nuanban-avatar-trace-static-'));
    const filePath = join(directory, 'avatar-trace.log');
    try {
      await writeFile(filePath, '');
      const trace = createAvatarTraceLog({ filePath });
      const record = { kind: 'stage', message: 'token=abcdefghijklmnopqrstuvwxyz012345 e2e_token=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' };
      trace.record(record);
      const text = await readFile(filePath, 'utf8');
      expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
      expect(text).not.toContain('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});