import Foundation

// The threshold callback is stronger evidence than a cached activity report.
// Keep this pure so stale-report/latch behavior can be tested without exporting
// any real Screen Time activity outside the report extension.
func sumoreRemainingMinutes(allocated: Int, reportedSeconds: Double, reached: Bool) -> Double? {
  guard (1...1440).contains(allocated), reportedSeconds.isFinite, reportedSeconds >= 0 else { return nil }
  if reached { return 0 }
  return max(0, Double(allocated) - reportedSeconds / 60)
}

#if os(iOS)
import DeviceActivity
import FamilyControls
import ManagedSettings
import SwiftUI

// A privacy-sandboxed report: activity never leaves this extension. The shared
// App Group is READ only here and contains user settings, never reported usage.
private struct ReportPolicy: Decodable {
  let version: Int
  let enabled: Bool
  let daily: ScreenTimeDailyPolicy?
  let perApp: ScreenTimePerAppPolicy?
  let applicationTokens: [String: ApplicationToken]?
  let grant: ScreenTimeGrant?

  var generation: String? { perApp?.generation ?? daily?.generation }
  var totalMinutes: Int { perApp?.minutes ?? daily?.minutes ?? 0 }

  static func load() -> Self? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "SumoreScreenTimeAppGroup") as? String,
          let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
          let bytes = try? Data(contentsOf: directory.appendingPathComponent("sumore-screen-time-v1.json")),
          let policy = try? JSONDecoder().decode(Self.self, from: bytes), policy.version == 1, policy.enabled,
          policy.totalMinutes > 0, policy.generation != nil else { return nil }
    do {
      try policy.daily?.validateStored()
      try policy.perApp?.validateStored()
      if let perApp = policy.perApp {
        guard policy.daily == nil, let tokens = policy.applicationTokens,
              Set(tokens.values).count == tokens.count,
              Set(tokens.keys) == Set(perApp.allocations.map(\.id)) else { return nil }
      }
      return policy
    } catch { return nil }
  }
}

private struct RemainingConfiguration {
  var remainingMinutes: Double?
  var allocatedMinutes: Int = 0
  var updatedAt: Date?
  var hasExtraTime = false
}

@main
struct SumoreActivityReport: DeviceActivityReportExtension {
  var body: some DeviceActivityReportScene {
    RemainingTimeScene()
  }
}

private struct RemainingTimeScene: DeviceActivityReportScene {
  private let policy = ReportPolicy.load()
  // A generation-specific context binds this report's filter to the same saved
  // selection/budget. An old report never calculates against a new selection.
  var context: DeviceActivityReport.Context {
    DeviceActivityReport.Context("sumore.remaining.\(policy?.generation ?? "unavailable")")
  }
  let content: (RemainingConfiguration) -> RemainingTimeView = { RemainingTimeView(configuration: $0) }

  func makeConfiguration(representing data: DeviceActivityResults<DeviceActivityData>) async -> RemainingConfiguration {
    guard let policy else { return RemainingConfiguration() }
    var totalSeconds = 0.0
    var perAppSeconds: [ApplicationToken: Double] = [:]
    var sawSegment = false
    var updatedAt: Date?
    var unattributedUsage = false
    let expectedTokens = Set(policy.applicationTokens?.values.map { $0 } ?? [])
    for await device in data {
      updatedAt = min(updatedAt ?? device.lastUpdatedDate, device.lastUpdatedDate)
      for await segment in device.activitySegments {
        guard Calendar.current.isDate(segment.dateInterval.start, inSameDayAs: Date()) else { continue }
        sawSegment = true
        guard segment.totalActivityDuration.isFinite, segment.totalActivityDuration >= 0 else { return RemainingConfiguration() }
        totalSeconds += segment.totalActivityDuration
        if policy.perApp != nil {
          for await category in segment.categories {
            for await app in category.applications {
              guard app.totalActivityDuration.isFinite, app.totalActivityDuration >= 0 else { return RemainingConfiguration() }
              guard let token = app.application.token, expectedTokens.contains(token) else {
                if app.totalActivityDuration > 0 { unattributedUsage = true }
                continue
              }
              perAppSeconds[token, default: 0] += app.totalActivityDuration
            }
          }
        }
      }
    }
    guard sawSegment, let current = ReportPolicy.load(), current.generation == policy.generation else {
      return RemainingConfiguration()
    }
    let remaining: Double
    if let perApp = current.perApp, let tokens = current.applicationTokens {
      guard !unattributedUsage, perAppSeconds.values.reduce(0, +) + 1 >= totalSeconds else { return RemainingConfiguration() }
      let reached = perApp.reachedIDs(now: Date())
      var total = 0.0
      for allocation in perApp.allocations {
        guard let token = tokens[allocation.id], let left = sumoreRemainingMinutes(
          allocated: allocation.minutes, reportedSeconds: perAppSeconds[token] ?? 0,
          reached: reached.contains(allocation.id)) else { return RemainingConfiguration() }
        total += left
      }
      remaining = total
    } else {
      guard let left = sumoreRemainingMinutes(allocated: current.totalMinutes,
        reportedSeconds: totalSeconds, reached: current.daily?.reached(now: Date()) == true) else {
        return RemainingConfiguration()
      }
      remaining = left
    }
    let extraExpiry = current.grant.flatMap { ScreenTimeGrant.date($0.expiresAt) }
    return RemainingConfiguration(remainingMinutes: remaining, allocatedMinutes: current.totalMinutes,
      updatedAt: updatedAt, hasExtraTime: (extraExpiry ?? .distantPast) > Date())
  }
}

// The report is hosted in a separate extension, so it must apply the same
// AppColorsDark palette itself rather than inherit the device's appearance.
private enum ReportPalette {
  static let ground = Color(red: 10 / 255.0, green: 21 / 255.0, blue: 29 / 255.0)
  static let ink = Color(red: 255 / 255.0, green: 243 / 255.0, blue: 222 / 255.0)
  static let inkSoft = Color(red: 170 / 255.0, green: 189 / 255.0, blue: 186 / 255.0)
  static let ember = Color(red: 255 / 255.0, green: 173 / 255.0, blue: 102 / 255.0)
}

private struct RemainingTimeView: SwiftUI.View {
  let configuration: RemainingConfiguration
  var body: some SwiftUI.View {
    VStack(alignment: .leading, spacing: 7) {
      if let remaining = configuration.remainingMinutes, configuration.allocatedMinutes > 0 {
        Text("\(Int(ceil(remaining))) of \(configuration.allocatedMinutes) min left").font(.subheadline.weight(.semibold))
        ProgressView(value: remaining, total: Double(configuration.allocatedMinutes)).tint(ReportPalette.ember)
        if let updated = configuration.updatedAt {
          Text("Updated \(updated, style: .time)").font(.caption2).foregroundStyle(ReportPalette.inkSoft)
        }
        if configuration.hasExtraTime { Text("Extra time is separate.").font(.caption2).foregroundStyle(ReportPalette.inkSoft) }
      } else {
        Text("Remaining time unavailable").font(.caption).foregroundStyle(ReportPalette.inkSoft)
      }
    }
    .padding(10)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    .foregroundStyle(ReportPalette.ink)
    .background(ReportPalette.ground)
    .environment(\.colorScheme, .dark)
  }
}
#endif
