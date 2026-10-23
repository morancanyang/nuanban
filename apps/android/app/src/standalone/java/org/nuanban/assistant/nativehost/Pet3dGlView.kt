package org.nuanban.assistant.nativehost

import android.content.Context
import android.graphics.PixelFormat
import android.opengl.GLSurfaceView
import android.os.Handler
import android.os.Looper

/**
 * Spike (a) 的宿主视图：浮层里的原生 GLES 表面。
 *
 * 两个只有在真机上才能确认的点（本仓库无设备，均未验证）：
 *  1) SurfaceView 在 TYPE_APPLICATION_OVERLAY 浮层窗口中的合成：这里用 setZOrderOnTop + TRANSLUCENT，
 *     若某些机型仍出现黑底/不透明，会由上层 watchdog 回退到静态 PNG；
 *  2) 首帧到达时间与持续帧率。帧统计经 logcat tag NuanbanPet3d 输出，测量步骤见文档。
 */
class Pet3dGlView(
    context: Context,
    modelBytes: ByteArray,
    onReady: () -> Unit,
    onFailure: (String) -> Unit,
) : GLSurfaceView(context), Pet3dRenderSurface {
    private val handler = Handler(Looper.getMainLooper())
    private var released = false

    init {
        setEGLContextClientVersion(2)
        setEGLConfigChooser(8, 8, 8, 8, 16, 0)
        holder.setFormat(PixelFormat.TRANSLUCENT)
        setZOrderOnTop(true)
        preserveEGLContextOnPause = true
        setRenderer(
            Pet3dGlRenderer(
                modelBytes = modelBytes,
                onReady = { handler.post { if (!released) onReady() } },
                onFailure = { reason -> handler.post { if (!released) onFailure(reason) } },
            ),
        )
        renderMode = RENDERMODE_CONTINUOUSLY
    }

    override fun pauseRendering() {
        runCatching { onPause() }
    }

    override fun resumeRendering() {
        runCatching { onResume() }
    }

    override fun shutdown() {
        released = true
        handler.removeCallbacksAndMessages(null)
        runCatching { onPause() }
    }
}