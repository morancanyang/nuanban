import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const sdkFixture = `export default class SyntheticAvatar {
  constructor(options) {
    this.options = options;
    window.avatarAudit.options = { audio: options.audio, reconnect: options.reconnect, sentry: options.sentry };
    window.avatarAudit.dimensions = { width: options.container.offsetWidth, height: options.container.offsetHeight };
    window.avatarLateCallbacks = options.agentCallbacks;
  }
  setVolume(value) { window.avatarAudit.volume = value; window.avatarAudit.volumes.push(value); }
  idle() { window.avatarAudit.motions.push('idle'); }
  interactiveidle() { window.avatarAudit.motions.push('interactiveidle'); }
  listen() { window.avatarAudit.motions.push('listen'); }
  think() { window.avatarAudit.motions.push('think'); }
  getAgentState() { return 'running'; }
  getASRState() { return window.avatarAudit.asr; }
  async startASR() {
    window.avatarAudit.asrStarts++;
    window.avatarAudit.asr = 'listening';
    this.options.agentCallbacks.onASRStateChange('listening');
    this.options.agentCallbacks.onASRResult({ text: '合成识别文字', isFinal: true });
    setTimeout(() => {
      this.options.agentCallbacks.onLLMResponse({ event: 'chunk', text: '这是合成回答' });
      this.options.agentCallbacks.onConversationChange({ state: 'speaking', text: '这是合成回答' });
      this.options.agentCallbacks.onSpeakStateChange({ state: 'speak_start' });
    }, 0);
  }
  async stopASR() {
    window.avatarAudit.asrStops++;
    window.avatarAudit.asr = 'idle';
    this.options.agentCallbacks.onASRStateChange('idle');
  }
  interrupt() {
    window.avatarAudit.interrupts++;
    this.options.agentCallbacks.onConversationChange({ state: 'interrupted' });
    return 0;
  }
  async init({onDownloadProgress}) {
    await fetch(this.options.gatewayServer, { method: 'POST', body: JSON.stringify({ request_id: 'synthetic-request' }) });
    onDownloadProgress(100);
    if (window.avatarMode === 'pending') await new Promise(resolve => window.addEventListener('synthetic-avatar-resolve', resolve, { once: true }));
    if (window.avatarMode === 'error') { this.options.agentCallbacks.onError({ code: 'synthetic-error' }); throw new Error('synthetic-error'); }
    const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
    canvas.style.pointerEvents = 'auto';
    for (const name of ['pointerdown', 'pointermove', 'pointerup', 'click', 'contextmenu']) canvas.addEventListener(name, event => event.stopPropagation());
    this.options.container.append(canvas);
    this.options.onRenderChange('rendering');
  }
  async destroy() { window.avatarAudit.destroyed++; this.options.container.replaceChildren(); }
}`;

async function fixture(page: Page, mode = 'ready') {
  await page.route('http://127.0.0.1:41874/**', async route => {
    const filename = new URL(route.request().url()).pathname.slice(1);
    if (filename === 'avatar-runtime/default-pet.json') return route.fulfill({ body: 'export default ' + readFileSync(new URL('../../apps/desktop/default-pet.json', import.meta.url), 'utf8'), contentType: 'text/javascript' });
    if (filename === 'assets/xingyun-floral-otter-preview.png') return route.fulfill({ body: readFileSync(new URL('../../apps/desktop/assets/xingyun-floral-otter-preview.png', import.meta.url)), contentType: 'image/png' });
    if (filename === 'avatar-runtime/sdk-fixture.js') return route.fulfill({ body: sdkFixture, contentType: 'text/javascript' });
    if (filename === 'avatar-runtime/xingyun-renderer.js') return route.fulfill({ body: readFileSync(new URL('../../apps/desktop/xingyun-renderer.js', import.meta.url), 'utf8').replace("'@xmov/avatar/agent'", "'./sdk-fixture.js'"), contentType: 'text/javascript' });
    if (!['pet.html', 'pet.css', 'pet.js', 'pet-artwork.js'].includes(filename)) return route.abort();
    return route.fulfill({ body: readFileSync(new URL('../../apps/desktop/' + filename, import.meta.url)), contentType: filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.css') ? 'text/css' : 'text/javascript' });
  });
  await page.addInitScript(({ mode }) => {
    const audit = { begins: 0, exchanges: 0, stops: 0, failures: 0, destroyed: 0, management: 0, microphones: 0, menus: 0, drags: [] as string[], motions: [] as string[],
      confirms: 0, modes: [] as string[], asrStarts: 0, asrStops: 0, interrupts: 0, volumes: [] as number[], asr: 'idle' };
    let listener: ((value: unknown) => void) | undefined;
    let runtimeListener: ((value: unknown) => void) | undefined;
    let state = { configured: mode !== 'mismatch', configurationMismatch: mode === 'mismatch', phase: mode === 'mismatch' ? 'unconfigured' : 'idle', message: mode === 'mismatch' ? '本机仍是其他星云应用，请先更新为应用 188337 的完整凭证。' : '本机应用已配置', appId: '031ce3cd-synthetic-application', mode: 'render', conversation: { enabled: false, phase: 'idle' } };
    const publish = (phase: string, message: string) => { state = { ...state, phase, message }; listener?.(state); return state; };
    const runtime = { observation: { state: 'off', generation: 1, captureActive: false }, task: { state: 'idle' }, analysis: { state: 'idle' }, captions: { enabled: false }, wake: { state: 'disabled', microphoneActive: false }, voice: { active: false, microphoneActive: false } };
    Object.assign(window, { avatarAudit: audit, avatarMode: mode, nuanbanPet: {
      snapshot: async () => runtime, onState: (callback: (value: unknown) => void) => { runtimeListener = callback; return () => { runtimeListener = undefined; }; }, onPanel: () => () => {}, command: async () => ({ ok: true }),
      drag: async (action: string) => { audit.drags.push(action); return true; },
      openMain: async () => { audit.management++; }, openTool: async () => { audit.management++; }, dictate: async () => { audit.microphones++; }, showMenu: async () => { audit.menus++; return true; },
    }, nuanbanAvatar: {
      status: async () => state, onState: (callback: (value: unknown) => void) => { listener = callback; return () => { listener = undefined; }; },
      begin: async (consent: boolean, selected = 'render') => {
        if (!state.configured || !consent) throw new Error('matching application and consent required');
        audit.begins++;
        audit.modes.push(selected);
        state = { ...state, mode: selected, conversation: { enabled: selected === 'conversation', phase: 'connecting' } };
        publish('connecting', '正在连接');
        return { lease: 'synthetic-lease', mode: selected, appId: state.appId, gatewayServer: 'https://nuanban-xingyun.invalid/session' };
      },
      confirmConversation: async () => { audit.confirms++; return mode !== 'conversation-cancel'; },
      exchange: async () => { audit.exchanges++; return { status: 200, body: { error_code: 0, data: { resource_pack: {} } } }; },
      ready: async () => { publish('ready', '花环水獭已启用'); return true; },
      fail: async () => { audit.failures++; return publish('error', '加载失败；不会自动重连'); },
      stop: async () => { audit.stops++; publish('stopping', '正在停止'); state = { ...state, conversation: { enabled: false, phase: 'idle' } }; return { stopped: true, ...publish('idle', '云端会话已停止，恢复本机桌宠') }; },
    } });
    window.addEventListener('test-avatar-messages', event => {
      Object.assign(runtime, { messages: (event as CustomEvent).detail });
      runtimeListener?.(runtime);
    });
  }, { mode });
  await page.goto('http://127.0.0.1:41874/pet.html');
  await page.waitForLoadState('networkidle');
  await page.locator('#pet-toggle').click();
  await page.locator('#feature-avatar').click();
  await expect(page.locator('#avatar-view')).toBeVisible();
}

async function audit(page: Page) { return page.evaluate(() => (window as unknown as { avatarAudit: Record<string, unknown> }).avatarAudit); }

test('真实动作入口只控制已连接的星云角色，点击互动而拖动不触发动作', async ({ page }) => {
  await fixture(page);
  await expect(page.locator('#avatar-motion-idle')).toBeDisabled();
  await expect(page.locator('#avatar-motion-status')).toContainText('本地预览不包含星云动作');
  expect(await audit(page)).toMatchObject({ begins: 0, motions: [] });
  await page.locator('#avatar-consent').check();
  await page.locator('#avatar-start').click();
  await expect(page.locator('#avatar-motion-idle')).toBeEnabled();
  expect(await audit(page)).toMatchObject({ motions: [] });
  for (const name of ['interactive', 'listen', 'think', 'idle']) await page.locator('#avatar-motion-' + name).click();
  expect(await audit(page)).toMatchObject({ motions: ['interactiveidle', 'listen', 'think', 'idle'], begins: 1, exchanges: 1, microphones: 0 });
  await page.locator('#collapse-panel').click();
  const bounds = await page.locator('#pet-toggle').boundingBox();
  if (!bounds) throw new Error('Pet not visible');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 12, bounds.y + 12, { steps: 10 });
  await page.mouse.up();
  expect((await audit(page)).motions).toEqual(['interactiveidle', 'listen', 'think', 'idle']);
  await page.locator('#pet-toggle').click();
  expect((await audit(page)).motions).toEqual(['interactiveidle', 'listen', 'think', 'idle', 'interactiveidle']);
  await page.locator('#feature-avatar').click();
  await page.locator('#avatar-stop').click();
  await expect(page.locator('#avatar-motion-idle')).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('nuanban:avatar-interaction')));
  expect(await audit(page)).toMatchObject({ begins: 1, exchanges: 1, microphones: 0, destroyed: 1 });
  expect((await audit(page)).motions).toHaveLength(5);
});

test('本地预览自动轻摇呼吸，拖动暂停动效，减少动态与实时 3D 不叠加', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await fixture(page);
  await page.locator('#collapse-panel').click();
  const preview = page.locator('#builtin-pet');
  await expect(preview).toHaveCSS('animation-name', 'pet-idle');
  const transform = await preview.evaluate(element => getComputedStyle(element).transform);
  await expect.poll(() => preview.evaluate(element => getComputedStyle(element).transform)).not.toBe(transform);
  await page.locator('#pet-toggle').evaluate(element => element.classList.add('is-dragging'));
  await expect(preview).toHaveCSS('animation-play-state', 'paused');
  await page.locator('#pet-toggle').evaluate(element => element.classList.remove('is-dragging'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(preview).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await audit(page)).toMatchObject({ begins: 0, exchanges: 0, management: 0, microphones: 0 });
  await page.locator('#pet-toggle').click();
  await page.locator('#feature-avatar').click();
  await page.locator('#avatar-consent').check();
  await page.locator('#avatar-start').click();
  await expect(page.locator('#avatar-status')).toHaveAttribute('data-phase', 'ready');
  await page.locator('#collapse-panel').click();
  await expect(page.locator('#xingyun-pet')).toHaveCSS('animation-name', 'none');
  await expect(page.locator('#xingyun-canvas canvas')).toHaveCSS('pointer-events', 'none');
  expect(await audit(page)).toMatchObject({ begins: 1, exchanges: 1, destroyed: 0, stops: 0, management: 0, microphones: 0 });
});

test('按住形象直接拖动，释放不打开面板，单击右键和实时 3D 不受影响', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await fixture(page);
  await page.locator('#collapse-panel').click();
  const stage = page.locator('#pet-toggle');
  const initialDragCount = ((await audit(page)).drags as string[]).length;
  const drag = async () => {
    const bounds = await stage.boundingBox();
    if (!bounds) throw new Error('桌宠形象不可见');
    const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x - 125, start.y - 170, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('#pet-panel')).toBeHidden();
    await expect(stage).not.toHaveClass(/is-dragging/);
  };
  await drag();
  const dragActions = ((await audit(page)).drags as string[]).slice(initialDragCount);
  expect(dragActions[0]).toBe('start');
  expect(dragActions.at(-1)).toBe('end');
  expect(dragActions.filter(action => action === 'move').length).toBeGreaterThan(0);
  await stage.click({ button: 'right' });
  expect(await audit(page)).toMatchObject({ menus: 1, begins: 0, management: 0, microphones: 0 });
  await stage.click();
  await expect(page.locator('#feature-home')).toBeVisible();
  await page.locator('#feature-avatar').click();
  await page.locator('#avatar-consent').check();
  await page.locator('#avatar-start').click();
  await expect(page.locator('#avatar-status')).toHaveAttribute('data-phase', 'ready');
  await page.locator('#collapse-panel').click();
  await drag();
  await expect(page.locator('#xingyun-pet')).toBeVisible();
  await stage.focus();
  await stage.press('Enter');
  await expect(page.locator('#feature-home')).toBeVisible();
  expect(await audit(page)).toMatchObject({ begins: 1, exchanges: 1, destroyed: 0, stops: 0, management: 0, microphones: 0 });
  expect(errors).toEqual([]);
});

test('悬浮态只保留形象，状态留在功能页，右键菜单仍可用', async ({ page }, testInfo) => {
  await fixture(page);
  await expect(page.locator('#avatar-display-state')).toBeVisible();
  await page.locator('#collapse-panel').click();
  await expect(page.locator('#pet-panel')).toBeHidden();
  await expect(page.locator('.dock-copy')).toBeHidden();
  await expect(page.locator('#avatar-display-state')).toBeHidden();
  await expect(page.locator('#message')).toBeHidden();
  await expect(page.locator('#pet-menu, #pet-voice, #pet-search')).toHaveCount(3);
  for (const selector of ['#pet-menu', '#pet-voice', '#pet-search', '.dock-tools .drag-handle']) await expect(page.locator(selector)).toBeHidden();
  await expect(page.locator('#builtin-pet')).toBeVisible();
  await expect(page.locator('#pet-toggle')).not.toHaveAttribute('title');
  await page.locator('#pet-toggle').click({ button: 'right' });
  expect(await audit(page)).toMatchObject({ menus: 1, begins: 0, management: 0, microphones: 0 });
  await page.screenshot({ path: testInfo.outputPath('pet-model-only.png'), omitBackground: true });
  await page.locator('#pet-toggle').click();
  await page.locator('#feature-avatar').click();
  await expect(page.locator('#avatar-display-state')).toBeVisible();
  await page.locator('#avatar-consent').check();
  await page.locator('#avatar-start').click();
  await expect(page.locator('#avatar-status')).toHaveAttribute('data-phase', 'ready');
  await page.locator('#collapse-panel').click();
  await expect(page.locator('#xingyun-pet')).toBeVisible();
  await expect(page.locator('.dock-copy')).toBeHidden();
  await expect(page.locator('#avatar-display-state')).toBeHidden();
  await expect(page.locator('#pet-voice-controls')).toBeHidden();
  await page.locator('#pet-toggle').click({ button: 'right' });
  expect(await audit(page)).toMatchObject({ menus: 2, begins: 1, exchanges: 1 });
});

test('消息只显示一个小圆点，点击看详情且不会重连已有 3D 会话', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await fixture(page);
  await page.locator('#collapse-panel').click();
  await expect(page.locator('#pet-notification')).toBeHidden();
  const messages = [{ id: 'answer-1', role: 'assistant', text: '这条新消息只在详情显示。<img src=x onerror=alert(1)>' }];
  await page.evaluate(messages => window.dispatchEvent(new CustomEvent('test-avatar-messages', { detail: messages })), messages);
  await expect(page.locator('#pet-notification')).toBeVisible();
  await expect(page.locator('#pet-panel')).toBeHidden();
  await expect(page.locator('.dock-copy')).toBeHidden();
  await expect(page.locator('#pet-due-todos')).toBeHidden();
  for (const selector of ['#artwork-status', '#model-status']) await expect(page.locator(selector)).toBeHidden();
  await expect(page.locator('#pet-notification')).not.toHaveAttribute('title');
  const dot = await page.locator('#pet-notification > span').boundingBox();
  expect(dot).toMatchObject({ width: 8, height: 8 });
  expect(await audit(page)).toMatchObject({ begins: 0, management: 0, microphones: 0 });
  await page.screenshot({ path: testInfo.outputPath('pet-single-notification-dot.png'), omitBackground: true });
  await page.locator('#pet-notification').focus();
  await page.locator('#pet-notification').press('Enter');
  await expect(page.locator('#pet-panel')).toHaveAttribute('data-view', 'question');
  await expect(page.locator('#message-list')).toContainText(messages[0].text);
  await expect(page.locator('#message-list img')).toHaveCount(0);
  await page.locator('#collapse-panel').click();
  await page.evaluate(messages => window.dispatchEvent(new CustomEvent('test-avatar-messages', { detail: messages })), messages);
  await expect(page.locator('#pet-notification')).toBeHidden();
  await page.locator('#pet-toggle').click();
  await page.locator('#feature-avatar').click();
  await page.locator('#avatar-consent').check();
  await page.locator('#avatar-start').click();
  await expect(page.locator('#avatar-status')).toHaveAttribute('data-phase', 'ready');
  await page.locator('#collapse-panel').click();
  await page.evaluate(messages => window.dispatchEvent(new CustomEvent('test-avatar-messages', { detail: messages })), [...messages, { id: 'answer-2', role: 'assistant', text: '另一条新消息' }]);
  await expect(page.locator('#pet-notification')).toBeVisible();
  await expect(page.locator('#xingyun-pet')).toBeVisible();
  await page.locator('#pet-notification').click();
  await expect(page.locator('#pet-panel')).toHaveAttribute('data-view', 'question');
  expect(await audit(page)).toMatchObject({ begins: 1, exchanges: 1, stops: 0, destroyed: 0, management: 0, microphones: 0 });
  expect(errors).toEqual([]);
});

test('独立形象页面浏览和切页不会连接云端或打开客户端', async ({ page }) => {
  await fixture(page);
  await expect(page.locator('#feature-home')).toBeHidden();
  await expect(page.locator('#lesson-card')).toBeHidden();
  await expect(page.locator('#voice-section')).toBeHidden();
  await expect(page.locator('#avatar-start')).toBeDisabled();
  await expect(page.locator('#builtin-pet')).toBeVisible();
  await expect(page.locator('#builtin-pet')).toHaveAttribute('data-avatar-id', 'xingyun-floral-otter');
  await expect(page.locator('#avatar-title')).toHaveText('默认小伙伴 · 花环水獭');
  expect(await page.locator('#builtin-pet').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('#fallback-cat-pet')).toBeHidden();
  await page.locator('#view-features').click();
  await expect(page.locator('#avatar-view')).toBeHidden();
  await page.locator('#feature-avatar').click();
  expect(await audit(page)).toMatchObject({ begins: 0, exchanges: 0, management: 0, microphones: 0 });
});

test('本机仍为旧应用时只显示新默认预览，不允许连错形象', async ({ page }) => {
  await fixture(page, 'mismatch');
  await expect(page.locator('#avatar-application')).toHaveText('待切换至应用 · 188337');
  await expect(page.locator('#avatar-status')).toContainText('188337');
  await page.locator('#avatar-consent').check();
  await expect(page.locator('#avatar-start')).toBeDisabled();
  await expect(page.locator('#builtin-pet')).toBeVisible();
  await expect(page.locator('#builtin-pet')).toHaveAttribute('src', './assets/xingyun-floral-otter-preview.png');
  await expect(page.locator('#xingyun-pet')).toBeHidden();
  expect(await audit(page)).toMatchObject({ begins: 0, exchanges: 0, management: 0, microphones: 0 });
});

test('明确启用才显示形象，容器非零；停止恢复原桌宠且重新要求确认', async ({ page }) => {
  await fixture(page);
  await page.locator('#avatar-consent').check();
  await page.locator('#avatar-start').click();
  await expect(page.locator('#avatar-status')).toHaveAttribute('data-phase', 'ready');
  await expect(page.locator('#xingyun-pet')).toBeVisible();
  await expect(page.locator('#builtin-pet')).toBeHidden();
  const running = await audit(page);
  expect(running).toMatchObject({ begins: 1, exchanges: 1, volume: 0, options: { audio: { inputEnabled: false }, reconnect: { enabled: false, maxAttempts: 0 }, sentry: { enabled: false } } });
  expect((running.dimensions as { width: number }).width).toBeGreaterThan(0);
  expect((running.dimensions as { height: number }).height).toBeGreaterThan(0);
  await page.locator('#avatar-stop').click();
  await expect(page.locator('#xingyun-pet')).toBeHidden();
  await expect(page.locator('#builtin-pet')).toBeVisible();
  await expect(page.locator('#avatar-start')).toBeDisabled();
  expect(await audit(page)).toMatchObject({ begins: 1, destroyed: 1, stops: 1, microphones: 0 });
});

test('资源失败退回原桌宠，不自动重连', async ({ page }) => {
  await fixture(page, 'error');
  await page.locator('#avatar-consent').check();
  await page.locator('#avatar-start').click();
  await expect(page.locator('#avatar-status')).toHaveAttribute('data-phase', 'error');
  await expect(page.locator('#xingyun-pet')).toBeHidden();
  await expect(page.locator('#builtin-pet')).toBeVisible();
  await page.waitForTimeout(700);
  expect(await audit(page)).toMatchObject({ begins: 1, exchanges: 1, failures: 1, destroyed: 1 });
  await expect(page.locator('#avatar-start')).toBeDisabled();
});

test('加载中停止，迟到的初始化结果不能重新显示或创建会话', async ({ page }) => {
  await fixture(page, 'pending');
  await page.locator('#avatar-consent').check();
  await page.locator('#avatar-start').click();
  await expect.poll(async () => (await audit(page)).exchanges).toBe(1);
  await page.locator('#avatar-stop').click();
  await page.evaluate(() => window.dispatchEvent(new Event('synthetic-avatar-resolve')));
  await expect(page.locator('#avatar-status')).toHaveAttribute('data-phase', 'idle');
  await expect(page.locator('#xingyun-pet')).toBeHidden();
  await expect(page.locator('#builtin-pet')).toBeVisible();
  expect(await audit(page)).toMatchObject({ begins: 1, destroyed: 1, stops: 1 });
});

async function recordConversationEvents(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { avatarConversationLog: string[] }).avatarConversationLog = [];
    window.addEventListener('nuanban:avatar-conversation', event => {
      const detail = (event as CustomEvent).detail as { state: string; asr: string };
      (window as unknown as { avatarConversationLog: string[] }).avatarConversationLog.push(detail.state + ':' + detail.asr);
    });
  });
}

test('实时对话必须本人确认：取消后不开会话、不开麦，也不改变形象会话', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await fixture(page, 'conversation-cancel');
  await page.locator('#view-features').click();
  await page.locator('#feature-avatar-conversation').click();
  await expect(page.locator('#avatar-view')).toBeVisible();
  await expect(page.locator('#avatar-conversation-start')).toBeFocused();
  await expect(page.locator('#avatar-conversation-start')).toBeEnabled();
  await expect(page.locator('#avatar-conversation-state')).toHaveAttribute('data-state', 'idle');
  await page.locator('#avatar-conversation-start').click();
  await expect(page.locator('#avatar-conversation-state')).toContainText('已取消');
  await expect(page.locator('#avatar-conversation-state')).toHaveAttribute('data-state', 'cancelled');
  expect(await audit(page)).toMatchObject({ confirms: 1, begins: 0, exchanges: 0, asrStarts: 0, asrStops: 0, destroyed: 0, stops: 0 });
  expect(errors).toEqual([]);
});

test('实时对话确认后开麦聆听、显示识别与回答，停止确认关闭且不残留 ASR', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await fixture(page, 'conversation');
  await recordConversationEvents(page);
  await page.locator('#view-features').click();
  await page.locator('#feature-avatar-conversation').click();
  await expect(page.locator('#avatar-conversation-start')).toBeFocused();
  await page.locator('#avatar-conversation-start').click();
  await expect(page.locator('#avatar-conversation-transcript')).toContainText('合成识别文字');
  await expect(page.locator('#avatar-conversation-state')).toHaveAttribute('data-state', 'speaking');
  await expect(page.locator('#avatar-conversation-reply')).toContainText('这是合成回答');
  await expect(page.locator('#avatar-motion-idle')).toBeDisabled();
  await expect.poll(async () => page.evaluate(() => (window as unknown as { avatarConversationLog: string[] }).avatarConversationLog))
    .toEqual(expect.arrayContaining(['listening:listening', 'speaking:listening']));
  expect(await audit(page)).toMatchObject({ begins: 1, confirms: 1, modes: ['conversation'], asrStarts: 1, asrStops: 0,
    volume: 1, volumes: [1], exchanges: 1, destroyed: 0, stops: 0,
    options: { audio: { inputEnabled: true }, reconnect: { enabled: false, maxAttempts: 0 }, sentry: { enabled: false } } });
  await page.locator('#avatar-conversation-stop').click();
  await expect(page.locator('#avatar-conversation-state')).toHaveAttribute('data-state', 'stopped');
  await expect(page.locator('#xingyun-pet')).toBeHidden();
  expect(await audit(page)).toMatchObject({ begins: 1, asrStarts: 1, asrStops: 1, destroyed: 1, stops: 1, asr: 'idle' });
  expect(errors).toEqual([]);
});

test('仅形象会话运行中也能进入实时对话：按钮可用、先停形象再建立对话会话', async ({ page }) => {
  // 现场问题：用户已启用花环水獭（仅形象）后，"开启实时对话"按钮被禁用且界面不说明原因，等于点不动。
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await fixture(page, 'conversation');
  await page.locator('#avatar-consent').check();
  await page.locator('#avatar-start').click();
  await expect(page.locator('#avatar-motion-idle')).toBeEnabled();
  const enabledAudit = await audit(page);
  expect(enabledAudit).toMatchObject({ begins: 1, modes: ['render'], asrStarts: 0 });

  await expect(page.locator('#avatar-conversation-start')).toBeEnabled();
  await expect(page.locator('#avatar-conversation-start')).toHaveText('切换到实时对话');
  await expect(page.locator('#avatar-conversation-boundaries')).toContainText('会先停止这个仅形象会话');

  await page.locator('#avatar-conversation-start').click();
  await expect(page.locator('#avatar-conversation-state')).toHaveAttribute('data-state', 'speaking');
  expect(await audit(page)).toMatchObject({ confirms: 1, modes: ['render', 'conversation'], stops: 1, destroyed: 1,
    asrStarts: 1, volume: 1, microphones: 0 });
  expect(errors).toEqual([]);

  await page.locator('#avatar-conversation-stop').click();
  await expect(page.locator('#avatar-conversation-state')).toHaveAttribute('data-state', 'stopped');
  const stoppedAudit = await audit(page);
  expect(stoppedAudit).toMatchObject({ asrStarts: 1, asr: 'idle' });
  // 停止是幂等的：SDK 自身与销毁路径都会结束上行，这里只要求"确实停过、且没有新的上行"。
  expect(Number(stoppedAudit.asrStops)).toBeGreaterThanOrEqual(1);
});

test('实时对话停止后，迟到的 ASR、回答与连接回调被 generation 丢弃', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await fixture(page, 'conversation');
  await page.locator('#avatar-conversation-start').click();
  await expect(page.locator('#avatar-conversation-state')).toHaveAttribute('data-state', 'speaking');
  await page.locator('#avatar-conversation-stop').click();
  await expect(page.locator('#avatar-conversation-state')).toHaveAttribute('data-state', 'stopped');
  await page.evaluate(() => {
    const callbacks = (window as unknown as { avatarLateCallbacks: Record<string, (value: unknown) => void> }).avatarLateCallbacks;
    callbacks.onASRResult({ text: '迟到的识别', isFinal: true });
    callbacks.onConversationChange({ state: 'speaking' });
    callbacks.onLLMResponse({ event: 'chunk', text: '迟到的回答' });
    callbacks.onASRStateChange('listening');
    callbacks.onSocketStateChange('closed');
    callbacks.onError({ code: 'synthetic-late', domain: 'network' });
  });
  await expect(page.locator('#avatar-conversation-state')).toHaveAttribute('data-state', 'stopped');
  await expect(page.locator('#avatar-conversation-transcript')).not.toContainText('迟到的识别');
  await expect(page.locator('#avatar-conversation-reply')).not.toContainText('迟到的回答');
  await page.waitForTimeout(300);
  await expect(page.locator('#avatar-status')).toHaveAttribute('data-phase', 'idle');
  expect(await audit(page)).toMatchObject({ begins: 1, exchanges: 1, asrStarts: 1, asrStops: 1, destroyed: 1, stops: 1, failures: 0 });
  expect(errors).toEqual([]);
});
