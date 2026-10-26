import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../ios/ScreenTimeEngine.swift', import.meta.url), 'utf8');
function method(name: string, next: string) {
  return source.slice(source.indexOf(`  func ${name}(`), source.indexOf(`  func ${next}(`));
}

// Match executable structure rather than comments or a neighboring method.
// These lifecycle blocks have no Swift string interpolation containing braces.
function swiftBlock(code: string, declaration: RegExp): string {
  const executable = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const match = declaration.exec(executable);
  expect(match, `Missing Swift declaration: ${declaration}`).not.toBeNull();
  const opening = executable.indexOf('{', match!.index);
  expect(opening).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = opening; index < executable.length; index += 1) {
    if (executable[index] === '{') depth += 1;
    if (executable[index] === '}' && --depth === 0) return executable.slice(opening + 1, index);
  }
  throw new Error(`Unclosed Swift block: ${declaration}`);
}

function expectOrdered(code: string, patterns: RegExp[]) {
  let previous = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(code);
    expect(match, `Missing lifecycle operation: ${pattern}`).not.toBeNull();
    expect(match!.index, `Lifecycle operation out of order: ${pattern}`).toBeGreaterThan(previous);
    previous = match!.index;
  }
}

// Source guards for previously observed boundary bugs, not a substitute for
// an iOS build or physical-device tests of Apple's ManagedSettings framework.
describe('native restriction serialization source regressions', () => {
  it('qualifies Expo bridge types when Combine is imported to avoid its Record name collision', () => {
    const bridge = readFileSync(new URL('../ios/ScreenTimeModule.swift', import.meta.url), 'utf8');
    expect(bridge).toContain('import Combine');
    expect(bridge).toMatch(/struct ScreenTimeGrantInput:\s*ExpoModulesCore\.Record\s*\{/);
    expect(bridge).not.toMatch(/:\s*Record\b/);
    expect(bridge).toContain('ScreenTimeModule: ExpoModulesCore.Module');
    expect(bridge).not.toMatch(/:\s*Promise\b/);
  });

  it('cannot clear another process’s valid shields after failing to acquire a lock', () => {
    const status = method('getStatus', 'setAccount');
    expect(status).not.toContain('store.clearAllSettings()');
    expect(status).toContain('Previously enabled restrictions may still be active');
    expect(status).toContain('requiresReset');
  });

  it('clears and stops only within the locked transaction, after cooldown validation', () => {
    const clear = method('clearSelection', 'configureDailyLimit');
    expect(clear.indexOf('try withState')).toBeGreaterThan(-1);
    expect(clear.indexOf('store.clearAllSettings()')).toBeGreaterThan(clear.indexOf('try withState'));
    expect(clear.indexOf('requireAllowed')).toBeLessThan(clear.indexOf('state.enabled = false'));
    expect(clear).not.toContain('monitor.stopMonitoring');
    const toggle = method('setBlockingEnabled', 'clearSelection');
    expect(toggle).not.toContain('store.clearAllSettings()');
    expect(toggle.indexOf('reconcile(&state)')).toBeGreaterThan(toggle.indexOf('try withState'));
    expect(toggle).not.toContain('monitor.stopMonitoring');
    const transaction = source.slice(source.indexOf('private func withState'), source.indexOf('private func persist'));
    expect(transaction.indexOf('try persist(state')).toBeLessThan(transaction.indexOf('applyShields(state)'));
    expect(transaction.indexOf('try persist(state')).toBeLessThan(transaction.indexOf('stopOnlyExplicit'));
    expect(transaction.indexOf('try persist(state')).toBeLessThan(transaction.indexOf('journal.acknowledge(pending)'));
    expect(transaction).toContain('entry.apply(to: &state.daily, enabled: state.enabled');
    expect(transaction).toContain('previousActivities.contains');
  });

  it('never turns empty selective cleanup or rollback into Apple stop-all', () => {
    const transaction = source.slice(source.indexOf('private func withState'), source.indexOf('private func persist'));
    expect(transaction).not.toContain('monitor.stopMonitoring');
    expect(transaction.match(/stopOnlyExplicit\(/g)).toHaveLength(2);
    expect(source.match(/monitor\.stopMonitoring\(/g)).toHaveLength(1);
    expect(source).toContain('ScreenTimeMonitorCleanup.stopOnlyExplicit(activities) { monitor.stopMonitoring($0) }');
  });

  it('keeps all blocking engine work off the UI queue, including picker and lifecycle paths', () => {
    const bridge = readFileSync(new URL('../ios/ScreenTimeModule.swift', import.meta.url), 'utf8');
    expect(bridge).toContain('private let engineQueue = ScreenTimeExecution.queue');
    const functions = bridge.split('AsyncFunction(').slice(1);
    for (const fn of functions) {
      const name = fn.match(/^"([^"]+)"/)?.[1];
      expect(fn).toContain('.runOnQueue(.main)');
      if (name !== 'presentAppPicker' && name !== 'presentAppLimits') expect(fn).toContain('self.perform(promise)');
      else expect(fn).toContain('self.engineQueue.async');
    }
    expect(bridge).toContain('.receive(on: DispatchQueue.main)');
    expect(bridge).toContain('OnAppBecomesActive {\n      DispatchQueue.main.async');
    expect(bridge).toContain('self.engineQueue.async {\n          self.engine.updateAuthorization(authorization)\n          do {\n            let initial = try self.engine.pickerContext()');
    expect(bridge).toContain('self.engineQueue.async {\n                  self.engine.updateAuthorization(authorization)\n                  do {\n                    let status = try selection.map');
    const perform = bridge.slice(bridge.indexOf('  private func perform('), bridge.indexOf('  private func finishPicker('));
    expect(perform).toContain('let authorization = authorizationSnapshot()\n    engineQueue.async');
    expect(perform.indexOf('try operation(self.engine)')).toBeGreaterThan(perform.indexOf('engineQueue.async'));
    expect(bridge).toContain('guard pickerSession == session else { return }');
    expect(bridge.match(/UIApplication\.shared\.applicationState == \.active/g)).toHaveLength(4);
    expect(bridge).not.toContain('engineQueue.sync');
    expect(bridge).not.toContain('DispatchQueue.main.sync');
  });

  it('samples authorization only on main and never treats startup unknown as token revocation', () => {
    const bridge = readFileSync(new URL('../ios/ScreenTimeModule.swift', import.meta.url), 'utf8');
    expect(source).not.toContain('AuthorizationCenter.shared');
    expect(bridge.match(/AuthorizationCenter\.shared\.authorizationStatus/g)).toHaveLength(1);
    const snapshot = bridge.slice(bridge.indexOf('  private func authorizationSnapshot('), bridge.indexOf('  private func refreshAuthorization('));
    expect(snapshot).toContain('dispatchPrecondition(condition: .onQueue(.main))');
    expect(snapshot).toContain('@unknown default: return .notDetermined');
    // Deferred observer events sample the current main-queue value, not an
    // old published value that might overwrite a newer confirmed denial.
    expect(bridge).toContain('.sink { [weak self] _ in self?.refreshAuthorization() }');
    const reconcile = source.slice(source.indexOf('  private func reconcile('), source.indexOf('  private func status('));
    expect(reconcile).toContain('if authorization.shouldResetSelection(extensionProcess: extensionProcess)');
    expect(reconcile.indexOf('state.selection = FamilyActivitySelection()')).toBeGreaterThan(reconcile.indexOf('shouldResetSelection'));
    expect(reconcile.indexOf('guard authorization.canReconcile(extensionProcess: extensionProcess) else { return }')).toBeLessThan(reconcile.indexOf('state.daily?.rollover'));
    const shields = source.slice(source.indexOf('  private func applyShields('), source.indexOf('  private func reconcile('));
    expect(shields.indexOf('shouldPreserveShields')).toBeLessThan(shields.indexOf('store.clearAllSettings()'));
    expect(source).toContain('if authorization.canReconcile(extensionProcess: extensionProcess) || !state.enabled');
    expect(source).toContain('guard !extensionProcess else { return }');
    expect(source).toContain('"authorized": currentAuthorization.permitsNewRestrictions');
    expect(method('setBlockingEnabled', 'clearSelection')).toContain('if !enabled && authorization != .denied');
    expect(method('clearSelection', 'configureDailyLimit')).toContain('if authorization != .denied');
  });

  it('accepts authorization cancellation as a choice while preserving the actual OS status and real errors', () => {
    const bridge = readFileSync(new URL('../ios/ScreenTimeModule.swift', import.meta.url), 'utf8');
    const request = swiftBlock(bridge, /AsyncFunction\("requestAuthorization"\)/);
    expect(request).toContain('Task { @MainActor in');
    expectOrdered(request, [
      /try self\.engine\.requireAvailable\(\)/,
      /try await AuthorizationCenter\.shared\.requestAuthorization\(for: \.individual\)/,
      /catch FamilyControlsError\.authorizationCanceled\s*\{\s*\}/,
      /let authorization = self\.authorizationSnapshot\(\)/,
      /self\.perform\(promise\)/,
      /_ = engine\.getStatus\(\)/,
      /return authorization\.rawValue/,
      /catch \{ promise\.reject\("ERR_SCREEN_TIME_AUTHORIZATION", error\.localizedDescription\) \}/,
    ]);
    expect(request.match(/requestAuthorization\(for:/g)).toHaveLength(1);
    expect(request).not.toMatch(/return\s+\.approved|resolve\("approved"\)|updateAuthorization\(\.approved\)/);
  });

  it('uses version-gated past activity and separate dated events, never fabricated usage', () => {
    expect(source).toContain('if #available(iOS 17.4, *)');
    expect(source).toContain('includesPastActivity: true');
    expect(source).toContain('"usageMinutesToday": NSNull()');
    expect(source).toContain('var daily: ScreenTimeDailyPolicy?');
    expect(source).toContain('var settingsChangeAllowedAt: Date?');
    expect(source).toContain('try state.daily?.validateStored()');
    expect(source).toContain('DeviceActivityName(daily.activityName)');
    expect(source).toContain('DeviceActivityEvent.Name(daily.eventName)');
    const callback = method('handleActivity', 'grantTemporaryAccess');
    expect(callback).toContain('try withState');
    expect(callback).toContain('daily.receiveThreshold');
    expect(callback.indexOf('.enqueue(entry)')).toBeLessThan(callback.indexOf('try withState'));
    expect(callback).toContain('for attempt in 0..<3');
    expect(callback).not.toContain('.acknowledge(');
    expect(callback).not.toContain('store.clearAllSettings');
    const monitor = readFileSync(new URL('../../../plugins/screen-time/SumoreActivityMonitor.swift', import.meta.url), 'utf8');
    expect(monitor).toContain('override func eventDidReachThreshold');
    expect(monitor).toContain('engine.handleActivity(activity, threshold: event)');
    expect(source).toContain('try registerGrant(state, now: now)');
    expect(source).toContain('!monitor.activities.contains(Self.monitorName)');
  });

  it('requires disabling before edits and a reached threshold before a new daily break', () => {
    expect(method('pickerContext', 'saveSelection')).toContain('guard !state.enabled');
    expect(method('saveSelection', 'setBlockingEnabled')).toContain('guard !state.enabled');
    expect(method('configureDailyLimit', 'requestDisable')).toContain('guard !state.enabled');
    expect(source.slice(source.indexOf('  func grantTemporaryAccess'))).toContain('!daily.reached(now: now), !activeGrant(state, now: now)');
  });

  it('keeps per-app limits transactional, validates stale editor identity, and journals each app threshold', () => {
    expect(source).toContain('try state.perApp?.validateStored()');
    expect(source).toContain('entry.apply(to: &state.perApp, enabled: state.enabled');
    const editor = method('saveAppLimits', 'setBlockingEnabled');
    expect(editor).toContain('try withState');
    expect(editor).toContain('state.accountId == context.accountId');
    expect(editor).toContain('state.selection.applicationTokens == context.selection.applicationTokens');
    expect(editor).toContain('guard !state.enabled');
    expect(editor).toContain('try ScreenTimePerAppPolicy.validate(minutes: value)');
    expect(source).toContain('events[DeviceActivityEvent.Name(perApp.eventName(allocation.id))]');
    expect(source).toContain('let tokens = Set(reached.compactMap { state.applicationTokens?[$0] })');
    expect(source).toContain('perApp.reachedIDs(now: now).isEmpty, !activeGrant(state, now: now)');
  });

  it('keeps labels and reports native and never writes report usage to shared storage', () => {
    const view = readFileSync(new URL('../ios/ScreenTimeSelectionView.swift', import.meta.url), 'utf8');
    const report = readFileSync(new URL('../../../plugins/screen-time/SumoreActivityReport.swift', import.meta.url), 'utf8');
    expect(view).toContain('Label(app.token)');
    expect(view).toContain('DeviceActivityReport(');
    expect(view).toContain('ScreenTimeExecution.queue.async');
    expect(view).not.toContain('EventDispatcher');
    expect(report).toContain('for await device in data');
    expect(report).toContain('current.generation == policy.generation');
    expect(report).toContain('Remaining time unavailable');
    expect(report).not.toMatch(/\.write\(|UserDefaults|URLSession|fetch\(|sendEvent/);
    expect(source).toContain('"usageMinutesToday": NSNull()');
  });

  it('uses one centered vertical tile style for private app, category and website labels', () => {
    const view = readFileSync(new URL('../ios/ScreenTimeSelectionView.swift', import.meta.url), 'utf8');
    const style = swiftBlock(view, /private\s+struct\s+SelectionTileLabelStyle:\s*LabelStyle/);
    const grid = swiftBlock(view, /private\s+struct\s+ScreenTimeSelectionContent:\s*SwiftUI\.View/);
    expect(style).toContain('VStack(alignment: .center, spacing: 6)');
    expect(style).toMatch(/configuration\.icon\s*\.frame\(width: 40, height: 40, alignment: \.center\)/);
    expect(style).toContain('.multilineTextAlignment(.center)');
    expect(style).toContain('.lineLimit(2, reservesSpace: true)');
    expect(style).toContain('.fixedSize(horizontal: false, vertical: true)');
    expect(style).toContain('minHeight: SelectionGridGeometry.minimumTileHeight');
    expect(style).toContain('.accessibilityElement(children: .combine)');
    expect(style).toContain('.accessibilityHidden(minutes == nil)');
    expect(grid).toContain('Label(app.token).labelStyle(SelectionTileLabelStyle(minutes: app.minutes))');
    expect(grid.match(/Label\(token\)\.labelStyle\(SelectionTileLabelStyle\(\)\)/g)).toHaveLength(2);
    expect(grid).toContain('selection.categoryTokens');
    expect(grid).toContain('selection.webDomainTokens');
    expect(grid).toContain('ScrollView');
    expect(style + grid).not.toMatch(/scaleEffect|minimumScaleFactor|\.clipped\(/);
    // Apple resolves these views on-device; don't replace them with a bridge
    // callback or network lookup just to obtain a custom icon/title layout.
    expect(view).not.toMatch(/EventDispatcher|sendEvent|URLSession|bundleIdentifier|localizedDisplayName/);
  });

  it('attaches the app grid to its nearest screen controller before inserting its hosted view', () => {
    const view = readFileSync(new URL('../ios/ScreenTimeSelectionView.swift', import.meta.url), 'utf8');
    const initialize = swiftBlock(view, /required\s+init\s*\(/);
    expect(initialize).not.toMatch(/\baddSubview\s*\(/);
    const mount = swiftBlock(view, /override\s+func\s+didMoveToWindow\s*\(/);
    expect(mount).not.toMatch(/currentViewController\s*\(/);
    expect(mount).toMatch(/guard\s+window\s*!=\s*nil,\s*let\s+parent\s*=\s*containingViewController\s*\(\)/);
    expect(mount).toContain('!(parent is UINavigationController), !(parent is UITabBarController)');
    expectOrdered(mount, [
      /parent\.addChild\s*\(hosting\)/,
      /addSubview\s*\(hosting\.view\)/,
      /hosting\.didMove\s*\(toParent:\s*parent\)/,
    ]);
  });

  it('finds the nearest app-grid parent with UIKit rather than an unavailable React category', () => {
    const view = readFileSync(new URL('../ios/ScreenTimeSelectionView.swift', import.meta.url), 'utf8');
    const lookup = swiftBlock(view, /private\s+func\s+containingViewController\s*\(\)\s*->\s*UIViewController\?/);
    expectOrdered(lookup, [
      /var\s+responder:\s*UIResponder\?\s*=\s*next/,
      /while\s+let\s+current\s*=\s*responder/,
      /if\s+let\s+controller\s*=\s*current\s+as\?\s+UIViewController\s*\{\s*return\s+controller\s*\}/,
      /responder\s*=\s*current\.next/,
      /return\s+nil/,
    ]);
    expect(view).not.toMatch(/\breactViewController\s*\(|\bimport\s+React\b/);
    expect(lookup).not.toMatch(/rootViewController|currentViewController|window|superview/);
  });

  it('makes repeated app-grid attachment idempotent and detaches before changing parents', () => {
    const view = readFileSync(new URL('../ios/ScreenTimeSelectionView.swift', import.meta.url), 'utf8');
    const mount = swiftBlock(view, /override\s+func\s+didMoveToWindow\s*\(/);
    const changedParent = swiftBlock(mount, /if\s+hosting\.parent\s*!==\s*parent\s*\{/);
    expectOrdered(changedParent, [/detachHostingController\s*\(\)/, /parent\.addChild\s*\(hosting\)/]);
    expect(changedParent.match(/parent\.addChild\s*\(hosting\)/g)).toHaveLength(1);
    expect(mount.match(/parent\.addChild\s*\(hosting\)/g)).toHaveLength(1);
    const missingContainer = swiftBlock(mount, /guard\s+window\s*!=\s*nil[\s\S]*?else\s*\{/);
    expectOrdered(missingContainer, [/detachHostingController\s*\(\)/, /\breturn\b/]);
  });

  it('invalidates pending app-grid snapshots and removes the hosted view before its controller', () => {
    const view = readFileSync(new URL('../ios/ScreenTimeSelectionView.swift', import.meta.url), 'utf8');
    const detach = swiftBlock(view, /private\s+func\s+detachHostingController\s*\(/);
    expectOrdered(detach, [
      /revision\s*\+=\s*1/,
      /hosting\.willMove\s*\(toParent:\s*nil\)/,
      /hosting\.view\.removeFromSuperview\s*\(\)/,
      /hosting\.removeFromParent\s*\(\)/,
    ]);
    expect(detach).toMatch(/hosting\.rootView\s*=\s*ScreenTimeSelectionContent\s*\(snapshot:\s*nil/);
  });

  it('loads app labels only while attached and rejects late results after detachment or remount', () => {
    const view = readFileSync(new URL('../ios/ScreenTimeSelectionView.swift', import.meta.url), 'utf8');
    const reload = swiftBlock(view, /\bfunc\s+reload\s*\(/);
    expectOrdered(reload, [
      /revision\s*\+=\s*1/,
      /let\s+current\s*=\s*revision/,
      /guard\s+window\s*!=\s*nil,\s*hosting\.parent\s*!=\s*nil/,
      /ScreenTimeExecution\.queue\.async/,
      /engine\.selectionSnapshot\s*\(\)/,
      /DispatchQueue\.main\.async/,
    ]);
    const completion = swiftBlock(reload, /DispatchQueue\.main\.async\s*\{/);
    expect(completion).toMatch(/\[weak\s+self\]/);
    expect(completion).toMatch(/guard\s+let\s+self,\s*current\s*==\s*self\.revision,\s*self\.window\s*!=\s*nil,\s*self\.hosting\.parent\s*!=\s*nil\s+else\s*\{\s*return\s*\}/);
    expectOrdered(completion, [/\bguard\b/, /self\.hosting\.rootView\s*=\s*ScreenTimeSelectionContent\s*\(snapshot:\s*snapshot/]);
  });
});
