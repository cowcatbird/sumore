import Foundation

// Apple's stopMonitoring([]) means STOP ALL, not no work. All selective cleanup
// must use this gate, including rollback after an unrelated validation failure.
enum ScreenTimeMonitorCleanup {
  static func stopOnlyExplicit<Activity>(_ activities: [Activity], stop: ([Activity]) -> Void) {
    guard !activities.isEmpty else { return }
    stop(activities)
  }
}

// These gates compare values read during the CURRENT locked transaction, not
// an in-memory "last applied" cache. Another process may have changed either
// the durable policy or Apple's live settings since the previous status read.
enum ScreenTimeWritePolicy {
  static func commitIfChanged<Value: Equatable>(original: Value, updated: Value,
    hasDurableOriginal: Bool, persist: () throws -> Void) rethrows {
    guard !hasDurableOriginal || original != updated else { return }
    try persist()
  }

  static func updateIfChanged<Value: Equatable>(current: Value, desired: Value,
    apply: (Value) -> Void) {
    guard current != desired else { return }
    apply(desired)
  }
}

// Keep blocking daemon calls and file locks off UIKit's main thread, while
// serializing every app-process engine call on the same queue.
enum ScreenTimeExecution {
  static let queue = DispatchQueue(label: "com.sumore.screen-time.engine", qos: .userInitiated)
}

// AuthorizationCenter starts as notDetermined in EACH process. That is not
// proof of revocation. The app snapshots Apple's main-queue-only property;
// its monitor extension instead follows the already-saved enabled policy.
// Never persist this snapshot as evidence that a future process is authorized.
enum ScreenTimeAuthorization: String {
  case notDetermined, approved, denied

  var permitsNewRestrictions: Bool { self == .approved }

  func shouldResetSelection(extensionProcess: Bool) -> Bool {
    !extensionProcess && self == .denied
  }

  func canReconcile(extensionProcess: Bool) -> Bool {
    extensionProcess || self == .approved
  }

  func shouldPreserveShields(extensionProcess: Bool, enabled: Bool) -> Bool {
    !extensionProcess && self == .notDetermined && enabled
  }
}

struct ScreenTimeFailure: LocalizedError {
  let message: String
  let requiresReset: Bool
  init(message: String, requiresReset: Bool = false) {
    self.message = message
    self.requiresReset = requiresReset
  }
  var errorDescription: String? { message }
}

// Foundation-only logic is executable in local regression tests without iOS.
struct ScreenTimeGrant: Codable, Equatable {
  let grantId: String
  let requesterId: String
  let requestId: String?
  let startedAt: String
  let expiresAt: String
  let serverNow: String
  let source: String

  init(grantId: String, requesterId: String, requestId: String?, startedAt: String,
       expiresAt: String, serverNow: String, source: String = "request") {
    self.grantId = grantId
    self.requesterId = requesterId
    self.requestId = requestId
    self.startedAt = startedAt
    self.expiresAt = expiresAt
    self.serverNow = serverNow
    self.source = source
  }

  private enum CodingKeys: String, CodingKey {
    case grantId, requesterId, requestId, startedAt, expiresAt, serverNow, source
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    grantId = try values.decode(String.self, forKey: .grantId)
    requesterId = try values.decode(String.self, forKey: .requesterId)
    requestId = try values.decodeIfPresent(String.self, forKey: .requestId)
    startedAt = try values.decode(String.self, forKey: .startedAt)
    expiresAt = try values.decode(String.self, forKey: .expiresAt)
    serverNow = try values.decode(String.self, forKey: .serverNow)
    // Existing v1 files have no source. Only an absent field is legacy;
    // explicit null, unknown values, and malformed types must be rejected.
    source = values.contains(.source) ? try values.decode(String.self, forKey: .source) : "request"
    try validateSourceAndRequest()
  }

  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(grantId, forKey: .grantId)
    try values.encode(requesterId, forKey: .requesterId)
    try values.encode(requestId, forKey: .requestId)
    try values.encode(startedAt, forKey: .startedAt)
    try values.encode(expiresAt, forKey: .expiresAt)
    try values.encode(serverNow, forKey: .serverNow)
    try values.encode(source, forKey: .source)
  }

  private func validateSourceAndRequest() throws {
    guard (source == "request" && requestId.flatMap { UUID(uuidString: $0) } != nil)
      || (source == "panic" && requestId == nil) else {
      throw ScreenTimeFailure(message: "The approval has an invalid source or request. Refresh and try again.")
    }
  }

  func hasSameIdentity(as other: Self) -> Bool {
    // serverNow is refreshed by an idempotent claim; it is not grant identity.
    grantId.lowercased() == other.grantId.lowercased()
      && requesterId.lowercased() == other.requesterId.lowercased()
      && source == other.source && requestId == other.requestId
      && startedAt == other.startedAt && expiresAt == other.expiresAt
  }

  func permitsDuration(_ duration: TimeInterval) -> Bool {
    abs(duration - 900) < 1 || (source == "request" && abs(duration - 1800) < 1)
  }

  static func date(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
  }

  func validate(accountId: String?, now: Date) throws -> (start: Date, end: Date) {
    try validateSourceAndRequest()
    guard UUID(uuidString: grantId) != nil,
          UUID(uuidString: requesterId) != nil,
          accountId?.lowercased() == requesterId.lowercased() else {
      throw ScreenTimeFailure(message: "This approval belongs to a different app account.")
    }
    guard let start = Self.date(startedAt), let end = Self.date(expiresAt),
          let server = Self.date(serverNow) else {
      throw ScreenTimeFailure(message: "The server approval has invalid dates. Refresh and try again.")
    }
    let duration = end.timeIntervalSince(start)
    guard permitsDuration(duration),
          server >= start, server < end, end > now,
          abs(server.timeIntervalSince(now)) <= 120 else {
      throw ScreenTimeFailure(message: "This approval expired or cannot be timed safely. Enable automatic Date & Time and refresh. Supported pauses are 15 or 30 minutes.")
    }
    return (start, end)
  }

  static func monitorInterval(start: Date, end: Date) -> (start: DateComponents, end: DateComponents) {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let fields: Set<Calendar.Component> = [.timeZone, .year, .month, .day, .hour, .minute, .second]
    // Apple's minimum interval is 15min. Include the original grant start minus
    // 1min, never the retry time. Round end UP <1sec so an early callback cannot
    // observe an unexpired grant and accidentally leave shields off forever.
    return (
      calendar.dateComponents(fields, from: start.addingTimeInterval(-60)),
      calendar.dateComponents(fields, from: Date(timeIntervalSince1970: ceil(end.timeIntervalSince1970)))
    )
  }
}

// Foundation-only calendar/callback/cooldown policy, shared with the extension.
// A missing policy in the v1 file means legacy manual (block-now) mode.
struct ScreenTimeDailyPolicy: Codable, Equatable {
  let minutes: Int
  var generation: String
  var day: String
  var reachedDay: String?

  static func validate(minutes: Int) throws {
    guard (1...1440).contains(minutes) else {
      throw ScreenTimeFailure(message: "Enter a daily limit from 1 to 1440 whole minutes.")
    }
  }

  func validateStored() throws {
    try Self.validate(minutes: minutes)
    guard UUID(uuidString: generation) != nil, Self.validDayKey(day),
          reachedDay == nil || reachedDay == day else {
      throw ScreenTimeFailure(message: "Invalid saved daily-limit policy.")
    }
  }

  static func validDayKey(_ value: String) -> Bool {
    guard let separator = value.lastIndex(of: ":"),
          let zone = TimeZone(identifier: String(value[..<separator])),
          let seconds = Double(value[value.index(after: separator)...]), seconds.isFinite,
          seconds >= -2_208_988_800, seconds < 253_402_300_800 else { return false }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    return dayKey(Date(timeIntervalSince1970: seconds), calendar: calendar) == value
  }

  static func dayKey(_ now: Date, calendar: Calendar = .current) -> String {
    // Include the timezone: travel must invalidate a queued old-zone callback.
    "\(calendar.timeZone.identifier):\(Int(calendar.startOfDay(for: now).timeIntervalSince1970))"
  }

  static func dayBounds(_ now: Date, calendar: Calendar = .current) -> (start: Date, end: Date) {
    let start = calendar.startOfDay(for: now)
    return (start, calendar.date(byAdding: .day, value: 1, to: start)!)
  }

  var rolloverName: String { "sumore.daily-rollover.\(generation)" }
  var activityName: String { "sumore.daily-budget.\(generation).\(day)" }
  var eventName: String { "sumore.daily-threshold.\(generation).\(day)" }

  mutating func rollover(now: Date, calendar: Calendar = .current) {
    let today = Self.dayKey(now, calendar: calendar)
    if day != today { day = today; reachedDay = nil }
  }

  mutating func receiveThreshold(activity: String, event: String, now: Date, calendar: Calendar = .current) -> Bool {
    rollover(now: now, calendar: calendar)
    guard activity == activityName, event == eventName else { return false }
    reachedDay = day
    return true
  }

  func reached(now: Date, calendar: Calendar = .current) -> Bool {
    reachedDay == Self.dayKey(now, calendar: calendar)
  }

  static func shouldShield(enabled: Bool, selected: Bool, daily: Self?, activeGrant: Bool, now: Date, calendar: Calendar = .current) -> Bool {
    enabled && selected && !activeGrant && (daily?.reached(now: now, calendar: calendar) ?? true)
  }
}

enum ScreenTimeDisablePolicy {
  static let delay: TimeInterval = 30

  static func request(existing: Date?, now: Date) -> Date {
    existing ?? now.addingTimeInterval(delay)
  }

  static func requireAllowed(enabled: Bool, deadline: Date?, now: Date) throws {
    guard !enabled || (deadline.map { $0 <= now } ?? false) else {
      throw ScreenTimeFailure(message: "Start the 30-second turn-off pause, then wait for it to finish before changing or clearing your limit.")
    }
  }
}

// App identities are random local keys. Opaque Apple tokens live only in the
// engine's protected state; neither tokens nor names cross the JS bridge.
struct ScreenTimeAppAllocation: Codable, Equatable {
  let id: String
  let minutes: Int
  var reachedDay: String?
}

struct ScreenTimePerAppPolicy: Codable, Equatable {
  var generation: String
  var day: String
  var allocations: [ScreenTimeAppAllocation]

  static func validate(minutes: Int) throws {
    try ScreenTimeDailyPolicy.validate(minutes: minutes)
  }

  func validateStored() throws {
    guard UUID(uuidString: generation) != nil, ScreenTimeDailyPolicy.validDayKey(day),
          (1...50).contains(allocations.count), Set(allocations.map(\.id)).count == allocations.count else {
      throw ScreenTimeFailure(message: "Invalid saved per-app limits.")
    }
    for allocation in allocations {
      try Self.validate(minutes: allocation.minutes)
      guard UUID(uuidString: allocation.id) != nil,
            allocation.reachedDay == nil || allocation.reachedDay == day else {
        throw ScreenTimeFailure(message: "Invalid saved per-app limit.")
      }
    }
  }

  var minutes: Int { allocations.reduce(0) { $0 + $1.minutes } }
  var rolloverName: String { "sumore.daily-rollover.\(generation)" }
  var activityName: String { "sumore.daily-budget.\(generation).\(day)" }
  func eventName(_ id: String) -> String { "sumore.daily-app-threshold.\(generation).\(id).\(day)" }

  mutating func rollover(now: Date, calendar: Calendar = .current) {
    let today = ScreenTimeDailyPolicy.dayKey(now, calendar: calendar)
    if day != today {
      day = today
      for index in allocations.indices { allocations[index].reachedDay = nil }
    }
  }

  func reachedIDs(now: Date, calendar: Calendar = .current) -> Set<String> {
    let today = ScreenTimeDailyPolicy.dayKey(now, calendar: calendar)
    return Set(allocations.filter { $0.reachedDay == today }.map(\.id))
  }

  mutating func receiveThreshold(activity: String, event: String, now: Date, calendar: Calendar = .current) -> Bool {
    rollover(now: now, calendar: calendar)
    guard activity == activityName,
          let index = allocations.firstIndex(where: { eventName($0.id) == event }) else { return false }
    allocations[index].reachedDay = day
    return true
  }
}

// Only callback identity is journaled: no app tokens, usage totals or account
// identifiers. The policy's random generation binds the event to its owner and
// selection. Dated identity also rejects delayed callbacks from yesterday.
struct ScreenTimePendingThreshold: Codable {
  let generation: String
  let day: String
  let applicationId: String?

  init?(activity: String, event: String, now: Date, calendar: Calendar = .current) {
    let isPerApp = event.hasPrefix("sumore.daily-app-threshold.")
    let prefix = isPerApp ? "sumore.daily-app-threshold." : "sumore.daily-threshold."
    guard event.hasPrefix(prefix) else { return nil }
    let suffix = String(event.dropFirst(prefix.count))
    guard suffix.count > 37 else { return nil }
    let generation = String(suffix.prefix(36))
    guard UUID(uuidString: generation) != nil, suffix.dropFirst(36).first == "." else { return nil }
    let remaining = String(suffix.dropFirst(37))
    let applicationId = isPerApp ? String(remaining.prefix(36)) : nil
    if isPerApp {
      guard remaining.count > 37, UUID(uuidString: applicationId!) != nil,
            remaining.dropFirst(36).first == "." else { return nil }
    }
    let day = isPerApp ? String(remaining.dropFirst(37)) : remaining
    guard ScreenTimeDailyPolicy.validDayKey(day), day == ScreenTimeDailyPolicy.dayKey(now, calendar: calendar),
          activity == "sumore.daily-budget.\(generation).\(day)" else { return nil }
    self.generation = generation
    self.day = day
    self.applicationId = applicationId
  }

  var filename: String {
    let encoded = Data(day.utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "=", with: "")
    let appSuffix = applicationId.map { "-\($0)" } ?? ""
    return "threshold-\(generation)\(appSuffix)-\(encoded).json"
  }

  func apply(to policy: inout ScreenTimeDailyPolicy?, enabled: Bool, now: Date, calendar: Calendar = .current) -> Bool {
    guard applicationId == nil, enabled, var daily = policy, daily.generation == generation,
          day == ScreenTimeDailyPolicy.dayKey(now, calendar: calendar) else { return false }
    daily.rollover(now: now, calendar: calendar)
    guard daily.day == day else { return false }
    daily.reachedDay = day
    policy = daily
    return true
  }

  func apply(to policy: inout ScreenTimePerAppPolicy?, enabled: Bool, now: Date, calendar: Calendar = .current) -> Bool {
    guard let applicationId, enabled, var daily = policy, daily.generation == generation,
          day == ScreenTimeDailyPolicy.dayKey(now, calendar: calendar) else { return false }
    daily.rollover(now: now, calendar: calendar)
    guard daily.day == day, let index = daily.allocations.firstIndex(where: { $0.id == applicationId }) else { return false }
    daily.allocations[index].reachedDay = day
    policy = daily
    return true
  }
}

// Independent atomic files are intentionally writable BEFORE acquiring the
// main state lock. Retries deduplicate to one file per generation/day. Cleanup
// is scoped to our private subdirectory and a strict filename prefix.
final class ScreenTimeThresholdJournal {
  static let maximumEntries = 128
  private let directory: URL
  init(directory: URL) { self.directory = directory.appendingPathComponent("sumore-pending-thresholds", isDirectory: true) }

  private func files() -> [URL] {
    let files = (try? FileManager.default.contentsOfDirectory(at: directory,
      includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey])) ?? []
    return files.filter { $0.lastPathComponent.hasPrefix("threshold-") && $0.pathExtension == "json" }
  }

  func enqueue(_ entry: ScreenTimePendingThreshold) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try JSONEncoder().encode(entry).write(to: directory.appendingPathComponent(entry.filename),
      options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    // Old generations are irrelevant after newer configurations. Keep a small
    // bound even if many callbacks race account/selection changes in one day.
    let ordered = files().sorted {
      let a = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
      let b = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
      return a > b
    }
    for file in ordered.dropFirst(Self.maximumEntries) { try? FileManager.default.removeItem(at: file) }
  }

  func pending(now: Date, calendar: Calendar = .current) -> [ScreenTimePendingThreshold] {
    var entries: [ScreenTimePendingThreshold] = []
    for file in files() {
      let resources = try? file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
      guard resources?.isRegularFile == true, (resources?.fileSize ?? 4097) <= 4096,
            let data = try? Data(contentsOf: file),
            let entry = try? JSONDecoder().decode(ScreenTimePendingThreshold.self, from: data),
            UUID(uuidString: entry.generation) != nil, ScreenTimeDailyPolicy.validDayKey(entry.day),
            entry.applicationId == nil || UUID(uuidString: entry.applicationId!) != nil,
            entry.day == ScreenTimeDailyPolicy.dayKey(now, calendar: calendar),
            entry.filename == file.lastPathComponent else {
        try? FileManager.default.removeItem(at: file)
        continue
      }
      entries.append(entry)
    }
    return entries
  }

  // Call only AFTER the main state (including a consumed latch) is persisted.
  // A duplicate file reappearing during removal is harmless: applying twice is
  // idempotent, and every new generation/day has a different filename.
  func acknowledge(_ entries: [ScreenTimePendingThreshold]) {
    for entry in entries { try? FileManager.default.removeItem(at: directory.appendingPathComponent(entry.filename)) }
  }
}
