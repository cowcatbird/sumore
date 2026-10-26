import DeviceActivity

final class SumoreActivityMonitor: DeviceActivityMonitor {
  private let engine = ScreenTimeEngine(extensionProcess: true)

  override func intervalDidStart(for activity: DeviceActivityName) {
    super.intervalDidStart(for: activity)
    reconcile(activity)
  }

  override func intervalDidEnd(for activity: DeviceActivityName) {
    super.intervalDidEnd(for: activity)
    reconcile(activity)
  }

  private func reconcile(_ activity: DeviceActivityName) {
    engine.handleActivity(activity)
  }

  override func eventDidReachThreshold(_ event: DeviceActivityEvent.Name, activity: DeviceActivityName) {
    super.eventDidReachThreshold(event, activity: activity)
    engine.handleActivity(activity, threshold: event)
  }
}
