// 星云实时对话的麦克风权限闸门。
//
// 默认会话在 main.cjs 中原本一律拒绝权限。实时对话需要 Chromium 的 `navigator.mediaDevices.getUserMedia`
// 采集麦克风，因此这里提供一个作用域极窄的替代实现：只有“本人已在本机显式开启对话”的那一次会话、
// 那个桌宠窗口、那个页面、且只针对 `media`（音频）时才放行；其他窗口、其他权限、停止后的迟到请求一律拒绝。
// 对话标志由会话生命周期驱动，停止、销毁、退出或窗口消失时立即撤销。

const ALLOWED_PERMISSION = 'media';
const ALLOWED_MEDIA_TYPES = new Set(['audio', 'unknown']);

function declaredMediaTypes(details) {
  const declared = [];
  if (Array.isArray(details?.mediaTypes)) declared.push(...details.mediaTypes);
  if (typeof details?.mediaType === 'string') declared.push(details.mediaType);
  return declared.filter(type => typeof type === 'string');
}

function createXingyunConversationPermissionGuard() {
  let generation = 0;
  let armedGeneration = 0;
  let allowedContents;
  let allowedUrl = '';

  function armed() {
    return armedGeneration !== 0 && armedGeneration === generation;
  }

  function arm(contents) {
    if (!contents || typeof contents.getURL !== 'function' || contents.isDestroyed?.() === true) throw new Error('桌宠窗口不可用，无法授权实时对话麦克风。');
    const url = contents.getURL();
    if (typeof url !== 'string' || !url) throw new Error('桌宠页面地址无效，无法授权实时对话麦克风。');
    generation += 1;
    armedGeneration = generation;
    allowedContents = contents;
    allowedUrl = url;
    return armedGeneration;
  }

  function disarm(token) {
    if (token !== undefined && token !== armedGeneration) return false;
    generation += 1;
    armedGeneration = 0;
    allowedContents = undefined;
    allowedUrl = '';
    return true;
  }

  function allows(contents, permission, details) {
    if (!armed() || !allowedContents || contents !== allowedContents || permission !== ALLOWED_PERMISSION) return false;
    try {
      if (allowedContents.isDestroyed() || allowedContents.getURL() !== allowedUrl) return false;
    } catch { return false; }
    if (details?.isMainFrame === false) return false;
    if (details?.requestingUrl !== undefined && details.requestingUrl !== allowedUrl) return false;
    return declaredMediaTypes(details).every(type => ALLOWED_MEDIA_TYPES.has(type));
  }

  function install(session) {
    if (!session || typeof session.setPermissionCheckHandler !== 'function' || typeof session.setPermissionRequestHandler !== 'function') throw new Error('当前运行时无法接管权限请求。');
    session.setPermissionCheckHandler((contents, permission, _origin, details) => allows(contents, permission, details));
    session.setPermissionRequestHandler((contents, permission, callback, details) => {
      let decision = false;
      try { decision = allows(contents, permission, details); } catch { decision = false; }
      callback(decision);
    });
    // 屏幕采集与实时对话无关，始终拒绝，避免默认会话出现任何隐式放行。
    if (typeof session.setDisplayMediaRequestHandler === 'function') session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    return { dispose: () => disarm() };
  }

  return Object.freeze({ arm, disarm, armed, allows, install });
}

module.exports = { createXingyunConversationPermissionGuard, ALLOWED_PERMISSION, ALLOWED_MEDIA_TYPES };