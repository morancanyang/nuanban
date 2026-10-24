import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { evaluateLocalFrame, isAdmittedFrame, safeSummary } from '../../apps/desktop/observation-policy.cjs';
import { createControlLayout } from '../../apps/desktop/observation/control-layout.cjs';
import { syntheticDetection, syntheticFrame, syntheticPng } from '../helpers/standalone-frame';

describe('独立桌宠本地帧门控（合成单测，不是真实外部软件验收）', () => {
  it.each([
    ['验证码123456', '私人聊天', '银行卡支付'], ['验', '证', '码', '123456'],
    ['Password', 'bank account', 'synthetic@example.test'], ['未知页面', '未经分类的正文'], [],
  ])('已授权连续共享不按文字内容、页面分类或空文字暂停：%j', (...labels: string[]) => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, labels);
    const result = evaluateLocalFrame(frame, detection, { authorizedSharing: true });
    expect(result).toMatchObject({ decision: 'allow', scene: 'authorized_sharing', reason: 'authorized_sharing', redactionProfile: 'all_text_and_faces_v1' });
    if (result.decision !== 'allow') throw new Error('expected authorized sharing');
    expect(result.sanitizedPng).toEqual(detection.sanitizedPng);
    expect(result.sanitizedPng).not.toBe(detection.sanitizedPng);
    expect(result.sanitizedPng).not.toEqual(frame.png);
    expect(result.elements).toEqual([]);
    expect(isAdmittedFrame(result, frame.capturedAt)).toBe(true);
    expect(isAdmittedFrame({ ...result }, frame.capturedAt)).toBe(false);
    expect(isAdmittedFrame(result, frame.capturedAt + 5001)).toBe(false);
  });

  it('已授权的空文字无人脸画面允许无需遮盖，但检测出文字或人脸仍禁止原图回退', () => {
    const frame = syntheticFrame();
    const detection = { ...syntheticDetection(frame, []), sanitizedPng: Buffer.from(frame.png) };
    expect(evaluateLocalFrame(frame, detection, { authorizedSharing: true }).decision).toBe('allow');
    expect(evaluateLocalFrame(frame, detection)).toMatchObject({ decision: 'pause', reason: 'no_readable_text' });
    detection.faces.push({ rect: { x: 20, y: 20, width: 100, height: 100 } });
    expect(evaluateLocalFrame(frame, detection, { authorizedSharing: true })).toMatchObject({ decision: 'pause', reason: 'unredacted_frame' });
    detection.faces = [];
    detection.words.push({ text: '私人聊天', rect: { x: 20, y: 20, width: 100, height: 30 } });
    expect(evaluateLocalFrame(frame, detection, { authorizedSharing: true })).toMatchObject({ decision: 'pause', reason: 'unredacted_frame' });
  });

  it('桌面浏览器与应用快捷方式成为可指引条目，不再当成未知正文丢弃', () => {
    const frame = syntheticFrame();
    const labels = ['Google Chrome', 'Microsoft Edge', '浏览器', '回收站'];
    const shared = evaluateLocalFrame(frame, syntheticDetection(frame, labels), { authorizedSharing: true });
    expect(shared).toMatchObject({ decision: 'allow', scene: 'authorized_sharing' });
    if (shared.decision !== 'allow') throw new Error('expected authorized sharing');
    expect(shared.elements.map(element => element.label)).toEqual(labels);
    const desktop = evaluateLocalFrame(frame, syntheticDetection(frame, labels.slice(0, 3)));
    expect(desktop).toMatchObject({ decision: 'allow', scene: 'desktop_controls' });
    if (desktop.decision !== 'allow') throw new Error('expected desktop controls');
    expect(desktop.elements.map(element => element.label)).toEqual(labels.slice(0, 3));
    expect(evaluateLocalFrame(frame, syntheticDetection(frame, ['任意新软件', '未知图标甲', '未知图标乙'])))
      .toMatchObject({ decision: 'pause', reason: 'unclassified_screen' });
  });

  it('已授权共享接纳无文字图标候选，但普通控件布局不向模型暴露真实图形', () => {
    const frame = syntheticFrame();
    const visualControls = [{ label: '未标注图标' as const, surface: 'visual' as const,
      rect: { x: 180, y: 220, width: 24, height: 24 }, appearance: 'a'.repeat(64) }];
    const detection = { ...syntheticDetection(frame, ['微信']), visualControls };
    const shared = evaluateLocalFrame(frame, detection, { authorizedSharing: true });
    expect(shared).toMatchObject({ decision: 'allow', scene: 'authorized_sharing', elements: [
      { label: '微信' }, { label: '未标注图标', surface: 'visual', appearance: 'a'.repeat(64) },
    ] });
    const normal = evaluateLocalFrame(frame, detection);
    expect(normal).toMatchObject({ decision: 'allow' });
    if (normal.decision !== 'allow') throw new Error('expected safe controls-only frame');
    expect(normal.elements.some(element => element.surface === 'visual')).toBe(false);
    expect(normal.scene).not.toBe('authorized_sharing');
  });

  it('已授权连续共享保留大图的完整脱敏像素与公共控件，不因云发送限制退为控件布局', () => {
    const png = syntheticPng(255, 1200, 1000, true);
    const frame = { ...syntheticFrame(), width: 1200, height: 1000, geometry: null, png, frameHash: createHash('sha256').update(png).digest('hex') };
    const detection = { ...syntheticDetection(frame, ['设置', '未知正文', '私人聊天']), sanitizedPng: syntheticPng(0, 1200, 1000, true) };
    expect(detection.sanitizedPng.length).toBeGreaterThan(2_000_000);
    const result = evaluateLocalFrame(frame, detection, { authorizedSharing: true });
    expect(result).toMatchObject({ decision: 'allow', scene: 'authorized_sharing', elements: [{ label: '设置' }] });
    if (result.decision !== 'allow') throw new Error('expected complete sanitized image');
    expect(result.sanitizedPng.equals(detection.sanitizedPng)).toBe(true);
    expect(result.elements.map(element => element.label)).toEqual(['设置']);
    expect(JSON.stringify(result.elements)).not.toContain('私人聊天');
  });

  it.each(['unavailable', 'incomplete', 'mismatch', 'bounds', 'corrupt', 'future', 'stale', 'word_limit'] as const)('连续共享授权不绕过检测、完整性与时效校验：%s', condition => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, ['私人聊天']);
    let timestamp = frame.capturedAt;
    let reason = 'invalid_or_stale_frame';
    if (condition === 'unavailable') { detection.status = 'unavailable'; reason = 'local_detector_unavailable'; }
    if (condition === 'incomplete') { detection.redaction.text = false; reason = 'incomplete_local_detection'; }
    if (condition === 'mismatch') { detection.frameHash = '0'.repeat(64); reason = 'detector_frame_mismatch'; }
    if (condition === 'bounds') { detection.words[0].rect.x = -1; reason = 'invalid_local_regions'; }
    if (condition === 'corrupt') frame.png[0] = 0;
    if (condition === 'future') frame.capturedAt += 1;
    if (condition === 'stale') { timestamp += 5001; reason = 'stale_frame'; }
    if (condition === 'word_limit') { detection.words = Array.from({ length: 8193 }, () => detection.words[0]); reason = 'local_detection_limit'; }
    expect(evaluateLocalFrame(frame, detection, { now: timestamp, authorizedSharing: true })).toMatchObject({ decision: 'pause', reason });
  });

  it('无文字的任务栏软件只使用同帧公共图标布局，不上传未脱敏原图或窗口标题', () => {
    const frame = syntheticFrame();
    const detection = { ...syntheticDetection(frame, []), sourceId: frame.sourceId,
      sanitizedPng: Buffer.from(frame.png), shellControls: [{ label: '微信', surface: 'taskbar' as const, rect: { x: 220, y: 540, width: 44, height: 44 } }] };
    const result = evaluateLocalFrame(frame, detection);
    expect(result).toMatchObject({ decision: 'allow', scene: 'controls_only', elements: [{ label: '微信', surface: 'taskbar', rect: detection.shellControls[0].rect }] });
    if (result.decision !== 'allow') throw new Error('expected safe public layout');
    expect(result.sanitizedPng).not.toEqual(frame.png);
    expect(result.sanitizedPng).toEqual(createControlLayout(detection.shellControls, frame.width, frame.height));
    detection.words.push({ text: '验证码123456', rect: { x: 100, y: 100, width: 100, height: 24 } });
    expect(evaluateLocalFrame(frame, detection)).toMatchObject({ decision: 'pause', reason: 'sensitive_screen' });
  });

  it.each(['source', 'window', 'geometry', 'label', 'bounds', 'surface', 'overflow'] as const)('原生图标不能越过来源、范围或白名单门控：%s', condition => {
    const frame = syntheticFrame();
    const detection = { ...syntheticDetection(frame), sourceId: frame.sourceId,
      shellControls: [{ label: '微信', surface: 'taskbar' as 'taskbar' | 'desktop', rect: { x: 220, y: 540, width: 44, height: 44 } }] };
    if (condition === 'source') detection.sourceId = 'screen:other:0';
    if (condition === 'window') frame.sourceId = 'window:42:0';
    if (condition === 'geometry') frame.geometry = null;
    if (condition === 'label') detection.shellControls[0].label = '私人聊天';
    if (condition === 'bounds') detection.shellControls[0].rect.x = -1;
    if (condition === 'surface') Object.assign(detection.shellControls[0], { surface: 'private-window' });
    if (condition === 'overflow') detection.shellControls = Array.from({ length: 129 }, () => detection.shellControls[0]);
    expect(evaluateLocalFrame(frame, detection)).toMatchObject({ decision: 'pause', reason: 'invalid_local_regions' });
  });

  it('无关正文或 OCR 抖动不使同一安全控件布局失效，控件移动或敏感内容仍被核验', () => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, ['文件', '编辑', '查看', '普通正文']);
    const first = evaluateLocalFrame(frame, detection);
    detection.words[3].text = '变化的普通正文';
    detection.words[3].rect.x += 20;
    const unchanged = evaluateLocalFrame(frame, detection);
    expect(first.decision).toBe('allow');
    expect(unchanged.decision).toBe('allow');
    if (first.decision !== 'allow' || unchanged.decision !== 'allow') throw new Error('missing layout');
    expect(first.signature).toBe(unchanged.signature);
    detection.words[0].rect.x += 20;
    const moved = evaluateLocalFrame(frame, detection);
    expect(moved.decision === 'allow' && moved.signature).not.toBe(first.signature);
    detection.words[3].text = '私人聊天';
    expect(evaluateLocalFrame(frame, detection)).toMatchObject({ decision: 'pause', reason: 'sensitive_screen' });
  });

  it.each([5000, 5001])('完整安全帧的真实五秒有效期不变：%i 毫秒', age => {
    const frame = syntheticFrame();
    const capturedAt = frame.capturedAt;
    const result = evaluateLocalFrame(frame, syntheticDetection(frame), { now: capturedAt + age });
    expect(frame.capturedAt).toBe(capturedAt);
    if (age <= 5000) expect(result.decision).toBe('allow');
    else {
      expect(result).toMatchObject({ decision: 'pause', reason: 'stale_frame' });
      expect(result).not.toHaveProperty('sanitizedPng');
      expect(isAdmittedFrame(result)).toBe(false);
    }
  });

  it.each(['sensitive', 'unclassified', 'unavailable', 'mismatch', 'corrupt', 'future'] as const)('安全或完整性失败不降为可重采集的过期帧：%s', condition => {
    const frame = syntheticFrame();
    const now = frame.capturedAt + 6000;
    const detection = syntheticDetection(frame);
    let reason = 'invalid_or_stale_frame';
    if (condition === 'sensitive') { detection.words.push({ text: '验证码123456', rect: { x: 20, y: 200, width: 100, height: 30 } }); reason = 'sensitive_screen'; }
    if (condition === 'unclassified') { detection.words = [{ text: '未知正文', rect: { x: 20, y: 20, width: 100, height: 30 } }]; reason = 'unclassified_screen'; }
    if (condition === 'unavailable') { detection.status = 'unavailable'; reason = 'local_detector_unavailable'; }
    if (condition === 'mismatch') { detection.frameHash = '0'.repeat(64); reason = 'detector_frame_mismatch'; }
    if (condition === 'corrupt') frame.png[frame.png.length - 1] ^= 1;
    if (condition === 'future') frame.capturedAt = now + 1;
    expect(evaluateLocalFrame(frame, detection, { now })).toMatchObject({ decision: 'pause', reason });
  });

  it('只有本地完整检测和同帧脱敏结果可以获得发送资格', () => {
    const frame = syntheticFrame();
    const decision = evaluateLocalFrame(frame, syntheticDetection(frame));
    expect(decision.decision).toBe('allow');
    expect(isAdmittedFrame(decision)).toBe(true);
    expect(isAdmittedFrame({ ...decision })).toBe(false);
    if (decision.decision === 'allow') {
      expect(decision.elements.map(element => element.label)).toEqual(['设置', '显示', '文本大小', '返回']);
      expect(decision.sanitizedHash).not.toBe(decision.frameHash);
      decision.sanitizedPng[decision.sanitizedPng.length - 1] ^= 1;
      expect(isAdmittedFrame(decision)).toBe(false);
    }
  });

  it('完整检测的大幅画面超出发送上限时只输出独立控件布局，不误判检测失败', () => {
    const png = syntheticPng(255, 1200, 1000, true);
    const frame = { ...syntheticFrame(), width: 1200, height: 1000, geometry: null, png, frameHash: createHash('sha256').update(png).digest('hex') };
    const detection = syntheticDetection(frame);
    detection.sanitizedPng = syntheticPng(0, frame.width, frame.height, true);
    expect(detection.sanitizedPng.length).toBeGreaterThan(2_000_000);
    const projected = evaluateLocalFrame(frame, detection);
    expect(projected).toMatchObject({ decision: 'allow', scene: 'controls_only', reason: 'locally_projected_controls' });
    if (projected.decision !== 'allow') throw new Error('missing safe control layout');
    expect(projected.sanitizedPng).toEqual(createControlLayout(detection.words, frame.width, frame.height));
    expect(projected.sanitizedPng.length).toBeLessThan(2_000_000);
    expect(projected.sanitizedPng).not.toEqual(detection.sanitizedPng);
    detection.words.push({ text: '验证码', rect: { x: 200, y: 20, width: 80, height: 30 } });
    expect(evaluateLocalFrame(frame, detection)).toMatchObject({ decision: 'pause', reason: 'sensitive_screen' });
    detection.words = [{ text: '未经识别的正文', rect: { x: 20, y: 20, width: 120, height: 30 } }];
    expect(evaluateLocalFrame(frame, detection)).toMatchObject({ decision: 'pause', reason: 'unclassified_screen' });
  });

  it('屏幕分词超过旧的 1024 阈值仍扫描全部内容，不能遗漏末尾敏感文字', () => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, ['文件', '编辑', '查看']);
    detection.words.push(...Array.from({ length: 1200 }, (_, index) => ({ text: 'a', rect: { x: 20 + index % 40 * 18, y: 160 + Math.floor(index / 40) * 10, width: 12, height: 8 } })));
    expect(evaluateLocalFrame(frame, detection)).toMatchObject({ decision: 'allow', scene: 'controls_only' });
    detection.words.push({ text: '私人聊天', rect: { x: 20, y: 500, width: 100, height: 30 } });
    expect(evaluateLocalFrame(frame, detection)).toMatchObject({ decision: 'pause', reason: 'sensitive_screen' });
  });

  it('完整检测但没有可读文字时明确暂停原因，不能冒充检测器损坏', () => {
    const frame = syntheticFrame();
    expect(evaluateLocalFrame(frame, syntheticDetection(frame, []))).toMatchObject({ decision: 'pause', reason: 'no_readable_text' });
  });

  it('本地完整性与处理量上限仍保守拒绝，不因控件布局回退而绕过', () => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame);
    const region = { x: 20, y: 20, width: 100, height: 30 };
    expect(evaluateLocalFrame(frame, { ...detection, words: Array.from({ length: 8193 }, () => ({ text: 'a', rect: region })) }))
      .toMatchObject({ decision: 'pause', reason: 'local_detection_limit' });
    expect(evaluateLocalFrame(frame, { ...detection, faces: Array.from({ length: 513 }, () => ({ rect: region })) }))
      .toMatchObject({ decision: 'pause', reason: 'local_detection_limit' });
    expect(evaluateLocalFrame(frame, { ...detection, words: Array.from({ length: 1025 }, (_, index) => ({ text: '设置', rect: { x: 20 + index % 40 * 18, y: 20 + Math.floor(index / 40) * 18, width: 12, height: 12 } })) }))
      .toMatchObject({ decision: 'pause', reason: 'control_layout_limit' });
    expect(evaluateLocalFrame(frame, { ...detection, redaction: { text: false, faces: true } }))
      .toMatchObject({ decision: 'pause', reason: 'incomplete_local_detection' });
    expect(evaluateLocalFrame(frame, { ...detection, sanitizedPng: Buffer.from(frame.png) }))
      .toMatchObject({ decision: 'pause', reason: 'unredacted_frame' });
  });

  it('未知软件名称不等于风险未知，但未经识别的页面必须暂停', () => {
    const frame = syntheticFrame();
    expect(evaluateLocalFrame(frame, syntheticDetection(frame, ['任意新软件', '设置', '显示', '字体大小', '返回'])).decision).toBe('allow');
    expect(evaluateLocalFrame(frame, syntheticDetection(frame, ['任意新软件', '一段未知内容', '另一个未知内容']))).toMatchObject({ decision: 'pause', reason: 'unclassified_screen' });
  });

  it.each([
    [['未知浏览器', '书签', '添加书签', '取消'], 'browser_controls'],
    [['任意编辑器', '文件', '编辑', '查看', '自动换行'], 'editor_controls'],
    [['Unlisted editor', 'File', 'Edit', 'Format', 'Word wrap', 'Save'], 'editor_controls'],
  ])('软件名称不参与白名单，纯已识别安全控件可独立分类：%s', (labels, scene) => {
    const frame = syntheticFrame();
    expect(evaluateLocalFrame(frame, syntheticDetection(frame, labels as string[]))).toMatchObject({ decision: 'allow', scene });
  });

  it('通用软件控件只能获得不含原画面的布局，不能带出未知正文或敏感页面', () => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, ['陌生软件', '文件', '编辑', '查看', '格式', '未知文档正文']);
    const projected = evaluateLocalFrame(frame, detection);
    expect(projected).toMatchObject({ decision: 'allow', scene: 'controls_only', reason: 'locally_projected_controls' });
    if (projected.decision === 'allow') {
      expect(projected.sanitizedPng).not.toEqual(detection.sanitizedPng);
      expect(projected.sanitizedPng).not.toEqual(frame.png);
      expect(projected.elements.map(element => element.label)).toEqual(['文件', '编辑', '查看', '格式']);
    }
    expect(evaluateLocalFrame(frame, syntheticDetection(frame, ['文件', '编辑', '查看', '格式', '私人聊天'])))
      .toMatchObject({ decision: 'pause', reason: 'sensitive_screen' });
  });

  it.each([
    [['此电脑', '回收站', '控制面板', '学习资料', '练习.txt'], 'desktop_controls'],
    [['This PC', 'Recycle Bin', 'Search', 'practice.txt'], 'desktop_controls'],
    [['文件资源管理器', '此电脑', '下载', '名称', '修改日期', '类型', '大小', '练习.txt'], 'file_manager_controls'],
    [['File Explorer', 'This PC', 'Name', 'Date modified', 'Type', 'Size', 'practice.txt'], 'file_manager_controls'],
    [['文件资源管理器', '此电脑', '快速访问', '新建', '剪切', '排序', '练习.txt'], 'file_manager_controls'],
  ])('完整检测后的普通系统控件可以分类，文件名不成为云端元素：%s', (labels, scene) => {
    const frame = syntheticFrame();
    const admitted = evaluateLocalFrame(frame, syntheticDetection(frame, labels as string[]));
    expect(admitted).toMatchObject({ decision: 'allow', scene });
    if (admitted.decision === 'allow') expect(admitted.elements.some(element => /练习|practice|学习资料/.test(element.label))).toBe(false);
  });

  it.each([
    ['文件资源管理器', '此电脑', '名称', '修改日期', '类型', '大小', '验证码123456'],
    ['此电脑', '回收站', '控制面板', '13812345678'],
  ])('敏感文件名不能借系统分类或控件布局放行：%s', (...labels) => {
    const frame = syntheticFrame();
    expect(evaluateLocalFrame(frame, syntheticDetection(frame, labels)).decision).toBe('pause');
  });

  it.each([
    ['回收站', '练习文档', '学习材料'],
    ['此电脑', '一段任意正文'],
    ['文件资源管理器', '搜索', '一段任意正文'],
    ['此电脑', '回收站', '控制面板', ...Array.from({ length: 11 }, (_, index) => `未知正文${index}`)],
    ['新建标签页', '收藏夹', '刷新', '普通网页标题', '普通网页正文', '另一个内容区域'],
    ['文件', '编辑', '查看', '格式', '练习文档', '普通正文', '第二行内容'],
  ])('稀疏桌面和正文较多的常见界面降为安全控件布局，不再整页误停：%s', (...labels) => {
    const frame = syntheticFrame();
    const projected = evaluateLocalFrame(frame, syntheticDetection(frame, labels));
    expect(projected).toMatchObject({ decision: 'allow', scene: 'controls_only' });
    expect(isAdmittedFrame(projected)).toBe(true);
  });

  it('布局只含已识别控件矩形，原始像素、未知文字及其位置均不进入输出', () => {
    const first = syntheticFrame();
    const changedPng = syntheticPng(144);
    const second = { ...first, png: changedPng, frameHash: createHash('sha256').update(changedPng).digest('hex') };
    const firstDetection = syntheticDetection(first, ['文件', '编辑', '查看', '普通正文', '另一个内容']);
    const secondDetection = syntheticDetection(second, ['文件', '编辑', '查看', '完全不同的内容', '另一份练习']);
    secondDetection.words[3].rect = { x: 400, y: 400, width: 200, height: 40 };
    const firstResult = evaluateLocalFrame(first, firstDetection);
    const secondResult = evaluateLocalFrame(second, secondDetection);
    expect(firstResult).toMatchObject({ decision: 'allow', scene: 'controls_only' });
    expect(secondResult).toMatchObject({ decision: 'allow', scene: 'controls_only' });
    if (firstResult.decision !== 'allow' || secondResult.decision !== 'allow') throw new Error('missing projected frame');
    expect(firstResult.sanitizedPng).toEqual(secondResult.sanitizedPng);
    expect(firstResult.sanitizedPng[24]).toBe(8);
    expect(firstResult.sanitizedPng[25]).toBe(0);
    const pixels = inflateSync(firstResult.sanitizedPng.subarray(41, 41 + firstResult.sanitizedPng.readUInt32BE(33)));
    expect(pixels.length).toBe((first.width + 1) * first.height);
    expect(pixels[20 * (first.width + 1) + 21]).toBe(48);
    expect(pixels[140 * (first.width + 1) + 21]).toBe(255);
    expect(pixels[400 * (first.width + 1) + 401]).toBe(255);
    expect(pixels.at(-1)).toBe(255);
    firstResult.sanitizedPng.fill(0);
    expect(isAdmittedFrame(firstResult)).toBe(false);
  });

  it('控件布局同样限制图像尺寸、像素、矩形和工作量', () => {
    expect(() => createControlLayout([], 800, 600)).toThrow('control_layout_invalid');
    expect(() => createControlLayout([{ rect: { x: -1, y: 0, width: 1, height: 1 } }], 800, 600)).toThrow('control_layout_invalid');
    expect(() => createControlLayout([{ rect: { x: 0, y: 0, width: 800, height: 600 } }], 8193, 600)).toThrow('image_dimensions_invalid');
    expect(() => createControlLayout([{ rect: { x: 0, y: 0, width: 1, height: 1 } }], 4097, 4096)).toThrow('image_dimensions_invalid');
    expect(() => createControlLayout(Array.from({ length: 5 }, () => ({ rect: { x: 0, y: 0, width: 4096, height: 4096 } })), 4096, 4096)).toThrow('control_layout_limit');
  });

  it('合并同一行相邻 OCR 分词，不把中文或英文控件拆词误作未知', () => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, ['文件资源管理器', '此电脑', '名称', '修改日期', '类型', '大小']);
    const title = detection.words[0];
    detection.words.splice(0, 1, ...['文件', '资源', '管理器'].map((text, index) => ({ text, rect: { ...title.rect, x: 20 + index * 32, width: 30 } })));
    expect(evaluateLocalFrame(frame, detection)).toMatchObject({ decision: 'allow', scene: 'file_manager_controls' });
    detection.words[1].rect.y += 40;
    const unmerged = evaluateLocalFrame(frame, detection);
    expect(unmerged).toMatchObject({ decision: 'allow', scene: 'controls_only' });
    if (unmerged.decision !== 'allow') throw new Error('missing safe control layout');
    expect(unmerged.elements.some(element => element.label === '文件资源管理器')).toBe(false);
  });

  it.each(['微信', 'WeChat', 'Weixin', '朋友圈', '发现', 'Moments', 'Discover'])('保留公共入口 %s 的真实位置，不导出联系人或文件名', label => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, [label, '同事小李', '未公开项目.docx']);
    const result = evaluateLocalFrame(frame, detection);
    expect(result).toMatchObject({ decision: 'allow', scene: 'controls_only' });
    if (result.decision !== 'allow') throw new Error('missing public entry');
    expect(result.elements).toEqual([{ id: expect.any(String), label, rect: detection.words[0].rect }]);
    expect(result.sanitizedPng).toEqual(createControlLayout([detection.words[0]], frame.width, frame.height));
    expect(result.sanitizedPng).not.toEqual(frame.png);
  });

  it('同一行的微信分词合并成入口，不跨行拼出未出现的控件', () => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, []);
    detection.words = [
      { text: '微', rect: { x: 20, y: 20, width: 20, height: 30 } },
      { text: '信', rect: { x: 42, y: 20, width: 20, height: 30 } },
    ];
    const result = evaluateLocalFrame(frame, detection);
    expect(result).toMatchObject({ decision: 'allow', scene: 'controls_only',
      elements: [{ label: '微信', rect: { x: 20, y: 20, width: 42, height: 30 } }] });
    detection.words[1].rect.y += 40;
    expect(evaluateLocalFrame(frame, detection)).toMatchObject({ decision: 'pause', reason: 'unclassified_screen' });
  });

  it.each(['私人聊天', '验证码', '付款确认', '13812345678', 'private@example.com'])('公共微信入口不能绕过敏感页面保护：%s', text => {
    const frame = syntheticFrame();
    expect(evaluateLocalFrame(frame, syntheticDetection(frame, ['微信', '朋友圈', text])))
      .toMatchObject({ decision: 'pause', reason: 'sensitive_screen' });
  });

  it.each(['密码', '验证码', '私人聊天', '付款确认', 'api_key sk-abcdefghijklmnopq', '13812345678', 'private@example.com'])('敏感文字本地拒绝：%s', text => {
    const frame = syntheticFrame();
    expect(evaluateLocalFrame(frame, syntheticDetection(frame, ['设置', '显示', '文本大小', text]))).toMatchObject({ decision: 'pause', reason: 'sensitive_screen' });
  });

  it('拆词敏感内容、帧身份不符和人脸检测缺失都不能放行', () => {
    const frame = syntheticFrame();
    expect(evaluateLocalFrame(frame, syntheticDetection(frame, ['设置', '显示', '文本大小', '支', '付']))).toMatchObject({ decision: 'pause' });
    expect(evaluateLocalFrame(frame, { ...syntheticDetection(frame), frameHash: 'different' }).decision).toBe('pause');
    expect(evaluateLocalFrame(frame, { ...syntheticDetection(frame), redaction: { text: true, faces: false } }).decision).toBe('pause');
    expect(evaluateLocalFrame(frame, { ...syntheticDetection(frame), status: 'unavailable' }).decision).toBe('pause');
  });

  it('原图、过期帧、尺寸伪造和越界控件均拒绝', () => {
    const frame = syntheticFrame();
    expect(evaluateLocalFrame(frame, { ...syntheticDetection(frame), sanitizedPng: Buffer.from(frame.png) }).decision).toBe('pause');
    expect(evaluateLocalFrame(frame, syntheticDetection(frame), { now: frame.capturedAt + 5001 }).decision).toBe('pause');
    expect(evaluateLocalFrame(frame, { ...syntheticDetection(frame), sanitizedPng: syntheticPng(0, 1, 1) }).decision).toBe('pause');
    expect(evaluateLocalFrame(frame, { ...syntheticDetection(frame), words: [{ text: '设置', rect: { x: -1, y: 0, width: 100, height: 30 } }] }).decision).toBe('pause');
  });

  it('笔记摘要不重新留存秘密', () => {
    expect(safeSummary('验证码123456')).not.toContain('123456');
    expect(safeSummary('学习调整字体')).toBe('学习调整字体');
  });
});

describe('多尺度 OCR 控件合并与隐私门控（合成结果）', () => {
  it('仅补识别读到微信时输出其原帧位置，不带出未知文字或原图', () => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, ['练习资料.txt']);
    const entry = { text: '微信', ocrPass: 1, rect: { x: 120, y: 72, width: 48, height: 24 } };
    detection.words.push(entry);
    const result = evaluateLocalFrame(frame, detection);
    expect(result).toMatchObject({ decision: 'allow', scene: 'controls_only', reason: 'locally_projected_controls' });
    if (result.decision !== 'allow') throw new Error('missing supplemental WeChat entry');
    expect(result.elements).toEqual([{ id: expect.any(String), label: '微信', rect: entry.rect }]);
    expect(result.sanitizedPng).toEqual(createControlLayout([entry], frame.width, frame.height));
    expect(result.sanitizedPng).not.toEqual(frame.png);
    expect(result.sanitizedPng).not.toEqual(detection.sanitizedPng);
    expect(isAdmittedFrame(result)).toBe(true);
  });

  it.each([0, 1])('同一 ocrPass %s 内的相邻中文分词仍可合并微信', ocrPass => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, []);
    detection.words = [
      { text: '微', ocrPass, rect: { x: 20, y: 20, width: 20, height: 30 } },
      { text: '信', ocrPass, rect: { x: 42, y: 20, width: 20, height: 30 } },
    ];
    const result = evaluateLocalFrame(frame, detection);
    expect(result).toMatchObject({ decision: 'allow', scene: 'controls_only' });
    if (result.decision !== 'allow') throw new Error('missing joined WeChat entry');
    expect(result.elements).toEqual([{ id: expect.any(String), label: '微信', rect: { x: 20, y: 20, width: 42, height: 30 } }]);
  });

  it.each([[undefined, 1], [0, 1], [1, undefined], [1, 0]] as const)('即使中文词框同一行相邻，也不能跨 ocrPass %s → %s 拼出微信', (firstPass, secondPass) => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, []);
    detection.words = [
      { text: '微', ocrPass: firstPass, rect: { x: 20, y: 20, width: 20, height: 30 } },
      { text: '信', ocrPass: secondPass, rect: { x: 42, y: 20, width: 20, height: 30 } },
    ];
    const result = evaluateLocalFrame(frame, detection);
    expect(result).toMatchObject({ decision: 'pause', reason: 'unclassified_screen' });
    expect(isAdmittedFrame(result)).toBe(false);
    expect(result).not.toHaveProperty('elements');
    expect(result).not.toHaveProperty('sanitizedPng');
  });

  it('跨尺度分词不能借已有安全控件把未出现的微信加入输出', () => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, ['设置']);
    detection.words.push(
      { text: '微', rect: { x: 20, y: 60, width: 20, height: 30 } },
      { text: '信', ocrPass: 1, rect: { x: 42, y: 60, width: 20, height: 30 } },
    );
    const result = evaluateLocalFrame(frame, detection);
    expect(result).toMatchObject({ decision: 'allow', scene: 'controls_only' });
    if (result.decision !== 'allow') throw new Error('missing existing safe control');
    expect(result.elements).toEqual([{ id: expect.any(String), label: '设置', rect: detection.words[0].rect }]);
  });

  it.each([[0, 1], [2, 1], [30, 1], [31, 2], [200, 2]])('微信跨尺度词框水平偏移 %s 像素时保留 %s 个入口，不吞掉不同位置的同名控件', (offset, count) => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, ['微信']);
    const entry = detection.words[0];
    const supplemental = { ...entry, ocrPass: 1, rect: { ...entry.rect, x: entry.rect.x + offset } };
    detection.words.push(supplemental);
    const result = evaluateLocalFrame(frame, detection);
    expect(result).toMatchObject({ decision: 'allow', scene: 'controls_only' });
    if (result.decision !== 'allow') throw new Error('missing deduplicated WeChat entry');
    const expected = count === 1 ? [entry] : [entry, supplemental];
    expect(result.elements).toEqual(expected.map(word => ({ id: expect.any(String), label: '微信', rect: word.rect })));
    expect(new Set(result.elements.map(element => element.id)).size).toBe(count);
    expect(result.sanitizedPng).toEqual(createControlLayout(expected, frame.width, frame.height));
  });

  it('补识别词框较小且嵌于原词框时仍去重，保留先识别的真实位置', () => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, ['微信']);
    detection.words.push({ text: '微信', ocrPass: 1, rect: { x: 40, y: 25, width: 20, height: 10 } });
    const result = evaluateLocalFrame(frame, detection);
    expect(result).toMatchObject({ decision: 'allow' });
    if (result.decision !== 'allow') throw new Error('missing nested WeChat entry');
    expect(result.elements).toEqual([{ id: expect.any(String), label: '微信', rect: detection.words[0].rect }]);
  });

  it('补识别的微、信合并后与原尺度微信只保留一个入口', () => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, []);
    detection.words = [
      { text: '微信', rect: { x: 20, y: 20, width: 42, height: 30 } },
      { text: '微', ocrPass: 1, rect: { x: 20, y: 20, width: 20, height: 30 } },
      { text: '信', ocrPass: 1, rect: { x: 42, y: 20, width: 20, height: 30 } },
    ];
    const result = evaluateLocalFrame(frame, detection);
    expect(result).toMatchObject({ decision: 'allow' });
    if (result.decision !== 'allow') throw new Error('missing merged duplicate WeChat entry');
    expect(result.elements).toEqual([{ id: expect.any(String), label: '微信', rect: detection.words[0].rect }]);
  });

  it.each(['wechat', 'WECHAT', 'ＷｅＣｈａｔ'])('同位置英文微信标签 %s 按规范化结果去重', text => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, ['WeChat']);
    detection.words.push({ text, ocrPass: 1, rect: { ...detection.words[0].rect } });
    const result = evaluateLocalFrame(frame, detection);
    expect(result).toMatchObject({ decision: 'allow' });
    if (result.decision !== 'allow') throw new Error('missing normalized WeChat entry');
    expect(result.elements).toEqual([{ id: expect.any(String), label: 'WeChat', rect: detection.words[0].rect }]);
  });

  it('同位置但不同标签不能被跨尺度去重误删', () => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, ['微信']);
    detection.words.push({ text: '发现', ocrPass: 1, rect: { ...detection.words[0].rect } });
    const result = evaluateLocalFrame(frame, detection);
    expect(result).toMatchObject({ decision: 'allow' });
    if (result.decision !== 'allow') throw new Error('missing distinct public entries');
    expect(result.elements.map(element => element.label)).toEqual(['微信', '发现']);
  });

  it.each(['验证码', '私人聊天', '付款确认', '13812345678', 'private@example.test'])('仅补识别发现敏感文字 %s 时，即使微信已去重也拒绝发送', text => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, ['微信']);
    detection.words.push(
      { text: '微信', ocrPass: 1, rect: { ...detection.words[0].rect } },
      { text, ocrPass: 1, rect: { x: 20, y: 60, width: 160, height: 30 } },
    );
    const result = evaluateLocalFrame(frame, detection);
    expect(result).toMatchObject({ decision: 'pause', reason: 'sensitive_screen', risk: 'private' });
    expect(isAdmittedFrame(result)).toBe(false);
    expect(result).not.toHaveProperty('elements');
    expect(result).not.toHaveProperty('sanitizedPng');
    expect(JSON.stringify(result)).not.toContain(text);
  });

  it('仅补识别发现拆词验证码时仍检查完整敏感内容', () => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, ['微信']);
    detection.words.push(...['验', '证', '码'].map((text, index) => ({ text, ocrPass: 1, rect: { x: 20 + index * 22, y: 60, width: 20, height: 30 } })));
    expect(evaluateLocalFrame(frame, detection)).toMatchObject({ decision: 'pause', reason: 'sensitive_screen', risk: 'private' });
  });

  it('放大补识别出的公共微信不能覆盖原尺度发现的敏感文字', () => {
    const frame = syntheticFrame();
    const detection = syntheticDetection(frame, ['私人聊天']);
    detection.words.push({ text: '微信', ocrPass: 1, rect: { x: 20, y: 60, width: 100, height: 30 } });
    expect(evaluateLocalFrame(frame, detection)).toMatchObject({ decision: 'pause', reason: 'sensitive_screen', risk: 'private' });
  });
});

describe('本人确认关闭本机遮盖后的原始帧放行（合成单测，不代表真实验收）', () => {
  function rawDetection(frame: ReturnType<typeof syntheticFrame>) {
    return { ...syntheticDetection(frame, ['设置', '显示', '文本大小']), redaction: { text: false, faces: false }, sanitizedPng: Buffer.from(frame.png) };
  }

  it('原始模式接受未遮盖的帧，并标记上传内容为原始画面', () => {
    const frame = syntheticFrame();
    const detection = rawDetection(frame);
    const result = evaluateLocalFrame(frame, detection, { authorizedSharing: true, unredactedUpload: true });
    expect(result).toMatchObject({ decision: 'allow', scene: 'owner_approved_unredacted', redactionProfile: 'owner_approved_none', unredacted: true });
    if (result.decision !== 'allow') throw new Error('expected raw allow');
    expect(result.sanitizedPng).toEqual(frame.png);
    expect(result.elements.map(element => element.label)).toContain('显示');
    expect(isAdmittedFrame(result)).toBe(true);
  });

  it('默认仍然拒绝未遮盖的帧，不会因为新开关放松默认值', () => {
    const frame = syntheticFrame();
    const detection = rawDetection(frame);
    expect(evaluateLocalFrame(frame, detection, { authorizedSharing: true })).toMatchObject({ decision: 'pause', reason: 'incomplete_local_detection' });
  });

  it('原始模式仍执行检测完整性、年龄检查', () => {
    const frame = syntheticFrame();
    const stale = { ...rawDetection(frame), status: 'unavailable' as const, reason: 'local_detector_unavailable' };
    expect(evaluateLocalFrame(frame, stale, { authorizedSharing: true, unredactedUpload: true })).toMatchObject({ decision: 'pause', reason: 'local_detector_unavailable' });
    const aged = { ...frame, capturedAt: frame.capturedAt - 6000 };
    expect(evaluateLocalFrame(aged, rawDetection(aged), { authorizedSharing: true, unredactedUpload: true, now: frame.capturedAt })).toMatchObject({ decision: 'pause', reason: 'stale_frame' });
  });
});
