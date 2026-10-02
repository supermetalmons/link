import { isEventMutation } from "../../../runtime/eventCommands.js";
import type { EventMutation } from "../../../runtime/eventCommands.js";
import { isSafeRecordKey } from "./recordKeys.ts";
import type {
  EventCommand,
  EventCommitPlan,
  EventField,
} from "../../../runtime/eventCommands.js";
import type {
  EventJsonRecord,
  EventPrizeAssignmentRecord,
} from "../../../runtime/eventReads.js";
import { STATE_VALUE_FIELD } from "./stateCompatibility.ts";

export function encodeEventUpdates(
  plan: readonly EventCommand[],
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const command of plan) {
    let path: string;
    let value: unknown = "value" in command ? command.value : null;
    switch (command.kind) {
      case "event":
        path = `events/${command.eventId}`;
        break;
      case "event-field":
        path = `events/${command.eventId}/${command.field}`;
        break;
      case "event-round":
        path = `events/${command.eventId}/rounds/${command.roundKey}`;
        break;
      case "event-match-status":
        path = `events/${command.eventId}/rounds/${command.roundKey}/matches/${command.matchKey}/status`;
        break;
      case "event-participant":
        path = `events/${command.eventId}/participants/${command.profileId}`;
        break;
      case "event-disqualification":
        path =
          command.roundKey === null
            ? `events/${command.eventId}/thirdPlaceMatch/winnerDisqualified`
            : `events/${command.eventId}/rounds/${command.roundKey}/matches/${command.matchKey}/winnerDisqualified`;
        break;
      case "prize-selections":
        path = `eventPrizeSelections/${command.eventId}`;
        break;
      case "prize-selection":
        path = `eventPrizeSelections/${command.eventId}/${command.profileId}`;
        break;
      case "profile-prizes":
        path = `profileEventPrizes/${command.profileId}`;
        break;
      case "profile-prize":
        path = `profileEventPrizes/${command.profileId}/${command.eventId}`;
        break;
      case "progress-outbox":
        path = `eventProgressOutbox/${command.outboxId}`;
        break;
      case "progress-dead":
        path = `eventProgressOutboxDead/${command.outboxId}`;
        break;
      case "progress-dispatched":
        path = `eventProgressOutbox/${command.outboxId}/lastQueuedAtMs`;
        break;
      case "profile-game-outbox":
        path = `profileGameProjectionOutbox/event/${command.eventId}`;
        break;
      case "profile-game-outbox-field":
        path = `profileGameProjectionOutbox/event/${command.eventId}/${command.field}`;
        break;
      case "profile-game-outbox-cleanup":
        path = `profileGameProjectionOutbox/event/${command.eventId}/cleanupOwnerProfileIds/${command.profileId}`;
        break;
      case "telegram-outbox":
        path = `telegramProjectionOutbox/event/${command.eventId}`;
        break;
      case "telegram-state":
        path = `eventTelegramProjections/${command.eventId}`;
        break;
      case "telegram-generation":
        path = `eventTelegramProjectionGenerations/${command.eventId}`;
        value = command.increment
          ? { [STATE_VALUE_FIELD]: { increment: command.value } }
          : command.value;
        break;
      case "invite":
        path = `invites/${command.inviteId}`;
        break;
      case "match-creation":
        path = `players/${command.playerId}/matches/${command.matchId}`;
        break;
      case "match-terminal-timer":
        path = `players/${command.playerId}/matches/${command.matchId}/timer`;
        break;
      case "match-timer-start-cleanup":
        path = `matchTimerStarts/${command.matchId}/${command.playerId}`;
        break;
      case "match-timer-claim":
        path = `matchTimerClaims/${command.matchId}`;
        break;
    }
    updates[path] = value;
  }
  return updates;
}
const fields = new Set<EventField>([
  "createdAtMs",
  "endedAtMs",
  "participants",
  "startAtMs",
  "startedAtMs",
  "status",
  "winnerDisplayName",
  "winnerProfileId",
  "currentRoundIndex",
  "bracketSize",
  "roundCount",
  "rounds",
  "thirdPlaceMatch",
  "updatedAtMs",
  "prizeSelectionsLockedAtMs",
  "prizeAssignments",
  "isSundayMons",
  "telegramAnnouncements",
  "announceOnTelegram",
]);
export function decodeEventUpdates(
  updates: Readonly<Record<string, unknown>>,
): EventCommitPlan {
  return Object.entries(updates).map(([path, value]): EventCommand => {
    const p = path.split("/");
    if (p.some((part) => part !== part.trim() || !isSafeRecordKey(part)))
      throw new Error("invalid-event-path");
    const record = value as EventJsonRecord;
    if (p[0] === "events") {
      if (p.length === 4 && p[2] === "rounds")
        return {
          kind: "event-round",
          eventId: p[1],
          roundKey: p[3],
          value: record,
        };
      if (
        p.length === 7 &&
        p[2] === "rounds" &&
        p[4] === "matches" &&
        p[6] === "status"
      )
        return {
          kind: "event-match-status",
          eventId: p[1],
          roundKey: p[3],
          matchKey: p[5],
          value: value as string,
        };
      if (p.length === 2)
        return { kind: "event", eventId: p[1], value: record };
      if (p.length === 3 && fields.has(p[2] as EventField))
        return {
          kind: "event-field",
          eventId: p[1],
          field: p[2],
          value,
        } as EventCommand;
      if (p.length === 4 && p[2] === "participants")
        return {
          kind: "event-participant",
          eventId: p[1],
          profileId: p[3],
          value: record,
        };
      if (
        p.length === 4 &&
        p[2] === "thirdPlaceMatch" &&
        p[3] === "winnerDisqualified"
      )
        return {
          kind: "event-disqualification",
          eventId: p[1],
          roundKey: null,
          matchKey: "third_place",
          value: value as boolean,
        };
      if (
        p.length === 7 &&
        p[2] === "rounds" &&
        p[4] === "matches" &&
        p[6] === "winnerDisqualified"
      )
        return {
          kind: "event-disqualification",
          eventId: p[1],
          roundKey: p[3],
          matchKey: p[5],
          value: value as boolean,
        };
    }
    if (p[0] === "eventPrizeSelections") {
      if (p.length === 2)
        return {
          kind: "prize-selections",
          eventId: p[1],
          value: value as Record<string, string> | null,
        };
      if (p.length === 3)
        return {
          kind: "prize-selection",
          eventId: p[1],
          profileId: p[2],
          value: value as string | null,
        };
    }
    if (p[0] === "profileEventPrizes") {
      if (p.length === 2)
        return {
          kind: "profile-prizes",
          profileId: p[1],
          value: value as Record<string, EventPrizeAssignmentRecord> | null,
        };
      if (p.length === 3)
        return {
          kind: "profile-prize",
          profileId: p[1],
          eventId: p[2],
          value: value as EventPrizeAssignmentRecord | null,
        };
    }
    if (
      p[0] === "eventProgressOutbox" &&
      p.length === 3 &&
      p[2] === "lastQueuedAtMs"
    )
      return {
        kind: "progress-dispatched",
        outboxId: p[1],
        value: value as number,
      };
    if (p.length === 2) {
      if (p[0] === "eventProgressOutbox")
        return { kind: "progress-outbox", outboxId: p[1], value: record };
      if (p[0] === "eventProgressOutboxDead")
        return { kind: "progress-dead", outboxId: p[1], value: record };
      if (p[0] === "eventTelegramProjections")
        return { kind: "telegram-state", eventId: p[1], value: record };
      if (p[0] === "eventTelegramProjectionGenerations") {
        const increment = (
          record?.[STATE_VALUE_FIELD] as { increment?: number } | undefined
        )?.increment;
        return {
          kind: "telegram-generation",
          eventId: p[1],
          value: increment ?? (value as number),
          ...(increment === undefined ? {} : { increment: true }),
        };
      }
      if (p[0] === "invites")
        return { kind: "invite", inviteId: p[1], value: record };
      if (p[0] === "matchTimerClaims")
        return { kind: "match-timer-claim", matchId: p[1], value: record };
    }
    if (p[1] === "event" && p.length === 3) {
      if (p[0] === "profileGameProjectionOutbox")
        return { kind: "profile-game-outbox", eventId: p[2], value: record };
      if (p[0] === "telegramProjectionOutbox")
        return { kind: "telegram-outbox", eventId: p[2], value: record };
    }
    if (
      p[0] === "profileGameProjectionOutbox" &&
      p[1] === "event" &&
      p.length === 4 &&
      [
        "schemaVersion",
        "requestId",
        "lastQueuedAtMs",
        "status",
        "deadAtMs",
        "reason",
      ].includes(p[3])
    )
      return {
        kind: "profile-game-outbox-field",
        eventId: p[2],
        field: p[3],
        value,
      } as EventCommand;
    if (
      p[0] === "profileGameProjectionOutbox" &&
      p[1] === "event" &&
      p.length === 5 &&
      p[3] === "cleanupOwnerProfileIds"
    )
      return {
        kind: "profile-game-outbox-cleanup",
        eventId: p[2],
        profileId: p[4],
        value: value as true | null,
      };
    if (p[0] === "players" && p[2] === "matches") {
      if (p.length === 4)
        return {
          kind: "match-creation",
          playerId: p[1],
          matchId: p[3],
          value: record,
        };
      if (p.length === 5 && p[4] === "timer")
        return {
          kind: "match-terminal-timer",
          playerId: p[1],
          matchId: p[3],
          value: value as string,
        };
    }
    if (p[0] === "matchTimerStarts" && p.length === 3 && value === null)
      return {
        kind: "match-timer-start-cleanup",
        matchId: p[1],
        playerId: p[2],
      };
    throw new Error("unsupported-event-path");
  });
}

export function decodeCanonicalEventUpdates(
  updates: Readonly<Record<string, unknown>>,
): EventMutation[] {
  const commands = decodeEventUpdates(updates);
  if (!commands.every(isEventMutation))
    throw new Error("unsupported-event-path");
  return commands;
}
