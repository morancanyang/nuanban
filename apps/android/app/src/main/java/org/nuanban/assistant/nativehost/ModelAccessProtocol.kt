package org.nuanban.assistant.nativehost

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * B2 Android 原生模型通道的本机协议、限制与序列化。
 *
 * 协议来源：B1 已冻结的 device-sessions + conversations/image-responses + SSE 事件流
 * （完整文档 `docs/implementation/android-model-access.md` 由 B1 落地）。
 *
 * 约束（与 docs/implementation/android-model-and-3d-plan.md 1.2 一致）：
 * - 设备会话凭证（access/refresh token、device_secret）只允许出现在原生层；
 *   本文件不向 JS 暴露任何 token，桥接只回传 requestId/text/code。
 * - 本文件只用 JDK API（javax.crypto / java.security），不依赖 Android，便于本机 JVM 校验。
 */

/** 原生加密存储中的设备会话；令牌永不返回给 WebView。 */
data class ModelAccessSession(
    val serverBaseUrl: String,
    val accountId: String,
    val deviceId: String,
    val accessToken: String,
    val refreshToken: String,
    val accessExpiresAtMs: Long,
    val refreshExpiresAtMs: Long,
)

/** device-session challenge：challenge 为 base64url 文本，签名算法固定 hmac-sha256-hex。 */
data class ModelAccessChallenge(
    val challengeId: String,
    val challenge: String,
    val expiresAtMs: Long,
)

/** 本机状态（status 桥接与 Web 适配器共用）。available=false 时一律 fail-closed。 */
data class ModelAccessStatus(
    val available: Boolean,
    val reason: String,
    val message: String,
) {
    companion object {
        const val REASON_READY = "ready"
        const val REASON_UNCONFIGURED = "unconfigured"
        const val REASON_SESSION_EXPIRED = "session_expired"
        const val REASON_HOST_UNAVAILABLE = "host_unavailable"
        const val REASON_REDACTION_UNAVAILABLE = "redaction_unavailable"
        const val REASON_REFRESH_FAILED = "refresh_failed"

        fun ready() = ModelAccessStatus(true, REASON_READY, "模型通道已配置。连接结果以实际请求为准。")
        fun unconfigured() = ModelAccessStatus(
            false,
            REASON_UNCONFIGURED,
            "模型通道未配置：本机没有可用的设备会话。不会回退演示回答，也不会把令牌交给网页。",
        )
        fun sessionExpired() = ModelAccessStatus(
            false,
            REASON_SESSION_EXPIRED,
            "模型会话已失效，请在客户端重新完成设备绑定。本次不会发送问题，也不会使用演示回答。",
        )
        fun hostUnavailable(message: String = "当前安装包或系统不支持模型通道（缺少网络权限或传输能力）。不会回退演示回答。") =
            ModelAccessStatus(false, REASON_HOST_UNAVAILABLE, message)
        fun redactionUnavailable() = ModelAccessStatus(
            false,
            REASON_REDACTION_UNAVAILABLE,
            "本机图片脱敏/门控尚未就绪，图片不会上传。请改用文字提问。",
        )
    }
}

/** 本机对一次问答的最终结论；text 与 code 互斥，绝不含 token。 */
data class ModelAccessReply(
    val ok: Boolean,
    val requestId: String,
    val text: String?,
    val code: String?,
    val retryable: Boolean,
)

/** 问答传输结论；AUTH_EXPIRED 由 broker 触发一次原生刷新后重试。 */
data class ModelAccessTransportResult(val ok: Boolean, val text: String?, val code: String?, val retryable: Boolean)

/** 固定端点集的原生传输；WebView 不能传入 URL、header 或任意 HTTP 目标。 */
interface ModelAccessTransport {
    /** device-sessions/challenges + 签名 + device-sessions：仅原生绑定流程调用。 */
    fun bind(serverBaseUrl: String, bindingId: String, deviceSecret: String): ModelAccessSession

    /** device-sessions/challenges（refresh_token 形式）+ 签名 + device-sessions/refresh（轮换）。 */
    fun refresh(serverBaseUrl: String, refreshToken: String, deviceSecret: String): ModelAccessSession

    /** 撤销当前 refresh token；幂等且仅拒绝型。 */
    fun revoke(serverBaseUrl: String, refreshToken: String): Boolean

    /** 文字问答：创建会话 → POST responses → 消费 SSE 到 completed/failed。 */
    fun answerText(serverBaseUrl: String, accessToken: String, requestId: String, question: String): ModelAccessTransportResult

    /** 图片问答：脱敏 PNG + sanitized_sha256 + redaction_attested → image-responses → SSE。 */
    fun answerImage(serverBaseUrl: String, accessToken: String, requestId: String, question: String, pngBytes: ByteArray): ModelAccessTransportResult

    /** 中止仍在进行的一次请求（断开 SSE + 请求取消）；实现必须幂等且不抛出。 */
    fun cancel(serverBaseUrl: String, requestId: String)
}

class ModelAccessTransportException(val code: String, val retryable: Boolean, message: String = code) : Exception(message)

/** 迁移期兼容门控（图片脱敏/门控未就绪时必须 fail-closed）。 */
fun interface ModelAccessRedactionGate {
    fun canUploadRedactedImage(): Boolean
}

object ModelAccessLimits {
    const val PROTOCOL_VERSION = 1
    const val QUESTION_MAX_CHARS = 1500
    const val REQUEST_ID_MAX = 80
    const val REPLY_TEXT_MAX = 24_000
    const val STATUS_MESSAGE_MAX = 300
    const val PENDING_MAX = 4
    const val TOKEN_MIN = 16
    const val TOKEN_MAX = 4096
    const val BASE_URL_MAX = 2048
    const val ACCESS_SKEW_MS = 30_000L
    const val REFRESH_MIN_REMAINING_MS = 5_000L
    /** device_secret 由绑定流程提供，仅存原生加密存储。 */
    const val DEVICE_SECRET_MIN = 16
    const val DEVICE_SECRET_MAX = 256
    /** WebView → 原生：用户选择的图片 base64 上限（10MiB 原图，含编码开销）。 */
    const val IMAGE_INPUT_BASE64_MAX = 14_000_000
    /** 脱敏后 PNG 上限：与服务端一致 2,000,000 字节。 */
    const val REDACTED_PNG_MAX_BYTES = 2_000_000
    const val PNG_MAX_DIMENSION = 4096
    const val PNG_MAX_PIXELS = 8_388_608
    const val CHALLENGE_MIN = 16
    const val CHALLENGE_MAX = 512
    const val SIGNATURE_HEX = 64
    const val MAX_SESSION_LIFETIME_MS = 400L * 24 * 60 * 60 * 1000

    val IMAGE_INPUT_MIMES: Set<String> = setOf("image/png", "image/jpeg", "image/webp")
    val REQUEST_ID = Regex("[A-Za-z0-9-]{8,80}")
    val ACCOUNT_ID = Regex("[a-z0-9-]{1,64}")
    val DEVICE_ID = Regex("[A-Za-z0-9-]{1,80}")
    val CHALLENGE_ID = Regex("[A-Za-z0-9-]{8,80}")
    val CHALLENGE = Regex("[A-Za-z0-9_-]{${CHALLENGE_MIN},${CHALLENGE_MAX}}")
    val SIGNATURE = Regex("[0-9a-f]{$SIGNATURE_HEX}")
    val BASE64 = Regex("[A-Za-z0-9+/]+={0,2}")
    val UUID_ID = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
    val HEX_SHA256 = Regex("[0-9a-f]{64}")

    /** 与 Web 端口共用错误码；REDACTION_UNAVAILABLE / AUTH_EXPIRED 为原生内部码，Web 适配器做 fail-closed 映射。 */
    val ERROR_CODES: Set<String> = setOf(
        "INVALID_REQUEST",
        "CONSENT_REQUIRED",
        "REDACTION_UNAVAILABLE",
        "AUTH_FAILED",
        "AUTH_EXPIRED",
        "PERMISSION_DENIED",
        "RISK_PAUSED",
        "RATE_LIMITED",
        "PROVIDER_UNAVAILABLE",
        "STREAM_INTERRUPTED",
        "TIMEOUT",
        "CANCELLED",
    )

    fun validToken(value: String?): Boolean = value != null &&
        value.length in TOKEN_MIN..TOKEN_MAX &&
        value.none { it == '\n' || it == '\r' || it == '\u0000' }

    fun validDeviceSecret(value: String?): Boolean = value != null &&
        value.length in DEVICE_SECRET_MIN..DEVICE_SECRET_MAX &&
        value.none { it.isWhitespace() || it == '\u0000' }

    fun validRequestId(value: String?): Boolean = value != null && REQUEST_ID.matches(value)

    fun validQuestion(value: String?): Boolean = value != null &&
        value.isNotBlank() && value.length <= QUESTION_MAX_CHARS && value.none { it == '\u0000' }

    fun validReplyText(value: String?): Boolean = value != null && value.isNotBlank() && value.length <= REPLY_TEXT_MAX

    fun validImageInputMime(value: String?): Boolean = value in IMAGE_INPUT_MIMES

    fun validImageInputBase64(value: String?): Boolean = value != null &&
        value.length in 4..IMAGE_INPUT_BASE64_MAX && value.length % 4 == 0 && BASE64.matches(value)

    fun validServerBaseUrl(value: String?): Boolean {
        if (value == null || value.length !in 8..BASE_URL_MAX) return false
        if (value.any { it <= ' ' || it == '\\' }) return false
        if (!value.startsWith("https://")) return false
        val authority = value.removePrefix("https://").substringBefore('/')
        if (authority.isEmpty() || authority.startsWith('.') || authority.contains('@')) return false
        return !value.contains('\u0000')
    }

    fun validSession(session: ModelAccessSession): Boolean =
        validServerBaseUrl(session.serverBaseUrl) &&
            ACCOUNT_ID.matches(session.accountId) &&
            DEVICE_ID.matches(session.deviceId) &&
            validToken(session.accessToken) &&
            validToken(session.refreshToken) &&
            session.accessExpiresAtMs > 0 &&
            session.refreshExpiresAtMs > session.accessExpiresAtMs &&
            session.refreshExpiresAtMs <= Long.MAX_VALUE / 2

    fun validChallenge(challenge: ModelAccessChallenge): Boolean =
        CHALLENGE_ID.matches(challenge.challengeId) && CHALLENGE.matches(challenge.challenge) && challenge.expiresAtMs > 0

    fun validErrorCode(code: String?): Boolean = code in ERROR_CODES
}

/** HMAC-SHA256 设备签名：key=device_secret UTF-8 字节，message=challenge UTF-8 字节，输出小写 hex。 */
object ModelAccessSignatures {
    fun signHmacSha256Hex(deviceSecret: String, challenge: String): String {
        require(ModelAccessLimits.validDeviceSecret(deviceSecret))
        require(ModelAccessLimits.CHALLENGE.matches(challenge))
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(deviceSecret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        val digest = mac.doFinal(challenge.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}

/** 脱敏后 PNG 的最小校验（签名/IHDR 尺寸/上限/sha256），与服务端字段对齐。 */
object ModelAccessPng {
    private val SIGNATURE = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)

    data class Size(val width: Int, val height: Int)

    fun size(bytes: ByteArray?): Size? {
        if (bytes == null || bytes.size < 33 || bytes.size > ModelAccessLimits.REDACTED_PNG_MAX_BYTES) return null
        for (index in SIGNATURE.indices) if (bytes[index] != SIGNATURE[index]) return null
        val ihdrLength = readInt(bytes, 8)
        if (ihdrLength != 13 || String(bytes, 12, 4, Charsets.US_ASCII) != "IHDR") return null
        val width = readInt(bytes, 16)
        val height = readInt(bytes, 20)
        if (width <= 0 || height <= 0) return null
        if (width > ModelAccessLimits.PNG_MAX_DIMENSION || height > ModelAccessLimits.PNG_MAX_DIMENSION) return null
        if (width.toLong() * height.toLong() > ModelAccessLimits.PNG_MAX_PIXELS) return null
        return Size(width, height)
    }

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }

    private fun readInt(bytes: ByteArray, offset: Int): Int =
        ((bytes[offset].toInt() and 255) shl 24) or ((bytes[offset + 1].toInt() and 255) shl 16) or
            ((bytes[offset + 2].toInt() and 255) shl 8) or (bytes[offset + 3].toInt() and 255)
}

/** 最小 JSON 序列化（无第三方依赖，禁止把 token 写入任何回复）。 */
object ModelAccessJson {
    fun quote(value: String): String {
        val builder = StringBuilder(value.length + 2)
        builder.append('"')
        for (character in value) {
            when {
                character == '"' -> builder.append("\\\"")
                character == '\\' -> builder.append("\\\\")
                character == '\n' -> builder.append("\\n")
                character == '\r' -> builder.append("\\r")
                character == '\t' -> builder.append("\\t")
                character < ' ' -> builder.append("\\u").append(character.code.toString(16).padStart(4, '0'))
                else -> builder.append(character)
            }
        }
        builder.append('"')
        return builder.toString()
    }

    fun status(status: ModelAccessStatus): String = buildString {
        append('{')
        append("\"protocolVersion\":").append(ModelAccessLimits.PROTOCOL_VERSION).append(',')
        append("\"available\":").append(status.available).append(',')
        append("\"reason\":").append(quote(status.reason)).append(',')
        append("\"message\":").append(quote(status.message.take(ModelAccessLimits.STATUS_MESSAGE_MAX)))
        append('}')
    }

    fun reply(reply: ModelAccessReply): String = buildString {
        append('{')
        append("\"requestId\":").append(quote(reply.requestId)).append(',')
        append("\"ok\":").append(reply.ok)
        if (reply.ok) append(",\"text\":").append(quote(reply.text ?: ""))
        else {
            append(",\"code\":").append(quote(reply.code ?: "PROVIDER_UNAVAILABLE"))
            append(",\"retryable\":").append(reply.retryable)
        }
        append('}')
    }

    fun error(requestId: String, code: String, retryable: Boolean): ModelAccessReply =
        ModelAccessReply(false, requestId, null, if (ModelAccessLimits.validErrorCode(code)) code else "PROVIDER_UNAVAILABLE", retryable)
}
