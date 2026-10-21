import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

type FeatureAudit = { commands: string[]; tools: string[]; management: string[]; questions: number; microphones: number; searches: number };

async function featureFixture(page: Page) {
  await page.route('http://127.0.0.1:41873/**', async route => {
    const filename = new URL(route.request().url()).pathname.slice(1);
    if (!['pet.html', 'pet.css', 'pet.js', 'pet-artwork.js', 'pet-search.js', 'library-runtime/pet-library.js'].includes(filename)) return route.abort();
    await route.fulfill({ body: readFileSync(new URL(`../../apps/desktop/${filename}`, import.meta.url)),
      contentType: filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.css') ? 'text/css' : 'text/javascript' });
  });
  await page.addInitScript(() => {
    const audit: FeatureAudit = { commands: [], tools: [], management: [], questions: 0, microphones: 0, searches: 0 };
    let onPanel: ((value: unknown) => void) | undefined;
    let onState: ((value: unknown) => void) | undefined;
    let onSearch: (() => void) | undefined;
    const state = { observation: { state: 'off', generation: 1, captureActive: false }, task: { state: 'idle', generation: 1, observationGeneration: 1 }, analysis: { state: 'idle' }, captions: { enabled: false }, wake: { state: 'disabled' },
      voice: { mode: 'local', presentation: 'pet', configured: true, state: 'off', active: false, microphoneActive: false, bubble: { user: '', assistant: '' } } };
    Object.assign(window, { syntheticFeatureAudit: audit, nuanbanPet: {
      snapshot: async () => state, onState: (listener: (value: unknown) => void) => { onState = listener; return () => { onState = undefined; }; },
      onPanel: (listener: (value: unknown) => void) => { onPanel = listener; return () => { onPanel = undefined; }; },
      command: async ({ type }: { type: string }) => {
        audit.commands.push(type);
        if (type === 'voice.open') Object.assign(state.voice, { state: 'listening', active: true, microphoneActive: true });
        if (type === 'voice.mute') Object.assign(state.voice, { state: 'muted', microphoneActive: false });
        if (['voice.unmute', 'voice.interrupt'].includes(type)) Object.assign(state.voice, { state: 'listening', microphoneActive: true });
        if (type === 'voice.stop') Object.assign(state.voice, { state: 'off', active: false, microphoneActive: false, bubble: { user: '', assistant: '' } });
        if (type.startsWith('voice.')) onState?.(state);
        return { ok: true };
      },
      openTool: async (route: string) => { audit.tools.push(route); return true; },
      openMain: async (route: string) => { audit.management.push(route); return true; },
      ask: async () => { audit.questions++; return { ok: true }; },
      dictate: async () => { audit.microphones++; return { status: 'cancelled', localOnly: true }; },
      cancelDictation: async () => true, showMenu: async () => true, close: async () => true,
    }, nuanbanSearch: {
      status: async () => ({ provider: 'ConfiguredModel', configured: false }),
      open: async () => { onPanel?.({ expanded: true, focusInput: false }); onSearch?.(); return true; },
      onOpen: (listener: () => void) => { onSearch = listener; return () => { onSearch = undefined; }; },
      search: async () => { audit.searches++; return { ok: false }; }, cancel: async () => ({ ok: true }),
    } });
    window.addEventListener('test-feature-runtime-update', () => {
      Object.assign(state, { messages: [{ id: 'synthetic-message', role: 'user', text: '这是一条合成提问' }], learning: { notes: [{ id: 'synthetic-note', question: '这是一条合成学习记录' }] } });
      onState?.(state);
    });
    window.addEventListener('test-feature-voice-update', event => {
      Object.assign(state.voice, (event as CustomEvent).detail);
      onState?.(state);
    });
    window.addEventListener('test-feature-panel-open', () => onPanel?.({ expanded: true, section: 'features' }));
  });
  await page.goto('http://127.0.0.1:41873/pet.html');
  await page.getByRole('button', { name: '展开暖暖面板', exact: true }).click();
  await expect(page.locator('#feature-home')).toBeVisible();
}

async function audit(page: Page) {
  return page.evaluate(() => (window as unknown as { syntheticFeatureAudit: FeatureAudit }).syntheticFeatureAudit);
}

async function addLibraryNote(page: Page, question = '怎样保存文件', summary = '先选择文件夹，再检查文件名。') {
  await page.locator('#feature-archive').click();
  await expect(page.locator('#archive-view')).toHaveAttribute('aria-busy', 'false');
  await page.locator('#archive-add').click();
  await page.locator('#archive-question').fill(question);
  await page.locator('#archive-summary').fill(summary);
  await page.locator('#archive-save').click();
  await expect(page.locator('#archive-status')).toHaveText('学习笔记已保存在本机。');
  await expect(page.locator('#archive-list details')).toHaveCount(1);
  await page.locator('#archive-list summary').click();
}

test('学习档案在桌宠里完成新增编辑、掌握、复习和确认删除，重开仍保留本机资料', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await featureFixture(page);
  await addLibraryNote(page, '怎样保存文件', '先选择文件夹。<img src=x onerror=alert(1)> 这只是笔记文字。');
  await expect(page.locator('#archive-list img, #archive-list script')).toHaveCount(0);
  await expect(page.locator('#archive-list')).toContainText('<img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: '记一次复习', exact: true }).click();
  await expect(page.locator('#archive-status')).toContainText('掌握状态保持不变');
  await expect(page.locator('#archive-list')).toContainText('还想再练');
  await page.getByRole('button', { name: '我确认已掌握', exact: true }).click();
  await expect(page.locator('#archive-list')).toContainText('本人确认掌握');
  await page.getByRole('button', { name: '编辑笔记', exact: true }).click();
  await page.locator('#archive-summary').fill('更新后的要点：先检查文件名，再亲手保存。');
  await page.locator('#archive-save').click();
  await expect(page.locator('#archive-list')).toContainText('更新后的要点');
  await page.locator('#archive-search').fill('找不到的关键词');
  await expect(page.locator('#archive-list')).toContainText('没有符合条件的笔记');
  await page.locator('#archive-search').clear();
  await page.locator('#archive-filter').selectOption('unmastered');
  await expect(page.locator('#archive-list details')).toHaveCount(0);
  await page.locator('#archive-filter').selectOption('mastered');
  await expect(page.locator('#archive-list details')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('pet-learning-archive.png'), omitBackground: true });
  await page.reload();
  await page.locator('#pet-toggle').click();
  await page.locator('#feature-archive').click();
  await expect(page.locator('#archive-list')).toContainText('本人确认掌握');
  await page.locator('#archive-list summary').click();
  await expect(page.locator('#archive-list')).toContainText('更新后的要点');
  await page.getByRole('button', { name: '删除笔记', exact: true }).click();
  await expect(page.locator('#archive-list details')).toHaveCount(1);
  await page.getByRole('button', { name: '保留', exact: true }).click();
  await page.getByRole('button', { name: '删除笔记', exact: true }).click();
  await page.getByRole('button', { name: '确认删除笔记', exact: true }).click();
  await expect(page.locator('#archive-list details')).toHaveCount(0);
  expect(await audit(page)).toMatchObject({ tools: [], management: [], questions: 0, microphones: 0, searches: 0 });
  expect(errors).toEqual([]);
});

test('关联复习待办先核对时间，修改后重新确认，完成复习不自动掌握且创建下次重复', async ({ page }, testInfo) => {
  await featureFixture(page);
  await addLibraryNote(page);
  await page.getByRole('button', { name: '安排复习', exact: true }).click();
  await expect(page.locator('#pet-panel')).toHaveAttribute('data-view', 'todos');
  await expect(page.locator('#todos-view')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#todo-title')).toHaveValue('复习：怎样保存文件');
  await expect(page.locator('#todo-note')).not.toHaveValue('');
  await page.locator('#todo-repeat').selectOption('daily');
  await page.locator('#todo-save').click();
  await expect(page.locator('#todo-confirmation')).toBeVisible();
  await expect(page.locator('#todos-list details')).toHaveCount(0);
  await page.locator('#todo-title').fill('每天复习一次保存文件');
  await expect(page.locator('#todo-confirmation')).toBeHidden();
  await page.locator('#todo-save').click();
  await expect(page.locator('#todo-confirmation-text')).toContainText('每天复习一次保存文件');
  await page.screenshot({ path: testInfo.outputPath('pet-todo-time-confirmation.png'), omitBackground: true });
  await page.locator('#todo-save').click();
  await expect(page.locator('#todos-list details')).toHaveCount(1);
  await page.locator('#todos-list summary').click();
  await page.getByRole('button', { name: '查看学习笔记', exact: true }).click();
  await expect(page.locator('#pet-panel')).toHaveAttribute('data-view', 'archive');
  await expect(page.locator('#archive-list details')).toHaveAttribute('open', '');
  await page.locator('#view-features').click();
  await page.locator('#feature-todos').click();
  await expect(page.locator('#todos-view')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: '我已复习，完成待办', exact: true }).click();
  await expect(page.locator('#todos-status')).toContainText('掌握状态未改变');
  await expect(page.locator('#todos-list details')).toHaveCount(1);
  await page.locator('#todos-completed').click();
  await expect(page.locator('#todos-list')).toContainText('每天复习一次保存文件');
  await page.locator('#todos-archive').click();
  await expect(page.locator('#archive-list')).toContainText('还想再练');
  await expect(page.locator('#archive-list')).not.toContainText('最近复习：尚无记录');
  expect(await audit(page)).toMatchObject({ tools: [], management: [], questions: 0, microphones: 0, searches: 0 });
});

test('档案与待办切页不丢编辑草稿，到期入口只打开桌宠待办页', async ({ page }) => {
  await page.clock.install();
  await featureFixture(page);
  await page.locator('#feature-archive').click();
  await page.locator('#archive-add').click();
  await page.locator('#archive-question').fill('尚未保存的真实笔记');
  await page.locator('#archive-summary').fill('这份草稿需要跨功能保留。');
  await page.locator('#view-features').click();
  await page.locator('#feature-todos').click();
  await page.locator('#todos-add').click();
  await page.locator('#todo-title').fill('真实的本机待办');
  await page.locator('#todo-save').click();
  await page.locator('#todo-save').click();
  await expect(page.locator('#todos-list details')).toHaveCount(1);
  await page.locator('#collapse-panel').click();
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('nuanban-demo-v1', 4);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('accounts', 'readwrite');
      const accounts = transaction.objectStore('accounts');
      const request = accounts.get('local-owner');
      request.onsuccess = () => { const snapshot = request.result; snapshot.todos[0].dueAt = new Date(Date.now() - 60000).toISOString(); snapshot.todos[0].version += 1; accounts.put(snapshot, 'local-owner'); };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.clock.fastForward(15000);
  await expect(page.locator('#pet-due-todos')).toBeHidden();
  await expect(page.locator('#pet-notification')).toBeVisible();
  await expect(page.locator('#pet-panel')).toBeHidden();
  await page.locator('#pet-notification').click();
  await expect(page.locator('#pet-panel')).toHaveAttribute('data-view', 'todos');
  await expect(page.locator('#todos-due')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#todos-list')).toContainText('真实的本机待办');
  await page.locator('#todos-archive').click();
  await expect(page.locator('#archive-question')).toHaveValue('尚未保存的真实笔记');
  await expect(page.locator('#archive-summary')).toHaveValue('这份草稿需要跨功能保留。');
  expect(await audit(page)).toMatchObject({ tools: [], management: [], questions: 0, microphones: 0, searches: 0 });
});

test('桌宠功能首页列全入口，光标指引置顶且不会因为浏览功能而启动采集', async ({ page }) => {
  await featureFixture(page);
  await expect(page.getByRole('heading', { name: '暖暖的功能小屋' })).toBeVisible();
  await expect(page.locator('#feature-home [data-tool]')).toHaveCount(9);
  await expect(page.locator('#question-form')).toBeHidden();
  await expect(page.getByRole('button', { name: /AI 生成桌宠/ })).toBeDisabled();
  await page.locator('#feature-guidance').click();
  await expect(page.getByRole('heading', { name: '光标指引 · 真实软件教学' })).toBeVisible();
  await expect(page.locator('#lesson-card')).toBeFocused();
  await expect(page.locator('#question-form')).toBeVisible();
  await page.locator('#guidance-observation').click();
  await expect(page.locator('#observation-section')).toBeFocused();
  await page.getByRole('button', { name: '全部功能', exact: true }).click();
  await expect(page.locator('#feature-home')).toBeFocused();
  await expect(page.locator('#question-form')).toBeHidden();
  const current = await audit(page);
  expect(current.commands.every(command => command === 'panel.set-expanded')).toBe(true);
  expect(current).toMatchObject({ tools: [], management: [], questions: 0, microphones: 0, searches: 0 });
});

test('功能页工具卡片全部打开桌宠工具，而不是客户端管理窗口', async ({ page }) => {
  await featureFixture(page);
  const cards = page.locator('#feature-home [data-tool]');
  const expected = await cards.evaluateAll(buttons => buttons.map(button => button.getAttribute('data-tool')));
  for (let index = 0; index < expected.length; index += 1) await cards.nth(index).click();
  expect((await audit(page)).tools).toEqual(expected);
  expect((await audit(page)).management).toEqual([]);
  expect((await audit(page)).microphones).toBe(0);
});

test('全部功能中的搜索复用本人确认入口，不代替用户勾选或发送', async ({ page }) => {
  await featureFixture(page);
  await page.locator('#feature-search').click();
  await expect(page.getByRole('heading', { name: '帮你查一查' })).toBeVisible();
  await expect(page.locator('#search-consent')).not.toBeChecked();
  await expect(page.locator('#submit-search')).toBeDisabled();
  expect((await audit(page)).searches).toBe(0);
});

test('点击每项功能只进入对应界面，实时状态不会让其他功能混入', async ({ page }, testInfo) => {
  await featureFixture(page);
  const roots = ['feature-home', 'question-view', 'dictation-view', 'search-view', 'voice-section', 'observation-section', 'lesson-card', 'conversation-view', 'learning-view', 'archive-view', 'todos-view', 'captions-view', 'wake-view', 'accessibility-section'];
  const routes = [
    { control: 'feature-question', section: 'question', visible: ['question-view', 'conversation-view'], title: '桌宠提问' },
    { control: 'feature-dictation', section: 'dictation', visible: ['dictation-view', 'conversation-view'], title: '本地语音输入' },
    { control: 'feature-guidance', section: 'guidance', visible: ['lesson-card', 'conversation-view'], title: '光标指引' },
    { control: 'feature-search', section: 'search', visible: ['search-view'], title: '智能查询' },
    { control: 'view-voice', section: 'voice', visible: ['voice-section'], title: '语音陪伴' },
    { control: 'feature-observation', section: 'observation', visible: ['observation-section'], title: '本地观察与脱敏' },
    { control: 'feature-learning', section: 'learning', visible: ['learning-view'], title: '学习笔记与复习' },
    { control: 'feature-archive', section: 'archive', visible: ['archive-view'], title: '学习档案' },
    { control: 'feature-todos', section: 'todos', visible: ['todos-view'], title: '待办与复习' },
    { control: 'feature-captions', section: 'captions', visible: ['captions-view'], title: '大字字幕' },
    { control: 'feature-wake', section: 'wake', visible: ['wake-view'], title: '本地语音唤醒' },
    { control: 'feature-management', section: 'accessibility', visible: ['accessibility-section'], title: '管理与退出' },
  ];
  for (const route of routes) {
    await page.locator('#' + route.control).click();
    await page.evaluate(() => window.dispatchEvent(new Event('test-feature-runtime-update')));
    await expect(page.locator('#pet-panel')).toHaveAttribute('data-view', route.section);
    await expect(page.locator('#panel-title')).toHaveText(route.title);
    for (const identifier of roots) {
      if (route.visible.includes(identifier)) await expect(page.locator('#' + identifier)).toBeVisible();
      else await expect(page.locator('#' + identifier)).toBeHidden();
    }
    await expect(page.locator('#stop-observation')).toBeVisible();
    if (['question', 'search', 'voice'].includes(route.section)) await page.screenshot({ path: testInfo.outputPath(route.section + '.png') });
    await page.locator('#view-features').click();
    await expect(page.locator('#feature-home')).toBeVisible();
    await expect(page.locator('#question-form')).toBeHidden();
    for (const identifier of roots.filter(identifier => identifier !== 'feature-home')) await expect(page.locator('#' + identifier)).toBeHidden();
  }
  const current = await audit(page);
  expect(current).toMatchObject({ tools: [], management: [], questions: 0, microphones: 0, searches: 0 });
  expect(current.commands.every(command => command === 'panel.set-expanded')).toBe(true);
});

test('面对面入口收起功能小屋，只保留桌宠、对话气泡和精简控制', async ({ page }, testInfo) => {
  await featureFixture(page);
  await page.locator('#feature-voice').click();
  await expect(page.locator('#pet-panel')).toBeHidden();
  await expect(page.locator('#pet-window')).toHaveClass(/is-voice-chat/);
  await expect(page.locator('#pet-voice-bubble')).toBeVisible();
  await expect(page.locator('#pet-voice-state')).toHaveText('正在听你说');
  await expect(page.locator('#pet-toggle')).toBeEnabled();
  await expect(page.locator('.dock-copy')).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new Event('test-feature-panel-open')));
  await expect(page.locator('#pet-panel')).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-feature-voice-update', { detail: {
    state: 'speaking', bubble: { user: '我今天有点累，陪我聊聊吧。', assistant: '我在这里陪着你。可以先放慢一点，和我说说今天发生了什么。' },
  } })));
  await page.setViewportSize({ width: 320, height: 500 });
  await expect(page.locator('#pet-voice-text')).toContainText('我在这里陪着你');
  await page.screenshot({ path: testInfo.outputPath('pet-voice-bubble.png'), omitBackground: true });
  await page.locator('#pet-voice-interrupt').click();
  await expect(page.locator('#pet-voice-state')).toHaveText('正在听你说');
  await page.locator('#pet-voice-mute').click();
  await expect(page.locator('#pet-voice-mute')).toHaveText('恢复麦克风');
  await expect(page.locator('#pet-voice-mute')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#pet-voice-mute').click();
  await expect(page.locator('#pet-voice-mute')).toHaveText('静音麦克风');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-feature-voice-update', { detail: {
    state: 'speaking', bubble: { user: '<img src=x onerror=alert(1)>', assistant: '<script>只是文字</script>。' + '长回答也应只在气泡内滚动。'.repeat(100) },
  } })));
  await expect(page.locator('#pet-voice-bubble script, #pet-voice-bubble img')).toHaveCount(0);
  for (const viewport of [{ width: 320, height: 500 }, { width: 330, height: 520 }, { width: 320, height: 360 }]) {
    await page.setViewportSize(viewport);
    const layout = await page.evaluate(() => {
      const bubble = document.getElementById('pet-voice-bubble')!.getBoundingClientRect();
      const pet = document.getElementById('pet-toggle')!.getBoundingClientRect();
      const end = document.getElementById('pet-voice-end')!.getBoundingClientRect();
      const text = document.getElementById('pet-voice-text')!;
      return { bubbleTop: bubble.top, bubbleBottom: bubble.bottom, petTop: pet.top, endBottom: end.bottom,
        endRight: end.right, viewportHeight: innerHeight, viewportWidth: innerWidth, scrolls: text.scrollHeight > text.clientHeight };
    });
    expect(layout.bubbleTop).toBeGreaterThanOrEqual(0);
    expect(layout.bubbleBottom).toBeLessThanOrEqual(layout.petTop);
    expect(layout.endBottom).toBeLessThanOrEqual(layout.viewportHeight);
    expect(layout.endRight).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.scrolls).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath('pet-voice-compact.png'), omitBackground: true });
  await page.locator('#pet-voice-end').click();
  await expect(page.locator('#pet-voice-bubble')).toBeHidden();
  await expect(page.locator('#pet-voice-controls')).toBeHidden();
  await expect(page.locator('#pet-voice-text')).toHaveText('');
  await expect(page.locator('#pet-panel')).toBeHidden();
  await expect(page.locator('#pet-toggle')).toBeEnabled();
  expect((await audit(page)).commands.filter(command => command.startsWith('voice.'))).toEqual(['voice.open', 'voice.interrupt', 'voice.mute', 'voice.unmute', 'voice.stop']);
  expect(await audit(page)).toMatchObject({ tools: [], management: [], questions: 0, microphones: 0, searches: 0 });
});

test('提问草稿跨功能保留，返回首页后搜索与观察不再堆叠', async ({ page }) => {
  await featureFixture(page);
  await page.locator('#feature-question').click();
  await page.locator('#question').fill('还没发送的草稿');
  await page.locator('#view-features').click();
  await page.locator('#feature-search').click();
  await page.locator('#search-query').fill('还没发送的搜索');
  await page.locator('#search-consent').check();
  await page.locator('#view-guidance').click();
  await expect(page.locator('#search-panel')).toBeHidden();
  await expect(page.locator('#question')).toHaveValue('还没发送的草稿');
  await expect(page.locator('#observation-section')).toBeHidden();
  await page.locator('#guidance-observation').click();
  await expect(page.locator('#lesson-card')).toBeHidden();
  await expect(page.locator('#question-form')).toBeHidden();
  await page.locator('#view-features').click();
  await page.locator('#feature-search').click();
  await expect(page.locator('#search-query')).toHaveValue('还没发送的搜索');
  await expect(page.locator('#search-consent')).not.toBeChecked();
  expect((await audit(page)).questions).toBe(0);
  expect((await audit(page)).searches).toBe(0);
});
