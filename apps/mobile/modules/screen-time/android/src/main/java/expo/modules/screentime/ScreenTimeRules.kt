package expo.modules.screentime

import java.time.Instant
import java.time.DateTimeException
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** Android-free policy logic, shared by the module, service and JVM tests. */
internal object ScreenTimeRules {
  const val DISABLE_DELAY_MS = 30_000L
  private const val INVALID_APPROVAL_TIME = "This approval has an invalid time. Refresh and try again."
  private val approvalTimePattern = Regex(
    "[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?([Zz]|[+-][0-9]{2}:[0-9]{2})",
  )
  fun validMinutes(minutes: Int) = minutes in 1..1440
  fun uuid(value: String): String {
    require(value.matches(Regex("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"))) { "Invalid app account or approval." }
    return UUID.fromString(value).toString()
  }
  fun dayStart(now: Long, zone: ZoneId = ZoneId.systemDefault()): Long =
    Instant.ofEpochMilli(now).atZone(zone).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli()
  fun iso(millis: Long): String = Instant.ofEpochMilli(millis).toString()
  fun approvalTime(value: String): Long {
    require(approvalTimePattern.matches(value)) { INVALID_APPROVAL_TIME }
    return try {
      // Supabase uses offsets and microseconds. Android's desugared Instant.parse
      // can reject +00:00, even though a desktop JDK accepts the same timestamp.
      // Parse its explicit offset before converting, never assume the phone's zone.
      OffsetDateTime.parse(value, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant().toEpochMilli()
    } catch (_: DateTimeException) {
      throw IllegalArgumentException(INVALID_APPROVAL_TIME)
    }
  }
  fun validGrantDuration(duration: Long) = abs(duration - 900_000L) < 1_000 || abs(duration - 1_800_000L) < 1_000
}

internal data class DisableWindow(val wallDeadline: Long, val elapsedDeadline: Long, val boot: Int) {
  fun ready(elapsed: Long, currentBoot: Int) = boot == currentBoot && elapsed >= elapsedDeadline
}

internal data class Approval(
  val grantId: String, val requesterId: String, val requestId: String?,
  val startedAt: String, val expiresAt: String, val serverNow: String,
  val source: String = "request",
) {
  val start: Long get() = ScreenTimeRules.approvalTime(startedAt)
  val end: Long get() = ScreenTimeRules.approvalTime(expiresAt)
  fun remaining(now: Long) = min(end - now, end - ScreenTimeRules.approvalTime(serverNow))
  fun validateStructure(owner: String?) {
    ScreenTimeRules.uuid(grantId)
    require(ScreenTimeRules.uuid(requesterId) == owner) { "This approval belongs to another app account." }
    when (source) {
      "request" -> ScreenTimeRules.uuid(requireNotNull(requestId) { "This approval is missing its request." })
      "panic" -> require(requestId == null) { "A panic break cannot belong to a request." }
      else -> throw IllegalArgumentException("This approval has an invalid source.")
    }
    val duration = end - start
    require(ScreenTimeRules.validGrantDuration(duration) &&
      (source != "panic" || abs(duration - 900_000L) < 1_000)) {
      "This approval expired or cannot be timed safely. Enable automatic Date & Time and refresh."
    }
  }
  fun validate(owner: String?, now: Long) {
    validateStructure(owner)
    val server = ScreenTimeRules.approvalTime(serverNow)
    require(server >= start && server < end && end > now && abs(server - now) <= 120_000) {
      "This approval expired or cannot be timed safely. Enable automatic Date & Time and refresh."
    }
  }
  fun sameIdentity(other: Approval) = source == other.source && grantId.equals(other.grantId, true) &&
    requestId.equals(other.requestId, true) && requesterId.equals(other.requesterId, true) &&
    start == other.start && end == other.end
}

internal data class ActiveApproval(val receipt: Approval, val elapsedEnd: Long, val boot: Int) {
  fun active(now: Long, elapsed: Long, currentBoot: Int): Boolean =
    now >= receipt.start - 120_000 && now < receipt.end && boot == currentBoot && elapsed < elapsedEnd
}

/** Package transitions only. No window text, nodes, activity content or input. */
internal data class UsageTransition(val at: Long, val packageName: String?, val kind: Kind, val activityKey: String? = null) {
  enum class Kind { FOREGROUND, BACKGROUND, SCREEN_OFF, SCREEN_ON, SHUTDOWN }
}

internal data class UsageReading(
  val millis: Long, val foregroundPackage: String?,
  val perPackageMillis: Map<String, Long> = emptyMap(),
  val foregroundChangedAt: Long = 0L,
)

/** Kept entirely on device. An exhausted app never consumes another app's allocation. */
internal object AppLimitPolicy {
  fun validate(selected: Set<String>, limits: Map<String, Int>) {
    require(selected.isNotEmpty() && selected.size <= 50 && limits.keys == selected &&
      limits.values.all(ScreenTimeRules::validMinutes)) { "Set 1 to 1440 whole minutes for each selected app." }
  }
  fun total(limits: Map<String, Int>): Int = limits.values.sum()
  fun consumed(reading: UsageReading, limits: Map<String, Int>): Long = limits.entries.sumOf { (pkg, minutes) ->
    (reading.perPackageMillis[pkg] ?: 0L).coerceIn(0L, minutes * 60_000L)
  }
  fun reached(reading: UsageReading, limits: Map<String, Int>, pkg: String): Boolean =
    limits[pkg]?.let { (reading.perPackageMillis[pkg] ?: 0L) >= it * 60_000L } ?: false
}

internal object DailyUsage {
  // One focused foreground timeline, so split-screen changes cannot double-count
  // a minute against the shared allowance. Query lookback reconstructs midnight.
  fun calculate(events: List<UsageTransition>, selected: Set<String>, dayStart: Long, now: Long): UsageReading {
    var foreground: String? = null
    var focusedActivity: String? = null
    var beforeScreenOff: String? = null
    var beforeScreenOffActivity: String? = null
    var previous = dayStart
    var total = 0L
    var foregroundChangedAt = 0L
    val perPackage = mutableMapOf<String, Long>()
    fun count(until: Long) {
      foreground?.takeIf { it in selected }?.let { pkg ->
        val duration = max(0L, until - previous)
        total += duration
        perPackage[pkg] = (perPackage[pkg] ?: 0L) + duration
      }
    }
    for (event in events.sortedBy { it.at }) {
      if (event.at > now) break
      val at = max(dayStart, event.at)
      count(at)
      previous = max(previous, at)
      when (event.kind) {
        UsageTransition.Kind.FOREGROUND -> {
          foreground = event.packageName; focusedActivity = event.activityKey
          foregroundChangedAt = event.at
          beforeScreenOff = null; beforeScreenOffActivity = null
        }
        UsageTransition.Kind.BACKGROUND -> if (foreground == event.packageName &&
          (focusedActivity == null || event.activityKey == null || focusedActivity == event.activityKey)) {
          foreground = null; focusedActivity = null
        }
        UsageTransition.Kind.SCREEN_OFF -> if (foreground != null) {
          beforeScreenOff = foreground; beforeScreenOffActivity = focusedActivity
          foreground = null; focusedActivity = null
        }
        UsageTransition.Kind.SCREEN_ON -> if (beforeScreenOff != null) {
          foreground = beforeScreenOff; focusedActivity = beforeScreenOffActivity
          beforeScreenOff = null; beforeScreenOffActivity = null
        }
        UsageTransition.Kind.SHUTDOWN -> {
          foreground = null; focusedActivity = null; beforeScreenOff = null; beforeScreenOffActivity = null
        }
      }
    }
    count(now)
    return UsageReading(min(max(total, 0L), max(0L, now - dayStart)), foreground, perPackage, foregroundChangedAt)
  }
}
