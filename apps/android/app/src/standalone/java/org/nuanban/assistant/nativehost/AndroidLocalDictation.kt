package org.nuanban.assistant.nativehost

import android.Manifest
import android.app.Activity
import android.app.Application
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * C：独立桌宠包的本地语音听写桥（仅 `:standalone` 源集编译；普通包不含此文件、不声明麦克风权限）。
 *
 * 边界：
 * - 只用系统**离线**语音识别（`createOnDeviceSpeechRecognizer`，API 31+；API 33+ 先询问
 *   `isOnDeviceRecognitionAvailable`）。不可用时不回退云端识别，明确显示不可用；不假装成功。
 * - 低置信度策略复用 Windows 端：置信度缺失或低于阈值 → `uncertain`，只提示重说，不写入草稿、
 *   不进入模型、不执行动作。
 * - 麦克风只在用户点击“开始语音输入”后开启，一次一句话，结束立即关闭；不使用常驻唤醒监听。
 * - 音频只在本机处理，不上传、不保存；桥接返回 `localOnly: true` 且结束后 `microphoneActive: false`。
 */
class AndroidLocalDictation private constructor(
    private val activity: Activity,
    private val webView: WebView,
) {
    companion object {
        const val LISTENER_NAME = "nuanbanVoiceHost"
        const val BRIDGE_NAME = "nuanbanVoice"
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val REQUEST_RECORD_AUDIO = 4311
        const val CONFIDENCE_THRESHOLD = 0.6f
        const val DICTATION_TIMEOUT_MS = 20_000L
        const val TEXT_MAX_CHARS = 500
        private val REQUEST_ID = Regex("[A-Za-z0-9-]{1,80}")
        private val METHODS = setOf("status", "dictate", "cancelDictation", "enable", "disable", "openSettings")

        /** 在共享管理页 WebView 创建后、loadUrl 前调用；只有独立包源集能编译到这里。 */
        fun attach(activity: Activity, content: android.view.View?): AndroidLocalDictation? {
            val webView = content as? WebView ?: return null
            return AndroidLocalDictation(activity, webView).also { it.register() }
        }

        private fun defaultMessage(): String =
            "点击“开始语音输入”后一次性开启系统离线识别，识别结束立即关闭麦克风；音频仅本机处理，不上传、不保存。"
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val lock = Any()
    @Volatile private var destroyed = false
    @Volatile private var active = false
    private var recognizer: SpeechRecognizer? = null
    private var timeout: Runnable? = null
    private var pendingReply: JavaScriptReplyProxy? = null
    private var pendingRequestId: String? = null
    @Volatile private var lastMessage: String = defaultMessage()

    private val lifecycleCallbacks = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
        override fun onActivityStarted(activity: Activity) = Unit
        override fun onActivityResumed(activity: Activity) {
            if (activity === this@AndroidLocalDictation.activity) onActivityResumed()
        }
        override fun onActivityPaused(activity: Activity) = Unit
        override fun onActivityStopped(activity: Activity) = Unit
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
        override fun onActivityDestroyed(activity: Activity) {
            if (activity === this@AndroidLocalDictation.activity) destroy()
        }
    }

    private fun register() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        activity.application.registerActivityLifecycleCallbacks(lifecycleCallbacks)
        webView.addJavascriptInterface(CapabilityBridge(), "nuanbanVoiceCapability")
        WebViewCompat.addWebMessageListener(webView, LISTENER_NAME, setOf(ORIGIN)) { _, message, origin, isMainFrame, reply ->
            if (destroyed || !isMainFrame || origin.toString() != ORIGIN) return@addWebMessageListener
            val payload = message.data ?: return@addWebMessageListener
            if (payload.length > 4096) return@addWebMessageListener
            val request = runCatching { JSONObject(payload) }.getOrNull() ?: return@addWebMessageListener
            handle(reply, request)
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, VOICE_WRAPPER_SCRIPT, setOf(ORIGIN))
        }
    }

    private fun handle(reply: JavaScriptReplyProxy, request: JSONObject) {
        val keys = request.keys().asSequence().toSet()
        if (keys != setOf("id", "method", "args")) return replyError(reply, "", "INVALID_REQUEST")
        val id = request.opt("id") as? String
        val method = request.opt("method") as? String
        val args = request.opt("args") as? JSONObject
        if (id == null || !REQUEST_ID.matches(id) || method !in METHODS || args == null || args.length() != 0) {
            return replyError(reply, id ?: "", "INVALID_REQUEST")
        }
        when (method) {
            "status" -> replyResult(reply, id, statusJson())
            "enable", "disable" -> {
                lastMessage = if (method == "enable") {
                    "独立桌宠包不提供常驻唤醒监听；听写为单次按钮触发，不需要开启唤醒。"
                } else {
                    "本地听写未开启；每次点击“开始语音输入”只会开启一次麦克风。"
                }
                replyResult(reply, id, statusJson())
            }
            "openSettings" -> replyBoolean(reply, id, openAppSettings())
            "cancelDictation" -> replyBoolean(reply, id, cancelDictation())
            "dictate" -> dictate(reply, id)
            else -> replyError(reply, id, "INVALID_REQUEST")
        }
    }

    // ---- 听写状态机 ----

    private fun dictate(reply: JavaScriptReplyProxy, id: String) {
        if (active || pendingReply != null) {
            lastMessage = "上一次听写尚未结束，请稍候或先取消。"
            return replyResult(reply, id, uncertainJson())
        }
        if (!offlineRecognitionAvailable()) {
            lastMessage = "本机没有可用的离线中文语音识别，未开启麦克风；不会改用云端识别。文字输入仍可用。"
            return replyResult(reply, id, cancelledJson())
        }
        if (!hasMicrophonePermission()) {
            pendingReply = reply
            pendingRequestId = id
            lastMessage = "等待系统麦克风授权；拒绝后不会录音。"
            activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_RECORD_AUDIO)
            return
        }
        startRecognition()
    }

    private fun startRecognition() {
        if (destroyed) return
        if (!offlineRecognitionAvailable()) {
            finishPending(uncertainJson())
            return
        }
        val recognizer = runCatching { SpeechRecognizer.createOnDeviceSpeechRecognizer(activity) }.getOrNull()
        if (recognizer == null) {
            lastMessage = "系统离线语音识别未能初始化，未开启麦克风；不会改用云端识别。"
            finishPending(cancelledJson())
            return
        }
        synchronized(lock) { this.recognizer = recognizer; active = true }
        lastMessage = "正在本机听写，请直接说一句话；识别结束立即关闭麦克风。"
        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = Unit
            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) = Unit
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() = Unit
            override fun onPartialResults(partialResults: Bundle?) = Unit
            override fun onEvent(eventType: Int, params: Bundle?) = Unit
            override fun onError(error: Int) {
                when (error) {
                    SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> {
                        lastMessage = "这次没有听清，未写入聊天草稿，请靠近麦克风、说慢一点后重试。"
                        finishPending(uncertainJson())
                    }
                    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> {
                        lastMessage = "麦克风权限未授权，本次没有录音。文字输入仍可用。"
                        finishPending(cancelledJson())
                    }
                    else -> {
                        lastMessage = "本机离线识别未完成，未改用云端识别；请稍后重试或改用文字输入。"
                        finishPending(uncertainJson())
                    }
                }
            }

            override fun onResults(results: Bundle?) {
                val candidates = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
                val scores = results?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)
                val text = candidates.firstOrNull()?.trim().orEmpty()
                val confidence = scores?.firstOrNull()
                val accepted = text.isNotEmpty() && confidence != null && confidence >= CONFIDENCE_THRESHOLD
                if (!accepted) {
                    lastMessage = "这次没有听清，未写入聊天草稿，请靠近麦克风、说慢一点后重试。"
                    finishPending(uncertainJson())
                    return
                }
                lastMessage = "本次听写完成，麦克风已关闭；识别文字只填入聊天草稿，由你检查后亲手发送。"
                finishPending(completeJson(text.take(TEXT_MAX_CHARS)))
            }
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
        }
        val timeout = Runnable {
            lastMessage = "本次听写超时，已关闭麦克风；未写入聊天草稿，请重试。"
            finishPending(uncertainJson())
        }
        this.timeout = timeout
        mainHandler.postDelayed(timeout, DICTATION_TIMEOUT_MS)
        runCatching { recognizer.startListening(intent) }.onFailure {
            lastMessage = "系统离线语音识别未能启动，未开启麦克风；不会改用云端识别。"
            finishPending(cancelledJson())
        }
    }

    private fun cancelDictation(): Boolean {
        val hadPending = pendingReply != null || active
        if (hadPending) {
            lastMessage = "本次语音输入已取消，没有填入或发送文字。"
            finishPending(cancelledJson())
        }
        return hadPending
    }

    private fun finishPending(resultJson: String) {
        timeout?.let { mainHandler.removeCallbacks(it) }
        timeout = null
        val recognizer: SpeechRecognizer?
        synchronized(lock) {
            recognizer = this.recognizer
            this.recognizer = null
            active = false
        }
        if (recognizer != null) {
            runCatching { recognizer.stopListening() }
            runCatching { recognizer.cancel() }
            runCatching { recognizer.destroy() }
        }
        val reply = pendingReply
        val id = pendingRequestId
        pendingReply = null
        pendingRequestId = null
        if (reply != null && id != null) replyResult(reply, id, resultJson)
    }

    private fun onActivityResumed() {
        if (pendingReply == null) return
        if (hasMicrophonePermission()) {
            val reply = pendingReply
            val id = pendingRequestId
            pendingReply = null
            pendingRequestId = null
            if (reply != null && id != null) {
                // 权限已授予：沿用同一个待回复请求，开始本次单句听写。
                pendingReply = reply
                pendingRequestId = id
                startRecognition()
            }
        } else {
            lastMessage = "麦克风权限未授权，本次没有录音，也不会改用云端识别。文字输入仍可用。"
            finishPending(cancelledJson())
        }
    }

    private fun destroy() {
        destroyed = true
        runCatching { activity.application.unregisterActivityLifecycleCallbacks(lifecycleCallbacks) }
        runCatching { webView.removeJavascriptInterface("nuanbanVoiceCapability") }
        finishPending(cancelledJson())
    }

    private fun hasMicrophonePermission(): Boolean =
        activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun offlineRecognitionAvailable(): Boolean {
        if (Build.VERSION.SDK_INT < 31) return false
        return if (Build.VERSION.SDK_INT >= 33) {
            runCatching { SpeechRecognizer.isOnDeviceRecognitionAvailable(activity) }.getOrDefault(false)
        } else {
            true
        }
    }

    private fun openAppSettings(): Boolean = runCatching {
        activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + activity.packageName)))
        true
    }.getOrDefault(false)

    // ---- 状态 JSON（localOnly=true，结束后 microphoneActive=false） ----

    private fun statusJson(): String {
        val available = offlineRecognitionAvailable()
        val microphoneActive = active
        val phase = when {
            !available -> "unavailable"
            microphoneActive -> "question"
            else -> "disabled"
        }
        val message = when {
            !available -> "本机没有可用的离线中文语音识别，未开启麦克风；不会改用云端识别。文字输入仍可用。"
            microphoneActive -> lastMessage
            !hasMicrophonePermission() -> "麦克风权限尚未授权；点击“开始语音输入”时请求系统权限，拒绝后不会录音。"
            else -> lastMessage
        }
        return JSONObject()
            .put("phase", phase)
            .put("enabled", false)
            .put("microphoneActive", microphoneActive)
            .put("dictationAvailable", available)
            .put("localOnly", true)
            .put("message", message.take(500))
            .toString()
    }

    private fun completeJson(text: String): String = JSONObject()
        .put("status", "complete")
        .put("text", text)
        .put("localOnly", true)
        .put("microphoneActive", false)
        .toString()

    private fun uncertainJson(): String = JSONObject()
        .put("status", "uncertain")
        .put("localOnly", true)
        .put("microphoneActive", false)
        .toString()

    private fun cancelledJson(): String = JSONObject()
        .put("status", "cancelled")
        .put("localOnly", true)
        .toString()

    private fun replyResult(reply: JavaScriptReplyProxy, id: String, resultJson: String) {
        if (destroyed) return
        webView.post {
            if (!destroyed) runCatching { reply.postMessage(JSONObject().put("id", id).put("ok", true).put("result", JSONObject(resultJson)).toString()) }
        }
    }

    private fun replyBoolean(reply: JavaScriptReplyProxy, id: String, value: Boolean) {
        if (destroyed) return
        webView.post {
            if (!destroyed) runCatching { reply.postMessage(JSONObject().put("id", id).put("ok", true).put("result", value).toString()) }
        }
    }

    private fun replyError(reply: JavaScriptReplyProxy, id: String, code: String) {
        if (destroyed) return
        webView.post {
            if (!destroyed) runCatching { reply.postMessage(JSONObject().put("id", id).put("ok", false).put("error", code).toString()) }
        }
    }

    /** JS 侧能力查询：仅离线识别可用时才暴露 dictate/cancelDictation，避免“可点但必失败”。 */
    private inner class CapabilityBridge {
        @JavascriptInterface
        fun available(): Boolean = !destroyed && offlineRecognitionAvailable()

        @JavascriptInterface
        fun confidenceThreshold(): Float = CONFIDENCE_THRESHOLD
    }

    private val VOICE_WRAPPER_SCRIPT = """
        (function () {
          if (window.__nuanbanVoiceShim) return;
          var host = window.nuanbanVoiceHost;
          if (!host || typeof host.postMessage !== 'function' || typeof host.addEventListener !== 'function') return;
          var sequence = 0;
          var pending = {};
          host.addEventListener('message', function (event) {
            var data;
            try { data = JSON.parse(String(event.data)); } catch (error) { return; }
            if (!data || typeof data.id !== 'string' || !pending[data.id]) return;
            var resolve = pending[data.id];
            delete pending[data.id];
            resolve(data);
          });
          function call(method, timeoutMs) {
            return new Promise(function (resolve) {
              var id = 'v-' + (++sequence) + '-' + Math.random().toString(36).slice(2, 10);
              pending[id] = resolve;
              window.setTimeout(function () {
                if (!pending[id]) return;
                delete pending[id];
                resolve(null);
              }, timeoutMs);
              try { host.postMessage(JSON.stringify({ id: id, method: method, args: {} })); }
              catch (error) { delete pending[id]; resolve(null); }
            });
          }
          function statusFallback() {
            return { phase: 'unavailable', enabled: false, microphoneActive: false, dictationAvailable: false, localOnly: true, message: 'Android 本地听写状态未确认，未开启麦克风。' };
          }
          function unpack(data, fallback) {
            return data && data.ok === true && data.result ? data.result : fallback;
          }
          var bridge = {
            status: function () { return call('status', 3000).then(function (data) { return unpack(data, statusFallback()); }); },
            enable: function () { return call('enable', 3000).then(function (data) { return unpack(data, statusFallback()); }); },
            disable: function () { return call('disable', 3000).then(function (data) { return unpack(data, statusFallback()); }); },
            openSettings: function () { return call('openSettings', 4000).then(function (data) { return !!(data && data.ok === true && data.result === true); }).catch(function () { return false; }); }
          };
          var available = false;
          try { available = !!(window.nuanbanVoiceCapability && window.nuanbanVoiceCapability.available() === true); } catch (error) {}
          if (available) {
            bridge.dictate = function () {
              return call('dictate', 30000).then(function (data) {
                return unpack(data, { status: 'uncertain', localOnly: true, microphoneActive: false });
              });
            };
            bridge.cancelDictation = function () {
              return call('cancelDictation', 4000).then(function (data) { return !!(data && data.ok === true && data.result === true); }).catch(function () { return false; });
            };
          }
          window.nuanbanVoice = bridge;
          window.__nuanbanVoiceShim = true;
        })();
    """.trimIndent()
}
