const { randomUUID } = require('node:crypto');
const { SearchError, searchFailure, validateSearchQuery, publicResultUrl, projectResults, projectModelAnswer } = require('./pet-search-common.cjs');
const { createModelSearchClient } = require('./model-search-client.cjs');

function registerPetSearchBridge({ ipcMain, isTrusted, showSearch, openExternal, client = createModelSearchClient() }) {
  let generation = 0;
  let controller = null;
  let disposed = false;
  let sources = new Map();
  const channels = [];

  function cancel() {
    generation += 1;
    controller?.abort();
    controller = null;
    sources.clear();
  }

  function payloadOnly(payload, fields) {
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      && Object.keys(payload).length === fields.length && fields.every(field => Object.hasOwn(payload, field));
  }

  function handle(name, action, count = 0) {
    const channel = `nuanban:pet-search:${name}`;
    channels.push(channel);
    ipcMain.handle(channel, (event, ...argumentsList) => {
      if (disposed || !isTrusted(event)) throw new Error('不可信搜索来源');
      if (argumentsList.length !== count) throw new Error('搜索参数无效');
      return action(...argumentsList);
    });
  }

  handle('status', () => { const current = client.status(); return { provider: current.provider, configured: current.configured === true, webSearch: current.webSearch === true }; });
  handle('show', () => { showSearch(); return { ok: true }; });
  handle('cancel', () => { cancel(); return { ok: true }; });
  handle('run', async payload => {
    if (!payloadOnly(payload, ['query', 'consent'])) return searchFailure(new SearchError('SEARCH_INVALID_QUERY'));
    if (payload.consent !== true) return searchFailure(new SearchError('SEARCH_CONSENT_REQUIRED'));
    let query;
    try { query = validateSearchQuery(payload.query); } catch (error) { return searchFailure(error); }
    cancel();
    const requestGeneration = generation;
    const requestController = new AbortController();
    controller = requestController;
    try {
      const result = await client.search(query, { signal: requestController.signal });
      const response = Array.isArray(result) ? { results: projectResults(result) } : projectModelAnswer(result);
      if (disposed || requestController.signal.aborted || requestGeneration !== generation) throw new SearchError('SEARCH_CANCELLED');
      const view = response.results.map(item => ({ id: randomUUID(), ...item }));
      sources = new Map(view.map(item => [item.id, item.url]));
      return { ok: true, query, ...response, results: view };
    } catch (error) {
      return searchFailure(disposed || requestController.signal.aborted || requestGeneration !== generation ? new SearchError('SEARCH_CANCELLED') : error);
    } finally {
      if (controller === requestController) controller = null;
    }
  }, 1);
  handle('open-source', async payload => {
    if (!payloadOnly(payload, ['id']) || typeof payload.id !== 'string') throw new Error('搜索来源无效');
    const url = sources.get(payload.id);
    if (!url || !publicResultUrl(url) || typeof openExternal !== 'function') throw new Error('来源已失效，请重新搜索');
    try { await openExternal(url); } catch { throw new Error('来源未打开，请稍后重试'); }
    return { ok: true };
  }, 1);

  return { cancel, show() { if (!disposed) showSearch(); }, dispose() { disposed = true; cancel(); for (const channel of channels.splice(0)) ipcMain.removeHandler(channel); } };
}

module.exports = { registerPetSearchBridge };
