package org.nuanban.assistant.nativehost

/**
 * 独立桌宠悬浮形象的渲染选型策略（纯 Kotlin，无 Android 依赖，可离线在 JVM 中执行用例）。
 *
 * 三个层级：
 *  - CONTROLLED_WEBVIEW：受控 WebView + three.js（与桌面端同版本 three/GLTFLoader、同一 GLB 与 digest），保真度最高；
 *  - NATIVE_GL：原生 GLSurfaceView + 轻量 GLB 渲染（内存与耗电更低，材质仅近似，用于低端机或 WebView 不可用）；
 *  - STATIC_PNG：随包静态 PNG，渲染失败、资源缺失/校验失败、低端机与用户手动关闭实时 3D 时的终态回退。
 *
 * 该策略只做“选择”，不假装做过真机测量；阈值集中在常量里，需真机数据后再调整（见 docs/implementation/android-3d-pet.md）。
 */
enum class Pet3dRenderMode { CONTROLLED_WEBVIEW, NATIVE_GL, STATIC_PNG }

data class Pet3dRenderInput(
    /** 随包 GLB 是否存在（assets/pet3d/models/lumi/Lumi_Magical_Kitten.glb）。 */
    val bundledModelPresent: Boolean,
    /** 随包 GLB 的 SHA-256 是否等于与桌面端一致的固定摘要；不相等时不得渲染未校验的字节。 */
    val modelDigestVerified: Boolean,
    /** 系统 WebView 是否可用（未禁用、已安装）。 */
    val webViewEngineAvailable: Boolean,
    /** 系统 WebView 主版本号；低于阈值不启用 importmap/ESM + WebGL2 路径。 */
    val webViewMajorVersion: Int,
    /** 设备 GLES 主版本（ActivityManager.deviceConfigurationInfo.glEsVersion 解析）。 */
    val glesMajorVersion: Int,
    /** ActivityManager.isLowRamDevice。 */
    val isLowRamDevice: Boolean,
    /** 设备总内存（MB）。 */
    val totalMemoryMb: Int,
    /** 已经失败的 3D 层级；失败过的不再重复尝试。 */
    val failedModes: Set<Pet3dRenderMode> = emptySet(),
    /** 当前层级连续失败次数；达到上限即封闭到静态 PNG。 */
    val consecutiveFailures: Int = 0,
    /** 本人在面板里关闭实时 3D（进程内偏好，不持久化）。 */
    val userDisabled3d: Boolean = false,
)

data class Pet3dRenderDecision(val mode: Pet3dRenderMode, val reason: String, val chain: List<Pet3dRenderMode>)

object Pet3dRenderPolicy {
    /** importmap + ESM 需要 Chrome/WebView 89+；WebGL2 与 three r186 取更保守的 90。 */
    const val WEBVIEW_MIN_MAJOR_VERSION = 90
    /** WebView 渲染进程内存开销较大，只在内存充足的设备上作为首选。 */
    const val WEBVIEW_MIN_TOTAL_MEMORY_MB = 4096
    /** 原生 GL 层的最低总内存；再低则用静态图，避免为小浮层挤占内存。 */
    const val NATIVE_MIN_TOTAL_MEMORY_MB = 2048
    const val NATIVE_MIN_GLES_MAJOR = 2
    /** 连续失败上限：不做无限重试，避免在低端机上反复起渲染进程。 */
    const val MAX_CONSECUTIVE_FAILURES = 2

    const val REASON_USER_DISABLED = "user_disabled_real_time_3d"
    const val REASON_MODEL_MISSING = "bundled_model_missing"
    const val REASON_MODEL_UNVERIFIED = "bundled_model_digest_mismatch"
    const val REASON_FAIL_CLOSED = "renderer_failure_fail_closed"
    const val REASON_WEBVIEW = "webview_three_js_selected"
    const val REASON_NATIVE_WEBVIEW_UNAVAILABLE = "native_gl_webview_unavailable"
    const val REASON_NATIVE_AFTER_WEBVIEW_FAILURE = "native_gl_after_webview_failure"
    const val REASON_NO_RENDERER = "no_viable_renderer_static_png"

    fun webViewViable(input: Pet3dRenderInput): Boolean = input.webViewEngineAvailable &&
        input.webViewMajorVersion >= WEBVIEW_MIN_MAJOR_VERSION &&
        !input.isLowRamDevice &&
        input.totalMemoryMb >= WEBVIEW_MIN_TOTAL_MEMORY_MB

    fun nativeGlViable(input: Pet3dRenderInput): Boolean = input.glesMajorVersion >= NATIVE_MIN_GLES_MAJOR &&
        input.totalMemoryMb >= NATIVE_MIN_TOTAL_MEMORY_MB

    /** 可用层级链（含终态静态图），从最高保真到最低。 */
    fun chain(input: Pet3dRenderInput): List<Pet3dRenderMode> {
        val modes = ArrayList<Pet3dRenderMode>(3)
        if (webViewViable(input)) modes.add(Pet3dRenderMode.CONTROLLED_WEBVIEW)
        if (nativeGlViable(input)) modes.add(Pet3dRenderMode.NATIVE_GL)
        modes.add(Pet3dRenderMode.STATIC_PNG)
        return modes
    }

    fun decide(input: Pet3dRenderInput): Pet3dRenderDecision {
        val chain = chain(input)
        if (input.userDisabled3d) return Pet3dRenderDecision(Pet3dRenderMode.STATIC_PNG, REASON_USER_DISABLED, chain)
        if (!input.bundledModelPresent) return Pet3dRenderDecision(Pet3dRenderMode.STATIC_PNG, REASON_MODEL_MISSING, chain)
        if (!input.modelDigestVerified) return Pet3dRenderDecision(Pet3dRenderMode.STATIC_PNG, REASON_MODEL_UNVERIFIED, chain)
        if (input.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return Pet3dRenderDecision(Pet3dRenderMode.STATIC_PNG, REASON_FAIL_CLOSED, chain)
        val chosen = chain.firstOrNull { it != Pet3dRenderMode.STATIC_PNG && it !in input.failedModes }
            ?: return Pet3dRenderDecision(Pet3dRenderMode.STATIC_PNG, REASON_NO_RENDERER, chain)
        val reason = when (chosen) {
            Pet3dRenderMode.CONTROLLED_WEBVIEW -> REASON_WEBVIEW
            Pet3dRenderMode.NATIVE_GL -> if (webViewViable(input)) REASON_NATIVE_AFTER_WEBVIEW_FAILURE else REASON_NATIVE_WEBVIEW_UNAVAILABLE
            Pet3dRenderMode.STATIC_PNG -> REASON_NO_RENDERER
        }
        return Pet3dRenderDecision(chosen, reason, chain)
    }

    /** 渲染层失败后的下一步决策：把失败层加入排除集，并累计连续失败次数。 */
    fun afterFailure(input: Pet3dRenderInput, failedMode: Pet3dRenderMode): Pet3dRenderDecision =
        decide(input.copy(failedModes = input.failedModes + failedMode, consecutiveFailures = input.consecutiveFailures + 1))

    fun label(mode: Pet3dRenderMode): String = when (mode) {
        Pet3dRenderMode.CONTROLLED_WEBVIEW -> "实时 3D · three.js（受控 WebView）"
        Pet3dRenderMode.NATIVE_GL -> "实时 3D · 原生 GLES"
        Pet3dRenderMode.STATIC_PNG -> "随包静态形象"
    }

    fun statusLine(mode: Pet3dRenderMode, reason: String): String = "形象：" + label(mode) + "（" + reason + "）"
}