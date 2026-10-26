package expo.modules.screentime

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.view.Gravity
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.Executors

/** Read-only native grid. Package IDs, labels and icons never cross the JS bridge. */
class ScreenTimeSelectionView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true
  companion object { private val worker = Executors.newSingleThreadExecutor() }
  private data class Tile(val label: String, val icon: Drawable?, val minutes: Int?)
  private val column = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
  private val scroll = ScrollView(context).apply {
    isFillViewport = false
    addView(column)
  }
  private var generation = 0
  init { addView(scroll, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)) }
  private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

  fun refresh() {
    val expected = ++generation
    column.removeAllViews()
    if (!isAttachedToWindow) return
    worker.execute {
      val result = runCatching {
        ScreenTimeEngine.get(context).selectedApps().map { (app, minutes) ->
          Tile(app.label, runCatching { context.packageManager.getApplicationIcon(app.packageName) }.getOrNull(), minutes)
        }
      }
      post {
        if (generation != expected || !isAttachedToWindow) return@post
        result.getOrNull()?.chunked(3)?.forEach { tiles ->
          val row = LinearLayout(context)
          repeat(3) { index ->
            val tile = LinearLayout(context).apply {
              orientation = LinearLayout.VERTICAL; gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
              setPadding(dp(5), dp(8), dp(5), dp(8))
            }
            tiles.getOrNull(index)?.let { data ->
              tile.addView(ImageView(context).apply {
                setImageDrawable(data.icon); importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
              }, LinearLayout.LayoutParams(dp(38), dp(38)))
              tile.addView(TextView(context).apply {
                text = data.label; textSize = 12f; gravity = Gravity.CENTER; maxLines = 2
                setTextColor(Color.rgb(245, 235, 214)); setPadding(0, dp(4), 0, 0)
              })
              data.minutes?.let { minutes -> tile.addView(TextView(context).apply {
                text = "$minutes min"; textSize = 12f; gravity = Gravity.CENTER
                setTextColor(Color.rgb(169, 187, 188))
              }) }
            }
            row.addView(tile, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
          }
          column.addView(row)
        }
      }
    }
  }

  override fun onAttachedToWindow() { super.onAttachedToWindow(); refresh() }
  override fun onDetachedFromWindow() { generation++; column.removeAllViews(); super.onDetachedFromWindow() }
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    scroll.layout(0, 0, right - left, bottom - top)
  }
}
