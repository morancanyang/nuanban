import { expect, test, type Page } from '@playwright/test';

async function installVoiceFixture(page: Page, mode: 'normal' | 'cancel' | 'unavailable' | 'pending' | 'dictation-cancel' | 'dictation-pending' | 'dictation-error' | 'dictation-uncertain' = 'normal') {
  await page.addInitScript(mode => {
    let state = { phase: 'disabled' as string, enabled: false, microphoneActive: false, dictationAvailable: true, localOnly: true as const, message: '本地语音未开启' };
    let lateEnable: (() => void) | undefined;
    let lateDictation: (() => void) | undefined;
    const stopDictation = () => {
      state = { ...state, phase: 'disabled', enabled: false, microphoneActive: false, message: '本次麦克风已关闭' };
      lateDictation?.();
      lateDictation = undefined;
    };
    window.addEventListener('test-finish-dictation', stopDictation);
    window.nuanbanVoice = {
      status: async () => { sessionStorage.setItem('voice-status-read', String(Number(sessionStorage.getItem('voice-status-read') || '0') + 1)); return { ...state } as Awaited<ReturnType<NonNullable<Window['nuanbanVoice']>['status']>>; },
      dictate: async () => {
        sessionStorage.setItem('voice-dictation-count', String(Number(sessionStorage.getItem('voice-dictation-count') || '0') + 1));
        if (mode === 'dictation-cancel') return { status: 'cancelled', localOnly: true };
        if (mode === 'dictation-error') {
          state = { ...state, phase: 'error', message: '20 秒内未识别到完整语句，请检查默认麦克风。' };
          throw new Error('synthetic dictation timeout');
        }
        state = { ...state, phase: 'question', enabled: true, microphoneActive: true, message: '正在本机听写，请直接说话。' };
        if (mode === 'dictation-uncertain') {
          stopDictation();
          return { status: 'uncertain' as const, localOnly: true as const, microphoneActive: false as const };
        }
        const result = { status: 'complete' as const, text: '教我在浏览器里收藏网页', localOnly: true as const, microphoneActive: false as const };
        if (mode === 'dictation-pending') return new Promise(resolve => { lateDictation = () => resolve(result); });
        stopDictation();
        return result;
      },
      cancelDictation: async () => {
        sessionStorage.setItem('voice-dictation-cancel-count', String(Number(sessionStorage.getItem('voice-dictation-cancel-count') || '0') + 1));
        stopDictation();
        return true;
      },
      enable: async () => {
        sessionStorage.setItem('voice-enable-count', String(Number(sessionStorage.getItem('voice-enable-count') || '0') + 1));
        if (mode === 'cancel') return { ...state, phase: 'disabled' };
        if (mode === 'unavailable') { state = { ...state, phase: 'unavailable', message: '本机缺少离线中文语音引擎；没有改用云端常听。' }; throw new Error('synthetic engine unavailable'); }
        if (mode === 'pending') return new Promise(resolve => { lateEnable = () => resolve({ ...state, phase: 'listening', enabled: true, microphoneActive: true }); });
        state = { ...state, phase: 'listening', enabled: true, microphoneActive: true, message: '本机监听中，说微光指引后在桌宠提问。' };
        return { ...state, phase: 'listening' };
      },
      disable: async () => {
        sessionStorage.setItem('voice-disable-count', String(Number(sessionStorage.getItem('voice-disable-count') || '0') + 1));
        state = { ...state, phase: 'disabled', enabled: false, microphoneActive: false, message: '本地语音已关闭' };
        lateEnable?.();
        stopDictation();
        return { ...state, phase: 'disabled' };
      },
      openSettings: async () => { sessionStorage.setItem('voice-settings-opened', 'true'); return true; },
    };
  }, mode);
}

async function openVoice(page: Page) {
  await page.goto('/#/chat/new');
  await page.getByRole('button', { name: '语音', exact: true }).click();
  return page.getByRole('dialog');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (navigator.mediaDevices) Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      sessionStorage.setItem('unexpected-microphone-request', 'true');
      throw new Error('Physical microphones are prohibited in this test');
    } });
  });
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => sessionStorage.getItem('unexpected-microphone-request'))).toBeNull();
});

test('浏览器或旧宿主缺少桥时说明真实限制，不反复请求麦克风', async ({ page }) => {
  const dialog = await openVoice(page);
  await expect(dialog).toContainText('没有独立桌宠语音入口');
  await expect(dialog.getByRole('button', { name: '检查麦克风权限' })).toHaveCount(0);
});

test('打开说明不启麦；本人点击才调用桌宠，停止与系统设置分开', async ({ page }) => {
  await installVoiceFixture(page);
  const dialog = await openVoice(page);
  await expect(dialog).toContainText('桌宠麦克风未开启');
  await expect(dialog.getByRole('region', { name: '开启本地语音提示' })).toContainText('本人同意本次输入');
  await expect(dialog.getByRole('region', { name: '开启本地语音提示' })).toContainText('麦克风不会自动开启');
  expect(await page.evaluate(() => sessionStorage.getItem('voice-enable-count'))).toBeNull();
  await dialog.getByRole('button', { name: '在桌宠开启本地语音', exact: true }).click();
  await expect(dialog).toContainText('本机监听中');
  await expect(dialog.getByRole('region', { name: '开启本地语音提示' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '停止本地语音', exact: true }).click();
  await expect(dialog).toContainText('本次麦克风已关闭');
  await expect(dialog.getByRole('region', { name: '开启本地语音提示' })).toBeVisible();
  await dialog.getByRole('button', { name: '打开 Windows 麦克风设置' }).click();
  expect(await page.evaluate(() => sessionStorage.getItem('voice-settings-opened'))).toBe('true');
  expect(await page.evaluate(() => sessionStorage.getItem('voice-enable-count'))).toBe('1');
});

test('取消原生确认后仍是未开启，而非假显示授权成功', async ({ page }) => {
  await installVoiceFixture(page, 'cancel');
  const dialog = await openVoice(page);
  await dialog.getByRole('button', { name: '在桌宠开启本地语音', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '在桌宠开启本地语音', exact: true })).toBeEnabled();
  await expect(dialog).toContainText('桌宠麦克风未开启');
});

test('缺离线引擎明确说明，不误报成 Windows 拒绝，也不自动重试', async ({ page }) => {
  await installVoiceFixture(page, 'unavailable');
  const dialog = await openVoice(page);
  await dialog.getByRole('button', { name: '在桌宠开启本地语音', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('本地语音未能开启');
  await expect(dialog).toContainText('本机缺少离线中文语音引擎');
  await dialog.getByRole('button', { name: '刷新语音状态' }).click();
  expect(await page.evaluate(() => sessionStorage.getItem('voice-enable-count'))).toBe('1');
});

test('开启等待时也能停止，迟到的开启回复不能覆盖停止状态', async ({ page }) => {
  await installVoiceFixture(page, 'pending');
  const dialog = await openVoice(page);
  await dialog.getByRole('button', { name: '在桌宠开启本地语音', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '请在桌宠确认语音授权' })).toBeDisabled();
  await expect(dialog.getByRole('region', { name: '开启本地语音提示' })).toContainText('还差一步：请本人确认开启');
  await expect(dialog.getByRole('region', { name: '开启本地语音提示' })).toContainText('暂不开启');
  await dialog.getByRole('button', { name: '停止本地语音', exact: true }).click();
  await expect(dialog).toContainText('本次麦克风已关闭');
  await expect(dialog.getByRole('button', { name: '在桌宠开启本地语音', exact: true })).toBeEnabled();
  await expect(dialog).not.toContainText('桌宠语音正在运行');
});

test('点击说话后直接回填并保留已有草稿，不唤醒、不自动发送', async ({ page }) => {
  await installVoiceFixture(page);
  await page.goto('/#/chat/new');
  await page.getByLabel('想问微光指引的问题').fill('我已有的问题');
  await page.getByRole('button', { name: '语音', exact: true }).click();
  const dialog = page.getByRole('dialog');
  expect(await page.evaluate(() => sessionStorage.getItem('voice-dictation-count'))).toBeNull();
  await dialog.getByRole('button', { name: '开始语音输入', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('想问微光指引的问题')).toHaveValue('我已有的问题\n教我在浏览器里收藏网页');
  await expect(page.locator('.message.user')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('voice-dictation-count'))).toBe('1');
  expect(await page.evaluate(() => sessionStorage.getItem('voice-enable-count'))).toBeNull();
});

test('原生取消本次输入后保留草稿，不误报识别成功', async ({ page }) => {
  await installVoiceFixture(page, 'dictation-cancel');
  const dialog = await openVoice(page);
  await dialog.getByRole('button', { name: '开始语音输入', exact: true }).click();
  await expect(dialog).toContainText('本次语音输入已取消');
  await dialog.getByRole('button', { name: '关闭窗口' }).click();
  await expect(page.getByLabel('想问微光指引的问题')).toHaveValue('');
  await expect(page.locator('.message.user')).toHaveCount(0);
});

test('低置信本地听写不回填候选文字，提示本人重说', async ({ page }) => {
  await installVoiceFixture(page, 'dictation-uncertain');
  await page.goto('/#/chat/new');
  await page.getByLabel('想问微光指引的问题').fill('保留的草稿');
  await page.getByRole('button', { name: '语音', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '开始语音输入', exact: true }).click();
  await expect(dialog).toContainText('这次没有听清');
  await expect(dialog.getByRole('region', { name: '本次识别文字' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭窗口' }).click();
  await expect(page.getByLabel('想问微光指引的问题')).toHaveValue('保留的草稿');
  await expect(page.locator('.message.user')).toHaveCount(0);
});

test('听写进行时显示状态，取消后忽略迟到文字', async ({ page }) => {
  await installVoiceFixture(page, 'dictation-pending');
  const dialog = await openVoice(page);
  await dialog.getByRole('button', { name: '开始语音输入', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '本地语音状态' })).toContainText('正在本机听写');
  await dialog.getByRole('button', { name: '取消本次输入', exact: true }).click();
  await expect(dialog).toContainText('本次语音输入已取消');
  await dialog.getByRole('button', { name: '关闭窗口' }).click();
  await expect(page.getByLabel('想问微光指引的问题')).toHaveValue('');
  expect(await page.evaluate(() => sessionStorage.getItem('voice-dictation-cancel-count'))).toBe('1');
});

test('关闭面板会取消本次听写，重新打开时不自动续录或回填', async ({ page }) => {
  await installVoiceFixture(page, 'dictation-pending');
  const dialog = await openVoice(page);
  await dialog.getByRole('button', { name: '开始语音输入', exact: true }).click();
  await dialog.getByRole('button', { name: '关闭窗口' }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('voice-dictation-cancel-count'))).toBe('1');
  await page.getByRole('button', { name: '语音', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: '开始语音输入', exact: true })).toBeEnabled();
  await page.getByRole('dialog').getByRole('button', { name: '关闭窗口' }).click();
  await expect(page.getByLabel('想问微光指引的问题')).toHaveValue('');
  expect(await page.evaluate(() => sessionStorage.getItem('voice-dictation-count'))).toBe('1');
});

test('超时或识别失败如实提示，不回退浏览器或云端录音', async ({ page }) => {
  await installVoiceFixture(page, 'dictation-error');
  const dialog = await openVoice(page);
  await dialog.getByRole('button', { name: '开始语音输入', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('本次语音输入未完成');
  await expect(dialog.getByRole('region', { name: '本地语音状态' })).toContainText('20 秒内未识别到完整语句');
  expect(await page.evaluate(() => sessionStorage.getItem('voice-dictation-count'))).toBe('1');
});

test('草稿字数不足时保留原文和识别文字，不能静默覆盖或截断', async ({ page }) => {
  await installVoiceFixture(page);
  await page.goto('/#/chat/new');
  await page.getByLabel('想问微光指引的问题').fill('字'.repeat(1500));
  await page.getByRole('button', { name: '语音', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '开始语音输入', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('没有覆盖原文字');
  await expect(dialog.getByRole('region', { name: '本次识别文字' })).toContainText('教我在浏览器里收藏网页');
  await dialog.getByRole('button', { name: '关闭窗口' }).click();
  await expect(page.getByLabel('想问微光指引的问题')).toHaveValue('字'.repeat(1500));
  await expect(page.locator('.message.user')).toHaveCount(0);
});
