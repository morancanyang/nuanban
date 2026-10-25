import { describe, expect, it } from 'vitest';
import Module from 'node:module';
import path from 'node:path';

// 现场缺陷回归：宿主的 snapshot 把无截屏模式放在 observation.guidance，而 preload 的字段白名单
// 投影没有列出它，于是桌宠永远看不到模式、按钮一直禁用。这里直接驱动真实的 pet-preload.cjs，
// 断言投影后的快照仍带该块，且白名单之外的字段一律被丢弃。
type AnyRecord = Record<string, unknown>;

function loadPetApi(snapshot: unknown) {
  const preload = path.resolve(import.meta.dirname, '../../apps/desktop/pet-preload.cjs');
  const originalRequire = Module.prototype.require;
  const handlers: Record<string, (event: unknown, payload: unknown) => void> = {};
  const box: { api: AnyRecord | null } = { api: null };
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, api: AnyRecord) => { if (name === 'nuanbanPet') box.api = api; } },
    ipcRenderer: {
      invoke: async () => snapshot,
      on: (channel: string, handler: (event: unknown, payload: unknown) => void) => { handlers[channel] = handler; },
      removeListener: () => {},
      send: () => {},
    },
  };
  const patched = function patchedRequire(this: unknown, id: string) {
    if (id === 'electron') return electron;
    return originalRequire.call(this as NodeJS.Module, id);
  } as unknown as NodeJS.Require;
  Module.prototype.require = patched;
  try {
    delete require.cache[require.resolve(preload)];
    require(preload);
  } finally {
    Module.prototype.require = originalRequire;
  }
  return { api: box.api as unknown as { onState: (listener: (value: unknown) => void) => () => void }, handlers };
}

const hostSnapshot = (guidance: AnyRecord) => ({
  observation: { state: 'off', sourceName: '', reason: '', generation: 0, captureActive: false, cloudConsent: false,
    unredactedUpload: false, guidance },
  task: { state: 'idle' },
});

function pushSnapshot(snapshot: unknown) {
  const { api, handlers } = loadPetApi({});
  const box: { value: AnyRecord | null } = { value: null };
  api.onState(value => { box.value = value as AnyRecord; });
  const push = Object.values(handlers)[0];
  expect(typeof push).toBe('function');
  push({}, snapshot);
  return box.value;
}

describe('桌宠 preload 必须把无截屏模式投递给界面', () => {
  it('保留 observation.guidance 的白名单字段并丢弃其它字段', () => {
    const seen = pushSnapshot(hostSnapshot({
      mode: 'screenshot-free', modeLabel: '无截屏（默认）', screenshotFree: true, active: false,
      reasonCode: null, reasonMessage: null, severity: 'info', suggestSingleFrame: false, textConsent: false,
      counts: { count: 0, limit: 400, truncated: false }, review: null, available: true,
      secretControlName: '不该到达界面',
    }));
    const observation = seen?.observation as AnyRecord | undefined;
    const guidance = observation?.guidance as AnyRecord | undefined;
    expect(guidance?.screenshotFree).toBe(true);
    expect(guidance?.mode).toBe('screenshot-free');
    expect(guidance?.counts).toEqual({ count: 0, limit: 400, truncated: false });
    expect(guidance?.secretControlName).toBeUndefined();
  });

  it('越界或类型不符的模式块不会到达界面', () => {
    const seen = pushSnapshot(hostSnapshot({ mode: 'screenshot-free', screenshotFree: 'yes' }));
    const observation = seen?.observation as AnyRecord | undefined;
    expect(observation?.guidance).toBeUndefined();
  });
});