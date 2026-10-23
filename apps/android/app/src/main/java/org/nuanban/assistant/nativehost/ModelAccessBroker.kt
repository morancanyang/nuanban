package org.nuanban.assistant.nativehost

import java.util.Base64

/**
 * 受限桥接的本机核心：字段白名单由 Android 桥接层完成；本类负责
 * 请求 ID/问题/图片上限、并发上限、取消、会话刷新与失败闭合。
 * 返回值只包含 requestId/text/code，**从不包含 token**。
 */
class ModelAccessBroker(
    private val store: ModelAccessSessionStore,
    private val binder: ModelAccessBinder,
    private val transport: ModelAccessTransport,
    private val redaction: ModelAccessRedactionGate = ModelAccessRedactionGate { false },
    private val now: () -> Long = System::currentTimeMillis,
    private val hostUnavailableMessage: () -> String? = { null },
) {
    private class Pending {
        @Volatile var cancelled = false
    }

    private val lock = Any()
    private val pending = linkedMapOf<String, Pending>()

    fun status(): ModelAccessStatus {
        hostUnavailableMessage()?.let { return ModelAccessStatus.hostUnavailable(it) }
        return store.status()
    }

    fun answerText(requestId: String?, question: String?): ModelAccessReply {
        if (!ModelAccessLimits.validRequestId(requestId)) return ModelAccessJson.error(safeId(requestId), "INVALID_REQUEST", false)
        val id = requestId!!
        val safeQuestion = question?.takeIf { ModelAccessLimits.validQuestion(it) }
            ?: return ModelAccessJson.error(id, "INVALID_REQUEST", false)
        val marker = begin(id) ?: return ModelAccessJson.error(id, "RATE_LIMITED", true)
        try {
            val result = withAuthRetry { session ->
                transport.answerText(session.serverBaseUrl, session.accessToken, id, safeQuestion)
            }
            if (marker.cancelled) return ModelAccessJson.error(id, "CANCELLED", false)
            return toReply(id, result)
        } finally {
            end(id)
        }
    }

    fun answerImage(
        requestId: String?,
        question: String?,
        mime: String?,
        base64: String?,
        confirmed: Boolean,
    ): ModelAccessReply {
        if (!ModelAccessLimits.validRequestId(requestId)) return ModelAccessJson.error(safeId(requestId), "INVALID_REQUEST", false)
        val id = requestId!!
        val safeQuestion = question?.takeIf { ModelAccessLimits.validQuestion(it) }
            ?: return ModelAccessJson.error(id, "INVALID_REQUEST", false)
        if (!confirmed) return ModelAccessJson.error(id, "CONSENT_REQUIRED", false)
        if (!ModelAccessLimits.validImageInputMime(mime) || !ModelAccessLimits.validImageInputBase64(base64)) {
            return ModelAccessJson.error(id, "INVALID_REQUEST", false)
        }
        // 本机脱敏/门控未就绪时一律拒绝：原始图片不上传，也不回退文字演示。
        if (!redaction.canUploadRedactedImage()) return ModelAccessJson.error(id, "REDACTION_UNAVAILABLE", false)
        // 服务端 image-responses 只接受脱敏 PNG；非 PNG 或超出尺寸/像素上限一律拒绝。
        if (mime != "image/png") return ModelAccessJson.error(id, "INVALID_REQUEST", false)
        val pngBytes = runCatching { Base64.getDecoder().decode(base64) }.getOrNull()
            ?: return ModelAccessJson.error(id, "INVALID_REQUEST", false)
        if (ModelAccessPng.size(pngBytes) == null) {
            pngBytes.fill(0)
            return ModelAccessJson.error(id, "INVALID_REQUEST", false)
        }
        val marker = begin(id) ?: return ModelAccessJson.error(id, "RATE_LIMITED", true)
        try {
            val result = withAuthRetry { session ->
                transport.answerImage(session.serverBaseUrl, session.accessToken, id, safeQuestion, pngBytes)
            }
            if (marker.cancelled) return ModelAccessJson.error(id, "CANCELLED", false)
            return toReply(id, result)
        } finally {
            pngBytes.fill(0)
            end(id)
        }
    }

    fun cancel(requestId: String?): Boolean {
        if (requestId == null) return false
        val found = synchronized(lock) {
            pending[requestId]?.let { it.cancelled = true; true } ?: false
        }
        val serverBaseUrl = runCatching { store.load()?.serverBaseUrl }.getOrNull()
        if (found && serverBaseUrl != null) runCatching { transport.cancel(serverBaseUrl, requestId) }
        return found
    }

    fun cancelAll() {
        val ids = synchronized(lock) { pending.keys.toList() }
        val serverBaseUrl = runCatching { store.load()?.serverBaseUrl }.getOrNull()
        if (serverBaseUrl != null) ids.forEach { id -> runCatching { transport.cancel(serverBaseUrl, id) } }
        synchronized(lock) { pending.values.forEach { it.cancelled = true } }
    }

    private fun begin(requestId: String): Pending? = synchronized(lock) {
        if (pending.containsKey(requestId) || pending.size >= ModelAccessLimits.PENDING_MAX) return null
        val marker = Pending()
        pending[requestId] = marker
        marker
    }

    private fun end(requestId: String) {
        synchronized(lock) { pending.remove(requestId) }
    }

    /**
     * 取可用会话（必要时原生刷新），执行一次请求；遇到 AUTH_EXPIRED 时刷新后**只重试一次**。
     * 刷新失败返回 AUTH_FAILED，不伪造成功、不重放演示回答。
     */
    private fun withAuthRetry(call: (ModelAccessSession) -> ModelAccessTransportResult): ModelAccessTransportResult {
        val first = binder.ensureSession()
            ?: return ModelAccessTransportResult(false, null, "AUTH_FAILED", false)
        val result = call(first)
        if (result.code != "AUTH_EXPIRED") return result
        val refreshed = binder.refresh()
            ?: return ModelAccessTransportResult(false, null, "AUTH_FAILED", false)
        return call(refreshed)
    }

    private fun toReply(requestId: String, result: ModelAccessTransportResult): ModelAccessReply {
        if (!result.ok) return ModelAccessJson.error(requestId, result.code ?: "PROVIDER_UNAVAILABLE", result.retryable)
        if (!ModelAccessLimits.validReplyText(result.text)) return ModelAccessJson.error(requestId, "STREAM_INTERRUPTED", true)
        return ModelAccessReply(true, requestId, result.text, null, false)
    }

    private fun safeId(requestId: String?): String = requestId?.take(80)?.filter { it.isLetterOrDigit() || it == '-' } ?: ""
}
