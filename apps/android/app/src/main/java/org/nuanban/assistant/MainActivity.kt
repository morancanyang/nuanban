package org.nuanban.assistant

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.JavaScriptReplyProxy
import org.json.JSONArray
import org.json.JSONObject
import org.nuanban.contracts.ActiveBridgeRequest
import org.nuanban.contracts.ActiveBridgeMethod
import org.nuanban.assistant.data.ReminderCancelInput
import org.nuanban.assistant.data.ReminderDatabase
import org.nuanban.assistant.data.ReminderReceiptInput
import org.nuanban.assistant.data.ReminderReceipts
import org.nuanban.assistant.data.ReminderStatuses
import org.nuanban.assistant.data.ReminderScheduleInput
import org.nuanban.assistant.data.RoomReminderStore
import org.nuanban.assistant.nativehost.AndroidSecretStore
import org.nuanban.assistant.nativehost.AndroidHostRuntime
import org.nuanban.assistant.nativehost.NativeDeviceAuth
import org.nuanban.assistant.nativehost.Top20FlowRegistry
import java.io.ByteArrayInputStream
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var reminderDatabase: ReminderDatabase
    private lateinit var reminderStore: RoomReminderStore
    private lateinit var reminderScheduler: ReminderNotificationScheduler
    private lateinit var nativeAuth: NativeDeviceAuth
    private val bridgeExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val bridgeLifecycleLock = Any()
    @Volatile private var destroyed = false
    @Volatile private var webViewReady = false
    private var pendingReminderDeepLink: String? = null
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    @Volatile private var textToSpeech: TextToSpeech? = null
    @Volatile private var ttsReady = false
    private var ttsBridgeFallbackScript: String? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        setContentView(AndroidHostRuntime.managementView(this, webView))
        reminderDatabase = ReminderDatabase.create(this)
        reminderStore = RoomReminderStore(reminderDatabase)
        reminderScheduler = ReminderNotificationScheduler(this)
        nativeAuth = NativeDeviceAuth(AndroidSecretStore.create(this))
        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = false
        webView.settings.allowContentAccess = false
        webView.settings.setSupportMultipleWindows(false)
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: WebChromeClient.FileChooserParams?,
            ): Boolean {
                val callback = filePathCallback ?: return false
                val params = fileChooserParams ?: return false
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = callback
                return try {
                    @Suppress("DEPRECATION")
                    startActivityForResult(Intent.createChooser(fileChooserIntent(params), "选择图片"), FILE_CHOOSER_REQUEST)
                    true
                } catch (_: ActivityNotFoundException) {
                    fileChooserCallback = null
                    callback.onReceiveValue(null)
                    false
                }
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                request.deny()
            }
        }
        installSpeechBridge()
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                ttsBridgeFallbackScript?.let { script -> view.evaluateJavascript(script, null) }
            }
            override fun onPageFinished(view: WebView, url: String) {
                webViewReady = true
                dispatchPendingReminder()
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = request.url.host != "appassets.androidplatform.net" || request.url.scheme != "https"
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (request.url.host == "appassets.androidplatform.net" && request.url.scheme == "https") loader.shouldInterceptRequest(request.url)?.let { return it }
                return WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "nuanbanBridge", setOf("https://appassets.androidplatform.net")) { _, message, origin, isMainFrame, reply ->
                if (!isMainFrame || origin.toString() != "https://appassets.androidplatform.net") return@addWebMessageListener
                val payload = message.data ?: return@addWebMessageListener
                if (payload.length > 4096) return@addWebMessageListener
                val request = runCatching { JSONObject(payload) }.getOrNull() ?: return@addWebMessageListener
                val fields = request.toWireMap()
                val decoded = runCatching { ActiveBridgeRequest.fromWire(fields) }.getOrNull() ?: return@addWebMessageListener
                when (decoded.method) {
                    ActiveBridgeMethod.CAPABILITIES -> postBridgeReply(reply, nativeCapabilities(decoded))
                    ActiveBridgeMethod.STOP_ALL -> {
                        nativeAuth.cancel()
                        postBridgeReply(reply, decoded.correlation() + AndroidHostRuntime.stopManagement(this))
                    }
                    ActiveBridgeMethod.REMINDER_SCHEDULE,
                    ActiveBridgeMethod.REMINDER_CANCEL,
                     ActiveBridgeMethod.REMINDER_NOTIFY_DUE -> try {
                         bridgeExecutor.execute {
                             val result = synchronized(bridgeLifecycleLock) {
                                 if (destroyed) {
                                     null
                                 } else {
                                     runCatching { handleReminderBridge(decoded) }
                                         .getOrElse { errorReply(decoded, if (it is org.nuanban.assistant.data.ReminderStoreException) "storage_error" else "scheduler_error", it.message ?: "原生提醒操作失败。") }
                                 }
                            }
                             if (result != null) postBridgeReply(reply, result)
                        }
                     } catch (_: RejectedExecutionException) {
                         Unit
                    }
                }
            }
        }
        webView.loadUrl("https://appassets.androidplatform.net/assets/ui/index.html")
        dispatchReminderIntent(intent)
    }

    private fun nativeCapabilities(request: ActiveBridgeRequest): Map<String, Any?> {
        return request.correlation() + AndroidHostRuntime.capabilities(this) + mapOf(
            "platform" to "android",
            "status" to "native-capability-gated",
            "auth" to nativeAuth.status(),
            "flowTop20" to Top20FlowRegistry.slots.map { mapOf("slot" to it.slot, "key" to it.key, "status" to it.status, "reason" to it.blockingReason) },
            "asset2d" to "requires_verified_generated_manifest",
        )
    }

    private fun handleReminderBridge(request: ActiveBridgeRequest): Map<String, Any?> {
        return when (request.method) {
            ActiveBridgeMethod.REMINDER_SCHEDULE -> handleSchedule(request)
            ActiveBridgeMethod.REMINDER_CANCEL -> handleCancel(request)
            ActiveBridgeMethod.REMINDER_NOTIFY_DUE -> handleNotifyDue(request)
            else -> errorReply(request, "bridge_error", "该桥方法不属于提醒操作。")
        }
    }

    private fun handleSchedule(request: ActiveBridgeRequest): Map<String, Any?> {
        val input = request.schedule ?: return errorReply(request, "bridge_error", "排程载荷缺失。")
        val stored = reminderStore.schedule(
            ReminderScheduleInput(
                accountId = input.accountId,
                reminderId = input.reminderId,
                todoId = input.todoId,
                instanceId = input.instanceId,
                scheduleVersion = input.scheduleVersion,
                dueAt = input.dueAt,
                timezone = input.timezone,
                deepLink = input.deepLink,
                repeatRule = input.repeatRule,
                channel = input.channel,
                payloadJson = JSONObject().put("kind", "review-reminder").toString(),
                updatedAt = input.updatedAt,
            ),
        )
        stored.replacedEntity?.let { previous ->
            reminderScheduler.cancel(AndroidReminderScheduleRequest(previous.instanceId, previous.dueAtEpochMs, previous.deepLink, previous.accountId, previous.reminderId, previous.clickToken))
        }
        val system = if (input.channel == "local") {
            reminderScheduler.schedule(AndroidReminderScheduleRequest(stored.entity.instanceId, stored.entity.dueAtEpochMs, stored.entity.deepLink, stored.entity.accountId, stored.entity.reminderId, stored.entity.clickToken))
        } else {
            AndroidReminderScheduleResult("unsupported", "push 通道尚未接入 Android 推送供应方，未向系统调度器派发。")
        }
        val outcome = if (stored.idempotent) "idempotent" else if (stored.replacedEntity != null) "replaced" else "created"
        return request.correlation() + mapOf("outcome" to outcome, "status" to system.status, "reason" to system.reason)
    }

    private fun handleCancel(request: ActiveBridgeRequest): Map<String, Any?> {
        val input = request.cancel ?: return errorReply(request, "bridge_error", "取消载荷缺失。")
        val cancelled = reminderStore.cancel(
            ReminderCancelInput(input.accountId, input.todoId, input.instanceId, input.scheduleVersion, input.cancelledAt),
        )
        val system = reminderScheduler.cancel(AndroidReminderScheduleRequest(cancelled.instanceId, cancelled.dueAtEpochMs, cancelled.deepLink, cancelled.accountId, cancelled.reminderId, cancelled.clickToken))
        return request.correlation() + mapOf("status" to system.status, "reason" to system.reason)
    }

    private fun handleNotifyDue(request: ActiveBridgeRequest): Map<String, Any?> {
        val input = request.notifyDue ?: return errorReply(request, "bridge_error", "到期载荷缺失。")
        val capability = reminderScheduler.capability()
        if (!capability.system) return request.correlation() + mapOf("status" to "unsupported", "reason" to capability.reason)
        val nowEpochMs = java.time.Instant.parse(input.now).toEpochMilli()
        val current = findReminder(input.accountId, input.reminderId)
            ?: return request.correlation() + mapOf("status" to "not_found", "reason" to "reminder_not_found")
        if (current.status != "scheduled") return request.correlation() + mapOf("status" to "not_scheduled", "reason" to current.status)
        if (current.dueAtEpochMs > nowEpochMs) return request.correlation() + mapOf("status" to "not_due", "reason" to "planned_at_in_future")
        val submission = reminderStore.claimDue(input.accountId, input.reminderId, input.now, input.now, current.instanceId)
            ?: return request.correlation() + mapOf("status" to "not_due", "reason" to "already_submitted_or_not_due")
        val submitted = submission.entity
        if (submitted.status != ReminderStatuses.SUBMITTED) return request.correlation() + mapOf("status" to submitted.status, "reason" to "already_delivered")
        val scheduleRequest = AndroidReminderScheduleRequest(submitted.instanceId, nowEpochMs, submitted.deepLink, submitted.accountId, submitted.reminderId, submitted.clickToken)
        val system = runCatching { reminderScheduler.schedule(scheduleRequest) }
            .getOrElse {
                if (submission.claimed) reminderStore.rollbackDueSubmission(input.accountId, input.reminderId, submitted.submittedAt ?: input.now, input.now)
                throw it
            }
        if (system.status != "scheduled") {
            if (submission.claimed) reminderStore.rollbackDueSubmission(input.accountId, input.reminderId, submitted.submittedAt ?: input.now, input.now)
            return request.correlation() + mapOf("status" to "unsupported", "reason" to system.reason)
        }
        return request.correlation() + mapOf("status" to "submitted", "reason" to "已提交到 Android 本地提醒调度器。")
    }

    private fun findReminder(accountId: String, reminderId: String) = reminderStore.list(accountId).firstOrNull { it.reminderId == reminderId }

    private fun errorReply(request: ActiveBridgeRequest, code: String, message: String): Map<String, Any?> = request.correlation() + mapOf("error_code" to code, "message" to message.take(256))

    private fun postBridgeReply(reply: JavaScriptReplyProxy, value: Map<String, Any?>) {
        if (destroyed) return
        runOnUiThread {
            if (!destroyed) runCatching { reply.postMessage(JSONObject(value).toString()) }
        }
    }

    private fun fileChooserIntent(params: WebChromeClient.FileChooserParams): Intent {
        val accepts = params.acceptTypes
            .map { it.trim().lowercase(Locale.ROOT) }
            .filter { it.isNotEmpty() }
            .distinct()
        val imageOnly = accepts.isNotEmpty() && accepts.all { it.startsWith("image/") }
        return Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = if (imageOnly) "image/*" else "*/*"
            if (accepts.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, accepts.toTypedArray())
            if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
    }

    private fun installSpeechBridge() {
        webView.addJavascriptInterface(SpeechJavascriptBridge(), "nuanbanTts")
        textToSpeech = TextToSpeech(this) { status ->
            var ready = status == TextToSpeech.SUCCESS
            val engine = textToSpeech
            if (ready && engine != null) {
                val language = engine.setLanguage(Locale.SIMPLIFIED_CHINESE)
                ready = language != TextToSpeech.LANG_MISSING_DATA && language != TextToSpeech.LANG_NOT_SUPPORTED
            }
            if (!ready) {
                runCatching { textToSpeech?.shutdown() }
                textToSpeech = null
            }
            ttsReady = ready
            if (ready) {
                engine?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) = Unit
                    override fun onDone(utteranceId: String?) = emitSpeechEvent(utteranceId, true)
                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) = emitSpeechEvent(utteranceId, false)
                    override fun onError(utteranceId: String?, errorCode: Int) = emitSpeechEvent(utteranceId, false)
                })
            }
        }
        val script = SPEECH_BRIDGE_SCRIPT
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, script, setOf("https://appassets.androidplatform.net"))
        } else {
            ttsBridgeFallbackScript = script
        }
    }

    private fun emitSpeechEvent(utteranceId: String?, ok: Boolean) {
        val safeId = utteranceId ?: return
        if (!::webView.isInitialized || destroyed) return
        webView.post {
            if (!destroyed) {
                runCatching { webView.evaluateJavascript("window.__nuanbanTtsEvent(" + JSONObject.quote(safeId) + "," + ok + ")", null) }
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            val callback = fileChooserCallback
            fileChooserCallback = null
            if (callback != null) {
                callback.onReceiveValue(if (resultCode == RESULT_OK) WebChromeClient.FileChooserParams.parseResult(resultCode, data) else null)
                return
            }
        }
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    inner class SpeechJavascriptBridge {
        @JavascriptInterface
        fun ready(): Boolean = ttsReady

        @JavascriptInterface
        fun speak(utteranceId: String?, text: String?, rate: Float): Boolean {
            if (!ttsReady) return false
            val safeId = utteranceId ?: return false
            val safeText = text ?: return false
            if (!safeId.matches(Regex("[A-Za-z0-9-]{1,64}")) || safeText.isBlank() || safeText.length > 12000) return false
            val engine = textToSpeech ?: return false
            val safeRate = rate.coerceIn(0.1f, 3f)
            webView.post {
                if (!destroyed && ttsReady) {
                    runCatching {
                        engine.setSpeechRate(safeRate)
                        engine.speak(safeText, TextToSpeech.QUEUE_FLUSH, null, safeId)
                    }
                }
            }
            return true
        }

        @JavascriptInterface
        fun cancel() {
            webView.post { if (!destroyed) runCatching { textToSpeech?.stop() } }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        dispatchReminderIntent(intent)
    }

    private fun dispatchReminderIntent(intent: Intent?) {
        val deepLink = intent?.getStringExtra(ReminderNotificationScheduler.EXTRA_DEEP_LINK) ?: return
        val accountId = intent.getStringExtra(ReminderNotificationScheduler.EXTRA_ACCOUNT_ID)
        val reminderId = intent.getStringExtra(ReminderNotificationScheduler.EXTRA_REMINDER_ID)
        val instanceId = intent.getStringExtra(ReminderNotificationScheduler.EXTRA_INSTANCE_ID)
        val clickToken = intent.getStringExtra(ReminderNotificationScheduler.EXTRA_CLICK_TOKEN)
        if (accountId == null || reminderId == null || instanceId == null || !ReminderNotificationScheduler.isSafeReminderOpenInput(accountId, reminderId, instanceId, deepLink, clickToken)) return
        val safeClickToken = clickToken ?: return
        recordReminderOpened(accountId, reminderId, instanceId, deepLink, safeClickToken)
    }

    private fun recordReminderOpened(accountId: String, reminderId: String, instanceId: String, deepLink: String, clickToken: String) {
        try {
            bridgeExecutor.execute {
                val accepted = synchronized(bridgeLifecycleLock) {
                    if (destroyed) {
                        false
                    } else {
                        val current = reminderStore.list(accountId).firstOrNull { it.reminderId == reminderId && it.instanceId == instanceId }
                        if (current == null || current.clickToken != clickToken || current.deepLink != deepLink || current.status != ReminderStatuses.DELIVERED || current.openedAt != null) {
                            false
                        } else {
                            runCatching {
                                reminderStore.recordReceipt(
                                    ReminderReceiptInput(
                                        accountId = current.accountId,
                                        todoId = current.todoId,
                                        instanceId = current.instanceId,
                                        scheduleVersion = current.scheduleVersion,
                                        state = ReminderReceipts.OPENED,
                                        observedAt = java.time.Instant.now().toString(),
                                    ),
                                )
                                true
                            }.getOrDefault(false)
                        }
                    }
                }
                if (accepted) {
                    runOnUiThread {
                        synchronized(bridgeLifecycleLock) {
                            if (!destroyed) {
                                pendingReminderDeepLink = deepLink
                                dispatchPendingReminder()
                            }
                        }
                    }
                }
            }
        } catch (_: RejectedExecutionException) {
            Unit
        }
    }

    private fun dispatchPendingReminder() {
        val deepLink = pendingReminderDeepLink ?: return
        if (!::webView.isInitialized || !webViewReady || webView.url == null) return
        val detail = JSONObject().put("deepLink", deepLink).toString()
        webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('nuanban:reminder-open',{detail:$detail}))", null)
        pendingReminderDeepLink = null
    }
    private fun dispatchLifecycleEvent(name: String) {
        if (::webView.isInitialized) webView.evaluateJavascript("window.dispatchEvent(new Event('$name'))", null)
    }
    override fun onPause() {
        dispatchLifecycleEvent("nuanban:management-pause")
        super.onPause()
    }
    override fun onDestroy() {
        destroyed = true
        webViewReady = false
        runCatching { nativeAuth.cancel() }
        dispatchLifecycleEvent("nuanban:management-destroy")
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        runCatching { textToSpeech?.stop() }
        runCatching { textToSpeech?.shutdown() }
        textToSpeech = null
        ttsReady = false
        webView.stopLoading()
        webView.destroy()
        synchronized(bridgeLifecycleLock) {
            bridgeExecutor.shutdownNow()
            if (::reminderDatabase.isInitialized) reminderDatabase.close()
        }
        super.onDestroy()
    }

    private companion object {
        private const val FILE_CHOOSER_REQUEST = 41234
        private val SPEECH_BRIDGE_SCRIPT = """
            (function () {
              if (window.__nuanbanTtsShim) return;
              var host = window.nuanbanTts;
              if (!host) return;
              if (typeof window.SpeechSynthesisUtterance !== 'function') {
                window.SpeechSynthesisUtterance = function (text) {
                  this.text = String(text === undefined || text === null ? '' : text);
                  this.lang = '';
                  this.rate = 1;
                  this.pitch = 1;
                  this.volume = 1;
                  this.onend = null;
                  this.onerror = null;
                  this.onstart = null;
                };
              }
              var sequence = 0;
              var current = null;
              var api = {
                speaking: false,
                pending: false,
                paused: false,
                speak: function (utterance) {
                  if (!utterance || typeof utterance.text !== 'string' || !utterance.text) return;
                  var id = 'utt-' + (++sequence);
                  current = { id: id, utterance: utterance };
                  var started = false;
                  try {
                    started = host.speak(id, utterance.text.slice(0, 12000), typeof utterance.rate === 'number' ? utterance.rate : 1) === true;
                  } catch (error) {
                    started = false;
                  }
                  if (!started) {
                    current = null;
                    var failed = utterance;
                    window.setTimeout(function () {
                      if (typeof failed.onerror === 'function') failed.onerror({ error: 'synthesis-unavailable' });
                    }, 0);
                  }
                },
                cancel: function () {
                  current = null;
                  try { host.cancel(); } catch (error) {}
                },
                pause: function () {},
                resume: function () {},
                getVoices: function () { return []; },
                addEventListener: function () {},
                removeEventListener: function () {},
                dispatchEvent: function () { return false; }
              };
              Object.defineProperty(window, 'speechSynthesis', {
                configurable: true,
                enumerable: true,
                get: function () {
                  try { return host.ready() === true ? api : undefined; } catch (error) { return undefined; }
                }
              });
              window.__nuanbanTtsEvent = function (id, ok) {
                var active = current;
                if (!active || active.id !== id) return;
                current = null;
                try {
                  if (ok === true) {
                    if (typeof active.utterance.onend === 'function') active.utterance.onend({});
                  } else if (typeof active.utterance.onerror === 'function') {
                    active.utterance.onerror({ error: 'synthesis-failed' });
                  }
                } catch (error) {}
              };
              window.__nuanbanTtsShim = true;
            })();
        """.trimIndent()
    }
}

private fun JSONObject.toWireMap(): Map<String, Any?> {
    val result = linkedMapOf<String, Any?>()
    val iterator = keys()
    while (iterator.hasNext()) {
        val key = iterator.next()
        result[key] = toWireValue(opt(key))
    }
    return result
}

private fun toWireValue(value: Any?): Any? = when (value) {
    JSONObject.NULL -> null
    is JSONObject -> value.toWireMap()
    is JSONArray -> buildList {
        for (index in 0 until value.length()) add(toWireValue(value.opt(index)))
    }
    else -> value
}
