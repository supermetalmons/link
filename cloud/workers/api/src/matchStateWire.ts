import {
  matchCreationWireValue,
  matchWireValue,
  type MatchWireValue,
  type MatchDocument,
} from "./matchRecordCodec.ts";
import {
  timerClaimWireValue,
  type TimerClaimWireValue,
} from "./matchClaimCodec.ts";
import type {
  MatchStateCreation,
  MatchStateCreateRequest,
  MatchStateCreateResult,
  MatchStateEventEffectsRequest,
  MatchStatePair,
} from "./matchStateTypes.ts";

export type MatchStateCreationWire = Omit<MatchStateCreation, "value"> & {
  value: MatchDocument;
};
export type MatchStateCreateWireRequest = Omit<
  MatchStateCreateRequest,
  "records"
> & {
  records: MatchStateCreationWire[];
};
export type MatchStateEventEffectsWireRequest = Omit<
  MatchStateEventEffectsRequest,
  "creations" | "claims"
> & {
  creations: MatchStateCreationWire[];
  claims: Array<
    Omit<
      NonNullable<MatchStateEventEffectsRequest["claims"]>[number],
      "claim"
    > & { claim: TimerClaimWireValue }
  >;
};
export type MatchStatePairWire = Omit<
  MatchStatePair,
  "playerMatch" | "opponentMatch" | "claim"
> & {
  playerMatch: MatchWireValue;
  opponentMatch: MatchWireValue;
  claim: TimerClaimWireValue;
};
export type MatchStateCreateWireResult = Omit<
  MatchStateCreateResult,
  "records"
> & {
  records: Array<
    Omit<MatchStateCreateResult["records"][number], "value"> & {
      value: MatchWireValue;
    }
  >;
};

function creationWire(creation: MatchStateCreation): MatchStateCreationWire {
  return { ...creation, value: matchCreationWireValue(creation.value) };
}

export function matchCreateWireRequest(
  input: MatchStateCreateRequest,
): MatchStateCreateWireRequest {
  return { ...input, records: input.records.map(creationWire) };
}

export function matchEventEffectsWireRequest(
  input: MatchStateEventEffectsRequest,
): MatchStateEventEffectsWireRequest {
  const { creations, claims, ...identity } = input;
  return { ...identity, creations: creations.map(creationWire), claims };
}

export function matchPairWire(pair: MatchStatePair): MatchStatePairWire {
  return {
    ...pair,
    playerMatch: matchWireValue(pair.playerMatch),
    opponentMatch: matchWireValue(pair.opponentMatch),
    claim: timerClaimWireValue(pair.claim),
  };
}

export function matchCreateWireResult(
  result: MatchStateCreateResult,
): MatchStateCreateWireResult {
  return {
    ...result,
    records: result.records.map((record) => ({
      ...record,
      value: matchWireValue(record.value),
    })),
  };
}
