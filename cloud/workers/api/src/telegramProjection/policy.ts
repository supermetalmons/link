import { PROFILE_BACKGROUND_SWEEP_LIMIT } from "../profileBackgroundLimits.ts";

export {
  infrastructureRetryDelaySeconds as projectionRetryDelaySeconds,
  MAX_INFRASTRUCTURE_RETRY_DELAY_SECONDS as MAX_PROJECTION_RETRY_DELAY_SECONDS,
} from "../queueRetry.ts";

export const PROJECTION_SWEEP_LIMIT = PROFILE_BACKGROUND_SWEEP_LIMIT;
export const PROJECTION_INPUT_RETRIES = 5;
