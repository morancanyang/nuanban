// UIA 的 BoundingRectangle 在本机 DPI 上下文里是**物理像素**；指引窗口用的是 DIP。
// 物理原点必须能被证明（dipToScreenRect 或 nativeOrigin），否则不换算、不画箭头（fail closed）。
function physicalBounds(display, screen) {
  try {
    if (typeof screen?.dipToScreenRect === 'function') {
      const mapped = screen.dipToScreenRect(null, display.bounds);
      if (mapped && Number.isFinite(mapped.x) && Number.isFinite(mapped.y) && mapped.width > 0 && mapped.height > 0) return mapped;
    }
  } catch {}
  const origin = display.nativeOrigin;
  const scale = Number.isFinite(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 0;
  if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y) && scale > 0) {
    return { x: origin.x, y: origin.y, width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) };
  }
  return null;
}

function physicalToDipRect(rect, { screen } = {}) {
  if (!rect || !['x', 'y', 'width', 'height'].every(field => Number.isFinite(rect[field])) || rect.width <= 0 || rect.height <= 0) return null;
  const displays = typeof screen?.getAllDisplays === 'function' ? screen.getAllDisplays() : [];
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  for (const display of displays) {
    const physical = physicalBounds(display, screen);
    if (!physical) continue;
    if (centerX < physical.x || centerY < physical.y || centerX > physical.x + physical.width || centerY > physical.y + physical.height) continue;
    const scale = Number.isFinite(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1;
    return Object.freeze({ x: display.bounds.x + (rect.x - physical.x) / scale, y: display.bounds.y + (rect.y - physical.y) / scale,
      width: rect.width / scale, height: rect.height / scale, displayId: String(display.id ?? '') });
  }
  return null;
}

module.exports = { physicalBounds, physicalToDipRect };