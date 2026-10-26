import Foundation

@main
struct ScreenTimeGrantTests {
  static let account = "11111111-1111-4111-8111-111111111111"
  static let other = "22222222-2222-4222-8222-222222222222"
  static let start = ScreenTimeGrant.date("2026-09-14T12:00:00.250Z")!
  static var checks = 0

  static func receipt(minutes: Int = 15, serverOffset: Double = 1, grantId: String = "33333333-3333-4333-8333-333333333333",
                      requestId: String? = other, source: String = "request") -> ScreenTimeGrant {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return ScreenTimeGrant(grantId: grantId, requesterId: account, requestId: requestId,
      startedAt: formatter.string(from: start),
      expiresAt: formatter.string(from: start.addingTimeInterval(Double(minutes * 60))),
      serverNow: formatter.string(from: start.addingTimeInterval(serverOffset)), source: source)
  }

  static func check(_ value: @autoclosure () -> Bool, _ message: String) {
    precondition(value(), message)
    checks += 1
  }

  static func rejected(_ grant: ScreenTimeGrant, accountId: String? = account, now: Date = start.addingTimeInterval(1)) {
    do { _ = try grant.validate(accountId: accountId, now: now); preconditionFailure("Invalid receipt was accepted") }
    catch { checks += 1 }
  }

  static func main() throws {
    for minutes in [15, 30] {
      let grant = receipt(minutes: minutes)
      let dates = try grant.validate(accountId: account, now: start.addingTimeInterval(1))
      check(dates.end.timeIntervalSince(dates.start) == Double(minutes * 60), "Original expiry changed")
      let interval = ScreenTimeGrant.monitorInterval(start: dates.start, end: dates.end)
      var calendar = Calendar(identifier: .gregorian)
      calendar.timeZone = TimeZone(secondsFromGMT: 0)!
      let scheduleStart = calendar.date(from: interval.start)!
      let scheduleEnd = calendar.date(from: interval.end)!
      check(scheduleEnd.timeIntervalSince(scheduleStart) >= 960, "DeviceActivity minimum interval violated")
      check(scheduleEnd >= dates.end && scheduleEnd.timeIntervalSince(dates.end) < 1, "Early expiry callback or extended pause")
      check(interval.end.timeZone?.secondsFromGMT() == 0, "Schedule must carry an absolute timezone")
      let retry = try receipt(minutes: minutes, serverOffset: Double(minutes * 60) - 1).validate(accountId: account, now: dates.end.addingTimeInterval(-1))
      check(retry.end == dates.end, "Late retry extended expiry")
    }
    rejected(receipt(minutes: 5))
    rejected(receipt(minutes: 10))
    rejected(receipt(minutes: 60))
    rejected(receipt(), accountId: other)
    rejected(receipt(), accountId: nil)
    rejected(receipt(grantId: "not-a-uuid"))
    rejected(receipt(serverOffset: -1))
    rejected(receipt(serverOffset: 901))
    rejected(receipt(), now: start.addingTimeInterval(901))
    rejected(receipt(), now: start.addingTimeInterval(-121))
    check(ScreenTimeGrant.date("2026-09-14T12:00:00Z") != nil, "Whole-second ISO timestamps unsupported")
    check(ScreenTimeGrant.date("garbage") == nil, "Invalid date accepted")
    check(!ScreenTimeFailure(message: "Lock busy").requiresReset, "Transient lock failure must not request destructive reset")
    check(ScreenTimeFailure(message: "Corrupt settings", requiresReset: true).requiresReset, "Corrupt storage must offer explicit recovery")
    try grantSourceTests()
    try dailyPolicyTests()
    try perAppPolicyTests()
    monitorCleanupTests()
    workerQueueTests()
    try authorizationPolicyTests()
    print("ScreenTimeGrant: \(checks) checks passed")
  }

  static func grantSourceTests() throws {
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()
    let request = receipt()
    let panic = receipt(requestId: nil, source: "panic")
    for minutes in [15] {
      let grant = receipt(minutes: minutes, requestId: nil, source: "panic")
      let dates = try grant.validate(accountId: account, now: start.addingTimeInterval(1))
      check(dates.end.timeIntervalSince(dates.start) == Double(minutes * 60), "Panic expiry changed")
      let encoded = try encoder.encode(grant)
      let fields = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
      check(fields["requestId"] is NSNull && fields["source"] as? String == "panic", "Panic storage lost null request/source")
      let restored = try decoder.decode(ScreenTimeGrant.self, from: encoded)
      check(restored == grant, "Panic receipt did not survive storage round-trip")
      _ = try restored.validate(accountId: account, now: start.addingTimeInterval(1))
      checks += 1
      let retry = receipt(minutes: minutes, serverOffset: Double(minutes * 60) - 1, requestId: nil, source: "panic")
      check(restored.hasSameIdentity(as: retry), "Panic retry with fresh serverNow changed identity")
      let retryDates = try retry.validate(accountId: account, now: dates.end.addingTimeInterval(-1))
      check(retryDates.end == dates.end, "Panic retry extended expiry")
    }
    check(!panic.hasSameIdentity(as: request), "Same grant ID crossed panic/request identity")
    check(!panic.hasSameIdentity(as: receipt(minutes: 30, requestId: nil, source: "panic")), "Changed expiry passed panic replay identity")
    check(!panic.hasSameIdentity(as: receipt(requestId: nil, source: "request")), "Changed source passed replay identity")
    check(request.hasSameIdentity(as: receipt(serverOffset: 2)), "Request retry with fresh serverNow changed identity")
    rejected(panic, accountId: other)
    rejected(panic, accountId: nil)
    rejected(panic, now: start.addingTimeInterval(901))
    rejected(panic, now: start.addingTimeInterval(-121))
    rejected(receipt(minutes: 5, requestId: nil, source: "panic"))
    rejected(receipt(minutes: 30, requestId: nil, source: "panic"))
    check(!panic.permitsDuration(1800), "Saved panic monitor accepted a 30-minute duration")
    check(request.permitsDuration(1800), "Saved request monitor lost 30-minute support")
    rejected(receipt(serverOffset: -1, requestId: nil, source: "panic"))
    rejected(receipt(serverOffset: 901, requestId: nil, source: "panic"))
    rejected(receipt(grantId: "not-a-uuid", requestId: nil, source: "panic"))
    rejected(receipt(requestId: nil))
    rejected(receipt(requestId: "not-a-uuid"))
    rejected(receipt(requestId: ""))
    rejected(receipt(source: "panic"))
    rejected(receipt(requestId: "", source: "panic"))
    for source in ["", "Panic", " panic", "future", "null"] {
      rejected(receipt(requestId: nil, source: source))
      rejected(receipt(source: source))
    }

    var legacy = try JSONSerialization.jsonObject(with: encoder.encode(request)) as! [String: Any]
    legacy.removeValue(forKey: "source")
    let restoredLegacy = try decoder.decode(ScreenTimeGrant.self, from: JSONSerialization.data(withJSONObject: legacy))
    check(restoredLegacy == request && restoredLegacy.source == "request", "Legacy v1 receipt changed identity")
    _ = try restoredLegacy.validate(accountId: account, now: start.addingTimeInterval(1))
    checks += 1
    let restoredAgain = try decoder.decode(ScreenTimeGrant.self, from: encoder.encode(restoredLegacy))
    check(restoredAgain == request, "Migrated request receipt did not survive storage round-trip")

    func rejectStored(_ fields: [String: Any]) throws {
      let data = try JSONSerialization.data(withJSONObject: fields)
      do { _ = try decoder.decode(ScreenTimeGrant.self, from: data); preconditionFailure("Malformed saved grant decoded") }
      catch { checks += 1 }
    }
    var fields = legacy
    for requestId in [NSNull(), "", "not-a-uuid", 7] as [Any] {
      fields["requestId"] = requestId
      try rejectStored(fields)
    }
    fields.removeValue(forKey: "requestId")
    try rejectStored(fields)
    for source in [NSNull(), "", "future", "Panic", 7, ["panic"]] as [Any] {
      fields = legacy
      fields["source"] = source
      try rejectStored(fields)
    }
    fields = legacy
    fields["source"] = "request"
    fields["requestId"] = NSNull()
    try rejectStored(fields)
    fields.removeValue(forKey: "requestId")
    try rejectStored(fields)
    fields = legacy
    fields["source"] = "panic"
    try rejectStored(fields)
    fields["requestId"] = ""
    try rejectStored(fields)
    fields["requestId"] = 7
    try rejectStored(fields)
    fields["requestId"] = NSNull()
    let decodedNull = try decoder.decode(ScreenTimeGrant.self, from: JSONSerialization.data(withJSONObject: fields))
    check(decodedNull == panic, "Explicit JSON null panic receipt was rejected or changed")
    fields.removeValue(forKey: "requestId")
    let decodedAbsent = try decoder.decode(ScreenTimeGrant.self, from: JSONSerialization.data(withJSONObject: fields))
    check(decodedAbsent == panic, "Panic without a request ID was rejected or changed")
  }

  static func authorizationPolicyTests() throws {
    // Apple's published property starts unknown on every launch, including
    // the separate monitor process. Repeated polls must not erase a saved
    // picker result or release a working shield before access is determined.
    let unknown = ScreenTimeAuthorization.notDetermined
    check(!unknown.permitsNewRestrictions, "Unknown status claimed authorization")
    for _ in 0..<20 {
      check(!unknown.shouldResetSelection(extensionProcess: false), "Startup poll erased saved selection")
      check(!unknown.canReconcile(extensionProcess: false), "Startup poll modified a saved policy or registered new monitors")
      check(unknown.shouldPreserveShields(extensionProcess: false, enabled: true), "Startup poll lifted existing shields")
    }
    check(!unknown.shouldPreserveShields(extensionProcess: false, enabled: false), "Explicit sign-out/disable left shields enabled")
    check(!unknown.shouldResetSelection(extensionProcess: true), "Extension startup erased app selection")
    check(unknown.canReconcile(extensionProcess: true), "Extension could not apply saved daily threshold/expiry policy")
    check(!unknown.shouldPreserveShields(extensionProcess: true, enabled: true), "Extension could not update expired-break shields")

    let approved = ScreenTimeAuthorization.approved
    check(approved.permitsNewRestrictions, "Approved app cannot choose apps")
    check(!approved.shouldResetSelection(extensionProcess: false), "Approved refresh erased selection")
    check(approved.canReconcile(extensionProcess: false), "Approved refresh cannot reconcile monitors")
    check(!approved.shouldPreserveShields(extensionProcess: false, enabled: true), "Approved refresh cannot apply shields")

    let denied = ScreenTimeAuthorization.denied
    check(!denied.permitsNewRestrictions, "Denied access allowed a new restriction/grant")
    check(denied.shouldResetSelection(extensionProcess: false), "Confirmed revocation retained invalid tokens")
    check(!denied.canReconcile(extensionProcess: false), "Denied access registered monitors")
    check(!denied.shouldPreserveShields(extensionProcess: false, enabled: true), "Confirmed revocation retained shields")
    check(!denied.shouldResetSelection(extensionProcess: true), "Extension-local status erased the app's durable policy")

    // The existing extension daily policy must still shield at threshold and
    // re-shield at a saved break's expiry without requesting authorization.
    var daily = ScreenTimeDailyPolicy(minutes: 15, generation: other,
      day: ScreenTimeDailyPolicy.dayKey(start))
    check(daily.receiveThreshold(activity: daily.activityName, event: daily.eventName, now: start), "Current extension threshold rejected")
    check(unknown.canReconcile(extensionProcess: true) && ScreenTimeDailyPolicy.shouldShield(
      enabled: true, selected: true, daily: daily, activeGrant: false, now: start), "Fresh extension failed to shield a reached daily limit")
    check(!ScreenTimeDailyPolicy.shouldShield(enabled: true, selected: true, daily: daily, activeGrant: true, now: start), "Extension interrupted a saved active break")
    check(unknown.canReconcile(extensionProcess: true) && ScreenTimeDailyPolicy.shouldShield(
      enabled: true, selected: true, daily: daily, activeGrant: false, now: start.addingTimeInterval(901)), "Fresh extension failed to re-shield an expired break")

    // Foundation fixture for the durable fields guarded by the production
    // authorization policy. Source regressions additionally verify that the
    // native token reset and all time/monitor reconciliation use these gates.
    struct SavedSelection: Codable {
      var accountId: String
      var enabled: Bool
      var opaqueSelections: [String]
      var daily: ScreenTimeDailyPolicy?
      var grant: ScreenTimeGrant?
      var settingsChangeAllowedAt: Date?

      mutating func receive(_ authorization: ScreenTimeAuthorization, extensionProcess: Bool) {
        if authorization.shouldResetSelection(extensionProcess: extensionProcess) {
          enabled = false
          opaqueSelections = []
          daily = nil
          grant = nil
          settingsChangeAllowedAt = nil
        }
      }
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    var saved = SavedSelection(accountId: account, enabled: true,
      opaqueSelections: ["opaque-app-token", "opaque-category-token", "opaque-domain-token"],
      daily: daily, grant: receipt(), settingsChangeAllowedAt: start.addingTimeInterval(30))
    let original = try encoder.encode(saved)
    for _ in 0..<20 {
      saved.receive(unknown, extensionProcess: false)
      saved = try JSONDecoder().decode(SavedSelection.self, from: encoder.encode(saved))
      saved.receive(unknown, extensionProcess: true)
      let refreshed = try encoder.encode(saved)
      check(refreshed == original, "Restart/extension poll changed saved tokens, daily generation, grant or cooldown")
    }
    saved.receive(denied, extensionProcess: false)
    check(saved.opaqueSelections.isEmpty && !saved.enabled, "Confirmed denial failed to clear invalid saved tokens")
    check(saved.daily == nil && saved.grant == nil && saved.settingsChangeAllowedAt == nil, "Confirmed denial retained invalid policy state")
    check(saved.accountId == account, "Revoking Screen Time changed the sumore account")
    let cleared = try encoder.encode(saved)
    saved.receive(approved, extensionProcess: false)
    let reapproved = try encoder.encode(saved)
    check(reapproved == cleared, "Re-approval restored revoked tokens without a new selection")
  }

  static func perAppPolicyTests() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let today = ScreenTimeDailyPolicy.dayKey(start, calendar: calendar)
    let tomorrow = ScreenTimeDailyPolicy.dayBounds(start, calendar: calendar).end
    for minutes in [1, 2, 17, 239, 1440] { try ScreenTimePerAppPolicy.validate(minutes: minutes); checks += 1 }
    for minutes in [Int.min, -1, 0, 1441, Int.max] {
      do { try ScreenTimePerAppPolicy.validate(minutes: minutes); preconditionFailure("Invalid per-app minutes accepted") }
      catch { checks += 1 }
    }
    var policy = ScreenTimePerAppPolicy(generation: UUID().uuidString, day: today,
      allocations: [ScreenTimeAppAllocation(id: account, minutes: 1), ScreenTimeAppAllocation(id: other, minutes: 1440)])
    try policy.validateStored()
    check(policy.minutes == 1441, "Combined allocation incorrectly capped to one app")
    check(policy.reachedIDs(now: start, calendar: calendar).isEmpty, "Unused apps initially blocked")
    let first = ScreenTimePendingThreshold(activity: policy.activityName, event: policy.eventName(account), now: start, calendar: calendar)!
    let second = ScreenTimePendingThreshold(activity: policy.activityName, event: policy.eventName(other), now: start, calendar: calendar)!
    check(first.applicationId == account && second.applicationId == other, "Per-app journal lost identity")
    check(first.filename != second.filename, "Independent app callbacks overwrite each other")
    check(policy.receiveThreshold(activity: policy.activityName, event: policy.eventName(account), now: start, calendar: calendar), "Current app threshold rejected")
    check(policy.reachedIDs(now: start, calendar: calendar) == [account], "One app threshold blocked all apps")
    check(!policy.receiveThreshold(activity: "wrong", event: policy.eventName(other), now: start, calendar: calendar), "Foreign activity accepted")
    check(!policy.receiveThreshold(activity: policy.activityName, event: policy.eventName(UUID().uuidString), now: start, calendar: calendar), "Foreign app accepted")
    var saved: ScreenTimePerAppPolicy? = try JSONDecoder().decode(ScreenTimePerAppPolicy.self, from: JSONEncoder().encode(policy))
    check(saved?.reachedIDs(now: start, calendar: calendar) == [account], "Restart lost app threshold")
    check(second.apply(to: &saved, enabled: true, now: start, calendar: calendar), "Journal retry lost second app")
    check(saved?.reachedIDs(now: start, calendar: calendar) == [account, other], "Journal failed to retain both thresholds")
    check(!first.apply(to: &saved, enabled: false, now: start, calendar: calendar), "Journal re-enabled disabled policy")
    check(!first.apply(to: &saved, enabled: true, now: tomorrow, calendar: calendar), "Yesterday callback blocked today")
    var shared: ScreenTimeDailyPolicy? = ScreenTimeDailyPolicy(minutes: 30, generation: policy.generation, day: today)
    check(!first.apply(to: &shared, enabled: true, now: start, calendar: calendar), "Per-app event latched shared policy")
    let sharedEntry = ScreenTimePendingThreshold(activity: shared!.activityName, event: shared!.eventName, now: start, calendar: calendar)!
    check(!sharedEntry.apply(to: &saved, enabled: true, now: start, calendar: calendar), "Shared event latched per-app policy")
    saved?.generation = UUID().uuidString
    check(!second.apply(to: &saved, enabled: true, now: start, calendar: calendar), "Old configuration crossed generation")
    let oldActivity = policy.activityName
    let oldEvent = policy.eventName(account)
    policy.rollover(now: tomorrow, calendar: calendar)
    check(policy.reachedIDs(now: tomorrow, calendar: calendar).isEmpty, "Midnight retained yesterday's app latches")
    check(!policy.receiveThreshold(activity: oldActivity, event: oldEvent, now: tomorrow, calendar: calendar), "Delayed threshold crossed midnight")
    check(policy.receiveThreshold(activity: policy.activityName, event: policy.eventName(other), now: tomorrow, calendar: calendar), "New day app threshold rejected")
    let legacy = try JSONDecoder().decode(ScreenTimePendingThreshold.self, from: Data("{\"generation\":\"\(account)\",\"day\":\"\(today)\"}".utf8))
    check(legacy.applicationId == nil, "Old shared journal no longer decodes")
    var corrupt = policy
    corrupt.allocations.append(corrupt.allocations[0])
    do { try corrupt.validateStored(); preconditionFailure("Duplicate app IDs accepted") } catch { checks += 1 }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sumore-per-app-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let journal = ScreenTimeThresholdJournal(directory: directory)
    try journal.enqueue(first)
    try journal.enqueue(second)
    check(journal.pending(now: start, calendar: calendar).count == 2, "Per-app journal did not survive storage round-trip")
  }

  static func monitorCleanupTests() {
    final class FakeCenter {
      var installed = Set<String>()
      var starts = 0
      var stops: [[String]] = []
      func start(_ name: String) { installed.insert(name); starts += 1 }
      func stop(_ names: [String]) {
        stops.append(names)
        // Match Apple's documented dangerous empty-array semantics.
        if names.isEmpty { installed.removeAll() }
        else { installed.subtract(names) }
      }
    }
    let legacy = FakeCenter()
    legacy.start("daily")
    legacy.stop([])
    check(legacy.installed.isEmpty, "Fake must reproduce Apple's stop-all behavior")

    let center = FakeCenter()
    let desired: Set<String> = ["daily", "rollover"]
    // Enabling followed by repeated status/callback reconciliation must not
    // stop/restart the just-created monitors and flood the system daemon.
    for _ in 0..<20 {
      for name in desired where !center.installed.contains(name) { center.start(name) }
      ScreenTimeMonitorCleanup.stopOnlyExplicit(center.installed.filter { !desired.contains($0) }, stop: center.stop)
    }
    check(center.starts == 2, "No-op cleanup caused repeated registrations")
    check(center.stops.isEmpty, "No-op cleanup reached stopMonitoring([])")
    check(center.installed == desired, "Healthy monitors were removed")
    center.start("obsolete")
    ScreenTimeMonitorCleanup.stopOnlyExplicit(center.installed.filter { !desired.contains($0) }, stop: center.stop)
    check(center.installed == desired && center.stops == [["obsolete"]], "Cleanup must remove only obsolete monitors")
    let before = center.installed
    // Validation error with no registrations must not stop any previous monitor.
    ScreenTimeMonitorCleanup.stopOnlyExplicit(center.installed.filter { !before.contains($0) }, stop: center.stop)
    check(center.installed == before && center.stops.count == 1, "Empty rollback cleared valid monitors")
    center.start("failed-new-generation")
    ScreenTimeMonitorCleanup.stopOnlyExplicit(center.installed.filter { !before.contains($0) }, stop: center.stop)
    check(center.installed == before, "Rollback removed a previous generation")
  }

  static func workerQueueTests() {
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    let completed = DispatchSemaphore(value: 0)
    let second = DispatchSemaphore(value: 0)
    ScreenTimeExecution.queue.async {
      precondition(!Thread.isMainThread, "Engine work ran on the UI thread")
      entered.signal()
      release.wait() // Simulated slow synchronous DeviceActivity daemon call.
      completed.signal()
    }
    check(entered.wait(timeout: .now() + 2) == .success, "Worker did not start")
    var mainHeartbeat = false
    RunLoop.current.perform { mainHeartbeat = true }
    RunLoop.current.run(until: Date().addingTimeInterval(0.03))
    check(mainHeartbeat, "Slow native work prevented UI run-loop progress")
    ScreenTimeExecution.queue.async { second.signal() }
    check(second.wait(timeout: .now() + 0.02) == .timedOut, "Engine queue is not serial; account changes could race saves")
    release.signal()
    check(completed.wait(timeout: .now() + 2) == .success, "Worker did not complete")
    check(second.wait(timeout: .now() + 2) == .success, "Serialized next operation was lost")
  }

  static func dailyPolicyTests() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
    let noon = ScreenTimeGrant.date("2026-09-14T19:00:00Z")!
    let bounds = ScreenTimeDailyPolicy.dayBounds(noon, calendar: calendar)
    let tomorrow = bounds.end
    for minutes in stride(from: 15, through: 240, by: 5) {
      try ScreenTimeDailyPolicy.validate(minutes: minutes)
      checks += 1
    }
    for minutes in [1, 5, 10, 14, 16, 239, 241, 245, 1440] {
      try ScreenTimeDailyPolicy.validate(minutes: minutes)
      checks += 1
    }
    for minutes in [Int.min, -1, 0, 1441, Int.max] {
      do { try ScreenTimeDailyPolicy.validate(minutes: minutes); preconditionFailure("Invalid budget accepted") }
      catch { checks += 1 }
    }
    var daily = ScreenTimeDailyPolicy(minutes: 30, generation: "first", day: ScreenTimeDailyPolicy.dayKey(noon, calendar: calendar))
    let validSaved = ScreenTimeDailyPolicy(minutes: 30, generation: account, day: daily.day)
    try validSaved.validateStored()
    checks += 1
    for invalid in [
      ScreenTimeDailyPolicy(minutes: 0, generation: account, day: daily.day),
      ScreenTimeDailyPolicy(minutes: 30, generation: "", day: daily.day),
      ScreenTimeDailyPolicy(minutes: 30, generation: "not-uuid", day: daily.day),
      ScreenTimeDailyPolicy(minutes: 30, generation: account, day: "bad-day"),
      ScreenTimeDailyPolicy(minutes: 30, generation: account, day: "UTC:nan"),
      ScreenTimeDailyPolicy(minutes: 30, generation: account, day: "UTC:999999999999999999"),
      ScreenTimeDailyPolicy(minutes: 30, generation: account, day: daily.day, reachedDay: "different-day")
    ] {
      do { try invalid.validateStored(); preconditionFailure("Malformed stored daily policy accepted") }
      catch { checks += 1 }
    }
    let activity = daily.activityName
    let event = daily.eventName
    check(!daily.reached(now: noon, calendar: calendar), "Daily mode must not block immediately")
    check(daily.receiveThreshold(activity: activity, event: event, now: noon, calendar: calendar), "Current threshold rejected")
    check(daily.receiveThreshold(activity: activity, event: event, now: noon, calendar: calendar), "Repeated threshold not idempotent")
    check(daily.reached(now: noon, calendar: calendar), "Threshold must latch for the whole day")
    let latched = daily
    check(ScreenTimeDailyPolicy.shouldShield(enabled: true, selected: true, daily: daily, activeGrant: false, now: noon, calendar: calendar), "Threshold did not block")
    check(!ScreenTimeDailyPolicy.shouldShield(enabled: true, selected: true, daily: daily, activeGrant: true, now: noon, calendar: calendar), "Approval did not lift daily shield")
    check(!ScreenTimeDailyPolicy.shouldShield(enabled: false, selected: true, daily: daily, activeGrant: false, now: noon, calendar: calendar), "Disable must win over threshold")
    check(!ScreenTimeDailyPolicy.shouldShield(enabled: true, selected: false, daily: daily, activeGrant: false, now: noon, calendar: calendar), "Empty selection must not block all apps")
    check(ScreenTimeDailyPolicy.shouldShield(enabled: true, selected: true, daily: nil, activeGrant: false, now: noon, calendar: calendar), "Legacy manual state lost immediate blocking")
    daily.rollover(now: tomorrow, calendar: calendar)
    check(!daily.reached(now: tomorrow, calendar: calendar), "Midnight failed to reset latch")
    check(!daily.receiveThreshold(activity: activity, event: event, now: tomorrow, calendar: calendar), "Yesterday's queued event blocked today")
    check(!daily.reached(now: tomorrow, calendar: calendar), "Rejected old event changed latch")
    check(!ScreenTimeDailyPolicy.shouldShield(enabled: true, selected: true, daily: latched, activeGrant: false, now: tomorrow, calendar: calendar), "Expired overnight grant incorrectly reblocked new day")
    check(daily.receiveThreshold(activity: daily.activityName, event: daily.eventName, now: tomorrow, calendar: calendar), "New day's threshold rejected")
    daily.rollover(now: tomorrow.addingTimeInterval(1), calendar: calendar)
    check(daily.reached(now: tomorrow, calendar: calendar), "Repeated interval start erased today's reached latch")
    let oldName = daily.activityName
    let oldEvent = daily.eventName
    daily.generation = "new-account-or-selection"
    daily.reachedDay = nil
    check(!daily.receiveThreshold(activity: oldName, event: oldEvent, now: tomorrow, calendar: calendar), "Old account/selection callback accepted")
    check(!daily.receiveThreshold(activity: daily.activityName, event: oldEvent, now: tomorrow, calendar: calendar), "Mismatched event accepted")
    var tokyo = calendar
    tokyo.timeZone = TimeZone(identifier: "Asia/Tokyo")!
    check(!daily.receiveThreshold(activity: daily.activityName, event: daily.eventName, now: tomorrow, calendar: tokyo), "Old timezone callback accepted")

    // Calendar days, not fixed24h intervals: spring/fall DST still reset at
    // local midnight and provide a comfortably >15min monitoring interval.
    for (date, hours) in [("2026-03-08T19:00:00Z", 23), ("2026-11-01T20:00:00Z", 25)] {
      let day = ScreenTimeDailyPolicy.dayBounds(ScreenTimeGrant.date(date)!, calendar: calendar)
      check(day.end.timeIntervalSince(day.start) == Double(hours * 3600), "DST day uses a fixed24h interval")
      check(calendar.component(.hour, from: day.start) == 0 && calendar.component(.hour, from: day.end) == 0, "Rollover is not local midnight")
    }

    let deadline = ScreenTimeDisablePolicy.request(existing: nil, now: noon)
    check(deadline.timeIntervalSince(noon) == 30, "Turn-off delay must be30seconds")
    check(ScreenTimeDisablePolicy.request(existing: deadline, now: noon.addingTimeInterval(12)) == deadline, "Repeated request extended turn-off delay")
    for pending in [nil, deadline] as [Date?] {
      do { try ScreenTimeDisablePolicy.requireAllowed(enabled: true, deadline: pending, now: noon); preconditionFailure("Active limit disabled without waiting") }
      catch { checks += 1 }
    }
    try ScreenTimeDisablePolicy.requireAllowed(enabled: true, deadline: deadline, now: deadline)
    try ScreenTimeDisablePolicy.requireAllowed(enabled: false, deadline: nil, now: noon)
    checks += 2
    let renewed = ScreenTimeDisablePolicy.request(existing: nil, now: noon.addingTimeInterval(5))
    check(renewed > deadline, "Cancel then request must start a fresh pause")

    // Same optional new fields as ScreenTimeState: old JSON has neither and
    // must retain manual mode. Opaque selection decoding remains an iOS test.
    struct PolicyEnvelope: Codable {
      var version: Int
      var enabled: Bool
      var daily: ScreenTimeDailyPolicy?
      var settingsChangeAllowedAt: Date?
    }
    let legacy = try JSONDecoder().decode(PolicyEnvelope.self, from: Data("{\"version\":1,\"enabled\":true}".utf8))
    check(legacy.daily == nil && legacy.settingsChangeAllowedAt == nil && legacy.enabled, "Legacy v1 migration changed manual configuration")
    let stored = PolicyEnvelope(version: 1, enabled: true, daily: latched, settingsChangeAllowedAt: deadline)
    let restored = try JSONDecoder().decode(PolicyEnvelope.self, from: JSONEncoder().encode(stored))
    check(restored.daily?.reached(now: noon, calendar: calendar) == true, "Restart lost today's threshold")
    check(restored.daily?.generation == latched.generation, "Restart changed callback identity")
    check(restored.settingsChangeAllowedAt == deadline, "Restart extended cooldown")
    try journalTests(noon: noon, calendar: calendar)
  }

  static func journalTests(noon: Date, calendar: Calendar) throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("sumore-journal-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let daily = ScreenTimeDailyPolicy(minutes: 30, generation: account, day: ScreenTimeDailyPolicy.dayKey(noon, calendar: calendar))
    let journal = ScreenTimeThresholdJournal(directory: directory)
    let entry = ScreenTimePendingThreshold(activity: daily.activityName, event: daily.eventName, now: noon, calendar: calendar)!
    check(ScreenTimePendingThreshold(activity: daily.activityName, event: "bad", now: noon, calendar: calendar) == nil, "Untrusted callback shape accepted")
    check(ScreenTimePendingThreshold(activity: "wrong-activity", event: daily.eventName, now: noon, calendar: calendar) == nil, "Wrong activity journaled")
    let tomorrow = ScreenTimeDailyPolicy.dayBounds(noon, calendar: calendar).end
    check(ScreenTimePendingThreshold(activity: daily.activityName, event: daily.eventName, now: tomorrow, calendar: calendar) == nil, "Yesterday callback journaled for today")
    try journal.enqueue(entry)
    try journal.enqueue(entry)
    check(journal.pending(now: noon, calendar: calendar).count == 1, "Duplicate callback grew journal")

    // Simulate all callback lock attempts timing out: no main-state transaction
    // occurs. A new process must still recover the pending threshold.
    let restarted = ScreenTimeThresholdJournal(directory: directory)
    var pending = restarted.pending(now: noon, calendar: calendar)
    check(pending.count == 1, "Lock timeout/process restart lost once-per-day callback")
    var trial: ScreenTimeDailyPolicy? = daily
    check(pending[0].apply(to: &trial, enabled: true, now: noon, calendar: calendar), "Retry failed to consume current event")
    check(trial?.reached(now: noon, calendar: calendar) == true, "Pending callback did not latch threshold")
    // Simulate commit failure: discard trial, do not acknowledge. A later retry
    // must still work; a successful commit then permits journal deletion.
    trial = daily
    pending = restarted.pending(now: noon, calendar: calendar)
    check(pending.count == 1, "Failed commit deleted pending callback")
    check(pending[0].apply(to: &trial, enabled: true, now: noon, calendar: calendar), "Retry after commit failure lost latch")
    let committed = try JSONEncoder().encode(trial)
    try committed.write(to: directory.appendingPathComponent("committed-test-policy.json"), options: .atomic)
    restarted.acknowledge(pending)
    check(restarted.pending(now: noon, calendar: calendar).isEmpty, "Successful commit did not consume journal")
    try restarted.enqueue(entry)
    pending = restarted.pending(now: noon, calendar: calendar)
    check(pending[0].apply(to: &trial, enabled: true, now: noon, calendar: calendar), "Post-commit duplicate not idempotent")
    check(!ScreenTimeDailyPolicy.shouldShield(enabled: true, selected: true, daily: trial, activeGrant: true, now: noon, calendar: calendar), "Pending callback overrode newer active approval")
    var foreign: ScreenTimeDailyPolicy? = ScreenTimeDailyPolicy(minutes: 30, generation: other, day: daily.day)
    check(!entry.apply(to: &foreign, enabled: true, now: noon, calendar: calendar), "Pending event crossed account/selection generation")
    check(!entry.apply(to: &trial, enabled: false, now: noon, calendar: calendar), "Pending event re-enabled disabled limit")
    check(!entry.apply(to: &trial, enabled: true, now: tomorrow, calendar: calendar), "Pending event blocked a different day")
    check(restarted.pending(now: tomorrow, calendar: calendar).isEmpty, "Old-day journal was not cleaned")

    for _ in 0..<(ScreenTimeThresholdJournal.maximumEntries + 8) {
      let policy = ScreenTimeDailyPolicy(minutes: 30, generation: UUID().uuidString, day: daily.day)
      try restarted.enqueue(ScreenTimePendingThreshold(activity: policy.activityName, event: policy.eventName, now: noon, calendar: calendar)!)
    }
    check(restarted.pending(now: noon, calendar: calendar).count <= ScreenTimeThresholdJournal.maximumEntries, "Journal exceeded resource bound")
  }
}
