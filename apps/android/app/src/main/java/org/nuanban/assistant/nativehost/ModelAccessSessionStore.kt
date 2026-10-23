package org.nuanban.assistant.nativehost

/**
 * 设备会话的原生加密持久化与状态判定。
 *
 * 存储复用 [EncryptedVault]：明文只在内存中短暂存在，落盘为 Android Keystore AES-GCM 密文；
 * 令牌不经过 WebView/JS。文件格式为固定版本的 8 行文本，读取时严格校验，损坏即视为未配置。
 */
object ModelAccessSessionCodec {
    private const val HEADER = "nuanban-model-session-v1"
    private const val LINE_COUNT = 8

    fun encode(session: ModelAccessSession): ByteArray {
        require(ModelAccessLimits.validSession(session)) { "invalid session" }
        val text = buildString {
            append(HEADER).append('\n')
            append(session.serverBaseUrl).append('\n')
            append(session.accountId).append('\n')
            append(session.deviceId).append('\n')
            append(session.accessToken).append('\n')
            append(session.refreshToken).append('\n')
            append(session.accessExpiresAtMs).append('\n')
            append(session.refreshExpiresAtMs)
        }
        val bytes = text.toByteArray(Charsets.UTF_8)
        require(bytes.size <= 16_384) { "session too large" }
        return bytes
    }

    fun decode(bytes: ByteArray?): ModelAccessSession? {
        if (bytes == null || bytes.isEmpty() || bytes.size > 16_384) return null
        val lines = String(bytes, Charsets.UTF_8).split('\n')
        if (lines.size != LINE_COUNT || lines[0] != HEADER) return null
        val accessExpiresAtMs = lines[6].toLongOrNull() ?: return null
        val refreshExpiresAtMs = lines[7].toLongOrNull() ?: return null
        val session = ModelAccessSession(
            serverBaseUrl = lines[1],
            accountId = lines[2],
            deviceId = lines[3],
            accessToken = lines[4],
            refreshToken = lines[5],
            accessExpiresAtMs = accessExpiresAtMs,
            refreshExpiresAtMs = refreshExpiresAtMs,
        )
        return if (ModelAccessLimits.validSession(session)) session else null
    }
}

class ModelAccessSessionStore(
    private val vault: EncryptedVault,
    private val now: () -> Long = System::currentTimeMillis,
) {
    companion object {
        const val ACCOUNT = "android-model"
        const val SLOT = "session"
        const val DEVICE_SECRET_SLOT = "device-secret"
    }

    fun load(): ModelAccessSession? = runCatching {
        ModelAccessSessionCodec.decode(vault.read(ACCOUNT, SLOT))
    }.getOrNull()

    fun save(session: ModelAccessSession) {
        if (!ModelAccessLimits.validSession(session)) throw IllegalArgumentException("invalid session")
        vault.write(ACCOUNT, SLOT, ModelAccessSessionCodec.encode(session))
    }

    /** device_secret 只在原生加密存储中；绑定流程提供，刷新时用于 HMAC 签名。 */
    fun saveDeviceSecret(deviceSecret: String) {
        if (!ModelAccessLimits.validDeviceSecret(deviceSecret)) throw IllegalArgumentException("invalid device secret")
        vault.write(ACCOUNT, DEVICE_SECRET_SLOT, deviceSecret.toByteArray(Charsets.UTF_8))
    }

    fun loadDeviceSecret(): String? = runCatching {
        val bytes = vault.read(ACCOUNT, DEVICE_SECRET_SLOT) ?: return@runCatching null
        try {
            String(bytes, Charsets.UTF_8).takeIf { ModelAccessLimits.validDeviceSecret(it) }
        } finally {
            bytes.fill(0)
        }
    }.getOrNull()

    fun clear() {
        runCatching { vault.remove(ACCOUNT, SLOT) }
        runCatching { vault.remove(ACCOUNT, DEVICE_SECRET_SLOT) }
    }

    /** 有会话且 refresh token 尚未到期即视为“配置完成”；实际请求仍可能失败，不据此宣称已连接。 */
    fun status(): ModelAccessStatus {
        val session = load() ?: return ModelAccessStatus.unconfigured()
        if (session.refreshExpiresAtMs - ModelAccessLimits.REFRESH_MIN_REMAINING_MS <= now()) {
            return ModelAccessStatus.sessionExpired()
        }
        return ModelAccessStatus.ready()
    }

    /** 返回仍可用的 access token；即将过期/已过期时返回 null，由调用方用 refresh token 换新。 */
    fun accessTokenFor(nowMs: Long = now()): String? {
        val session = load() ?: return null
        return if (session.accessExpiresAtMs - ModelAccessLimits.ACCESS_SKEW_MS > nowMs) session.accessToken else null
    }

    fun refreshTokenFor(nowMs: Long = now()): String? {
        val session = load() ?: return null
        return if (session.refreshExpiresAtMs - ModelAccessLimits.REFRESH_MIN_REMAINING_MS > nowMs) session.refreshToken else null
    }
}
