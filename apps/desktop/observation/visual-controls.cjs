const { createHash } = require('node:crypto');
const { LIMITS, ObservationError, checkAborted } = require('./observation-common.cjs');

function overlaps(first, second) {
  return first.x < second.x + second.width && second.x < first.x + first.width
    && first.y < second.y + second.height && second.y < first.y + first.height;
}

function flatSurround(bitmap, width, rect) {
  const minimum = [255, 255, 255];
  const maximum = [0, 0, 0];
  for (let sample = 0; sample <= 8; sample += 1) {
    const horizontal = rect.x + Math.floor((rect.width - 1) * sample / 8);
    const vertical = rect.y + Math.floor((rect.height - 1) * sample / 8);
    for (const [column, row] of [[horizontal, rect.y], [horizontal, rect.y + rect.height - 1], [rect.x, vertical], [rect.x + rect.width - 1, vertical]]) {
      const offset = (row * width + column) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        minimum[channel] = Math.min(minimum[channel], bitmap[offset + channel]);
        maximum[channel] = Math.max(maximum[channel], bitmap[offset + channel]);
      }
    }
  }
  return maximum.every((value, channel) => value - minimum[channel] <= 40);
}

function fingerprint(bitmap, width, rect) {
  const hash = createHash('sha256').update(`${rect.width}:${rect.height}:`);
  for (let row = rect.y; row < rect.y + rect.height; row += 1) {
    hash.update(bitmap.subarray((row * width + rect.x) * 4, (row * width + rect.x + rect.width) * 4));
  }
  return hash.digest('hex');
}

function extractVisualControls({ bitmap, width, height, exclusions = [], signal } = {}) {
  checkAborted(signal);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > LIMITS.maxDimension || height > LIMITS.maxDimension || width * height > LIMITS.maxPixels
    || !Buffer.isBuffer(bitmap) || bitmap.length !== width * height * 4
    || !Array.isArray(exclusions) || exclusions.length > 8704 || exclusions.some(rect => !rect
      || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.x < 0 || rect.y < 0
      || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > width || rect.y + rect.height > height)) {
    throw new ObservationError('visual_input_invalid');
  }
  const stride = Math.max(1, Math.ceil(Math.max(width, height) / 1600));
  const columns = Math.ceil(width / stride);
  const rows = Math.ceil(height / stride);
  const pixels = columns * rows;
  const colors = Buffer.alloc(pixels * 3);
  const blocked = Buffer.alloc(pixels);
  const edges = Buffer.alloc(pixels);
  const components = Buffer.alloc(pixels);
  const queue = new Int32Array(pixels);
  try {
    for (const rect of exclusions) {
      const left = Math.max(0, Math.floor(rect.x / stride) - 2);
      const right = Math.min(columns, Math.ceil((rect.x + rect.width) / stride) + 2);
      const top = Math.max(0, Math.floor(rect.y / stride) - 2);
      const bottom = Math.min(rows, Math.ceil((rect.y + rect.height) / stride) + 2);
      for (let row = top; row < bottom; row += 1) blocked.fill(1, row * columns + left, row * columns + right);
    }
    for (let row = 0; row < rows; row += 1) {
      if (row % 64 === 0) checkAborted(signal);
      for (let column = 0; column < columns; column += 1) {
        const offset = ((row * stride) * width + column * stride) * 4;
        const sampled = (row * columns + column) * 3;
        colors[sampled] = bitmap[offset];
        colors[sampled + 1] = bitmap[offset + 1];
        colors[sampled + 2] = bitmap[offset + 2];
      }
    }
    for (let row = 1; row < rows - 1; row += 1) {
      if (row % 64 === 0) checkAborted(signal);
      for (let column = 1; column < columns - 1; column += 1) {
        const index = row * columns + column;
        if (blocked[index] || blocked[index + 1] || blocked[index + columns]) continue;
        const offset = index * 3;
        let contrast = 0;
        for (let channel = 0; channel < 3; channel += 1) {
          contrast = Math.max(contrast, Math.abs(colors[offset + channel] - colors[offset + 3 + channel]),
            Math.abs(colors[offset + channel] - colors[offset + columns * 3 + channel]));
        }
        if (contrast >= 32) edges[index] = 1;
      }
    }
    for (let row = 1; row < rows - 1; row += 1) {
      for (let column = 1; column < columns - 1; column += 1) {
        if (!edges[row * columns + column]) continue;
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            const neighbor = (row + offsetY) * columns + column + offsetX;
            if (!blocked[neighbor]) components[neighbor] = 1;
          }
        }
      }
    }
    const candidates = [];
    const gridCandidates = [];
    const maximumSize = Math.min(192, Math.max(48, Math.min(width, height) * 0.18));
    for (let start = 0; start < pixels; start += 1) {
      if (start % 65536 === 0) checkAborted(signal);
      if (!components[start]) continue;
      let left = columns;
      let right = 0;
      let top = rows;
      let bottom = 0;
      let head = 0;
      let tail = 1;
      queue[0] = start;
      components[start] = 0;
      while (head < tail) {
        if (head % 65536 === 0) checkAborted(signal);
        const index = queue[head++];
        const row = Math.floor(index / columns);
        const column = index % columns;
        left = Math.min(left, column);
        right = Math.max(right, column);
        top = Math.min(top, row);
        bottom = Math.max(bottom, row);
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            const adjacentX = column + offsetX;
            const adjacentY = row + offsetY;
            if (adjacentX < 0 || adjacentX >= columns || adjacentY < 0 || adjacentY >= rows) continue;
            const neighbor = adjacentY * columns + adjacentX;
            if (!components[neighbor]) continue;
            components[neighbor] = 0;
            queue[tail++] = neighbor;
          }
        }
      }
      const rect = { x: (left - 2) * stride, y: (top - 2) * stride,
        width: (right - left + 5) * stride, height: (bottom - top + 5) * stride };
      if (rect.x < 0 || rect.y < 0 || rect.x + rect.width >= width || rect.y + rect.height >= height
        || rect.width < 10 || rect.height < 10 || rect.width > maximumSize || rect.height > maximumSize
        || rect.width / rect.height < 0.3 || rect.width / rect.height > 3
        || exclusions.some(excluded => overlaps(rect, excluded))) continue;
      if (flatSurround(bitmap, width, rect)) {
        if (candidates.length < 2048) candidates.push(rect);
        continue;
      }
      // 壁纸/照片背景上的桌面快捷方式四周不是纯色，flatSurround 会否掉它们，用户因此只会看到
      // "尚未识别出入口"。额外收集"图标网格"候选，但只在与至少一个同列、同尺寸量级且间距像图标
      // 网格的邻居成对出现时才接受，避免把整片照片纹理当成按钮。
      if (rect.width >= 16 && rect.height >= 16 && gridCandidates.length < 512) gridCandidates.push(rect);
    }
    const alignedPeers = candidate => gridCandidates.filter(other => other !== candidate
      && Math.abs(other.x + other.width / 2 - candidate.x - candidate.width / 2) <= Math.max(6, candidate.width / 3)
      && other.width >= candidate.width / 2 && other.width <= candidate.width * 2
      && Math.abs(other.y - candidate.y) >= Math.min(other.height, candidate.height) * 0.8
      && Math.abs(other.y - candidate.y) <= Math.max(other.height, candidate.height) * 8).length;
    const gridAccepted = gridCandidates.filter(candidate => alignedPeers(candidate) >= 1
      || candidates.some(flat => Math.abs(flat.x + flat.width / 2 - candidate.x - candidate.width / 2) <= Math.max(6, candidate.width / 3)
        && flat.width >= candidate.width / 2 && flat.width <= candidate.width * 2));
    const all = [...candidates, ...gridAccepted].slice(0, 2048);
    const ranked = all.map(rect => ({ rect, alignment: all.filter(other => other !== rect
      && Math.abs(other.x + other.width / 2 - rect.x - rect.width / 2) <= Math.max(6, rect.width / 3)
      && other.width >= rect.width / 2 && other.width <= rect.width * 2
      && Math.abs(other.y - rect.y) <= Math.max(rect.height, other.height) * 8).length }));
    ranked.sort((first, second) => Math.min(6, second.alignment) - Math.min(6, first.alignment)
      || first.rect.y - second.rect.y || first.rect.x - second.rect.x);
    checkAborted(signal);
    return ranked.slice(0, 48).sort((first, second) => first.rect.y - second.rect.y || first.rect.x - second.rect.x)
      .map(({ rect }) => ({ label: '未标注图标', surface: 'visual', rect, appearance: fingerprint(bitmap, width, rect) }));
  } finally {
    colors.fill(0);
    blocked.fill(0);
    edges.fill(0);
    components.fill(0);
    queue.fill(0);
  }
}

function matchesVisualControl(original, current) {
  if (original.surface !== 'visual' && current.surface !== 'visual') return true;
  return original.surface === 'visual' && current.surface === 'visual'
    && typeof original.appearance === 'string' && /^[a-f0-9]{64}$/.test(original.appearance)
    && original.appearance === current.appearance
    && ['width', 'height'].every(key => Math.abs(original.rect[key] - current.rect[key]) <= 4);
}

module.exports = { extractVisualControls, matchesVisualControl };
