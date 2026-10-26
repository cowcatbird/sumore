package expo.modules.screentime

/**
 * TYPE_WINDOW_STATE_CHANGED also reports pane changes, not just app switches.
 * A title change or a disappearing pane cannot establish a new foreground app.
 * In particular, a late dismissal from SystemUI must not displace the selected
 * app that already resumed, or all subsequent checks can target SystemUI.
 *
 * Consume only the event's change flags, never its text, source or view tree.
 * Keep legacy/unknown events and an explicit appearance on the existing path;
 * combined appearance/removal can represent a replacement pane.
 *
 * This does not infer what is behind a disappearing pane. If Android supplies
 * no return-window/resume event, the service keeps the conservative foreground
 * recovery rule rather than covering possibly still-visible system controls.
 */
internal object ForegroundWindowEventPolicy {
  fun canMoveForeground(paneAppeared: Boolean, paneDisappeared: Boolean, paneTitleChanged: Boolean): Boolean =
    paneAppeared || (!paneDisappeared && !paneTitleChanged)
}
