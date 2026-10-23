package org.nuanban.assistant.nativehost

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

object AndroidHostRuntime {
    fun managementView(activity: Activity, content: View): View {
        val management = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        management.addView(TextView(activity).apply {
            text = "此页仅用于管理；关闭不停止桌宠。观察与教学请在原生桌宠面板/通知中停止。"
            setPadding(16, 12, 16, 8)
        })
        management.addView(Button(activity).apply {
            text = "原生桌宠控制与停止"
            filterTouchesWhenObscured = true
            setOnClickListener { activity.startActivity(Intent(activity, PetControlActivity::class.java)) }
        })
        management.addView(content, LinearLayout.LayoutParams(-1, 0, 1f))
        // C：仅独立包为共享管理页接本地听写桥；普通包没有此文件/权限，保持无麦克风能力。
        AndroidLocalDictation.attach(activity, content)
        return management
    }

    fun capabilities(context: Context): Map<String, Any?> = NativeCaptureRuntime.report(context)

    fun stopManagement(context: Context): Map<String, Any?> {
        val petSnapshot = PetRuntime.sessions.snapshot()
        if (PetManagementBoundary.protectsPetSession(petSnapshot, NativeCaptureRuntime.petOwnedCapture)) {
            return mapOf("error_code" to "bridge_error", "message" to "管理页不能停止独立桌宠观察或教学；请使用原生桌宠停止入口。")
        }
        NativeCaptureService.stopFrom(context)
        return PetManagementBoundary.stopReply(PetRuntime.sessions.snapshot(), NativeCaptureRuntime.session.snapshot())
    }
}
