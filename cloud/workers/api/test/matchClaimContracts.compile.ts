import type { ClaimedTimerWrite } from "@mons/shared/timers";
import type { EventEffect } from "../../../runtime/eventCommands.js";
import type {
  TimerClaimDocument,
  RetainedTimerClaim,
} from "../src/matchClaimCodec.ts";
import type {
  DueMatchEffect,
  TimerClaimEffectPayload,
} from "../src/matchEffectCodec.ts";
import type { writeMatchTimer } from "../src/matchRecordCodec.ts";
import type { MatchTimerStartStore } from "../src/gameplayCoordinationD1.ts";
import type { LocalMatchTimerStore } from "../src/localMatchTimerStore.ts";
import type { MatchStateEventEffectsRequest } from "../src/matchStateTypes.ts";

type Assert<Value extends true> = Value;
type Rejects<Value, Contract> = Value extends Contract ? false : true;

export type ClaimsHaveNoGenericFieldIndex = Assert<
  string extends keyof TimerClaimDocument ? false : true
>;
export type EffectsHaveNoGenericFieldIndex = Assert<
  string extends keyof DueMatchEffect ? false : true
>;
export type RawClaimRecordsNeedDecoding = Assert<
  Rejects<{ status: "claimed" }, RetainedTimerClaim>
>;
export type DomainEventClaimsRejectRetainedScalars = Assert<
  Rejects<
    false | 0 | undefined | null,
    NonNullable<MatchStateEventEffectsRequest["claims"]>[number]["claim"]
  >
>;
export type NewClaimRequiresTimestamp = Assert<
  Rejects<Omit<ClaimedTimerWrite, "claimedAtMs">, ClaimedTimerWrite>
>;
export type NewClaimRequiresTerminalStatus = Assert<
  Rejects<
    Omit<ClaimedTimerWrite, "status"> & { status: "pending" },
    ClaimedTimerWrite
  >
>;
export type NewClaimCannotHaveLiveExpiry = Assert<
  Rejects<
    Omit<ClaimedTimerWrite, "expiresAtMs"> & { expiresAtMs: number },
    ClaimedTimerWrite
  >
>;
export type EventClaimCannotBeArbitraryRecord = Assert<
  Rejects<
    {
      kind: "match-timer-claim";
      matchId: string;
      value: { status: "claimed" };
    },
    EventEffect
  >
>;
export type EventTerminalTimerCannotBeArbitraryText = Assert<
  Rejects<
    {
      kind: "match-terminal-timer";
      playerId: string;
      matchId: string;
      value: string;
    },
    EventEffect
  >
>;
export type NewEffectRequiresIdentity = Assert<
  Rejects<Omit<TimerClaimEffectPayload, "effectId">, TimerClaimEffectPayload>
>;
export type NewEffectRequiresKnownReason = Assert<
  Rejects<
    Omit<TimerClaimEffectPayload, "reason"> & { reason: string },
    TimerClaimEffectPayload
  >
>;
export type OrdinaryTimerPatchesRejectRetainedScalars = Assert<
  Rejects<
    string | number | boolean | null,
    Parameters<typeof writeMatchTimer>[0]
  >
>;
export type OrdinaryTimerCleanupKeysStayStrings = Assert<
  Rejects<number, Parameters<MatchTimerStartStore["deletePair"]>[0]>
>;
export type OrdinaryTimerModeKeysStayStrings = Assert<
  Rejects<number, Parameters<LocalMatchTimerStore["mode"]>[0]>
>;
