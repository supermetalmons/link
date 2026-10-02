import {
  eventField,
  getEventField,
  type EventCommand,
  type EventMutation,
} from "../../../runtime/eventCommands.js";
import {
  createEventBracketRuntime,
  type EventBracketRuntime,
} from "../../../runtime/events/bracket.js";
import type {
  EVENT_LOCK_REFRESH_INTERVAL_MS,
  EVENT_LOCK_TTL_MS,
} from "../../../runtime/events/lockManagerCore.js";
import type { EventOwnershipSnapshot } from "../../../runtime/events/ownership.js";
import type {
  TelegramFailure,
  TelegramResult,
  TelegramSuccess,
} from "../../../runtime/telegram/client.js";
import {
  buildTelegramDeliveryTaskId,
  normalizeTaskPayload,
  type TelegramTaskPayload,
} from "../../../runtime/telegram/taskIdentity.js";

type Assert<T extends true> = T;
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? true
    : false;
type Rejects<Value, Contract> = Value extends Contract ? false : true;
type IsAny<T> = 0 extends 1 & T ? true : false;

export type EventLockTtlRetainsItsLiteralType = Assert<
  Equal<typeof EVENT_LOCK_TTL_MS, 30_000>
>;
export type EventLockRefreshIntervalRetainsItsLiteralType = Assert<
  Equal<typeof EVENT_LOCK_REFRESH_INTERVAL_MS, 10_000>
>;

type StatusCommand = Extract<
  EventMutation,
  { kind: "event-field"; field: "status" }
>;
export type EventFieldRetainsItsDiscriminant = Assert<
  Equal<ReturnType<typeof eventField<"status">>, StatusCommand>
>;
export type EventFieldReadRetainsItsValueType = Assert<
  Equal<
    ReturnType<typeof getEventField<"status">>,
    StatusCommand["value"] | undefined
  >
>;
export type EventStatusRejectsNonStatusValues = Assert<
  Rejects<number | "unknown", Parameters<typeof eventField<"status">>[2]>
>;
export type UnknownEventCommandsAreRejected = Assert<
  Rejects<{ kind: "arbitrary"; eventId: string; value: true }, EventCommand>
>;
export type UnknownEventFieldsAreRejected = Assert<
  Rejects<
    { kind: "event-field"; eventId: string; field: "arbitrary"; value: true },
    EventMutation
  >
>;
export type EventFieldsRejectWrongValueTypes = Assert<
  Rejects<
    { kind: "event-field"; eventId: string; field: "status"; value: number },
    EventMutation
  >
>;
export type MatchCreationRequiresActorIdentity = Assert<
  Rejects<{ kind: "match-creation"; matchId: string; value: {} }, EventCommand>
>;

type ThirdPlaceInput = Parameters<
  EventBracketRuntime["reconcileThirdPlaceMatchReadiness"]
>[0];
type ThirdPlaceBase = {
  eventId: string;
  rounds: {};
  nowMs: number;
  participantsById: {};
  inviteUpdates: [];
  thirdPlaceMatch: null;
};
export type ReadOnlyThirdPlaceReconciliationNeedsNoOwnership = Assert<
  ThirdPlaceBase & { allowInviteCreation: false } extends ThirdPlaceInput
    ? true
    : false
>;
export type ThirdPlaceCreationRequiresOwnership = Assert<
  Rejects<ThirdPlaceBase & { allowInviteCreation: true }, ThirdPlaceInput>
>;
export type DefaultThirdPlaceCreationRequiresOwnership = Assert<
  Rejects<ThirdPlaceBase, ThirdPlaceInput>
>;
export type MatchReadersMustReturnPairs = Assert<
  Rejects<
    { readMatchPair(): Promise<string> },
    NonNullable<Parameters<typeof createEventBracketRuntime>[0]>
  >
>;

export function supportedBracketCalls(ownership: EventOwnershipSnapshot) {
  const runtime = createEventBracketRuntime();
  const bracket = runtime.buildFixedBracketState({
    eventId: "event",
    participantIds: [],
    participantsById: {},
    nowMs: 1,
    ownershipSnapshot: ownership,
  });
  const reconciliation = runtime.reconcileThirdPlaceMatchReadiness({
    eventId: "event",
    rounds: {},
    nowMs: 1,
    participantsById: {},
    inviteUpdates: [],
    thirdPlaceMatch: null,
    allowInviteCreation: false,
  });
  return { bracket, reconciliation };
}

export const taskIdentitySignature: (payload: TelegramTaskPayload) => string =
  buildTelegramDeliveryTaskId;
export type NormalizedTelegramPayloadIsChecked = Assert<
  Equal<IsAny<ReturnType<typeof normalizeTaskPayload>>, false>
>;
export type IncompleteTelegramProofIsRejected = Assert<
  Rejects<
    {
      messageKey: string;
      revision: string;
      taskKind: "rate-limit-proof";
      retrySequence: number;
      generation: string;
    },
    TelegramTaskPayload
  >
>;
export type CompleteTelegramProofIsAccepted = Assert<
  {
    messageKey: string;
    revision: string;
    taskKind: "rate-limit-proof";
    retrySequence: number;
    generation: string;
    proofTaskKind: "desired";
    barrierProofOwner: string;
    barrierRetryNotBeforeMs: number;
  } extends TelegramTaskPayload
    ? true
    : false
>;
export type TelegramResultDiscriminatesSuccess = Assert<
  Equal<Extract<TelegramResult, { ok: true }>, TelegramSuccess>
>;
export type TelegramResultDiscriminatesFailure = Assert<
  Equal<Extract<TelegramResult, { ok: false }>, TelegramFailure>
>;
export function telegramResultSummary(result: TelegramResult): string {
  return result.ok ? result.outcome : result.classification;
}
