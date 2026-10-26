package expo.modules.screentime

import org.junit.Assert.*
import org.junit.Test

class AppLimitPolicyTest {
  private val selected = setOf("app.game", "app.video")
  private val limits = mapOf("app.game" to 1, "app.video" to 3)
  @Test fun eachSelectedAppNeedsAnExactValidWholeMinuteAllocation() {
    AppLimitPolicy.validate(selected, limits)
    AppLimitPolicy.validate(selected, mapOf("app.game" to 1440, "app.video" to 17))
    listOf(emptyMap(), mapOf("app.game" to 1), limits + ("unselected.app" to 1),
      limits + ("app.video" to 0), limits + ("app.video" to 1441)).forEach {
      assertThrows(IllegalArgumentException::class.java) { AppLimitPolicy.validate(selected, it) }
    }
    assertThrows(IllegalArgumentException::class.java) { AppLimitPolicy.validate(emptySet(), emptyMap()) }
  }
  @Test fun exhaustedGameDoesNotBlockOtherAppAndNeverConsumesItsRemainingBudget() {
    val reading = UsageReading(700_000L, "app.game", mapOf("app.game" to 660_000L, "app.video" to 40_000L))
    assertTrue(AppLimitPolicy.reached(reading, limits, "app.game"))
    assertFalse(AppLimitPolicy.reached(reading, limits, "app.video"))
    assertFalse(AppLimitPolicy.reached(reading, limits, "unselected.app"))
    assertEquals(4, AppLimitPolicy.total(limits))
    assertEquals(100_000L, AppLimitPolicy.consumed(reading, limits))
  }
  @Test fun allAppsExhaustedConsumesExactlyAllocatedTotal() {
    val reading = UsageReading(900_000L, "app.video", mapOf("app.game" to 400_000L, "app.video" to 500_000L))
    assertEquals(240_000L, AppLimitPolicy.consumed(reading, limits))
  }
  @Test fun uninterruptedForegroundTailCountsForItsOwnAppWithoutPauseOrReopen() {
    val history = listOf(UsageTransition(0, "app.game", UsageTransition.Kind.FOREGROUND))
    val before = DailyUsage.calculate(history, selected, 0, 59_999)
    val at = DailyUsage.calculate(history, selected, 0, 60_000)
    assertFalse(AppLimitPolicy.reached(before, limits, "app.game"))
    assertTrue(AppLimitPolicy.reached(at, limits, "app.game"))
    assertFalse(AppLimitPolicy.reached(at, limits, "app.video"))
    assertEquals(60_000L, at.perPackageMillis["app.game"])
  }
  @Test fun switchAndDelayedActivityPauseKeepIndependentTotals() {
    val events = listOf(UsageTransition(0, "app.game", UsageTransition.Kind.FOREGROUND),
      UsageTransition(60_000, "app.video", UsageTransition.Kind.FOREGROUND),
      UsageTransition(60_050, "app.game", UsageTransition.Kind.BACKGROUND))
    val reading = DailyUsage.calculate(events, selected, 0, 180_000)
    assertEquals(mapOf("app.game" to 60_000L, "app.video" to 120_000L), reading.perPackageMillis)
    assertEquals(60_000L, reading.foregroundChangedAt)
  }
  @Test fun missingUsageIsZeroNotAReachedLimit() {
    val empty = DailyUsage.calculate(emptyList(), selected, 0, 60_000)
    assertEquals(0L, AppLimitPolicy.consumed(empty, limits))
    assertFalse(AppLimitPolicy.reached(empty, limits, "app.game"))
  }
}
