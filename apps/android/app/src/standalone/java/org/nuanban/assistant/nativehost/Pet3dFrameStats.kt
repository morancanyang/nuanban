package org.nuanban.assistant.nativehost

import android.util.Log

/**
 * 浮层 3D 渲染的帧统计。只做本地计数与 logcat 输出，不联网、不上报。
 *
 * 真机测量时用 `adb logcat -s NuanbanPet3d:I` 读取；本仓库**没有**设备实测数据，
 * 见 docs/implementation/android-3d-pet.md 的测量步骤与判据（deviceVerified=false）。
 */
class Pet3dFrameStats(private val mode: String) {
    private val samples = ArrayDeque<Long>(240)
    private var windowStartNanos = 0L
    private var totalFrames = 0L
    private var worstFrameMs = 0.0

    @Synchronized
    fun recordFrame(frameNanos: Long) {
        totalFrames++
        val start = windowStartNanos
        if (start == 0L) {
            windowStartNanos = frameNanos
            return
        }
        val deltaMs = (frameNanos - start) / 1_000_000.0
        if (deltaMs > worstFrameMs) worstFrameMs = deltaMs
        windowStartNanos = frameNanos
        samples.addLast(frameNanos)
        if (samples.size > 240) samples.removeFirst()
    }

    /** 约每 5 秒输出一次窗口统计：帧数、平均帧率、p95 帧间隔、最差帧间隔。 */
    @Synchronized
    fun maybeReport(nowNanos: Long, windowMs: Long = 5000L) {
        if (samples.size < 2) return
        val first = samples.first()
        if (nowNanos - first < windowMs * 1_000_000L) return
        report()
        samples.clear()
    }

    @Synchronized
    fun report() {
        if (samples.size < 2) return
        val deltas = ArrayList<Double>(samples.size - 1)
        var previous = samples.first()
        for (frame in samples.drop(1)) {
            deltas.add((frame - previous) / 1_000_000.0)
            previous = frame
        }
        val sorted = deltas.sorted()
        val spanMs = sorted.sum()
        val averageFps = if (spanMs <= 0.0) 0.0 else (deltas.size * 1000.0 / spanMs)
        val p95 = sorted[minOf(sorted.size - 1, (sorted.size * 95) / 100)]
        Log.i(TAG, "mode=$mode frames=$totalFrames windowFrames=${deltas.size} avgFps=${"%.1f".format(averageFps)} p95FrameMs=${"%.1f".format(p95)} worstFrameMs=${"%.1f".format(worstFrameMs)} deviceVerified=false")
    }

    companion object {
        const val TAG = "NuanbanPet3d"
    }
}