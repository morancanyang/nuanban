package org.nuanban.assistant.nativehost

import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ContextThemeWrapper
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream

/**
 * Spike (b)：浮层里的受控 WebView + three.js（与桌面端同版本 three/GLTFLoader、同一份 GLB 与 digest）。
 *
 * 约束做法：
 *  - 页面与模型全部来自本 APK 的 assets/pet3d 目录，通过应用内拦截的合成 https 源提供，允许 WebView 正常使用
 *    fetch / crypto.subtle（同源 https 才是安全上下文），同时**不存在任何真实网络访问**：
 *    非该源的请求一律 403 空响应、导航一律拒绝，页面内也不允许出现外部 URL（由测试守护）；
 *  - 不启用文件访问、内容访问、DOM Storage、地理位置、多窗口；不允许缩放；WebView 自身不可聚焦/不可点击，
 *    拖动与单击始终由浮层宿主处理（原生行为与静态图完全一致）；
 *  - 页面日志不回显到 logcat；页面回报的失败原因会被收敛成短代码后使用。
 */
class Pet3dWebView(
    context: Context,
    private val onReady: (String) -> Unit,
    private val onFailure: (String) -> Unit,
) : WebView(ContextThemeWrapper(context, android.R.style.Theme_DeviceDefault_NoActionBar)), Pet3dRenderSurface {

    private val handler = Handler(Looper.getMainLooper())
    private var released = false

    init {
        setBackgroundColor(Color.TRANSPARENT)
        setLayerType(View.LAYER_TYPE_HARDWARE, null)
        isFocusable = false
        isFocusableInTouchMode = false
        isClickable = false
        isLongClickable = false
        isHapticFeedbackEnabled = false
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            cacheMode = WebSettings.LOAD_NO_CACHE
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            loadsImagesAutomatically = true
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        addJavascriptInterface(Bridge(), BRIDGE_NAME)
        webViewClient = Pet3dAssetClient()
        webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean = true
        }
        loadUrl(INDEX_URL)
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
        runCatching { stopLoading() }
        runCatching { removeJavascriptInterface(BRIDGE_NAME) }
        runCatching { destroy() }
    }

    private fun report(block: () -> Unit) {
        handler.post { if (!released) runCatching { block() } }
    }

    /** 只接受短代码，避免页面文本进入状态栏/日志。 */
    private fun sanitizeCode(value: String?): String =
        (value ?: "page_error").replace(Regex("[^A-Za-z0-9_.:-]"), "").take(64).ifEmpty { "page_error" }

    inner class Bridge {
        @JavascriptInterface
        fun ready(facts: String) {
            val summary = sanitizeCode(facts)
            Log.i(Pet3dFrameStats.TAG, "mode=webview_three_js ready facts=$summary deviceVerified=false")
            report { onReady(summary) }
        }

        @JavascriptInterface
        fun failed(reason: String) {
            val code = sanitizeCode(reason)
            Log.w(Pet3dFrameStats.TAG, "mode=webview_three_js failed reason=$code")
            report { onFailure(code) }
        }

        @JavascriptInterface
        fun stats(frames: Int, averageFps: Double, p95FrameMs: Double, worstFrameMs: Double) {
            Log.i(
                Pet3dFrameStats.TAG,
                "mode=webview_three_js frames=$frames avgFps=${"%.1f".format(averageFps)} " +
                    "p95FrameMs=${"%.1f".format(p95FrameMs)} worstFrameMs=${"%.1f".format(worstFrameMs)} deviceVerified=false",
            )
        }
    }

    inner class Pet3dAssetClient : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
            respond(request.url)

        @Deprecated("仍被旧 WebView 调用，行为与新签名一致")
        override fun shouldInterceptRequest(view: WebView, url: String): WebResourceResponse = respond(Uri.parse(url))

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

        @Deprecated("仍被旧 WebView 调用，行为与新签名一致")
        override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean = true

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            report { onFailure("asset_main_frame_error_" + error.errorCode) }
        }
    }

    private fun respond(uri: Uri): WebResourceResponse {
        val assetPath = assetPathFor(uri) ?: return simpleResponse(403, "Forbidden")
        return try {
            val stream = context.assets.open(assetPath)
            WebResourceResponse(
                mimeTypeOf(assetPath),
                null,
                200,
                "OK",
                mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"),
                stream,
            )
        } catch (_: Exception) {
            simpleResponse(404, "Not Found")
        }
    }

    private fun simpleResponse(status: Int, reason: String): WebResourceResponse =
        WebResourceResponse("text/plain", "UTF-8", status, reason, mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))

    private fun assetPathFor(uri: Uri): String? {
        if (uri.scheme != "https" || uri.host != HOST) return null
        val path = uri.path ?: return null
        val relative = path.removePrefix("/")
        if (!relative.startsWith(ASSET_PREFIX)) return null
        if (relative.contains("..") || relative.contains("//")) return null
        if (!relative.matches(ASSET_PATH_PATTERN)) return null
        return relative
    }

    private fun mimeTypeOf(path: String): String = when (path.substringAfterLast('.', "")) {
        "html" -> "text/html"
        "js", "mjs" -> "text/javascript"
        "css" -> "text/css"
        "json" -> "application/json"
        "glb" -> "model/gltf-binary"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "svg" -> "image/svg+xml"
        else -> "application/octet-stream"
    }

    companion object {
        const val HOST = "pet3d.nuanban.invalid"
        const val ORIGIN = "https://$HOST"
        const val INDEX_URL = "$ORIGIN/pet3d/index.html"
        const val BRIDGE_NAME = "nuanbanPet3d"
        private const val ASSET_PREFIX = "pet3d/"
        private val ASSET_PATH_PATTERN = Regex("[A-Za-z0-9._/-]+")
    }
}