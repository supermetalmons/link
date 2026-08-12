import { isMobile } from "../utils/misc";

const MIN_TIME_BETWEEN_TOUCHSTARTS = 555;

let lastTouchStartTime = 0;

export function preventTouchstartIfNeeded(
  event: TouchEvent | MouseEvent,
): void {
  if (!isMobile) {
    return;
  }
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest(
      ".small-top-control-buttons, [data-top-right-popover='true']",
    )
  ) {
    return;
  }
  const currentTime = event.timeStamp;
  const shouldPrevent =
    currentTime - lastTouchStartTime < MIN_TIME_BETWEEN_TOUCHSTARTS;
  if (!shouldPrevent) {
    lastTouchStartTime = currentTime;
    return;
  }
  event.preventDefault();
  event.stopPropagation();
}
