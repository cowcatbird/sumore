package expo.modules.screentime

/**
 * Some OEMs publish UsageEvents late, especially full-screen games. While the
 * accessibility service has positively observed the same foreground session,
 * elapsed time advances a conservative local floor instead of waiting for the
 * game to PAUSE. The OS total is merged with max, never added a second time.
 * No background, lock-screen or previous session interval is extrapolated.
 */
internal class ForegroundUsageTracker {
  private var day: Long? = null
  private var selection = emptySet<String>()
  private val floors = mutableMapOf<String, Long>()
  private var session: Long? = null
  private var packageName: String? = null
  private var baseline = 0L
  private var started = 0L

  fun clear() { day = null; selection = emptySet(); floors.clear(); session = null; packageName = null }
  fun pause() { session = null; packageName = null }

  fun merge(reading: UsageReading, selected: Set<String>, dayStart: Long,
    foreground: String?, foregroundSession: Long?, elapsed: Long): UsageReading {
    if (day != dayStart || selection != selected) {
      clear(); day = dayStart; selection = selected.toSet()
    }
    val active = foreground?.takeIf { it in selected && foregroundSession != null }
    val usage = selected.associateWith { maxOf(reading.perPackageMillis[it] ?: 0L, floors[it] ?: 0L) }.toMutableMap()
    if (active != packageName || foregroundSession != session) {
      // Do not extend the prior app up to this query: a screen-off/switch may
      // have happened earlier, without a usage query while the screen was off.
      packageName = active; session = foregroundSession
      baseline = usage[active] ?: 0L; started = elapsed
    }
    if (active != null) {
      val current = maxOf(usage[active] ?: 0L, baseline + (elapsed - started).coerceAtLeast(0L))
      usage[active] = current
      floors[active] = current
    }
    return reading.copy(millis = usage.values.sum(), perPackageMillis = usage)
  }

  // Status/grant queries may use the last proven floor, but cannot extend it:
  // only the service knows whether a selected app is still visible/unlocked.
  fun snapshot(reading: UsageReading, selected: Set<String>, dayStart: Long): UsageReading {
    if (day != dayStart || selection != selected) return reading
    val usage = selected.associateWith { maxOf(reading.perPackageMillis[it] ?: 0L, floors[it] ?: 0L) }
    return reading.copy(millis = usage.values.sum(), perPackageMillis = usage)
  }
}
