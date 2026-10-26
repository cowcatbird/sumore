import Foundation
import Darwin
import FamilyControls
import ManagedSettings
import DeviceActivity

// Compiled into the app and monitor. Opaque selections never leave this device.
private struct ScreenTimeState: Codable, Equatable {
  var version = 1
  var accountId: String?
  var enabled = false
  var selection = FamilyActivitySelection()
  var grant: ScreenTimeGrant?
  var usedGrants: [String: Double] = [:]
  // Optional additions keep old v1 manual-blocking files readable unchanged.
  var daily: ScreenTimeDailyPolicy?
  var perApp: ScreenTimePerAppPolicy?
  var applicationTokens: [String: ApplicationToken]?
  var settingsChangeAllowedAt: Date?
}

struct ScreenTimeSelectedApp: Identifiable {
  let id: String
  let token: ApplicationToken
  let minutes: Int?
}

struct ScreenTimeAppLimitsContext {
  let apps: [ScreenTimeSelectedApp]
  let accountId: String
  let selection: FamilyActivitySelection
}

struct ScreenTimeSelectionSnapshot {
  let apps: [ScreenTimeSelectedApp]
  let selection: FamilyActivitySelection
  let reportGeneration: String?
}

final class ScreenTimeEngine {
  static let monitorName = DeviceActivityName("sumore.approved-pause")
  // Unentitled/default-off builds must not initialize managed-settings services.
  private lazy var store = ManagedSettingsStore(named: ManagedSettingsStore.Name("sumore.chosen-apps"))
  private lazy var monitor = DeviceActivityCenter()
  private let extensionProcess: Bool
  private var boundAccountId: String?
  // Read and written only on the app's serial engine queue. Extensions never
  // read AuthorizationCenter: their initial unknown status must not erase the
  // app's selection or prevent an OS-delivered threshold from being applied.
  private var authorization: ScreenTimeAuthorization = .notDetermined

  init(extensionProcess: Bool = false) { self.extensionProcess = extensionProcess }

  func updateAuthorization(_ snapshot: ScreenTimeAuthorization) {
    guard !extensionProcess else { return }
    authorization = snapshot
  }

  private var container: URL? {
    guard Bundle.main.object(forInfoDictionaryKey: "SumoreScreenTimeEnabled") as? Bool == true,
          let group = Bundle.main.object(forInfoDictionaryKey: "SumoreScreenTimeAppGroup") as? String else { return nil }
    return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
  }

  private var unavailableReason: String? {
    guard Bundle.main.object(forInfoDictionaryKey: "SumoreScreenTimeEnabled") as? Bool == true else {
      return "Real app blocking is not enabled in this build. An approved, signed Screen Time build is required."
    }
    guard container != nil else {
      return "The signed Screen Time App Group is missing. Install a correctly provisioned build."
    }
    if !extensionProcess {
      guard let plugins = Bundle.main.builtInPlugInsURL,
            FileManager.default.fileExists(atPath: plugins.appendingPathComponent("SumoreActivityMonitor.appex").path) else {
        return "The Screen Time monitor extension is missing. A new native build is required."
      }
    }
    return nil
  }

  func requireAvailable() throws {
    if let reason = unavailableReason { throw ScreenTimeFailure(message: reason) }
  }

  private var reportAvailable: Bool {
    // Earlier OS monitors may omit pre-registration usage. Do not show an
    // all-day report as the remaining enforced allowance on those versions.
    if #unavailable(iOS 17.4) { return false }
    guard unavailableReason == nil,
          Bundle.main.object(forInfoDictionaryKey: "SumoreScreenTimeReportsEnabled") as? Bool == true,
          let plugins = Bundle.main.builtInPlugInsURL else { return false }
    return FileManager.default.fileExists(atPath: plugins.appendingPathComponent("SumoreActivityReport.appex").path)
  }

  private func requireAuthorized() throws {
    try requireAvailable()
    guard authorization.permitsNewRestrictions else {
      throw ScreenTimeFailure(message: "Screen Time access is needed before choosing or blocking apps.")
    }
  }

  // A cross-process lock prevents stale monitor callbacks undoing a newer grant,
  // selection or Disable. JSON replacement is atomic, including opaque tokens.
  private func withState<T>(recoverCorrupt: Bool = false, _ action: (inout ScreenTimeState) throws -> T) throws -> T {
    try requireAvailable()
    guard let directory = container else { throw ScreenTimeFailure(message: "Screen Time storage is unavailable.") }
    let descriptor = open(directory.appendingPathComponent("sumore-screen-time.lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw ScreenTimeFailure(message: "Cannot open Screen Time storage. No new restrictions were enabled.") }
    defer { close(descriptor) }
    // Do not hang the foreground indefinitely behind another process.
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
      guard errno == EWOULDBLOCK, ProcessInfo.processInfo.systemUptime < deadline else {
        throw ScreenTimeFailure(message: "Screen Time settings are busy. Please retry.")
      }
      usleep(10_000)
    }
    defer { flock(descriptor, LOCK_UN) }
    let path = directory.appendingPathComponent("sumore-screen-time-v1.json")
    var state = ScreenTimeState()
    var hasDurableOriginal = false
    if FileManager.default.fileExists(atPath: path.path) {
      do {
        state = try JSONDecoder().decode(ScreenTimeState.self, from: Data(contentsOf: path))
        guard state.version == 1 else { throw ScreenTimeFailure(message: "Unsupported Screen Time settings version.") }
        try state.daily?.validateStored()
        try state.perApp?.validateStored()
        if let perApp = state.perApp {
          guard state.daily == nil, state.selection.categoryTokens.isEmpty, state.selection.webDomainTokens.isEmpty,
                let tokens = state.applicationTokens,
                tokens.count == state.selection.applicationTokens.count,
                Set(tokens.keys) == Set(perApp.allocations.map(\.id)),
                Set(tokens.values) == state.selection.applicationTokens else {
            throw ScreenTimeFailure(message: "Invalid saved per-app selection.")
          }
        }
        hasDurableOriginal = true
      } catch {
        store.clearAllSettings()
        if !recoverCorrupt { throw ScreenTimeFailure(message: "Screen Time settings could not be read. Restrictions were removed; use Clear selection to reset them.", requiresReset: true) }
        state = ScreenTimeState()
      }
    }
    let original = state
    let journal = ScreenTimeThresholdJournal(directory: directory)
    let pending = journal.pending(now: Date())
    for entry in pending {
      _ = entry.apply(to: &state.daily, enabled: state.enabled, now: Date())
      _ = entry.apply(to: &state.perApp, enabled: state.enabled, now: Date())
    }
    let previousActivities = Set(monitor.activities)
    do {
      let result = try action(&state)
      do {
        // Every transaction still reads/validates under the cross-process lock.
        // An unchanged status/grid refresh already has a durable policy; avoid
        // replacing the same protected file for every poll. Missing/corrupt
        // files and consumed new threshold latches always need a real commit.
        try ScreenTimeWritePolicy.commitIfChanged(original: original, updated: state,
          hasDurableOriginal: hasDurableOriginal) { try persist(state, to: path) }
      }
      catch {
        throw ScreenTimeFailure(message: "Screen Time settings could not be saved. Restrictions were removed for safety; please retry.", requiresReset: true)
      }
      // In particular a grant is committed BEFORE lifting shields. No monitor
      // callback can observe an unrecorded break or half-enabled daily policy.
      applyShields(state)
      // Keep pending callbacks on any action/commit failure, so the extension
      // retry or next foreground read can still deliver the once/day latch.
      journal.acknowledge(pending)
      // Do not stop the previous monitor before its replacement is durably
      // recorded. Every stop and shield mutation stays inside this same lock.
      if authorization.canReconcile(extensionProcess: extensionProcess) || !state.enabled {
        let desired = desiredActivities(state)
        stopOnlyExplicit(monitor.activities.filter { isOurActivity($0) && !desired.contains($0) })
      }
      return result
    } catch {
      // Registrations may synchronously queue callbacks. New generation names
      // make those callbacks harmless after rollback to the old durable state.
      stopOnlyExplicit(monitor.activities.filter { isOurActivity($0) && !previousActivities.contains($0) })
      if (error as? ScreenTimeFailure)?.requiresReset == true { store.clearAllSettings() }
      else { applyShields(original) }
      throw error
    }
  }

  private func persist(_ state: ScreenTimeState, to path: URL) throws {
    try JSONEncoder().encode(state).write(to: path, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  private func selectionCount(_ selection: FamilyActivitySelection) -> Int {
    selection.applicationTokens.count + selection.categoryTokens.count + selection.webDomainTokens.count
  }

  private func isOurActivity(_ activity: DeviceActivityName) -> Bool {
    activity == Self.monitorName || activity.rawValue.hasPrefix("sumore.daily-")
  }

  private func stopOnlyExplicit(_ activities: [DeviceActivityName]) {
    ScreenTimeMonitorCleanup.stopOnlyExplicit(activities) { monitor.stopMonitoring($0) }
  }

  private func desiredActivities(_ state: ScreenTimeState) -> Set<DeviceActivityName> {
    var names = Set<DeviceActivityName>()
    if state.enabled, let daily = state.daily {
      names.insert(DeviceActivityName(daily.rolloverName))
      names.insert(DeviceActivityName(daily.activityName))
    }
    if state.enabled, let perApp = state.perApp {
      names.insert(DeviceActivityName(perApp.rolloverName))
      names.insert(DeviceActivityName(perApp.activityName))
    }
    if state.enabled && state.grant != nil { names.insert(Self.monitorName) }
    return names
  }

  private func registerDaily(_ state: ScreenTimeState, now: Date) throws {
    guard state.enabled, state.daily != nil || state.perApp != nil else { return }
    let rolloverName = state.perApp?.rolloverName ?? state.daily!.rolloverName
    let activityName = state.perApp?.activityName ?? state.daily!.activityName
    let installed = Set(monitor.activities)
    let rollover = DeviceActivityName(rolloverName)
    if !installed.contains(rollover) {
      // This independent recurring clock creates the next day's dated event,
      // including when the app has not been opened. Callback delivery remains
      // iOS-controlled; getStatus also reconciles rollover on foreground.
      try monitor.startMonitoring(rollover, during: DeviceActivitySchedule(
        intervalStart: DateComponents(hour: 0, minute: 0, second: 0),
        intervalEnd: DateComponents(hour: 23, minute: 59, second: 59), repeats: true))
    }
    let activity = DeviceActivityName(activityName)
    if !installed.contains(activity) {
      let bounds = ScreenTimeDailyPolicy.dayBounds(now)
      let calendar = Calendar.current
      let fields: Set<Calendar.Component> = [.timeZone, .year, .month, .day, .hour, .minute, .second]
      let schedule = DeviceActivitySchedule(
        intervalStart: calendar.dateComponents(fields, from: bounds.start),
        intervalEnd: calendar.dateComponents(fields, from: bounds.end), repeats: false)
      var events: [DeviceActivityEvent.Name: DeviceActivityEvent] = [:]
      if let perApp = state.perApp {
        for allocation in perApp.allocations {
          guard let token = state.applicationTokens?[allocation.id] else {
            throw ScreenTimeFailure(message: "A saved app limit is missing its selection.", requiresReset: true)
          }
          var selected = FamilyActivitySelection()
          selected.applicationTokens = [token]
          events[DeviceActivityEvent.Name(perApp.eventName(allocation.id))] = dailyEvent(selected, minutes: allocation.minutes)
        }
      } else if let daily = state.daily {
        events[DeviceActivityEvent.Name(daily.eventName)] = dailyEvent(state.selection, minutes: daily.minutes)
      }
      try monitor.startMonitoring(activity, during: schedule, events: events)
    }
  }

  private func dailyEvent(_ selected: FamilyActivitySelection, minutes: Int) -> DeviceActivityEvent {
    if #available(iOS 17.4, *) {
      return DeviceActivityEvent(applications: selected.applicationTokens,
        categories: selected.categoryTokens, webDomains: selected.webDomainTokens,
        threshold: DateComponents(minute: minutes), includesPastActivity: true)
    }
    return DeviceActivityEvent(applications: selected.applicationTokens,
      categories: selected.categoryTokens, webDomains: selected.webDomainTokens,
      threshold: DateComponents(minute: minutes))
  }

  private func activeGrant(_ state: ScreenTimeState, now: Date) -> Bool {
    guard let grant = state.grant else { return false }
    return grant.requesterId.lowercased() == state.accountId?.lowercased()
      && (ScreenTimeGrant.date(grant.expiresAt) ?? .distantPast) > now
  }

  private func registerGrant(_ state: ScreenTimeState, now: Date) throws {
    guard state.enabled, let grant = state.grant, activeGrant(state, now: now),
          !monitor.activities.contains(Self.monitorName) else { return }
    guard let start = ScreenTimeGrant.date(grant.startedAt), let end = ScreenTimeGrant.date(grant.expiresAt) else {
      throw ScreenTimeFailure(message: "The saved approval has invalid dates. Clear selection to recover.", requiresReset: true)
    }
    let duration = end.timeIntervalSince(start)
    guard grant.permitsDuration(duration) else {
      throw ScreenTimeFailure(message: "The saved approval has an invalid duration. Clear selection to recover.", requiresReset: true)
    }
    let interval = ScreenTimeGrant.monitorInterval(start: start, end: end)
    // Repair a missing OS monitor without moving the original server expiry.
    try monitor.startMonitoring(Self.monitorName, during: DeviceActivitySchedule(
      intervalStart: interval.start, intervalEnd: interval.end, repeats: false))
  }

  private func applyShields(_ state: ScreenTimeState, now: Date = Date()) {
    // Startup/foreground unknown is observational, not permission to lift a
    // working shield. Explicit account reset/disable sets enabled=false and
    // still clears it. The OS remains authoritative for extension writes.
    guard !authorization.shouldPreserveShields(extensionProcess: extensionProcess, enabled: state.enabled) else { return }
    if let perApp = state.perApp {
      guard authorization.canReconcile(extensionProcess: extensionProcess), state.enabled, !activeGrant(state, now: now) else {
        if hasShields { store.clearAllSettings() }
        return
      }
      let reached = perApp.reachedIDs(now: now)
      let tokens = Set(reached.compactMap { state.applicationTokens?[$0] })
      updateShields(applications: tokens.isEmpty ? nil : tokens)
      return
    }
    guard authorization.canReconcile(extensionProcess: extensionProcess),
          ScreenTimeDailyPolicy.shouldShield(enabled: state.enabled,
            selected: selectionCount(state.selection) > 0, daily: state.daily,
            activeGrant: activeGrant(state, now: now), now: now) else {
      if hasShields { store.clearAllSettings() }
      return
    }
    let selection = state.selection
    updateShields(applications: selection.applicationTokens.isEmpty ? nil : selection.applicationTokens,
      applicationCategories: selection.categoryTokens.isEmpty ? nil : .specific(selection.categoryTokens),
      webDomains: selection.webDomainTokens.isEmpty ? nil : selection.webDomainTokens,
      webDomainCategories: selection.categoryTokens.isEmpty ? nil : .specific(selection.categoryTokens))
  }

  private var hasShields: Bool {
    store.shield.applications != nil || store.shield.applicationCategories != nil
      || store.shield.webDomains != nil || store.shield.webDomainCategories != nil
  }

  private func updateShields(applications: Set<ApplicationToken>?,
    applicationCategories: ShieldSettings.ActivityCategoryPolicy<Application>? = nil,
    webDomains: Set<WebDomainToken>? = nil,
    webDomainCategories: ShieldSettings.ActivityCategoryPolicy<WebDomain>? = nil) {
    // Compare Apple's CURRENT named-store values every time, including after
    // extension callbacks. Never assume the last app-process write still wins.
    // Stable status reads do not need four repeated daemon setting mutations.
    ScreenTimeWritePolicy.updateIfChanged(current: store.shield.applications, desired: applications) {
      store.shield.applications = $0
    }
    ScreenTimeWritePolicy.updateIfChanged(current: store.shield.applicationCategories, desired: applicationCategories) {
      store.shield.applicationCategories = $0
    }
    ScreenTimeWritePolicy.updateIfChanged(current: store.shield.webDomains, desired: webDomains) {
      store.shield.webDomains = $0
    }
    ScreenTimeWritePolicy.updateIfChanged(current: store.shield.webDomainCategories, desired: webDomainCategories) {
      store.shield.webDomainCategories = $0
    }
  }

  private func reconcile(_ state: inout ScreenTimeState, now: Date = Date()) throws {
    if authorization.shouldResetSelection(extensionProcess: extensionProcess) {
      // Only confirmed app-process denial invalidates saved opaque tokens.
      // Apple's initial notDetermined value is NOT a revocation signal.
      state.enabled = false
      state.selection = FamilyActivitySelection()
      state.grant = nil
      state.daily = nil
      state.perApp = nil
      state.applicationTokens = nil
      state.settingsChangeAllowedAt = nil
      return
    }
    guard authorization.canReconcile(extensionProcess: extensionProcess) else { return }
    if let grant = state.grant,
       grant.requesterId.lowercased() != state.accountId?.lowercased() ||
       (ScreenTimeGrant.date(grant.expiresAt) ?? .distantPast) <= now {
      state.grant = nil
    }
    state.daily?.rollover(now: now)
    state.perApp?.rollover(now: now)
    try registerDaily(state, now: now)
    try registerGrant(state, now: now)
  }

  private func status(_ state: ScreenTimeState, reason: String? = nil) -> [String: Any] {
    let currentAuthorization: ScreenTimeAuthorization = unavailableReason == nil ? authorization : .notDetermined
    let dailyUsageNote: String?
    if #available(iOS 17.4, *) { dailyUsageNote = reportAvailable ? nil : "Time left isn't available on iOS. Your limit still applies." }
    else { dailyUsageNote = "Time left isn't available. This iOS version counts usage from when you enabled the limit." }
    let deadlineFormatter = ISO8601DateFormatter()
    deadlineFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    // `shielded` reports our settings, not an unverifiable promise that iOS has
    // already drawn its shielding UI over every selected application.
    return [
      "engineAvailable": reason == nil,
      "supportsPanicGrants": true,
      "authorized": currentAuthorization.permitsNewRestrictions,
      "authorizationStatus": currentAuthorization.rawValue,
      "selectionDisplayAvailable": reason == nil,
      "customLimitAvailable": reason == nil,
      "reportAvailable": reason == nil && reportAvailable,
      "blockingEnabled": state.enabled,
      "shielded": reason == nil && currentAuthorization.permitsNewRestrictions && (state.perApp.map {
        state.enabled && !activeGrant(state, now: Date()) && !$0.reachedIDs(now: Date()).isEmpty
      } ?? ScreenTimeDailyPolicy.shouldShield(
        enabled: state.enabled, selected: selectionCount(state.selection) > 0,
        daily: state.daily, activeGrant: activeGrant(state, now: Date()), now: Date())),
      "mode": state.daily == nil && state.perApp == nil ? "manual" : "daily",
      "limitMode": state.perApp == nil ? "shared" : "perApp",
      "allocatedMinutes": (state.perApp?.minutes ?? state.daily?.minutes) as Any? ?? NSNull(),
      "dailyLimitMinutes": (state.perApp?.minutes ?? state.daily?.minutes) as Any? ?? NSNull(),
      "dailyLimitReached": state.perApp.map { !$0.reachedIDs(now: Date()).isEmpty } ?? (state.daily?.reached(now: Date()) ?? false),
      "usageMinutesToday": NSNull(),
      "dailyUsageNote": dailyUsageNote as Any? ?? NSNull(),
      "settingsChangeAllowedAt": state.settingsChangeAllowedAt.map { deadlineFormatter.string(from: $0) } as Any? ?? NSNull(),
      "selection": ["applications": state.selection.applicationTokens.count,
                    "categories": state.selection.categoryTokens.count,
                    "webDomains": state.selection.webDomainTokens.count],
      "appliedGrantId": state.grant?.grantId as Any? ?? NSNull(),
      "appliedRequestId": state.grant?.requestId as Any? ?? NSNull(),
      "temporaryAccessExpiresAt": state.grant?.expiresAt as Any? ?? NSNull(),
      "reason": reason as Any? ?? NSNull()
    ]
  }

  func getStatus() -> [String: Any] {
    if let reason = unavailableReason { return status(ScreenTimeState(), reason: reason) }
    do {
      return try withState { state in
        try reconcile(&state)
        return status(state)
      }
    } catch {
      // Lock/open failures do not own the state and MUST NOT clear another
      // process's valid shields. Only corruption/write failures already cleared
      // settings under the lock and offer the explicit reset recovery flow.
      let reset = (error as? ScreenTimeFailure)?.requiresReset == true
      let reason = reset ? error.localizedDescription : "\(error.localizedDescription) Previously enabled restrictions may still be active. Please retry."
      var result = status(ScreenTimeState(), reason: reason)
      result["engineAvailable"] = reset
      result["requiresReset"] = reset
      return result
    }
  }

  func setAccount(_ accountId: String?) throws -> [String: Any] {
    if unavailableReason != nil { return getStatus() }
    if let accountId, UUID(uuidString: accountId) == nil { throw ScreenTimeFailure(message: "Invalid app account.") }
    boundAccountId = accountId?.lowercased()
    return try withState { state in
      let normalized = accountId?.lowercased()
      if normalized != state.accountId {
        state.accountId = normalized
        state.grant = nil
        state.enabled = false
        state.selection = FamilyActivitySelection()
        state.daily = nil
        state.perApp = nil
        state.applicationTokens = nil
        state.settingsChangeAllowedAt = nil
        // Explicit sign-out/start-over cannot leave the next user blocked.
      }
      try reconcile(&state)
      return status(state)
    }
  }

  func pickerContext() throws -> (selection: FamilyActivitySelection, accountId: String) {
    try requireAuthorized()
    return try withState { state in
      guard let accountId = state.accountId else { throw ScreenTimeFailure(message: "Sign in to sumore before choosing apps.") }
      guard !state.enabled else { throw ScreenTimeFailure(message: "Turn off your current limit before changing the selected apps.") }
      return (state.selection, accountId)
    }
  }

  func saveSelection(_ selection: FamilyActivitySelection, expectedAccountId: String) throws -> [String: Any] {
    try requireAuthorized()
    guard selection.applicationTokens.count <= 50, selection.categoryTokens.count <= 50,
          selection.webDomainTokens.count <= 50 else {
      throw ScreenTimeFailure(message: "Apple supports up to 50 apps, 50 categories, and 50 websites at once. Choose fewer items and save again.")
    }
    return try withState { state in
      guard state.accountId == expectedAccountId else {
        throw ScreenTimeFailure(message: "Your app account changed while the picker was open. Please choose apps again.")
      }
      guard !state.enabled else { throw ScreenTimeFailure(message: "Your limit was enabled while the picker was open. Turn it off before changing apps.") }
      state.selection = selection
      state.daily = nil
      state.perApp = nil
      state.applicationTokens = nil
      state.settingsChangeAllowedAt = nil
      if selectionCount(selection) == 0 { state.enabled = false; state.grant = nil }
      try reconcile(&state)
      return status(state)
    }
  }

  // The view receives only opaque tokens in-process. It never exports labels,
  // icons, token bytes, or per-app identifiers through the Expo bridge.
  func selectionSnapshot() throws -> ScreenTimeSelectionSnapshot {
    try requireAuthorized()
    return try withState { state in
      let apps = selectedApps(&state)
      return ScreenTimeSelectionSnapshot(apps: apps, selection: state.selection,
        reportGeneration: reportAvailable && state.enabled ? (state.perApp?.generation ?? state.daily?.generation) : nil)
    }
  }

  private func selectedApps(_ state: inout ScreenTimeState) -> [ScreenTimeSelectedApp] {
    let saved = state.applicationTokens ?? [:]
    let apps = state.selection.applicationTokens.map { token in
      let id = saved.first(where: { $0.value == token && UUID(uuidString: $0.key) != nil })?.key ?? UUID().uuidString
      return ScreenTimeSelectedApp(id: id, token: token,
        minutes: state.perApp?.allocations.first(where: { $0.id == id })?.minutes)
    }.sorted { $0.id < $1.id }
    // Persist only random local IDs, keeping grid order stable after refresh or
    // relaunch even for migrated shared/manual selections without allocations.
    state.applicationTokens = Dictionary(uniqueKeysWithValues: apps.map { ($0.id, $0.token) })
    return apps
  }

  func appLimitsContext() throws -> ScreenTimeAppLimitsContext {
    try requireAuthorized()
    return try withState { state in
      guard let accountId = state.accountId else { throw ScreenTimeFailure(message: "Sign in to sumore before setting app limits.") }
      guard !state.enabled else { throw ScreenTimeFailure(message: "Turn off your current limit before changing app limits.") }
      guard !state.selection.applicationTokens.isEmpty, state.selection.categoryTokens.isEmpty,
            state.selection.webDomainTokens.isEmpty else {
        throw ScreenTimeFailure(message: "Choose individual apps only for per-app limits. Categories and websites can use a shared limit.")
      }
      let apps = selectedApps(&state)
      return ScreenTimeAppLimitsContext(apps: apps, accountId: accountId, selection: state.selection)
    }
  }

  func saveAppLimits(_ minutes: [String: Int], context: ScreenTimeAppLimitsContext) throws -> [String: Any] {
    try requireAuthorized()
    guard Set(minutes.keys) == Set(context.apps.map(\.id)) else {
      throw ScreenTimeFailure(message: "Enter a limit for every selected app.")
    }
    for value in minutes.values { try ScreenTimePerAppPolicy.validate(minutes: value) }
    return try withState { state in
      guard state.accountId == context.accountId,
            state.selection.applicationTokens == context.selection.applicationTokens,
            state.selection.categoryTokens.isEmpty, state.selection.webDomainTokens.isEmpty else {
        throw ScreenTimeFailure(message: "Your account or selected apps changed. Reopen app limits and try again.")
      }
      guard !state.enabled else { throw ScreenTimeFailure(message: "Your limit was enabled while this editor was open. Turn it off before changing limits.") }
      let today = ScreenTimeDailyPolicy.dayKey(Date())
      state.perApp = ScreenTimePerAppPolicy(generation: UUID().uuidString, day: today,
        allocations: context.apps.map { app in
          // Editing a same-day limit retains an existing threshold latch when
          // the new budget is no larger. Larger budgets rely on OS backfill.
          let previous = state.perApp?.allocations.first(where: { $0.id == app.id })
          let reached = previous.flatMap { $0.minutes >= minutes[app.id]! && $0.reachedDay == today ? today : nil }
          return ScreenTimeAppAllocation(id: app.id, minutes: minutes[app.id]!, reachedDay: reached)
        })
      state.applicationTokens = Dictionary(uniqueKeysWithValues: context.apps.map { ($0.id, $0.token) })
      state.daily = nil
      state.enabled = true
      state.grant = nil
      state.settingsChangeAllowedAt = nil
      try reconcile(&state)
      return status(state)
    }
  }

  func setBlockingEnabled(_ enabled: Bool) throws -> [String: Any] {
    if !enabled && unavailableReason != nil { return getStatus() }
    if enabled { try requireAuthorized() }
    return try withState(recoverCorrupt: !enabled) { state in
      if enabled && selectionCount(state.selection) == 0 {
        throw ScreenTimeFailure(message: "Choose at least one app, category, or website first.")
      }
      if enabled && state.accountId == nil { throw ScreenTimeFailure(message: "Sign in to sumore before enabling app blocking.") }
      if !enabled && authorization != .denied {
        try ScreenTimeDisablePolicy.requireAllowed(enabled: state.enabled, deadline: state.settingsChangeAllowedAt, now: Date())
      }
      if enabled && !state.enabled, let daily = state.daily {
        state.daily = ScreenTimeDailyPolicy(minutes: daily.minutes, generation: UUID().uuidString,
          day: ScreenTimeDailyPolicy.dayKey(Date()))
      }
      if enabled && !state.enabled, var perApp = state.perApp {
        perApp.generation = UUID().uuidString
        perApp.rollover(now: Date())
        // Same-day latches stay conservative until Apple's backfilled events
        // arrive; restarting a limit must not grant a fresh allowance.
        state.perApp = perApp
      }
      state.enabled = enabled
      if !enabled { state.grant = nil; state.settingsChangeAllowedAt = nil }
      try reconcile(&state)
      return status(state)
    }
  }

  func clearSelection() throws -> [String: Any] {
    if unavailableReason != nil { return getStatus() }
    return try withState(recoverCorrupt: true) { state in
      if authorization != .denied {
        try ScreenTimeDisablePolicy.requireAllowed(enabled: state.enabled, deadline: state.settingsChangeAllowedAt, now: Date())
      }
      if state.accountId == nil { state.accountId = boundAccountId }
      state.enabled = false
      state.grant = nil
      state.selection = FamilyActivitySelection()
      state.daily = nil
      state.perApp = nil
      state.applicationTokens = nil
      state.settingsChangeAllowedAt = nil
      store.clearAllSettings()
      return status(state)
    }
  }

  func configureDailyLimit(_ minutes: Int) throws -> [String: Any] {
    try requireAuthorized()
    try ScreenTimeDailyPolicy.validate(minutes: minutes)
    return try withState { state in
      guard !state.enabled else { throw ScreenTimeFailure(message: "Turn off your current limit before changing its duration.") }
      guard state.accountId != nil, selectionCount(state.selection) > 0 else {
        throw ScreenTimeFailure(message: "Sign in and choose at least one app, category, or website first.")
      }
      state.daily = ScreenTimeDailyPolicy(minutes: minutes, generation: UUID().uuidString,
        day: ScreenTimeDailyPolicy.dayKey(Date()))
      state.perApp = nil
      state.applicationTokens = nil
      state.enabled = true
      state.grant = nil
      state.settingsChangeAllowedAt = nil
      try reconcile(&state)
      return status(state)
    }
  }

  func requestDisable() throws -> [String: Any] {
    if unavailableReason != nil { return getStatus() }
    return try withState { state in
      if state.enabled {
        state.settingsChangeAllowedAt = ScreenTimeDisablePolicy.request(existing: state.settingsChangeAllowedAt, now: Date())
      }
      return status(state)
    }
  }

  func cancelDisable() throws -> [String: Any] {
    if unavailableReason != nil { return getStatus() }
    return try withState { state in
      state.settingsChangeAllowedAt = nil
      return status(state)
    }
  }

  // Both names are checked UNDER the same lock as account/selection/grants.
  // Dated event identities prevent yesterday's delayed threshold from latching
  // today; generation prevents callbacks from old selections and accounts.
  func handleActivity(_ activity: DeviceActivityName, threshold: DeviceActivityEvent.Name? = nil) {
    guard unavailableReason == nil, isOurActivity(activity) else { return }
    if let threshold, let directory = container,
       let entry = ScreenTimePendingThreshold(activity: activity.rawValue, event: threshold.rawValue, now: Date()) {
      // This independent atomic write cannot be blocked by the main state lock.
      // If it fails, direct bounded attempts below still deliver when possible.
      try? ScreenTimeThresholdJournal(directory: directory).enqueue(entry)
    }
    for attempt in 0..<3 {
      do {
        try withState { state in
          let now = Date()
          if activity == Self.monitorName {
            // Reconcile the persisted *current* grant, never blindly re-shield.
            try reconcile(&state, now: now)
            return
          }
          guard state.enabled else { return }
          if var perApp = state.perApp {
            guard activity.rawValue == perApp.rolloverName || activity.rawValue == perApp.activityName else { return }
            if let threshold { _ = perApp.receiveThreshold(activity: activity.rawValue, event: threshold.rawValue, now: now) }
            else { perApp.rollover(now: now) }
            state.perApp = perApp
            try reconcile(&state, now: now)
            return
          }
          guard var daily = state.daily else { return }
          guard activity.rawValue == daily.rolloverName || activity.rawValue == daily.activityName else { return }
          if let threshold {
            _ = daily.receiveThreshold(activity: activity.rawValue, event: threshold.rawValue, now: now)
          } else {
            daily.rollover(now: now)
          }
          state.daily = daily
          try reconcile(&state, now: now)
        }
        return
      } catch {
        // A timeout does not clear shields or acknowledge the journal. Keep the
        // extension alive for bounded retries; a later foreground status also
        // consumes a pending event if iOS terminates this callback process.
        if (error as? ScreenTimeFailure)?.requiresReset == true { return }
        if attempt < 2 { usleep(UInt32(50_000 * (attempt + 1))) }
      }
    }
  }

  func grantTemporaryAccess(_ receipt: ScreenTimeGrant) throws -> [String: Any] {
    try requireAuthorized()
    // The JS caller MUST obtain this receipt from the authenticated claim RPC.
    // Native cannot independently authenticate a plain JS object as server data.
    return try withState { state in
      let now = Date()
      let dates = try receipt.validate(accountId: state.accountId, now: now)
      guard state.enabled, selectionCount(state.selection) > 0 else {
        throw ScreenTimeFailure(message: "Enable chosen-app blocking before applying an approval.")
      }
      state.daily?.rollover(now: now)
      state.perApp?.rollover(now: now)
      if let daily = state.daily, !daily.reached(now: now), !activeGrant(state, now: now) {
        throw ScreenTimeFailure(message: "An approved break can be applied after today's daily limit is reached.")
      }
      if let perApp = state.perApp, perApp.reachedIDs(now: now).isEmpty, !activeGrant(state, now: now) {
        throw ScreenTimeFailure(message: "An approved break can be applied after an app's daily limit is reached.")
      }
      if let active = state.grant, active.grantId.lowercased() == receipt.grantId.lowercased() {
        guard active.hasSameIdentity(as: receipt) else {
          throw ScreenTimeFailure(message: "The approval changed unexpectedly. Refresh before trying again.")
        }
        try reconcile(&state)
        return status(state)
      }
      guard state.usedGrants[receipt.grantId.lowercased()] == nil else {
        throw ScreenTimeFailure(message: "This approval was already used on this device.")
      }
      if let active = state.grant, (ScreenTimeGrant.date(active.expiresAt) ?? .distantPast) > now {
        throw ScreenTimeFailure(message: "A different approved pause is already active.")
      }
      let interval = ScreenTimeGrant.monitorInterval(start: dates.start, end: dates.end)
      // The full interval is 16/31 minutes even at late retry. The end remains
      // the server's original expiry; reopening the app never extends a grant.
      let schedule = DeviceActivitySchedule(
        intervalStart: interval.start,
        intervalEnd: interval.end,
        repeats: false
      )
      // Never lift shields when the OS rejects the expiry monitor.
      try monitor.startMonitoring(Self.monitorName, during: schedule)
      state.grant = receipt
      state.usedGrants = state.usedGrants.filter { $0.value > now.timeIntervalSince1970 }
      state.usedGrants[receipt.grantId.lowercased()] = dates.end.timeIntervalSince1970
      // withState commits this receipt before applying (and lifting) shields.
      try reconcile(&state)
      return status(state)
    }
  }
}
