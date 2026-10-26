package expo.modules.screentime

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Test

class PickerSessionTest {
  @Test fun duplicateOpenIsRejectedDuringPreparationAndSave() {
    val session = PickerSession<String>()
    val ticket = requireNotNull(session.begin("first"))
    assertNull(session.begin("duplicate during prepare"))
    assertTrue(session.markShown(ticket))
    assertTrue(session.beginCompletion(ticket))
    assertNull(session.begin("duplicate during save"))
    assertTrue(session.finish(ticket))
    assertNotNull(session.begin("new"))
  }

  @Test fun saveCancelAndBackCanStartOnlyOneCompletion() {
    val session = PickerSession<String>()
    val ticket = requireNotNull(session.begin("first"))
    assertFalse(session.beginCompletion(ticket))
    assertTrue(session.markShown(ticket))
    assertFalse(session.markShown(ticket))
    assertTrue(session.beginCompletion(ticket))
    assertFalse(session.beginCompletion(ticket))
    assertTrue(session.finish(ticket))
    assertFalse(session.finish(ticket))
  }

  @Test fun activityDestructionDuringPreparationRejectsLateDialog() {
    val session = PickerSession<String>()
    val ticket = requireNotNull(session.begin("first"))
    assertSame(ticket, session.interrupt())
    assertFalse(session.isCurrent(ticket))
    assertFalse(session.markShown(ticket))
    assertFalse(session.finish(ticket))
    assertNull(session.interrupt())
  }

  @Test fun activityDestructionDuringSaveRejectsLateResult() {
    val session = PickerSession<String>()
    val ticket = requireNotNull(session.begin("first"))
    assertTrue(session.markShown(ticket))
    assertTrue(session.beginCompletion(ticket))
    assertSame(ticket, session.interrupt())
    assertFalse(session.finish(ticket))
  }

  @Test fun oldWorkerCannotSettleOrDismissANewPicker() {
    val session = PickerSession<String>()
    val old = requireNotNull(session.begin("old"))
    session.interrupt()
    val fresh = requireNotNull(session.begin("fresh"))
    assertFalse(session.markShown(old))
    assertFalse(session.beginCompletion(old))
    assertFalse(session.finish(old))
    assertTrue(session.isCurrent(fresh))
    assertTrue(session.markShown(fresh))
    assertSame(fresh, session.interrupt())
  }

  @Test fun destructionRacingWorkerCompletionSettlesExactlyOnce() {
    val session = PickerSession<String>()
    val ticket = requireNotNull(session.begin("first"))
    val start = CountDownLatch(1)
    val done = CountDownLatch(2)
    val winners = AtomicInteger()
    val workers = Executors.newFixedThreadPool(2)
    try {
      workers.execute { start.await(); if (session.finish(ticket)) winners.incrementAndGet(); done.countDown() }
      workers.execute { start.await(); if (session.interrupt() != null) winners.incrementAndGet(); done.countDown() }
      start.countDown()
      assertTrue(done.await(2, TimeUnit.SECONDS))
      assertEquals(1, winners.get())
    } finally { workers.shutdownNow() }
  }
}
