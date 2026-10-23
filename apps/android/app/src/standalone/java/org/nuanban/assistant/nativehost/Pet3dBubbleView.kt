package org.nuanban.assistant.nativehost

import android.content.Context
import android.graphics.Color
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout

/** 3D 渲染视图的统一生命周期接口（原生 GL 与受控 WebView 都实现它）。 */
interface Pet3dRenderSurface {
    fun pauseRendering()
    fun resumeRendering()
    fun shutdown()
}

/**
 * 悬浮形象的宿主视图。
 *
 * - 随包静态 PNG 是**常驻子视图**：3D 就绪之前显示它（不出现空窗），3D 失败时移除 3D 视图即回到它；
 * - 触摸全部由本视图处理（onInterceptTouchEvent 恒为 true）：拖动、单击打开原生面板、遮挡拒收
 *   （filterTouchesWhenObscured）与升级前的 ImageView 行为一致，3D 内容本身不可交互、不可聚焦；
 * - 本类不做任何渲染决策，只负责视图层级的挂载/摘除，决策在 [Pet3dOverlay] 与 [Pet3dRenderPolicy]。
 */
class Pet3dBubbleView(context: Context, private val fallback: View) : FrameLayout(context) {
    private var surfaceView: View? = null
    private var surfaceLifecycle: Pet3dRenderSurface? = null

    init {
        setBackgroundColor(Color.TRANSPARENT)
        filterTouchesWhenObscured = true
        isClickable = true
        addView(fallback, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    /** 3D 子视图永远不接收触摸：拖动/单击语义只属于浮层宿主。 */
    override fun onInterceptTouchEvent(event: MotionEvent): Boolean = true

    fun attach3d(view: View, lifecycle: Pet3dRenderSurface) {
        detach3d()
        view.isClickable = false
        view.isFocusable = false
        view.isFocusableInTouchMode = false
        view.filterTouchesWhenObscured = true
        surfaceView = view
        surfaceLifecycle = lifecycle
        addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    fun detach3d() {
        val view = surfaceView
        val lifecycle = surfaceLifecycle
        surfaceView = null
        surfaceLifecycle = null
        fallback.visibility = View.VISIBLE
        if (view != null) runCatching { removeView(view) }
        runCatching { lifecycle?.shutdown() }
    }

    fun mark3dReady() {
        fallback.visibility = View.INVISIBLE
    }

    fun pause3d() {
        runCatching { surfaceLifecycle?.pauseRendering() }
    }

    fun resume3d() {
        runCatching { surfaceLifecycle?.resumeRendering() }
    }

    fun has3dSurface(): Boolean = surfaceView != null
}