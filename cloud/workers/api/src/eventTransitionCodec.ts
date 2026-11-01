import {
  readMatchCreationInput,
  type MatchDocument,
} from "./matchRecordCodec.ts";
import { normalizeRecordKey } from "@mons/shared/ids";
import { MAX_EVENT_PARTICIPANTS } from "@mons/shared/events";
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";
import {
  canonicalJson,
  canonicalEventRepositoryJson,
  sha256Hex,
} from "./canonicalJson.ts";
import {
  eventCommandRecord as record,
  parseEventMutations,
  parseEventEffects,
  parseEventInvite,
  parseEventProgressCommandRecord,
} from "../../../runtime/eventCommandCodec.js";
import { eventCommandIdentity } from "../../../runtime/eventCommands.js";
import type {
  EventEffect,
  EventMutation,
} from "../../../runtime/eventCommands.js";
import type {
  EventTransitionIntent,
  EventTransitionDraftInput,
  EventIntentEffects,
  EventIntentUpdates,
  EventInviteSourceMutation,
} from "../../../runtime/eventTransitionRecords.js";

export { record };
type PreparedEffect = Exclude<EventEffect, { kind: "invite" }>;
type IntentPayload = Omit<
  EventTransitionIntent,
  "payloadDigest" | "operationDigest"
>;
type LoginMatchDiscoveryInput = {
  loginUid: string;
  matchId: string;
  inviteId: string;
  resolution: "resolved";
  provenance: "capture";
};

function invalid(message = "event-transition-invalid-intent"): never {
  throw new Error(message);
}
function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !record(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
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
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
function unique<Command extends EventEffect | EventMutation>(
  commands: readonly Command[],
): Command[] {
  const result = new Map<string, Command>();
  for (const command of commands)
    result.set(eventCommandIdentity(command), command);
  return [...result.values()];
}
function requireUnique(
  commands: readonly (EventEffect | EventMutation)[],
): void {
  if (new Set(commands.map(eventCommandIdentity)).size !== commands.length)
    invalid("event-transition-duplicate-command");
}

export function canonical(value: unknown): string {
  return canonicalJson(value, () => invalid("event-transition-invalid-effect"));
}
export function digest(value: unknown): Promise<string> {
  return sha256Hex(canonical(value));
}

export function eventInviteSourceUpdates(effects: readonly EventEffect[]) {
  return effects.flatMap((command) =>
    command.kind === "invite"
      ? [{ inviteId: command.inviteId, value: command.value }]
      : [],
  );
}

export function eventIntentDigestInput(intent: IntentPayload) {
  return {
    schemaVersion: intent.schemaVersion,
    transitionId: intent.transitionId,
    eventId: intent.eventId,
    expectedRevision: intent.expectedRevision,
    sourceEpoch: intent.sourceEpoch,
    canonicalUpdates: intent.canonicalUpdates,
    inviteMutations: intent.inviteMutations,
    effects: intent.effects,
    createdAtMs: intent.createdAtMs,
  };
}

export function parseEventInviteMutations(
  value: unknown,
): EventInviteSourceMutation[] {
  if (!Array.isArray(value) || value.length > MAX_EVENT_PARTICIPANTS) invalid();
  const rows: unknown[] = value;
  const mutations = rows.map((item): EventInviteSourceMutation => {
    const row = exact(item, ["current", "value"]);
    const current = exact(row.current, ["inviteId", "revision", "value"]);
    const revision = integer(current.revision);
    if ((current.value === null) !== (revision === 0)) invalid();
    return {
      current: {
        inviteId: key(current.inviteId),
        revision,
        value: current.value === null ? null : parseEventInvite(current.value),
      },
      value: parseEventInvite(row.value),
    };
  });
  if (
    new Set(mutations.map((mutation) => mutation.current.inviteId)).size !==
    mutations.length
  )
    invalid();
  return mutations;
}

export function encodeEventIntentUpdates(
  commands: readonly EventMutation[],
): EventIntentUpdates {
  return unique(parseEventMutations(commands));
}
export function encodeEventIntentEffects(
  commands: readonly EventEffect[],
): EventIntentEffects {
  return unique(parseEventEffects(commands));
}
export function createEventTransitionDraft(
  input: EventTransitionDraftInput,
): EventTransitionDraftInput {
  if (input.schemaVersion !== 3) invalid();
  const createdAtMs = integer(input.createdAtMs);
  return {
    schemaVersion: 3,
    transitionId: key(input.transitionId),
    eventId: key(input.eventId),
    expectedRevision: integer(input.expectedRevision, 1),
    canonicalUpdates: encodeEventIntentUpdates(input.canonicalUpdates),
    effects: encodeEventIntentEffects(input.effects),
    createdAtMs,
    updatedAtMs: integer(input.updatedAtMs, createdAtMs),
  };
}
export function eventIntentCanonicalChanges(
  intent: EventTransitionIntent,
): EventMutation[] {
  return intent.canonicalUpdates;
}
export function eventIntentInviteChanges(intent: EventTransitionDraftInput) {
  return eventInviteSourceUpdates(intent.effects);
}
export function eventIntentPayloadDigest(
  intent: IntentPayload,
): Promise<string> {
  return digest(eventIntentDigestInput(intent));
}
export function preparedEventEffects(
  effects: EventIntentEffects,
): PreparedEffect[] {
  return effects.filter(
    (command): command is PreparedEffect => command.kind !== "invite",
  );
}
export function prepareEventIntentEnvelope(
  intent: EventTransitionDraftInput,
  sourceEpoch: number,
  inviteMutations: readonly {
    current: { inviteId: string; revision: number; value: unknown };
    value: unknown;
  }[],
): IntentPayload {
  for (const mutation of inviteMutations) {
    if (mutation.current.value === null) continue;
    if (
      !record(mutation.current.value) ||
      mutation.current.value.eventId !== intent.eventId
    ) {
      invalid("event-transition-invite-owner-conflict");
    }
    if (
      intent.effects.some(
        (effect) =>
          effect.kind === "match-creation" &&
          effect.matchId === mutation.current.inviteId,
      )
    ) {
      invalid("event-transition-invite-already-exists");
    }
  }
  return {
    ...createEventTransitionDraft(intent),
    sourceEpoch: integer(sourceEpoch, 1),
    inviteMutations: parseEventInviteMutations(inviteMutations),
    effects: preparedEventEffects(intent.effects),
  };
}
export function completeEventIntentEnvelope(
  next: IntentPayload,
  payloadDigest: string,
  operationDigest = payloadDigest,
): EventTransitionIntent {
  return parseEventTransitionIntent({
    ...next,
    payloadDigest,
    operationDigest,
  });
}

export function parseEventTransitionIntent(
  value: unknown,
): EventTransitionIntent {
  const row = exact(value, [
    "schemaVersion",
    "transitionId",
    "eventId",
    "expectedRevision",
    "canonicalUpdates",
    "effects",
    "createdAtMs",
    "updatedAtMs",
    "sourceEpoch",
    "inviteMutations",
    "payloadDigest",
    "operationDigest",
  ]);
  if (row.schemaVersion !== 3) invalid();
  const createdAtMs = integer(row.createdAtMs);
  const canonicalUpdates = parseEventMutations(row.canonicalUpdates);
  const effects = parseEventEffects(row.effects);
  requireUnique(canonicalUpdates);
  requireUnique(effects);
  if (effects.some((effect) => effect.kind === "invite")) invalid();
  const intent: EventTransitionIntent = {
    schemaVersion: 3,
    transitionId: key(row.transitionId),
    eventId: key(row.eventId),
    expectedRevision: integer(row.expectedRevision, 1),
    canonicalUpdates,
    effects,
    createdAtMs,
    updatedAtMs: integer(row.updatedAtMs, createdAtMs),
    sourceEpoch: integer(row.sourceEpoch, 1),
    inviteMutations: parseEventInviteMutations(row.inviteMutations),
    payloadDigest: hash(row.payloadDigest),
    operationDigest: hash(row.operationDigest),
  };
  for (const command of canonicalUpdates) {
    if ("eventId" in command && command.eventId !== intent.eventId)
      invalid("event-transition-cross-event-command");
    if (command.kind === "progress-outbox" && command.value !== null) {
      if (
        parseEventProgressCommandRecord(command.value).eventId !==
        intent.eventId
      )
        invalid("event-transition-cross-event-command");
    }
  }
  effectLayout(intent);
  return intent;
}

export function effectLayout(intent: EventTransitionIntent): {
  creations: {
    playerId: string;
    matchId: string;
    value: MatchDocument;
    markerPath: string;
  }[];
  otherEffects: Extract<
    PreparedEffect,
    {
      kind:
        | "match-terminal-timer"
        | "match-timer-start-cleanup"
        | "match-timer-claim";
    }
  >[];
  discovery: LoginMatchDiscoveryInput[];
} {
  const creations: {
    playerId: string;
    matchId: string;
    value: MatchDocument;
    markerPath: string;
  }[] = [];
  const otherEffects: Extract<
    PreparedEffect,
    {
      kind:
        | "match-terminal-timer"
        | "match-timer-start-cleanup"
        | "match-timer-claim";
    }
  >[] = [];
  const discovery: LoginMatchDiscoveryInput[] = [];
  const sources = new Map(
    intent.inviteMutations.map((mutation) => [
      mutation.current.inviteId,
      mutation,
    ]),
  );
  if (intent.effects.length > MAX_EVENT_PARTICIPANTS * 4)
    invalid("event-transition-too-many-effects");
  for (const effect of intent.effects) {
    if (effect.kind === "invite") invalid("event-transition-unprepared-invite");
    if (effect.kind !== "match-creation") {
      otherEffects.push(effect);
      continue;
    }
    const mutation = sources.get(effect.matchId);
    const invite = mutation?.value;
    if (
      !invite ||
      !isCanonicalLoginUid(effect.playerId) ||
      invite.eventId !== intent.eventId ||
      (invite.hostId !== effect.playerId && invite.guestId !== effect.playerId)
    )
      invalid("event-transition-invalid-match-creation");
    const match = readMatchCreationInput(effect.value).document;
    creations.push({
      playerId: effect.playerId,
      matchId: effect.matchId,
      value: match,
      markerPath: `players/${effect.playerId}/matches/${effect.matchId}`,
    });
    discovery.push({
      loginUid: effect.playerId,
      matchId: effect.matchId,
      inviteId: effect.matchId,
      resolution: "resolved",
      provenance: "capture",
    });
  }
  for (const mutation of intent.inviteMutations) {
    const { inviteId } = mutation.current;
    if (
      mutation.value.eventId !== intent.eventId ||
      (mutation.current.value !== null &&
        mutation.current.value.eventId !== intent.eventId)
    )
      invalid("event-transition-invite-owner-conflict");
    const created = creations.filter(
      (creation) => creation.matchId === inviteId,
    );
    if (mutation.current.value !== null) {
      if (created.length !== 0)
        invalid("event-transition-invite-already-exists");
    } else if (
      created.length !== 2 ||
      !created.some(
        (creation) => creation.playerId === mutation.value.hostId,
      ) ||
      !created.some((creation) => creation.playerId === mutation.value.guestId)
    )
      invalid("event-transition-invite-matches-missing");
  }
  return { creations, otherEffects, discovery };
}

export function sameTransitionIntent(
  left: EventTransitionIntent,
  right: EventTransitionIntent,
): boolean {
  return (
    left.transitionId === right.transitionId &&
    left.eventId === right.eventId &&
    left.expectedRevision === right.expectedRevision &&
    left.payloadDigest === right.payloadDigest &&
    left.operationDigest === right.operationDigest &&
    left.sourceEpoch === right.sourceEpoch &&
    canonicalEventRepositoryJson(left.canonicalUpdates) ===
      canonicalEventRepositoryJson(right.canonicalUpdates) &&
    canonicalEventRepositoryJson(left.effects) ===
      canonicalEventRepositoryJson(right.effects) &&
    canonicalEventRepositoryJson(left.inviteMutations) ===
      canonicalEventRepositoryJson(right.inviteMutations)
  );
}
export function eventIntentMatchesPlan(
  existing: EventTransitionIntent,
  canonicalUpdates: EventIntentUpdates,
  effects: EventIntentEffects,
  eventId: string,
  revision: number,
): boolean {
  const canonicalCommands = (
    commands: readonly (EventEffect | EventMutation)[],
  ) =>
    canonicalEventRepositoryJson(
      [...commands].sort((left, right) => {
        const a = eventCommandIdentity(left);
        const b = eventCommandIdentity(right);
        return a < b ? -1 : a > b ? 1 : 0;
      }),
    );
  return (
    existing.eventId === eventId &&
    existing.expectedRevision === revision &&
    canonicalCommands(existing.canonicalUpdates) ===
      canonicalCommands(canonicalUpdates) &&
    canonicalCommands(existing.effects) ===
      canonicalCommands(preparedEventEffects(effects))
  );
}
export function eventIntentNotificationTargets(intent: EventTransitionIntent) {
  const metadataInviteIds = new Set(
    intent.inviteMutations.map(({ current }) => current.inviteId),
  );
  const matchInviteIds = [
    ...new Set(
      intent.effects.flatMap((effect) =>
        effect.kind === "match-timer-claim" ? [effect.value.inviteId] : [],
      ),
    ),
  ].filter(
    (inviteId) =>
      normalizeRecordKey(inviteId) === inviteId &&
      !metadataInviteIds.has(inviteId),
  );
  return { metadataInviteIds, matchInviteIds, effects: intent.effects };
}
