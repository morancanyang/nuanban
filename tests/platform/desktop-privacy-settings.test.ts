import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const { createPrivacySettings } = createRequire(import.meta.url)('../../apps/desktop/privacy-settings.cjs') as {
  createPrivacySettings(options: { userDataPath: string }): {
    read(): { unredactedUpload: boolean; maskedFrameUpload: boolean; relaxedSafety: boolean; maxPermissions: boolean };
    write(next: { unredactedUpload?: boolean; relaxedSafety?: boolean }): unknown;
    file: string;
  };
};

const directories: string[] = [];
function settingsFile() {
  const directory = mkdtempSync(join(tmpdir(), 'nuanban-privacy-'));
  directories.push(directory);
  return join(directory, 'privacy-settings.json');
}

describe('本机隐私开关与最大权限模式（合成单测）', () => {
  it('默认开启本机遮盖且不跳过敏感词，缺少文件时也保持默认', () => {
    const file = settingsFile();
    const settings = createPrivacySettings({ userDataPath: join(file, '..') });
    expect(settings.read()).toEqual({ version: 1, unredactedUpload: false, maskedFrameUpload: true, relaxedSafety: false, maxPermissions: false });
  });

  it('最大权限同时持久化两个开关，单项更新不会清掉另一项', () => {
    const file = settingsFile();
    const settings = createPrivacySettings({ userDataPath: join(file, '..') });
    settings.write({ unredactedUpload: true, relaxedSafety: true });
    expect(settings.read()).toMatchObject({ unredactedUpload: true, relaxedSafety: true, maxPermissions: true });
    settings.write({ unredactedUpload: false });
    expect(settings.read()).toMatchObject({ unredactedUpload: false, relaxedSafety: true, maxPermissions: false });
    settings.write({ relaxedSafety: false });
    expect(settings.read()).toMatchObject({ unredactedUpload: false, relaxedSafety: false, maxPermissions: false });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, unredactedUpload: false, relaxedSafety: false });
    rmSync(join(file, '..'), { recursive: true, force: true });
  });
});