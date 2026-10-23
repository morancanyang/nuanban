package org.nuanban.assistant.nativehost

import org.json.JSONObject
import java.io.BufferedReader
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.time.Instant
import java.util.Base64
import java.util.UUID
import javax.net.ssl.HttpsURLConnection

/**
 * 原生模型通道传输：只允许固定端点 + HTTPS，不接受 WebView 传入的 URL/header/方法。
 *
 * 协议来源：B1 冻结的 device-sessions + conversations/image-responses + SSE 事件流。
 * 统一信封 `{ data, request_id, schema_version }` / 错误 `{ error: { code, message, retryable, details? }, ... }`。
 */
class AndroidModelAccessHttp(
    private val connectTimeoutMs: Int = 10_000,
    private val readTimeoutMs: Int = 60_000,
    private val maxResponseBytes: Int = 1_000_000,
) : ModelAccessTransport {
    companion object {
        const val PATH_CHALLENGES = "/v1/device-sessions/challenges"
        const val PATH_DEVICE_SESSIONS = "/v1/device-sessions"
        const val PATH_REFRESH = "/v1/device-sessions/refresh"
        const val PATH_REVOKE = "/v1/device-sessions/revoke"
        const val PATH_CONVERSATIONS = "/v1/conversations"
        const val CONVERSATION_MODE = "accessible"
        private const val JSON_CONTENT_TYPE = "application/json; charset=utf-8"
        private const val SSE_CONTENT_TYPE = "text/event-stream"
        private const val MAX_SSE_LINE = 1_000_000
    }

    private class ActiveRequest(
        val connection: HttpURLConnection,
        var serverRequestId: String? = null,
        var accessToken: String? = null,
        var serverBaseUrl: String = "",
    )

    private val lock = Any()
    private val active = LinkedHashMap<String, ActiveRequest>()

    override fun bind(serverBaseUrl: String, bindingId: String, deviceSecret: String): ModelAccessSession {
        if (!ModelAccessLimits.DEVICE_ID.matches(bindingId)) throw ModelAccessTransportException("INVALID_REQUEST", false)
        val challenge = fetchChallenge(serverBaseUrl, JSONObject().put("binding_id", bindingId))
        val signature = ModelAccessSignatures.signHmacSha256Hex(deviceSecret, challenge.challenge)
        val data = postEnvelope(
            serverBaseUrl = serverBaseUrl,
            path = PATH_DEVICE_SESSIONS,
            body = JSONObject().put("challenge_id", challenge.challengeId).put("signature", signature),
            accessToken = null,
            requestId = null,
        ).requireData()
        return sessionFrom(data, serverBaseUrl)
    }

    override fun refresh(serverBaseUrl: String, refreshToken: String, deviceSecret: String): ModelAccessSession {
        val challenge = fetchChallenge(serverBaseUrl, JSONObject().put("refresh_token", refreshToken))
        val signature = ModelAccessSignatures.signHmacSha256Hex(deviceSecret, challenge.challenge)
        val data = postEnvelope(
            serverBaseUrl = serverBaseUrl,
            path = PATH_REFRESH,
            body = JSONObject()
                .put("refresh_token", refreshToken)
                .put("challenge_id", challenge.challengeId)
                .put("signature", signature),
            accessToken = null,
            requestId = null,
        ).requireData()
        return sessionFrom(data, serverBaseUrl)
    }

    override fun revoke(serverBaseUrl: String, refreshToken: String): Boolean {
        val outcome = postEnvelope(
            serverBaseUrl = serverBaseUrl,
            path = PATH_REVOKE,
            body = JSONObject().put("refresh_token", refreshToken).put("revoke_device", true),
            accessToken = null,
            requestId = null,
        )
        val data = (outcome as? PostOutcome.Ok)?.data ?: return false
        return data.optBoolean("revoked", false)
    }

    override fun answerText(
        serverBaseUrl: String,
        accessToken: String,
        requestId: String,
        question: String,
    ): ModelAccessTransportResult = answer(serverBaseUrl, accessToken, requestId, question, pngBytes = null)

    override fun answerImage(
        serverBaseUrl: String,
        accessToken: String,
        requestId: String,
        question: String,
        pngBytes: ByteArray,
    ): ModelAccessTransportResult = answer(serverBaseUrl, accessToken, requestId, question, pngBytes)

    override fun cancel(serverBaseUrl: String, requestId: String) {
        val entry = synchronized(lock) { active.remove(requestId) } ?: return
        runCatching { entry.connection.disconnect() }
        val serverRequestId = entry.serverRequestId ?: return
        val token = entry.accessToken ?: return
        // 取消请求在后台发出，避免阻塞 WebView 消息线程；失败保持 fail-closed（SSE 已断开）。
        Thread {
            runCatching {
                postEnvelope(
                    serverBaseUrl = entry.serverBaseUrl,
                    path = "/v1/requests/$serverRequestId/cancel",
                    body = JSONObject(),
                    accessToken = token,
                    requestId = null,
                )
            }
        }.start()
    }

    private fun answer(
        serverBaseUrl: String,
        accessToken: String,
        requestId: String,
        question: String,
        pngBytes: ByteArray?,
    ): ModelAccessTransportResult {
        val inputId = UUID.nameUUIDFromBytes(requestId.toByteArray(Charsets.UTF_8)).toString()
        val conversation = postEnvelope(
            serverBaseUrl = serverBaseUrl,
            path = PATH_CONVERSATIONS,
            body = JSONObject().put("mode", CONVERSATION_MODE),
            accessToken = accessToken,
            requestId = requestId,
        )
        val conversationData = when (conversation) {
            is PostOutcome.Ok -> conversation.data
            is PostOutcome.Failure -> return conversation.toResult()
        }
        val sessionId = conversationData.optString("session_id")
        if (!ModelAccessLimits.UUID_ID.matches(sessionId)) return unavailable()

        val submitBody: JSONObject
        val submitPath: String
        if (pngBytes == null) {
            submitBody = JSONObject().put("input_id", inputId).put("generation", 0).put("text", question)
            submitPath = "$PATH_CONVERSATIONS/$sessionId/responses"
        } else {
            if (ModelAccessPng.size(pngBytes) == null) return invalidRequest()
            submitBody = JSONObject()
                .put("input_id", inputId)
                .put("generation", 0)
                .put("question", question)
                .put("image", JSONObject().put("mime", "image/png").put("base64", Base64.getEncoder().encodeToString(pngBytes)))
                .put("sanitized_sha256", ModelAccessPng.sha256Hex(pngBytes))
                .put("redaction_attested", true)
            submitPath = "$PATH_CONVERSATIONS/$sessionId/image-responses"
        }
        val submitted = postEnvelope(
            serverBaseUrl = serverBaseUrl,
            path = submitPath,
            body = submitBody,
            accessToken = accessToken,
            requestId = requestId,
        )
        val submittedData = when (submitted) {
            is PostOutcome.Ok -> submitted.data
            is PostOutcome.Failure -> return submitted.toResult()
        }
        val serverRequestId = submittedData.optString("request_id")
        val streamPath = submittedData.optString("stream_path")
        if (!ModelAccessLimits.UUID_ID.matches(serverRequestId) || !streamPath.startsWith("/v1/requests/") || !streamPath.endsWith("/events")) {
            return unavailable()
        }
        return readEvents(serverBaseUrl, accessToken, requestId, serverRequestId, streamPath)
    }

    /** 消费 SSE，直到 response.completed / response.failed / response.cancelled。 */
    private fun readEvents(
        serverBaseUrl: String,
        accessToken: String,
        inputRequestId: String,
        serverRequestId: String,
        streamPath: String,
    ): ModelAccessTransportResult {
        val connection = open(serverBaseUrl, streamPath, accessToken)
        connection.setRequestProperty("Accept", "$SSE_CONTENT_TYPE, text/plain")
        val entry = ActiveRequest(connection, serverRequestId, accessToken, serverBaseUrl)
        synchronized(lock) { active[inputRequestId] = entry }
        try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                val errorBody = connection.errorStream?.use { readBounded(it, maxResponseBytes) } ?: ""
                return resultFromEnvelope(connection.responseCode, errorBody)
            }
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
                val answer = StringBuilder()
                while (true) {
                    val line = readLineBounded(reader) ?: break
                    if (!line.startsWith("data:")) continue
                    val payload = line.removePrefix("data:").trim()
                    if (payload.isEmpty()) continue
                    val event = runCatching { JSONObject(payload) }.getOrNull() ?: continue
                    val type = event.optString("type")
                    val body = event.optJSONObject("payload") ?: JSONObject()
                    when (type) {
                        "caption.segment" -> {
                            val text = body.optString("text")
                            if (answer.length + text.length > ModelAccessLimits.REPLY_TEXT_MAX) return interrupted()
                            answer.append(text)
                        }
                        "response.completed" -> {
                            val text = answer.toString().trim()
                            return if (text.isEmpty()) interrupted() else ModelAccessTransportResult(true, text, null, false)
                        }
                        "response.failed" -> {
                            val code = body.optString("code").takeIf { ModelAccessLimits.validErrorCode(it) } ?: "PROVIDER_UNAVAILABLE"
                            return ModelAccessTransportResult(false, null, code, body.optBoolean("retryable", false))
                        }
                        "response.cancelled" -> return ModelAccessTransportResult(false, null, "CANCELLED", false)
                        else -> Unit
                    }
                }
            }
            return interrupted()
        } catch (timeout: SocketTimeoutException) {
            return ModelAccessTransportResult(false, null, "TIMEOUT", true)
        } catch (error: ModelAccessTransportException) {
            return ModelAccessTransportResult(false, null, error.code, error.retryable)
        } catch (_: Exception) {
            return ModelAccessTransportResult(false, null, "PROVIDER_UNAVAILABLE", true)
        } finally {
            synchronized(lock) { if (active[inputRequestId] === entry) active.remove(inputRequestId) }
            runCatching { connection.disconnect() }
        }
    }

    private fun fetchChallenge(serverBaseUrl: String, body: JSONObject): ModelAccessChallenge {
        val data = postEnvelope(serverBaseUrl, PATH_CHALLENGES, body, accessToken = null, requestId = null).requireData()
        if (data.optString("signature_algorithm") != "hmac-sha256-hex") throw ModelAccessTransportException("AUTH_FAILED", false)
        val expiresAt = runCatching { Instant.parse(data.optString("expires_at")).toEpochMilli() }.getOrDefault(0)
        val challenge = ModelAccessChallenge(
            challengeId = data.optString("challenge_id"),
            challenge = data.optString("challenge"),
            expiresAtMs = expiresAt,
        )
        if (!ModelAccessLimits.validChallenge(challenge)) throw ModelAccessTransportException("AUTH_FAILED", false)
        if (challenge.expiresAtMs <= System.currentTimeMillis()) throw ModelAccessTransportException("AUTH_EXPIRED", false)
        return challenge
    }

    private fun sessionFrom(data: JSONObject, serverBaseUrl: String): ModelAccessSession {
        val session = data.optJSONObject("session") ?: throw ModelAccessTransportException("PROVIDER_UNAVAILABLE", true)
        if (session.optString("token_type") != "Bearer") throw ModelAccessTransportException("AUTH_FAILED", false)
        val expiresIn = session.optLong("expires_in", 0)
        val refreshExpiresIn = session.optLong("refresh_expires_in", 0)
        if (expiresIn <= 0 || refreshExpiresIn <= expiresIn) throw ModelAccessTransportException("AUTH_FAILED", false)
        val now = System.currentTimeMillis()
        val parsed = ModelAccessSession(
            serverBaseUrl = serverBaseUrl,
            accountId = session.optString("account_id"),
            deviceId = session.optString("device_id"),
            accessToken = session.optString("access_token"),
            refreshToken = session.optString("refresh_token"),
            accessExpiresAtMs = now + expiresIn * 1000,
            refreshExpiresAtMs = now + refreshExpiresIn * 1000,
        )
        if (!ModelAccessLimits.validSession(parsed)) throw ModelAccessTransportException("AUTH_FAILED", false)
        return parsed
    }

    private sealed class PostOutcome {
        class Ok(val data: JSONObject) : PostOutcome()
        class Failure(val code: String, val retryable: Boolean) : PostOutcome()

        fun requireData(): JSONObject = when (this) {
            is Ok -> data
            is Failure -> throw ModelAccessTransportException(code, retryable)
        }

        fun toResult(): ModelAccessTransportResult = when (this) {
            is Ok -> ModelAccessTransportResult(false, null, "PROVIDER_UNAVAILABLE", true)
            is Failure -> ModelAccessTransportResult(false, null, code, retryable)
        }
    }

    private fun postEnvelope(
        serverBaseUrl: String,
        path: String,
        body: JSONObject,
        accessToken: String?,
        requestId: String?,
    ): PostOutcome {
        return try {
            val connection = open(serverBaseUrl, path, accessToken)
            val payload = body.toString().toByteArray(Charsets.UTF_8)
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.setFixedLengthStreamingMode(payload.size)
            connection.outputStream.use { stream -> stream.write(payload) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.use { readBounded(it, maxResponseBytes) } ?: ""
            runCatching { connection.disconnect() }
            if (status in 200..299) {
                val json = runCatching { JSONObject(text) }.getOrNull()
                    ?: return PostOutcome.Failure("PROVIDER_UNAVAILABLE", true)
                return PostOutcome.Ok(json.optJSONObject("data") ?: JSONObject())
            }
            val mapped = resultFromEnvelope(status, text)
            PostOutcome.Failure(mapped.code ?: "PROVIDER_UNAVAILABLE", mapped.retryable)
        } catch (timeout: SocketTimeoutException) {
            PostOutcome.Failure("TIMEOUT", true)
        } catch (error: ModelAccessTransportException) {
            PostOutcome.Failure(error.code, error.retryable)
        } catch (_: Exception) {
            PostOutcome.Failure("PROVIDER_UNAVAILABLE", true)
        }
    }

    private fun resultFromEnvelope(status: Int, text: String): ModelAccessTransportResult {
        val json = runCatching { JSONObject(text) }.getOrNull()
        val error = json?.optJSONObject("error")
        val rawCode = error?.optString("code").orEmpty()
        val retryable = error?.optBoolean("retryable", false) ?: false
        val code = when {
            rawCode == "AUTH_EXPIRED" -> "AUTH_EXPIRED"
            rawCode == "AUTH_FAILED" -> "AUTH_FAILED"
            rawCode in ModelAccessLimits.ERROR_CODES -> rawCode
            status == HttpURLConnection.HTTP_UNAUTHORIZED -> "AUTH_FAILED"
            status == 400 || status == 413 || status == 415 || status == 422 -> "INVALID_REQUEST"
            status == 403 -> "PERMISSION_DENIED"
            status == 429 -> "RATE_LIMITED"
            status == 408 || status == 504 -> "TIMEOUT"
            status >= 500 -> "PROVIDER_UNAVAILABLE"
            else -> "PROVIDER_UNAVAILABLE"
        }
        return ModelAccessTransportResult(false, null, code, retryable)
    }

    private fun open(serverBaseUrl: String, path: String, accessToken: String?): HttpURLConnection {
        if (!ModelAccessLimits.validServerBaseUrl(serverBaseUrl)) throw ModelAccessTransportException("PROVIDER_UNAVAILABLE", false)
        if (!path.startsWith("/v1/")) throw ModelAccessTransportException("INVALID_REQUEST", false)
        val url = URL(serverBaseUrl.trimEnd('/') + path)
        if (url.protocol != "https") throw ModelAccessTransportException("PROVIDER_UNAVAILABLE", false)
        val connection = url.openConnection() as? HttpsURLConnection
            ?: throw ModelAccessTransportException("PROVIDER_UNAVAILABLE", false)
        connection.instanceFollowRedirects = false
        connection.useCaches = false
        connection.allowUserInteraction = false
        connection.connectTimeout = connectTimeoutMs
        connection.readTimeout = readTimeoutMs
        connection.setRequestProperty("Content-Type", JSON_CONTENT_TYPE)
        connection.setRequestProperty("Accept", JSON_CONTENT_TYPE)
        connection.setRequestProperty("Accept-Encoding", "identity")
        connection.setRequestProperty("Connection", "close")
        if (accessToken != null) connection.setRequestProperty("Authorization", "Bearer $accessToken")
        return connection
    }

    private fun readBounded(stream: java.io.InputStream, limit: Int): String {
        val buffer = ByteArrayOutputStream()
        val chunk = ByteArray(8192)
        while (true) {
            val read = stream.read(chunk)
            if (read < 0) break
            if (buffer.size() + read > limit) throw ModelAccessTransportException("PROVIDER_UNAVAILABLE", true)
            buffer.write(chunk, 0, read)
        }
        return String(buffer.toByteArray(), Charsets.UTF_8)
    }

    private fun readLineBounded(reader: BufferedReader): String? {
        val line = reader.readLine() ?: return null
        if (line.length > MAX_SSE_LINE) throw ModelAccessTransportException("PROVIDER_UNAVAILABLE", true)
        return line
    }

    private fun interrupted() = ModelAccessTransportResult(false, null, "STREAM_INTERRUPTED", true)
    private fun unavailable() = ModelAccessTransportResult(false, null, "PROVIDER_UNAVAILABLE", true)
    private fun invalidRequest() = ModelAccessTransportResult(false, null, "INVALID_REQUEST", false)
}
