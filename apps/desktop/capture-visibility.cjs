// 截图 / 录屏可见性策略。
//
// Windows 上 Electron 的 setContentProtection(true) 会调用 SetWindowDisplayAffinity，把窗口从
// 截图和录屏中排除（Snipping Tool、Xbox Game Bar、OBS 等都拍不到）。便携客户端现在默认允许
// 桌宠、管理界面、工具小屋和语音气泡被截图 / 录屏捕获；屏幕观察期间仍由采集状态自动恢复保护
// （management-window-visibility.cjs 与 standalone-host.cjs 的 captureActive 逻辑）。
//
// 需要旧行为（完全拍不到）时使用显式保护参数：
//   --protect-pet      只保护桌宠 / 工具小屋 / 语音气泡
//   --protect-client   只保护管理界面
//   --protect-display  全部保护
// --pet-display-compatible / --client-display-compatible 作为旧的"允许捕获"别名继续接受。
const PROTECT_ALL_FLAG = '--protect-display';

function flagSet(argv) {
  return new Set((Array.isArray(argv) ? argv : []).filter(value => typeof value === 'string'));
}

function createCaptureVisibility(argv = process.argv) {
  const flags = flagSet(argv);
  return Object.freeze({
    petVisible: !flags.has(PROTECT_ALL_FLAG) && !flags.has('--protect-pet'),
    clientVisible: !flags.has(PROTECT_ALL_FLAG) && !flags.has('--protect-client'),
  });
}

function contentProtectionRequired(argv = process.argv, scope = 'pet') {
  const visibility = createCaptureVisibility(argv);
  return scope === 'client' ? !visibility.clientVisible : !visibility.petVisible;
}

module.exports = { createCaptureVisibility, contentProtectionRequired, PROTECT_ALL_FLAG };