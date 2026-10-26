/** A native pager also emits page callbacks for button-driven changes. Only
 * accept adjacent pages from a swipe that began on the still-current slide.
 * Reaching the final page is navigation, never permission to finish the tour. */
export function createTourPagerNavigation(stepCount: number) {
  let step = 0;
  let enabled = false;
  let origin: number | null = null;
  return {
    update(nextStep: number, canSwipe: boolean) {
      if (step !== nextStep || !canSwipe) origin = null;
      step = nextStep;
      enabled = canSwipe;
    },
    start() { origin = enabled ? step : null; },
    cancel() { origin = null; },
    select(nextStep: number) {
      const accepted = enabled && origin === step && Number.isInteger(nextStep)
        && nextStep >= 0 && nextStep < stepCount && Math.abs(nextStep - step) === 1;
      origin = null;
      return accepted;
    },
  };
}
