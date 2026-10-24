const { createAnySearchClient } = require('./anysearch-client.cjs');
const { createModelSearchClient } = require('./model-search-client.cjs');
const { SearchError } = require('./pet-search-common.cjs');

// 桌宠智能查询的供应选择：配置了 AnySearch 密钥就用真实网页检索（可核验来源、实时信息）；
// 没有密钥时退回本机已配置模型，并如实标注“未联网核验”。AnySearch 已配置但调用失败时直接报错，
// 不静默改走模型，避免把模型生成的内容冒充检索结果。
function createPetSearchClient({ anySearch, model } = {}) {
  function status() {
    const live = anySearch?.status?.() ?? {};
    if (live.configured === true) return { provider: 'AnySearch', configured: true, webSearch: true };
    const fallback = model?.status?.() ?? {};
    return { provider: 'ConfiguredModel', configured: fallback.configured === true, webSearch: false };
  }

  async function search(value, { signal } = {}) {
    const current = status();
    if (current.webSearch) return anySearch.search(value, { signal });
    if (current.configured !== true) throw new SearchError('SEARCH_NOT_CONFIGURED');
    return model.search(value, { signal });
  }

  return Object.freeze({ status, search });
}

module.exports = { createPetSearchClient, createAnySearchClient, createModelSearchClient };