package expo.modules.screentime

import java.time.Instant
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ApprovalStorageTest {
  private val owner = "11111111-1111-4111-8111-111111111111"
  private val start = Instant.parse("2026-09-15T12:00:00Z").toEpochMilli()
  private val receipt = Approval(
    "22222222-2222-4222-8222-222222222222", owner,
    "33333333-3333-4333-8333-333333333333",
    ScreenTimeRules.iso(start), ScreenTimeRules.iso(start + 900_000), ScreenTimeRules.iso(start + 5_000),
  )
  private fun stored(value: Approval = receipt) = ApprovalStorage.write(ActiveApproval(value, 1_000_000, 4))

  @Test fun panicRoundTripStoresExplicitNullAndKeepsDeadlineAndBoot() {
    val panic = receipt.copy(source = "panic", requestId = null)
    val json = stored(panic)
    assertEquals("panic", json.getString("source"))
    assertTrue(json.has("requestId"))
    assertTrue(json.isNull("requestId"))
    val active = ApprovalStorage.read(JSONObject(json.toString()), owner)
    assertEquals(ActiveApproval(panic, 1_000_000, 4), active)
    assertTrue(active.receipt.sameIdentity(panic.copy(serverNow = ScreenTimeRules.iso(start + 10_000))))
    assertFalse(active.active(start + 10_000, 1_000_000, 4))
    assertFalse(active.active(start + 10_000, 100_000, 5))
  }

  @Test fun requestRoundTripPreservesSourceAndRequestId() {
    val active = ApprovalStorage.read(JSONObject(stored().toString()), owner)
    assertEquals(ActiveApproval(receipt, 1_000_000, 4), active)
    assertEquals("request", active.receipt.source)
    assertEquals(receipt.requestId, active.receipt.requestId)
  }

  @Test fun legacyReceiptWithoutSourceRemainsARequest() {
    listOf(15, 30).forEach { minutes ->
      val value = receipt.copy(expiresAt = ScreenTimeRules.iso(start + minutes * 60_000))
      val json = stored(value).apply { remove("source") }
      val active = ApprovalStorage.read(JSONObject(json.toString()), owner)
      assertEquals(value, active.receipt)
      assertEquals("request", active.receipt.source)
      assertEquals("request", ApprovalStorage.write(active).getString("source"))
    }
  }

  @Test fun missingOrNullLegacyRequestIdCannotBecomeAPanicGrant() {
    listOf(stored().apply { remove("requestId") }, stored().put("requestId", JSONObject.NULL)).forEach { json ->
      json.remove("source")
      assertThrows(IllegalArgumentException::class.java) { ApprovalStorage.read(json, owner) }
    }
  }

  @Test fun invalidSourcesAndSourceRequestCombinationsAreRejectedOnRead() {
    listOf(
      stored().put("source", "unknown"), stored().put("source", ""),
      stored().put("source", JSONObject.NULL), stored().put("requestId", "1-1-1-1-1"),
      stored().put("source", "panic"), stored().put("source", "panic").put("requestId", ""),
      stored(receipt.copy(source = "panic", requestId = null, expiresAt = ScreenTimeRules.iso(start + 1_800_000))),
    ).forEach { json ->
      assertThrows(Exception::class.java) { ApprovalStorage.read(json, owner) }
    }
  }

  @Test fun persistedPanicStillRequiresItsOwnerAndValidGrantId() {
    val panic = receipt.copy(source = "panic", requestId = null)
    assertThrows(IllegalArgumentException::class.java) { ApprovalStorage.read(stored(panic), null) }
    assertThrows(IllegalArgumentException::class.java) {
      ApprovalStorage.read(stored(panic), "44444444-4444-4444-8444-444444444444")
    }
    assertThrows(IllegalArgumentException::class.java) { ApprovalStorage.read(stored(panic.copy(grantId = "invalid")), owner) }
  }
}
