import { timerClaimFixture } from "./matchClaimFixture.ts";
import type {
  EventCommand,
  EventMutation,
} from "../../../runtime/eventCommands.js";
import { isEventMutation } from "../../../runtime/eventCommands.js";
import {
  parseEventMutation,
  parseEventEffect,
} from "../../../runtime/eventCommandCodec.js";
import { eventProjectionStateFixture as readEventTelegramProjectionDocument } from "./eventProjectionFixture.ts";
import { retainEventProgressRecord } from "../../../runtime/eventProgressRecords.js";
import { retainEventProjectionOutbox } from "../../../runtime/eventProjectionOutboxRecords.js";
import { inviteDocumentFixture } from "./inviteDocumentFixture.ts";
import { publicMatchFixture } from "./matchRecordFixture.ts";

const STATE_VALUE_FIELD = ".sv";

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

function commandAt(
  path: string,
  value: unknown,
): { effect: boolean; command: unknown } {
  const parts = path.split("/");
  const [root, id, field, key, group, child, leaf] = parts;
  if (root === "events") {
    if (parts.length === 2)
      return { effect: false, command: { kind: "event", eventId: id, value } };
    if (parts.length === 3)
      return {
        effect: false,
        command: { kind: "event-field", eventId: id, field, value },
      };
    if (parts.length === 4 && field === "rounds")
      return {
        effect: false,
        command: { kind: "event-round", eventId: id, roundKey: key, value },
      };
    if (parts.length === 4 && field === "participants")
      return {
        effect: false,
        command: {
          kind: "event-participant",
          eventId: id,
          profileId: key,
          value,
        },
      };
    if (
      parts.length === 4 &&
      field === "thirdPlaceMatch" &&
      key === "winnerDisqualified"
    )
      return {
        effect: false,
        command: {
          kind: "event-disqualification",
          eventId: id,
          roundKey: null,
          matchKey: "third_place",
          value,
        },
      };
    if (parts.length === 7 && field === "rounds" && group === "matches") {
      if (leaf === "status")
        return {
          effect: false,
          command: {
            kind: "event-match-status",
            eventId: id,
            roundKey: key,
            matchKey: child,
            value,
          },
        };
      if (leaf === "winnerDisqualified")
        return {
          effect: false,
          command: {
            kind: "event-disqualification",
            eventId: id,
            roundKey: key,
            matchKey: child,
            value,
          },
        };
    }
  }
  if (root === "eventPrizeSelections") {
    if (parts.length === 2)
      return {
        effect: false,
        command: { kind: "prize-selections", eventId: id, value },
      };
    if (parts.length === 3)
      return {
        effect: false,
        command: {
          kind: "prize-selection",
          eventId: id,
          profileId: field,
          value,
        },
      };
  }
  if (root === "profileEventPrizes") {
    if (parts.length === 2)
      return {
        effect: false,
        command: { kind: "profile-prizes", profileId: id, value },
      };
    if (parts.length === 3)
      return {
        effect: false,
        command: {
          kind: "profile-prize",
          profileId: id,
          eventId: field,
          value,
        },
      };
  }
  if (root === "eventProgressOutbox") {
    if (parts.length === 2)
      return {
        effect: false,
        command: { kind: "progress-outbox", outboxId: id, value },
      };
    if (parts.length === 3 && field === "lastQueuedAtMs")
      return {
        effect: false,
        command: { kind: "progress-dispatched", outboxId: id, value },
      };
  }
  if (root === "eventProgressOutboxDead" && parts.length === 2)
    return {
      effect: false,
      command: { kind: "progress-dead", outboxId: id, value },
    };
  if (root === "eventTelegramProjections" && parts.length === 2)
    return {
      effect: false,
      command: { kind: "telegram-state", eventId: id, value },
    };
  if (root === "eventTelegramProjectionGenerations" && parts.length === 2) {
    if (
      value !== null &&
      typeof value === "object" &&
      STATE_VALUE_FIELD in value
    ) {
      const marker = value[STATE_VALUE_FIELD];
      if (
        marker !== null &&
        typeof marker === "object" &&
        "increment" in marker
      )
        return {
          effect: false,
          command: {
            kind: "telegram-generation",
            eventId: id,
            value: marker.increment,
            increment: true,
          },
        };
    }
    return {
      effect: false,
      command: { kind: "telegram-generation", eventId: id, value },
    };
  }
  if (id === "event") {
    if (root === "telegramProjectionOutbox" && parts.length === 3)
      return {
        effect: false,
        command: { kind: "telegram-outbox", eventId: field, value },
      };
    if (root === "profileGameProjectionOutbox") {
      if (parts.length === 3)
        return {
          effect: false,
          command: { kind: "profile-game-outbox", eventId: field, value },
        };
      if (parts.length === 4)
        return {
          effect: false,
          command: {
            kind: "profile-game-outbox-field",
            eventId: field,
            field: key,
            value,
          },
        };
      if (parts.length === 5 && key === "cleanupOwnerProfileIds")
        return {
          effect: false,
          command: {
            kind: "profile-game-outbox-cleanup",
            eventId: field,
            profileId: group,
            value,
          },
        };
    }
  }
  if (root === "invites" && parts.length === 2)
    return {
      effect: true,
      command: {
        kind: "invite",
        inviteId: id,
        value:
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? inviteDocumentFixture({
                version: 2,
                hostColor: "white",
                eventRoundIndex: 0,
                eventMatchKey: "0_0",
                eventOwned: true,
                ...value,
              })
            : value,
      },
    };
  if (root === "players" && field === "matches") {
    if (parts.length === 4)
      return {
        effect: true,
        command: {
          kind: "match-creation",
          playerId: id,
          matchId: key,
          value:
            value !== null && typeof value === "object" && !Array.isArray(value)
              ? publicMatchFixture({
                  version: 2,
                  emojiId: 1,
                  aura: "none",
                  gameVariant: "Classic",
                  status: "",
                  flatMovesString: "",
                  timer: "",
                  ...value,
                })
              : value,
        },
      };
    if (parts.length === 5 && group === "timer")
      return {
        effect: true,
        command: {
          kind: "match-terminal-timer",
          playerId: id,
          matchId: key,
          value,
        },
      };
  }
  if (root === "matchTimerClaims" && parts.length === 2)
    return {
      effect: true,
      command: {
        kind: "match-timer-claim",
        matchId: id,
        value:
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? timerClaimFixture(value)
            : value,
      },
    };
  if (root === "matchTimerStarts" && parts.length === 3 && value === null)
    return {
      effect: true,
      command: {
        kind: "match-timer-start-cleanup",
        playerId: field,
        matchId: id,
      },
    };
  throw new Error("unsupported-test-event-path");
}

export function decodeEventUpdates(
  updates: Readonly<Record<string, unknown>>,
): EventCommand[] {
  return Object.entries(updates).map(([path, value]) => {
    const [root, id, nested] = path.split("/");
    if (
      root === "eventTelegramProjections" &&
      id &&
      path.split("/").length === 2
    ) {
      return {
        kind: "telegram-state",
        eventId: id,
        value:
          value === null ? null : readEventTelegramProjectionDocument(value),
      };
    }
    if (root === "eventProgressOutbox" && id && path.split("/").length === 2) {
      return {
        kind: "progress-outbox",
        outboxId: id,
        value:
          value === null ? null : retainEventProgressRecord("pending", value),
      };
    }
    if (
      root === "eventProgressOutboxDead" &&
      id &&
      path.split("/").length === 2
    ) {
      return {
        kind: "progress-dead",
        outboxId: id,
        value: value === null ? null : retainEventProgressRecord("dead", value),
      };
    }
    if (
      root === "profileGameProjectionOutbox" &&
      id === "event" &&
      nested &&
      path.split("/").length === 3
    ) {
      return {
        kind: "profile-game-outbox",
        eventId: nested,
        value:
          value === null
            ? null
            : retainEventProjectionOutbox("profile-game", value),
      };
    }
    if (
      root === "telegramProjectionOutbox" &&
      id === "event" &&
      nested &&
      path.split("/").length === 3
    ) {
      return {
        kind: "telegram-outbox",
        eventId: nested,
        value:
          value === null
            ? null
            : retainEventProjectionOutbox("telegram", value),
      };
    }
    const { effect, command } = commandAt(path, value);
    return effect ? parseEventEffect(command) : parseEventMutation(command);
  });
}

export function decodeCanonicalEventUpdates(
  updates: Readonly<Record<string, unknown>>,
): EventMutation[] {
  const commands = decodeEventUpdates(updates);
  if (!commands.every(isEventMutation))
    throw new Error("unexpected-test-event-effect");
  return commands;
}
