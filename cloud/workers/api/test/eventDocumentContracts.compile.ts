import type {
  EventDocument,
  EventParticipantDocument,
  EventParticipantsDocument,
  EventRoundsDocument,
  EventWrite,
  EventParticipantPatch,
  EventMatchPatch,
} from "../../../runtime/events/documents.js";
import type { EventReads } from "../../../runtime/eventReads.js";
import type {
  EventMutation,
  EventFieldValues,
} from "../../../runtime/eventCommands.js";
import type {
  EventCompatibilityRecord,
  EventView,
  decodeEventView,
} from "@mons/shared/events";

type Assert<Value extends true> = Value;
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? true
    : false;
type Rejects<Value, Contract> = Value extends Contract ? false : true;

export type PlainObjectsCannotBecomeEventDocuments = Assert<
  Rejects<{ eventId: string; status: "scheduled" }, EventDocument>
>;
export type EventDocumentsHaveNoStringIndexer = Assert<
  string extends keyof EventDocument ? false : true
>;
export type ParticipantDocumentsHaveNoStringIndexer = Assert<
  string extends keyof EventParticipantDocument ? false : true
>;
export type WireCompatibilityHeadersHaveNoStringIndexer = Assert<
  string extends keyof EventCompatibilityRecord ? false : true
>;
export type EventReadsReturnDocuments = Assert<
  Equal<Awaited<ReturnType<EventReads["readEvent"]>>, EventDocument | null>
>;
export type EventCreationCommandsRequireDocuments = Assert<
  Equal<Extract<EventMutation, { kind: "event" }>["value"], EventDocument>
>;
export type EventParticipantWritesRequireDocuments = Assert<
  Equal<EventFieldValues["participants"], EventParticipantsDocument>
>;
export type EventRoundWritesRequireDocuments = Assert<
  Equal<EventFieldValues["rounds"], EventRoundsDocument>
>;
export type NewEventStatusRejectsUnknownValues = Assert<
  Rejects<"legacy-status", EventWrite["status"]>
>;
export type NewEventTimestampRejectsNumericStrings = Assert<
  Rejects<string, EventWrite["startAtMs"]>
>;
export type ParticipantStatePatchRejectsUnknownStates = Assert<
  Rejects<{ state: "legacy-state" }, EventParticipantPatch>
>;
export type MatchEmojiPatchRejectsLegacyStrings = Assert<
  Rejects<{ hostEmojiId: string }, EventMatchPatch>
>;
export type EventViewDecoderHasACompleteResult = Assert<
  Equal<ReturnType<typeof decodeEventView>, EventView | null>
>;
export type EventViewTimestampsAreNumeric = Assert<
  Equal<EventView["startAtMs"], number>
>;
