function createManagementWindowVisibility(options = {}) {
  let displayCompatible = options.displayCompatible === true;
  let captureActive;
  const protection = new WeakMap();
  const live = window => Boolean(window && !window.isDestroyed());

  function syncProtection(window) {
    if (!live(window)) return;
    const required = !displayCompatible || captureActive !== false;
    if (protection.get(window) === required) return;
    window.setContentProtection(required);
    protection.set(window, required);
  }

  function updateObservation(observation, window) {
    captureActive = observation?.captureActive;
    syncProtection(window);
  }

  function setCompatibility(window, compatible) {
    displayCompatible = compatible === true;
    syncProtection(window);
  }

  function enableCompatibility(window) {
    setCompatibility(window, true);
  }

  async function show(window, { route = '/', ready } = {}) {
    if (!live(window)) throw new Error('管理窗口未就绪');
    syncProtection(window);
    window.setTitle('微光指引 · 管理中心');
    if (window.isMinimized()) window.restore();
    window.setSkipTaskbar(false);
    window.show();
    window.moveTop();
    window.focus();
    await ready;
    if (!live(window) || window.webContents.isDestroyed()) throw new Error('管理窗口已关闭');
    await window.webContents.executeJavaScript(`window.location.hash = ${JSON.stringify(route)};`, true);
    return true;
  }

  return { syncProtection, updateObservation, enableCompatibility, setCompatibility, show };
}

module.exports = { createManagementWindowVisibility };
