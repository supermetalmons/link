export type AutomoveWorkerFailurePolicy =
  "main-thread-fallback" | "pause-and-retry";

const initialWatchAutomoveWorkerRetryDelayMs = 1_000;
const maximumWatchAutomoveWorkerRetryDelayMs = 15_000;

export const getWatchAutomoveWorkerRetryDelayMs = (
  consecutiveFailures: number,
): number =>
  Math.min(
    initialWatchAutomoveWorkerRetryDelayMs *
      2 ** Math.min(Math.max(consecutiveFailures, 0), 4),
    maximumWatchAutomoveWorkerRetryDelayMs,
  );

export const getAutomoveWorkerFailurePolicy = (
  isWatchAutomove: boolean,
): AutomoveWorkerFailurePolicy =>
  isWatchAutomove ? "pause-and-retry" : "main-thread-fallback";
