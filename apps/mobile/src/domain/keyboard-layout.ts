type InputRevealGeometry = {
  inputTop: number;
  inputHeight: number;
  viewportTop: number;
  viewportHeight: number;
  keyboardTop: number;
  scrollY: number;
  gap: number;
  bottomObstruction?: number;
};

/** Window-space measurements work with both a resized Android window and the
 * iOS keyboard-inset viewport. Return a content-space scroll offset. */
export function getInputRevealOffset({ inputTop, inputHeight, viewportTop, viewportHeight, keyboardTop, scrollY, gap, bottomObstruction = 0 }: InputRevealGeometry) {
  const bottom = Math.min(viewportTop + viewportHeight, keyboardTop) - bottomObstruction;
  if (bottom <= viewportTop) return scrollY;
  const overlap = inputTop + inputHeight + gap - bottom;
  const above = inputTop - gap - viewportTop;
  const delta = inputHeight + gap * 2 > bottom - viewportTop
    ? above
    : overlap > 0 ? overlap : above < 0 ? above : 0;
  return Math.max(0, scrollY + delta);
}

/** Measure the real window position, not the parent's relative y (a modal's
 * local y=0 can actually be halfway down the phone's screen). */
export function getKeyboardToolbarBottom(viewportTop: number, viewportHeight: number, keyboardTop: number) {
  return Math.max(0, viewportTop + viewportHeight - keyboardTop);
}
