import assert from "node:assert/strict";
import { createDefaultProfileAppearance } from "@mons/shared/appearance";
import { isEventRecord } from "@mons/shared/events";
import { isGameSessionMatch } from "@mons/shared/game-sessions";
import { isNavigationItem } from "@mons/shared/navigation";
import {
  createEmptyEventTelegramProjectionDocument,
  readEventTelegramProjectionDocument,
} from "../../cloud/runtime/telegram/eventProjectionRecords.js";

/** @template T @param {T} value @returns {NonNullable<T>} */
export function required(value) {
  assert.ok(value !== null && value !== undefined);
  return value;
}

/**
 * @typedef {import("@mons/shared/events").EventParticipantFields} ParticipantFields
 * @typedef {import("@mons/shared/events").EventMatchFields} MatchFields
 * @typedef {import("@mons/shared/events").EventRecordFields} EventFields
 * @typedef {Omit<import("@mons/shared/events").EventRoundFields, "matches"> & { matches: Record<string, MatchFields> }} RoundFields
 * @typedef {Partial<Omit<EventFields, "participants" | "rounds" | "thirdPlaceMatch">> & { participants?: Record<string, Partial<ParticipantFields>>, rounds?: Record<string, RoundFields>, thirdPlaceMatch?: MatchFields | null }} EventPatch
 * @typedef {import("../../cloud/runtime/telegram/eventProjectionRecords.js").EventTelegramProjectionStateDocument} TelegramProjection
 * @typedef {import("../../cloud/runtime/telegram/eventProjectionRecords.js").EventTelegramProjectionGuard} TelegramGuard
 */

/** @param {Partial<Omit<TelegramProjection, "eventTelegramProjectionGuard">> & { eventTelegramProjectionGuard?: TelegramGuard | null }} [overrides] */
export function canonicalEventTelegramProjection(overrides = {}) {
  /** @type {Omit<TelegramProjection, "eventTelegramProjectionGuard"> & { eventTelegramProjectionGuard: TelegramGuard | null }} */
  const value = {
    ...createEmptyEventTelegramProjectionDocument(),
    ...overrides,
    schemaVersion: 3,
  };
  if (value.eventTelegramProjectionGuard)
    value.eventTelegramProjectionGuard = {
      generation: 0,
      ...value.eventTelegramProjectionGuard,
    };
  return readEventTelegramProjectionDocument(value);
}

/** @param {Partial<import("@mons/shared/appearance").ProfileAppearance>} [overrides] */
export const canonicalAppearance = (overrides = {}) => ({
  ...createDefaultProfileAppearance(),
  ...overrides,
});

/**
 * @param {Partial<import("@mons/shared/profiles").PlayerProfile>} [overrides]
 * @returns {import("@mons/shared/profiles").CompletePlayerProfile}
 */
export const canonicalProfile = (overrides = {}) => ({
  ...canonicalAppearance(),
  id: "profile",
  username: null,
  eth: null,
  sol: null,
  nonce: 0,
  rating: 1500,
  totalManaPoints: 0,
  win: false,
  mining: {
    lastRockDate: null,
    materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  },
  ...overrides,
});

/**
 * @param {Partial<import("@mons/shared/navigation").NavigationGameItem>} [overrides]
 * @returns {import("@mons/shared/navigation").NavigationGameItem}
 */
export function canonicalNavigationGame(overrides = {}) {
  const value = {
    id: "game",
    entityType: "game",
    inviteId: "game",
    kind: "direct",
    status: "active",
    sortBucket: 1,
    listSortAtMs: 1,
    hostLoginId: null,
    guestLoginId: null,
    opponentProfileId: null,
    opponentName: null,
    opponentEmoji: null,
    automatchStateHint: null,
    isPendingAutomatch: false,
    ...overrides,
  };
  const { isOptimistic, ...wire } = value;
  assert.ok(isNavigationItem(wire) && wire.entityType === "game");
  assert.ok(isOptimistic === undefined || typeof isOptimistic === "boolean");
  return isOptimistic === undefined ? wire : { ...wire, isOptimistic };
}

/**
 * @param {Partial<import("@mons/shared/navigation").NavigationEventItem>} [overrides]
 * @returns {import("@mons/shared/navigation").NavigationEventItem}
 */
export function canonicalNavigationEvent(overrides = {}) {
  const value = {
    id: "event",
    entityType: "event",
    eventId: "event",
    status: "waiting",
    sortBucket: 1,
    listSortAtMs: 1,
    startAtMs: null,
    updatedAtMs: null,
    endedAtMs: null,
    participantCount: 0,
    participantPreview: [],
    winnerDisplayName: null,
    ...overrides,
  };
  const { isOptimistic, ...wire } = value;
  assert.ok(isNavigationItem(wire) && wire.entityType === "event");
  assert.ok(isOptimistic === undefined || typeof isOptimistic === "boolean");
  return isOptimistic === undefined ? wire : { ...wire, isOptimistic };
}

/**
 * @param {Partial<ParticipantFields>} [overrides]
 * @returns {ParticipantFields}
 */
export const canonicalParticipant = (overrides = {}) => ({
  profileId: "participant",
  loginUid: "participant-login",
  username: "Participant",
  displayName: "Participant",
  emojiId: 1,
  aura: "none",
  joinedAtMs: 1,
  state: "active",
  eliminatedRoundIndex: overrides.state === "eliminated" ? 0 : null,
  eliminatedByProfileId: null,
  ...overrides,
});

/**
 * @param {Partial<MatchFields>} [overrides]
 * @returns {MatchFields}
 */
export const canonicalEventMatch = (overrides = {}) => ({
  matchKey: "0_0",
  inviteId: null,
  status: "upcoming",
  resolvedAtMs: overrides.status === "bye" ? 1 : null,
  winnerDisqualified: false,
  winnerProfileId: null,
  loserProfileId: null,
  hostSlotBlocked: false,
  hostProfileId: null,
  hostLoginUid: null,
  hostDisplayName: null,
  hostEmojiId: null,
  hostAura: null,
  guestSlotBlocked: false,
  guestProfileId: null,
  guestLoginUid: null,
  guestDisplayName: null,
  guestEmojiId: null,
  guestAura: null,
  ...overrides,
});

/** @param {EventPatch} [overrides] */
export function canonicalEvent(overrides = {}) {
  const started = overrides.status === "active" || overrides.status === "ended";
  const ended = overrides.status === "ended";
  const bracketSize = started ? (overrides.bracketSize ?? 2) : 0;
  const roundCount = started ? Math.log2(bracketSize) : 0;
  const rounds = Object.fromEntries(
    Array.from({ length: roundCount }, (_, index) => [
      String(index),
      {
        roundIndex: index,
        status: ended ? "completed" : index === 0 ? "active" : "upcoming",
        createdAtMs: 1,
        completedAtMs: ended ? 2 : null,
        matches: Object.fromEntries(
          Array.from(
            { length: bracketSize / 2 ** (index + 1) },
            (_, matchIndex) => {
              const matchKey = `${index}_${matchIndex}`;
              return [
                matchKey,
                canonicalEventMatch({
                  matchKey,
                  ...(ended ? { status: "bye", resolvedAtMs: 2 } : {}),
                }),
              ];
            },
          ),
        ),
      },
    ]),
  );
  const value = {
    schemaVersion: 3,
    eventId: "event-1",
    isSundayMons: false,
    status: "scheduled",
    createdAtMs: 1,
    updatedAtMs: 1,
    startAtMs: 1,
    startedAtMs: started ? 1 : null,
    endedAtMs: ended || overrides.status === "dismissed" ? 2 : null,
    createdByProfileId: "creator",
    createdByLoginUid: "creator-login",
    createdByUsername: "Creator",
    winnerProfileId: null,
    winnerDisplayName: null,
    currentRoundIndex: started ? 0 : null,
    bracketSize,
    roundCount,
    bracketFormat: "fixed",
    roundByes: {},
    telegramAnnouncements: { invite: false, matches: false, results: false },
    telegramDeliveryVersion: 2,
    supportsThirdPlaceMatch: false,
    thirdPlaceMatch: null,
    prizeSelectionsLockedAtMs: null,
    prizeAssignments: {},
    participants: {},
    rounds,
    ...overrides,
  };
  value.participants = Object.fromEntries(
    Object.entries(value.participants).map(([profileId, participant]) => [
      profileId,
      canonicalParticipant({
        profileId,
        loginUid: `login-${profileId}`,
        ...participant,
      }),
    ]),
  );
  assert.ok(isEventRecord(value), "fixture must be a complete canonical event");
  return value;
}

/** @param {Partial<import("@mons/shared/game-sessions").GameSessionMatch>} [overrides] */
export function canonicalMatch(overrides = {}) {
  const value = {
    schemaVersion: 1,
    version: 1,
    color: "white",
    emojiId: 1,
    aura: "none",
    gameVariant: "Classic",
    fen: "fen",
    status: "active",
    flatMovesString: "",
    timer: { state: "idle" },
    ...overrides,
  };
  assert.ok(
    isGameSessionMatch(value),
    "fixture must be a complete canonical match",
  );
  return value;
}
