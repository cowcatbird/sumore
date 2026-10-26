package expo.modules.screentime

import java.util.concurrent.atomic.AtomicLong

/** Main-thread state for one background enforcement query at a time. */
internal class EnforcementPollingState {
  // The engine outlives service reconnects. Session IDs must not restart at 1,
  // or a reconnected service could count the disconnected interval as usage.
  companion object { private val sessions = AtomicLong() }
  class Ticket internal constructor(val epoch: Long, val foreground: String?, val foregroundSession: Long)

  var epoch = 0L; private set
  var foreground: String? = null; private set
  private var inFlight: Ticket? = null
  private var foregroundSession = 0L

  fun moveTo(packageName: String?): Boolean {
    if (foreground == packageName) return false
    foreground = packageName
    foregroundSession = sessions.incrementAndGet()
    invalidate()
    return true
  }

  // Settings, account changes, screen-off and recovery invalidate old work.
  // A repeated event from the same game is not a settings/foreground change.
  fun invalidate(): Long = ++epoch

  fun begin(): Ticket? {
    if (inFlight != null) return null
    return Ticket(epoch, foreground, foregroundSession).also { inFlight = it }
  }

  fun complete(ticket: Ticket): Boolean {
    if (inFlight !== ticket) return false
    inFlight = null
    return ticket.epoch == epoch && ticket.foreground == foreground
  }

  fun canRecover(packageName: String?, resumedAt: Long, lastWindowAt: Long): Boolean =
    packageName != null && packageName != foreground && resumedAt > lastWindowAt
}
