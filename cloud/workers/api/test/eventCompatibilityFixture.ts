import {
  readEventDocument,
  readEventParticipantsDocument,
  readEventRoundDocument,
  type EventDocument,
  type EventParticipantsDocument,
  type EventRoundDocument,
} from "../../../runtime/events/documents.js";
import type { EventCommitPlan } from "../../../runtime/eventCommands.js";
import { decodeEventUpdates } from "./eventLegacyFixtureCodec.ts";
import type {
  EventStore,
  EventCommitOptions,
} from "../src/eventStoreContracts.ts";
import type { EventPersistenceCommand } from "../src/eventPersistenceCommands.ts";
import {
  canonicalEvent,
  canonicalParticipant,
  canonicalEventMatch,
} from "../../../../test/fixtures/canonicalData.mjs";

function fields(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid event fixture fields");
  }
  return Object.fromEntries(Object.entries(value));
}

function numberField(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  if (typeof value !== "number")
    throw new TypeError("invalid event fixture number");
  return value;
}

function completeEventFixture(value: object) {
  const source = fields(value);
  const started = source.status === "active" || source.status === "ended";
  const sourceRounds = fields(source.rounds ?? {});
  const roundCount =
    Object.keys(sourceRounds).length === 0
      ? 1
      : Math.max(...Object.keys(sourceRounds).map(Number)) + 1;
  const {
    rounds: _rounds,
    thirdPlaceMatch: _thirdPlaceMatch,
    ...header
  } = source;
  const base = fields(
    canonicalEvent({
      createdByProfileId: "creator-profile",
      createdByLoginUid: "creator-login",
      ...header,
      ...(started
        ? {
            bracketSize:
              typeof source.bracketSize === "number" && source.bracketSize > 0
                ? source.bracketSize
                : 2 ** roundCount,
            roundCount:
              typeof source.roundCount === "number" && source.roundCount > 0
                ? source.roundCount
                : roundCount,
            currentRoundIndex: numberField(source.currentRoundIndex, 0),
            startedAtMs: numberField(source.startedAtMs, 1),
            ...(source.status === "ended"
              ? { endedAtMs: numberField(source.endedAtMs, 2) }
              : {}),
          }
        : {}),
      thirdPlaceMatch: null,
    }),
  );
  const generatedRounds = fields(base.rounds);
  const participants = fields(base.participants);
  const completeMatch = (matchKey: string, value: unknown) => {
    const match = fields(value);
    const host =
      typeof match.hostProfileId === "string"
        ? canonicalParticipant({
            profileId: match.hostProfileId,
            loginUid: `${match.hostProfileId}-login`,
            ...fields(participants[match.hostProfileId] ?? {}),
          })
        : null;
    const guest =
      typeof match.guestProfileId === "string"
        ? canonicalParticipant({
            profileId: match.guestProfileId,
            loginUid: `${match.guestProfileId}-login`,
            ...fields(participants[match.guestProfileId] ?? {}),
          })
        : null;
    const resolved =
      match.status === "host" ||
      match.status === "guest" ||
      match.status === "bye";
    return canonicalEventMatch({
      matchKey,
      ...(host
        ? {
            hostProfileId: host.profileId,
            hostLoginUid: host.loginUid,
            hostDisplayName: host.displayName,
            hostEmojiId: host.emojiId,
            hostAura: host.aura,
          }
        : {}),
      ...(guest
        ? {
            guestProfileId: guest.profileId,
            guestLoginUid: guest.loginUid,
            guestDisplayName: guest.displayName,
            guestEmojiId: guest.emojiId,
            guestAura: guest.aura,
          }
        : {}),
      ...(resolved ? { resolvedAtMs: 2 } : {}),
      ...(match.status === "host" ||
      match.status === "guest" ||
      match.status === "pending"
        ? { inviteId: `invite-${matchKey}` }
        : {}),
      ...(match.status === "host"
        ? {
            winnerProfileId: host?.profileId ?? null,
            loserProfileId: guest?.profileId ?? null,
          }
        : {}),
      ...(match.status === "guest"
        ? {
            winnerProfileId: guest?.profileId ?? null,
            loserProfileId: host?.profileId ?? null,
          }
        : {}),
      ...match,
    });
  };
  for (const [roundKey, rawRound] of Object.entries(sourceRounds)) {
    const round = fields(rawRound);
    const rawMatches = fields(round.matches ?? {});
    const matches = Object.fromEntries(
      Object.entries(rawMatches).map(([matchKey, match]) => [
        matchKey,
        completeMatch(matchKey, match),
      ]),
    );
    generatedRounds[roundKey] = {
      roundIndex: Number(roundKey),
      createdAtMs: 1,
      completedAtMs: round.status === "completed" ? 2 : null,
      status: "active",
      ...round,
      matches,
    };
  }
  base.rounds = generatedRounds;
  if (source.thirdPlaceMatch != null)
    base.thirdPlaceMatch = completeMatch("third_place", source.thirdPlaceMatch);
  const event = readEventDocument(base);
  if (!event) throw new TypeError("invalid canonical event fixture");
  return event;
}

export function eventDocumentFixture<Source extends object>(
  value: Source,
): EventDocument & Source {
  const event = completeEventFixture(value);
  return { ...value, ...event };
}

export function eventParticipantsFixture<Source extends object>(
  value: Source,
): EventParticipantsDocument & Source {
  const participants = readEventParticipantsDocument(
    Object.fromEntries(
      Object.entries(value).map(([profileId, participant]) => [
        profileId,
        canonicalParticipant({ profileId, ...fields(participant) }),
      ]),
    ),
  );
  if (!participants) throw new TypeError("invalid event participants fixture");
  return { ...value, ...participants };
}

export function eventRoundFixture<Source extends object>(
  value: Source,
): EventRoundDocument & Source {
  const source = fields(value);
  const round = readEventRoundDocument({
    roundIndex: 0,
    status: "active",
    createdAtMs: 1,
    completedAtMs: source.status === "completed" ? 2 : null,
    ...source,
    matches: Object.fromEntries(
      Object.entries(fields(source.matches ?? {})).map(([matchKey, match]) => [
        matchKey,
        canonicalEventMatch({ matchKey, ...fields(match) }),
      ]),
    ),
  });
  if (!round) throw new TypeError("invalid event round fixture");
  return { ...value, ...round };
}

export function eventRecordFixture(value: unknown): Record<string, unknown> {
  const event = eventDocumentFixture(fields(value));
  return Object.fromEntries(Object.entries(event));
}

export function eventStatusFixture(
  eventId: string,
  status: "scheduled" | "active" | "ended" | "dismissed",
): Record<string, unknown> {
  const event = eventDocumentFixture({ eventId, status });
  return {
    [`events/${eventId}/status`]: event.status,
    [`events/${eventId}/startedAtMs`]: event.startedAtMs,
    [`events/${eventId}/endedAtMs`]: event.endedAtMs,
    [`events/${eventId}/currentRoundIndex`]: event.currentRoundIndex,
    [`events/${eventId}/bracketSize`]: event.bracketSize,
    [`events/${eventId}/roundCount`]: event.roundCount,
    [`events/${eventId}/rounds`]: event.rounds,
  };
}

export function decodeEventCompatibilityPlanFixture(
  updates: Record<string, unknown>,
): EventCommitPlan {
  return invokeEventCompatibilityFixture(
    (plan: EventCommitPlan) => plan,
    decodeEventUpdates(updates),
  );
}

export function commitEventCompatibilityFixture(
  repository: Pick<EventStore, "commitEventPlan">,
  commands: readonly EventPersistenceCommand[],
  signal?: AbortSignal,
  options?: EventCommitOptions,
): Promise<void> {
  return Reflect.apply(repository.commitEventPlan, repository, [
    commands,
    signal,
    options,
  ]);
}

export function invokeEventCompatibilityFixture<
  Operation extends (...args: never[]) => unknown,
>(operation: Operation, ...args: unknown[]): ReturnType<Operation> {
  return Reflect.apply(operation, undefined, args);
}
