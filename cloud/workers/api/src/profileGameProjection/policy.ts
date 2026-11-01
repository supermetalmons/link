import { PROJECTION_RECOVERY_PAGE_SIZE } from "../projectionRecoveryPages.ts";
export { infrastructureRetryDelaySeconds as profileGameProjectionRetryDelaySeconds } from "../queueRetry.ts";

export const PROFILE_GAME_PROJECTION_SWEEP_LIMIT =
  PROJECTION_RECOVERY_PAGE_SIZE;
export const PROFILE_GAME_PROJECTION_SWEEP_CONCURRENCY = 10;
export const PROFILE_GAME_PROJECTION_RECOVERY_DELAY_MS = 5 * 60 * 1_000;
export const HISTORICAL_MATCH_ARCHIVE_BATCH_SIZE = 5;
