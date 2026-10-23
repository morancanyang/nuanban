package org.nuanban.assistant.nativehost

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * 悬浮形象 3D 的编排层：探测能力与资产 → 让 [Pet3dRenderPolicy] 选层级 → 挂载/回退。
 *
 * 行为要点：
 *  - 资产校验（读 5.4MB + SHA-256 + GLB 结构）在后台线程做，主线程只做视图挂载，避免阻塞悬浮窗；
 *  - 3D 就绪前显示静态 PNG；创建异常、页面/GL 报错、或在 [READY_TIMEOUT_MS] 内没有就绪都会升层回退；
 *  - 连续失败达到策略上限就封闭到静态 PNG，不做无限重试；
 *  - 面板里可切换"实时 3D / 静态形象"（仅进程内偏好，不落盘、不新增存储）。
 */
class Pet3dOverlay(private val context: Context, fallback: View) {
    val view = Pet3dBubbleView(context, fallback)

    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "nuanban-pet3d-probe").apply { isDaemon = true }
    }
    private val failedModes = LinkedHashSet<Pet3dRenderMode>()
    private var consecutiveFailures = 0
    private var userDisabled3d = false
    private var mode = Pet3dRenderMode.STATIC_PNG
    private var reason = Pet3dRenderPolicy.REASON_MODEL_MISSING
    private var modelLoad: Pet3dAssets.ModelLoad? = null
    private var environment: Pet3dRenderInput? = null
    private var pending: Pet3dRenderMode? = null
    private var watchdog: Runnable? = null
    private var destroyed = false

    fun start() {
        decideAndAttach()
    }

    fun statusLine(): String = Pet3dRenderPolicy.statusLine(mode, reason)

    fun currentMode(): Pet3dRenderMode = mode

    fun isRealTime3d(): Boolean = mode != Pet3dRenderMode.STATIC_PNG

    /** 面板按钮：在实时 3D 与静态形象之间切换；重新开启时清空失败记录再试一次。 */
    fun toggleRealTime3d(): String {
        userDisabled3d = !userDisabled3d
        if (!userDisabled3d) {
            failedModes.clear()
            consecutiveFailures = 0
        }
        decideAndAttach()
        return statusLine()
    }

    fun pause() {
        view.pause3d()
    }

    fun resume() {
        view.resume3d()
    }

    fun destroy() {
        destroyed = true
        clearWatchdog()
        handler.removeCallbacksAndMessages(null)
        runCatching { executor.shutdownNow() }
        runCatching { view.detach3d() }
    }

    /**
     * 选择并挂载渲染层。
     *
     * [precomputed] 用于失败升层：由 [Pet3dRenderPolicy.afterFailure] 算出下一步，避免在两层各写一份升层规则。
     * 没有缓存探测结果时（首次启动）在后台线程读资产 + 探测能力，主线程只做视图挂载。
     */
    private fun decideAndAttach(precomputed: Pet3dRenderDecision? = null) {
        if (destroyed) return
        clearWatchdog()
        pending = null
        view.detach3d()
        if (precomputed == null && userDisabled3d) {
            applyStatic(Pet3dRenderPolicy.REASON_USER_DISABLED)
            return
        }
        if (precomputed == null && consecutiveFailures >= Pet3dRenderPolicy.MAX_CONSECUTIVE_FAILURES) {
            applyStatic(Pet3dRenderPolicy.REASON_FAIL_CLOSED)
            return
        }
        val cachedLoad = modelLoad
        val cachedEnvironment = environment
        if (cachedLoad != null && cachedEnvironment != null) {
            applyDecision(precomputed ?: Pet3dRenderPolicy.decide(inputFor(cachedEnvironment)), cachedLoad)
            return
        }
        try {
            executor.execute {
                val loaded = Pet3dAssets.loadVerified(context)
                val probe = Pet3dAssets.probe(context, loaded)
                val input = inputFor(probe)
                val decision = Pet3dRenderPolicy.decide(input)
                handler.post {
                    if (destroyed) return@post
                    modelLoad = loaded
                    environment = probe
                    applyDecision(decision, loaded)
                }
            }
        } catch (_: RejectedExecutionException) {
            applyStatic(Pet3dRenderPolicy.REASON_FAIL_CLOSED)
        }
    }

    private fun inputFor(probe: Pet3dRenderInput): Pet3dRenderInput = probe.copy(
        failedModes = failedModes.toSet(),
        consecutiveFailures = consecutiveFailures,
        userDisabled3d = userDisabled3d,
    )

    private fun applyDecision(decision: Pet3dRenderDecision, load: Pet3dAssets.ModelLoad) {
        if (destroyed) return
        mode = decision.mode
        reason = decision.reason
        val facts = (load as? Pet3dAssets.ModelLoad.Verified)?.facts
        Log.i(
            Pet3dFrameStats.TAG,
            "mode=" + decision.mode + " reason=" + decision.reason + " chain=" + decision.chain.joinToString(">") +
                " meshCount=" + (facts?.meshCount ?: -1) + " skinCount=" + (facts?.skinCount ?: -1) +
                " triangleCount=" + (facts?.triangleCount ?: -1) + " deviceVerified=false",
        )
        if (decision.mode == Pet3dRenderMode.STATIC_PNG) {
            clearWatchdog()
            pending = null
            view.detach3d()
            return
        }
        val attached = try {
            when (decision.mode) {
                Pet3dRenderMode.CONTROLLED_WEBVIEW -> {
                    val surface = Pet3dWebView(
                        context = context,
                        onReady = { summary -> onSurfaceReady(decision.mode, summary) },
                        onFailure = { code -> onSurfaceFailed(decision.mode, code) },
                    )
                    view.attach3d(surface, surface)
                    true
                }
                Pet3dRenderMode.NATIVE_GL -> {
                    val bytes = (load as? Pet3dAssets.ModelLoad.Verified)?.bytes
                    if (bytes == null) {
                        false
                    } else {
                        val surface = Pet3dGlView(
                            context = context,
                            modelBytes = bytes,
                            onReady = { onSurfaceReady(decision.mode, "native_gl_first_frame") },
                            onFailure = { code -> onSurfaceFailed(decision.mode, code) },
                        )
                        view.attach3d(surface, surface)
                        true
                    }
                }
                Pet3dRenderMode.STATIC_PNG -> false
            }
        } catch (_: Throwable) {
            false
        }
        if (!attached) {
            onSurfaceFailed(decision.mode, if (decision.mode == Pet3dRenderMode.NATIVE_GL && load !is Pet3dAssets.ModelLoad.Verified) {
                Pet3dRenderPolicy.REASON_MODEL_MISSING
            } else {
                "renderer_create_failed"
            })
            return
        }
        pending = decision.mode
        postWatchdog(decision.mode)
    }

    private fun applyStatic(reasonCode: String) {
        mode = Pet3dRenderMode.STATIC_PNG
        reason = reasonCode
        clearWatchdog()
        pending = null
        view.detach3d()
    }

    private fun postWatchdog(surfaceMode: Pet3dRenderMode) {
        clearWatchdog()
        val runnable = Runnable {
            Log.w(Pet3dFrameStats.TAG, "mode=" + surfaceMode + " ready_timeout_ms=" + READY_TIMEOUT_MS)
            onSurfaceFailed(surfaceMode, "renderer_ready_timeout")
        }
        watchdog = runnable
        handler.postDelayed(runnable, READY_TIMEOUT_MS)
    }

    private fun clearWatchdog() {
        watchdog?.let { handler.removeCallbacks(it) }
        watchdog = null
    }

    private fun onSurfaceReady(surfaceMode: Pet3dRenderMode, summary: String) {
        if (destroyed || pending != surfaceMode) return
        pending = null
        clearWatchdog()
        mode = surfaceMode
        view.mark3dReady()
        Log.i(Pet3dFrameStats.TAG, "mode=" + surfaceMode + " first_frame_ready summary=" + summary)
    }

    private fun onSurfaceFailed(surfaceMode: Pet3dRenderMode, code: String) {
        if (destroyed) return
        if (pending != surfaceMode && mode != surfaceMode) return
        pending = null
        clearWatchdog()
        // 升层规则只在 Pet3dRenderPolicy 里：先把失败计入，再算下一步决策。
        val next = environment?.let { Pet3dRenderPolicy.afterFailure(inputFor(it), surfaceMode) }
        failedModes.add(surfaceMode)
        consecutiveFailures++
        Log.w(
            Pet3dFrameStats.TAG,
            "mode=" + surfaceMode + " renderer_failed reason=" + code + " consecutiveFailures=" + consecutiveFailures +
                " next=" + (next?.mode?.toString() ?: "recompute"),
        )
        view.detach3d()
        decideAndAttach(next)
    }

    companion object {
        /** 8 秒内没有首帧就认为该层级不可用；真机测量时据此校准（见文档）。 */
        const val READY_TIMEOUT_MS = 8000L
    }
}