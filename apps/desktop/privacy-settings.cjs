const fs = require('node:fs');
const path = require('node:path');

// Owner-controlled privacy switches for screen observation. The file lives in the Electron userData
// directory (outside the repository) and is intentionally tiny and synchronous.
function createPrivacySettings({ userDataPath } = {}) {
  if (typeof userDataPath !== 'string' || !userDataPath.trim()) throw new Error('privacy_settings_path_required');
  const file = path.join(userDataPath, 'privacy-settings.json');
  let cache = null;

  function read() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = Object.freeze({ version: 1, unredactedUpload: parsed?.unredactedUpload === true, maskedFrameUpload: parsed?.unredactedUpload !== true });
    } catch {
      cache = Object.freeze({ version: 1, unredactedUpload: false, maskedFrameUpload: true });
    }
    return cache;
  }

  function write(next) {
    const value = Object.freeze({ version: 1, unredactedUpload: next?.unredactedUpload === true, maskedFrameUpload: next?.unredactedUpload !== true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), { encoding: 'utf8' });
    cache = value;
    return value;
  }

  return Object.freeze({ read, write, file });
}

module.exports = { createPrivacySettings };