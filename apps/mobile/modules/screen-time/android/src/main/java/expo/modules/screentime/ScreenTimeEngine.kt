package expo.modules.screentime

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ComponentName
import android.content.Context
import android.os.SystemClock
import android.provider.Settings
import android.util.AtomicFile
import android.view.accessibility.AccessibilityManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

internal data class ScreenTimeState(
  val owner: String? = null,
  val selected: Set<String> = emptySet(),
  val minutes: Int? = null,
  val enabled: Boolean = false,
  val consent: Boolean = false,
  val disable: DisableWindow? = null,
  val grant: ActiveApproval? = null,
  val lastGrantStarts: Map<String, Long> = emptyMap(),
  val appMinutes: Map<String, Int>? = null,
)

internal data class Enforcement(val enabled: Boolean, val selected: Set<String>, val reached: Boolean, val paused: Boolean,
  val usageForeground: String? = null, val usageForegroundAt: Long = 0L)
internal data class AppLimitsContext(val owner: String, val selected: Set<String>, val limits: Map<String, Int>)

internal class ScreenTimeEngine private constructor(private val context: Context) {
  companion object {
    @Volatile private var shared: ScreenTimeEngine? = null
    fun get(context: Context): ScreenTimeEngine = shared ?: synchronized(this) {
      shared ?: ScreenTimeEngine(context.applicationContext).also { shared = it }
    }
  }
  // Private, excluded from Android Auto Backup. App selections never enter JS,
  // Supabase, logs, or cloud backups. The module/service use this same process.
  private val file = AtomicFile(File(context.noBackupFilesDir, "sumore-app-limits-v1.json"))
  private val usageCache = UsageReadingCache()
  private var storageError = false
  private val liveUsage = ForegroundUsageTracker()
  private fun now() = System.currentTimeMillis()
  private fun elapsed() = SystemClock.elapsedRealtime()
  private fun boot() = Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, 0)

  fun accessibilityConfigured(): Boolean {
    val manager = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
    val target = ComponentName(context, SumoreAccessibilityService::class.java)
    return manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK).any {
      ComponentName(it.resolveInfo.serviceInfo.packageName, it.resolveInfo.serviceInfo.name) == target
    }
  }

  private fun read(): ScreenTimeState {
    // On older Android, an interrupted AtomicFile write can leave only .bak.
    // Let openRead restore it instead of treating a saved limit as first run.
    if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return ScreenTimeState()
    try {
      val json = JSONObject(file.openRead().bufferedReader().use { it.readText() })
      check(json.getInt("version") == 1)
      val owner = json.optString("owner").takeIf { it.isNotEmpty() }?.let(ScreenTimeRules::uuid)
      val packages = json.getJSONArray("selected").let { list ->
        check(list.length() <= 50)
        (0 until list.length()).map { list.getString(it) }.toSet()
      }
      check(packages.all { it.matches(Regex("[A-Za-z0-9_]+(\\.[A-Za-z0-9_]+)+")) })
      val minutes = if (json.isNull("minutes")) null else json.getInt("minutes").also { check(ScreenTimeRules.validMinutes(it)) }
      val appMinutes = json.optJSONObject("appMinutes")?.let { values ->
        values.keys().asSequence().associateWith { values.getInt(it) }.also { AppLimitPolicy.validate(packages, it) }
      }
      check(appMinutes == null || minutes == null)
      val disable = json.optJSONObject("disable")?.let {
        DisableWindow(it.getLong("wall"), it.getLong("elapsed"), it.getInt("boot"))
      }
      val grant = json.optJSONObject("grant")?.let { ApprovalStorage.read(it, owner) }
      val markers = json.getJSONObject("lastGrantStarts")
      check(markers.length() <= 1_000)
      val starts = markers.keys().asSequence().associate { ScreenTimeRules.uuid(it) to markers.getLong(it).also { value -> check(value >= 0) } }
      val state = ScreenTimeState(owner, packages, minutes, json.getBoolean("enabled"), json.getBoolean("consent"), disable, grant, starts, appMinutes)
      check(!state.enabled || (owner != null && packages.isNotEmpty() && (minutes != null || appMinutes != null) && state.consent))
      return state
    } catch (error: Exception) {
      storageError = true
      throw IllegalStateException("App-limit settings could not be read. Clear your selection to start again.", error)
    }
  }

  private fun write(state: ScreenTimeState) {
    val json = JSONObject().put("version", 1).put("owner", state.owner ?: "")
      .put("selected", JSONArray(state.selected.toList())).put("minutes", state.minutes ?: JSONObject.NULL)
      .put("enabled", state.enabled).put("consent", state.consent).put("lastGrantStarts", JSONObject(state.lastGrantStarts))
    state.appMinutes?.let { json.put("appMinutes", JSONObject(it)) }
    state.disable?.let { json.put("disable", JSONObject().put("wall", it.wallDeadline).put("elapsed", it.elapsedDeadline).put("boot", it.boot)) }
    state.grant?.let { json.put("grant", ApprovalStorage.write(it)) }
    var stream: FileOutputStream? = null
    try {
      stream = file.startWrite()
      stream.write(json.toString().toByteArray(Charsets.UTF_8))
      file.finishWrite(stream)
      storageError = false
    } catch (error: Exception) {
      if (stream != null) file.failWrite(stream)
      storageError = true
      throw IllegalStateException("App-limit settings could not be saved. Clear your selection and try again.", error)
    }
    // Policy-only writes cannot change usage already measured on this device.
    // Keep the same short-lived sample for the immediate status response.
    usageCache.retainFor(state.owner, state.selected)
    if (!state.enabled) liveUsage.pause()
    SumoreAccessibilityService.refresh()
  }

  private fun reconciled(): ScreenTimeState {
    val state = read()
    var next = state
    // Permission revocation must not leave a ghost enabled status or overlay.
    // A temporary service disconnect is reported, not treated as user revocation.
    if (state.enabled && (!state.consent || !AndroidUsage.permission(context) || !accessibilityConfigured()))
      next = next.copy(enabled = false, grant = null, disable = null)
    if (next.grant?.active(now(), elapsed(), boot()) == false) next = next.copy(grant = null)
    if (next.disable?.boot?.let { it != boot() } == true) next = next.copy(disable = null)
    if (next != state) write(next)
    return next
  }

  private fun usage(state: ScreenTimeState): UsageReading {
    val time = now()
    val day = ScreenTimeRules.dayStart(time)
    val reading = usageCache.read(state.owner, state.selected, day, time, elapsed()) {
      AndroidUsage.read(context, state.selected, time)
    }
    return liveUsage.snapshot(reading, state.selected, day)
  }

  private fun requireOwner(state: ScreenTimeState): String = state.owner ?: error("Sign in before setting app limits.")
  private fun requireReady(state: ScreenTimeState) {
    requireOwner(state)
    check(state.consent) { "Read and accept the Accessibility disclosure first." }
    check(AndroidUsage.permission(context)) { "Allow Usage Access in Android Settings." }
    check(accessibilityConfigured()) { "Enable sumore app limits in Android Accessibility settings." }
    check(SumoreAccessibilityService.connected) { "Android has not connected the app-limit service. Reopen Accessibility settings and try again." }
  }
  private fun requireEditable(state: ScreenTimeState) {
    check(!state.enabled) { "Turn off app limits before changing apps or the daily allowance." }
  }
  private fun requireDisableReady(state: ScreenTimeState) {
    check(!state.enabled || state.disable?.ready(elapsed(), boot()) == true) { "Wait for the 30-second pause timer before turning off app limits." }
  }

  @Synchronized fun setAccount(value: String?): Map<String, Any?> {
    val owner = value?.let(ScreenTimeRules::uuid)
    val previous = try { read() } catch (_: Exception) {
      // Automatic account binding must not silently dismiss corruption or the
      // user's recovery confirmation. Explicit sign-out may clear private data.
      if (owner != null) return status()
      null
    }
    if (previous == null || previous.owner != owner) {
      liveUsage.clear()
      write(ScreenTimeState(owner = owner, lastGrantStarts = previous?.lastGrantStarts ?: emptyMap()))
    }
    return status()
  }

  @Synchronized fun disclosure(accepted: Boolean): Map<String, Any?> {
    val state = reconciled()
    requireOwner(state)
    write(state.copy(consent = accepted, enabled = if (accepted) state.enabled else false,
      grant = if (accepted) state.grant else null, disable = if (accepted) state.disable else null))
    return status()
  }

  @Synchronized fun pickerContext(): Pair<String, Set<String>> {
    val state = reconciled()
    requireEditable(state)
    check(state.consent) { "Read and accept the Accessibility disclosure first." }
    return requireOwner(state) to state.selected
  }

  @Synchronized fun requireDisclosure() {
    val state = reconciled()
    requireOwner(state)
    check(state.consent) { "Read and accept the Accessibility disclosure first." }
  }

  @Synchronized fun saveSelection(owner: String, packages: Set<String>): Map<String, Any?> {
    val state = reconciled()
    check(state.owner == owner) { "The app account changed. Reopen the app picker." }
    requireEditable(state)
    check(state.consent && packages.size <= 50) { "Choose up to 50 apps after accepting the disclosure." }
    val allowed = AppSafety.choices(context).map { it.packageName }.toSet()
    check(allowed.containsAll(packages)) { "One of these apps cannot be limited. Reopen the picker." }
    // Changing the selection invalidates the per-app allocation as a whole;
    // old apps must never silently retain limits for a different selection.
    write(state.copy(selected = packages, grant = null, disable = null,
      appMinutes = state.appMinutes?.takeIf { it.keys == packages }))
    return status()
  }

  @Synchronized fun appLimitsContext(): AppLimitsContext {
    val state = reconciled()
    requireEditable(state); requireReady(state)
    check(state.selected.isNotEmpty()) { "Choose apps first." }
    return AppLimitsContext(requireOwner(state), state.selected,
      state.appMinutes ?: state.selected.associateWith { state.minutes ?: 30 })
  }

  @Synchronized fun saveAppLimits(initial: AppLimitsContext, limits: Map<String, Int>): Map<String, Any?> {
    val state = reconciled()
    check(state.owner == initial.owner && state.selected == initial.selected) { "Your account or selected apps changed. Reopen app limits." }
    requireEditable(state); requireReady(state)
    AppLimitPolicy.validate(state.selected, limits)
    val allowed = AppSafety.choices(context).map { it.packageName }.toSet()
    check(allowed.containsAll(state.selected)) { "One of these apps cannot be limited. Reopen the picker." }
    usage(state)
    write(state.copy(appMinutes = limits.toMap(), minutes = null, enabled = true, disable = null, grant = null))
    return status()
  }

  @Synchronized fun selectedApps(): List<Pair<AppChoice, Int?>> {
    val state = read()
    if (!state.consent || state.owner == null) return emptyList()
    return AppSafety.choices(context).filter { it.packageName in state.selected }.map { it to state.appMinutes?.get(it.packageName) }
  }

  @Synchronized fun configure(minutes: Int): Map<String, Any?> {
    check(ScreenTimeRules.validMinutes(minutes)) { "Choose 1 to 1440 whole minutes." }
    val state = reconciled()
    requireEditable(state); requireReady(state)
    check(state.selected.isNotEmpty()) { "Choose apps first." }
    usage(state) // Don't enable if Android cannot provide a usage reading.
    write(state.copy(minutes = minutes, appMinutes = null, enabled = true, disable = null, grant = null))
    return status()
  }

  @Synchronized fun setEnabled(enabled: Boolean): Map<String, Any?> {
    val state = reconciled()
    if (enabled) {
      requireReady(state)
      check((state.minutes != null || state.appMinutes != null) && state.selected.isNotEmpty()) { "Choose apps and a daily allowance first." }
      usage(state)
    } else requireDisableReady(state)
    write(state.copy(enabled = enabled, disable = null, grant = if (enabled) state.grant else null))
    return status()
  }

  @Synchronized fun requestDisable(): Map<String, Any?> {
    val state = reconciled()
    requireOwner(state)
    if (state.enabled && state.disable == null) write(state.copy(disable = DisableWindow(now() + ScreenTimeRules.DISABLE_DELAY_MS, elapsed() + ScreenTimeRules.DISABLE_DELAY_MS, boot())))
    return status()
  }

  @Synchronized fun cancelDisable(): Map<String, Any?> {
    val state = reconciled()
    write(state.copy(disable = null))
    return status()
  }

  @Synchronized fun clear(): Map<String, Any?> {
    val state = try { reconciled() } catch (_: Exception) { null }
    if (state != null) requireDisableReady(state)
    write(ScreenTimeState(owner = state?.owner, consent = state?.consent ?: false, lastGrantStarts = state?.lastGrantStarts ?: emptyMap()))
    return status()
  }

  @Synchronized fun grant(receipt: Approval): Map<String, Any?> {
    val state = reconciled()
    requireReady(state)
    check(state.enabled && (state.minutes != null || state.appMinutes != null)) { "Enable a daily app limit before using this approval." }
    receipt.validate(state.owner, now())
    state.grant?.let { active ->
      check(active.receipt.sameIdentity(receipt)) { "Another approval is already active. Approvals cannot overlap." }
      return status() // Preserve original elapsed deadline on all retries.
    }
    check(anyReached(state, usage(state))) { "Your daily allowance has not been used yet." }
    check(receipt.start > (state.owner?.let { state.lastGrantStarts[it] } ?: 0)) { "This approval was already used or is older than the last approval." }
    val remaining = receipt.remaining(now())
    check(remaining in 1..1_800_000) { "This approval expired." }
    check(state.lastGrantStarts.size < 1_000 || state.owner in state.lastGrantStarts) { "This device has reached its app-account limit." }
    write(state.copy(grant = ActiveApproval(receipt, elapsed() + remaining, boot()), lastGrantStarts = state.lastGrantStarts + (requireOwner(state) to receipt.start)))
    return status()
  }

  @Synchronized fun enforcement(foreground: String?, foregroundSession: Long? = null, observedElapsed: Long = elapsed()): Enforcement {
    val state = reconciled()
    if (!state.enabled || !state.consent || !AndroidUsage.permission(context) || !accessibilityConfigured()) return Enforcement(false, emptySet(), false, false)
    val selected = state.selected.intersect(AppSafety.choices(context).map { it.packageName }.toSet())
    // Read on every poll even if the last accessibility package was transient.
    val reading = liveUsage.merge(usage(state), state.selected, ScreenTimeRules.dayStart(now()),
      foreground, foregroundSession, observedElapsed)
    val reached = foreground in selected && if (state.appMinutes != null)
      AppLimitPolicy.reached(reading, state.appMinutes, foreground!!) else state.minutes?.let { reading.millis >= it * 60_000L } == true
    return Enforcement(true, selected, reached, state.grant != null, reading.foregroundPackage, reading.foregroundChangedAt)
  }

  private fun anyReached(state: ScreenTimeState, reading: UsageReading): Boolean = state.appMinutes?.let { limits ->
    limits.keys.any { AppLimitPolicy.reached(reading, limits, it) }
  } ?: (state.minutes?.let { reading.millis >= it * 60_000L } == true)

  @Synchronized fun foregroundFromUsage(): String? {
    val state = reconciled()
    if (!state.consent || !state.enabled) return null
    return usage(state).foregroundPackage
  }

  @Synchronized fun status(): Map<String, Any?> {
    try {
      val state = reconciled()
      val usagePermission = AndroidUsage.permission(context)
      val accessibility = accessibilityConfigured()
      val connected = SumoreAccessibilityService.connected
      val reading = if (state.consent && usagePermission) runCatching { usage(state) }.getOrNull() else null
      val authorized = state.consent && usagePermission && accessibility && connected && reading != null && SumoreAccessibilityService.failure == null
      val reached = reading != null && anyReached(state, reading)
      val allocated = state.appMinutes?.let(AppLimitPolicy::total) ?: state.minutes
      val reason = when {
        !state.consent -> "Accept the disclosure to set up Android app limits."
        !usagePermission -> "Usage Access is off."
        !accessibility -> "The Accessibility service is off."
        !connected -> "Android has not connected the Accessibility service."
        SumoreAccessibilityService.failure != null -> SumoreAccessibilityService.failure
        reading == null -> "Android usage history is unavailable. Unlock the phone and retry."
        else -> null
      }
      return mapOf("engineAvailable" to true, "supportsPanicGrants" to true, "authorized" to authorized,
        "authorizationStatus" to if (authorized) "approved" else "notDetermined",
        "shielded" to (authorized && SumoreAccessibilityService.overlayVisible),
        "blockingEnabled" to state.enabled, "selection" to mapOf("applications" to state.selected.size, "categories" to 0, "webDomains" to 0),
        "appliedGrantId" to state.grant?.receipt?.grantId, "appliedRequestId" to state.grant?.receipt?.requestId,
        "temporaryAccessExpiresAt" to state.grant?.receipt?.expiresAt,
        "selectionDisplayAvailable" to true, "customLimitAvailable" to true,
        "reason" to reason, "requiresReset" to false, "mode" to "daily", "dailyLimitMinutes" to allocated,
        "limitMode" to if (state.appMinutes == null) "shared" else "perApp", "allocatedMinutes" to allocated,
        "dailyLimitReached" to reached, "usageMinutesToday" to reading?.let {
          (state.appMinutes?.let { limits -> AppLimitPolicy.consumed(it, limits) } ?: it.millis) / 60_000.0
        },
        "usageAccessGranted" to usagePermission, "accessibilityEnabled" to accessibility,
        "accessibilityServiceConnected" to connected,
        "consentGranted" to state.consent, "settingsChangeAllowedAt" to state.disable?.let { ScreenTimeRules.iso(it.wallDeadline) })
    } catch (error: Exception) {
      SumoreAccessibilityService.hideForFailure()
      return mapOf("engineAvailable" to true, "supportsPanicGrants" to true, "authorized" to false, "authorizationStatus" to "notDetermined",
        "shielded" to false, "blockingEnabled" to false, "selection" to mapOf("applications" to 0, "categories" to 0, "webDomains" to 0),
        "appliedGrantId" to null, "appliedRequestId" to null, "temporaryAccessExpiresAt" to null, "reason" to (error.message ?: "App-limit settings are unavailable."),
        "requiresReset" to storageError, "mode" to "daily", "dailyLimitMinutes" to null, "dailyLimitReached" to false,
        "usageMinutesToday" to null, "usageAccessGranted" to false, "accessibilityEnabled" to false,
        "accessibilityServiceConnected" to SumoreAccessibilityService.connected,
        "consentGranted" to false, "settingsChangeAllowedAt" to null)
    }
  }
}
