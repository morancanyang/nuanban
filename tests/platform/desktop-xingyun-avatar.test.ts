import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { GATEWAY, PET_AVATAR_CSP, defaultPet, signSession, createXingyunAvatarService, registerXingyunAvatarBridge } = require('../../apps/desktop/xingyun-avatar.cjs');
const { loadXingyunCredentials } = require('../../apps/desktop/xingyun-credentials.cjs');
const credentials = { appId: '031ce3cd-synthetic-application-id', appSecret: 'synthetic-secret-00000000' };
const sessionBody = () => ({ error_code: 0, data: { session_id: 'synthetic-session', resource_pack: {} } });
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const request = { method: 'POST', body: { request_id: 'synthetic-request', config: { raw_audio: false } } };

function fixture() {
  const fetchRequest = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => response(options?.method === 'POST' ? sessionBody() : { error_code: 0, data: {} }));
  const onState = vi.fn();
  return { fetchRequest, onState, service: createXingyunAvatarService({ credentials, fetch: fetchRequest, onState }) };
}

describe('星云桌宠主进程鉴权和会话边界', () => {
  it('产品默认形象为新花环水獭，不把截图预览伪称离线 3D，也不默认联网', () => {
    expect(defaultPet).toMatchObject({ id: 'xingyun-floral-otter', name: '花环水獭', application: { editorId: '188337', appIdPrefix: '031ce3cd' }, requiresNetworkFor3D: true, autoConnect: false });
    expect(fixture().service.status()).toMatchObject({ defaultAvatarId: 'xingyun-floral-otter', defaultAvatarName: '花环水獭', configurationMismatch: false });
    const bytes = readFileSync(new URL('../../apps/desktop/' + defaultPet.offlinePreview, import.meta.url));
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([400, 560]);
    expect(bytes[25]).toBe(6);
    const html = readFileSync(new URL('../../apps/desktop/pet.html', import.meta.url), 'utf8');
    expect(html).toContain('默认桌宠：花环水獭（本地静态预览）');
    expect(html).toContain('src="' + defaultPet.offlinePreview + '"');
    expect(html).toContain('data-avatar-id="' + defaultPet.id + '"');
    expect(html).not.toContain('xingyun-monkey-preview.png');
    expect(html).toMatch(/id="fallback-cat-pet"[^>]+hidden/);
  });
  it('默认不连接、不重连、不启麦，状态不泄露密钥', () => {
    const { service, fetchRequest } = fixture();
    expect(service.status()).toMatchObject({ phase: 'idle', autoReconnect: false, microphoneActive: false });
    expect(JSON.stringify(service.status())).not.toContain(credentials.appSecret);
    expect(fetchRequest).not.toHaveBeenCalled();
    expect(() => service.begin(false)).toThrow('本人确认');
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it('未配置或已经退出时不允许创建会话', async () => {
    const service = createXingyunAvatarService({});
    expect(service.status().phase).toBe('unconfigured');
    expect(() => service.begin(true)).toThrow();
    const configured = fixture().service;
    await configured.dispose();
    expect(() => configured.begin(true)).toThrow();
  });

  it.each(['other-application-id', '031ce3ce-other-application-id'])('旧应用或不匹配的应用 %s 不能误连旧形象', async appId => {
    const fetchRequest = vi.fn<typeof fetch>();
    const service = createXingyunAvatarService({ credentials: { ...credentials, appId }, fetch: fetchRequest });
    expect(service.status()).toMatchObject({ configured: false, configurationMismatch: true, phase: 'unconfigured', defaultAvatarId: 'xingyun-floral-otter' });
    expect(service.status().message).toContain('188337');
    expect(() => service.begin(true)).toThrow('188337');
    expect((await service.stop()).stopped).toBe(true);
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it('与官方递归排序、Unicode 转义和 MD5 规范一致', () => {
    const data = { zoo: '小猴 😀 hi', alpha: [{ zebra: 2, apple: 'a b' }] };
    const canonical = JSON.stringify({ alpha: [{ apple: 'a b', zebra: 2 }], zoo: '小猴 😀 hi' })
      .replace(/[^\u0000-\u007E]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')).replace(/ /g, '');
    const signed = signSession(credentials, 'POST', data, 12345);
    const expected = createHash('md5').update('/user/v1/ttsa_v2/sessionpost' + canonical + credentials.appSecret + 12345).digest('hex');
    expect(signed.headers['X-TOKEN']).toBe(expected);
    expect(signed.headers['X-TIMESTAMP']).toBe('12345');
    expect(JSON.parse(signed.body)).toEqual(data);
    expect(signed.body.indexOf('alpha')).toBeLessThan(signed.body.indexOf('zoo'));
  });

  it('按 Unicode 码点而非 UTF-16 代码单元排序非 BMP 键', () => {
    const signed = signSession(credentials, 'POST', { '\u{10000}': 1, '\uE000': 2 }, 100);
    expect(Object.keys(JSON.parse(signed.body))).toEqual(['\uE000', '\u{10000}']);
  });

  it('只允许固定官方 HTTPS 接口，重建安全请求，不转发页面附加字段', async () => {
    const { service, fetchRequest } = fixture();
    const grant = service.begin(true);
    expect(JSON.stringify(grant)).not.toContain(credentials.appSecret);
    await service.exchange(grant.lease, { ...request, url: 'https://example.invalid', body: { ...request.body, appSecret: 'not-forwarded', image: 'private-screen', brain_config: { query: 'private-question' }, asr_id: 99,
      tag: 'private-tag', gateway_type: 'private-gateway', session_speak_req_id: 99,
      features: { auto_send_asr_to_llm: true, speech_frontend: { enabled: true } },
      config: { raw_audio: true, framedata_proto_version: 99, walk_version: 99, image: 'private-config-image' } } });
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    const [url, options] = fetchRequest.mock.calls[0];
    expect(url).toBe(GATEWAY);
    expect(options?.redirect).toBe('error');
    const sent = JSON.parse(String(options?.body));
    expect(sent).toEqual({ request_id: 'synthetic-request', gateway_type: 'default', session_speak_req_id: 1,
      features: { auto_send_asr_to_llm: false, speech_frontend: { enabled: false } }, config: { framedata_proto_version: 2, walk_version: 3, raw_audio: true } });
    expect(JSON.stringify(options)).not.toContain(credentials.appSecret);
    expect(JSON.stringify(options)).not.toContain('private-');
    expect(service.ready(grant.lease)).toBe(true);
    await service.stop();
  });

  it.each([true, false])('沿用 SDK 检测的输出音频格式 raw_audio=%s，不添加自定义标签', async rawAudio => {
    const { service, fetchRequest } = fixture();
    const grant = service.begin(true);
    await service.exchange(grant.lease, { ...request, body: { ...request.body, config: { raw_audio: rawAudio } } });
    const sent = JSON.parse(String(fetchRequest.mock.calls[0][1]?.body));
    expect(sent.config).toEqual({ framedata_proto_version: 2, walk_version: 3, raw_audio: rawAudio });
    expect(sent).not.toHaveProperty('tag');
    expect(service.status()).toMatchObject({ microphoneActive: false, autoReconnect: false });
    await service.stop();
  });

  it.each([
    { config: undefined }, { config: null }, { config: {} },
    ...[null, 0, 1, 'true', 'false', {}, []].map(rawAudio => ({ config: { raw_audio: rawAudio } })),
  ])('缺失或非布尔音频格式在联网前拒绝（%j）', async ({ config }) => {
    const { service, fetchRequest } = fixture();
    const grant = service.begin(true);
    await expect(service.exchange(grant.lease, { ...request, body: { ...request.body, config } })).rejects.toThrow('音频格式参数无效');
    expect(fetchRequest).not.toHaveBeenCalled();
    expect(await service.stop()).toMatchObject({ stopped: true, phase: 'idle' });
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it('一次本人授权只发一次 POST，拒绝 SDK 重试及平行创建', async () => {
    const { service, fetchRequest } = fixture();
    const grant = service.begin(true);
    await service.exchange(grant.lease, request);
    expect(() => service.begin(true)).toThrow('第二个');
    await expect(service.exchange(grant.lease, request)).rejects.toThrow('禁止自动重连');
    await expect(service.exchange('invalid', request)).rejects.toThrow('授权已失效');
    await expect(service.exchange(grant.lease, { method: 'PUT' })).rejects.toThrow();
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it('停止使用主进程持有的会话标识，幂等释放后才可手动重试', async () => {
    const { service, fetchRequest } = fixture();
    const grant = service.begin(true);
    await service.exchange(grant.lease, request);
    const result = await service.stop();
    expect(result).toMatchObject({ stopped: true, phase: 'idle' });
    expect(JSON.parse(String(fetchRequest.mock.calls[1][1]?.body))).toMatchObject({ session_id: 'synthetic-session', request_id: 'synthetic-request' });
    await service.stop();
    expect(fetchRequest).toHaveBeenCalledTimes(2);
    expect(service.begin(true).lease).not.toBe(grant.lease);
    await service.stop();
  });

  it('取消尚未返回的创建请求，也等待会话标识后 DELETE，不产生孤儿会话', async () => {
    const { service, fetchRequest } = fixture();
    let finish!: (reply: Response) => void;
    fetchRequest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const grant = service.begin(true);
    const starting = service.exchange(grant.lease, request);
    const stopping = service.stop();
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    finish(response(sessionBody()));
    await expect(starting).rejects.toThrow();
    expect(await stopping).toMatchObject({ stopped: true });
    expect(service.status().phase).toBe('idle');
    expect(fetchRequest.mock.calls.map(([, options]) => options?.method)).toEqual(['POST', 'DELETE']);
    expect(JSON.parse(String(fetchRequest.mock.calls[1][1]?.body)).session_id).toBe('synthetic-session');
  });

  it('超时按 request_id 清理，不自动再次 POST，错误不复述平台回显', async () => {
    const { service, fetchRequest } = fixture();
    fetchRequest.mockRejectedValueOnce(new Error('network detail ' + credentials.appSecret));
    const grant = service.begin(true);
    await expect(service.exchange(grant.lease, request)).rejects.toThrow('连接失败或超时');
    expect(service.status().phase).toBe('error');
    expect(JSON.stringify(service.status())).not.toContain(credentials.appSecret);
    expect(fetchRequest.mock.calls.map(([, options]) => options?.method)).toEqual(['POST', 'DELETE']);
    expect(JSON.parse(String(fetchRequest.mock.calls[1][1]?.body))).toEqual({ request_id: 'synthetic-request', stop_reason: 'load_failed' });
  });

  it('无法确认云端停止时如实阻止新会话，允许本人重试 DELETE', async () => {
    const { service, fetchRequest } = fixture();
    const grant = service.begin(true);
    await service.exchange(grant.lease, request);
    fetchRequest.mockRejectedValueOnce(new Error('offline'));
    expect(await service.stop()).toMatchObject({ stopped: false, phase: 'cleanup_failed' });
    expect(() => service.begin(true)).toThrow('第二个');
    expect(await service.stop()).toMatchObject({ stopped: true, phase: 'idle' });
    expect(fetchRequest.mock.calls.map(([, options]) => options?.method)).toEqual(['POST', 'DELETE', 'DELETE']);
  });

  it('平台参数错误保留错误码和说明，但隐藏密钥及请求标识', async () => {
    const { service, fetchRequest } = fixture();
    fetchRequest.mockResolvedValueOnce(response({ error_code: 1008, error_reason: '角色、音色参数不完整 ' + credentials.appSecret + ' request_id: ' + 'a'.repeat(32) }));
    const grant = service.begin(true);
    await expect(service.exchange(grant.lease, request)).rejects.toThrow('1008');
    expect(service.status().message).toContain('角色、音色参数不完整');
    expect(service.status().message).not.toContain(credentials.appSecret);
    expect(service.status().message).not.toContain('a'.repeat(32));
    expect(fetchRequest.mock.calls.map(([, options]) => options?.method)).toEqual(['POST', 'DELETE']);
  });

  it('退出与失败清理不会把旧的 ready 误判为正在显示', async () => {
    const { service } = fixture();
    const grant = service.begin(true);
    expect(service.ready(grant.lease)).toBe(false);
    await service.exchange(grant.lease, request);
    await service.fail(grant.lease, 'timeout');
    expect(service.ready(grant.lease)).toBe(false);
    expect(service.status()).toMatchObject({ phase: 'error', microphoneActive: false });
    await service.dispose();
    expect(() => service.begin(true)).toThrow();
  });

  it('会话 IPC 只允许真实桌宠，主客户端和子框架均不能调用', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), removeHandler: (channel: string) => handlers.delete(channel) };
    const trusted = {};
    const { service, fetchRequest } = fixture();
    const bridge = registerXingyunAvatarBridge({ ipcMain, service, isTrusted: (event: unknown) => event === trusted });
    for (const handler of handlers.values()) expect(() => handler({}, true)).toThrow('不可信');
    expect(handlers.get('nuanban:avatar:status')!(trusted)).toMatchObject({ phase: 'idle' });
    bridge.dispose();
    expect(handlers.size).toBe(0);
    expect(fetchRequest).not.toHaveBeenCalled();
  });

  it('CSP 只允许星云及其指定 OSS 资源，不放开任意 HTTPS、脚本或麦克风', () => {
    expect(PET_AVATAR_CSP).toContain('wss://*.xingyun3d.com');
    expect(PET_AVATAR_CSP).not.toMatch(/unsafe-eval|connect-src\s+\*|https:;|wss:;/);
    expect(PET_AVATAR_CSP).not.toContain('*.aliyuncs.com');
    for (const directive of ['img-src', 'connect-src', 'media-src']) {
      const policy = PET_AVATAR_CSP.split(';').find((value: string) => value.trim().startsWith(directive + ' '));
      expect(policy).toContain('https://public-xmov.oss-cn-hangzhou.aliyuncs.com');
    }
    const html = readFileSync(new URL('../../apps/desktop/pet.html', import.meta.url), 'utf8');
    expect(html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1]).toBe(PET_AVATAR_CSP);
    const preload = readFileSync(new URL('../../apps/desktop/preload.cjs', import.meta.url), 'utf8');
    expect(preload).not.toContain('nuanbanAvatar');
    const renderer = readFileSync(new URL('../../apps/desktop/xingyun-renderer.js', import.meta.url), 'utf8');
    expect(renderer).toContain('audio: { inputEnabled: conversationMode }');
    expect(renderer).toContain('currentInstance.setVolume(conversationMode ? 1 : 0)');
    expect(renderer).toContain('maxAttempts: 0');
    expect(renderer).not.toMatch(/\.ask\(|getUserMedia\(/);
    expect(renderer).toMatch(/async function startListening\(token, target\) \{\n  if \(!isCurrent\(token, target\) \|\| mode !== 'conversation'\) return;/);
  });
});

describe('星云凭证仅从本机加密配置读取', () => {
  it('不存在时不自动申请应用、连接或写入默认明文', async () => {
    expect(await loadXingyunCredentials({ configurationPath: join(tmpdir(), 'missing-xingyun-' + Date.now()) })).toBeUndefined();
  });
  it('校验加密格式并由固定解密器读取，拒绝明文配置', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nuanban-xingyun-'));
    const configurationPath = join(directory, 'avatar.json');
    try {
      const decrypt = vi.fn(async () => credentials.appSecret);
      await writeFile(configurationPath, JSON.stringify({ version: 1, appId: credentials.appId, appSecret: credentials.appSecret }));
      await expect(loadXingyunCredentials({ configurationPath, decrypt })).rejects.toThrow('配置无效');
      expect(decrypt).not.toHaveBeenCalled();
      await writeFile(configurationPath, JSON.stringify({ version: 1, appId: credentials.appId, credentialFormat: 'windows-dpapi-v1', encryptedSecret: 'A'.repeat(32) }));
      expect(await loadXingyunCredentials({ configurationPath, decrypt })).toEqual(credentials);
      expect(decrypt).toHaveBeenCalledWith('A'.repeat(32));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
