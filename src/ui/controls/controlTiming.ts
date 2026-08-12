export const CANCEL_AUTOMATCH_REVEAL_DELAY_MS = 10000;
export const NAVIGATION_PENDING_CANCEL_INTENT_TTL_MS = 60000;

export const getOutsideTapDismissThresholdMs = (mobile: boolean): number =>
  mobile ? 42 : 420;

export const didOutsideTapDismissWindowPass = (
  dismissedAtMs: number,
  now: number,
  mobile: boolean,
): boolean => now - dismissedAtMs >= getOutsideTapDismissThresholdMs(mobile);

export const rewindOutsideTapDismissedAtForReset = (
  dismissedAtMs: number,
  mobile: boolean,
): number => (mobile ? dismissedAtMs : dismissedAtMs - 1000);

export const getTimerEnableDelayMs = (
  currentProgress: number,
  target: number,
): number => Math.max(0, (target - currentProgress) * 1000);

export const hasControlDeadlineElapsed = (
  deadline: number | null,
  now: number,
): boolean => deadline !== null && now >= deadline;

export const getCancelAutomatchRevealDeadlineMs = (
  pendingRevealAtMs: number | null,
  now: number,
): number => pendingRevealAtMs ?? now + CANCEL_AUTOMATCH_REVEAL_DELAY_MS;
