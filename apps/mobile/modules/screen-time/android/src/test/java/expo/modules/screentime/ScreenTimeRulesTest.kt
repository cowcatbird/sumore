package expo.modules.screentime

import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test

class ScreenTimeRulesTest {
  private val owner = "11111111-1111-4111-8111-111111111111"
  private val start = Instant.parse("2026-09-15T12:00:00Z").toEpochMilli()
  private fun approval(minutes: Int = 15) = Approval(
    "22222222-2222-4222-8222-222222222222", owner,
    "33333333-3333-4333-8333-333333333333",
    ScreenTimeRules.iso(start), ScreenTimeRules.iso(start + minutes * 60_000), ScreenTimeRules.iso(start + 5_000),
  )
  private fun event(at: Long, pkg: String?, kind: UsageTransition.Kind) = UsageTransition(at, pkg, kind)
  private val fg = UsageTransition.Kind.FOREGROUND
  private val bg = UsageTransition.Kind.BACKGROUND

  @Test fun dailyMinutesAcceptCustomWholeMinutesWithinOneDay() {
    listOf(1, 14, 15, 16, 20, 60, 239, 240, 245, 1440).forEach { assertTrue(ScreenTimeRules.validMinutes(it)) }
    listOf(-5, 0, 1441, Int.MAX_VALUE).forEach { assertFalse(ScreenTimeRules.validMinutes(it)) }
  }
  @Test fun uuidRejectsJavasLenientShortNotation() {
    assertThrows(IllegalArgumentException::class.java) { ScreenTimeRules.uuid("1-1-1-1-1") }
    assertEquals(owner, ScreenTimeRules.uuid(owner.uppercase()))
  }
  @Test fun exactSupportedGrantDurations() {
    approval(15).validate(owner, start + 5_000)
    approval(30).validate(owner, start + 5_000)
    listOf(5, 10, 20, 31).forEach { minutes ->
      assertThrows(IllegalArgumentException::class.java) { approval(minutes).validate(owner, start + 5_000) }
    }
  }
  @Test fun panicGrantAcceptsNullRequestIdAndOnlyFifteenMinutes() {
    val receipt = approval().copy(requestId = null, source = "panic")
    receipt.validate(owner, start + 5_000)
    assertEquals(895_000L, receipt.remaining(start + 5_000))
    listOf(5, 10, 20, 30).forEach { minutes ->
      assertThrows(IllegalArgumentException::class.java) {
        receipt.copy(expiresAt = ScreenTimeRules.iso(start + minutes * 60_000)).validate(owner, start + 5_000)
      }
    }
  }
  @Test fun sourceMustMatchThePresenceOfAValidRequestId() {
    listOf(
      approval().copy(requestId = null), approval().copy(requestId = ""),
      approval().copy(requestId = "1-1-1-1-1"), approval().copy(source = "panic"),
      approval().copy(source = "unknown"), approval().copy(source = ""),
      approval().copy(source = "PANIC", requestId = null),
      approval().copy(source = "panic", requestId = ""),
    ).forEach { receipt ->
      assertThrows(IllegalArgumentException::class.java) { receipt.validate(owner, start + 5_000) }
    }
  }
  @Test fun panicGrantKeepsAccountAndTimingChecks() {
    val receipt = approval().copy(requestId = null, source = "panic")
    assertThrows(IllegalArgumentException::class.java) { receipt.validate(null, start + 5_000) }
    assertThrows(IllegalArgumentException::class.java) { receipt.validate("44444444-4444-4444-8444-444444444444", start + 5_000) }
    assertThrows(IllegalArgumentException::class.java) { receipt.copy(grantId = "invalid").validate(owner, start + 5_000) }
    assertThrows(IllegalArgumentException::class.java) { receipt.validate(owner, start + 900_000) }
    assertThrows(IllegalArgumentException::class.java) { receipt.validate(owner, start + 126_000) }
    assertThrows(IllegalArgumentException::class.java) { receipt.copy(serverNow = ScreenTimeRules.iso(start - 1)).validate(owner, start) }
  }
  @Test fun panicRetryIdentityIncludesSourceAndPreservesElapsedExpiryAndBoot() {
    val receipt = approval().copy(requestId = null, source = "panic")
    val active = ActiveApproval(receipt, 1_000_000, 4)
    val retry = receipt.copy(serverNow = ScreenTimeRules.iso(start + 10_000))
    retry.validate(owner, start + 10_000)
    assertTrue(receipt.sameIdentity(retry))
    assertFalse(receipt.sameIdentity(retry.copy(source = "request")))
    assertFalse(receipt.sameIdentity(retry.copy(requestId = owner)))
    assertFalse(receipt.sameIdentity(retry.copy(grantId = owner)))
    assertFalse(receipt.sameIdentity(retry.copy(startedAt = ScreenTimeRules.iso(start + 1_000))))
    assertFalse(receipt.sameIdentity(retry.copy(expiresAt = ScreenTimeRules.iso(start + 1_800_000))))
    assertTrue(active.active(start + 10_000, 110_000, 4))
    assertFalse(active.active(start + 10_000, 1_000_000, 4))
    assertFalse(active.active(start + 10_000, 110_000, 5))
    assertFalse(active.active(start + 900_000, 110_000, 4))
  }
  @Test fun foreignAccountCannotUseGrant() {
    assertThrows(IllegalArgumentException::class.java) { approval().validate("44444444-4444-4444-8444-444444444444", start + 5_000) }
    assertThrows(IllegalArgumentException::class.java) { approval().validate(null, start + 5_000) }
  }
  @Test fun malformedIdCannotUseGrant() {
    assertThrows(IllegalArgumentException::class.java) { approval().copy(grantId = "nope").validate(owner, start + 5_000) }
  }
  @Test fun expiredAndFutureServerReceiptRejected() {
    assertThrows(IllegalArgumentException::class.java) { approval().validate(owner, start + 900_000) }
    assertThrows(IllegalArgumentException::class.java) { approval().copy(serverNow = ScreenTimeRules.iso(start - 1)).validate(owner, start) }
  }
  @Test fun clockSkewRejected() {
    assertThrows(IllegalArgumentException::class.java) { approval().validate(owner, start + 126_000) }
    assertThrows(IllegalArgumentException::class.java) { approval().validate(owner, start - 116_000) }
  }
  @Test fun receiptRetryCannotChangeItsWindow() {
    val receipt = approval()
    assertTrue(receipt.sameIdentity(receipt.copy(serverNow = ScreenTimeRules.iso(start + 10_000))))
    assertFalse(receipt.sameIdentity(receipt.copy(expiresAt = ScreenTimeRules.iso(start + 1_800_000))))
    assertFalse(receipt.sameIdentity(receipt.copy(requestId = owner)))
  }
  @Test fun screenshotTimestampWithSupabaseMicrosecondsAndUtcOffsetIsAccepted() {
    val receipt = approval().copy(
      startedAt = "2026-09-17T05:36:48.116656+00:00",
      expiresAt = "2026-09-17T05:51:48.116656+00:00",
      serverNow = "2026-09-17T05:36:53.116656+00:00",
    )
    val server = Instant.parse("2026-09-17T05:36:53.116Z").toEpochMilli()
    receipt.validate(owner, server)
    assertEquals(Instant.parse("2026-09-17T05:51:48.116Z").toEpochMilli(), receipt.end)
    assertEquals(895_000L, receipt.remaining(server))
  }
  @Test fun explicitOffsetsKeepTheOriginalInstantAcrossDates() {
    val expected = Instant.parse("2026-09-17T05:51:48.116Z").toEpochMilli()
    listOf(
      "2026-09-17T05:51:48.116Z",
      "2026-09-17T05:51:48.116656+00:00",
      "2026-09-16T22:51:48.116656-07:00",
      "2026-09-17T11:21:48.116656+05:30",
      "2026-09-17T18:36:48.116656789+12:45",
    ).forEach { assertEquals(it, expected, ScreenTimeRules.approvalTime(it)) }
  }
  @Test fun timestampsSupportSecondsAndOneThroughNineFractionalDigits() {
    val seconds = Instant.parse("2026-09-17T05:51:48Z").toEpochMilli()
    assertEquals(seconds, ScreenTimeRules.approvalTime("2026-09-17T05:51:48+00:00"))
    (1..9).forEach { digits ->
      val fraction = "123456789".take(digits)
      val expectedMillis = fraction.padEnd(3, '0').take(3).toLong()
      assertEquals(seconds + expectedMillis, ScreenTimeRules.approvalTime("2026-09-17T05:51:48.$fraction+00:00"))
    }
  }
  @Test fun malformedAndAmbiguousApprovalTimesAreRejectedWithoutRawParserErrors() {
    listOf(
      "", "2026-09-17", "2026-09-17T05:51:48", "2026-09-17T05:51Z",
      "2026-09-17T05:51:48+00", "2026-09-17T05:51:48+0000",
      "2026-09-17T05:51:48+00:00:30", "2026-09-17T05:51:48+19:00",
      "2026-09-17T05:51:48+00:61", "2026-09-17T05:51:48.Z",
      "2026-09-17T05:51:48.1234567890Z", "2026-09-17T05:51:48Z trailing",
      "2026-02-29T05:51:48Z", "2026-09-31T05:51:48Z", "2026-09-17T24:00:00Z",
      "2026-09-17T05:61:48Z", "2026-09-17T05:51:60Z",
    ).forEach { value ->
      val error = assertThrows(value, IllegalArgumentException::class.java) { ScreenTimeRules.approvalTime(value) }
      assertEquals("This approval has an invalid time. Refresh and try again.", error.message)
    }
  }
  @Test fun invalidTimesInEveryGrantFieldFailValidation() {
    val receipt = approval()
    listOf(
      receipt.copy(startedAt = "invalid"), receipt.copy(expiresAt = "invalid"), receipt.copy(serverNow = "invalid"),
    ).forEach { value ->
      assertThrows(IllegalArgumentException::class.java) { value.validate(owner, start + 5_000) }
    }
  }
  @Test fun offsetReceiptRetryKeepsExpiryAndNeverRefreshesTheBreak() {
    val receipt = approval().copy(
      startedAt = "2026-09-15T05:00:00.123456-07:00",
      expiresAt = "2026-09-15T05:15:00.123456-07:00",
      serverNow = "2026-09-15T12:00:05.123456+00:00",
    )
    val phoneNow = start + 5_123
    receipt.validate(owner, phoneNow)
    val active = ActiveApproval(receipt, 1_000_000, 4)
    val retry = receipt.copy(
      startedAt = "2026-09-15T12:00:00.123456Z", expiresAt = "2026-09-15T12:15:00.123456Z",
      serverNow = "2026-09-15T12:14:59.123456+00:00",
    )
    val retryNow = start + 899_123
    retry.validate(owner, retryNow)
    assertTrue(receipt.sameIdentity(retry))
    assertEquals(1_000L, retry.remaining(retryNow))
    assertFalse(active.active(retryNow, 1_000_000, 4))
    assertFalse(active.active(start + 900_123, 100_000, 4))
    assertThrows(IllegalArgumentException::class.java) { retry.validate(owner, start + 900_123) }
  }
  @Test fun acceptedClockSkewNeverAddsTimeOrRejectsValidThirtyMinutes() {
    listOf(15, 30).forEach { minutes ->
      val receipt = approval(minutes)
      listOf(start - 1_000, start + 15_000).forEach { phoneTime ->
        receipt.validate(owner, phoneTime)
        assertTrue(receipt.remaining(phoneTime) in 1..minutes * 60_000L)
        assertTrue(receipt.remaining(phoneTime) <= receipt.end - phoneTime)
      }
    }
  }
  @Test fun monotonicExpiryWinsWhenWallClockMovesBack() {
    val active = ActiveApproval(approval(), 1_000_000, 4)
    assertTrue(active.active(start + 5_000, 100_000, 4))
    assertFalse(active.active(start + 5_000, 1_000_000, 4))
    assertFalse(active.active(start + 900_000, 100_000, 4))
    assertFalse(active.active(start - 121_000, 100_000, 4))
  }
  @Test fun rebootEndsPauseInsteadOfRestoringAnUntrustedElapsedClock() {
    assertFalse(ActiveApproval(approval(), 1_000_000, 4).active(start + 5_000, 1_000, 5))
  }
  @Test fun disableDelayCannotBeShortenedByWallClockOrReboot() {
    val window = DisableWindow(start + 30_000, 50_000, 8)
    assertFalse(window.ready(49_999, 8))
    assertTrue(window.ready(50_000, 8))
    assertFalse(window.ready(500_000, 9))
  }
  @Test fun sharedBudgetAddsAppsAndExcludesOtherApps() {
    val events = listOf(event(0, "a", fg), event(60_000, "b", fg), event(120_000, "other", fg))
    assertEquals(120_000, DailyUsage.calculate(events, setOf("a", "b"), 0, 180_000).millis)
  }
  @Test fun switchBeforeOldPauseDoesNotEraseNewApp() {
    val events = listOf(event(0, "a", fg), event(10_000, "b", fg), event(10_050, "a", bg))
    val reading = DailyUsage.calculate(events, setOf("a", "b"), 0, 20_000)
    assertEquals(20_000, reading.millis)
    assertEquals("b", reading.foregroundPackage)
  }
  @Test fun duplicateResumeNeverDoubleCounts() {
    val events = listOf(event(0, "a", fg), event(1_000, "a", fg), event(2_000, "a", fg))
    assertEquals(60_000, DailyUsage.calculate(events, setOf("a"), 0, 60_000).millis)
  }
  @Test fun oldActivityPauseDoesNotCloseAnotherActivityInSameApp() {
    val events = listOf(UsageTransition(0, "a", fg, "first"), UsageTransition(10_000, "a", fg, "second"),
      UsageTransition(10_050, "a", bg, "first"), UsageTransition(20_000, "a", bg, "second"))
    assertEquals(20_000, DailyUsage.calculate(events, setOf("a"), 0, 60_000).millis)
  }
  @Test fun screenOffAndKeyguardShownDoNotEraseResumeCandidate() {
    val events = listOf(event(0, "a", fg), event(10_000, null, UsageTransition.Kind.SCREEN_OFF),
      event(10_050, null, UsageTransition.Kind.SCREEN_OFF), event(50_000, null, UsageTransition.Kind.SCREEN_ON))
    assertEquals(20_000, DailyUsage.calculate(events, setOf("a"), 0, 60_000).millis)
  }
  @Test fun pauseEndsUsage() {
    assertEquals(10_000, DailyUsage.calculate(listOf(event(0, "a", fg), event(10_000, "a", bg)), setOf("a"), 0, 60_000).millis)
  }
  @Test fun lookbackSessionClipsAtMidnight() {
    val events = listOf(event(-20_000, "a", fg), event(10_000, "a", bg))
    assertEquals(10_000, DailyUsage.calculate(events, setOf("a"), 0, 60_000).millis)
  }
  @Test fun screenOffTimeDoesNotCountAndUnlockCanResume() {
    val events = listOf(event(0, "a", fg), event(10_000, null, UsageTransition.Kind.SCREEN_OFF),
      event(50_000, null, UsageTransition.Kind.SCREEN_ON))
    assertEquals(20_000, DailyUsage.calculate(events, setOf("a"), 0, 60_000).millis)
  }
  @Test fun shutdownDoesNotResumeOldForeground() {
    val events = listOf(event(0, "a", fg), event(10_000, null, UsageTransition.Kind.SHUTDOWN),
      event(50_000, null, UsageTransition.Kind.SCREEN_ON))
    assertEquals(10_000, DailyUsage.calculate(events, setOf("a"), 0, 60_000).millis)
  }
  @Test fun futureEventsAreIgnored() {
    assertEquals(10_000, DailyUsage.calculate(listOf(event(0, "a", fg), event(20_000, "a", bg)), setOf("a"), 0, 10_000).millis)
  }
  @Test fun noHistoryDoesNotInventUsage() {
    assertEquals(0, DailyUsage.calculate(emptyList(), setOf("a"), 0, 60_000).millis)
  }
  @Test fun midnightRespectsLocalTimezoneAndDst() {
    val la = ZoneId.of("America/Los_Angeles")
    val spring = Instant.parse("2026-03-08T12:00:00Z").toEpochMilli()
    val fall = Instant.parse("2026-11-01T12:00:00Z").toEpochMilli()
    assertEquals("2026-03-08T08:00:00Z", ScreenTimeRules.iso(ScreenTimeRules.dayStart(spring, la)))
    assertEquals("2026-11-01T07:00:00Z", ScreenTimeRules.iso(ScreenTimeRules.dayStart(fall, la)))
  }
}
