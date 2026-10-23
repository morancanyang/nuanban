package org.nuanban.assistant.nativehost

import android.app.ActivityManager
import android.content.Context
import android.webkit.WebView

/**
 * 随包 3D 资产的读取与校验，以及"设备能力探测 → 策略输入"的映射。
 *
 * 资产与桌面端同源：构建期从被 git 跟踪的 `apps/web/public/models/lumi/Lumi_Magical_Kitten.glb`
 * 复制到 standalone 的 assets/pet3d/models/lumi/ 下，运行期再用固定摘要校验一次；
 * 摘要不一致时不渲染这些字节（宁可回退静态 PNG）。
 */
object Pet3dAssets {
    const val MODEL_ASSET_PATH = "pet3d/models/lumi/Lumi_Magical_Kitten.glb"
    const val MODEL_DISPLAY_NAME = "露米 Lumi"
    /** 与 apps/web/src/three-d/builtin-models.ts 的 lumiModel.sha256、character_manifest.json 完全一致。 */
    const val PINNED_MODEL_SHA256 = "3ec165a265d28d00bec78c6262d4909542d9d5e8759759cc00cdb07fd7f95f90"

    sealed class ModelLoad {
        data class Verified(val bytes: ByteArray, val facts: Pet3dGlbFacts) : ModelLoad()
        object Missing : ModelLoad()
        data class DigestMismatch(val actualDigest: String) : ModelLoad()
        data class Unreadable(val detail: String) : ModelLoad()
    }

    fun loadVerified(context: Context): ModelLoad {
        val bytes = try {
            context.assets.open(MODEL_ASSET_PATH).use { it.readBytes() }
        } catch (_: Exception) {
            return ModelLoad.Missing
        }
        val digest = try {
            Pet3dGlb.digest(bytes)
        } catch (error: Exception) {
            return ModelLoad.Unreadable("digest_unavailable")
        }
        if (digest != PINNED_MODEL_SHA256) return ModelLoad.DigestMismatch(digest)
        val facts = try {
            Pet3dGlb.inspect(bytes).facts
        } catch (error: Pet3dGlbFormatException) {
            return ModelLoad.Unreadable(error.message ?: "glb_format_error")
        } catch (error: Exception) {
            return ModelLoad.Unreadable("glb_unreadable")
        }
        return ModelLoad.Verified(bytes, facts)
    }

    fun probe(context: Context, load: ModelLoad): Pet3dRenderInput {
        val manager = context.getSystemService(ActivityManager::class.java)
        val engine = webViewEngine()
        return Pet3dRenderInput(
            bundledModelPresent = load is ModelLoad.Verified || load is ModelLoad.DigestMismatch,
            modelDigestVerified = load is ModelLoad.Verified,
            webViewEngineAvailable = engine.first,
            webViewMajorVersion = engine.second,
            glesMajorVersion = glesMajorVersion(manager),
            isLowRamDevice = manager?.isLowRamDevice == true,
            totalMemoryMb = totalMemoryMb(manager),
        )
    }

    /** 未知即保守：拿不到 GLES 版本按 0 处理，拿不到内存按 0 处理，都会退到静态 PNG。 */
    fun glesMajorVersion(manager: ActivityManager?): Int {
        val version = try { manager?.deviceConfigurationInfo?.glEsVersion } catch (_: Exception) { null } ?: return 0
        return version.substringBefore('.').toIntOrNull() ?: 0
    }

    fun totalMemoryMb(manager: ActivityManager?): Int {
        if (manager == null) return 0
        return try {
            val info = ActivityManager.MemoryInfo()
            manager.getMemoryInfo(info)
            (info.totalMem / (1024L * 1024L)).toInt()
        } catch (_: Exception) {
            0
        }
    }

    /** 系统 WebView 是否可用及其主版本；取不到就是不可用，不猜测。 */
    fun webViewEngine(): Pair<Boolean, Int> {
        return try {
            val info = WebView.getCurrentWebViewPackage() ?: return false to 0
            val major = info.versionName?.substringBefore('.')?.toIntOrNull() ?: 0
            (major > 0) to major
        } catch (_: Throwable) {
            false to 0
        }
    }
}