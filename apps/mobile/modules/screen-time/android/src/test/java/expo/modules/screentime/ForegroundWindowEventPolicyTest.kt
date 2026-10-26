package expo.modules.screentime

import org.junit.Assert.*
import org.junit.Test

class ForegroundWindowEventPolicyTest {
  private val game = "example.game"
  private val system = "com.android.systemui"
  private fun window(polling: EnforcementPollingState, pkg: String,
    appeared: Boolean = false, disappeared: Boolean = false, title: Boolean = false): Boolean =
    ForegroundWindowEventPolicy.canMoveForeground(appeared, disappeared, title) && polling.moveTo(pkg)

  @Test fun legacyAndUnknownWindowFlagsKeepNormalSwitchHandling() {
    // Only the three known pane bits enter this policy. Unknown bits, like
    // legacy zero-bit events, leave all three false and retain normal handling.
    assertTrue(ForegroundWindowEventPolicy.canMoveForeground(false, false, false))
    val polling = EnforcementPollingState()
    assertTrue(window(polling, game))
    assertTrue(window(polling, "com.android.settings"))
    assertEquals("com.android.settings", polling.foreground)
  }

  @Test fun titlesAndRemovalAreNotEvidenceThatAnAppEnteredForeground() {
    assertFalse(ForegroundWindowEventPolicy.canMoveForeground(false, false, true))
    assertFalse(ForegroundWindowEventPolicy.canMoveForeground(false, true, false))
    assertFalse(ForegroundWindowEventPolicy.canMoveForeground(false, true, true))
  }

  @Test fun appearanceStillTakesPrecedenceIncludingCombinedReplacementEvents() {
    for (removed in listOf(false, true)) for (title in listOf(false, true)) {
      assertTrue(ForegroundWindowEventPolicy.canMoveForeground(true, removed, title))
    }
  }

  @Test fun lateSystemPaneDismissalCannotCancelTheResumedGamesThresholdCheck() {
    val polling = EnforcementPollingState()
    window(polling, system, appeared = true)
    window(polling, game)
    val ticket = requireNotNull(polling.begin())
    assertFalse(window(polling, system, disappeared = true))
    assertEquals(game, polling.foreground)
    val usage = DailyUsage.calculate(
      listOf(UsageTransition(0L, game, UsageTransition.Kind.FOREGROUND)), setOf(game), 0L, 60_000L,
    )
    assertTrue(polling.complete(ticket))
    assertTrue(AppLimitPolicy.reached(usage, mapOf(game to 1), ticket.foreground!!))
  }

  @Test fun lateKeyboardTitleEventsCannotKeepRestartingAnActiveGamesTimer() {
    val polling = EnforcementPollingState()
    window(polling, game)
    val ticket = requireNotNull(polling.begin())
    repeat(500) { assertFalse(window(polling, "example.keyboard", title = true)) }
    assertEquals(game, polling.foreground)
    assertTrue(polling.complete(ticket))
    val next = requireNotNull(polling.begin())
    assertEquals(ticket.foregroundSession, next.foregroundSession)
  }

  @Test fun actualSystemSettingsHomeAndKeyboardAppearanceStillRejectsOldGameWork() {
    for (pkg in listOf(system, "com.android.settings", "example.home", "example.keyboard")) {
      val polling = EnforcementPollingState()
      window(polling, game)
      val stale = requireNotNull(polling.begin())
      assertTrue(window(polling, pkg, appeared = true))
      assertEquals(pkg, polling.foreground)
      assertFalse(polling.complete(stale))
      assertFalse(polling.canRecover(game, 1_000L, 2_000L))
    }
  }

  @Test fun oldSelectedPaneDismissalCannotRestoreBlockingOverNewSettingsWindow() {
    val polling = EnforcementPollingState()
    window(polling, game)
    window(polling, "com.android.settings")
    val settings = requireNotNull(polling.begin())
    assertFalse(window(polling, game, disappeared = true))
    assertEquals("com.android.settings", polling.foreground)
    assertTrue(polling.complete(settings))
  }

  @Test fun dismissalAloneDoesNotAssumeTheUnderlyingAppOrOverrideProtectedUi() {
    val polling = EnforcementPollingState()
    window(polling, game)
    window(polling, system, appeared = true)
    assertFalse(window(polling, system, disappeared = true))
    assertEquals(system, polling.foreground)
    // No return event: preserve safety rather than accepting stale app history.
    assertFalse(polling.canRecover(game, 1_000L, 2_000L))
    // A real, newer resume remains eligible for the existing recovery path.
    assertTrue(polling.canRecover(game, 3_000L, 2_000L))
  }
}
