package expo.modules.screentime

import org.junit.Assert.*
import org.junit.Test

class EnforcementPollingStateTest {
  private val game = "example.game"

  @Test fun repeatedGameWindowsCannotStarveAnInFlightThresholdCheck() {
    val polling = EnforcementPollingState()
    assertTrue(polling.moveTo(game))
    val ticket = requireNotNull(polling.begin())
    repeat(1_000) {
      assertFalse(polling.moveTo(game))
      assertNull(polling.begin())
    }
    assertTrue(polling.complete(ticket))
    assertNotNull(polling.begin())
  }

  @Test fun silentGameCrossesTheLimitWithoutPauseOrReopenEvent() {
    val polling = EnforcementPollingState()
    polling.moveTo(game)
    val events = listOf(UsageTransition(0L, game, UsageTransition.Kind.FOREGROUND))
    val selected = setOf(game)
    val blockedAt = mutableListOf<Long>()
    // The same event history is polled as the game stays open. No PAUSED event
    // or second launch is needed to count its still-running foreground tail.
    for (now in 899_000L..902_000L step 1_000L) {
      val ticket = requireNotNull(polling.begin())
      val usage = DailyUsage.calculate(events, selected, 0L, now)
      if (polling.complete(ticket) && ticket.foreground in selected && usage.millis >= 900_000L) {
        blockedAt.add(now)
      }
    }
    assertEquals(listOf(900_000L, 901_000L, 902_000L), blockedAt)
  }

  @Test fun busyGameStillAppliesTheThresholdResultBeforeItCloses() {
    val polling = EnforcementPollingState()
    polling.moveTo(game)
    val ticket = requireNotNull(polling.begin())
    val selected = setOf(game)
    val usage = DailyUsage.calculate(
      listOf(UsageTransition(0L, game, UsageTransition.Kind.FOREGROUND)), selected, 0L, 901_000L,
    )
    repeat(500) { polling.moveTo(game) }
    assertTrue(polling.complete(ticket) && ticket.foreground in selected && usage.millis >= 900_000L)
  }

  @Test fun systemControlsInvalidateOldGameResultImmediately() {
    val polling = EnforcementPollingState()
    polling.moveTo(game)
    val stale = requireNotNull(polling.begin())
    assertTrue(polling.moveTo("com.android.settings"))
    assertNull(polling.begin()) // Still only one actual query in flight.
    assertFalse(polling.complete(stale))
    val fresh = requireNotNull(polling.begin())
    assertEquals("com.android.settings", fresh.foreground)
    assertTrue(polling.complete(fresh))
  }

  @Test fun settingsAndGrantChangesInvalidateEvenIfGameDoesNotChange() {
    val polling = EnforcementPollingState()
    polling.moveTo(game)
    val stale = requireNotNull(polling.begin())
    polling.invalidate()
    assertFalse(polling.complete(stale))
    val updated = requireNotNull(polling.begin())
    assertEquals(game, updated.foreground)
    assertTrue(polling.complete(updated))
  }

  @Test fun approvedBreakExpiryBlocksTheSameGameAfterOneReconciliationRetry() {
    val polling = EnforcementPollingState()
    polling.moveTo(game)
    val receipt = Approval(
      "22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
      ScreenTimeRules.iso(0L), ScreenTimeRules.iso(900_000L), ScreenTimeRules.iso(1_000L),
    )
    val approvedBreak = ActiveApproval(receipt, 900_000L, 1)
    assertTrue(approvedBreak.active(899_000L, 899_000L, 1))
    val beforeExpiry = requireNotNull(polling.begin())
    assertFalse(approvedBreak.active(900_000L, 900_000L, 1))
    // Engine reconciliation removes the expired grant and calls refresh().
    // That policy change invalidates old work but must not cancel future ticks.
    polling.invalidate()
    assertFalse(polling.complete(beforeExpiry))
    val afterExpiry = requireNotNull(polling.begin())
    repeat(100) { polling.moveTo(game) }
    val paused = approvedBreak.active(901_000L, 901_000L, 1)
    assertTrue(polling.complete(afterExpiry) && afterExpiry.foreground == game && !paused)
  }

  @Test fun screenOffAndUnlockRejectPendingWorkThenResumePolling() {
    val polling = EnforcementPollingState()
    polling.moveTo(game)
    val locked = requireNotNull(polling.begin())
    polling.invalidate()
    polling.moveTo(null)
    assertFalse(polling.complete(locked))
    val recoveryEpoch = polling.invalidate()
    assertEquals(recoveryEpoch, polling.epoch)
    polling.moveTo(game)
    val unlocked = requireNotNull(polling.begin())
    assertTrue(polling.complete(unlocked))
  }

  @Test fun staleForegroundRecoveryCannotOverrideANewerAppSwitch() {
    val polling = EnforcementPollingState()
    polling.moveTo(game)
    val recoveryEpoch = polling.invalidate()
    polling.moveTo("com.android.settings")
    assertNotEquals(recoveryEpoch, polling.epoch)
    assertEquals("com.android.settings", polling.foreground)
  }

  @Test fun duplicateCompletionCannotClearTheNextQuery() {
    val polling = EnforcementPollingState()
    val first = requireNotNull(polling.begin())
    assertTrue(polling.complete(first))
    val second = requireNotNull(polling.begin())
    assertFalse(polling.complete(first))
    assertNull(polling.begin())
    assertTrue(polling.complete(second))
  }

  @Test fun newerActualGameResumeRecoversMissedWindowEventButOldHistoryNeverCoversSystemControls() {
    val polling = EnforcementPollingState()
    polling.moveTo("com.android.systemui")
    assertFalse(polling.canRecover(game, 1_000L, 2_000L))
    assertFalse(polling.canRecover(game, 2_000L, 2_000L))
    assertTrue(polling.canRecover(game, 3_000L, 2_000L))
    assertFalse(polling.canRecover(null, 3_000L, 2_000L))
    polling.moveTo(game)
    assertFalse(polling.canRecover(game, 3_000L, 2_000L))
  }

  @Test fun policyRefreshDoesNotResetLiveSessionButScreenOffDoes() {
    val polling = EnforcementPollingState()
    polling.moveTo(game)
    val first = requireNotNull(polling.begin())
    polling.complete(first)
    polling.invalidate()
    val refreshed = requireNotNull(polling.begin())
    assertEquals(first.foregroundSession, refreshed.foregroundSession)
    polling.complete(refreshed)
    polling.moveTo(null)
    polling.moveTo(game)
    val unlocked = requireNotNull(polling.begin())
    assertNotEquals(first.foregroundSession, unlocked.foregroundSession)
  }

  @Test fun reconnectDoesNotReuseThePriorServicesLiveUsageSession() {
    val old = EnforcementPollingState().also { it.moveTo(game) }
    val current = EnforcementPollingState().also { it.moveTo(game) }
    assertNotEquals(requireNotNull(old.begin()).foregroundSession, requireNotNull(current.begin()).foregroundSession)
  }
}
