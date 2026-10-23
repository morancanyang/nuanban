import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * B2 原生会话/绑定/桥接核心的 JVM 校验：用本机 Gradle 缓存里的 Kotlin 编译器把
 * 纯 JDK Kotlin 文件（协议/加密存储/绑定/broker）与生成的检查入口编译并执行。
 *
 * 不在 CI 无 Android Gradle 缓存 / 非 Windows 环境时跳过；跳过不等于通过，报告里会标注。
 * 本测试不产生 APK，只做源码级逻辑验证（deviceVerified=false）。
 */

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const nativeRoot = resolve(workspaceRoot, 'apps/android/app/src/main/java/org/nuanban/assistant/nativehost');
const cacheRoot = resolve(workspaceRoot, '.cache/android-model-access-checks');
const sources = ['EncryptedVault.kt', 'ModelAccessProtocol.kt', 'ModelAccessSessionStore.kt', 'ModelAccessBinder.kt', 'ModelAccessBroker.kt'];

function findJava(): string | undefined {
  const candidates = [
    process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : '',
    'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\java.exe',
    'C:\\Program Files\\Microsoft\\jdk-25.0.3.9-hotspot\\bin\\java.exe',
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate));
}

function findJars(): string[] {
  const gradleHome = process.env.GRADLE_USER_HOME ?? join(homedir(), '.gradle');
  const coordinates = [
    'org.jetbrains.kotlin/kotlin-compiler-embeddable/2.2.20',
    'org.jetbrains.kotlin/kotlin-stdlib/2.2.20',
    'org.jetbrains.kotlin/kotlin-script-runtime/2.2.20',
    'org.jetbrains.kotlin/kotlin-reflect/1.6.10',
    'org.jetbrains.kotlin/kotlin-daemon-embeddable/2.2.20',
    'org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm/1.8.0',
    'org.jetbrains/annotations/13.0',
  ];
  const jars: string[] = [];
  for (const coordinate of coordinates) {
    const directory = join(gradleHome, 'caches/modules-2/files-2.1', ...coordinate.split('/'));
    const found = walkJars(directory);
    const jar = found.find(file => !/-(sources|javadoc)\.jar$/.test(file));
    if (!jar) return [];
    jars.push(jar);
  }
  return jars;
}

function walkJars(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) result.push(...walkJars(full));
    else if (entry.endsWith('.jar')) result.push(full);
  }
  return result;
}

const java = process.platform === 'win32' ? findJava() : undefined;
const jars = java ? findJars() : [];
const canRun = Boolean(java) && jars.length > 0;

const CHECKS_SOURCE = `
package org.nuanban.assistant.nativehost

import java.io.File
import java.nio.file.Files
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.crypto.spec.SecretKeySpec

object ModelAccessChecks {
    private var passed = 0
    private val failures = mutableListOf<String>()
    private const val NOW = 1_800_000_000_000L
    private const val HMAC_SECRET = "device-secret-0123456789"
    private const val HMAC_CHALLENGE = "q2VnJx8YzA3bC6dE9fG0hT4kLmN1pR7s"
    private const val HMAC_EXPECTED = "b284031428f208dc34b924493060e4d31514a56059419256284e6769c5e174b4"

    private val PNG: ByteArray = byteArrayOf(
        0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    )

    @JvmStatic
    fun main(args: Array<String>) {
        val root = Files.createTempDirectory("model-access-checks").toFile()
        try {
            signatures()
            sessionStore(root)
            binder(root)
            brokerText(root)
            brokerImage(root)
            concurrencyAndCancel(root)
        } finally {
            root.deleteRecursively()
        }
        println("{\\"passed\\":" + passed + ",\\"failed\\":" + failures.size + "}")
        if (failures.isNotEmpty()) {
            failures.forEach { failure -> println("FAIL " + failure) }
            System.exit(1)
        }
    }

    private fun check(name: String, block: () -> Unit) {
        try {
            block()
            passed += 1
        } catch (error: Throwable) {
            failures.add(name + ": " + (error.message ?: error.javaClass.simpleName))
        }
    }

    private fun expectTrue(condition: Boolean, message: String) {
        if (!condition) throw IllegalStateException(message)
    }

    private fun session(accessOffset: Long = 3_600_000L, refreshOffset: Long = 604_800_000L): ModelAccessSession =
        ModelAccessSession("https://api.example.com", "acct-1", "device-1", "access-token-0123456789abcdef", "refresh-token-0123456789abcdef", NOW + accessOffset, NOW + refreshOffset)

    private fun vault(root: File): EncryptedVault =
        EncryptedVault(File(root, "vault")) { _ -> SecretKeySpec(ByteArray(32) { 7 }, "AES") }

    private fun store(root: File, now: Long = NOW): ModelAccessSessionStore = ModelAccessSessionStore(vault(root), { now })

    class FakeTransport : ModelAccessTransport {
        var bindSession: ModelAccessSession? = null
        var refreshSession: ModelAccessSession? = null
        var textResults = ArrayDeque<ModelAccessTransportResult>()
        var imageResults = ArrayDeque<ModelAccessTransportResult>()
        var refreshCalls = 0
        var textCalls = 0
        var imageCalls = 0
        var lastAccessTokens = mutableListOf<String>()
        var cancelled = mutableListOf<String>()
        var textEntered = CountDownLatch(1)
        var textBlock: CountDownLatch? = null
        var recordTokens = false

        override fun bind(serverBaseUrl: String, bindingId: String, deviceSecret: String): ModelAccessSession =
            bindSession ?: throw ModelAccessTransportException("AUTH_FAILED", false)

        override fun refresh(serverBaseUrl: String, refreshToken: String, deviceSecret: String): ModelAccessSession {
            refreshCalls += 1
            return refreshSession ?: throw ModelAccessTransportException("AUTH_FAILED", false)
        }

        override fun revoke(serverBaseUrl: String, refreshToken: String): Boolean = true

        override fun answerText(serverBaseUrl: String, accessToken: String, requestId: String, question: String): ModelAccessTransportResult {
            textCalls += 1
            if (recordTokens) lastAccessTokens.add(accessToken)
            textEntered.countDown()
            textBlock?.await(5, TimeUnit.SECONDS)
            return textResults.removeFirstOrNull() ?: ModelAccessTransportResult(true, "回答", null, false)
        }

        override fun answerImage(serverBaseUrl: String, accessToken: String, requestId: String, question: String, pngBytes: ByteArray): ModelAccessTransportResult {
            imageCalls += 1
            return imageResults.removeFirstOrNull() ?: ModelAccessTransportResult(true, "图片回答", null, false)
        }

        override fun cancel(serverBaseUrl: String, requestId: String) {
            cancelled.add(requestId)
        }
    }

    private fun signatures() = check("signatures") {
        expectTrue(ModelAccessSignatures.signHmacSha256Hex(HMAC_SECRET, HMAC_CHALLENGE) == HMAC_EXPECTED, "hmac mismatch")
        expectTrue(runCatching { ModelAccessSignatures.signHmacSha256Hex("short", HMAC_CHALLENGE) }.isFailure, "short secret must fail")
    }

    private fun sessionStore(root: File) {
        check("store_unconfigured") {
            expectTrue(store(root).status() == ModelAccessStatus.unconfigured(), "must be unconfigured")
        }
        check("store_roundtrip_and_status") {
            val target = store(root)
            target.saveDeviceSecret(HMAC_SECRET)
            expectTrue(target.loadDeviceSecret() == HMAC_SECRET, "secret roundtrip")
            target.save(session())
            expectTrue(target.load() == session(), "session roundtrip")
            expectTrue(target.status().available, "ready expected")
            expectTrue(target.accessTokenFor() == session().accessToken, "access token expected")
        }
        check("store_expired") {
            val expiredAccess = store(root, NOW + 3_600_001L + ModelAccessLimits.ACCESS_SKEW_MS + 1)
            expectTrue(expiredAccess.accessTokenFor() == null, "access must be expired")
            expectTrue(expiredAccess.refreshTokenFor() != null, "refresh must remain")
            val expiredAll = store(root, NOW + 604_800_001L)
            expectTrue(expiredAll.status().reason == ModelAccessStatus.REASON_SESSION_EXPIRED, "session_expired expected")
        }
        check("store_rejects_tampered") {
            val file = File(root, "vault")
            val target = store(root)
            target.save(session())
            file.listFiles()?.filter { it.name.endsWith(".bin") }?.forEach { candidate ->
                if (candidate.length() > 20) {
                    val bytes = candidate.readBytes()
                    bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 1).toByte()
                    candidate.writeBytes(bytes)
                }
            }
            expectTrue(target.load() == null, "tampered session must be rejected")
            expectTrue(target.status().reason == ModelAccessStatus.REASON_UNCONFIGURED, "must stay fail-closed")
            target.save(session())
        }
    }

    private fun binder(root: File) {
        check("binder_requires_confirmation_and_https") {
            val target = store(root)
            val transport = FakeTransport()
            val subject = ModelAccessBinder(target, transport, { NOW })
            expectTrue(!subject.bind("https://api.example.com", "device-1", HMAC_SECRET, false), "must require confirmation")
            expectTrue(!subject.bind("http://api.example.com", "device-1", HMAC_SECRET, true), "http must be rejected")
            expectTrue(!subject.bind("https://api.example.com", "device-1", "short", true), "short secret must be rejected")
        }
        check("binder_bind_and_refresh") {
            val target = store(root)
            val transport = FakeTransport()
            val subject = ModelAccessBinder(target, transport, { NOW })
            transport.bindSession = session()
            expectTrue(subject.bind("https://api.example.com", "device-1", HMAC_SECRET, true), "bind must succeed")
            expectTrue(target.load() == session(), "session must be stored")
            expectTrue(target.loadDeviceSecret() == HMAC_SECRET, "secret must be stored")
            transport.refreshSession = session(accessOffset = 7_200_000L, refreshOffset = 1_209_600_000L)
            val refreshedNow = store(root, NOW + 3_600_001L + ModelAccessLimits.ACCESS_SKEW_MS + 1)
            val refresher = ModelAccessBinder(refreshedNow, transport, { NOW + 3_600_001L + ModelAccessLimits.ACCESS_SKEW_MS + 1 })
            val refreshed = refresher.ensureSession()
            expectTrue(refreshed != null && refreshed.accessExpiresAtMs == NOW + 7_200_000L, "refresh must update session")
            expectTrue(transport.refreshCalls == 1, "one refresh expected")
            transport.refreshSession = session(accessOffset = 30L, refreshOffset = 604_800_000L)
            transport.refreshSession = ModelAccessSession("https://api.example.com", "acct-2", "device-1", "access-token-0123456789abcdef", "refresh-token-0123456789abcdef", NOW + 3_600_000L, NOW + 604_800_000L)
            expectTrue(refresher.refresh() == null, "account change must be rejected")
        }
    }

    private fun brokerText(root: File) {
        check("broker_requires_session") {
            val store = store(root)
            store.clear()
            val transport = FakeTransport()
            val broker = ModelAccessBroker(store, ModelAccessBinder(store, transport, { NOW }), transport, { false }, { NOW }) { null }
            val reply = broker.answerText("request-0001", "问题")
            expectTrue(!reply.ok && reply.code == "AUTH_FAILED", "AUTH_FAILED expected")
            expectTrue(transport.textCalls == 0, "transport must not be called")
        }
        check("broker_text_success_without_token") {
            val store = store(root)
            store.save(session())
            val transport = FakeTransport()
            val broker = ModelAccessBroker(store, ModelAccessBinder(store, transport, { NOW }), transport, { false }, { NOW }) { null }
            val reply = broker.answerText("request-0001", "手机字体怎么调大？")
            expectTrue(reply.ok && reply.text == "回答", "text answer expected")
            val json = ModelAccessJson.reply(reply)
            expectTrue(!json.contains("access-token"), "reply must not contain access token")
            expectTrue(!json.contains("refresh-token"), "reply must not contain refresh token")
        }
        check("broker_text_validation") {
            val store = store(root)
            store.save(session())
            val transport = FakeTransport()
            val broker = ModelAccessBroker(store, ModelAccessBinder(store, transport, { NOW }), transport, { false }, { NOW }) { null }
            expectTrue(broker.answerText("bad id!", "问题").code == "INVALID_REQUEST", "bad request id")
            expectTrue(broker.answerText("request-0001", "x".repeat(1501)).code == "INVALID_REQUEST", "long question")
            expectTrue(transport.textCalls == 0, "invalid requests must not reach transport")
        }
        check("broker_auth_expired_retries_once_after_refresh") {
            val store = store(root)
            store.save(session())
            store.saveDeviceSecret(HMAC_SECRET)
            val transport = FakeTransport()
            transport.recordTokens = true
            transport.textResults.addLast(ModelAccessTransportResult(false, null, "AUTH_EXPIRED", false))
            transport.refreshSession = ModelAccessSession("https://api.example.com", "acct-1", "device-1", "rotated-access-token-0123456789", "rotated-refresh-token-0123456789", NOW + 3_600_000L, NOW + 604_800_000L)
            val broker = ModelAccessBroker(store, ModelAccessBinder(store, transport, { NOW }), transport, { false }, { NOW }) { null }
            val reply = broker.answerText("request-0001", "问题")
            expectTrue(reply.ok, "retry must succeed")
            expectTrue(transport.refreshCalls == 1 && transport.textCalls == 2, "one refresh and two attempts expected")
            expectTrue(transport.lastAccessTokens.last() == "rotated-access-token-0123456789", "retry must use rotated token")
        }
        check("broker_auth_expired_refresh_failure_is_fail_closed") {
            val store = store(root)
            store.save(session())
            val transport = FakeTransport()
            transport.textResults.addLast(ModelAccessTransportResult(false, null, "AUTH_EXPIRED", false))
            transport.refreshSession = null
            val broker = ModelAccessBroker(store, ModelAccessBinder(store, transport, { NOW }), transport, { false }, { NOW }) { null }
            val reply = broker.answerText("request-0001", "问题")
            expectTrue(!reply.ok && reply.code == "AUTH_FAILED", "AUTH_FAILED expected")
        }
    }

    private fun brokerImage(root: File) {
        val pngBase64 = Base64.getEncoder().encodeToString(PNG)
        check("broker_image_requires_redaction") {
            val store = store(root)
            store.save(session())
            val transport = FakeTransport()
            val broker = ModelAccessBroker(store, ModelAccessBinder(store, transport, { NOW }), transport, { false }, { NOW }) { null }
            val reply = broker.answerImage("request-0001", "看看", "image/png", pngBase64, true)
            expectTrue(!reply.ok && reply.code == "REDACTION_UNAVAILABLE", "redaction gate expected")
            expectTrue(transport.imageCalls == 0, "image must not be uploaded")
        }
        check("broker_image_requires_consent_and_png") {
            val store = store(root)
            store.save(session())
            val transport = FakeTransport()
            val broker = ModelAccessBroker(store, ModelAccessBinder(store, transport, { NOW }), transport, { true }, { NOW }) { null }
            expectTrue(broker.answerImage("request-0001", "看看", "image/png", pngBase64, false).code == "CONSENT_REQUIRED", "consent required")
            expectTrue(broker.answerImage("request-0001", "看看", "image/jpeg", pngBase64, true).code == "INVALID_REQUEST", "only png accepted")
            expectTrue(broker.answerImage("request-0001", "看看", "image/png", "not-base64!", true).code == "INVALID_REQUEST", "bad base64")
            expectTrue(transport.imageCalls == 0, "invalid images must not be uploaded")
        }
        check("broker_image_success_and_png_validation") {
            val store = store(root)
            store.save(session())
            val transport = FakeTransport()
            val broker = ModelAccessBroker(store, ModelAccessBinder(store, transport, { NOW }), transport, { true }, { NOW }) { null }
            val reply = broker.answerImage("request-0001", "看看", "image/png", pngBase64, true)
            expectTrue(reply.ok && reply.text == "图片回答", "image answer expected")
            expectTrue(transport.imageCalls == 1, "image must reach transport")
            expectTrue(ModelAccessPng.sha256Hex(PNG) == "9828c7317cb499358b0506a356e155adbf2eaa62704872ec7fb6a45d7f7edd39", "png sha mismatch")
            val oversized = PNG.copyOf()
            oversized[17] = 0x20
            expectTrue(ModelAccessPng.size(oversized) == null, "oversized png must be rejected")
        }
    }

    private fun concurrencyAndCancel(root: File) {
        check("broker_pending_limit") {
            val store = store(root)
            store.save(session())
            val transport = FakeTransport()
            transport.textBlock = CountDownLatch(1)
            val broker = ModelAccessBroker(store, ModelAccessBinder(store, transport, { NOW }), transport, { false }, { NOW }) { null }
            val threads = (1..4).map { index ->
                Thread { broker.answerText("request-000" + index, "问题") }.also { it.start() }
            }
            var waited = 0
            while (transport.textCalls < 4 && waited < 3000) {
                Thread.sleep(10)
                waited += 10
            }
            expectTrue(transport.textCalls == 4, "four concurrent requests expected")
            val rejected = broker.answerText("request-0005", "问题")
            expectTrue(rejected.code == "RATE_LIMITED", "pending limit must reject extra requests")
            transport.textBlock?.countDown()
            threads.forEach { it.join(5000) }
        }
        check("broker_cancel_marks_cancelled") {
            val store = store(root)
            store.save(session())
            val transport = FakeTransport()
            transport.textBlock = CountDownLatch(1)
            val broker = ModelAccessBroker(store, ModelAccessBinder(store, transport, { NOW }), transport, { false }, { NOW }) { null }
            var replyJson = ""
            val thread = Thread { replyJson = ModelAccessJson.reply(broker.answerText("request-0001", "问题")) }
            thread.start()
            transport.textEntered.await(3, TimeUnit.SECONDS)
            expectTrue(broker.cancel("request-0001"), "cancel must find request")
            expectTrue(transport.cancelled.contains("request-0001"), "transport cancel expected")
            transport.textBlock?.countDown()
            thread.join(5000)
            expectTrue(replyJson.contains("CANCELLED"), "cancelled reply expected")
            expectTrue(!broker.cancel("unknown-request"), "unknown request cancel must be false")
        }
        check("status_host_unavailable") {
            val store = store(root)
            val transport = FakeTransport()
            val broker = ModelAccessBroker(store, ModelAccessBinder(store, transport, { NOW }), transport, { false }, { NOW }) { "缺少网络权限" }
            expectTrue(broker.status().reason == ModelAccessStatus.REASON_HOST_UNAVAILABLE, "host unavailable expected")
            expectTrue(broker.status().message.contains("网络"), "message expected")
        }
    }
}
`;

describe('B2 Android 原生会话/桥接核心（JVM 级校验）', () => {
  it.skipIf(!canRun)('会话加密存储、绑定/刷新、桥接白名单、取消、失效与拒绝路径可执行验证', () => {
    mkdirSync(cacheRoot, { recursive: true });
    const checkFile = join(cacheRoot, 'ModelAccessChecks.kt');
    writeFileSync(checkFile, CHECKS_SOURCE, 'utf8');
    const classesDir = join(cacheRoot, 'classes');
    mkdirSync(classesDir, { recursive: true });
    const classpath = jars.join(';');
    const compileArgs = [
      '-cp', classpath,
      'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
      '-no-stdlib', '-no-reflect',
      '-classpath', classpath,
      '-jvm-target', '17',
      '-d', classesDir,
      ...sources.map(source => join(nativeRoot, source)),
      checkFile,
    ];
    const compile = spawnSync(java!, compileArgs, { encoding: 'utf8', timeout: 180_000, windowsHide: true });
    expect(compile.error).toBeUndefined();
    expect(compile.status, compile.stderr || compile.stdout).toBe(0);
    const run = spawnSync(java!, ['-cp', [classesDir, ...jars].join(';'), 'org.nuanban.assistant.nativehost.ModelAccessChecks'], {
      encoding: 'utf8', timeout: 120_000, windowsHide: true,
    });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stdout + '\n' + run.stderr).toBe(0);
    expect(run.stdout).toContain('"failed":0');
    const summary = JSON.parse(run.stdout.trim().split('\n').at(-1)!);
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBeGreaterThanOrEqual(15);
  }, 300_000);
});
