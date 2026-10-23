import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createCaptureVisibility, contentProtectionRequired, PROTECT_ALL_FLAG } = require('../../apps/desktop/capture-visibility.cjs');

describe('截图与录屏可见性策略', () => {
  it('默认允许桌宠与管理界面被截图和录屏捕获', () => {
    const visibility = createCaptureVisibility(['electron.exe', '--management']);
    expect(visibility).toEqual({ petVisible: true, clientVisible: true });
    expect(contentProtectionRequired([], 'pet')).toBe(false);
    expect(contentProtectionRequired([], 'client')).toBe(false);
  });

  it('--protect-pet 只保护桌宠侧窗口，管理界面仍可捕获', () => {
    expect(createCaptureVisibility(['--protect-pet'])).toEqual({ petVisible: false, clientVisible: true });
    expect(contentProtectionRequired(['--protect-pet'], 'pet')).toBe(true);
    expect(contentProtectionRequired(['--protect-pet'], 'client')).toBe(false);
  });

  it('--protect-client 只保护管理界面，桌宠仍可捕获', () => {
    expect(createCaptureVisibility(['--protect-client'])).toEqual({ petVisible: true, clientVisible: false });
  });

  it('--protect-display 恢复全部保护，且忽略旧的可捕获别名', () => {
    expect(PROTECT_ALL_FLAG).toBe('--protect-display');
    expect(createCaptureVisibility(['--protect-display', '--pet-display-compatible', '--client-display-compatible']))
      .toEqual({ petVisible: false, clientVisible: false });
  });

  it('旧的可捕获别名保持可见语义', () => {
    expect(createCaptureVisibility(['--pet-display-compatible', '--client-display-compatible']))
      .toEqual({ petVisible: true, clientVisible: true });
    expect(createCaptureVisibility(['--pet-display-compatible'])).toEqual({ petVisible: true, clientVisible: true });
  });

  it('客户端主进程与启动脚本按同一策略接线', () => {
    const main = readFileSync(new URL('../../apps/desktop/main.cjs', import.meta.url), 'utf8');
    expect(main).toContain('createCaptureVisibility(process.argv)');
    expect(main).toContain('displayCompatible: captureVisibility.clientVisible');
    expect(main).toContain('petDisplayCompatible: captureVisibility.petVisible');
    expect(main).toContain("--protect-pet");
    expect(main).toContain("--protect-client");
    const script = readFileSync(new URL('../../scripts/start-desktop-client.ps1', import.meta.url), 'utf8');
    expect(script).toContain("if ($ProtectPet) { $launchArguments += '--protect-pet' }");
    expect(script).not.toContain("'--pet-display-compatible'");
  });
});