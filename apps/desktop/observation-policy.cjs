const { createHash } = require('node:crypto');
const { createControlLayout } = require('./observation/control-layout.cjs');
const { LIMITS } = require('./observation/observation-common.cjs');

const policyVersion = 'windows-local-ocr-v10';
const admittedFrames = new WeakSet();
const privatePattern = /密码|口令|验证码|动态码|私聊|聊天记录|私人聊天|发送给|身份证|银行卡|支付|付款|收款|转账|交易确认|安全密钥|访问令牌|password|passcode|one[ -]?time|verification code|private (?:chat|message)|credit card|bank account|payment|transfer money|bearer\s|api[ _-]?key|secret key/i;
const personalPattern = /(?:\b1[3-9]\d{9}\b)|(?:\b\d{17}[\dXx]\b)|(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})|(?:\b(?:sk|pk)[-_][A-Za-z0-9]{16,})/;
const genericLabels = new Set([
  '设置', '系统', '显示', '屏幕', '字体', '字体大小', '文本大小', '大小', '缩放', '辅助功能', '无障碍', '个性化', '主题', '颜色', '语言', '时间和语言', '网络和internet', '网络', 'wifi', '蓝牙', '音量', '声音', '音频', '通知', '开始', '所有应用', '应用', '搜索', '搜索应用', '桌面', '文件', '编辑', '查看', '视图', '帮助', '格式', '工具', '选项', '菜单', '更多', '返回', '下一步', '上一步', '确定', '取消', '保存', '应用更改', '关闭', '打开', '展开', '收起', '大', '中', '小', '默认', '推荐', '开启', '关闭状态', '开', '关', '滑块', '放大', '缩小',
  'settings', 'system', 'display', 'screen', 'font', 'fonts', 'font size', 'text size', 'size', 'scale', 'accessibility', 'personalization', 'theme', 'colors', 'language', 'network', 'wi-fi', 'wifi', 'bluetooth', 'volume', 'sound', 'audio', 'notifications', 'start', 'all apps', 'apps', 'search', 'desktop', 'file', 'edit', 'view', 'help', 'format', 'tools', 'options', 'menu', 'more', 'back', 'next', 'previous', 'ok', 'cancel', 'save', 'apply', 'close', 'open', 'expand', 'collapse', 'large', 'medium', 'small', 'default', 'recommended', 'on', 'off', 'slider', 'zoom in', 'zoom out',
  '书签', '收藏', '收藏夹', '添加书签', '添加到收藏夹', '添加收藏', '编辑书签', '书签管理器', '新建标签页', '新标签页', '标签页', '重新加载', '刷新', '主页', '全屏', '退出全屏',
  '新建', '新建文件', '撤销', '重做', '剪切', '复制', '粘贴', '全选', '查找', '替换', '自动换行', '另存为', '对齐', '加粗', '斜体', '下划线', '居中', '项目符号',
  'bookmarks', 'bookmark', 'favorites', 'add bookmark', 'add to favorites', 'edit bookmark', 'bookmark manager', 'new tab', 'reload', 'refresh', 'home', 'fullscreen', 'full screen',
  'new', 'new file', 'undo', 'redo', 'cut', 'copy', 'paste', 'select all', 'find', 'replace', 'word wrap', 'save as', 'alignment', 'bold', 'italic', 'underline', 'center', 'bullets',
  '微信', 'wechat', 'weixin', '朋友圈', 'moments', '发现', 'discover',
]);
const sceneLabels = new Set(['设置', '系统', '显示', '字体', '字体大小', '文本大小', '缩放', '辅助功能', '无障碍', '个性化', '主题', '语言', '网络', '蓝牙', '音量', '声音', 'settings', 'system', 'display', 'font', 'fonts', 'font size', 'text size', 'scale', 'accessibility', 'personalization', 'theme', 'language', 'network', 'bluetooth', 'volume', 'sound']);
const browserLabels = new Set(['书签', '收藏', '收藏夹', '添加书签', '添加到收藏夹', '添加收藏', '编辑书签', '书签管理器', '新建标签页', '新标签页', '标签页', '重新加载', '刷新', '主页', '全屏', '退出全屏',
  'bookmarks', 'bookmark', 'favorites', 'add bookmark', 'add to favorites', 'edit bookmark', 'bookmark manager', 'new tab', 'reload', 'refresh', 'home', 'fullscreen', 'full screen']);
const editorLabels = new Set(['文件', '编辑', '查看', '视图', '格式', '工具', '新建', '撤销', '重做', '自动换行', '另存为', '对齐', '加粗', '斜体', '下划线', '居中', '项目符号',
  'file', 'edit', 'view', 'format', 'tools', 'new', 'undo', 'redo', 'word wrap', 'save as', 'alignment', 'bold', 'italic', 'underline', 'center', 'bullets']);
const desktopLabels = new Set(['此电脑', '这台电脑', '我的电脑', '回收站', '控制面板', 'this pc', 'my computer', 'recycle bin', 'control panel']);
// 常见应用与入口名。用户最常问"帮我打开浏览器/微信"，但 OCR 读到的桌面或任务栏快捷方式文字
// （Google Chrome、Microsoft Edge、浏览器…）原先不在词表里，会被当成未知正文整条丢弃，于是本机
// 报"尚未识别出可指引操作的入口"。这些是应用名而非用户内容，加入词表后即可作为普通控件指引。
const applicationLabels = new Set([
  '浏览器', '谷歌浏览器', '谷歌', '谷歌chrome', '微软edge', '微软浏览器', '火狐浏览器', '火狐', '360浏览器', '360安全浏览器', 'qq浏览器', '搜狗浏览器', '搜狗高速浏览器', '百度浏览器', '夸克浏览器', '夸克', '欧朋浏览器',
  'chrome', 'google chrome', 'google', 'edge', 'microsoft edge', 'internet explorer', 'firefox', 'mozilla firefox', 'opera', 'brave', 'safari',
  '企业微信', 'wecom', 'qq', 'tim', '钉钉', 'dingtalk', '飞书', 'feishu', 'lark', '腾讯会议', '网易云音乐', 'qq音乐', '酷狗音乐', '迅雷',
  'wps', 'wps office', 'word', 'excel', 'powerpoint', 'office', '记事本', 'notepad', '计算器', 'calculator', '画图', 'paint',
  '命令提示符', 'powershell', '任务管理器', 'task manager', '截图工具', 'snipping tool', '相机', 'camera', '时钟', 'clock', '日历', 'calendar', '便签', 'sticky notes',
  '文件夹', 'folder', '新建文件夹', '压缩文件', '文本文档', '快捷方式', '我的文档', '此电脑图标', '网络邻居',
]);
const explorerLabels = new Set(['文件资源管理器', '资源管理器', '此电脑', '这台电脑', '快速访问', '文件夹选项', 'file explorer', 'this pc', 'quick access', 'folder options']);
const fileColumns = new Set(['名称', '修改日期', '类型', '大小', 'name', 'date modified', 'type', 'size']);
const fileActions = new Set(['新建', '剪切', '复制', '粘贴', '排序', '布局', '查看', '删除', '重命名', 'new', 'cut', 'copy', 'paste', 'sort', 'layout', 'view', 'delete', 'rename']);
for (const label of [...desktopLabels, ...explorerLabels, ...fileColumns, ...fileActions, ...applicationLabels, '下载', '文档', '图片', '音乐', '视频', '本地磁盘', '导航窗格', 'downloads', 'documents', 'pictures', 'music', 'videos', 'local disk', 'navigation pane']) genericLabels.add(label);
// 应用入口与桌面图标一起用于桌面场景判定，避免桌面画面因缺少"设置类"词而落进 unknown。
for (const label of applicationLabels) desktopLabels.add(label);

function normalizeLabel(value) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F]/g, '').trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function recognizedControls(words) {
  const controls = [];
  let matchedCount = 0;
  for (let index = 0; index < words.length; index += 1) {
    let match;
    const parts = [];
    const bounds = { ...words[index].rect };
    for (let end = index; end < Math.min(words.length, index + 8); end += 1) {
      const current = words[end];
      if ((current.ocrPass ?? 0) !== (words[index].ocrPass ?? 0)) break;
      if (end > index) {
        const previous = words[end - 1].rect;
        const overlap = Math.min(previous.y + previous.height, current.rect.y + current.rect.height) - Math.max(previous.y, current.rect.y);
        const gap = current.rect.x - previous.x - previous.width;
        if (overlap < Math.min(previous.height, current.rect.height) * 0.6 || gap < -2 || gap > Math.max(previous.height, current.rect.height) * 1.5) break;
        const right = Math.max(bounds.x + bounds.width, current.rect.x + current.rect.width);
        const bottom = Math.max(bounds.y + bounds.height, current.rect.y + current.rect.height);
        bounds.x = Math.min(bounds.x, current.rect.x);
        bounds.y = Math.min(bounds.y, current.rect.y);
        bounds.width = right - bounds.x;
        bounds.height = bottom - bounds.y;
      }
      parts.push(current.text.trim());
      const label = [parts.join(' '), parts.join('')].find(value => genericLabels.has(normalizeLabel(value)));
      if (label) match = { text: label, rect: { ...bounds }, count: end - index + 1 };
    }
    if (match) {
      const duplicate = controls.some(control => {
        if (normalizeLabel(control.text) !== normalizeLabel(match.text)) return false;
        const overlapWidth = Math.max(0, Math.min(control.rect.x + control.rect.width, match.rect.x + match.rect.width) - Math.max(control.rect.x, match.rect.x));
        const overlapHeight = Math.max(0, Math.min(control.rect.y + control.rect.height, match.rect.y + match.rect.height) - Math.max(control.rect.y, match.rect.y));
        return overlapWidth * overlapHeight >= Math.min(control.rect.width * control.rect.height, match.rect.width * match.rect.height) * 0.7;
      });
      if (!duplicate) controls.push({ text: match.text, rect: match.rect });
      matchedCount += match.count;
      index += match.count - 1;
    }
  }
  return { controls, matchedCount };
}

function isRestrictedText(value) {
  const normalized = normalizeLabel(value);
  return privatePattern.test(normalized) || personalPattern.test(normalized);
}

function safeSummary(value, maximum = 500) {
  if (typeof value !== 'string' || isRestrictedText(value)) return '本次内容涉及隐私或风险，仅保留教学状态。';
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, maximum);
}

function validRect(rect, width, height) {
  return Boolean(rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0
    && rect.x + rect.width <= width && rect.y + rect.height <= height);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validPng(image, width, height) {
  return Buffer.isBuffer(image) && image.length >= 33 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && image.toString('ascii', 12, 16) === 'IHDR' && image.readUInt32BE(16) === width && image.readUInt32BE(20) === height;
}

function deny(reason, risk = 'unknown') {
  return { decision: 'pause', risk, reason, policyVersion };
}

function evaluateLocalFrame(frame, detection, options = {}) {
  return evaluateFrame(frame, detection, options, false);
}

function evaluateSelectedFrame(frame, detection, options = {}) {
  return evaluateFrame(frame, detection, options, true);
}

function evaluateFrame(frame, detection, options, selected) {
  const now = options.now ?? Date.now();
  const authorizedSharing = !selected && options.authorizedSharing === true;
  if (!frame || !Buffer.isBuffer(frame.png) || !Number.isInteger(frame.width) || !Number.isInteger(frame.height)
    || frame.width < 1 || frame.height < 1 || frame.width > 16384 || frame.height > 16384
    || !Number.isFinite(frame.capturedAt) || frame.capturedAt > now
    || typeof frame.sourceId !== 'string' || !frame.sourceId || !validPng(frame.png, frame.width, frame.height)
    || digest(frame.png) !== frame.frameHash) return deny('invalid_or_stale_frame');
  if (!detection || detection.status !== 'complete') return deny(detection?.reason ?? 'local_detector_unavailable');
  if (detection.frameHash !== frame.frameHash || detection.width !== frame.width || detection.height !== frame.height) return deny('detector_frame_mismatch');
  if (!Array.isArray(detection.words) || !Array.isArray(detection.faces)
    || detection.redaction?.text !== true || detection.redaction?.faces !== true) return deny('incomplete_local_detection');
  if (detection.words.length > 8192 || detection.faces.length > 512) return deny('local_detection_limit');
  if (!validPng(detection.sanitizedPng, frame.width, frame.height) || detection.sanitizedPng.length > LIMITS.maxPngBytes) return deny('local_redaction_invalid');
  const shellControls = detection.shellControls ?? [];
  if (!Array.isArray(shellControls) || shellControls.length > 128 || shellControls.some(control =>
    !['微信', '开始', '搜索', '此电脑', '回收站', '控制面板'].includes(control?.label)
    || !['taskbar', 'desktop'].includes(control?.surface) || !validRect(control.rect, frame.width, frame.height))
    || (shellControls.length && (!frame.sourceId.startsWith('screen:') || !frame.geometry || detection.sourceId !== frame.sourceId))) return deny('invalid_local_regions');
  if (!selected && !authorizedSharing && detection.words.length === 0 && !shellControls.length) return deny('no_readable_text');
  if (detection.words.some(word => typeof word?.text !== 'string' || !word.text.length || word.text.length > 512 || !validRect(word.rect, frame.width, frame.height))
    || detection.faces.some(face => !validRect(face?.rect, frame.width, frame.height))) return deny('invalid_local_regions');
  const visualControls = detection.visualControls ?? [];
  if (!Array.isArray(visualControls) || visualControls.length > 48 || visualControls.some(control =>
    control?.label !== '未标注图标' || control.surface !== 'visual' || !/^[a-f0-9]{64}$/.test(control.appearance ?? '')
    || !validRect(control.rect, frame.width, frame.height)
    || [...detection.words, ...detection.faces].some(region => control.rect.x < region.rect.x + region.rect.width
      && region.rect.x < control.rect.x + control.rect.width && control.rect.y < region.rect.y + region.rect.height
      && region.rect.y < control.rect.y + control.rect.height))) return deny('invalid_local_regions');
  const text = detection.words.map(word => word.text).join(' ');
  if (text.length > 20000) return deny('local_text_limit');
  if (!authorizedSharing && (isRestrictedText(text) || isRestrictedText(detection.words.map(word => word.text).join('')))) return deny('sensitive_screen', 'private');
  const { controls: allowedWords, matchedCount } = recognizedControls(detection.words);
  for (const control of shellControls) {
    const duplicate = allowedWords.findIndex(word => normalizeLabel(word.text) === normalizeLabel(control.label)
      && word.rect.x >= control.rect.x && word.rect.y >= control.rect.y
      && word.rect.x + word.rect.width <= control.rect.x + control.rect.width
      && word.rect.y + word.rect.height <= control.rect.y + control.rect.height);
    if (duplicate >= 0) allowedWords.splice(duplicate, 1);
    allowedWords.push({ text: control.label, rect: { ...control.rect }, surface: control.surface });
  }
  if (allowedWords.length > 1024) return deny('control_layout_limit');
  const labels = new Set(allowedWords.map(word => normalizeLabel(word.text)));
  const positiveMarkers = [...labels].filter(label => sceneLabels.has(label));
  const unknownCount = detection.words.length - matchedCount;
  const countLabels = group => [...labels].filter(label => group.has(label)).length;
  let scene = null;
  if (countLabels(explorerLabels) >= 2 && (countLabels(fileColumns) >= 3 || (countLabels(explorerLabels) >= 3 && countLabels(fileActions) >= 3)) && unknownCount <= Math.min(24, allowedWords.length * 2)) scene = 'file_manager_controls';
  else if (countLabels(desktopLabels) >= 2 && allowedWords.length >= 3 && unknownCount <= Math.min(12, allowedWords.length * 2)) scene = 'desktop_controls';
  else if (positiveMarkers.length >= 2 && allowedWords.length >= 3 && unknownCount <= allowedWords.length * 2) scene = 'settings';
  else if (allowedWords.length >= 3 && unknownCount <= 1 && [...labels].filter(label => browserLabels.has(label)).length >= 2) scene = 'browser_controls';
  else if (allowedWords.length >= 4 && unknownCount <= 1 && [...labels].filter(label => editorLabels.has(label)).length >= 3) scene = 'editor_controls';
  const requiresRedaction = (!selected && !authorizedSharing) || detection.words.length > 0 || detection.faces.length > 0;
  if (requiresRedaction && !shellControls.length && digest(detection.sanitizedPng) === frame.frameHash) return deny('unredacted_frame');
  let sanitizedPng;
  if (selected || authorizedSharing) {
    sanitizedPng = Buffer.from(detection.sanitizedPng);
    scene = selected ? 'selected_frame' : 'authorized_sharing';
  } else if (shellControls.length || !scene || detection.sanitizedPng.length > 2_000_000) {
    if (!allowedWords.length) return deny('unclassified_screen');
    try { sanitizedPng = createControlLayout(allowedWords, frame.width, frame.height); }
    catch { return deny('control_layout_unavailable'); }
    scene = 'controls_only';
  } else sanitizedPng = Buffer.from(detection.sanitizedPng);
  if (!authorizedSharing && sanitizedPng.length > 2_000_000) { sanitizedPng.fill(0); return deny('control_layout_limit'); }
  const sanitizedHash = digest(sanitizedPng);
  if (requiresRedaction && sanitizedHash === frame.frameHash) { sanitizedPng.fill(0); return deny('unredacted_frame'); }
  if (now - frame.capturedAt > (options.maxAgeMs ?? 5000)) { sanitizedPng.fill(0); return deny('stale_frame'); }
  const elements = allowedWords.map((word, index) => ({ id: `element_${frame.frameHash.slice(0, 12)}_${index}`, label: word.text.trim(), rect: { ...word.rect }, ...(word.surface ? { surface: word.surface } : {}) }));
  if (selected || authorizedSharing) {
    for (const control of visualControls) {
      if (shellControls.some(shell => control.rect.x >= shell.rect.x && control.rect.y >= shell.rect.y
        && control.rect.x + control.rect.width <= shell.rect.x + shell.rect.width
        && control.rect.y + control.rect.height <= shell.rect.y + shell.rect.height)) continue;
      elements.push({ id: `element_${frame.frameHash.slice(0, 12)}_${elements.length}`, label: control.label,
        rect: { ...control.rect }, surface: control.surface, appearance: control.appearance });
    }
  }
  // Authorized continuous sharing must not treat unrelated text drift (clock, cursor, OCR jitter,
  // body text) as a new screen; the stable identity of a frame is the set of recognizable controls
  // that arrows are allowed to point at. Controls-only frames already used this rule.
  const contextWords = scene === 'controls_only' || authorizedSharing ? allowedWords : detection.words;
  const signature = digest(JSON.stringify([
    ...contextWords.map(word => [normalizeLabel(word.text), Math.round(word.rect.x / 4), Math.round(word.rect.y / 4), Math.round(word.rect.width / 4), Math.round(word.rect.height / 4), ...(word.surface ? [word.surface] : [])]),
    ...elements.filter(element => element.surface === 'visual').map(element => ['visual', element.rect, element.appearance]),
  ]));
  const admitted = {
    decision: 'allow', risk: 'safe', reason: authorizedSharing ? 'authorized_sharing' : scene === 'controls_only' ? 'locally_projected_controls' : 'locally_checked', policyVersion, frameId: frame.frameId ?? frame.frameHash,
    frameHash: frame.frameHash, sanitizedHash, capturedAt: frame.capturedAt, sourceId: frame.sourceId,
    sourceName: frame.sourceName ?? '', displayId: frame.displayId, width: frame.width, height: frame.height,
    geometry: frame.geometry ? { ...frame.geometry } : null, signature, elements, sanitizedPng,
    redactionProfile: 'all_text_and_faces_v1', scene,
  };
  admittedFrames.add(admitted);
  return admitted;
}

function isAdmittedFrame(frame, now = Date.now(), maxAgeMs = 5000) {
  return Boolean(frame && admittedFrames.has(frame) && frame.decision === 'allow'
    && Number.isFinite(frame.capturedAt) && frame.capturedAt <= now && now - frame.capturedAt <= maxAgeMs
    && Buffer.isBuffer(frame.sanitizedPng) && digest(frame.sanitizedPng) === frame.sanitizedHash);
}

module.exports = { evaluateLocalFrame, evaluateSelectedFrame, isAdmittedFrame, isRestrictedText, normalizeLabel, safeSummary, validRect, policyVersion };
