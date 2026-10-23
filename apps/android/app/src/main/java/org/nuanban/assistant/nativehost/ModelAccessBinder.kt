package org.nuanban.assistant.nativehost

/**
 * 设备会话绑定/刷新/撤销：全部走原生传输与[ModelAccessSessionStore]加密存储。
 *
 * - device_secret 只进原生加密存储，用于 device-sessions challenge 的 HMAC-SHA256 签名；
 * - refresh token 轮换后立即覆盖保存；任何失败保持原状态并返回 null/false（fail-closed）；
 * - 本类不使用 Android API，便于本机 JVM 校验。
 */
class ModelAccessBinder(
    private val store: ModelAccessSessionStore,
    private val transport: ModelAccessTransport,
    private val now: () -> Long = System::currentTimeMillis,
) {
    /** 绑定流程（用户确认后由原生配置入口调用；厂商的 device_secret 不得进入 JS）。 */
    fun bind(serverBaseUrl: String, deviceId: String, deviceSecret: String, userConfirmed: Boolean): Boolean {
        if (!userConfirmed) return false
        if (!ModelAccessLimits.validServerBaseUrl(serverBaseUrl)) return false
        if (!ModelAccessLimits.DEVICE_ID.matches(deviceId)) return false
        if (!ModelAccessLimits.validDeviceSecret(deviceSecret)) return false
        return runCatching {
            store.saveDeviceSecret(deviceSecret)
            val session = transport.bind(serverBaseUrl, deviceId, deviceSecret)
            require(session.serverBaseUrl == serverBaseUrl && session.deviceId == deviceId && session.accountId.isNotEmpty())
            require(session.accessExpiresAtMs > now() && session.refreshExpiresAtMs > session.accessExpiresAtMs)
            store.save(session)
            true
        }.getOrDefault(false)
    }

    /** 返回 access token 仍有效的会话；即将过期时先用 refresh token 走原生轮换。 */
    fun ensureSession(): ModelAccessSession? {
        val current = store.load() ?: return null
        if (current.accessExpiresAtMs - ModelAccessLimits.ACCESS_SKEW_MS > now()) return current
        return refresh()
    }

    fun refresh(): ModelAccessSession? = runCatching {
        val current = store.load() ?: return@runCatching null
        if (current.refreshExpiresAtMs - ModelAccessLimits.REFRESH_MIN_REMAINING_MS <= now()) return@runCatching null
        val deviceSecret = store.loadDeviceSecret() ?: return@runCatching null
        val refreshed = transport.refresh(current.serverBaseUrl, current.refreshToken, deviceSecret)
        require(refreshed.serverBaseUrl == current.serverBaseUrl)
        require(refreshed.accountId == current.accountId && refreshed.deviceId == current.deviceId)
        require(ModelAccessLimits.validSession(refreshed))
        require(refreshed.refreshExpiresAtMs - ModelAccessLimits.REFRESH_MIN_REMAINING_MS > now())
        store.save(refreshed)
        refreshed
    }.getOrNull()

    fun revoke(): Boolean = runCatching {
        val current = store.load() ?: return@runCatching false
        transport.revoke(current.serverBaseUrl, current.refreshToken)
        store.clear()
        true
    }.getOrDefault(false)
}
