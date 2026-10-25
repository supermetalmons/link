import type { RetainedMatchValue } from "./matchRecordCodec.ts";
import type {
  MatchStateCreation,
  MatchStateEventEffectsRequest,
  MatchStatePair,
  MatchStatePairRequest,
} from "./matchStateTypes.ts";

export type {
  TransactionDecision,
  TransactionResult,
} from "../../../runtime/transactions.js";

export type MatchStatePort = {
  readMatchRecord(
    input: { playerId: string; matchId: string },
    signal?: AbortSignal,
  ): Promise<RetainedMatchValue>;
  readMatchRecords(
    inputs: readonly { playerId: string; matchId: string }[],
    signal?: AbortSignal,
  ): Promise<RetainedMatchValue[]>;
  readMatchPair(
    input: Omit<MatchStatePairRequest, "epoch">,
    signal?: AbortSignal,
  ): Promise<MatchStatePair>;
  readMatchPairs(
    inputs: readonly Omit<MatchStatePairRequest, "epoch">[],
    signal?: AbortSignal,
  ): Promise<MatchStatePair[]>;
  createMatchRecords(
    input: {
      inviteId: string;
      transitionId: string;
      records: MatchStateCreation[];
    },
    signal?: AbortSignal,
  ): Promise<void>;
  applyMatchEventEffects(
    input: Omit<MatchStateEventEffectsRequest, "epoch">,
    signal?: AbortSignal,
  ): Promise<void>;
};
