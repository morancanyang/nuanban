const fs = require('node:fs');
const path = require('node:path');

// Owner-controlled privacy switches for screen observation. The file lives in the Electron userData
// directory (outside the repository) and is intentionally tiny and synchronous.
function createPrivacySettings({ userDataPath } = {}) {
  if (typeof userDataPath !== 'string' || !userDataPath.trim()) throw new Error('privacy_settings_path_required');
  const file = path.join(userDataPath, 'privacy-settings.json');
  let cache = null;

  function normalize(source) {
    // Owner-only switches on a single-machine install: raw frames plus "do not stop for restricted
    // words". `unredactedUpload` alone cannot relax the restricted-text filter, so the two stay
    // separate and the combined mode is derived.
    const unredactedUpload = source?.unredactedUpload === true;
    const relaxedSafety = source?.relaxedSafety === true;
    return Object.freeze({ version: 1, unredactedUpload, maskedFrameUpload: !unredactedUpload,
      relaxedSafety, maxPermissions: unredactedUpload && relaxedSafety });
  }

  function read() {
    if (cache) return cache;
    try { cache = normalize(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch { cache = normalize(undefined); }
    return cache;
  }

  function write(next) {
    const current = read();
    const value = normalize({
      unredactedUpload: next?.unredactedUpload === undefined ? current.unredactedUpload : next.unredactedUpload === true,
      relaxedSafety: next?.relaxedSafety === undefined ? current.relaxedSafety : next.relaxedSafety === true,
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, unredactedUpload: value.unredactedUpload, relaxedSafety: value.relaxedSafety }), { encoding: 'utf8' });
    cache = value;
    return value;
  }

  return Object.freeze({ read, write, file });
}

module.exports = { createPrivacySettings };