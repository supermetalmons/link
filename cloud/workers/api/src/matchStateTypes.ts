import type {
  SubmitMoveRequest,
  SubmitMoveResponse,
  SurrenderMatchRequest,
  SurrenderMatchResponse,
} from "@mons/shared/game-sessions";
import type {
  ClaimMatchVictoryByTimerRequest,
  ClaimMatchVictoryByTimerResponse,
  StartMatchTimerRequest,
  StartMatchTimerResponse,
} from "@mons/shared/timers";

import type {
  MatchCreationInput,
  RetainedMatchValue,
} from "./matchRecordCodec.ts";
import type {
  RetainedTimerClaim,
  TimerClaimDocument,
} from "./matchClaimCodec.ts";

export type MatchStateRecord = import("./matchRecordCodec.ts").MatchDocument;
export type MatchStateJson = RetainedMatchValue;

export type MatchStateAuthority = { inviteId: string; epoch: number };

export type MatchStateRecordRequest = MatchStateAuthority & {
  matchId: string;
  playerId: string;
};

export const MAX_MATCH_STATE_RECORD_READS = 8;

export type MatchStateRecordsRequest = MatchStateAuthority & {
  requests: readonly { playerId: string; matchId: string }[];
};

export type MatchStatePairRequest = MatchStateRecordRequest & {
  opponentId: string | null;
};

export type MatchStatePair = MatchStatePairRequest & {
  revision: number;
  playerMatch: RetainedMatchValue;
  opponentMatch: RetainedMatchValue;
  claim: RetainedTimerClaim;
};

export type MatchStateSyncReadRequest = MatchStatePairRequest & {
  knownRevision?: number;
};

export type MatchStateSyncReadResult = {
  epoch: number;
  revision: number;
} & (
  | { status: "unchanged" }
  | {
      status: "changed";
      playerMatch: RetainedMatchValue;
      opponentMatch: RetainedMatchValue;
    }
);

export type MatchStateSource = {
  inviteId: string | null;
  epoch: number;
  status: "empty" | "staged" | "active";
  importId: string | null;
  stagedEpoch: number | null;
  digest: string | null;
};

export type MatchStateCreation = {
  matchId: string;
  playerId: string;
  value: MatchCreationInput;
  marker: string;
};

export type MatchStateCreateRequest = MatchStateAuthority & {
  records: MatchStateCreation[];
};

export type MatchStateCreateResult = {
  records: Array<{
    matchId: string;
    playerId: string;
    outcome: "created" | "already-created";
    value: RetainedMatchValue;
  }>;
  changedMatchIds: string[];
};

export type MatchStateMoveRequest = SubmitMoveRequest & { epoch: number };
export type MatchStateSurrenderRequest = SurrenderMatchRequest & {
  epoch: number;
};
export type MatchStateStartTimerRequest = StartMatchTimerRequest & {
  epoch: number;
};
export type MatchStateClaimTimerRequest = ClaimMatchVictoryByTimerRequest & {
  epoch: number;
  eventId?: string | null;
};

export type MatchStateEffect = import("./matchEffectCodec.ts").DueMatchEffect;

export type MatchStateEventEffectsRequest = MatchStateAuthority & {
  operationId: string;
  creations?: MatchStateCreation[];
  terminalTimers?: Array<{ matchId: string; playerId: string }>;
  claims?: Array<{
    matchId: string;
    playerId: string;
    opponentId: string;
    claim: TimerClaimDocument;
  }>;
};

export type MatchStateOperations = {
  readRecord(input: MatchStateRecordRequest): RetainedMatchValue;
  readRecords(input: MatchStateRecordsRequest): RetainedMatchValue[];
  readPair(input: MatchStatePairRequest): MatchStatePair;
  createRecords(input: MatchStateCreateRequest): MatchStateCreateResult;
  move(input: MatchStateMoveRequest): SubmitMoveResponse;
  surrender(input: MatchStateSurrenderRequest): SurrenderMatchResponse;
  startTimer(
    input: MatchStateStartTimerRequest,
  ): Promise<StartMatchTimerResponse>;
  claimTimer(
    input: MatchStateClaimTimerRequest,
  ): Promise<ClaimMatchVictoryByTimerResponse>;
};
