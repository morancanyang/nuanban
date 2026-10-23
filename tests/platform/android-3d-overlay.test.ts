import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const androidRoot = fileURLToPath(new URL('../../apps/android/', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const nativeRoot = 'app/src/standalone/java/org/nuanban/assistant/nativehost/';
const readAndroid = (relativePath: string) => readFileSync(androidRoot + relativePath, 'utf8');
const docPath = workspaceRoot + 'docs/implementation/android-3d-pet.md';

describe('Android 独立桌宠实时 3D：悬浮层行为与回退路径', () => {
  it('悬浮层保留静态 PNG 常驻、拖动、单击与遮挡拒收，且服务层不直接接触 WebView', () => {
    const service = readAndroid(nativeRoot + 'PetRuntimeService.kt');
    // 升级前的行为必须逐条保留。
    expect(service).toContain('ImageView(this)');
    expect(service).toContain('R.drawable.nuanban_pet_preview');
    expect(service).toContain('filterTouchesWhenObscured = true');
    expect(service).toContain('WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY');
    expect(service).toContain('WindowManager.LayoutParams.FLAG_SECURE');
    expect(service).toContain('event.rawX');
    expect(service).toContain('view.performClick()');
    expect(service).toContain('MotionEvent.ACTION_CANCEL -> true');
    expect(service).toContain('setOnClickListener { togglePanel() }');
    expect(service).toContain('PetStopReceiver.ACTION_STOP');
    expect(service).toContain('handler.removeCallbacksAndMessages(null)');
    expect(service).toContain('Intent.ACTION_SCREEN_OFF');
    expect(service).toContain('isKeyguardLocked');
    // 渲染选型只经由 Pet3dOverlay 暴露的接口，服务本身不出现 WebView/GLES 细节。
    expect(service).toContain('Pet3dOverlay(this, staticPet)');
    expect(service).toContain('pet3d?.toggleRealTime3d()');
    expect(service).toContain('Pet3dRenderPolicy.statusLine');
    expect(service).not.toMatch(/WebView|GLSurfaceView|GLES20/);
    expect(existsSync(androidRoot + 'app/src/standalone/res/drawable-nodpi/nuanban_pet_preview.png')).toBe(true);
  });

  it('宿主视图把静态图作为常驻子视图，3D 子视图不可交互，摘除 3D 即回到静态图', () => {
    const bubble = readAndroid(nativeRoot + 'Pet3dBubbleView.kt');
    expect(bubble).toContain('addView(fallback, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))');
    expect(bubble).toContain('override fun onInterceptTouchEvent(event: MotionEvent): Boolean = true');
    expect(bubble).toContain('view.isClickable = false');
    expect(bubble).toContain('view.isFocusable = false');
    expect(bubble).toContain('fallback.visibility = View.VISIBLE');
    expect(bubble).toContain('fallback.visibility = View.INVISIBLE');
    const detach = bubble.slice(bubble.indexOf('fun detach3d()'), bubble.indexOf('fun mark3dReady()'));
    expect(detach.indexOf('fallback.visibility = View.VISIBLE')).toBeLessThan(detach.indexOf('lifecycle?.shutdown()'));
  });

  it('编排层按策略升层回退：后台校验、watchdog 超时、连续失败封闭、可切换回静态图', () => {
    const overlay = readAndroid(nativeRoot + 'Pet3dOverlay.kt');
    expect(overlay).toContain('Pet3dAssets.loadVerified(context)');
    expect(overlay).toContain('Pet3dAssets.probe(context, loaded)');
    expect(overlay).toContain('Pet3dRenderPolicy.decide(input)');
    expect(overlay).toContain('Pet3dRenderPolicy.MAX_CONSECUTIVE_FAILURES');
    expect(overlay).toContain('Pet3dRenderPolicy.afterFailure(inputFor(it), surfaceMode)');
    expect(overlay).toContain('Pet3dRenderPolicy.REASON_FAIL_CLOSED');
    expect(overlay).toContain('handler.postDelayed(runnable, READY_TIMEOUT_MS)');
    expect(overlay).toContain('const val READY_TIMEOUT_MS = 8000L');
    expect(overlay).toContain('failedModes.add(surfaceMode)');
    expect(overlay).toContain('consecutiveFailures++');
    expect(overlay).toContain('executor.shutdownNow()');
    expect(overlay).toContain('RejectedExecutionException');
    // 切换实时 3D 时清空失败记录，关闭时立即回到静态形象。
    const toggle = overlay.slice(overlay.indexOf('fun toggleRealTime3d()'), overlay.indexOf('fun pause()'));
    expect(toggle).toContain('failedModes.clear()');
    expect(toggle).toContain('consecutiveFailures = 0');
    expect(toggle).toContain('decideAndAttach()');
    expect(overlay).toContain('Pet3dRenderPolicy.REASON_USER_DISABLED');
  });

  it('原生 GL 层对超出支持范围的模型失败封闭，不静默画错', () => {
    const renderer = readAndroid(nativeRoot + 'Pet3dGlRenderer.kt');
    for (const code of [
      'native_skinning_unsupported', 'native_morph_targets_unsupported', 'native_primitive_mode_unsupported',
      'native_index_out_of_range', 'native_no_mesh_instances', 'native_shader_compile_failed', 'native_shader_link_failed',
      'native_gl_upload_error',
    ]) expect(renderer).toContain(code);
    expect(renderer).toContain('onFailure(reason)');
    expect(renderer).toContain('Pet3dGlb.inspect(modelBytes)');
    expect(renderer).toContain('if (facts.skinned)');
    // 动画采样只实现 LINEAR/STEP，CUBICSPLINE 明确跳过。
    expect(renderer).toContain('sampler.interpolation == "CUBICSPLINE"');
    const glView = readAndroid(nativeRoot + 'Pet3dGlView.kt');
    expect(glView).toContain('setEGLContextClientVersion(2)');
    expect(glView).toContain('PixelFormat.TRANSLUCENT');
    expect(glView).toContain('setZOrderOnTop(true)');
    expect(glView).toContain('preserveEGLContextOnPause = true');
  });

  it('渲染层与原生层都不新增网络/采集能力，也不写日志到业务之外', () => {
    for (const file of ['Pet3dGlRenderer.kt', 'Pet3dGlView.kt', 'Pet3dOverlay.kt', 'Pet3dAssets.kt']) {
      const source = readAndroid(nativeRoot + file);
      expect(source).not.toMatch(/MediaProjection|ImageReader|SpeechRecognizer|AudioRecord|MediaRecorder|AccessibilityService/);
      expect(source).not.toMatch(/HttpURLConnection|Socket\(|openConnection|URL\(/);
    }
    const assets = readAndroid(nativeRoot + 'Pet3dAssets.kt');
    expect(assets).toContain('context.assets.open(MODEL_ASSET_PATH)');
    expect(assets).toContain('if (digest != PINNED_MODEL_SHA256) return ModelLoad.DigestMismatch(digest)');
    const stats = readAndroid(nativeRoot + 'Pet3dFrameStats.kt');
    expect(stats).toContain('const val TAG = "NuanbanPet3d"');
    expect(stats).toContain('deviceVerified=false');
  });

  it('文档明确标注未做真机验收，并给出可执行的测量与验收步骤、判据与异常路径预期', () => {
    expect(existsSync(docPath)).toBe(true);
    const doc = readFileSync(docPath, 'utf8');
    expect(doc).toContain('deviceVerified=false');
    expect(doc).toContain('未测');
    for (const command of ['dumpsys gfxinfo', 'dumpsys meminfo', 'dumpsys batterystats', 'logcat -s NuanbanPet3d']) {
      expect(doc).toContain(command);
    }
    for (const phase of ['webview_three_js', 'native_gl', 'static_png']) expect(doc).toContain(phase);
    expect(doc).toContain('measure-pet3d.ps1');
    // 真机验收清单（邀请所有者执行、由 lead 记录结果）必须覆盖 lead 要求的四类内容。
    expect(doc).toContain('accept-pet3d.ps1');
    expect(doc).toContain('邀请所有者执行');
    for (const covered of [
      'adb install', 'SYSTEM_ALERT_WINDOW', 'POST_NOTIFICATIONS', 'FLAG_SECURE', 'overlayRegionUniformBlack',
      'fallback-missing', 'fallback-corrupt', 'Ppet3dModelVariant', 'am start-foreground-service', 'Janky frames',
      'ACTION_SCREEN_OFF', '旋转', '低电量', '关闭系统动画',
    ]) expect(doc).toContain(covered);
    expect(doc).toContain('结果（lead 填）');
    // 不允许出现编造的实测数字：不得声称已实测帧率/内存/耗电。
    expect(doc).not.toMatch(/实测[^。\n]{0,20}\d+\s*(fps|帧|MB|mAh)/i);
    expect(doc).not.toMatch(/deviceVerified\s*=\s*true/);
    expect(doc).not.toMatch(/已通过真机|真机已验证|线上已更新/);
  });

  it('旋转与“关闭系统动画”有明确实现：夹取坐标 + 只渲染静态一帧', () => {
    const service = readAndroid(nativeRoot + 'PetRuntimeService.kt');
    expect(service).toContain('registerComponentCallbacks(configurationWatcher)');
    expect(service).toContain('unregisterComponentCallbacks(configurationWatcher)');
    expect(service).toContain('override fun onConfigurationChanged(newConfig: Configuration) { clampBubbleIntoDisplay() }');
    const clamp = service.slice(service.indexOf('private fun clampBubbleIntoDisplay()'));
    expect(clamp).toContain('resources.displayMetrics');
    expect(clamp).toContain('updateViewLayout(view, layout)');
    const glView = readAndroid(nativeRoot + 'Pet3dGlView.kt');
    expect(glView).toContain('ValueAnimator.areAnimatorsEnabled()');
    expect(glView).toContain('RENDERMODE_WHEN_DIRTY');
    const page = readFileSync(androidRoot + 'app/src/standalone/assets/pet3d/viewer/pet3d-viewer.js', 'utf8');
    expect(page).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
    expect(page).toContain('motion_reduced');
  });
});