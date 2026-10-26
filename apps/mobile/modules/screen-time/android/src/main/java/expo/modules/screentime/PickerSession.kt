package expo.modules.screentime

/** Short bookkeeping only: never hold this lock while calling Android services. */
internal class PickerSession<T> {
  class Ticket<T>(val value: T)
  private enum class Phase { PREPARING, SHOWN, COMPLETING }
  private var current: Ticket<T>? = null
  private var phase = Phase.PREPARING

  @Synchronized fun begin(value: T): Ticket<T>? {
    if (current != null) return null
    return Ticket(value).also { current = it; phase = Phase.PREPARING }
  }

  @Synchronized fun isCurrent(ticket: Ticket<T>) = current === ticket

  @Synchronized fun markShown(ticket: Ticket<T>): Boolean {
    if (current !== ticket || phase != Phase.PREPARING) return false
    phase = Phase.SHOWN
    return true
  }

  @Synchronized fun beginCompletion(ticket: Ticket<T>): Boolean {
    if (current !== ticket || phase != Phase.SHOWN) return false
    phase = Phase.COMPLETING
    return true
  }

  @Synchronized fun finish(ticket: Ticket<T>): Boolean {
    if (current !== ticket) return false
    current = null
    return true
  }

  @Synchronized fun interrupt(): Ticket<T>? = current.also { current = null }
}
