"use strict";

const assert = require("node:assert/strict");
const {
  canonicalEvent,
  canonicalParticipant,
  canonicalEventMatch,
} = require("../../../test/fixtures/canonicalData.mjs");
const {
  isEventRecord,
  isEventParticipantRecord,
  isEventMatchRecord,
  isEventRoundRecord,
} = require("../../runtime/shared/events");

/**
 * @typedef {import("../../runtime/shared/event-types").EventParticipantFields} ParticipantFields
 * @typedef {import("../../runtime/shared/event-types").EventParticipantRecord} ParticipantRecord
 * @typedef {import("../../runtime/shared/event-types").EventMatchFields} MatchFields
 * @typedef {Partial<Omit<import("../../runtime/shared/event-types").EventRoundFields, "matches">> & {matches?: Record<string, Partial<MatchFields>>}} RoundPatch
 * @typedef {Partial<Omit<import("../../runtime/shared/event-types").EventRecordFields, "participants" | "rounds" | "thirdPlaceMatch">> & {participants?: Record<string, Partial<ParticipantFields>>, rounds?: Record<string, RoundPatch>, thirdPlaceMatch?: Partial<MatchFields> | null}} EventPatch
 * @typedef {{eventId: string, event?: EventPatch | null, rounds?: Record<string, RoundPatch>, participantsById?: Record<string, Partial<ParticipantFields>>, thirdPlaceMatch?: Partial<MatchFields> | null}} PrizeInput
 */

/**
 * @template {object} Value
 * @param {Value} value
 * @param {string} name
 * @returns {Value}
 */
function fields(value, name) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), name);
  return value;
}

/**
 * @param {string} profileId
 * @param {Partial<ParticipantFields>} [patch]
 */
function participant(profileId, patch = {}) {
  const value = canonicalParticipant({
    profileId,
    loginUid: `${profileId}-login`,
    username: profileId,
    displayName: profileId,
    ...fields(patch, "participant fixture patch"),
  });
  assert.ok(
    isEventParticipantRecord(value),
    `invalid participant fixture: ${profileId}`,
  );
  return value;
}

/**
 * @param {string} matchKey
 * @param {Partial<MatchFields>} [patch]
 * @param {Record<string, ParticipantRecord>} [participants]
 */
function match(matchKey, patch = {}, participants = {}) {
  fields(patch, "match fixture patch");
  /** @type {Partial<MatchFields>} */
  const slots = {};
  for (const side of /** @type {const} */ (["host", "guest"])) {
    const profileId = patch[`${side}ProfileId`];
    if (profileId == null) continue;
    const player = participants[profileId] ?? participant(profileId);
    slots[`${side}ProfileId`] = profileId;
    slots[`${side}LoginUid`] = player.loginUid;
    slots[`${side}DisplayName`] = player.displayName;
    slots[`${side}EmojiId`] = player.emojiId;
    slots[`${side}Aura`] = player.aura;
  }
  const resolved = ["host", "guest", "bye"].includes(patch.status ?? "");
  const playing = ["host", "guest", "pending"].includes(patch.status ?? "");
  const value = canonicalEventMatch(
    /** @type {Partial<MatchFields>} */ ({
      matchKey,
      ...slots,
      ...(resolved ? { resolvedAtMs: 1 } : {}),
      ...(playing ? { inviteId: `invite-${matchKey}` } : {}),
      ...(patch.status === "host"
        ? {
            winnerProfileId: patch.hostProfileId,
            loserProfileId: patch.guestProfileId ?? null,
          }
        : {}),
      ...(patch.status === "guest"
        ? {
            winnerProfileId: patch.guestProfileId,
            loserProfileId: patch.hostProfileId ?? null,
          }
        : {}),
      ...patch,
    }),
  );
  assert.ok(isEventMatchRecord(value), `invalid match fixture: ${matchKey}`);
  return value;
}

/**
 * @param {number} roundIndex
 * @param {RoundPatch} [patch]
 * @param {Record<string, ParticipantRecord>} [participants]
 */
function round(roundIndex, patch = {}, participants = {}) {
  fields(patch, "round fixture patch");
  const matches = Object.fromEntries(
    Object.entries(patch.matches ?? {}).map(([matchKey, value]) => [
      matchKey,
      isEventMatchRecord(value) && value.matchKey === matchKey
        ? value
        : match(matchKey, value, participants),
    ]),
  );
  const terminal =
    Object.values(matches).length > 0 &&
    Object.values(matches).every(
      (value) =>
        ["host", "guest", "bye"].includes(value.status) ||
        value.winnerDisqualified,
    );
  const status = patch.status ?? (terminal ? "completed" : "active");
  const value = {
    roundIndex,
    status,
    createdAtMs: 1,
    completedAtMs: status === "completed" ? 1 : null,
    ...patch,
    matches,
  };
  assert.ok(isEventRoundRecord(value), `invalid round fixture: ${roundIndex}`);
  return value;
}

/** @param {EventPatch} [patch] */
function event(patch = {}) {
  fields(patch, "event fixture patch");
  const participants = Object.fromEntries(
    Object.entries(patch.participants ?? {}).map(([profileId, value]) => [
      profileId,
      participant(profileId, value),
    ]),
  );
  const started = patch.status === "active" || patch.status === "ended";
  const roundKeys = Object.keys(patch.rounds ?? {});
  assert.ok(
    roundKeys.every((key) => /^(0|[1-4])$/.test(key)),
    "invalid round fixture key",
  );
  const roundCount = started
    ? (patch.roundCount ??
      (roundKeys.length ? Math.max(...roundKeys.map(Number)) + 1 : 1))
    : 0;
  const bracketSize = started ? (patch.bracketSize ?? 2 ** roundCount) : 0;
  const {
    rounds: sourceRounds,
    thirdPlaceMatch,
    participants: _participants,
    ...header
  } = patch;
  const value = canonicalEvent({
    ...header,
    participants,
    ...(started ? { bracketSize, roundCount } : {}),
    supportsThirdPlaceMatch:
      patch.supportsThirdPlaceMatch ?? thirdPlaceMatch != null,
    thirdPlaceMatch: null,
  });
  for (const [key, valuePatch] of Object.entries(sourceRounds ?? {})) {
    value.rounds[key] = round(
      Number(key),
      {
        ...valuePatch,
        matches: { ...value.rounds[key]?.matches, ...valuePatch.matches },
      },
      participants,
    );
  }
  if (thirdPlaceMatch != null)
    value.thirdPlaceMatch = match("third_place", thirdPlaceMatch, participants);
  assert.ok(isEventRecord(value), `invalid event fixture: ${value.eventId}`);
  return value;
}

/**
 * @template {PrizeInput} Input
 * @param {Input} input
 */
function prizeInput(input) {
  const rounds = input.rounds ?? {};
  const source = input.event ?? {};
  const status =
    source.status ?? (Object.keys(rounds).length ? "ended" : "scheduled");
  const value = event({
    eventId: input.eventId,
    ...source,
    status,
    participants: input.participantsById ?? source.participants ?? {},
    rounds,
    thirdPlaceMatch: input.thirdPlaceMatch ?? null,
  });
  return {
    ...input,
    event: value,
    rounds: value.rounds,
    participantsById: value.participants,
    thirdPlaceMatch: value.thirdPlaceMatch,
  };
}

module.exports = { event, participant, match, round, prizeInput };
