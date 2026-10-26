package expo.modules.screentime

/**
 * One observational usage sample, protected by the engine's monitor. Changing a
 * budget, pause timer or approval does not change historical usage. Keep that
 * sample for the command's returned status instead of scanning up to two days
 * of UsageEvents twice. Account/selection changes never reuse another sample.
 */
internal class UsageReadingCache {
  private data class Entry(val owner: String?, val selected: Set<String>, val dayStart: Long,
    val wall: Long, val elapsed: Long, val reading: UsageReading)
  private var entry: Entry? = null

  fun retainFor(owner: String?, selected: Set<String>) {
    if (entry?.let { it.owner != owner || it.selected != selected } == true) entry = null
  }

  fun read(owner: String?, selected: Set<String>, dayStart: Long, wall: Long, elapsed: Long,
    load: () -> UsageReading): UsageReading {
    entry?.takeIf { it.owner == owner && it.selected == selected && it.dayStart == dayStart &&
      wall - it.wall in 0..1_999 && elapsed - it.elapsed in 0..1_999 }?.let { return it.reading }
    // Drop an expired sample before loading so a failed load never revives it.
    entry = null
    return load().also { entry = Entry(owner, selected.toSet(), dayStart, wall, elapsed, it) }
  }
}
