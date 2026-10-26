package expo.modules.screentime

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.lang.ref.WeakReference
import java.util.concurrent.Executors

/** Voluntary on-device overlay, not device administration or package suspension. */
class SumoreAccessibilityService : AccessibilityService() {
  companion object {
    private var instance: WeakReference<SumoreAccessibilityService>? = null
    @Volatile var connected = false; private set
    @Volatile var overlayVisible = false; private set
    @Volatile var failure: String? = null; private set
    fun refresh() { instance?.get()?.let { service -> service.handler.post {
      service.polling.invalidate()
      service.evaluate()
    } } }
    fun hideForFailure() { instance?.get()?.let { service -> service.handler.post { service.hideOverlay() } } }
    fun ownAppForeground() { instance?.get()?.let { service ->
      service.handler.post { service.foreground = service.packageName; service.hideOverlay(); service.evaluate() }
    } }
  }
  private val handler = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()
  private val engine by lazy { ScreenTimeEngine.get(this) }
  private val polling = EnforcementPollingState()
  private var foreground: String?
    get() = polling.foreground
    set(value) { if (polling.moveTo(value)) foregroundObservedAt = System.currentTimeMillis() }
  private var foregroundObservedAt = 0L
  private var overlay: View? = null
  private var receiverRegistered = false
  private var destroyed = false
  private var observeAppChanges = false
  private val tick = Runnable { evaluate() }
  private val environmentReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action == Intent.ACTION_SCREEN_OFF) {
        polling.invalidate()
        foreground = null
        hideOverlay()
        handler.removeCallbacks(tick)
      } else {
        polling.invalidate()
        if (foreground == null) recoverForeground() else evaluate()
      }
    }
  }

  override fun onServiceConnected() {
    super.onServiceConnected()
    instance = WeakReference(this)
    connected = true
    failure = null
    val filter = IntentFilter().apply {
      addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_USER_PRESENT)
      addAction(Intent.ACTION_TIME_CHANGED); addAction(Intent.ACTION_TIMEZONE_CHANGED)
    }
    if (Build.VERSION.SDK_INT >= 33) registerReceiver(environmentReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
    else registerReceiver(environmentReceiver, filter)
    receiverRegistered = true
    recoverForeground()
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED || !observeAppChanges) return
    // Deliberately never access event.text, source, records, windows or root nodes.
    val changes = event.contentChangeTypes
    if (!ForegroundWindowEventPolicy.canMoveForeground(
      paneAppeared = changes and AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_APPEARED != 0,
      paneDisappeared = changes and AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_DISAPPEARED != 0,
      paneTitleChanged = changes and AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_TITLE != 0,
    )) return
    val packageName = event.packageName?.toString() ?: return
    // An overlay can generate its own window event. Do not dismiss it as though
    // the underlying selected app had closed. Expo lifecycle handles real opens.
    if (packageName == this.packageName && overlay != null) return
    // Essential UI must be immediately usable while a background usage query
    // is running. Its stale result cannot re-show the previous app's overlay.
    // Games can emit repeated window events without leaving the foreground.
    // Do not postpone the timer or invalidate an in-flight check for those:
    // otherwise a busy game can keep every threshold result from applying.
    if (packageName == foreground) return
    hideOverlay()
    foreground = packageName
    evaluate()
  }

  private fun evaluate() {
    if (destroyed) return
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    if (!power.isInteractive || keyguard.isKeyguardLocked) {
      polling.invalidate()
      foreground = null
      handler.removeCallbacks(tick)
      hideOverlay()
      return
    }
    val ticket = polling.begin() ?: return
    handler.removeCallbacks(tick)
    val expectedPackage = ticket.foreground
    val observedElapsed = SystemClock.elapsedRealtime()
    // UsageEvents and package-manager reads never run on the accessibility/UI
    // thread. Only one query can be in flight, even during rapid app switching.
    worker.execute {
      val result = runCatching { engine.enforcement(expectedPackage, ticket.foregroundSession, observedElapsed) }
      handler.post {
        if (destroyed) return@post
        if (!polling.complete(ticket)) { evaluate(); return@post }
        result.fold(onSuccess = { state ->
          val justEnabled = state.enabled && !observeAppChanges
          observeAppChanges = state.enabled
          failure = null // A recovered usage query must not leave a stale failure.
          // A newer real activity resume can recover an OEM-missed package
          // event. Never override a newer system/keyboard window using stale
          // historical game usage: essential controls retain precedence.
          if (state.enabled && polling.canRecover(state.usageForeground, state.usageForegroundAt, foregroundObservedAt)) {
            foreground = state.usageForeground
            hideOverlay()
            evaluate()
            return@post
          }
          if (state.enabled && expectedPackage in state.selected && state.reached && !state.paused) showOverlay()
          else hideOverlay()
          // Recover a missing initial foreground once. A known system window
          // takes precedence over usage history, which may still name a game
          // while the notification shade or another essential control is open.
          if (justEnabled && expectedPackage == null) recoverForeground()
          else if (state.enabled) handler.postDelayed(tick, if (expectedPackage in state.selected) 1_000 else 5_000)
        }, onFailure = {
          failure = "Android app limits could not run. Open sumore to check permissions and settings."
          hideOverlay()
          // Recover automatically from temporary usage-service failures.
          handler.postDelayed(tick, 5_000)
        })
      }
    }
  }

  private fun recoverForeground() {
    if (destroyed) return
    if (foreground != null) { evaluate(); return }
    val expectedEpoch = polling.invalidate()
    worker.execute {
      val recovered = runCatching { engine.foregroundFromUsage() }.getOrNull()
      handler.post {
        if (!destroyed && polling.epoch == expectedEpoch) { foreground = recovered; evaluate() }
      }
    }
  }

  private fun showOverlay() {
    if (overlay != null) return
    val density = resources.displayMetrics.density
    fun dp(value: Int) = (value * density).toInt()
    val layout = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding(dp(28), dp(36), dp(28), dp(36))
      setBackgroundColor(Color.rgb(13, 24, 27))
      isFocusableInTouchMode = true
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
    }
    fun text(value: String, size: Float) = TextView(this).apply {
      text = value; textSize = size; gravity = Gravity.CENTER
      setTextColor(Color.rgb(243, 235, 218)); setPadding(0, dp(8), 0, dp(12))
    }
    layout.addView(text("Daily allowance used", 27f))
    layout.addView(text("This app is covered until tomorrow. Open sumore to request time from your circle.", 17f))
    layout.addView(Button(this).apply {
      text = "Open sumore"
      setOnClickListener {
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        if (launch != null) {
          try {
            startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
            this@SumoreAccessibilityService.foreground = packageName
            hideOverlay()
          } catch (_: Exception) { failure = "Could not open sumore. Use Home and open it from your launcher." }
        }
      }
    }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(56)))
    layout.addView(Button(this).apply {
      text = "Home"
      setOnClickListener {
        if (performGlobalAction(GLOBAL_ACTION_HOME)) {
          this@SumoreAccessibilityService.foreground = null
          hideOverlay()
        }
      }
    }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(56)))
    val parameters = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
      WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
      PixelFormat.OPAQUE,
    ).apply { gravity = Gravity.TOP or Gravity.START; title = "sumore daily app limit" }
    try {
      (getSystemService(Context.WINDOW_SERVICE) as WindowManager).addView(layout, parameters)
      overlay = layout
      overlayVisible = true
      failure = null
      layout.requestFocus()
    } catch (_: Exception) {
      failure = "Android could not display the app-limit screen. Check Accessibility settings."
      overlayVisible = false
    }
  }

  private fun hideOverlay() {
    overlay?.let { view -> runCatching { (getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeViewImmediate(view) } }
    overlay = null
    overlayVisible = false
  }

  override fun onInterrupt() { hideOverlay() }
  override fun onUnbind(intent: Intent?): Boolean { cleanup(); return super.onUnbind(intent) }
  override fun onDestroy() { cleanup(); super.onDestroy() }
  private fun cleanup() {
    destroyed = true
    polling.invalidate()
    handler.removeCallbacksAndMessages(null)
    hideOverlay()
    if (receiverRegistered) { unregisterReceiver(environmentReceiver); receiverRegistered = false }
    if (instance?.get() === this) { connected = false; instance = null }
    worker.shutdownNow()
  }
}
