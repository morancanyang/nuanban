const fs = require('node:fs');
const path = require('node:path');

// Persisted switch for the owner-approved cloud dictation mode. Default is off: uploading audio is a
// privacy boundary change and must stay opt-in. This file holds no secret and no audio.
function createCloudDictationSettings({ userDataPath }) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) throw new TypeError('cloud_dictation_settings_path_invalid');
  const filePath = path.join(userDataPath, 'nuanban-cloud-dictation.json');

  function read() {
    try {
      const details = fs.lstatSync(filePath);
      if (!details.isFile() || details.size < 2 || details.size > 4096) return { enabled: false };
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { enabled: parsed?.enabled === true };
    } catch { return { enabled: false }; }
  }

  function write({ enabled } = {}) {
    if (typeof enabled !== 'boolean') throw new TypeError('cloud_dictation_settings_invalid');
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, enabled }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    return { enabled };
  }

  return Object.freeze({ filePath, read, write });
}

module.exports = { createCloudDictationSettings };