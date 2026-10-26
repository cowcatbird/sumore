package expo.modules.screentime

import org.junit.Assert.*
import org.junit.Test

class ForegroundUsageTrackerTest {
  private val selected = setOf("app.game", "app.video")
  private fun reading(game: Long = 0, video: Long = 0) = UsageReading(game + video, null,
    mapOf("app.game" to game, "app.video" to video))

  @Test fun delayedOemUsageStillCrossesThresholdWhileSameGameRemainsOpen() {
    val tracker = ForegroundUsageTracker()
    val raw = reading(59_000)
    tracker.merge(raw, selected, 0, "app.game", 1, 5_000)
    val next = tracker.merge(raw, selected, 0, "app.game", 1, 6_000)
    assertTrue(AppLimitPolicy.reached(next, mapOf("app.game" to 1), "app.game"))
    assertEquals(60_000L, next.perPackageMillis["app.game"])
  }
  @Test fun osCatchingUpDoesNotDoubleCountObservedUsage() {
    val tracker = ForegroundUsageTracker()
    tracker.merge(reading(50_000), selected, 0, "app.game", 1, 5_000)
    tracker.merge(reading(50_000), selected, 0, "app.game", 1, 15_000)
    assertEquals(61_000L, tracker.merge(reading(61_000), selected, 0, "app.game", 1, 16_000).millis)
  }
  @Test fun systemControlsAndScreenOffDoNotExtendPreviousGameSession() {
    val tracker = ForegroundUsageTracker()
    tracker.merge(reading(50_000), selected, 0, "app.game", 1, 0)
    tracker.merge(reading(50_000), selected, 0, "app.game", 1, 10_000)
    val settings = tracker.merge(reading(50_000), selected, 0, "com.android.settings", 2, 20_000)
    assertEquals(60_000L, settings.millis)
    assertEquals(60_000L, tracker.merge(reading(50_000), selected, 0, "app.game", 3, 100_000).millis)
    assertEquals(61_000L, tracker.merge(reading(50_000), selected, 0, "app.game", 3, 101_000).millis)
  }
  @Test fun statusQueriesNeverCountBackgroundTime() {
    val tracker = ForegroundUsageTracker()
    tracker.merge(reading(), selected, 0, "app.game", 1, 0)
    tracker.merge(reading(), selected, 0, "app.game", 1, 10_000)
    repeat(30) { assertEquals(10_000L, tracker.snapshot(reading(), selected, 0).millis) }
  }
  @Test fun disabledLimitDoesNotAccumulateTimeAcrossAResumeWithTheSameSessionId() {
    val tracker = ForegroundUsageTracker()
    tracker.merge(reading(), selected, 0, "app.game", 1, 0)
    tracker.merge(reading(), selected, 0, "app.game", 1, 10_000)
    tracker.pause()
    assertEquals(10_000L, tracker.merge(reading(), selected, 0, "app.game", 1, 90_000).millis)
    assertEquals(11_000L, tracker.merge(reading(), selected, 0, "app.game", 1, 91_000).millis)
  }
  @Test fun unrelatedAppsAndNoObservedForegroundNeverInventUsage() {
    val tracker = ForegroundUsageTracker()
    tracker.merge(reading(), selected, 0, null, 0, 0)
    assertEquals(0L, tracker.merge(reading(), selected, 0, "other.app", 1, 100_000).millis)
  }
  @Test fun midnightSelectionChangesAndAccountResetDoNotCarryFloors() {
    val tracker = ForegroundUsageTracker()
    tracker.merge(reading(), selected, 0, "app.game", 1, 0)
    tracker.merge(reading(), selected, 0, "app.game", 1, 10_000)
    assertEquals(0L, tracker.merge(reading(), selected, 1, "app.game", 1, 11_000).millis)
    tracker.merge(reading(), selected, 1, "app.game", 1, 20_000)
    tracker.clear()
    assertEquals(0L, tracker.snapshot(reading(), selected, 1).millis)
  }
}
