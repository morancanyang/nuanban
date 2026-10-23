package org.nuanban.assistant.nativehost

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.nuanban.assistant.MainActivity
import org.nuanban.assistant.R
import kotlin.math.abs

class PetRuntimeService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var bubble: View? = null
    private var pet3d: Pet3dOverlay? = null
    private var bubbleAnimator: ObjectAnimator? = null
    private var panel: ScrollView? = null
    private var status: TextView? = null
    private var guidance: AndroidGuidanceOverlay? = null
    private var receiverRegistered = false

    /** 状态文本 = 原有会话/权限状态 + 当前形象层级（实时 3D 或静态回退）与原因。 */
    private fun statusText(): String {
        val shape = pet3d?.statusLine() ?: Pet3dRenderPolicy.statusLine(Pet3dRenderMode.STATIC_PNG, "overlay_not_started")
        return PetRuntime.status(this) + "\n" + shape
    }
    private val guidanceMonitor = object : Runnable {
        override fun run() { refreshGuidance(); handler.postDelayed(this, 100) }
    }

    private fun refreshGuidance() {
        val current = AndroidGuidanceRuntime.display()
        try { guidance?.render(current.view, current.target, current.geometry, panel == null && PetRuntime.running) }
        catch (_: Exception) { PetRuntime.privacyPause(this, "guidance_overlay_unavailable"); stopSelf() }
    }
    private val monitor = object : Runnable {
        override fun run() {
            val channel = getSystemService(NotificationManager::class.java).getNotificationChannel(CHANNEL)
            if (!Settings.canDrawOverlays(this@PetRuntimeService) || !PetRuntime.notificationGranted(this@PetRuntimeService)
                || channel?.importance == NotificationManager.IMPORTANCE_NONE || getSystemService(KeyguardManager::class.java).isKeyguardLocked) {
                PetRuntime.privacyPause(this@PetRuntimeService, "runtime_permission_or_lock_changed")
                stopSelf()
                return
            }
            status?.text = statusText()
            handler.postDelayed(this, 1000)
        }
    }
    private val screenOff = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            PetRuntime.privacyPause(context, "screen_off")
            stopSelf()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action != ACTION_START) { stopSelf(); return START_NOT_STICKY }
        if (bubble != null) return START_NOT_STICKY
        try {
            check(Settings.canDrawOverlays(this) && PetRuntime.notificationGranted(this))
            check(!getSystemService(KeyguardManager::class.java).isKeyguardLocked)
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "微光指引独立桌宠与停止入口", NotificationManager.IMPORTANCE_LOW))
            check(manager.getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE)
            val open = PendingIntent.getActivity(this, 7310, Intent(this, PetControlActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val stop = PendingIntent.getBroadcast(this, 7311, Intent(this, PetStopReceiver::class.java).setAction(PetStopReceiver.ACTION_STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val exit = PendingIntent.getBroadcast(this, 7312, Intent(this, PetStopReceiver::class.java).setAction(PetStopReceiver.ACTION_EXIT), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val notification = Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_stat_nuanban)
                .setContentTitle("微光指引 · 独立桌宠")
                .setContentText("桌宠已驻留；点此查看观察状态与原生授权。")
                .setContentIntent(open).setOngoing(true)
                .addAction(Notification.Action.Builder(null, "停止观察/教学", stop).build())
                .addAction(Notification.Action.Builder(null, "退出桌宠", exit).build()).build()
            if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            else startForeground(NOTIFICATION_ID, notification)
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF), RECEIVER_NOT_EXPORTED)
            else registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF))
            receiverRegistered = true
            addBubble()
            guidance = AndroidGuidanceOverlay(this)
            AndroidGuidanceRuntime.setListener { handler.post { refreshGuidance(); status?.text = statusText() } }
            handler.post(guidanceMonitor)
            PetRuntime.running = true
            handler.post(monitor)
        } catch (_: Exception) {
            PetRuntime.stopWork(this, "pet_start_unavailable")
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun parameters(width: Int, height: Int, focusable: Boolean = false): WindowManager.LayoutParams {
        return WindowManager.LayoutParams(width, height, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            (if (focusable) WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL else WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE) or WindowManager.LayoutParams.FLAG_SECURE, PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.END
            x = 16
            y = 160
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        }
    }

    private fun addBubble() {
        val manager = getSystemService(WindowManager::class.java)
        val metrics = resources.displayMetrics
        val width = (88 * metrics.density).toInt()
        val height = (width * 1.4f).toInt()
        val layout = parameters(width, height)
        // 随包静态形象：低端机、渲染失败或本人关闭实时 3D 时的回退，始终是浮层的常驻子视图（3D 就绪前显示它）。
        // 这不是实时 3D 建模本身；不连接星云、不抓屏、不联网。
        val staticPet = ImageView(this).apply {
            setImageResource(R.drawable.nuanban_pet_preview)
            scaleType = ImageView.ScaleType.FIT_CENTER
            contentDescription = "微光指引独立桌宠静态回退形象"
            filterTouchesWhenObscured = true
        }
        val shape = Pet3dOverlay(this, staticPet)
        pet3d = shape
        val pet = shape.view.apply {
            filterTouchesWhenObscured = true
            isClickable = true
            contentDescription = "微光指引独立桌宠实时 3D 形象，必要时自动回退为随包静态形象；点击打开原生输入和停止面板，拖动移动位置"
            setOnClickListener { togglePanel() }
        }
        var startRawX = 0f
        var startRawY = 0f
        var startX = 0
        var startY = 0
        var dragged = false
        pet.setOnTouchListener { view, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> { startRawX = event.rawX; startRawY = event.rawY; startX = layout.x; startY = layout.y; dragged = false; true }
                MotionEvent.ACTION_MOVE -> {
                    val deltaX = event.rawX - startRawX
                    val deltaY = event.rawY - startRawY
                    if (abs(deltaX) + abs(deltaY) > 12 * metrics.density) dragged = true
                    layout.x = (startX - deltaX.toInt()).coerceIn(0, (metrics.widthPixels - layout.width).coerceAtLeast(0))
                    layout.y = (startY + deltaY.toInt()).coerceIn(0, (metrics.heightPixels - layout.height).coerceAtLeast(0))
                    try { manager.updateViewLayout(pet, layout) } catch (_: Exception) { PetRuntime.privacyPause(this, "overlay_lost"); stopSelf() }
                    true
                }
                MotionEvent.ACTION_UP -> { if (!dragged) view.performClick(); true }
                MotionEvent.ACTION_CANCEL -> true
                else -> false
            }
        }
        bubble = pet
        manager.addView(pet, layout)
        shape.start()
        if (ValueAnimator.areAnimatorsEnabled()) {
            bubbleAnimator = ObjectAnimator.ofFloat(pet, View.TRANSLATION_Y, 0f, -3 * metrics.density, 0f).apply {
                duration = 2600
                repeatCount = ObjectAnimator.INFINITE
                interpolator = AccelerateDecelerateInterpolator()
                start()
            }
        }
    }

    private fun togglePanel() {
        if (panel != null) { hidePanel(); return }
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(20, 16, 20, 16); setBackgroundColor(0xfffffbef.toInt()) }
        val state = TextView(this).apply { textSize = 15f; text = statusText() }
        status = state
        root.addView(state)
        val question = EditText(this).apply {
            hint = "输入想在当前软件中学的操作（您亲手操作）"
            isSingleLine = false
            maxLines = 3
            filters = arrayOf(android.text.InputFilter.LengthFilter(2000))
            isSaveEnabled = false
            if (Build.VERSION.SDK_INT >= 26) importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            imeOptions = android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        }
        root.addView(question)
        fun button(label: String, action: () -> Unit) {
            root.addView(Button(this).apply { text = label; filterTouchesWhenObscured = true; setOnClickListener { action() } })
        }
        button("提交问题（需本次云同意与服务连接）") {
            val accepted = AndroidGuidanceRuntime.ask(question.text.toString())
            question.text.clear()
            state.text = if (accepted) statusText() else "问题为空、过长或包含敏感内容；未提交。"
            if (accepted && PetRuntime.sessions.snapshot().observation == PetObservationPhase.OBSERVING) hidePanel()
        }
        button("我点好了（等待新画面核验）") { if (AndroidGuidanceRuntime.verify()) hidePanel() else state.text = "还没有可核验的教学步骤；不会把本次点击当作成功。" }
        button("本人开启观察 / 继续共享") { hidePanel(); startActivity(Intent(this, PetControlActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        button("停止本次教学（保留本地观察）") { AndroidGuidanceRuntime.finishTeaching(); state.text = statusText() }
        button("立即停止观察与教学") { PetRuntime.stopWork(this); state.text = statusText() }
        // 形象层级可由本人切换：仅进程内偏好，不落盘、不新增存储；关闭时立即回到随包静态形象。
        button(if (pet3d?.isRealTime3d() == true) "切换为静态形象（省电）" else "切换为实时 3D 形象") {
            state.text = pet3d?.toggleRealTime3d() ?: "实时 3D 形象不可用，继续使用随包静态形象。"
        }
        button("打开管理界面") { hidePanel(); startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        button("收起面板") { hidePanel() }
        button("退出桌宠") { PetRuntime.stopWork(this, "user_exited"); stopSelf() }
        val scroll = ScrollView(this).apply { addView(root) }
        panel = scroll
        PetRuntime.inputPanelVisible = true
        // 面板打开期间暂停浮层渲染，省电且避免遮挡期间继续绘制。
        pet3d?.pause()
        AndroidGuidanceRuntime.pauseForControls()
        refreshGuidance()
        val metrics = resources.displayMetrics
        val width = minOf((340 * metrics.density).toInt(), metrics.widthPixels - 24).coerceAtLeast(1)
        val height = (metrics.heightPixels * 0.7).toInt()
        try { getSystemService(WindowManager::class.java).addView(scroll, parameters(width, height, true)) }
        catch (_: Exception) { hidePanel(); PetRuntime.privacyPause(this, "input_overlay_unavailable"); stopSelf() }
    }

    private fun hidePanel() {
        val old = panel
        panel = null
        PetRuntime.inputPanelVisible = false
        status = null
        pet3d?.resume()
        if (old != null) {
            getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(old.windowToken, 0)
            runCatching { getSystemService(WindowManager::class.java).removeViewImmediate(old) }
        }
    }

    override fun onDestroy() {
        PetRuntime.stopWork(this, "pet_runtime_destroyed")
        PetRuntime.running = false
        handler.removeCallbacksAndMessages(null)
        bubbleAnimator?.cancel()
        bubbleAnimator = null
        hidePanel()
        // 先销毁 3D 表面（释放 GL 上下文/渲染进程），再移除浮层视图，避免残留渲染。
        runCatching { pet3d?.destroy() }
        pet3d = null
        bubble?.let { runCatching { getSystemService(WindowManager::class.java).removeViewImmediate(it) } }
        bubble = null
        AndroidGuidanceRuntime.setListener(null)
        runCatching { guidance?.clear() }
        guidance = null
        if (receiverRegistered) runCatching { unregisterReceiver(screenOff) }
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "org.nuanban.assistant.START_PET_BY_USER"
        private const val CHANNEL = "nuanban-standalone-pet"
        private const val NOTIFICATION_ID = 7310
    }
}
