import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { GATEWAY, createAvatarProxyFallback, createXingyunAvatarService, parseProxySpec, probeTcpPort } = require('../../apps/desktop/xingyun-avatar.cjs');

// task-17：现场系统代理 127.0.0.1:6518 已失效（端口无监听）→ Chromium 全走死代理 → SDK 报
// code=10002 socket连接失败。这里全部用假 session/假探针，不碰真实网络、不改系统设置。

const credentials = { appId: '031ce3cd-synthetic-application-id', appSecret: 'synthetic-secret-00000000' };
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const sessionBody = () => ({ error_code: 0, data: { session_id: 'synthetic-session', resource_pack: {} } });
const postRequest = () => ({ method: 'POST', body: { request_id: 'synthetic-request', config: { raw_audio: false } } });

function fakeSession(resolved = 'PROXY 127.0.0.1:6518;DIRECT') {
  return { resolveProxy: vi.fn(async (_url: string) => resolved), setProxy: vi.fn(async (_settings: unknown) => undefined), resolved, applied: () => [] };
}

describe('系统代理规格解析与端口探测', () => {
  it('只在真的配置了代理时才返回代理，DIRECT 与畸形串一律不切换', () => {
    expect(parseProxySpec('PROXY 127.0.0.1:6518;DIRECT')).toMatchObject({ kind: 'PROXY', host: '127.0.0.1', port: 6518, label: '127.0.0.1:6518' });
    expect(parseProxySpec('HTTPS proxy.example.com:8080')).toMatchObject({ kind: 'HTTPS', host: 'proxy.example.com', port: 8080 });
    expect(parseProxySpec('SOCKS5 10.0.0.9:1080')).toMatchObject({ kind: 'SOCKS5', port: 1080 });
    expect(parseProxySpec('DIRECT')).toBeNull();
    expect(parseProxySpec('DIRECT;DIRECT')).toBeNull();
    expect(parseProxySpec('')).toBeNull();
    expect(parseProxySpec(undefined)).toBeNull();
    expect(parseProxySpec('PROXY 127.0.0.1')).toBeNull();
    expect(parseProxySpec('PROXY 127.0.0.1:0')).toBeNull();
    expect(parseProxySpec('PROXY 127.0.0.1:99999')).toBeNull();
    expect(parseProxySpec('代理 127.0.0.1:6518')).toBeNull();
  });

  it('端口探测把拒绝/超时/异常都视为不可达，只有连上才算可用', async () => {
    expect(await probeTcpPort('127.0.0.1', 6518, { timeoutMs: 200, connect: async () => 'open' })).toBe('open');
    expect(await probeTcpPort('127.0.0.1', 6518, { timeoutMs: 200, connect: async () => 'refused' })).toBe('refused');
    expect(await probeTcpPort('127.0.0.1', 6518, { timeoutMs: 200, connect: async () => 'timeout' })).toBe('timeout');
    expect(await probeTcpPort('127.0.0.1', 6518, { timeoutMs: 200, connect: async () => { throw new Error('boom'); } })).toBe('error');
    expect(await probeTcpPort('127.0.0.1', 6518, { timeoutMs: 200, connect: async () => 42 as unknown as string })).toBe('error');
  });
});

describe('代理回退判定：只在“配置了但连不上”时切直连', () => {
  it('代理可达 → 保持 system，不做任何切换', async () => {
    const session = fakeSession();
    const proxy = createAvatarProxyFallback({ resolveProxy: session.resolveProxy, probe: async () => 'open', applyDirect: () => session.setProxy({ mode: 'direct' }),
      restoreSystem: () => session.setProxy({ mode: 'system' }) });
    expect(await proxy.prepare()).toEqual({ mode: 'system' });
    expect(session.setProxy).not.toHaveBeenCalled();
    expect(proxy.direct()).toBe(false);
  });

  it('没配代理（DIRECT）→ 连探针都不调用，行为与今天一致', async () => {
    const session = fakeSession('DIRECT');
    const probe = vi.fn(async () => 'refused');
    const proxy = createAvatarProxyFallback({ resolveProxy: session.resolveProxy, probe, applyDirect: () => session.setProxy({ mode: 'direct' }) });
    expect(await proxy.prepare()).toEqual({ mode: 'system' });
    expect(probe).not.toHaveBeenCalled();
    expect(session.setProxy).not.toHaveBeenCalled();
  });

  it('代理配置了但端口被拒 → 只对承载形象的 session 切 direct，并给出可执行提示', async () => {
    const session = fakeSession();
    const applied: unknown[] = [];
    const proxy = createAvatarProxyFallback({ resolveProxy: session.resolveProxy, probe: async () => 'refused',
      applyDirect: async () => { applied.push({ mode: 'direct' }); }, restoreSystem: async () => { applied.push({ mode: 'system' }); } });
    const decision = await proxy.prepare();
    expect(decision.mode).toBe('direct');
    expect(decision.notice).toContain('检测到系统代理 127.0.0.1:6518 无法连接');
    expect(decision.notice).toContain('已自动改为直连尝试');
    expect(applied).toEqual([{ mode: 'direct' }]);
    expect(proxy.direct()).toBe(true);
    expect(await proxy.restore()).toBe(true);
    expect(applied).toEqual([{ mode: 'direct' }, { mode: 'system' }]);
    expect(await proxy.restore()).toBe(false);
    expect(applied).toHaveLength(2);
  });

  it('resolveProxy 抛错、切换失败、没有注入端口时都保持 system（fail closed，不改动）', async () => {
    const fallback = createAvatarProxyFallback({ resolveProxy: async () => { throw new Error('no session'); }, probe: async () => 'refused' });
    expect(await fallback.prepare()).toEqual({ mode: 'system' });
    const failing = createAvatarProxyFallback({ resolveProxy: async () => 'PROXY 127.0.0.1:6518', probe: async () => 'refused',
      applyDirect: async () => { throw new Error('setProxy failed'); } });
    expect(await failing.prepare()).toEqual({ mode: 'system' });
    expect(failing.direct()).toBe(false);
    expect(await createAvatarProxyFallback().prepare()).toEqual({ mode: 'system' });
  });
});

describe('会话失败文案与恢复：沿用既有 fail/trace 链路', () => {
  function serviceFixture(options: { resolved?: string; probe?: string; postFails?: boolean } = {}) {
    const session = fakeSession(options.resolved);
    const fetchRequest = vi.fn<typeof fetch>().mockImplementation(async (_url, request) => {
      if (request?.method === 'POST' && options.postFails === true) throw new Error('socket hang up');
      return response(request?.method === 'POST' ? sessionBody() : { error_code: 0, data: {} });
    });
    const onState = vi.fn();
    const events: { event: string; detail: Record<string, unknown> }[] = [];
    const proxy = createAvatarProxyFallback({ resolveProxy: session.resolveProxy, probe: async () => options.probe ?? 'refused',
      applyDirect: () => session.setProxy({ mode: 'direct' }), restoreSystem: () => session.setProxy({ mode: 'system' }),
      trace: (event: string, detail: Record<string, unknown>) => events.push({ event, detail: detail ?? {} }) });
    const service = createXingyunAvatarService({ credentials, fetch: fetchRequest, onState, proxy });
    return { service, session, fetchRequest, events };
  }

  it('代理被拒时自动直连；实时通道仍失败 → 文案带提示并恢复 system，且不新增 POST/DELETE 次数', async () => {
    const { service, session, fetchRequest, events } = serviceFixture();
    const grant = service.begin(true, 'render');
    await service.exchange(grant.lease, postRequest());
    expect(session.setProxy.mock.calls.map(([settings]) => settings)).toEqual([{ mode: 'direct' }]);
    expect(events.some(entry => entry.event === 'avatar_proxy' && entry.detail.state === 'unreachable_direct')).toBe(true);
    // 渲染端随后报实时通道失败（现场 code=10002）：文案要说明代理原因并恢复系统代理。
    const status = await service.fail(grant.lease, 'load_failed', '实时通道：code=10002 socket连接失败');
    expect(status.message).toContain('失败阶段与原因：实时通道：code=10002 socket连接失败');
    expect(status.message).toContain('检测到系统代理 127.0.0.1:6518 无法连接');
    expect(status.message).toContain('直连仍失败，已恢复系统代理设置');
    expect(session.setProxy.mock.calls.map(([settings]) => settings)).toEqual([{ mode: 'direct' }, { mode: 'system' }]);
    expect(fetchRequest.mock.calls.map(([, request]) => request?.method)).toEqual(['POST', 'DELETE']);
  });

  it('切直连后 POST 仍失败 → 如实报错、恢复 system，且一次会话只发一次 POST', async () => {
    const { service, session, fetchRequest } = serviceFixture({ postFails: true });
    const grant = service.begin(true, 'render');
    await expect(service.exchange(grant.lease, postRequest())).rejects.toThrow('检测到系统代理 127.0.0.1:6518 无法连接');
    // 失败即停止：会话已关闭，旧租约不再能创建第二个会话（一次会话一次 POST，不自动重连）。
    await expect(service.exchange(grant.lease, postRequest())).rejects.toThrow('形象会话授权已失效');
    expect(service.status().phase).toBe('error');
    expect(service.status().message).toContain('直连仍失败，已恢复系统代理设置');
    expect(session.setProxy.mock.calls.map(([settings]) => settings)).toEqual([{ mode: 'direct' }, { mode: 'system' }]);
    expect(fetchRequest.mock.calls.map(([, request]) => request?.method)).toEqual(['POST', 'DELETE']);
  });

  it('代理可达或没配代理时行为与今天完全一致：不调用 setProxy、文案不带代理提示', async () => {
    for (const options of [{ probe: 'open' }, { resolved: 'DIRECT', probe: 'refused' }]) {
      const { service, session } = serviceFixture(options);
      const grant = service.begin(true, 'render');
      await service.exchange(grant.lease, postRequest());
      expect(service.ready(grant.lease)).toBe(true);
      expect(session.setProxy).not.toHaveBeenCalled();
      const status = await service.fail(grant.lease, 'load_failed', '实时通道：socket=closed');
      expect(status.message).not.toContain('检测到系统代理');
      expect(await service.stop()).toMatchObject({ stopped: true });
    }
  });

  it('直连期间正常停止也会恢复 system（不影响其他网络功能）', async () => {
    const { service, session } = serviceFixture();
    const grant = service.begin(true, 'render');
    await service.exchange(grant.lease, postRequest());
    expect(session.setProxy.mock.calls.map(([settings]) => settings)).toEqual([{ mode: 'direct' }]);
    expect(await service.stop()).toMatchObject({ stopped: true });
    expect(session.setProxy.mock.calls.map(([settings]) => settings)).toEqual([{ mode: 'direct' }, { mode: 'system' }]);
    expect(session.setProxy).toHaveBeenCalledTimes(2);
  });
});

describe('静态边界：不改用户系统设置，不放宽会话语义', () => {
  const avatar = readFileSync(new URL('../../apps/desktop/xingyun-avatar.cjs', import.meta.url), 'utf8');
  const host = readFileSync(new URL('../../apps/desktop/standalone-host.cjs', import.meta.url), 'utf8');

  it('没有任何注册表/系统代理写入，只有 Electron session.setProxy', () => {
    for (const text of [avatar, host]) {
      expect(text).not.toMatch(/reg\.exe|reg add|Registry\.SetValue|HKCU|HKEY_CURRENT_USER|ProxyEnable|ProxyServer/);
      expect(text).not.toMatch(/netsh\s+winhttp|Set-ItemProperty.*Internet Settings/);
    }
    expect(avatar).toContain("await applyDirect();");
    expect(host).toContain("applyDirect: () => avatarSession().setProxy({ mode: 'direct' })");
    expect(host).toContain("restoreSystem: () => avatarSession().setProxy({ mode: 'system' })");
    // 只切换 direct/system 两种模式，不注入自定义 proxyRules 或 PAC。
    expect(host).not.toMatch(/setProxy\(\{[^}]*proxyRules/);
    expect(host).not.toMatch(/setProxy\(\{[^}]*pacScript/);
  });

  it('探测与切换都是本地只读行为：不抓屏、不写盘、不带凭证', () => {
    expect(avatar).toContain("require('node:net')");
    expect(avatar).not.toMatch(/desktopCapturer|capturePage|toPNG|sanitizedPng/);
    expect(avatar).not.toContain('appSecret}');
    const fallbackBlock = avatar.slice(avatar.indexOf('function createAvatarProxyFallback'), avatar.indexOf('function createXingyunAvatarService'));
    expect(fallbackBlock).not.toContain('appSecret');
    expect(fallbackBlock).not.toContain('signSession');
    expect(fallbackBlock).not.toContain('GATEWAY + ');
    expect(GATEWAY).toContain('nebula-agent.xingyun3d.com');
  });

  it('宿主把回退端口接进形象会话，且仍是一次会话一次 POST', () => {
    expect(host).toContain('createAvatarProxyFallback({');
    expect(host).toContain('proxy: avatarProxy,');
    expect(avatar).toContain('禁止自动重连或重复创建星云会话');
    expect(avatar).toContain('attempt.postStarted');
  });
});