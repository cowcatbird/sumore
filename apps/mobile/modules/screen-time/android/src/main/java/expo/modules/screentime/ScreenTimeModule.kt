package expo.modules.screentime

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.WindowManager
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

class ScreenTimeModule : Module() {
  private val context: Context get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()
  private val engine: ScreenTimeEngine get() = ScreenTimeEngine.get(context)
  private val pickerHandler = Handler(Looper.getMainLooper())
  private val pickerWorker = Executors.newSingleThreadExecutor()
  private val pickerSession = PickerSession<Promise>()
  private val destroyed = AtomicBoolean(false)
  // Only read or write dialog references on MAIN. Engine and package-manager
  // work runs on pickerWorker, including Save, Cancel and Android's Back action.
  private var picker: AlertDialog? = null
  private var pickerTicket: PickerSession.Ticket<Promise>? = null

  override fun definition() = ModuleDefinition {
    Name("ScreenTimeModule")
    View(ScreenTimeSelectionView::class) {
      Prop("refreshKey") { view: ScreenTimeSelectionView, _: Double -> view.refresh() }
    }
    OnActivityEntersForeground { SumoreAccessibilityService.ownAppForeground() }
    OnDestroy {
      destroyed.set(true)
      closePicker()
      pickerWorker.shutdownNow()
    }
    OnActivityDestroys { closePicker() }

    AsyncFunction("getStatus") { engine.status() }
    AsyncFunction("requestAuthorization") {
      engine.requireDisclosure()
      if (engine.status()["authorized"] == true) "approved" else "denied"
    }
    AsyncFunction("setAccount") { value: String? -> engine.setAccount(value) }
    AsyncFunction("setDisclosureAccepted") { accepted: Boolean -> engine.disclosure(accepted) }
    AsyncFunction("configureDailyLimit") { minutes: Int -> engine.configure(minutes) }
    AsyncFunction("setBlockingEnabled") { enabled: Boolean -> engine.setEnabled(enabled) }
    AsyncFunction("requestDisable") { engine.requestDisable() }
    AsyncFunction("cancelDisable") { engine.cancelDisable() }
    AsyncFunction("clearSelection") { engine.clear() }
    AsyncFunction("grantTemporaryAccess") { input: ApprovalInput -> engine.grant(input.receipt()) }

    AsyncFunction("openUsageAccessSettings") {
      engine.requireDisclosure()
      val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).setData(Uri.parse("package:${context.packageName}"))
      openSettings(intent, Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
      engine.status()
    }
    AsyncFunction("openAccessibilitySettings") {
      engine.requireDisclosure()
      openSettings(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
      engine.status()
    }

    AsyncFunction("presentAppPicker") { promise: Promise ->
      if (destroyed.get()) {
        promise.reject("ERR_SCREEN_TIME_INTERRUPTED", "App picker was interrupted. Reopen sumore.", null)
        return@AsyncFunction
      }
      val ticket = pickerSession.begin(promise)
      if (ticket == null) {
        promise.reject("ERR_SCREEN_TIME_SELECTION", "The app picker is already open.", null)
        return@AsyncFunction
      }
      try {
        val activity = appContext.currentActivity ?: error("Open sumore before choosing apps.")
        check(!activity.isFinishing && !activity.isDestroyed) { "Open sumore before choosing apps." }
        pickerWork(ticket, work = {
          val (owner, selected) = engine.pickerContext()
          val choices = AppSafety.choices(context)
          check(choices.isNotEmpty()) { "No eligible installed apps were found. System apps are excluded for safety." }
          Triple(owner, selected, choices)
        }) { (owner, selected, choices) ->
          check(appContext.currentActivity === activity && !activity.isFinishing && !activity.isDestroyed) {
            "App picker was interrupted. Reopen it."
          }
          if (pickerSession.markShown(ticket)) {
            val checked = choices.map { it.packageName in selected }.toBooleanArray()
            val dialog = AlertDialog.Builder(activity)
              .setTitle("Choose apps")
              .setMultiChoiceItems(choices.map { it.label }.toTypedArray(), checked) { _, index, value -> checked[index] = value }
              .setPositiveButton("Save") { _, _ ->
                val packages = choices.filterIndexed { index, _ -> checked[index] }.map { it.packageName }.toSet()
                completePicker(ticket) { engine.saveSelection(owner, packages) }
              }
              .setNegativeButton("Cancel") { _, _ -> completePicker(ticket) { engine.status() } }
              .create()
            dialog.setOnCancelListener { completePicker(ticket) { engine.status() } }
            picker = dialog
            pickerTicket = ticket
            dialog.show()
          }
        }
      } catch (error: Exception) {
        rejectPicker(ticket, error)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("presentAppLimits") { promise: Promise ->
      if (destroyed.get()) {
        promise.reject("ERR_SCREEN_TIME_INTERRUPTED", "App limits were interrupted. Reopen sumore.", null)
        return@AsyncFunction
      }
      val ticket = pickerSession.begin(promise)
      if (ticket == null) {
        promise.reject("ERR_SCREEN_TIME_SELECTION", "The app editor is already open.", null)
        return@AsyncFunction
      }
      try {
        val activity = appContext.currentActivity ?: error("Open sumore before setting app limits.")
        check(!activity.isFinishing && !activity.isDestroyed) { "Open sumore before setting app limits." }
        pickerWork(ticket, work = {
          val initial = engine.appLimitsContext()
          val apps = AppSafety.choices(context).filter { it.packageName in initial.selected }
          check(apps.size == initial.selected.size) { "Some apps are no longer available. Choose apps again." }
          val icons = apps.associate { it.packageName to context.packageManager.getApplicationIcon(it.packageName) }
          Triple(initial, apps, icons)
        }) { (initial, apps, icons) ->
          check(appContext.currentActivity === activity && !activity.isFinishing && !activity.isDestroyed) {
            "App limits were interrupted. Reopen them."
          }
          if (pickerSession.markShown(ticket)) {
            fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
            val fields = linkedMapOf<String, EditText>()
            val content = LinearLayout(activity).apply {
              orientation = LinearLayout.VERTICAL
              setPadding(dp(20), dp(8), dp(20), dp(16))
            }
            content.addView(TextView(activity).apply { text = "Daily minutes for each app"; setPadding(0, 0, 0, dp(12)) })
            apps.forEach { app ->
              val row = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(0, dp(6), 0, dp(6)) }
              row.addView(ImageView(activity).apply { setImageDrawable(icons[app.packageName]); importantForAccessibility = android.view.View.IMPORTANT_FOR_ACCESSIBILITY_NO },
                LinearLayout.LayoutParams(dp(36), dp(36)))
              row.addView(TextView(activity).apply { text = app.label; setPadding(dp(10), 0, dp(8), 0) },
                LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
              val field = EditText(activity).apply {
                inputType = InputType.TYPE_CLASS_NUMBER
                setSingleLine(true)
                setText(initial.limits[app.packageName].toString())
                contentDescription = "${app.label}, daily minutes"
                setSelectAllOnFocus(true)
              }
              fields[app.packageName] = field
              row.addView(field, LinearLayout.LayoutParams(dp(84), LinearLayout.LayoutParams.WRAP_CONTENT))
              content.addView(row)
            }
            val scroll = ScrollView(activity).apply { isFillViewport = false; addView(content) }
            val dialog = AlertDialog.Builder(activity).setTitle("App limits").setView(scroll)
              .setPositiveButton("Save & enable", null)
              .setNegativeButton("Cancel") { _, _ -> completePicker(ticket) { engine.status() } }.create()
            dialog.setOnCancelListener { completePicker(ticket) { engine.status() } }
            dialog.setOnShowListener {
              dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
              dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val limits = linkedMapOf<String, Int>()
                var invalid: EditText? = null
                fields.forEach { (pkg, field) ->
                  val minutes = field.text.toString().toIntOrNull()
                  if (minutes == null || !ScreenTimeRules.validMinutes(minutes)) {
                    field.error = "Use 1 to 1440 minutes"
                    if (invalid == null) invalid = field
                  } else limits[pkg] = minutes
                }
                if (invalid != null) { invalid?.requestFocus(); return@setOnClickListener }
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
                completePicker(ticket) { engine.saveAppLimits(initial, limits) }
              }
            }
            picker = dialog; pickerTicket = ticket
            dialog.show()
          }
        }
      } catch (error: Exception) { rejectPicker(ticket, error) }
    }.runOnQueue(Queues.MAIN)
  }

  private fun <T> pickerWork(ticket: PickerSession.Ticket<Promise>, work: () -> T, onSuccess: (T) -> Unit) {
    try {
      pickerWorker.execute {
        if (!pickerSession.isCurrent(ticket)) return@execute
        val result = runCatching(work)
        pickerHandler.post {
          if (!pickerSession.isCurrent(ticket)) return@post
          result.fold(onSuccess = { value ->
            try { onSuccess(value) }
            catch (error: Exception) { rejectPicker(ticket, error) }
          }, onFailure = { error -> rejectPicker(ticket, error) })
        }
      }
    } catch (error: RejectedExecutionException) {
      rejectPicker(ticket, error)
    }
  }

  private fun completePicker(ticket: PickerSession.Ticket<Promise>, work: () -> Map<String, Any?>) {
    if (!pickerSession.beginCompletion(ticket)) return
    pickerWork(ticket, work) { status ->
      if (pickerSession.finish(ticket)) {
        dismissPicker(ticket)
        ticket.value.resolve(status)
      }
    }
  }

  private fun rejectPicker(ticket: PickerSession.Ticket<Promise>, error: Throwable) {
    if (pickerSession.finish(ticket)) {
      dismissPicker(ticket)
      ticket.value.reject("ERR_SCREEN_TIME_SELECTION", error.message, error)
    }
  }

  private fun dismissPicker(ticket: PickerSession.Ticket<Promise>) {
    if (pickerTicket !== ticket) return
    val dialog = picker
    picker = null; pickerTicket = null
    // Android may already have removed the activity's window during teardown.
    runCatching { dialog?.setOnCancelListener(null); dialog?.dismiss() }
  }

  private fun closePicker() {
    val ticket = pickerSession.interrupt() ?: return
    ticket.value.reject("ERR_SCREEN_TIME_INTERRUPTED", "App picker was interrupted. Reopen it.", null)
    pickerHandler.post { dismissPicker(ticket) }
  }

  private fun openSettings(intent: Intent, fallback: Intent? = null) {
    try { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    catch (error: Exception) {
      if (fallback == null) throw IllegalStateException("Android settings could not be opened. Open them manually.", error)
      context.startActivity(fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }
}

class ApprovalInput : Record {
  @Field var grantId: String = ""
  @Field var requesterId: String = ""
  @Field var requestId: String? = null
  @Field var source: String = "request"
  @Field var startedAt: String = ""
  @Field var expiresAt: String = ""
  @Field var serverNow: String = ""
  internal fun receipt() = Approval(grantId, requesterId, requestId, startedAt, expiresAt, serverNow, source)
}
