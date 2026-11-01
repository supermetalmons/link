import { createHash } from "node:crypto";
import type {
  EventTransitionIntent,
  EventTransitionDraftInput,
} from "../../../runtime/eventTransitionRecords.js";
import { isEventMutation } from "../../../runtime/eventCommands.js";
import {
  parseEventEffects,
  parseEventMutations,
  parseEventInvite,
} from "../../../runtime/eventCommandCodec.js";
import {
  canonical,
  createEventTransitionDraft,
  eventIntentDigestInput,
  parseEventTransitionIntent,
} from "../src/eventTransitionCodec.ts";
import {
  decodeEventUpdates,
  decodeCanonicalEventUpdates,
} from "./eventLegacyFixtureCodec.ts";

function fields(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid intent fixture");
  return Object.fromEntries(Object.entries(value));
}

export function eventDraftFixture(value: {
  schemaVersion: 3;
  transitionId: string;
  eventId: string;
  expectedRevision: number;
  canonicalUpdates: unknown;
  effects: unknown;
  createdAtMs: number;
  updatedAtMs: number;
}): EventTransitionDraftInput {
  const canonicalUpdates = Array.isArray(value.canonicalUpdates)
    ? parseEventMutations(value.canonicalUpdates)
    : decodeCanonicalEventUpdates(fields(value.canonicalUpdates));
  const commands = Array.isArray(value.effects)
    ? parseEventEffects(value.effects)
    : decodeEventUpdates(fields(value.effects));
  if (commands.some(isEventMutation))
    throw new Error("unexpected intent fixture mutation");
  const effects = commands.filter((command) => !isEventMutation(command));
  return createEventTransitionDraft({ ...value, canonicalUpdates, effects });
}

export function eventIntentFixture(
  value: Parameters<typeof eventDraftFixture>[0] & {
    sourceEpoch?: number;
    inviteMutations?: unknown;
    payloadDigest?: string;
    operationDigest?: string;
  },
): EventTransitionIntent {
  const draft = eventDraftFixture(value);
  const inviteMutations =
    value.inviteMutations ??
    draft.effects.flatMap((effect) =>
      effect.kind === "invite"
        ? [
            {
              current: { inviteId: effect.inviteId, value: null, revision: 0 },
              value: parseEventInvite(effect.value),
            },
          ]
        : [],
    );
  const prepared = {
    ...draft,
    sourceEpoch: value.sourceEpoch ?? 1,
    inviteMutations,
    effects: draft.effects.filter((effect) => effect.kind !== "invite"),
  };
  const parsed = parseEventTransitionIntent({
    ...prepared,
    payloadDigest: "a".repeat(64),
    operationDigest: "a".repeat(64),
  });
  const payloadDigest =
    value.payloadDigest ??
    createHash("sha256")
      .update(canonical(eventIntentDigestInput(parsed)))
      .digest("hex");
  return parseEventTransitionIntent({
    ...parsed,
    payloadDigest,
    operationDigest: value.operationDigest ?? payloadDigest,
  });
}

export function retainedEventIntentFixture(
  value: unknown,
): EventTransitionIntent {
  return Object.assign(
    eventIntentFixture({
      schemaVersion: 3,
      transitionId: "invalid-fixture",
      eventId: "event-1",
      expectedRevision: 1,
      canonicalUpdates: [],
      effects: [],
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
    fields(value),
  );
}

export function retainedEventInviteMutationsFixture(
  value: EventTransitionIntent["inviteMutations"],
) {
  return value;
}
