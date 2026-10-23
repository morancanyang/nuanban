// Shared "scaled analysis copy" helper.
//
// The model gateway rejects images over 2 MB and large uploads add seconds of latency, so both the
// continuous runtime and the single-frame guidance flow send a downscaled PNG copy when the sanitized
// frame is big. Callers must remap any pixel coordinates returned by the model back to the original
// frame (see single-frame-guidance.cjs) because the model sees the scaled image.
const ANALYSIS_IMAGE_LIMIT_BYTES = 1_400_000;
const PROVIDER_IMAGE_LIMIT_BYTES = 2_000_000;

function resolveNativeImage(provided) {
  if (provided && typeof provided.createFromBuffer === 'function') return provided;
  try {
    const electron = require('electron');
    return electron?.nativeImage;
  } catch {
    // Unit tests run without electron; they inject a resize hook instead of a nativeImage.
    return undefined;
  }
}

function createAnalysisImageScaler({ nativeImage: providedNativeImage, limitBytes = ANALYSIS_IMAGE_LIMIT_BYTES, maxDimension = 1600 } = {}) {
  const nativeImage = resolveNativeImage(providedNativeImage);
  return function scaleAnalysisImage(png) {
    if (!png || typeof png.length !== 'number' || png.length <= limitBytes) return null;
    if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function') return null;
    try {
      const image = nativeImage.createFromBuffer(png);
      const { width, height } = image.getSize();
      if (!width || !height) return null;
      let scale = Math.min(1, maxDimension / Math.max(width, height));
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const resized = image.resize({ width: Math.max(1, Math.round(width * scale)), quality: 'good' });
        const bytes = resized.toPNG();
        const size = resized.getSize();
        if (bytes.length <= limitBytes) return { image: { mime: 'image/png', bytes, width: size.width, height: size.height } };
        scale *= 0.78;
      }
      return null;
    } catch {
      return null;
    }
  };
}

module.exports = { createAnalysisImageScaler, ANALYSIS_IMAGE_LIMIT_BYTES, PROVIDER_IMAGE_LIMIT_BYTES };