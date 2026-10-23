import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const androidRoot = fileURLToPath(new URL('../../apps/android/', import.meta.url));
const nativeRoot = 'app/src/standalone/java/org/nuanban/assistant/nativehost/';
const readAndroid = (relativePath: string) => readFileSync(androidRoot + relativePath, 'utf8');

describe('Android 独立桌宠原生安全闭环', () => {
  it.skipIf(process.platform !== 'win32')('实际执行 Kotlin 会话、门控、资源清理及管理停止隔离用例，不冒充设备测试', () => {
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', androidRoot + 'check-standalone.ps1',
    ], { cwd: workspaceRoot, encoding: 'utf8', timeout: 120_000, windowsHide: true }).trim();
    const result = JSON.parse(output) as { passed: boolean; caseCount: number; cases: string[]; deviceVerified: boolean; captureExecuted: boolean; cloudExecuted: boolean };
    expect(result.passed).toBe(true);
    expect(result.caseCount).toBe(result.cases.length);
    expect(result.caseCount).toBeGreaterThanOrEqual(250);
    expect(new Set(result.cases).size).toBe(result.caseCount);
    for (const scenario of [
      'default_no_capture_or_channels',
      'missing_detector_prevents_authorization',
      'system_consent_one_use',
      'management_stop_does_not_change_observation_or_teaching',
      'management_stop_does_not_cancel_pending_pet_consent',
      'management_waits_for_pet_resource_cleanup',
      'ending_teaching_preserves_observation',
      'privacy_recovery_requires_fresh_native_and_system_consent',
      'stale_stop_cannot_cancel_new_observation',
      'process_restart_does_not_restore_observation',
      'gate_sensitive',
      'gate_unknown',
      'capture_cleanup_failure_remains_fail_closed',
      'late_capture_frame_is_closed_not_reused',
      'optional_cloud_consent_is_separate_and_not_restored',
      'android_teaching_new_expected_label_can_complete',
      'android_teaching_layout_change_not_completion',
      'android_geometry_single_app_mismatch_rejected',
      'android_adapter_unknown_trigger_rejected',
      'guidance_protocol_default_gate_denies',
    ]) expect(result.cases).toContain(scenario);
    expect(result).toMatchObject({ deviceVerified: false, captureExecuted: false, cloudExecuted: false });
  }, 120_000);

  it('分离 specialUse 驻留与 mediaProjection 捕获，不申请麦克风、无障碍或开机自启', () => {
    const manifest = readAndroid('standalone/src/main/AndroidManifest.xml');
    const petService = manifest.match(/<service\b[^>]*android:name="\.nativehost\.PetRuntimeService"[^>]*>/)?.[0];
    const captureService = manifest.match(/<service\b[^>]*android:name="\.nativehost\.NativeCaptureService"[^>]*>/)?.[0];
    expect(petService).toContain('android:foregroundServiceType="specialUse"');
    expect(petService).toContain('android:exported="false"');
    expect(petService).toContain('android:stopWithTask="false"');
    expect(captureService).toContain('android:foregroundServiceType="mediaProjection"');
    expect(captureService).toContain('android:stopWithTask="false"');
    expect(manifest).toContain('android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE');
    expect(manifest).toContain('android:name=".nativehost.PetControlActivity" android:exported="true"');
    expect(manifest).not.toMatch(/RECORD_AUDIO|BIND_ACCESSIBILITY_SERVICE|AccessibilityService|RECEIVE_BOOT_COMPLETED/);
  });

  it('普通 app 恢复原权限与入口，并在源集层面不编译独立桌宠和捕获实现', () => {
    const manifest = readAndroid('app/src/main/AndroidManifest.xml');
    const build = readAndroid('app/build.gradle.kts');
    const standaloneBuild = readAndroid('standalone/build.gradle.kts');
    const host = readAndroid('app/src/normal/java/org/nuanban/assistant/nativehost/AndroidHostRuntime.kt');
    expect([...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map(match => match[1]).sort()).toEqual([
      'android.permission.POST_NOTIFICATIONS', 'android.permission.SCHEDULE_EXACT_ALARM',
    ]);
    expect(manifest).toContain('android:name=".MainActivity" android:exported="true"');
    expect(manifest).not.toMatch(/PetRuntimeService|NativeCaptureService|PetControlActivity|mediaProjection|specialUse/);
    expect(build).toContain('src/normal/java');
    expect(build).not.toContain('src/standalone');
    expect(standaloneBuild).toContain('applicationId = "org.nuanban.assistant.standalone"');
    expect(standaloneBuild).toContain('app/src/standalone/java');
    expect(standaloneBuild).not.toContain('app/src/normal/java');
    expect(host).not.toMatch(/MediaProjection|PetRuntime|NativeCapture|TYPE_APPLICATION_OVERLAY/);
    expect(host).toContain('standalone_build_required');
  });

  it('WebView 宿主接入系统文件选择器与本地 TTS，同时明确拒绝网页直接申请采集权限', () => {
    const activity = readAndroid('app/src/main/java/org/nuanban/assistant/MainActivity.kt');
    expect(activity).toContain('onShowFileChooser');
    expect(activity).toContain('WebChromeClient.FileChooserParams.parseResult');
    expect(activity).toContain('Intent.ACTION_GET_CONTENT');
    expect(activity).toContain('override fun onPermissionRequest');
    expect(activity).toContain('request.deny()');
    expect(activity).toContain('android.speech.tts.TextToSpeech');
    expect(activity).toContain('addJavascriptInterface(SpeechJavascriptBridge(), "nuanbanTts")');
    expect(activity).toContain('addDocumentStartJavaScript');
    expect(activity).toContain('__nuanbanTtsEvent');
    expect(activity).not.toMatch(/RECORD_AUDIO|CAMERA|SpeechRecognizer|getUserMedia|MediaRecorder/);
  });

  it('驻留桌宠实际拥有原生输入、通知停止与退出，不依赖 Activity 或 WebView 持有', () => {
    const service = readAndroid(nativeRoot + 'PetRuntimeService.kt');
    expect(service).toContain('class PetRuntimeService : Service()');
    expect(service).toContain('WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY');
    expect(service).toContain('EditText(this)');
    expect(service).toContain('AndroidGuidanceRuntime.ask');
    expect(service).toContain('AndroidGuidanceRuntime.verify');
    expect(service).toContain('AndroidGuidanceRuntime.finishTeaching');
    expect(service).toContain('question.text.clear()');
    expect(service).toContain('R.drawable.nuanban_pet_preview');
    expect(service).toContain('ImageView(this)');
    expect(service).not.toMatch(/text = "[^"]*\\n[^"]*"/);
    expect(existsSync(androidRoot + 'app/src/standalone/res/drawable-nodpi/nuanban_pet_preview.png')).toBe(true);
    expect(service).toContain('PetStopReceiver.ACTION_STOP');
    expect(service).toContain('PetStopReceiver.ACTION_EXIT');
    expect(service).toContain('START_NOT_STICKY');
    expect(service).not.toMatch(/MediaProjectionManager|ImageReader|SpeechRecognizer|AudioRecord|MediaRecorder|WebView|onTaskRemoved/);
  });

  it('原生本人同意不持久化，未就绪检测器在系统捕获授权之前封闭', () => {
    const control = readAndroid(nativeRoot + 'PetControlActivity.kt');
    const request = control.slice(control.indexOf('private fun requestObservation()'), control.indexOf('override fun onRequestPermissionsResult'));
    expect(control).toContain('window.setHideOverlayWindows(true)');
    expect(control).toContain('filterTouchesWhenObscured = true');
    expect(control).toContain('isSaveEnabled = false');
    expect(request).toContain('val nativeConsent = consent.isChecked');
    expect(request).toContain('consent.isChecked = false');
    expect(request).toContain('val nativeCloudConsent = cloudConsent.isChecked');
    expect(request).toContain('cloudConsent.isChecked = false');
    expect(request.indexOf('NativeCaptureRuntime.gate.detectorReady()')).toBeGreaterThan(0);
    expect(request.indexOf('NativeCaptureRuntime.gate.detectorReady()')).toBeLessThan(request.indexOf('createScreenCaptureIntent()'));
    expect(request).toContain('if (petTicket == null) { render(); return }');
    expect(control).not.toMatch(/SharedPreferences|onSaveInstanceState|SpeechRecognizer/);
  });

  it('管理暂停/关闭不是系统锁屏或进程终止，管理 stop_all 先保护独立会话', () => {
    const activity = readAndroid('app/src/main/java/org/nuanban/assistant/MainActivity.kt');
    const lifecycle = activity.slice(activity.indexOf('override fun onPause()'));
    expect(activity).toContain('nuanban:management-pause');
    expect(activity).toContain('nuanban:management-destroy');
    expect(activity).not.toMatch(/nuanban:host-pause|nuanban:host-destroy|PetRuntime\.stopWork/);
    expect(activity).toContain('AndroidHostRuntime.stopManagement');
    const host = readAndroid(nativeRoot + 'AndroidHostRuntime.kt');
    expect(host).toContain('PetManagementBoundary.protectsPetSession');
    expect(host).toContain('PetManagementBoundary.stopReply');
    expect(lifecycle).not.toMatch(/stopService|stopFrom|session\.stop|gate\.stop/);
    expect(readAndroid(nativeRoot + 'PetControlActivity.kt')).toContain('cancelPending("authorization_activity_destroyed")');
  });

  it('真实捕获先注册系统 callback，未知帧停采，释放资源前使会话失效', () => {
    const capture = readAndroid(nativeRoot + 'NativeCaptureService.kt');
    const finish = capture.slice(capture.indexOf('private fun finish('));
    expect(capture.indexOf('registerCallback(projectionCallback, handler)')).toBeLessThan(capture.indexOf('createVirtualDisplay('));
    expect(capture).toContain('if (!NativeCaptureRuntime.gate.detectorReady())');
    expect(capture).toContain('if (!decision.allowed) { local.release(detection.sanitized); finish(CaptureStop.PRIVACY_BLOCKED); return }');
    expect(capture).toContain('local.detect(frame, bitmap, epoch)');
    expect(capture).toContain('AndroidGuidanceRuntime.onFrame(sanitized)');
    expect(capture).toContain('if (petTicket == null) handler.postDelayed(deadline, MAX_DURATION_MS)');
    expect(finish.indexOf('NativeCaptureRuntime.gate.stop()')).toBeLessThan(finish.indexOf('display?.release()'));
    expect(finish.indexOf('PetRuntime.sessions.captureStopped')).toBeLessThan(finish.indexOf('display?.release()'));
    expect(finish).toContain('projection?.stop()');
    expect(finish).toContain('reader?.close()');
  });

  it('原生停止不为了停止而启动前台服务，熄屏/撤权在原生运行时收口', () => {
    const capture = readAndroid(nativeRoot + 'NativeCaptureService.kt');
    const stop = capture.slice(capture.indexOf('fun stopFrom('), capture.indexOf('private val handler'));
    expect(stop).toContain('NativeCaptureRuntime.session.stop(CaptureStop.USER)');
    expect(stop).toContain('NativeCaptureRuntime.gate.stop()');
    expect(stop).toContain('context.stopService(');
    expect(stop).not.toMatch(/startService|startForegroundService/);
    const runtime = readAndroid(nativeRoot + 'PetRuntimeService.kt');
    expect(runtime).toContain('Intent.ACTION_SCREEN_OFF');
    expect(runtime).toContain('isKeyguardLocked');
    expect(runtime).toContain('PetRuntime.privacyPause');
    expect(runtime).toContain('handler.removeCallbacksAndMessages(null)');
  });

  it('缺设备会话或单独云同意保持关闭，不把可能上云的 ASR 或固定步骤冒充教学', () => {
    const gate = readAndroid(nativeRoot + 'LocalFrameGate.kt');
    const runtime = readAndroid(nativeRoot + 'PetRuntime.kt');
    const sessions = readAndroid(nativeRoot + 'PetSessions.kt');
    expect(gate).toContain('detectorVerified: Boolean = false');
    expect(runtime).toContain('unavailable_no_offline_wake_engine');
    expect(runtime).toContain('AndroidGuidanceRuntime.status()');
    expect(runtime).toContain('不录音、不使用可能上云的系统ASR');
    expect(sessions).toContain('authenticated_cloud_guidance_unavailable');
    expect(sessions).toContain('cloudChannelOpen: Boolean = false');
    expect(sessions).toContain('familyChannelOpen: Boolean = false');
  });

  it('使用随包 OCR/人脸模型真实本地检测，同帧遮盖、私有身份准入及超时仍封闭', () => {
    const detector = readAndroid(nativeRoot + 'AndroidLocalScreenDetector.kt');
    const build = readAndroid('standalone/build.gradle.kts');
    expect(build).toContain('com.google.mlkit:text-recognition-chinese:16.0.1');
    expect(build).toContain('com.google.mlkit:face-detection:16.1.7');
    expect(detector).toContain('paths.sorted()');
    expect(detector).toContain('AndroidScreenPolicy.MODEL_FINGERPRINT');
    expect(detector).toContain('IdentityHashMap<LocallySanitizedFrame, Boolean>()');
    expect(detector).toContain('recognizer.process(image)');
    expect(detector).toContain('faceDetector.process(image)');
    expect(detector).toContain('for (rect in textRegions + faces)');
    expect(detector).toContain('finished - frame.capturedAtMs > AndroidScreenPolicy.MAX_DETECTION_MS');
    expect(detector).not.toMatch(/HttpURLConnection|fetch\(|Log\.|println\(/);
  });

  it('真实客户端只接受当前私有准入帧，单飞、停止先失效并取消连接', () => {
    const runtime = readAndroid(nativeRoot + 'AndroidGuidanceRuntime.kt');
    const client = readAndroid(nativeRoot + 'StandaloneGuidanceClient.kt');
    const stop = runtime.slice(runtime.indexOf('@Synchronized fun stopObservation('));
    expect(runtime).toContain('if (active == null) dispatch(frame)');
    expect(runtime).toContain('candidate === pending.request.frame');
    expect(runtime).toContain('isAdmitted(pending.local, SystemClock.elapsedRealtime())');
    expect(runtime).toContain('state.isCurrent(pending.job)');
    expect(runtime).toContain('capture.generation == pending.job.observationGeneration');
    expect(stop.indexOf('cloudConsent = false')).toBeLessThan(stop.indexOf('cancellation?.cancel()'));
    expect(stop).toContain('request?.frame?.erase()');
    expect(client).toContain('channel.requestMethod = "POST"');
    expect(client).toContain('channel.instanceFollowRedirects = false');
    expect(client).toContain('cancellation.attach { channel.disconnect() }');
    expect(client).toContain('guard.afterResponse(request, cancellation)');
    expect(client).not.toMatch(/errorStream|SpeechRecognizer|Log\.|println\(|retry\(/);
  });

  it('真实显示源尺寸与缩小帧尺寸分离，单应用区域及旋转不明时拒绝指引', () => {
    const capture = readAndroid(nativeRoot + 'NativeCaptureService.kt');
    expect(capture).toContain('AndroidCaptureGeometry(sourceWidth, sourceHeight, width, height)');
    expect(capture).toContain('getDisplay(Display.DEFAULT_DISPLAY)).getRealMetrics(metrics)');
    expect(capture).toContain('captureGeometry?.matchesSource(width, height) != true');
    expect(capture).toContain('if (!sourceConfirmed)');
    expect(capture).not.toContain('captureSize = width to height');
    expect(capture).toContain('PetRuntime.localControlsVisible()');
    const overlay = readAndroid(nativeRoot + 'AndroidGuidanceOverlay.kt');
    expect(overlay).toContain('FLAG_NOT_TOUCHABLE');
    expect(overlay).toContain('FLAG_SECURE');
    expect(overlay).toContain('getLocationOnScreen(actual)');
    expect(overlay).toContain('actual[0] != target.x || actual[1] != target.y');
    expect(overlay).not.toMatch(/dispatchGesture|AccessibilityService|Instrumentation|sendPointerSync|Runtime\.getRuntime/);
  });

  it('连接仅原生本人确认后加密保存，不与当次云同意、采集启动合并', () => {
    const connection = readAndroid(nativeRoot + 'AndroidGuidanceConnection.kt');
    expect(connection).toContain('AndroidSecretStore.create(context).write');
    expect(connection).toContain('uri.scheme == "https"');
    expect(connection).toContain('window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)');
    expect(connection).toContain('require(confirmed &&');
    expect(connection).toContain('PetRuntime.stopWork(this@GuidanceConnectionActivity');
    expect(connection).not.toMatch(/startForegroundService|createScreenCaptureIntent|SharedPreferences|Log\.|println\(/);
    const manifest = readAndroid('standalone/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android:name=".nativehost.GuidanceConnectionActivity" android:exported="false"');
    expect(manifest).toContain('TransportBackendDiscovery" tools:node="remove"');
  });
});
