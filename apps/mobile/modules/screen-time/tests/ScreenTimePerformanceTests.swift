import Foundation

// Exercises the real Foundation-only write gates used by ScreenTimeEngine.
// Counts avoided operations, not simulated or claimed iPhone wall-clock speed.
@main
struct ScreenTimePerformanceTests {
  static var checks = 0
  static let account = "11111111-1111-4111-8111-111111111111"
  static let generation = "22222222-2222-4222-8222-222222222222"
  static let app = "33333333-3333-4333-8333-333333333333"
  static let now = ScreenTimeGrant.date("2026-09-28T12:00:00Z")!

  static func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    precondition(condition(), message)
    checks += 1
  }

  struct Policy: Equatable {
    var accountId: String? = account
    var enabled = true
    var selected: Set<String> = [app]
    var daily: ScreenTimeDailyPolicy?
    var perApp: ScreenTimePerAppPolicy?
    var grant: ScreenTimeGrant?
    var usedGrants: [String: Double] = [:]
    var deadline: Date?
  }

  struct Shields: Equatable {
    var applications: Set<String>?
    var applicationCategories: Set<String>?
    var webDomains: Set<String>?
    var webDomainCategories: Set<String>?
  }

  static func apply(_ desired: Shields, live: inout Shields, writes: inout Int) {
    ScreenTimeWritePolicy.updateIfChanged(current: live.applications, desired: desired.applications) {
      live.applications = $0; writes += 1
    }
    ScreenTimeWritePolicy.updateIfChanged(current: live.applicationCategories, desired: desired.applicationCategories) {
      live.applicationCategories = $0; writes += 1
    }
    ScreenTimeWritePolicy.updateIfChanged(current: live.webDomains, desired: desired.webDomains) {
      live.webDomains = $0; writes += 1
    }
    ScreenTimeWritePolicy.updateIfChanged(current: live.webDomainCategories, desired: desired.webDomainCategories) {
      live.webDomainCategories = $0; writes += 1
    }
  }

  static func main() throws {
    var durable = Policy()
    let desired = Shields(applications: [app])
    var live = desired
    var diskWrites = 0
    var shieldWrites = 0
    for _ in 0..<30 {
      // Every poll gets fresh durable/live values; neither gate caches them.
      let original = durable
      ScreenTimeWritePolicy.commitIfChanged(original: original, updated: durable, hasDurableOriginal: true) {
        diskWrites += 1
      }
      apply(desired, live: &live, writes: &shieldWrites)
    }
    check(diskWrites == 0, "Unchanged status polling replaced durable state")
    check(shieldWrites == 0, "Unchanged status polling re-sent shields")

    // A different process can mutate Apple's settings while disk is unchanged.
    // Compare those fresh values and repair only the field that diverged.
    live.applications = nil
    apply(desired, live: &live, writes: &shieldWrites)
    check(live == desired && shieldWrites == 1, "External shield mutation was hidden by a stale cache")
    live.webDomains = ["external-domain"]
    apply(desired, live: &live, writes: &shieldWrites)
    check(live == desired && shieldWrites == 2, "Obsolete website shield was not removed")
    apply(Shields(), live: &live, writes: &shieldWrites)
    check(live == Shields() && shieldWrites == 3, "Grant/disable could not clear a current shield")

    // A default value from a missing/corrupt file is NOT a durable original.
    for _ in 0..<2 {
      ScreenTimeWritePolicy.commitIfChanged(original: durable, updated: durable, hasDurableOriginal: false) {
        diskWrites += 1
      }
    }
    check(diskWrites == 2, "Missing/recovered state skipped its initial commit")

    let today = ScreenTimeDailyPolicy.dayKey(now)
    durable.daily = ScreenTimeDailyPolicy(minutes: 15, generation: generation, day: today)
    var updated = durable
    _ = updated.daily!.receiveThreshold(activity: updated.daily!.activityName,
      event: updated.daily!.eventName, now: now)
    var order: [String] = []
    ScreenTimeWritePolicy.commitIfChanged(original: durable, updated: updated, hasDurableOriginal: true) {
      durable = updated; order.append("persist")
    }
    ScreenTimeWritePolicy.updateIfChanged(current: live.applications, desired: Set([app])) {
      live.applications = $0; order.append("shield")
    }
    order.append("acknowledge")
    check(order == ["persist", "shield", "acknowledge"], "New threshold was shielded/acknowledged before durable commit")
    check(durable.daily!.reached(now: now), "Threshold latch was lost")

    // Duplicate callback is already on disk and can safely avoid a replacement.
    updated = durable
    _ = updated.daily!.receiveThreshold(activity: updated.daily!.activityName,
      event: updated.daily!.eventName, now: now)
    ScreenTimeWritePolicy.commitIfChanged(original: durable, updated: updated, hasDurableOriginal: true) {
      preconditionFailure("Duplicate threshold performed a no-op write")
    }
    checks += 1
    updated.daily!.rollover(now: now.addingTimeInterval(86_400))
    check(updated != durable && !updated.daily!.reached(now: now.addingTimeInterval(86_400)), "Daily rollover did not invalidate equality")

    let perApp = ScreenTimePerAppPolicy(generation: generation, day: today,
      allocations: [ScreenTimeAppAllocation(id: app, minutes: 15)])
    var reached = perApp
    _ = reached.receiveThreshold(activity: reached.activityName, event: reached.eventName(app), now: now)
    check(reached != perApp, "Per-app threshold was treated as unchanged")
    var budget = perApp
    budget.allocations = [ScreenTimeAppAllocation(id: app, minutes: 30)]
    check(budget != perApp, "Per-app budget edit was treated as unchanged")

    for change: (inout Policy) -> Void in [
      { $0.accountId = nil }, { $0.enabled = false }, { $0.selected = [] },
      { $0.daily = nil }, { $0.perApp = perApp },
      { $0.deadline = now.addingTimeInterval(30) },
      { $0.usedGrants[app] = now.addingTimeInterval(900).timeIntervalSince1970 },
      { $0.grant = ScreenTimeGrant(grantId: app, requesterId: account, requestId: generation,
          startedAt: "2026-09-28T12:00:00Z", expiresAt: "2026-09-28T12:15:00Z", serverNow: "2026-09-28T12:00:01Z") }
    ] {
      updated = durable
      change(&updated)
      var commits = 0
      ScreenTimeWritePolicy.commitIfChanged(original: durable, updated: updated, hasDurableOriginal: true) { commits += 1 }
      check(commits == 1, "Changed policy was not committed")
    }

    // A real commit failure must propagate before shield removal or journal ACK.
    updated = durable
    updated.enabled = false
    order = []
    do {
      try ScreenTimeWritePolicy.commitIfChanged(original: durable, updated: updated, hasDurableOriginal: true) {
        order.append("persist-attempt")
        throw ScreenTimeFailure(message: "Injected disk failure", requiresReset: true)
      }
      order.append("shield")
      order.append("acknowledge")
      preconditionFailure("Commit failure was swallowed")
    } catch {
      check(order == ["persist-attempt"], "Failed commit still applied or acknowledged state")
    }
    print("ScreenTimePerformance: \(checks) checks passed; 30 stable polls avoid 30 file replacements and 120 shield setters (not a device timing benchmark).")
  }
}
