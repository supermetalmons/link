import { readMatchDocument, type MatchDocument } from "./matchRecordCodec.ts";
import { normalizeRecordKey } from "@mons/shared/ids";
import { inviteSourceEventState } from "@mons/shared/invite-records";
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
import {
  canonicalJson,
  canonicalEventRepositoryJson,
  sha256Hex,
} from "./canonicalJson.ts";
import { normalizeInviteSource } from "./inviteSourceD1.ts";
import {
  decodeEventUpdates,
  decodeCanonicalEventUpdates,
  encodeEventUpdates,
} from "./eventCompatibilityCodec.ts";
import type { EventPersistenceCommand } from "./eventPersistenceCommands.ts";
import type {
  EventTransitionIntent,
  EventTransitionDraftInput,
  EventIntentEffects,
  EventIntentUpdates,
} from "./eventD1/types.ts";
import type {
  EventEffect,
  EventMutation,
} from "../../../runtime/eventCommands.js";
import type {
  InviteSourceMutation,
  RetainedInviteMutationBatch,
} from "./inviteSourceD1.ts";
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

function digestInput(intent: Omit<V2Intent, "payloadDigest">) {
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

type InviteMutationEvidence = {
  current: { inviteId: string; revision: number; value: unknown };
  value: unknown;
};

function inviteMutationEvidence(
  value: RetainedInviteMutationBatch,
): InviteMutationEvidence[] {
  const retained: unknown = value;
  return retained as InviteMutationEvidence[];
}

function effectEvidence(value: EventIntentEffects): JsonRecord {
  const retained: unknown = value;
  return retained as JsonRecord;
}

export function encodeEventIntentUpdates(
  commands: readonly EventMutation[],
): EventIntentUpdates {
  const value: unknown = encodeEventUpdates(commands);
  return value as EventIntentUpdates;
}

export function encodeEventIntentEffects(
  commands: readonly EventEffect[],
): EventIntentEffects {
  const value: unknown = encodeEventUpdates(commands);
  return value as EventIntentEffects;
}

export function createEventTransitionDraft(
  input: EventTransitionDraftInput,
): Extract<EventTransitionIntent, { schemaVersion: 1 }> {
  const value: unknown = input;
  return value as Extract<EventTransitionIntent, { schemaVersion: 1 }>;
}

export function eventIntentCanonicalChanges(intent: EventTransitionIntent) {
  const value: unknown = intent.canonicalUpdates;
  return decodeCanonicalEventUpdates(value as JsonRecord);
}

export function eventIntentInviteChanges(
  intent: Extract<EventTransitionIntent, { schemaVersion: 1 }>,
) {
  return decodeEventUpdates(
    effectEvidence(intent[STATE_EFFECTS_FIELD]),
  ).flatMap((command) =>
    command.kind === "invite"
      ? [{ inviteId: command.inviteId, value: command.value }]
      : [],
  );
}

export function eventIntentPayloadDigest(
  intent: Omit<V2Intent, "payloadDigest">,
): Promise<string> {
  return digest(digestInput(intent));
}

export function prepareEventIntentEnvelope(
  intent: Extract<EventTransitionIntent, { schemaVersion: 1 }>,
  sourceEpoch: number,
  inviteMutations: InviteSourceMutation[],
): Omit<V2Intent, "payloadDigest"> {
  const retainedMutations: unknown = inviteMutations;
  const next: Omit<V2Intent, "payloadDigest"> = {
    ...intent,
    schemaVersion: 2,
    sourceEpoch,
    inviteMutations: retainedMutations as RetainedInviteMutationBatch,
    [STATE_EFFECTS_FIELD]: preparedEventEffects(
      intent[STATE_EFFECTS_FIELD],
      intent.createdAtMs,
    ),
  };
  return next;
}

export function completeEventIntentEnvelope(
  next: Omit<V2Intent, "payloadDigest">,
  payloadDigest: string,
): V2Intent {
  const prepared = { ...next, payloadDigest };
  effectLayout(prepared);
  return prepared;
}

export function effectLayout(intent: V2Intent): {
  creations: {
    playerId: string;
    matchId: string;
    value: MatchDocument;
    markerPath: string;
  }[];
  otherEffects: Extract<
    EventPersistenceCommand,
    {
      kind:
        | "match-terminal-timer"
        | "match-timer-start-cleanup"
        | "match-timer-claim";
    }
  >[];
  discovery: LoginMatchDiscoveryInput[];
} {
  const creations: [string, MatchDocument][] = [];
  const otherEffects: JsonRecord = {};
  const discovery: LoginMatchDiscoveryInput[] = [];
  const sources = new Map(
    inviteMutationEvidence(intent.inviteMutations).map((mutation) => [
      mutation.current.inviteId,
      mutation,
    ]),
  );
  const paths = Object.keys(effectEvidence(intent[STATE_EFFECTS_FIELD]));
  if (paths.length > MAX_EVENT_PARTICIPANTS * 4) {
    throw new Error("event-transition-too-many-effects");
  }
  for (const [path, value] of Object.entries(
    effectEvidence(intent[STATE_EFFECTS_FIELD]),
  )) {
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
        const sourceMutation = sources.get(parts[3]);
        const source = sourceMutation
          ? inviteSourceEventState(
              sourceMutation.value as Parameters<
                typeof inviteSourceEventState
              >[0],
            )
          : null;
        if (
          !record(value) ||
          Object.hasOwn(value, "sessionCreation") ||
          !source ||
          !isCanonicalLoginUid(parts[1]) ||
          source.eventId !== intent.eventId ||
          !isCanonicalLoginUid(source.hostId) ||
          !isCanonicalLoginUid(source.guestId) ||
          source.hostId === source.guestId ||
          ![source.hostId, source.guestId].includes(parts[1])
        ) {
          throw new Error("event-transition-invalid-match-creation");
        }
        creations.push([path, readMatchDocument(value)!]);
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
  for (const mutation of inviteMutationEvidence(intent.inviteMutations)) {
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
    const invite = inviteSourceEventState(
      mutation.value as Parameters<typeof inviteSourceEventState>[0],
    );
    if (invite.eventId !== intent.eventId) {
      throw new Error("event-transition-invite-owner-conflict");
    }
    if (mutation.current.value !== null) {
      if (
        inviteSourceEventState(
          mutation.current.value as Parameters<
            typeof inviteSourceEventState
          >[0],
        ).eventId !== intent.eventId
      ) {
        throw new Error("event-transition-invite-owner-conflict");
      }
      if (creations.some(([path]) => path.split("/")[3] === inviteId)) {
        throw new Error("event-transition-invite-already-exists");
      }
    }
    if (
      mutation.current.value === null &&
      (!isCanonicalLoginUid(invite.hostId) ||
        !isCanonicalLoginUid(invite.guestId) ||
        !paths.includes(`players/${invite.hostId}/matches/${inviteId}`) ||
        !paths.includes(`players/${invite.guestId}/matches/${inviteId}`))
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
      ): command is Extract<
        EventPersistenceCommand,
        {
          kind:
            | "match-terminal-timer"
            | "match-timer-start-cleanup"
            | "match-timer-claim";
        }
      > =>
        command.kind === "match-terminal-timer" ||
        command.kind === "match-timer-start-cleanup" ||
        command.kind === "match-timer-claim",
    ),
    discovery,
  };
}

export function preparedEventEffects(
  effects: EventIntentEffects,
  nowMs: number,
): EventIntentEffects {
  const value: unknown = Object.fromEntries(
    Object.entries(effectEvidence(effects))
      .filter(([path]) => !path.startsWith("invites/"))
      .map(([path, value]) => [path, resolveTimestamps(value, nowMs)]),
  );
  return value as EventIntentEffects;
}

export function sameTransitionIntent(
  left: EventTransitionIntent,
  right: EventTransitionIntent,
): boolean {
  return (
    left.transitionId === right.transitionId &&
    left.schemaVersion === right.schemaVersion &&
    left.eventId === right.eventId &&
    left.expectedRevision === right.expectedRevision &&
    canonicalEventRepositoryJson(left.canonicalUpdates) ===
      canonicalEventRepositoryJson(right.canonicalUpdates) &&
    canonicalEventRepositoryJson(left[STATE_EFFECTS_FIELD]) ===
      canonicalEventRepositoryJson(right[STATE_EFFECTS_FIELD]) &&
    (left.schemaVersion !== 2 ||
      (right.schemaVersion === 2 &&
        left.payloadDigest === right.payloadDigest &&
        left.sourceEpoch === right.sourceEpoch &&
        canonicalEventRepositoryJson(left.inviteMutations) ===
          canonicalEventRepositoryJson(right.inviteMutations)))
  );
}

export function eventIntentMatchesPlan(
  existing: EventTransitionIntent,
  canonicalUpdates: EventIntentUpdates,
  stateEffects: EventIntentEffects,
  eventId: string,
  revision: number,
): boolean {
  return !(
    canonicalEventRepositoryJson(existing.canonicalUpdates) !==
      canonicalEventRepositoryJson(canonicalUpdates) ||
    (existing.schemaVersion === 1 &&
      canonicalEventRepositoryJson(existing[STATE_EFFECTS_FIELD]) !==
        canonicalEventRepositoryJson(stateEffects)) ||
    existing.eventId !== eventId ||
    existing.expectedRevision !== revision
  );
}

export function eventIntentNotificationTargets(intent: V2Intent) {
  const effects = decodeEventUpdates(
    effectEvidence(intent[STATE_EFFECTS_FIELD]),
  );
  const metadataInviteIds = new Set(
    inviteMutationEvidence(intent.inviteMutations)
      .map(({ current }) => current.inviteId)
      .filter((inviteId) => normalizeRecordKey(inviteId) === inviteId),
  );
  const matchInviteIds = [
    ...new Set(
      effects.flatMap((command) =>
        command.kind === "match-timer-claim" &&
        record(command.value) &&
        typeof command.value.inviteId === "string"
          ? [command.value.inviteId]
          : [],
      ),
    ),
  ].filter(
    (inviteId) =>
      normalizeRecordKey(inviteId) === inviteId &&
      !metadataInviteIds.has(inviteId),
  );
  return { metadataInviteIds, matchInviteIds, effects };
}
