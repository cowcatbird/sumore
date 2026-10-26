package expo.modules.screentime

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Process
import android.provider.Settings
import android.telecom.TelecomManager
import android.view.inputmethod.InputMethodManager

internal data class AppChoice(val packageName: String, val label: String)

internal object AndroidUsage {
  fun permission(context: Context): Boolean {
    val ops = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
    return ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName) == AppOpsManager.MODE_ALLOWED
  }

  fun read(context: Context, selected: Set<String>, now: Long): UsageReading {
    check(permission(context)) { "Allow Usage Access in Android Settings." }
    val start = ScreenTimeRules.dayStart(now)
    val manager = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
    // Aggregated queryUsageStats buckets can span midnight. Events allow exact
    // clipping and reconstruct a session already active at local midnight.
    val events = manager.queryEvents(start - 86_400_000L, now)
      ?: error("Android usage history is unavailable. Unlock the phone and try again.")
    val transition = mutableListOf<UsageTransition>()
    val event = UsageEvents.Event()
    while (events.hasNextEvent()) {
      events.getNextEvent(event)
      val kind = when (event.eventType) {
        1 -> UsageTransition.Kind.FOREGROUND // ACTIVITY_RESUMED / MOVE_TO_FOREGROUND
        2 -> UsageTransition.Kind.BACKGROUND // ACTIVITY_PAUSED / MOVE_TO_BACKGROUND
        16, 17 -> UsageTransition.Kind.SCREEN_OFF // Screen noninteractive or keyguard shown
        18 -> UsageTransition.Kind.SCREEN_ON // KEYGUARD_HIDDEN, resume only after unlock
        26, 27 -> UsageTransition.Kind.SHUTDOWN // Runtime shutdown/startup clear stale foreground
        else -> null
      }
      // UsageEvents identifies activity components, not screen contents. Keep
      // that opaque identity only in memory so a late pause from activity A
      // cannot close a newer activity B in the same package.
      if (kind != null) transition.add(UsageTransition(event.timeStamp, event.packageName, kind,
        if (kind == UsageTransition.Kind.FOREGROUND || kind == UsageTransition.Kind.BACKGROUND) event.className else null))
    }
    return DailyUsage.calculate(transition, selected, start, now)
  }
}

internal object AppSafety {
  private var cachedAt = 0L
  private var cached: List<AppChoice>? = null
  private val alwaysProtected = setOf(
    "android", "com.android.systemui", "com.android.settings", "com.android.phone",
    "com.android.server.telecom", "com.android.emergency", "com.android.permissioncontroller",
    "com.google.android.permissioncontroller", "com.android.packageinstaller",
    "com.google.android.packageinstaller", "com.google.android.gms", "com.google.android.gsf",
  )

  @Synchronized fun invalidate() { cached = null }
  @Synchronized fun choices(context: Context): List<AppChoice> {
    val time = android.os.SystemClock.elapsedRealtime()
    cached?.takeIf { time - cachedAt in 0..59_999 }?.let { return it }
    val manager = context.packageManager
    val protected = alwaysProtected.toMutableSet().apply { add(context.packageName) }
    listOf(
      Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME),
      Intent(Intent.ACTION_DIAL), Intent(Settings.ACTION_SETTINGS),
    ).forEach { intent ->
      manager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY).forEach { protected.add(it.activityInfo.packageName) }
    }
    (context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager)?.defaultDialerPackage?.let(protected::add)
    // Protect every installed keyboard, not only today's default. Changing the
    // input method must never briefly make the new keyboard blockable.
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).inputMethodList
      .forEach { protected.add(it.packageName) }
    Settings.Secure.getString(context.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)
      ?.substringBefore('/')?.let(protected::add)
    return manager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
      .mapNotNull { item ->
        val application = item.activityInfo.applicationInfo
        val pkg = application.packageName
        // A conservative first beta: system apps are never obstructed, even if
        // an OEM gives its emergency/settings component an unexpected package.
        if (pkg in protected || application.flags and ApplicationInfo.FLAG_SYSTEM != 0 || !application.enabled) null
        else AppChoice(pkg, item.loadLabel(manager).toString())
      }.distinctBy { it.packageName }.sortedBy { it.label.lowercase() }.also { cached = it; cachedAt = time }
  }
}
