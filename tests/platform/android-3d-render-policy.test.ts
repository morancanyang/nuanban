import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const androidRoot = fileURLToPath(new URL('../../apps/android/', import.meta.url));
const checkScript = androidRoot + 'standalone/tools/pet3d/check-pet3d.ps1';
const modelManifestPath = androidRoot + '../web/public/models/lumi/character_manifest.json';

interface Pet3dCheckResult {
  passed: boolean;
  caseCount: number;
  kotlinCaseCount: number;
  cases: string[];
  failures: Record<string, string>;
  bundledModel: {
    readable: boolean;
    sha256: string;
    byteSize: number;
    gltfVersion: string;
    meshCount: number;
    primitiveCount: number;
    nodeCount: number;
    skinCount: number;
    materialCount: number;
    imageCount: number;
    textureCount: number;
    triangleCount: number;
    vertexCount: number;
    extensionsRequired: string[];
    animationNames: string[];
    hasIdleAnimation: boolean;
    selfContained: boolean;
    positionBoundsMin: number[];
    positionBoundsMax: number[];
  };
  policyThresholds: { webviewMinMajorVersion: number; webviewMinTotalMemoryMb: number; nativeMinTotalMemoryMb: number; maxConsecutiveFailures: number };
  assetParity: { bundledModelSha256: string; bundledModelBytes: number; desktopModelPin: string; kotlinRuntimePin: string; characterManifestSha256: string; apkAssetPath: string };
  vendoredThree: { checked: boolean; matches: boolean; detail: string; files: { file: string; matches: boolean; sha256: string }[] };
  androidTypecheck: { ok: boolean; sources: string[] };
  deviceVerified: boolean;
  captureExecuted: boolean;
  cloudExecuted: boolean;
  networkExecuted: boolean;
}

let cachedResult: Pet3dCheckResult | undefined;

function runPet3dChecks(): Pet3dCheckResult {
  if (cachedResult) return cachedResult;
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', checkScript], {
      cwd: workspaceRoot, encoding: 'utf8', timeout: 300_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    }).trim();
    cachedResult = JSON.parse(output) as Pet3dCheckResult;
    return cachedResult;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout?.trim() ?? '';
    const parsed = stdout ? (JSON.parse(stdout) as Pet3dCheckResult) : undefined;
    if (parsed) { cachedResult = parsed; return parsed; }
    throw error;
  }
}

describe('Android 独立桌宠实时 3D：离线渲染/回退用例', () => {
  it.skipIf(process.platform !== 'win32')('离线执行策略与 GLB 数据层用例（真读随包模型，不冒充设备测试）', () => {
    const result = runPet3dChecks();
    expect(result.failures).toEqual({});
    expect(result.passed).toBe(true);
    expect(result.caseCount).toBe(result.cases.length);
    expect(new Set(result.cases).size).toBe(result.caseCount);
    expect(result.caseCount).toBeGreaterThanOrEqual(40);
    expect(result.kotlinCaseCount).toBeGreaterThanOrEqual(30);
    for (const scenario of [
      'policy_capable_device_selects_webview_three_js',
      'policy_low_ram_device_selects_native_gl',
      'policy_small_memory_device_falls_back_to_static_png',
      'policy_old_webview_engine_selects_native_gl',
      'policy_without_gles_support_falls_back_to_static_png',
      'policy_missing_bundled_model_falls_back_to_static_png',
      'policy_unverified_model_digest_falls_back_to_static_png',
      'policy_user_disabled_3d_falls_back_to_static_png',
      'policy_webview_failure_escalates_to_native_gl',
      'policy_native_failure_escalates_to_static_png',
      'policy_two_consecutive_failures_fail_closed',
      'policy_failed_modes_are_never_reselected',
      'policy_chain_is_ordered_and_ends_with_static_png',
      'glb_accepts_minimal_self_contained_triangle',
      'glb_rejects_bad_magic_and_unsupported_version',
      'glb_rejects_declared_length_mismatch_and_truncation',
      'glb_rejects_external_buffer_and_image_uris',
      'glb_rejects_sparse_accessor',
      'glb_rejects_accessor_range_beyond_bin_chunk',
      'glb_rejects_unsupported_gltf_1_and_missing_asset',
      'glb_rejects_primitive_without_position_attribute',
      'glb_rejects_json_chunk_with_invalid_syntax',
      'pet3d_android_sources_typecheck_against_android_jar',
      'bundled_model_matches_web_public_digest',
      'bundled_model_matches_character_manifest_digest',
      'bundled_model_matches_desktop_model_pin',
      'bundled_model_matches_kotlin_runtime_pin',
      'vendored_three_runtime_matches_node_modules',
    ]) expect(result.cases).toContain(scenario);
    expect(result).toMatchObject({ deviceVerified: false, captureExecuted: false, cloudExecuted: false, networkExecuted: false });
  }, 300_000);

  it.skipIf(process.platform !== 'win32')('随包 GLB 的结构事实与桌面端 manifest 一致，且模型可被原生层读取', () => {
    const result = runPet3dChecks();
    const manifest = JSON.parse(readFileSync(modelManifestPath, 'utf8')) as {
      runtime: { sha256: string; fileBytes: number; triangleCount: number; meshCount: number; skeleton: { boneCount: number }; animations: { name: string; kind: string }[]; limitations: string[] };
    };
    expect(result.bundledModel.readable).toBe(true);
    expect(result.bundledModel.gltfVersion.startsWith('2.')).toBe(true);
    expect(result.bundledModel.sha256).toBe(manifest.runtime.sha256);
    expect(result.bundledModel.byteSize).toBe(manifest.runtime.fileBytes);
    expect(result.bundledModel.triangleCount).toBe(manifest.runtime.triangleCount);
    expect(result.bundledModel.meshCount).toBe(manifest.runtime.meshCount);
    expect(result.bundledModel.skinCount).toBe(manifest.runtime.skeleton.boneCount);
    expect(manifest.runtime.skeleton.boneCount).toBe(0);
    expect(manifest.runtime.animations.some(animation => animation.name === 'idle' && animation.kind === 'object-transform')).toBe(true);
    expect(result.bundledModel.animationNames).toContain('idle');
    expect(result.bundledModel.hasIdleAnimation).toBe(true);
    expect(result.bundledModel.selfContained).toBe(true);
    expect(result.bundledModel.extensionsRequired).toContain('KHR_texture_transform');
    expect(result.bundledModel.imageCount).toBeGreaterThan(0);
    expect(result.bundledModel.textureCount).toBeGreaterThan(0);
    expect(result.bundledModel.positionBoundsMin).toHaveLength(3);
    expect(result.bundledModel.positionBoundsMax).toHaveLength(3);
    expect(result.bundledModel.positionBoundsMin.every(Number.isFinite)).toBe(true);
    expect(result.bundledModel.positionBoundsMax.every(Number.isFinite)).toBe(true);
  }, 300_000);

  it.skipIf(process.platform !== 'win32')('依赖 Android API 的 pet3d 源文件确实通过 android.jar 类型检查（可编译 ≠ 已验证渲染）', () => {
    const result = runPet3dChecks();
    expect(result.androidTypecheck.ok).toBe(true);
    expect(result.androidTypecheck.sources).toEqual([
      'Pet3dRenderPolicy.kt', 'Pet3dGlbDocument.kt', 'Pet3dAssets.kt', 'Pet3dFrameStats.kt',
      'Pet3dGlRenderer.kt', 'Pet3dGlView.kt', 'Pet3dWebView.kt', 'Pet3dBubbleView.kt', 'Pet3dOverlay.kt',
    ]);
    expect(result.vendoredThree.checked).toBe(true);
    expect(result.vendoredThree.matches).toBe(true);
    expect(result.vendoredThree.files).toHaveLength(5);
    expect(result.vendoredThree.files.every(file => file.matches && /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
  }, 300_000);

  it('策略阈值与运行时一致，且资产四路摘要相同（public 文件 / manifest / 桌面 pin / Kotlin pin）', () => {
    const policy = readFileSync(androidRoot + 'app/src/standalone/java/org/nuanban/assistant/nativehost/Pet3dRenderPolicy.kt', 'utf8');
    for (const [name, value] of [['WEBVIEW_MIN_MAJOR_VERSION', 90], ['WEBVIEW_MIN_TOTAL_MEMORY_MB', 4096], ['NATIVE_MIN_TOTAL_MEMORY_MB', 2048], ['MAX_CONSECUTIVE_FAILURES', 2]] as const) {
      expect(policy).toContain(`const val ${name} = ${value}`);
    }
    if (process.platform !== 'win32') return;
    const result = runPet3dChecks();
    expect(result.policyThresholds).toEqual({ webviewMinMajorVersion: 90, webviewMinTotalMemoryMb: 4096, nativeMinTotalMemoryMb: 2048, maxConsecutiveFailures: 2 });
    const digests = new Set([
      result.assetParity.bundledModelSha256, result.assetParity.desktopModelPin,
      result.assetParity.kotlinRuntimePin, result.assetParity.characterManifestSha256,
    ]);
    expect(digests.size).toBe(1);
    expect(/^[a-f0-9]{64}$/.test(result.assetParity.desktopModelPin)).toBe(true);
    expect(result.assetParity.bundledModelBytes).toBeGreaterThan(1_000_000);
    expect(result.assetParity.apkAssetPath).toBe('pet3d/models/lumi/Lumi_Magical_Kitten.glb');
  }, 300_000);
});