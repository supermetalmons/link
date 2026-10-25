import { readInviteMetadataMany } from "./automatchReadD1.ts";
import {
  createEventStateRepository,
  type EventStateRepository,
} from "./eventRepository.ts";
import type { GameSessionPort } from "./gameSessionContracts.ts";

export type EventProfileGameProjectionState = Pick<
  EventStateRepository,
  | "readEvent"
  | "readMatchRecords"
  | "readEventProfileGameProjectionOutbox"
  | "claimEventProfileGameProjectionOutbox"
  | "acknowledgeEventProfileGameProjectionOutbox"
  | "transactEventLease"
> &
  Pick<GameSessionPort, "readInviteMetadataMany">;

export function createEventProfileGameProjectionState(
  env: Env,
): EventProfileGameProjectionState {
  const state = createEventStateRepository(env);
  return {
    readEvent: state.readEvent,
    readMatchRecords: state.readMatchRecords,
    readInviteMetadataMany: (inviteIds, signal) =>
      readInviteMetadataMany(env.PROFILE_GAMES_DB, inviteIds, signal),
    readEventProfileGameProjectionOutbox:
      state.readEventProfileGameProjectionOutbox,
    claimEventProfileGameProjectionOutbox:
      state.claimEventProfileGameProjectionOutbox,
    acknowledgeEventProfileGameProjectionOutbox:
      state.acknowledgeEventProfileGameProjectionOutbox,
    transactEventLease: state.transactEventLease,
  };
}
