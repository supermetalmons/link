import type {
  MatchStateCreation,
  MatchStateEventEffectsRequest,
  MatchStatePair,
  MatchStatePairRequest,
} from "../src/matchStateTypes.ts";
export {
  StateRepositoryFailure,
  StateRepositoryPermissionDenied,
  STATE_SERVER_TIMESTAMP,
  stateIncrement,
} from "../src/stateCompatibility.ts";

export type StateQuery = {
  endAt?: string | number | boolean | null;
  equalTo?: string | number | boolean | null;
  limitToFirst?: number;
  orderBy?: string;
  shallow?: boolean;
  startAt?: string | number | boolean | null;
};

export type StateTransactionResult = {
  committed: boolean;
  decision?: string;
  value: unknown;
};

export type StateRepository = {
  readMatchPair?: (
    input: Omit<MatchStatePairRequest, "epoch">,
    signal?: AbortSignal,
  ) => Promise<MatchStatePair>;
  readMatchPairs?: (
    inputs: readonly Omit<MatchStatePairRequest, "epoch">[],
    signal?: AbortSignal,
  ) => Promise<MatchStatePair[]>;
  createMatchRecords?: (
    input: {
      inviteId: string;
      transitionId: string;
      records: MatchStateCreation[];
    },
    signal?: AbortSignal,
  ) => Promise<void>;
  applyMatchEventEffects?: (
    input: Omit<MatchStateEventEffectsRequest, "epoch">,
    signal?: AbortSignal,
  ) => Promise<void>;
  getPath: (
    path: string,
    query?: StateQuery,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  patchRoot: (
    updates: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<void>;
  transactPath: (
    path: string,
    updater: (current: unknown) => unknown,
    signal?: AbortSignal,
    beforeWrite?: (attempt: {
      current: unknown;
      proposed: unknown;
      etag: string;
    }) => Promise<void>,
  ) => Promise<StateTransactionResult>;
};
