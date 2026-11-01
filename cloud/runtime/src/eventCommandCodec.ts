import {
  isEventRecord,
  isEventParticipantRecord,
  isEventParticipants,
  isEventMatchRecord,
  isEventRoundRecord,
  isEventRounds,
  isEventPrizeAssignments,
  isEventAnnouncements,
} from "./shared/events.js";
import {
  isEventPrizeAssignmentWireRecord,
  type EventPrizeAssignmentWireRecord,
} from "./shared/event-prizes.js";
import {
  readInviteDocument,
  type EventInviteDocument,
} from "./shared/invite-records.js";
import {
  CONTROLLER_VERSION,
  isMatchFenWithinLimit,
  type MatchCreationRecord,
} from "./shared/match-protocol.js";
import {
  MATCH_TIMER_TERMINAL,
  isMatchTimer,
  isTimerClaim,
  type ClaimedTimerWrite,
} from "./shared/timers.js";
import { isCanonicalLoginUid, isSafeRecordKey } from "./shared/ids.js";
import { isAura, isEmojiId } from "./shared/appearance.js";
import type {
  EventMutation,
  EventEffect,
  EventFieldMutation,
} from "./eventCommands.js";
import type { EventProgressOutboxRecord } from "./events.js";
import {
  retainEventProgressRecord,
  readEventProgressPending,
} from "./eventProgressRecords.js";
import { retainEventProjectionOutbox } from "./eventProjectionOutboxRecords.js";
import { readEventTelegramProjectionDocument } from "./telegram/eventProjectionRecords.js";

export function eventCommandRecord(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(): never {
  throw new TypeError("invalid-canonical-event-command");
}
function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !eventCommandRecord(value) ||
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  )
    invalid();
  return value;
}
function key(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    !isSafeRecordKey(value)
  )
    invalid();
  return value;
}
function integer(value: unknown, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    invalid();
  return value;
}
function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value);
}
function text(value: unknown): string {
  if (typeof value !== "string") invalid();
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}
function keys(value: unknown): Record<string, string> {
  if (!eventCommandRecord(value)) invalid();
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [key(name), key(item)]),
  );
}
function assignment(value: unknown): EventPrizeAssignmentWireRecord {
  if (!isEventPrizeAssignmentWireRecord(value)) invalid();
  return value;
}

export function parseEventProgressCommandRecord(
  value: unknown,
): EventProgressOutboxRecord {
  const record = readEventProgressPending(value);
  if (!record) invalid();
  return record;
}

const telegramProjectionState = readEventTelegramProjectionDocument;

function parseEventField(row: Record<string, unknown>): EventFieldMutation {
  const eventId = key(row.eventId);
  const field = row.field;
  const value = row.value;
  switch (field) {
    case "createdAtMs":
    case "startAtMs":
    case "updatedAtMs":
    case "bracketSize":
    case "roundCount":
      return { kind: "event-field", eventId, field, value: integer(value) };
    case "endedAtMs":
    case "startedAtMs":
    case "currentRoundIndex":
    case "prizeSelectionsLockedAtMs":
      return {
        kind: "event-field",
        eventId,
        field,
        value: nullableInteger(value),
      };
    case "winnerDisplayName":
      return {
        kind: "event-field",
        eventId,
        field,
        value: nullableText(value),
      };
    case "winnerProfileId":
      return {
        kind: "event-field",
        eventId,
        field,
        value: value === null ? null : key(value),
      };
    case "status":
      if (
        value !== "scheduled" &&
        value !== "active" &&
        value !== "ended" &&
        value !== "dismissed"
      )
        invalid();
      return { kind: "event-field", eventId, field, value };
    case "participants":
      if (!isEventParticipants(value)) invalid();
      return { kind: "event-field", eventId, field, value };
    case "rounds":
      if (!isEventRounds(value)) invalid();
      return { kind: "event-field", eventId, field, value };
    case "thirdPlaceMatch":
      if (value !== null && !isEventMatchRecord(value)) invalid();
      return { kind: "event-field", eventId, field, value };
    case "prizeAssignments":
      if (!isEventPrizeAssignments(value, eventId)) invalid();
      return { kind: "event-field", eventId, field, value: { ...value } };
    case "isSundayMons":
      return { kind: "event-field", eventId, field, value: boolean(value) };
    case "telegramAnnouncements":
      if (!isEventAnnouncements(value)) invalid();
      return { kind: "event-field", eventId, field, value };
    default:
      return invalid();
  }
}

export function parseEventMutation(value: unknown): EventMutation {
  if (!eventCommandRecord(value)) invalid();
  const kind = value.kind;
  const body = value.value;
  switch (kind) {
    case "event": {
      exact(value, ["kind", "eventId", "value"]);
      const eventId = key(value.eventId);
      if (!isEventRecord(body) || body.eventId !== eventId) invalid();
      return { kind, eventId, value: body };
    }
    case "event-field":
      exact(value, ["kind", "eventId", "field", "value"]);
      return parseEventField(value);
    case "event-round": {
      exact(value, ["kind", "eventId", "roundKey", "value"]);
      const roundKey = key(value.roundKey);
      if (
        body !== null &&
        (!isEventRoundRecord(body) || String(body.roundIndex) !== roundKey)
      )
        invalid();
      return { kind, eventId: key(value.eventId), roundKey, value: body };
    }
    case "event-match-status": {
      exact(value, ["kind", "eventId", "roundKey", "matchKey", "value"]);
      if (
        body !== "upcoming" &&
        body !== "pending" &&
        body !== "host" &&
        body !== "guest" &&
        body !== "bye"
      )
        invalid();
      return {
        kind,
        eventId: key(value.eventId),
        roundKey: key(value.roundKey),
        matchKey: key(value.matchKey),
        value: body,
      };
    }
    case "event-participant": {
      exact(value, ["kind", "eventId", "profileId", "value"]);
      const profileId = key(value.profileId);
      if (
        body !== null &&
        (!isEventParticipantRecord(body) || body.profileId !== profileId)
      )
        invalid();
      return { kind, eventId: key(value.eventId), profileId, value: body };
    }
    case "event-disqualification":
      exact(value, ["kind", "eventId", "roundKey", "matchKey", "value"]);
      return {
        kind,
        eventId: key(value.eventId),
        roundKey: value.roundKey === null ? null : key(value.roundKey),
        matchKey: key(value.matchKey),
        value: boolean(body),
      };
    case "prize-selections":
      exact(value, ["kind", "eventId", "value"]);
      return {
        kind,
        eventId: key(value.eventId),
        value: body === null ? null : keys(body),
      };
    case "prize-selection":
      exact(value, ["kind", "eventId", "profileId", "value"]);
      return {
        kind,
        eventId: key(value.eventId),
        profileId: key(value.profileId),
        value: body === null ? null : key(body),
      };
    case "profile-prizes": {
      exact(value, ["kind", "profileId", "value"]);
      const profileId = key(value.profileId);
      if (body === null) return { kind, profileId, value: null };
      if (!eventCommandRecord(body)) invalid();
      return {
        kind,
        profileId,
        value: Object.fromEntries(
          Object.entries(body).map(([eventId, item]) => {
            const prize = assignment(item);
            if (prize.profileId !== profileId || prize.eventId !== eventId)
              invalid();
            return [key(eventId), prize];
          }),
        ),
      };
    }
    case "profile-prize": {
      exact(value, ["kind", "eventId", "profileId", "value"]);
      const eventId = key(value.eventId);
      const profileId = key(value.profileId);
      const prize = body === null ? null : assignment(body);
      if (prize && (prize.eventId !== eventId || prize.profileId !== profileId))
        invalid();
      return { kind, eventId, profileId, value: prize };
    }
    case "progress-outbox":
      exact(value, ["kind", "outboxId", "value"]);
      return {
        kind,
        outboxId: key(value.outboxId),
        value: body === null ? null : parseEventProgressCommandRecord(body),
      };
    case "progress-dead": {
      exact(value, ["kind", "outboxId", "value"]);
      const outboxId = key(value.outboxId);
      if (body === null) return { kind, outboxId, value: null };
      return { kind, outboxId, value: retainEventProgressRecord("dead", body) };
    }
    case "progress-dispatched":
      exact(value, ["kind", "outboxId", "value"]);
      return { kind, outboxId: key(value.outboxId), value: integer(body) };
    case "profile-game-outbox":
      exact(value, ["kind", "eventId", "value"]);
      return {
        kind,
        eventId: key(value.eventId),
        value:
          body === null
            ? null
            : retainEventProjectionOutbox("profile-game", body),
      };
    case "telegram-outbox":
      exact(value, ["kind", "eventId", "value"]);
      return {
        kind,
        eventId: key(value.eventId),
        value:
          body === null ? null : retainEventProjectionOutbox("telegram", body),
      };
    case "profile-game-outbox-field": {
      exact(value, ["kind", "eventId", "field", "value"]);
      const eventId = key(value.eventId);
      const field = value.field;
      switch (field) {
        case "schemaVersion":
          if (body !== 1) invalid();
          return { kind, eventId, field, value: body };
        case "status":
          if (body !== "pending") invalid();
          return { kind, eventId, field, value: body };
        case "requestId":
          return { kind, eventId, field, value: key(body) };
        case "lastQueuedAtMs":
        case "deadAtMs":
          return { kind, eventId, field, value: nullableInteger(body) };
        case "reason":
          return { kind, eventId, field, value: nullableText(body) };
        default:
          return invalid();
      }
    }
    case "profile-game-outbox-cleanup":
      exact(value, ["kind", "eventId", "profileId", "value"]);
      if (body !== true && body !== null) invalid();
      return {
        kind,
        eventId: key(value.eventId),
        profileId: key(value.profileId),
        value: body,
      };
    case "telegram-state":
      exact(value, ["kind", "eventId", "value"]);
      return {
        kind,
        eventId: key(value.eventId),
        value: body === null ? null : telegramProjectionState(body),
      };
    case "telegram-generation":
      exact(value, ["kind", "eventId", "value"], ["increment"]);
      return {
        kind,
        eventId: key(value.eventId),
        value: integer(body),
        ...(Object.hasOwn(value, "increment")
          ? { increment: boolean(value.increment) }
          : {}),
      };
    default:
      return invalid();
  }
}

export function parseEventInvite(value: unknown): EventInviteDocument {
  const invite = readInviteDocument(value);
  if (!invite || invite.kind !== "event") invalid();
  return structuredClone(invite);
}

function parseEventMatchCreation(value: unknown): MatchCreationRecord {
  const row = exact(value, [
    "schemaVersion",
    "version",
    "color",
    "emojiId",
    "aura",
    "gameVariant",
    "fen",
    "status",
    "flatMovesString",
    "timer",
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.version !== CONTROLLER_VERSION ||
    (row.color !== "white" && row.color !== "black") ||
    row.status !== "active" ||
    row.flatMovesString !== "" ||
    !isMatchTimer(row.timer) ||
    row.timer.state !== "idle" ||
    !isMatchFenWithinLimit(row.fen) ||
    !isEmojiId(row.emojiId) ||
    !isAura(row.aura)
  )
    invalid();
  return {
    schemaVersion: 1,
    version: CONTROLLER_VERSION,
    color: row.color,
    emojiId: row.emojiId,
    aura: row.aura,
    gameVariant: text(row.gameVariant),
    fen: row.fen,
    status: "active",
    flatMovesString: "",
    timer: { state: "idle" },
  };
}
function parseEventTimerClaim(value: unknown): ClaimedTimerWrite {
  if (!isTimerClaim(value) || value.status !== "claimed") invalid();
  return structuredClone(value);
}

export function parseEventEffect(value: unknown): EventEffect {
  if (!eventCommandRecord(value)) invalid();
  const kind = value.kind;
  switch (kind) {
    case "invite": {
      exact(value, ["kind", "inviteId", "value"]);
      const invite = readInviteDocument(parseEventInvite(value.value));
      if (!invite) invalid();
      return { kind, inviteId: key(value.inviteId), value: invite };
    }
    case "match-creation":
      exact(value, ["kind", "playerId", "matchId", "value"]);
      if (!isCanonicalLoginUid(value.playerId)) invalid();
      return {
        kind,
        playerId: value.playerId,
        matchId: key(value.matchId),
        value: parseEventMatchCreation(value.value),
      };
    case "match-terminal-timer":
      exact(value, ["kind", "playerId", "matchId", "value"]);
      if (
        !isCanonicalLoginUid(value.playerId) ||
        !isMatchTimer(value.value) ||
        value.value.state !== "finished"
      )
        invalid();
      return {
        kind,
        playerId: value.playerId,
        matchId: key(value.matchId),
        value: MATCH_TIMER_TERMINAL,
      };
    case "match-timer-start-cleanup":
      exact(value, ["kind", "playerId", "matchId"]);
      if (!isCanonicalLoginUid(value.playerId)) invalid();
      return { kind, playerId: value.playerId, matchId: key(value.matchId) };
    case "match-timer-claim":
      exact(value, ["kind", "matchId", "value"]);
      return {
        kind,
        matchId: key(value.matchId),
        value: parseEventTimerClaim(value.value),
      };
    default:
      return invalid();
  }
}

export function parseEventMutations(value: unknown): EventMutation[] {
  if (!Array.isArray(value)) invalid();
  const entries: unknown[] = value;
  return entries.map(parseEventMutation);
}
export function parseEventEffects(value: unknown): EventEffect[] {
  if (!Array.isArray(value)) invalid();
  const entries: unknown[] = value;
  return entries.map(parseEventEffect);
}
