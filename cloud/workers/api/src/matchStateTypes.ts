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

export type MatchStateJson =
  | null
  | boolean
  | number
  | string
  | MatchStateJson[]
  | { [key: string]: MatchStateJson };

export type MatchStateRecord = { [key: string]: MatchStateJson };

export type MatchStateAuthority = { inviteId: string; epoch: number };

export type MatchStateRecordRequest = MatchStateAuthority & {
  matchId: string;
  playerId: string;
};

export type MatchStatePairRequest = MatchStateRecordRequest & {
  opponentId: string | null;
};

export type MatchStatePair = MatchStatePairRequest & {
  revision: number;
  playerMatch: MatchStateRecord | null;
  opponentMatch: MatchStateRecord | null;
  claim: MatchStateRecord | null;
};

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
  value: MatchStateRecord;
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
    value: MatchStateRecord;
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

export type MatchStateEffect = {
  effectId: string;
  inviteId: string;
  matchId: string;
  playerId: string;
  opponentId: string;
  epoch: number;
  claimedAtMs: number;
  eventId: string | null;
  sourceKey: string;
  reason: "timer-claimed";
  nextAtMs: number;
  attempts: number;
};

export type MatchStateEventEffectsRequest = MatchStateAuthority & {
  operationId: string;
  creations?: MatchStateCreation[];
  terminalTimers?: Array<{ matchId: string; playerId: string }>;
  claims?: Array<{
    matchId: string;
    playerId: string;
    opponentId: string;
    claim: MatchStateRecord;
  }>;
};

export type MatchStateOperations = {
  readRecord(input: MatchStateRecordRequest): MatchStateRecord | null;
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
