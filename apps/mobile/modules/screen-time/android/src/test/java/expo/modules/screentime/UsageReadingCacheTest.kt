package expo.modules.screentime

import org.junit.Assert.*
import org.junit.Test

class UsageReadingCacheTest {
  private val apps = setOf("app.game")
  private val sample = UsageReading(120_000, "app.game", mapOf("app.game" to 120_000))

  @Test fun configureAndReturnedStatusScanUsageOnlyOnce() {
    val cache = UsageReadingCache()
    var reads = 0
    fun read(wall: Long, elapsed: Long) = cache.read("owner", apps, 0, wall, elapsed) { reads++; sample }
    assertSame(sample, read(1_000, 50_000)) // Preflight before Save & enable.
    cache.retainFor("owner", apps) // Persist the new budget, not a new selection.
    assertSame(sample, read(1_020, 50_020)) // Returned status.
    assertEquals(1, reads) // Previously the write forced a second full scan.
    cache.retainFor("owner", apps) // Cooldown/grant receipt writes are policy too.
    assertSame(sample, read(1_100, 50_100))
    assertEquals(1, reads)
  }

  @Test fun fullScanCadenceStillExpiresAtTwoSecondsDespitePolicyWrites() {
    val cache = UsageReadingCache()
    var reads = 0
    for (delta in 0L..5_000L step 1_000L) {
      cache.read("owner", apps, 0, 10_000 + delta, 100_000 + delta) { reads++; sample }
      cache.retainFor("owner", apps)
    }
    assertEquals(3, reads) // t=0, 2s, 4s. Writes do not extend the deadline.
  }

  @Test fun changingAccountOrSelectionCannotReusePrivateUsage() {
    val cache = UsageReadingCache()
    var reads = 0
    fun read(owner: String?, selected: Set<String>) = cache.read(owner, selected, 0, 1_000, 50_000) { reads++; sample }
    read("first", apps)
    cache.retainFor("second", apps); read("second", apps)
    cache.retainFor("first", apps); read("first", apps)
    cache.retainFor("first", setOf("app.reader")); read("first", setOf("app.reader"))
    cache.retainFor(null, emptySet()); read(null, emptySet())
    assertEquals(5, reads)
  }

  @Test fun readItselfChecksOwnerSelectionAndDayEvenWithoutAnExplicitInvalidation() {
    val cache = UsageReadingCache()
    var reads = 0
    fun read(owner: String, selected: Set<String>, day: Long) = cache.read(owner, selected, day, 1_000, 50_000) { reads++; sample }
    read("first", apps, 0)
    read("second", apps, 0)
    read("second", emptySet(), 0)
    read("second", emptySet(), 500)
    assertEquals(4, reads)
  }

  @Test fun wallClockChangesAndMonotonicExpiryCannotKeepAStaleReadingAlive() {
    for ((wall, elapsed) in listOf(999L to 50_001L, 1_001L to 49_999L,
      1_001L to 52_000L, 3_000L to 50_001L)) {
      val cache = UsageReadingCache()
      var reads = 0
      cache.read("owner", apps, 0, 1_000, 50_000) { reads++; sample }
      cache.read("owner", apps, 0, wall, elapsed) { reads++; sample }
      assertEquals(2, reads)
    }
  }

  @Test fun slowQueriesDoNotGetAFreshTtlStartingAtCompletion() {
    val cache = UsageReadingCache()
    var reads = 0
    cache.read("owner", apps, 0, 1_000, 50_000) { reads++; sample }
    cache.read("owner", apps, 0, 4_000, 53_000) { reads++; sample }
    assertEquals(2, reads)
  }

  @Test fun failedRefreshNeverFallsBackToAnExpiredSample() {
    val cache = UsageReadingCache()
    cache.read("owner", apps, 0, 1_000, 50_000) { sample }
    try {
      cache.read("owner", apps, 0, 3_000, 52_000) { error("Usage Access revoked") }
      fail("A failed usage query must propagate")
    } catch (_: IllegalStateException) { }
    var reads = 0
    cache.read("owner", apps, 0, 3_001, 52_001) { reads++; sample }
    assertEquals(1, reads)
  }

  @Test fun cachedOsReadingStillMergesWithLiveForegroundUsageAtEveryPoll() {
    val cache = UsageReadingCache()
    val live = ForegroundUsageTracker()
    var reads = 0
    val almostReached = sample.copy(millis = 119_500, perPackageMillis = mapOf("app.game" to 119_500))
    val first = cache.read("owner", apps, 0, 1_000, 50_000) { reads++; almostReached }
    val initial = live.merge(first, apps, 0, "app.game", 1, 50_000)
    assertFalse(AppLimitPolicy.reached(initial, mapOf("app.game" to 2), "app.game"))
    cache.retainFor("owner", apps)
    val next = cache.read("owner", apps, 0, 2_000, 51_000) { reads++; almostReached }
    val advanced = live.merge(next, apps, 0, "app.game", 1, 51_000)
    assertEquals(1, reads)
    assertEquals(initial.millis + 1_000, advanced.millis)
    assertTrue(AppLimitPolicy.reached(advanced, mapOf("app.game" to 2), "app.game"))
  }
}
