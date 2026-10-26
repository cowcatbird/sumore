import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const base = new URL('../android/src/main/', import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, base)), 'utf8');
const engine = read('java/expo/modules/screentime/ScreenTimeEngine.kt');
const service = read('java/expo/modules/screentime/SumoreAccessibilityService.kt');
const nativeModule = read('java/expo/modules/screentime/ScreenTimeModule.kt');
const rules = read('java/expo/modules/screentime/ScreenTimeRules.kt');

describe('Android native privacy and safety source guards', () => {
  it('parses every approval timestamp with an explicit offset-compatible formatter', () => {
    expect(rules).toContain('OffsetDateTime.parse(value, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant().toEpochMilli()');
    const approval = rules.slice(rules.indexOf('internal data class Approval('), rules.indexOf('internal data class ActiveApproval('));
    expect(approval).not.toContain('Instant.parse');
    for (const field of ['startedAt', 'expiresAt', 'serverNow']) {
      expect(approval).toContain(`ScreenTimeRules.approvalTime(${field})`);
    }
  });
  it('allows AtomicFile to recover a backup-only interrupted write', () => {
    expect(engine).toContain('!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()');
    expect(engine).toContain('file.openRead()');
  });
  it('reuses fresh usage after policy writes without changing enforcement or permission checks', () => {
    const cache = read('java/expo/modules/screentime/UsageReadingCache.kt');
    expect(engine).toContain('usageCache.retainFor(state.owner, state.selected)');
    expect(engine).toContain('usageCache.read(state.owner, state.selected, day, time, elapsed())');
    expect(engine).toContain('liveUsage.snapshot(reading, state.selected, day)');
    expect(cache).toContain('wall - it.wall in 0..1_999 && elapsed - it.elapsed in 0..1_999');
    expect(cache).toContain('it.owner == owner && it.selected == selected && it.dayStart == dayStart');
    expect(engine).toContain('!state.consent || !AndroidUsage.permission(context) || !accessibilityConfigured()');
    expect(engine).toContain('if (next.grant?.active(now(), elapsed(), boot()) == false)');
    expect(engine).not.toContain('usageCached = null');
  });
  it('uses explicit consent and no window-content or gesture capability', () => {
    const config = read('res/xml/sumore_accessibility_service.xml');
    expect(config).toContain('android:canRetrieveWindowContent="false"');
    expect(config).toContain('android:canPerformGestures="false"');
    expect(config).toContain('android:isAccessibilityTool="false"');
    expect(engine).toContain('Read and accept the Accessibility disclosure first.');
    expect(read('res/values/strings.xml')).toContain('These are your limits, not your circle’s.');
    expect(read('res/values/strings.xml')).not.toContain('shared daily allowance');
  });
  it('uses an accessibility overlay and preserves a Home escape', () => {
    expect(service).toContain('TYPE_ACCESSIBILITY_OVERLAY');
    expect(service).toContain('performGlobalAction(GLOBAL_ACTION_HOME)');
    expect(service).toContain('if (!power.isInteractive || keyguard.isKeyguardLocked)');
    expect(read('AndroidManifest.xml')).not.toContain('QUERY_ALL_PACKAGES');
    // Inside Button.apply an unqualified foreground resolves to View's Drawable
    // property, not the service's package-name state (or compiles for null and
    // silently updates the wrong receiver).
    expect(service).toContain('this@SumoreAccessibilityService.foreground = packageName');
    expect(service).toContain('this@SumoreAccessibilityService.foreground = null');
  });
  it('keeps expensive usage checks off the accessibility thread and rejects stale results', () => {
    expect(service).toContain('worker.execute');
    expect(service).toContain('if (!polling.complete(ticket)) { evaluate(); return@post }');
    expect(service).toContain('polling.epoch == expectedEpoch');
  });
  it('keeps polling a running game without letting repeated window events cancel its checks', () => {
    expect(service).toContain('if (packageName == foreground) return');
    expect(service).toContain('val ticket = polling.begin() ?: return');
    expect(service).toContain('handler.postDelayed(tick, if (expectedPackage in state.selected) 1_000 else 5_000)');
    expect(service).toMatch(/fun refresh\(\)[\s\S]*?service\.polling\.invalidate\(\)[\s\S]*?service\.evaluate\(\)/);
    expect(service).toContain('if (justEnabled && expectedPackage == null) recoverForeground()');
    expect(service).toContain('if (foreground != null) { evaluate(); return }');
  });
  it('ignores pane title and dismissal events before changing foreground or hiding its overlay', () => {
    const eventHandler = service.slice(service.indexOf('  override fun onAccessibilityEvent'), service.indexOf('  private fun evaluate'));
    expect(eventHandler).toContain('val changes = event.contentChangeTypes');
    expect(eventHandler).toContain('paneAppeared = changes and AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_APPEARED != 0');
    expect(eventHandler).toContain('paneDisappeared = changes and AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_DISAPPEARED != 0');
    expect(eventHandler).toContain('paneTitleChanged = changes and AccessibilityEvent.CONTENT_CHANGE_TYPE_PANE_TITLE != 0');
    expect(eventHandler).toMatch(/if \(!ForegroundWindowEventPolicy\.canMoveForeground\([\s\S]*?\)\) return/);
    const guard = eventHandler.indexOf('ForegroundWindowEventPolicy.canMoveForeground');
    expect(guard).toBeLessThan(eventHandler.indexOf('hideOverlay()'));
    expect(guard).toBeLessThan(eventHandler.indexOf('foreground = packageName'));
    const executable = eventHandler.replace(/\/\/[^\n]*/g, '');
    expect(executable).not.toMatch(/event\.(text|source|records)|rootInActiveWindow|getWindows\(/);
  });
  it('reports the live service connection separately from its enabled Settings entry', () => {
    expect(engine).toContain('"accessibilityServiceConnected" to connected');
    expect(engine).toContain('"accessibilityServiceConnected" to SumoreAccessibilityService.connected');
    expect(engine).toContain('"accessibilityEnabled" to accessibility');
  });
  it('prepares the picker off MAIN and returns to MAIN only for dialog work', () => {
    expect(nativeModule).toMatch(/pickerWork\(ticket, work = \{\s+val \(owner, selected\) = engine\.pickerContext\(\)\s+val choices = AppSafety\.choices\(context\)/);
    expect(nativeModule).toMatch(/pickerWorker\.execute \{[\s\S]*?val result = runCatching\(work\)[\s\S]*?pickerHandler\.post/);
    expect(nativeModule).toContain('}.runOnQueue(Queues.MAIN)');
  });
  it('saves and reads picker status on the worker, including Cancel and Back', () => {
    expect(nativeModule).toContain('completePicker(ticket) { engine.saveSelection(owner, packages) }');
    expect(nativeModule.match(/completePicker\(ticket\) \{ engine\.status\(\) \}/g)).toHaveLength(4);
    expect(nativeModule).toMatch(/private fun completePicker[\s\S]*?pickerWork\(ticket, work\)/);
    expect(nativeModule).not.toMatch(/\.resolve\(engine\./);
  });
  it('guards preparing and finishing sessions against duplicates and activity teardown', () => {
    expect(nativeModule).toContain('val ticket = pickerSession.begin(promise)');
    expect(nativeModule).toContain('OnActivityDestroys { closePicker() }');
    expect(nativeModule).toContain('if (!pickerSession.isCurrent(ticket)) return@post');
    expect(nativeModule).toContain('if (pickerTicket !== ticket) return');
    expect(nativeModule).toContain('pickerSession.interrupt() ?: return');
    expect(nativeModule).toContain('pickerWorker.shutdownNow()');
  });
  it('keeps app labels, icons and per-app allocations in a native view and validates saving against its original account', () => {
    const view = read('java/expo/modules/screentime/ScreenTimeSelectionView.kt');
    expect(nativeModule).toContain('View(ScreenTimeSelectionView::class)');
    expect(nativeModule).toContain('AsyncFunction("presentAppLimits")');
    expect(nativeModule).toContain('engine.saveAppLimits(initial, limits)');
    expect(nativeModule).toContain('SOFT_INPUT_ADJUST_RESIZE');
    expect(view).toContain('getApplicationIcon');
    expect(view).not.toContain('sendEvent');
    expect(engine).toContain('state.owner == initial.owner && state.selected == initial.selected');
    expect(engine).toContain('AppLimitPolicy.validate(state.selected, limits)');
    expect(engine).toContain('"limitMode" to if (state.appMinutes == null) "shared" else "perApp"');
    expect(engine).toContain('AppLimitPolicy.consumed(it, limits)');
  });
  it('advances observed foreground time when OEM usage events are late, without blindly overriding system UI', () => {
    expect(service).toContain('engine.enforcement(expectedPackage, ticket.foregroundSession, observedElapsed)');
    expect(service).toContain('polling.canRecover(state.usageForeground, state.usageForegroundAt, foregroundObservedAt)');
    expect(engine).toContain('liveUsage.merge(usage(state)');
    expect(engine).toContain('liveUsage.clear()');
  });
});
