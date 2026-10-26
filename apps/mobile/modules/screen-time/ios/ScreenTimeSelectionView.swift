import ExpoModulesCore
import FamilyControls
import ManagedSettings
import SwiftUI
import UIKit
import DeviceActivity

// Match AppColorsDark. Keep this scoped to the embedded surface, not the
// separately presented system picker or per-app editor.
private enum SelectionPalette {
  static let ink = Color(red: 255 / 255.0, green: 243 / 255.0, blue: 222 / 255.0)
  static let inkSoft = Color(red: 170 / 255.0, green: 189 / 255.0, blue: 186 / 255.0)
  static let ember = Color(red: 255 / 255.0, green: 173 / 255.0, blue: 102 / 255.0)
}

// Keep these in step with selectedAppsGridHeight in selected-apps.tsx. The
// embedded ScrollView can still grow/scroll its content at larger Dynamic Type
// sizes; these are minimum dimensions, not a clipped fixed-height text box.
private enum SelectionGridGeometry {
  static let minimumColumn: CGFloat = 88
  static let columnSpacing: CGFloat = 12
  static let rowSpacing: CGFloat = 16
  static let minimumTileHeight: CGFloat = 104
  static let verticalPadding: CGFloat = 8
  static let stackSpacing: CGFloat = 12
  static let reportHeight: CGFloat = 104
}

// Use the same layout for application, category and website tokens. Apple's
// default category/site label is horizontal, which truncates inside a grid.
// A shared LabelStyle also centers the title underneath the icon without
// scaling the remote icon beyond the space reserved for it.
private struct SelectionTileLabelStyle: LabelStyle {
  var minutes: Int? = nil

  func makeBody(configuration: Configuration) -> some SwiftUI.View {
    VStack(alignment: .center, spacing: 6) {
      configuration.icon
        .frame(width: 40, height: 40, alignment: .center)
        .accessibilityHidden(true)
      configuration.title
        .font(.caption)
        .multilineTextAlignment(.center)
        .lineLimit(2, reservesSpace: true)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, minHeight: 34, alignment: .top)
      // Reserve the same allowance line for every tile, even in a mixed grid.
      Text(minutes.map { "\($0) min" } ?? " ")
        .font(.caption2)
        .foregroundStyle(SelectionPalette.inkSoft)
        .frame(minHeight: 16)
        .accessibilityHidden(minutes == nil)
    }
    .frame(maxWidth: .infinity, minHeight: SelectionGridGeometry.minimumTileHeight, alignment: .top)
    .accessibilityElement(children: .combine)
  }
}

// Display-only, device-local surface. System Label resolves private tokens;
// names, icons and tokens never become bridge props or events.
final class ScreenTimeSelectionView: ExpoView {
  private let engine = ScreenTimeEngine()
  private let hosting = UIHostingController(rootView: ScreenTimeSelectionContent(snapshot: nil, refreshKey: 0))
  private var revision = 0

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    hosting.overrideUserInterfaceStyle = .dark
    hosting.view.backgroundColor = .clear
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    hosting.view.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    // Use the controller that actually owns this view, not the window's root
    // controller. React Native Screens gives each tab its own controller;
    // assigning the root as parent raises UIViewControllerHierarchyInconsistency.
    guard window != nil, let parent = containingViewController(),
          !(parent is UINavigationController), !(parent is UITabBarController) else {
      detachHostingController()
      return
    }
    if hosting.parent !== parent {
      detachHostingController()
      // UIKit requires containment before adding the child's view, and didMove
      // only after insertion. Repeated window callbacks must not add it twice.
      parent.addChild(hosting)
      addSubview(hosting.view)
      hosting.view.frame = bounds
      hosting.didMove(toParent: parent)
    }
    reload()
  }

  private func containingViewController() -> UIViewController? {
    // Use UIKit directly: React's UIView category is not exposed to this pod
    // when Expo's precompiled frameworks are used.
    var responder: UIResponder? = next
    while let current = responder {
      if let controller = current as? UIViewController { return controller }
      responder = current.next
    }
    return nil
  }

  private func detachHostingController() {
    // A snapshot queued before switching tabs must not repopulate a detached
    // surface (or a surface subsequently mounted for another account).
    revision += 1
    if hosting.parent != nil { hosting.willMove(toParent: nil) }
    hosting.view.removeFromSuperview()
    hosting.removeFromParent()
    hosting.rootView = ScreenTimeSelectionContent(snapshot: nil, refreshKey: revision)
  }

  func reload() {
    revision += 1
    let current = revision
    // Clear first so a changed/revoked account never flashes a previous grid.
    hosting.rootView = ScreenTimeSelectionContent(snapshot: nil, refreshKey: current)
    // Expo can set refreshKey before UIKit has mounted the view. Wait until
    // containment is complete before loading any of Apple's remote labels.
    guard window != nil, hosting.parent != nil,
          (try? engine.requireAvailable()) != nil else { return }
    let authorization: ScreenTimeAuthorization
    switch AuthorizationCenter.shared.authorizationStatus {
    case .approved: authorization = .approved
    case .denied: authorization = .denied
    default: authorization = .notDetermined
    }
    let engine = self.engine
    ScreenTimeExecution.queue.async { [weak self] in
      engine.updateAuthorization(authorization)
      let snapshot = try? engine.selectionSnapshot()
      DispatchQueue.main.async { [weak self] in
        guard let self, current == self.revision,
              self.window != nil, self.hosting.parent != nil else { return }
        self.hosting.rootView = ScreenTimeSelectionContent(snapshot: snapshot, refreshKey: current)
      }
    }
  }
}

private struct ScreenTimeSelectionContent: SwiftUI.View {
  let snapshot: ScreenTimeSelectionSnapshot?
  let refreshKey: Int
  var body: some SwiftUI.View {
    ScrollView {
      VStack(spacing: SelectionGridGeometry.stackSpacing) {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: SelectionGridGeometry.minimumColumn),
                                    spacing: SelectionGridGeometry.columnSpacing)],
                  alignment: .center, spacing: SelectionGridGeometry.rowSpacing) {
          ForEach(snapshot?.apps ?? []) { app in
            Label(app.token).labelStyle(SelectionTileLabelStyle(minutes: app.minutes))
          }
          if let selection = snapshot?.selection {
            ForEach(Array(selection.categoryTokens), id: \.self) { token in
              Label(token).labelStyle(SelectionTileLabelStyle())
            }
            ForEach(Array(selection.webDomainTokens), id: \.self) { token in
              Label(token).labelStyle(SelectionTileLabelStyle())
            }
          }
        }
        if let snapshot, let generation = snapshot.reportGeneration {
          let bounds = ScreenTimeDailyPolicy.dayBounds(Date())
          ZStack {
            Text("Remaining time unavailable").font(.caption).foregroundStyle(SelectionPalette.inkSoft)
            DeviceActivityReport(DeviceActivityReport.Context("sumore.remaining.\(generation)"),
              filter: DeviceActivityFilter(segment: .daily(during: DateInterval(start: bounds.start, end: bounds.end)),
                applications: snapshot.selection.applicationTokens, categories: snapshot.selection.categoryTokens,
                webDomains: snapshot.selection.webDomainTokens))
              .id(refreshKey)
          }
          .frame(height: SelectionGridGeometry.reportHeight)
        }
      }
      .padding(.vertical, SelectionGridGeometry.verticalPadding)
    }
    .foregroundStyle(SelectionPalette.ink)
    .tint(SelectionPalette.ember)
    .environment(\.colorScheme, .dark)
  }
}

struct ScreenTimeAppLimitsEditor: SwiftUI.View {
  let context: ScreenTimeAppLimitsContext
  let finish: ([String: Int]?) -> Void
  @State private var input: [String: String]

  init(context: ScreenTimeAppLimitsContext, finish: @escaping ([String: Int]?) -> Void) {
    self.context = context
    self.finish = finish
    _input = State(initialValue: Dictionary(uniqueKeysWithValues: context.apps.map { ($0.id, String($0.minutes ?? 30)) }))
  }

  private var validMinutes: [String: Int]? {
    var values: [String: Int] = [:]
    for app in context.apps {
      guard let text = input[app.id], !text.isEmpty, text.allSatisfy({ $0.isASCII && $0.isNumber }),
            let minutes = Int(text), (1...1440).contains(minutes) else { return nil }
      values[app.id] = minutes
    }
    return values
  }

  var body: some SwiftUI.View {
    NavigationStack {
      Form {
        Section {
          ForEach(context.apps) { app in
            HStack {
              Label(app.token)
              Spacer()
              TextField("Minutes", text: Binding(get: { input[app.id] ?? "" }, set: { input[app.id] = $0 }))
                .keyboardType(.numberPad).multilineTextAlignment(.trailing).frame(width: 72)
                .accessibilityLabel("Daily limit in minutes")
              Text("min").foregroundStyle(.secondary)
            }
          }
        } footer: { Text("1 to 1440 whole minutes per app, each day.") }
      }
      .navigationTitle("App limits")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { finish(nil) } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Enable") { if let values = validMinutes { finish(values) } }.disabled(validMinutes == nil)
        }
      }
    }
    .interactiveDismissDisabled()
  }
}
