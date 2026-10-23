package org.nuanban.assistant.nativehost

import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.util.concurrent.ExecutorService

/**
 * Android 受限模型桥接：只暴露 status / text / image / cancel 四个方法。
 *
 * - 字段白名单 + 类型 + 大小上限在原生侧强制（见 [ModelAccessLimits]），WebView 不能传入
 *   URL、header、端点或任意 HTTP 目标；
 * - 令牌只保存在原生加密存储，**任何回复都不含 access/refresh token**；
 * - 未配置/失效/拒绝一律结构化 fail-closed，不回退演示数据；
 * - JS 只拿到 Promise 包装，桥接对象由 document-start 脚本注入，仅在 Android 宿主存在。
 */
class AndroidModelAccessBridge(
    private val webView: WebView,
    private val broker: ModelAccessBroker,
    private val executor: ExecutorService,
) {
    companion object {
        const val LISTENER_NAME = "nuanbanAndroidModelHost"
        const val BRIDGE_NAME = "nuanbanAndroidModel"
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val MAX_BRIDGE_CHARS = 14_200_000
        private val REQUEST_ID = Regex("[A-Za-z0-9-]{1,80}")
        private val OUTER_KEYS = setOf("id", "method", "args")
        private val STATUS_KEYS = emptySet<String>()
        private val TEXT_KEYS = setOf("requestId", "question")
        private val IMAGE_KEYS = setOf("requestId", "question", "mime", "base64", "confirmed")
        private val CANCEL_KEYS = setOf("requestId")
    }

    @Volatile private var destroyed = false

    /** 注册 WebMessageListener 与 document-start 包装脚本；返回需要在 onPageStarted 兜底注入的脚本（不支持时）。 */
    fun register(): String? {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return null
        WebViewCompat.addWebMessageListener(webView, LISTENER_NAME, setOf(ORIGIN)) { _, message, origin, isMainFrame, reply ->
            if (destroyed || !isMainFrame || origin.toString() != ORIGIN) return@addWebMessageListener
            val payload = message.data ?: return@addWebMessageListener
            if (payload.length > MAX_BRIDGE_CHARS) {
                postText(reply, errorJson("", "INVALID_REQUEST"))
                return@addWebMessageListener
            }
            val request = runCatching { JSONObject(payload) }.getOrNull() ?: return@addWebMessageListener
            handle(reply, request)
        }
        return if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, MODEL_ACCESS_WRAPPER_SCRIPT, setOf(ORIGIN))
            null
        } else {
            MODEL_ACCESS_WRAPPER_SCRIPT
        }
    }

    fun destroy() {
        destroyed = true
        runCatching { broker.cancelAll() }
        runCatching { executor.shutdownNow() }
    }

    private fun handle(reply: JavaScriptReplyProxy, request: JSONObject) {
        if (keysOf(request) != OUTER_KEYS) {
            postText(reply, errorJson("", "INVALID_REQUEST"))
            return
        }
        val id = request.opt("id") as? String
        val method = request.opt("method") as? String
        val args = request.opt("args") as? JSONObject
        if (id == null || !REQUEST_ID.matches(id) || method == null || args == null) {
            postText(reply, errorJson(id ?: "", "INVALID_REQUEST"))
            return
        }
        when (method) {
            "status" -> {
                if (keysOf(args) != STATUS_KEYS) return postText(reply, errorJson(id, "INVALID_REQUEST"))
                dispatch(reply, id) { statusJson(id) }
            }
            "text" -> {
                if (keysOf(args) != TEXT_KEYS) return postText(reply, errorJson(id, "INVALID_REQUEST"))
                val requestId = args.opt("requestId") as? String
                val question = args.opt("question") as? String
                if (requestId == null || question == null) return postText(reply, errorJson(id, "INVALID_REQUEST"))
                dispatch(reply, id) { replyJson(id, broker.answerText(requestId, question)) }
            }
            "image" -> {
                if (keysOf(args) != IMAGE_KEYS) return postText(reply, errorJson(id, "INVALID_REQUEST"))
                val requestId = args.opt("requestId") as? String
                val question = args.opt("question") as? String
                val mime = args.opt("mime") as? String
                val base64 = args.opt("base64") as? String
                val confirmed = args.opt("confirmed") as? Boolean
                if (requestId == null || question == null || mime == null || base64 == null || confirmed == null) {
                    return postText(reply, errorJson(id, "INVALID_REQUEST"))
                }
                dispatch(reply, id) { replyJson(id, broker.answerImage(requestId, question, mime, base64, confirmed)) }
            }
            "cancel" -> {
                if (keysOf(args) != CANCEL_KEYS) return postText(reply, errorJson(id, "INVALID_REQUEST"))
                val requestId = args.opt("requestId") as? String ?: return postText(reply, errorJson(id, "INVALID_REQUEST"))
                val cancelled = broker.cancel(requestId)
                postText(reply, JSONObject().put("id", id).put("cancelled", cancelled).toString())
            }
            else -> postText(reply, errorJson(id, "INVALID_REQUEST"))
        }
    }

    private fun dispatch(reply: JavaScriptReplyProxy, id: String, block: () -> String) {
        try {
            executor.execute {
                if (destroyed) return@execute
                val text = runCatching(block).getOrElse { errorJson(id, "PROVIDER_UNAVAILABLE") }
                postText(reply, text)
            }
        } catch (_: Exception) {
            postText(reply, errorJson(id, "PROVIDER_UNAVAILABLE"))
        }
    }

    private fun statusJson(id: String): String {
        val status = broker.status()
        return JSONObject()
            .put("id", id)
            .put("ok", true)
            .put(
                "status",
                JSONObject()
                    .put("available", status.available)
                    .put("reason", status.reason)
                    .put("message", status.message.take(ModelAccessLimits.STATUS_MESSAGE_MAX)),
            )
            .toString()
    }

    private fun replyJson(id: String, reply: ModelAccessReply): String =
        JSONObject().put("id", id).put("reply", JSONObject(ModelAccessJson.reply(reply))).toString()

    private fun errorJson(id: String, code: String): String =
        JSONObject().put("id", id).put("ok", false).put("error", if (ModelAccessLimits.validErrorCode(code) || code == "INVALID_REQUEST") code else "INVALID_REQUEST").toString()

    private fun postText(reply: JavaScriptReplyProxy, text: String) {
        if (destroyed) return
        webView.post { if (!destroyed) runCatching { reply.postMessage(text) } }
    }

    private fun keysOf(value: JSONObject): Set<String> = value.keys().asSequence().toSet()
}

/**
 * 注入 window.nuanbanAndroidModel（Promise 包装）。只转发白名单字段；
 * 宿主校验失败时返回 fail-closed 结构，不抛演示数据。
 */
private val MODEL_ACCESS_WRAPPER_SCRIPT = """
    (function () {
      if (window.__nuanbanAndroidModelShim) return;
      var host = window.nuanbanAndroidModelHost;
      if (!host || typeof host.postMessage !== 'function' || typeof host.addEventListener !== 'function') return;
      var sequence = 0;
      var pending = {};
      host.addEventListener('message', function (event) {
        var data;
        try { data = JSON.parse(String(event.data)); } catch (error) { return; }
        if (!data || typeof data.id !== 'string' || !pending[data.id]) return;
        var resolve = pending[data.id].resolve;
        delete pending[data.id];
        resolve(data);
      });
      function call(method, args, timeoutMs) {
        return new Promise(function (resolve, reject) {
          var id = 'm-' + (++sequence) + '-' + Math.random().toString(36).slice(2, 10);
          pending[id] = { resolve: resolve, reject: reject };
          window.setTimeout(function () {
            if (!pending[id]) return;
            delete pending[id];
            reject(new Error('model-bridge-timeout'));
          }, timeoutMs);
          try { host.postMessage(JSON.stringify({ id: id, method: method, args: args })); }
          catch (error) { delete pending[id]; reject(new Error('model-bridge-unavailable')); }
        });
      }
      window.nuanbanAndroidModel = {
        protocolVersion: 1,
        status: function () {
          return call('status', {}, 3000).then(function (data) {
            if (data && data.ok === true && data.status && typeof data.status.available === 'boolean') return data.status;
            return { available: false, reason: 'host_unavailable', message: '模型通道状态未确认。' };
          });
        },
        answerText: function (input) {
          var requestId = String(input && input.requestId || '');
          var question = String(input && input.question || '');
          return call('text', { requestId: requestId, question: question }, 55000).then(function (data) {
            if (data && data.reply) return data.reply;
            return { ok: false, requestId: requestId, code: 'PROVIDER_UNAVAILABLE', retryable: true };
          });
        },
        answerImage: function (input) {
          var requestId = String(input && input.requestId || '');
          var question = String(input && input.question || '');
          var mime = String(input && input.mime || '');
          var base64 = String(input && input.base64 || '');
          var confirmed = !!(input && input.confirmed === true);
          return call('image', { requestId: requestId, question: question, mime: mime, base64: base64, confirmed: confirmed }, 65000).then(function (data) {
            if (data && data.reply) return data.reply;
            return { ok: false, requestId: requestId, code: 'PROVIDER_UNAVAILABLE', retryable: true };
          });
        },
        cancel: function (requestId) {
          var id = String(requestId || '');
          return call('cancel', { requestId: id }, 4000).then(function (data) {
            return !!(data && data.cancelled === true);
          }).catch(function () { return false; });
        }
      };
      window.__nuanbanAndroidModelShim = true;
    })();
""".trimIndent()
