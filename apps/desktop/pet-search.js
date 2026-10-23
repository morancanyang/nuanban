(() => {
  'use strict';

  const api = window.nuanbanSearch;
  const element = name => document.getElementById(name);
  const query = element('search-query');
  const consent = element('search-consent');
  const removers = [];
  let configured = false;
  let busy = false;
  let checking = false;
  let disposed = false;
  let generation = 0;
  let statusGeneration = 0;
  let unsubscribe;

  function bind(target, event, handler) {
    target.addEventListener(event, handler);
    removers.push(() => target.removeEventListener(event, handler));
  }

  function render() {
    element('submit-search').disabled = busy || checking || !configured || !consent.checked || !query.value.trim();
    element('submit-search').textContent = busy ? '正在查询…' : '请模型回答';
    element('cancel-search').disabled = !busy;
    query.readOnly = busy;
    consent.disabled = busy;
  }

  function error(message) {
    element('search-error').textContent = message;
    element('search-error').hidden = !message;
  }

  async function show() {
    if (disposed) return;
    if (!element('search-panel').hidden) {
      query.focus({ preventScroll: true });
      return;
    }
    element('search-panel').hidden = false;
    window.dispatchEvent(new CustomEvent('nuanban:pet:navigate', { detail: { section: 'search' } }));
    element('search-panel').scrollIntoView({ block: 'start', behavior: 'instant' });
    query.focus({ preventScroll: true });
    const current = ++statusGeneration;
    checking = true;
    render();
    try {
      if (typeof api?.status !== 'function') throw new Error('unavailable');
      const status = await api.status();
      if (disposed || current !== statusGeneration) return;
      if (!status || status.provider !== 'ConfiguredModel' || typeof status.configured !== 'boolean') throw new Error('invalid');
      configured = status.configured;
      element('search-configuration').textContent = configured ? '已复用现有模型 · 无需 AnySearch 密钥；回答不代表已联网核验' : '本机模型尚未就绪 · 请检查已有模型配置，不会展示模拟回答';
    } catch {
      if (disposed || current !== statusGeneration) return;
      configured = false;
      element('search-configuration').textContent = '搜索接口尚未就绪，请更新并重新启动桌宠。';
    } finally {
      if (!disposed && current === statusGeneration) { checking = false; render(); }
    }
  }

  async function open() {
    error('');
    try {
      if (typeof api?.open !== 'function') throw new Error('unavailable');
      await api.open();
    } catch {
      if (disposed) return;
      await show();
      error('查询面板未连接到桌宠核心；未发送问题。');
    }
  }

  function showResults(reply) {
    if (!reply || reply.ok !== true || typeof reply.query !== 'string' || reply.query.length > 500
      || !Array.isArray(reply.results) || reply.results.length > 10) throw new Error('invalid');
    if (reply.kind === 'model-answer') {
      if (reply.webSearch !== false || reply.results.length || typeof reply.answer !== 'string'
        || !reply.answer.trim() || reply.answer.length > 24000) throw new Error('invalid');
      element('search-answer-content').textContent = reply.answer;
      element('search-answer').hidden = false;
      element('search-results').replaceChildren();
      element('search-results').hidden = true;
      element('search-progress').textContent = '已由现有模型回答，未进行网页检索或实时核验。';
      return;
    }
    if (reply.kind !== undefined || reply.answer !== undefined || reply.webSearch !== undefined) throw new Error('invalid');
    const fragment = document.createDocumentFragment();
    for (const item of reply.results) {
      if (!item || !['id', 'title', 'url', 'snippet', 'source'].every(field => typeof item[field] === 'string')
        || item.id.length > 80 || item.title.length > 200 || item.url.length > 2048 || item.snippet.length > 1200 || item.source.length > 253) throw new Error('invalid');
      const result = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-source';
      button.textContent = `${item.title} ↗`;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const opened = await api.openSource(item.id);
          if (!opened || opened.ok !== true) throw new Error('not_opened');
        } catch { if (!disposed) error('来源未打开或已失效。请重新搜索后再选择，不会自动打开其他地址。'); }
        finally { if (!disposed) button.disabled = false; }
      });
      const snippet = document.createElement('p');
      snippet.textContent = item.snippet || '此来源未提供摘要，请打开原文核对。';
      const source = document.createElement('small');
      source.textContent = item.url;
      result.append(button, snippet, source);
      fragment.append(result);
    }
    element('search-results').replaceChildren(fragment);
    element('search-results').hidden = reply.results.length === 0;
    element('search-progress').textContent = reply.results.length ? `“${reply.query}” · 找到 ${reply.results.length} 条来源` : '没有找到可展示的安全来源。可以换个说法再搜，不会用模拟内容填充。';
  }

  function clearResults() {
    element('search-results').replaceChildren();
    element('search-results').hidden = true;
    element('search-answer-content').textContent = '';
    element('search-answer').hidden = true;
  }

  function restoreQueryFocus() {
    if (disposed || element('search-panel').hidden || !document.hasFocus()) return;
    if ([query, element('submit-search'), element('cancel-search'), document.body].includes(document.activeElement)) query.focus({ preventScroll: true });
  }

  async function search() {
    if (disposed || busy || checking || !configured || !consent.checked || !query.value.trim()) return;
    const current = ++generation;
    busy = true;
    error('');
    clearResults();
    element('search-progress').textContent = '正在请求已配置的模型…';
    render();
    try {
      const reply = await api.search(query.value.trim(), true);
      if (disposed || current !== generation) return;
      if (reply?.ok === false) {
        element('search-progress').textContent = '';
        error(typeof reply.message === 'string' && reply.message.length <= 200 ? reply.message : '搜索未完成，请稍后手动重试。');
      } else showResults(reply);
    } catch {
      if (disposed || current !== generation) return;
      element('search-progress').textContent = '';
      error('搜索未完成或返回内容无法使用，请稍后手动重试。');
    } finally {
      if (!disposed && current === generation) { busy = false; render(); restoreQueryFocus(); }
    }
  }

  async function cancel() {
    generation += 1;
    busy = false;
    render();
    clearResults();
    element('search-progress').textContent = '查询已停止，不会自动重新发送。';
    restoreQueryFocus();
    try { await api.cancel(); }
    catch { if (!disposed) error('停止请求尚未确认，请退出桌宠；迟到的结果不会显示。'); }
  }

  bind(element('pet-search'), 'click', () => { void open(); });
  bind(element('view-search'), 'click', () => { void open(); });
  bind(element('feature-search'), 'click', () => { void open(); });
  bind(element('search-form'), 'submit', event => { event.preventDefault(); void search(); });
  bind(query, 'input', render);
  bind(consent, 'change', render);
  bind(query, 'keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void search(); }
  });
  bind(element('cancel-search'), 'click', () => { void cancel(); });
  bind(window, 'nuanban:pet:view-changed', event => {
    if (event.detail?.section === 'search') { void show(); return; }
    if (element('search-panel').hidden) return;
    statusGeneration += 1;
    checking = false;
    consent.checked = false;
    element('search-panel').hidden = true;
    if (busy) void cancel();
    render();
  });
  bind(element('hide-search'), 'click', () => {
    void cancel();
    consent.checked = false;
    element('search-panel').hidden = true;
    window.dispatchEvent(new CustomEvent('nuanban:pet:navigate', { detail: { section: 'features' } }));
    element('view-features').focus({ preventScroll: true });
  });
  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    statusGeneration += 1;
    for (const remove of removers.splice(0)) remove();
    unsubscribe?.();
    try { Promise.resolve(api?.cancel()).catch(() => {}); } catch {}
  }
  bind(window, 'pagehide', dispose);
  bind(window, 'beforeunload', dispose);
  if (typeof api?.onOpen === 'function') unsubscribe = api.onOpen(() => { void show(); });
  render();
})();
