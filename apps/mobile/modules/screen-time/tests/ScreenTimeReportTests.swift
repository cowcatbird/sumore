import Foundation

@main
struct ScreenTimeReportTests {
  static func main() {
    precondition(sumoreRemainingMinutes(allocated: 30, reportedSeconds: 0, reached: true) == 0,
      "A confirmed threshold must override a stale zero-usage report")
    precondition(sumoreRemainingMinutes(allocated: 30, reportedSeconds: 1200, reached: true) == 0,
      "A shared exhausted budget must not show remaining time")
    let game = sumoreRemainingMinutes(allocated: 30, reportedSeconds: 600, reached: true)!
    let video = sumoreRemainingMinutes(allocated: 60, reportedSeconds: 900, reached: false)!
    precondition(game + video == 45, "One reached app must not discard another app's remaining budget")
    precondition(sumoreRemainingMinutes(allocated: 30, reportedSeconds: 1800, reached: false) == 0)
    precondition(sumoreRemainingMinutes(allocated: 30, reportedSeconds: 9000, reached: false) == 0)
    precondition(sumoreRemainingMinutes(allocated: 1, reportedSeconds: 30, reached: false) == 0.5)
    precondition(sumoreRemainingMinutes(allocated: 1440, reportedSeconds: 0, reached: false) == 1440)
    for seconds in [-1.0, Double.infinity, Double.nan] {
      precondition(sumoreRemainingMinutes(allocated: 30, reportedSeconds: seconds, reached: false) == nil)
    }
    for minutes in [0, -1, 1441] {
      precondition(sumoreRemainingMinutes(allocated: minutes, reportedSeconds: 0, reached: false) == nil)
    }
    // At midnight the policy resets the latch; yesterday's reached app gets
    // today's allowance. Extra time never gets added to the daily allocation.
    precondition(sumoreRemainingMinutes(allocated: 30, reportedSeconds: 0, reached: false) == 30)
    print("ScreenTimeReport: 14 checks passed")
  }
}
