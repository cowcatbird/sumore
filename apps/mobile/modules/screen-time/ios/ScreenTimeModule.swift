import ExpoModulesCore
import FamilyControls
import SwiftUI
import UIKit
import Combine

public class ScreenTimeModule: ExpoModulesCore.Module {
  private let engine = ScreenTimeEngine()
  private let engineQueue = ScreenTimeExecution.queue
  private var authorizationObserver: Combine.AnyCancellable?
  private var picker: UIViewController?
  private var pickerPromise: ExpoModulesCore.Promise?
  private var pickerSession: UUID?
  private var pickerFinishing = false

  public func definition() -> ExpoModulesCore.ModuleDefinition {
    Name("ScreenTimeModule")

    View(ScreenTimeSelectionView.self) {
      Prop("refreshKey") { (view: ScreenTimeSelectionView, _: Double) in view.reload() }
    }

    OnCreate {
      DispatchQueue.main.async {
        guard (try? self.engine.requireAvailable()) != nil else { return }
        self.authorizationObserver = AuthorizationCenter.shared.$authorizationStatus
          .receive(on: DispatchQueue.main)
          .sink { [weak self] _ in self?.refreshAuthorization() }
      }
    }
    OnAppBecomesActive {
      DispatchQueue.main.async { [weak self] in self?.refreshAuthorization() }
    }
    OnDestroy {
      DispatchQueue.main.async {
        self.authorizationObserver?.cancel()
        self.authorizationObserver = nil
        self.pickerPromise?.reject("ERR_SCREEN_TIME_INTERRUPTED", "App picker was interrupted. Please reopen it.")
        self.pickerPromise = nil
        self.pickerSession = nil
        self.picker?.dismiss(animated: false)
        self.picker = nil
      }
    }

    AsyncFunction("getStatus") { (promise: ExpoModulesCore.Promise) in
      self.perform(promise) { $0.getStatus() }
    }.runOnQueue(.main)

    AsyncFunction("requestAuthorization") { (promise: ExpoModulesCore.Promise) in
      Task { @MainActor in
        do {
          try self.engine.requireAvailable()
          do {
            try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
          } catch FamilyControlsError.authorizationCanceled {
            // Declining the system request is a valid choice, not an app error.
            // Sample the real OS status below; never manufacture approval.
          }
          let authorization = self.authorizationSnapshot()
          self.perform(promise) { engine in
            _ = engine.getStatus()
            return authorization.rawValue
          }
        } catch { promise.reject("ERR_SCREEN_TIME_AUTHORIZATION", error.localizedDescription) }
      }
    }.runOnQueue(.main)

    AsyncFunction("setAccount") { (accountId: String?, promise: ExpoModulesCore.Promise) in
      self.perform(promise) { try $0.setAccount(accountId) }
    }.runOnQueue(.main)

    AsyncFunction("setBlockingEnabled") { (enabled: Bool, promise: ExpoModulesCore.Promise) in
      self.perform(promise) { try $0.setBlockingEnabled(enabled) }
    }.runOnQueue(.main)

    AsyncFunction("configureDailyLimit") { (minutes: Int, promise: ExpoModulesCore.Promise) in
      self.perform(promise) { try $0.configureDailyLimit(minutes) }
    }.runOnQueue(.main)

    AsyncFunction("requestDisable") { (promise: ExpoModulesCore.Promise) in
      self.perform(promise) { try $0.requestDisable() }
    }.runOnQueue(.main)
    AsyncFunction("cancelDisable") { (promise: ExpoModulesCore.Promise) in
      self.perform(promise) { try $0.cancelDisable() }
    }.runOnQueue(.main)

    AsyncFunction("clearSelection") { (promise: ExpoModulesCore.Promise) in
      self.perform(promise) { try $0.clearSelection() }
    }.runOnQueue(.main)

    AsyncFunction("presentAppPicker") { (promise: ExpoModulesCore.Promise) in
      do {
        guard self.pickerSession == nil else { throw ScreenTimeFailure(message: "The app picker is already open.") }
        guard UIApplication.shared.applicationState == .active,
              self.appContext?.utilities?.currentViewController()?.viewIfLoaded?.window != nil else {
          throw ScreenTimeFailure(message: "Open sumore in the foreground before choosing apps.")
        }
        let session = UUID()
        self.pickerSession = session
        self.pickerPromise = promise
        self.pickerFinishing = false
        let authorization = self.authorizationSnapshot()
        self.engineQueue.async {
          self.engine.updateAuthorization(authorization)
          do {
            let initial = try self.engine.pickerContext()
            DispatchQueue.main.async {
              guard self.pickerSession == session else { return }
              guard UIApplication.shared.applicationState == .active,
                    let presenter = self.appContext?.utilities?.currentViewController(), presenter.viewIfLoaded?.window != nil else {
                self.finishPicker(session, error: ScreenTimeFailure(message: "Open sumore in the foreground before choosing apps."))
                return
              }
              let view = ScreenTimePicker(selection: initial.selection) { [weak self] selection in
                guard let self, self.pickerSession == session, !self.pickerFinishing else { return }
                self.pickerFinishing = true
                // Dismiss immediately; saving and even cancellation's status
                // reconciliation must never block the SwiftUI button handler.
                self.picker?.dismiss(animated: true)
                self.picker = nil
                let authorization = self.authorizationSnapshot()
                self.engineQueue.async {
                  self.engine.updateAuthorization(authorization)
                  do {
                    let status = try selection.map { try self.engine.saveSelection($0, expectedAccountId: initial.accountId) } ?? self.engine.getStatus()
                    DispatchQueue.main.async { self.finishPicker(session, status: status) }
                  } catch {
                    DispatchQueue.main.async { self.finishPicker(session, error: error) }
                  }
                }
              }
              let controller = UIHostingController(rootView: view)
              controller.isModalInPresentation = true
              self.picker = controller
              presenter.present(controller, animated: true)
            }
          } catch {
            DispatchQueue.main.async { self.finishPicker(session, error: error) }
          }
        }
      } catch { promise.reject("ERR_SCREEN_TIME_SELECTION", error.localizedDescription) }
    }.runOnQueue(.main)

    AsyncFunction("presentAppLimits") { (promise: ExpoModulesCore.Promise) in
      do {
        guard self.pickerSession == nil else { throw ScreenTimeFailure(message: "An app editor is already open.") }
        guard UIApplication.shared.applicationState == .active,
              self.appContext?.utilities?.currentViewController()?.viewIfLoaded?.window != nil else {
          throw ScreenTimeFailure(message: "Open sumore in the foreground before setting app limits.")
        }
        let session = UUID()
        self.pickerSession = session
        self.pickerPromise = promise
        self.pickerFinishing = false
        let authorization = self.authorizationSnapshot()
        self.engineQueue.async {
          self.engine.updateAuthorization(authorization)
          do {
            let context = try self.engine.appLimitsContext()
            DispatchQueue.main.async {
              guard self.pickerSession == session else { return }
              guard UIApplication.shared.applicationState == .active,
                    let presenter = self.appContext?.utilities?.currentViewController(), presenter.viewIfLoaded?.window != nil else {
                self.finishPicker(session, error: ScreenTimeFailure(message: "Open sumore in the foreground before setting app limits."))
                return
              }
              let view = ScreenTimeAppLimitsEditor(context: context) { [weak self] minutes in
                guard let self, self.pickerSession == session, !self.pickerFinishing else { return }
                self.pickerFinishing = true
                self.picker?.dismiss(animated: true)
                self.picker = nil
                let authorization = self.authorizationSnapshot()
                self.engineQueue.async {
                  self.engine.updateAuthorization(authorization)
                  do {
                    let status = try minutes.map { try self.engine.saveAppLimits($0, context: context) } ?? self.engine.getStatus()
                    DispatchQueue.main.async { self.finishPicker(session, status: status) }
                  } catch {
                    DispatchQueue.main.async { self.finishPicker(session, error: error) }
                  }
                }
              }
              let controller = UIHostingController(rootView: view)
              controller.isModalInPresentation = true
              self.picker = controller
              presenter.present(controller, animated: true)
            }
          } catch { DispatchQueue.main.async { self.finishPicker(session, error: error) } }
        }
      } catch { promise.reject("ERR_SCREEN_TIME_SELECTION", error.localizedDescription) }
    }.runOnQueue(.main)

    AsyncFunction("grantTemporaryAccess") { (input: ScreenTimeGrantInput, promise: ExpoModulesCore.Promise) in
      let receipt = ScreenTimeGrant(
        grantId: input.grantId, requesterId: input.requesterId, requestId: input.requestId,
        startedAt: input.startedAt, expiresAt: input.expiresAt, serverNow: input.serverNow,
        source: input.source
      )
      self.perform(promise) { try $0.grantTemporaryAccess(receipt) }
    }.runOnQueue(.main)
  }

  // Apple's authorizationStatus is main-queue-only and initially unknown.
  // Sample and enqueue on main in FIFO order. In particular, an observer event
  // reads the CURRENT property after receive(on:), rather than replaying an
  // older published value over a newer denial/picker operation.
  private func authorizationSnapshot() -> ScreenTimeAuthorization {
    dispatchPrecondition(condition: .onQueue(.main))
    guard (try? engine.requireAvailable()) != nil else { return .notDetermined }
    switch AuthorizationCenter.shared.authorizationStatus {
    case .approved: return .approved
    case .denied: return .denied
    case .notDetermined: return .notDetermined
    @unknown default: return .notDetermined
    }
  }

  private func refreshAuthorization() {
    let authorization = authorizationSnapshot()
    engineQueue.async {
      self.engine.updateAuthorization(authorization)
      _ = self.engine.getStatus()
    }
  }

  // The bridge's main-queue work is just this snapshot/handoff. File locks and
  // ManagedSettings/DeviceActivity operations remain on the worker, never a
  // synchronous main-to-worker or worker-to-main wait.
  private func perform(_ promise: ExpoModulesCore.Promise, operation: @escaping (ScreenTimeEngine) throws -> Any) {
    let authorization = authorizationSnapshot()
    engineQueue.async {
      self.engine.updateAuthorization(authorization)
      do { promise.resolve(try operation(self.engine)) }
      catch { promise.reject("ERR_SCREEN_TIME", error.localizedDescription) }
    }
  }

  // UIKit/picker identity is main-thread-only. A stale completion cannot close
  // a later picker or resolve a promise after module destruction.
  private func finishPicker(_ session: UUID, status: [String: Any]? = nil, error: Error? = nil) {
    guard pickerSession == session else { return }
    if let error { pickerPromise?.reject("ERR_SCREEN_TIME_SELECTION", error.localizedDescription) }
    else if let status { pickerPromise?.resolve(status) }
    pickerPromise = nil
    pickerSession = nil
    pickerFinishing = false
    picker?.dismiss(animated: true)
    picker = nil
  }
}

private struct ScreenTimePicker: SwiftUI.View {
  @State var selection: FamilyActivitySelection
  let finish: (FamilyActivitySelection?) -> Void

  var body: some SwiftUI.View {
    NavigationStack {
      FamilyActivityPicker(selection: $selection)
        .navigationTitle("Choose apps to block")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { finish(nil) } }
          ToolbarItem(placement: .confirmationAction) { Button("Save") { finish(selection) } }
        }
    }
    .interactiveDismissDisabled()
  }
}

// Combine also exports Record; use Expo's bridge record, not a publisher.
struct ScreenTimeGrantInput: ExpoModulesCore.Record {
  @Field var grantId: String
  @Field var requesterId: String
  @Field var requestId: String?
  @Field var source: String = "request"
  @Field var startedAt: String
  @Field var expiresAt: String
  @Field var serverNow: String
}
