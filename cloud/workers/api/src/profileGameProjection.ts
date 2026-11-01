import * as queue from "./profileGameProjection/queue.ts";
import * as recovery from "./profileGameProjection/recovery.ts";
import type {
  ProfileGameProjectionDependencies,
  ProfileGameProjectionRecoveryDependencies,
  ProfileGameProjectionSweepResult,
} from "./profileGameProjection/types.ts";

export type {
  ProfileGameProjectionDependencies,
  ProfileGameProjectionSweepResult,
} from "./profileGameProjection/types.ts";
export { profileGameProjectionRetryDelaySeconds } from "./profileGameProjection/policy.ts";
export {
  settleAutomatchProfileGameProjectionOutbox,
  processAutomatchProfileGameProjection,
  processEventProfileGameProjection,
  processProfileLinkProfileGameProjection,
  processRatingProfileGameProjection,
} from "./profileGameProjection/processing.ts";
export {
  handleProfileGameProjectionQueue,
  handleEventProfileGameProjectionQueue,
} from "./profileGameProjection/queue.ts";
export {
  claimAutomatchSweepCandidate,
  claimEventSweepCandidate,
  repairInvalidEventSweepEntry,
  handleProfileGameProjectionSweep,
} from "./profileGameProjection/recovery.ts";

export function handleProfileGameProjectionMessage(
  message: Message<unknown>,
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<void> {
  return queue.handleProfileGameProjectionMessage(message, env, dependencies);
}

export function sweepRatingProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<number> {
  return recovery.sweepRatingProfileGameProjections(env, dependencies);
}

export function sweepProfileLinkProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionDependencies = {},
): Promise<number> {
  return recovery.sweepProfileLinkProfileGameProjections(env, dependencies);
}

export function sweepProfileGameProjections(
  env: Env,
  dependencies: ProfileGameProjectionRecoveryDependencies = {},
): Promise<ProfileGameProjectionSweepResult> {
  return recovery.sweepProfileGameProjections(env, dependencies);
}
