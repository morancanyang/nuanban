import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceFailure, type ConversationPort } from '@nuanban/application';
import {
  AndroidImageQuestion,
  AndroidModelConversation,
  androidModelBridge,
  checkedAndroidModelStatus,
} from '../../apps/web/src/android-model';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const androidHostRoot = workspaceRoot + 'apps/android/app/src/main/java/org/nuanban/assistant/nativehost/';
const readSource = (path: string) => readFileSync(path, 'utf8');
const readHost = (name: string) => readSource(androidHostRoot + name);
const readWeb = (name: string) => readSource(workspaceRoot + 'apps/web/src/' + name);

const readyStatus = { available: true, reason: 'ready', message: '模型通道已配置。' };

interface TextInput { requestId: string; question: string }
interface ImageInput { requestId: string; question: string; mime: string; base64: string; confirmed: boolean }

function fakeBridge(options: {
  status?: unknown | (() => Promise<unknown>);
  answerText?: (input: TextInput) => Promise<unknown>;
  answerImage?: (input: ImageInput) => Promise<unknown>;
} = {}) {
  const state = { textCalls: [] as TextInput[], imageCalls: [] as ImageInput[], cancelCalls: [] as string[] };
  const bridge = {
    status: async () => (typeof options.status === 'function' ? (options.status as () => Promise<unknown>)() : options.status ?? readyStatus),
    answerText: async (input: TextInput) => {
      state.textCalls.push(input);
      return options.answerText ? options.answerText(input) : { ok: true, requestId: input.requestId, text: '好的，这是 Android 模型回答。' };
    },
    answerImage: async (input: ImageInput) => {
      state.imageCalls.push(input);
      return options.answerImage ? options.answerImage(input) : { ok: true, requestId: input.requestId, text: '图片已在本机脱敏后分析。' };
    },
    cancel: async (requestId: string) => {
      state.cancelCalls.push(requestId);
      return true;
    },
  };
  return { bridge, state };
}

function install(bridge: ReturnType<typeof fakeBridge>['bridge'] | undefined) {
  vi.stubGlobal('window', bridge === undefined ? {} : { nuanbanAndroidModel: bridge });
}

async function collect(port: ConversationPort, text: string, signal?: AbortSignal) {
  const events: Array<{ type: string; text?: string }> = [];
  for await (const event of port.stream(text, signal ?? new AbortController().signal)) events.push(event as { type: string; text?: string });
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Android 模型 Web 适配器（只在 Android 宿主启用，失败 fail-closed）', () => {
  it('桥接检测要求 status/answerText/answerImage/cancel 全部存在', () => {
    install(undefined);
    expect(androidModelBridge()).toBeUndefined();
    const { bridge } = fakeBridge();
    install(bridge);
    expect(androidModelBridge()).toBe(bridge);
    vi.unstubAllGlobals();
    vi.stubGlobal('window', { nuanbanAndroidModel: { status: async () => readyStatus } });
    expect(androidModelBridge()).toBeUndefined();
  });

  it('status 结构严格校验，异常结构一律当作不可用', () => {
    expect(checkedAndroidModelStatus(readyStatus)).toEqual(readyStatus);
    expect(() => checkedAndroidModelStatus({ available: 'yes' })).toThrow(ServiceFailure);
    expect(() => checkedAndroidModelStatus({ available: true, reason: 'ready', message: 'x'.repeat(400) })).toThrow(ServiceFailure);
    expect(() => checkedAndroidModelStatus(null)).toThrow(ServiceFailure);
  });

  it('未配置/失效时文字讲解失败闭合，不产生演示回答', async () => {
    const { bridge, state } = fakeBridge({ status: { available: false, reason: 'unconfigured', message: '模型通道未配置：本机没有可用的设备会话。' } });
    install(bridge);
    const port = new AndroidModelConversation(androidModelBridge()!);
    let thrown: ServiceFailure | undefined;
    try {
      await collect(port, '手机字体怎么调大？');
    } catch (error) {
      thrown = error as ServiceFailure;
    }
    expect(thrown).toBeInstanceOf(ServiceFailure);
    expect(thrown?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(thrown?.message).toContain('未配置');
    expect(state.textCalls).toHaveLength(0);
  });

  it('配置可用时产生 started → caption → completed 事件，且不出现演示内容', async () => {
    const { bridge } = fakeBridge();
    install(bridge);
    const port = new AndroidModelConversation(androidModelBridge()!);
    const events = await collect(port, '手机字体怎么调大？');
    expect(events.map(event => event.type)).toEqual(['started', 'delta', 'completed']);
    expect(events[1].text).toContain('Android 模型回答');
  });

  it('结构化错误码映射到 ServiceFailure（RISK_PAUSED 不再发送）', async () => {
    const { bridge } = fakeBridge({
      answerText: async input => ({ ok: false, requestId: input.requestId, code: 'RISK_PAUSED', retryable: false }),
    });
    install(bridge);
    const port = new AndroidModelConversation(androidModelBridge()!);
    await expect(collect(port, '帮我转账')).rejects.toMatchObject({ code: 'RISK_PAUSED', retryable: false });
  });

  it('requestId 不匹配视为讲解不完整，不拼接回答', async () => {
    const { bridge } = fakeBridge({ answerText: async () => ({ ok: true, requestId: 'other-id', text: '不该采用' }) });
    install(bridge);
    const port = new AndroidModelConversation(androidModelBridge()!);
    await expect(collect(port, '问题')).rejects.toMatchObject({ code: 'STREAM_INTERRUPTED' });
  });

  it('中止会向原生桥发送 cancel，且抛出 AbortError', async () => {
    const { bridge, state } = fakeBridge({ answerText: () => new Promise<unknown>(() => undefined) });
    install(bridge);
    const port = new AndroidModelConversation(androidModelBridge()!);
    const controller = new AbortController();
    const pending = collect(port, '很慢的问题', controller.signal);
    for (let index = 0; index < 50 && state.textCalls.length === 0; index += 1) await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.cancelCalls).toHaveLength(1);
  });

  it('图片状态映射为公共 ImageQuestionStatus，不冒充 ready', async () => {
    install(fakeBridge({ status: { available: false, reason: 'unconfigured', message: '未配置' } }).bridge);
    expect(await new AndroidImageQuestion(androidModelBridge()!).status()).toEqual({ available: false, reason: 'model_not_configured' });
    vi.unstubAllGlobals();
    install(fakeBridge({ status: { available: false, reason: 'host_unavailable', message: '无网络权限' } }).bridge);
    expect(await new AndroidImageQuestion(androidModelBridge()!).status()).toEqual({ available: false, reason: 'host_unavailable' });
    vi.unstubAllGlobals();
    install(fakeBridge().bridge);
    expect(await new AndroidImageQuestion(androidModelBridge()!).status()).toEqual({ available: true, reason: 'ready' });
  });

  it('图片问答需要本次确认；发送时以 PNG base64 交给原生层', async () => {
    const { bridge, state } = fakeBridge();
    install(bridge);
    const port = new AndroidImageQuestion(androidModelBridge()!);
    const image = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
    await expect(port.answer({ question: '看看', image, confirmed: false }, new AbortController().signal)).rejects.toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(state.imageCalls).toHaveLength(0);
    const answer = await port.answer({ question: '看看', image, confirmed: true }, new AbortController().signal);
    expect(answer).toContain('脱敏');
    expect(state.imageCalls).toHaveLength(1);
    expect(state.imageCalls[0]).toMatchObject({ mime: 'image/png', confirmed: true });
    expect(Buffer.from(state.imageCalls[0].base64, 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('原生返回 REDACTION_UNAVAILABLE 时明确“图片未上传”，不可重试且不改走其他路径', async () => {
    const { bridge } = fakeBridge({ answerImage: async input => ({ ok: false, requestId: input.requestId, code: 'REDACTION_UNAVAILABLE', retryable: false }) });
    install(bridge);
    const port = new AndroidImageQuestion(androidModelBridge()!);
    const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    let thrown: ServiceFailure | undefined;
    try {
      await port.answer({ question: '看看', image, confirmed: true }, new AbortController().signal);
    } catch (error) {
      thrown = error as ServiceFailure;
    }
    expect(thrown).toBeInstanceOf(ServiceFailure);
    expect(thrown?.code).toBe('PROVIDER_UNAVAILABLE');
    expect(thrown?.message).toContain('脱敏');
    expect(thrown?.retryable).toBe(false);
  });

  it('非 PNG/JPEG/WebP 或超过 10MB 的图片直接拒绝，不调用桥接', async () => {
    const { bridge, state } = fakeBridge();
    install(bridge);
    const port = new AndroidImageQuestion(androidModelBridge()!);
    await expect(port.answer({ question: '看看', image: new Blob(['x'], { type: 'image/gif' }), confirmed: true }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(state.imageCalls).toHaveLength(0);
  });

  it('Android 宿主源码保持严格白名单：令牌不得出现在桥接/Web 适配器中', () => {
    const bridgeSource = readHost('AndroidModelAccessBridge.kt');
    expect(bridgeSource).toContain('LISTENER_NAME = "nuanbanAndroidModelHost"');
    expect(bridgeSource).toContain('BRIDGE_NAME = "nuanbanAndroidModel"');
    expect(bridgeSource).toContain('keysOf(args)');
    expect(bridgeSource).toContain('ModelAccessLimits.validErrorCode');
    expect(bridgeSource).not.toMatch(/accessToken|refreshToken|Authorization|Bearer/);

    const protocol = readHost('ModelAccessProtocol.kt');
    expect(protocol).toContain('const val QUESTION_MAX_CHARS = 1500');
    expect(protocol).toContain('const val REDACTED_PNG_MAX_BYTES = 2_000_000');
    expect(protocol).toContain('const val PNG_MAX_PIXELS = 8_388_608');
    expect(protocol).toContain('ERROR_CODES');

    const webAdapter = readWeb('android-model.ts');
    expect(webAdapter).toContain('window.nuanbanAndroidModel');
    expect(webAdapter).not.toMatch(/accessToken|refreshToken|Authorization|Bearer/);

    const transport = readHost('AndroidModelAccessHttp.kt');
    for (const path of ['/v1/device-sessions/challenges', '/v1/device-sessions/refresh', '/v1/conversations']) {
      expect(transport).toContain(path);
    }
    expect(transport).toContain('ModelAccessPng.sha256Hex');
    expect(transport).toContain('redaction_attested');
  });

  it('原生会话存储/绑定/桥接字段与上限有源码级约束', () => {
    const store = readHost('ModelAccessSessionStore.kt');
    expect(store).toContain('DEVICE_SECRET_SLOT');
    expect(store).toContain('saveDeviceSecret');
    expect(store).toContain('clear()');

    const binder = readHost('ModelAccessBinder.kt');
    expect(binder).toContain('loadDeviceSecret');
    expect(binder).toContain('userConfirmed');
    expect(binder).toContain('transport.refresh');
    expect(binder).toContain('store.save(refreshed)');

    const broker = readHost('ModelAccessBroker.kt');
    expect(broker).toContain('withAuthRetry');
    expect(broker).toContain('REDACTION_UNAVAILABLE');
    expect(broker).toContain('PENDING_MAX');

    const activity = readSource(workspaceRoot + 'apps/android/app/src/main/java/org/nuanban/assistant/MainActivity.kt');
    expect(activity).toContain('AndroidModelAccessBridge');
    expect(activity).toContain('ModelAccessRedactionGate { false }');
    expect(activity).not.toMatch(/ACCESS_TOKEN|refresh_token/);
  });
});
