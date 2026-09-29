import {
  STATE_EFFECTS_FIELD,
  STATE_VALUE_FIELD,
} from "./stateCompatibility.ts";
import { MAX_EVENT_PARTICIPANTS } from "@mons/shared/events";
import {
  MATCH_TIMER_CLAIM_ROOT,
  MATCH_TIMER_TERMINAL,
} from "@mons/shared/timers";
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";
import { canonicalJson, sha256Hex } from "./canonicalJson.ts";
import { normalizeInviteSource } from "./inviteSourceD1.ts";
import { decodeEventUpdates } from "./eventCompatibilityCodec.ts";
import type { EventEffect } from "../../../runtime/eventCommands.js";
import type { EventTransitionIntent } from "./eventD1.ts";
import type { LoginMatchDiscoveryInput } from "./loginMatchDiscoveryD1.ts";
type V2Intent = Extract<EventTransitionIntent, { schemaVersion: 2 }>;
type JsonRecord = Record<string, unknown>;
export function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonical(value: unknown): string {
  return canonicalJson(value, () => {
    throw new Error("event-transition-invalid-effect");
  });
}

export async function digest(value: unknown): Promise<string> {
  return sha256Hex(canonical(value));
}

export function resolveTimestamps(value: unknown, nowMs: number): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => resolveTimestamps(child, nowMs));
  }
  if (!record(value)) {
    canonical(value);
    return value;
  }
  if (Object.hasOwn(value, STATE_VALUE_FIELD)) {
    if (
      Object.keys(value).length !== 1 ||
      value[STATE_VALUE_FIELD] !== "timestamp"
    ) {
      throw new Error("event-transition-invalid-server-value");
    }
    return nowMs;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      resolveTimestamps(child, nowMs),
    ]),
  );
}

export function eventInviteSourceUpdates(
  effects: Readonly<JsonRecord>,
): JsonRecord {
  return Object.fromEntries(
    Object.entries(effects).filter(([path]) => path.startsWith("invites/")),
  );
}

export function digestInput(intent: Omit<V2Intent, "payloadDigest">) {
  return {
    transitionId: intent.transitionId,
    eventId: intent.eventId,
    expectedRevision: intent.expectedRevision,
    sourceEpoch: intent.sourceEpoch,
    canonicalUpdates: intent.canonicalUpdates,
    inviteMutations: intent.inviteMutations,
    [STATE_EFFECTS_FIELD]: intent[STATE_EFFECTS_FIELD],
    createdAtMs: intent.createdAtMs,
  };
}

export function effectLayout(intent: V2Intent): {
  creations: {
    playerId: string;
    matchId: string;
    value: JsonRecord;
    markerPath: string;
  }[];
  otherEffects: Exclude<EventEffect, { kind: "invite" | "match-creation" }>[];
  discovery: LoginMatchDiscoveryInput[];
} {
  const creations: [string, JsonRecord][] = [];
  const otherEffects: JsonRecord = {};
  const discovery: LoginMatchDiscoveryInput[] = [];
  const sources = new Map(
    intent.inviteMutations.map((mutation) => [
      mutation.current.inviteId,
      mutation,
    ]),
  );
  const paths = Object.keys(intent[STATE_EFFECTS_FIELD]);
  if (paths.length > MAX_EVENT_PARTICIPANTS * 4) {
    throw new Error("event-transition-too-many-effects");
  }
  for (const [path, value] of Object.entries(intent[STATE_EFFECTS_FIELD])) {
    const parts = path.split("/");
    if (
      parts.some((part) => !isSafeRecordKey(part)) ||
      parts[0] === "invites" ||
      parts[0] === "eventTransitionReceipts" ||
      paths.some((other) => other !== path && path.startsWith(`${other}/`))
    ) {
      throw new Error("event-transition-invalid-effect-path");
    }
    if (parts[0] === "players" && parts[2] === "matches") {
      if (parts.length === 4) {
        const source = sources.get(parts[3]);
        if (
          !record(value) ||
          Object.hasOwn(value, "sessionCreation") ||
          !source ||
          !isCanonicalLoginUid(parts[1]) ||
          source.value.eventId !== intent.eventId ||
          !isCanonicalLoginUid(source.value.hostId) ||
          !isCanonicalLoginUid(source.value.guestId) ||
          source.value.hostId === source.value.guestId ||
          ![source.value.hostId, source.value.guestId].includes(parts[1])
        ) {
          throw new Error("event-transition-invalid-match-creation");
        }
        creations.push([path, value]);
        discovery.push({
          loginUid: parts[1],
          matchId: parts[3],
          inviteId: parts[3],
          resolution: "resolved",
          provenance: "capture",
        });
      } else if (
        parts.length === 5 &&
        parts[4] === "timer" &&
        value === MATCH_TIMER_TERMINAL
      ) {
        otherEffects[path] = value;
      } else {
        throw new Error("event-transition-invalid-match-effect");
      }
    } else {
      if (!(
        (parts[0] === "matchTimerStarts" &&
          parts.length === 3 &&
          value === null) ||
        (parts[0] === MATCH_TIMER_CLAIM_ROOT &&
          parts.length === 2 &&
          record(value) &&
          value.status === "claimed")
      )) {
        throw new Error("event-transition-invalid-effect-path");
      }
      otherEffects[path] = value;
    }
  }
  for (const mutation of intent.inviteMutations) {
    if (
      canonical(normalizeInviteSource(mutation.value)) !==
        canonical(mutation.value) ||
      (mutation.current.value !== null &&
        canonical(normalizeInviteSource(mutation.current.value)) !==
          canonical(mutation.current.value))
    ) {
      throw new Error("event-transition-invalid-invite-source");
    }
    const { inviteId } = mutation.current;
    if (mutation.value.eventId !== intent.eventId) {
      throw new Error("event-transition-invite-owner-conflict");
    }
    if (mutation.current.value !== null) {
      if (mutation.current.value.eventId !== intent.eventId) {
        throw new Error("event-transition-invite-owner-conflict");
      }
      if (creations.some(([path]) => path.split("/")[3] === inviteId)) {
        throw new Error("event-transition-invite-already-exists");
      }
    }
    if (
      mutation.current.value === null &&
      (!isCanonicalLoginUid(mutation.value.hostId) ||
        !isCanonicalLoginUid(mutation.value.guestId) ||
        !paths.includes(
          `players/${mutation.value.hostId}/matches/${inviteId}`,
        ) ||
        !paths.includes(
          `players/${mutation.value.guestId}/matches/${inviteId}`,
        ))
    ) {
      throw new Error("event-transition-invite-matches-missing");
    }
  }
  return {
    creations: creations.map(([markerPath, value]) => {
      const [, playerId, , matchId] = markerPath.split("/");
      return { playerId, matchId, value, markerPath };
    }),
    otherEffects: decodeEventUpdates(otherEffects).filter(
      (
        command,
      ): command is Exclude<
        EventEffect,
        { kind: "invite" | "match-creation" }
      > =>
        command.kind === "match-terminal-timer" ||
        command.kind === "match-timer-start-cleanup" ||
        command.kind === "match-timer-claim",
    ),
    discovery,
  };
}

export function preparedEventEffects(
  effects: Readonly<Record<string, unknown>>,
  nowMs: number,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(effects)
      .filter(([path]) => !path.startsWith("invites/"))
      .map(([path, value]) => [path, resolveTimestamps(value, nowMs)]),
  );
}
