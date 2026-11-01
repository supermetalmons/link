"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildPreviewParticipants,
  getListSortAtMs,
  mapEventStatusToNavigationStatus,
} = require("../runtime/events/eventProjectionModel");
const {
  deriveProjectionStatus,
  getOwnerContext,
  getProfileDisplayName,
  getProfileEmoji,
  pickListSortMillis,
  readTimestampMillis,
  shouldProjectInvite,
} = require("../runtime/events/gameProjectionModel");

/** @param {{eventOwned?: boolean, guestId?: string | null}} [fields] @returns {import("../runtime/shared/invite-records").InviteDocument} */
function invite(fields = {}) {
  const common = {
    schemaVersion: /** @type {const} */ (1),
    version: /** @type {const} */ (2),
    hostId: "host",
    hostColor: /** @type {const} */ ("white"),
    guestId: fields.eventOwned ? "guest" : null,
    password: null,
    automatchStateHint: null,
    automatchCanceledAt: null,
    telegramDeliveryVersion: null,
    automatchOperationIds: {},
    automatchMessage: null,
    sessionTransition: null,
    hostRematches: { state: /** @type {const} */ ("open"), indices: [] },
    guestRematches: { state: /** @type {const} */ ("open"), indices: [] },
    ...fields,
  };
  return fields.eventOwned
    ? {
        ...common,
        kind: "event",
        eventOwned: true,
        eventId: "event",
        eventRoundIndex: 0,
        eventMatchKey: "0_0",
      }
    : {
        ...common,
        kind: "manual",
        eventOwned: false,
        eventId: null,
        eventRoundIndex: null,
        eventMatchKey: null,
      };
}
/** @param {Partial<{username: string | null, eth: string | null, sol: string | null, emoji: number | null}>} [fields] */
const profile = (fields = {}) => ({
  username: null,
  eth: null,
  sol: null,
  emoji: null,
  ...fields,
});

test("event projection previews normalize ordering and limits", () => {
  const participants = Object.fromEntries(
    Array.from({ length: 7 }, (_, index) => {
      const position = 7 - index;
      return [
        `key-${position}`,
        {
          profileId: `p${position}`,
          displayName: `Player ${position}`,
          emojiId: position,
          aura: "none",
          joinedAtMs: position,
        },
      ];
    }),
  );
  /** @type {ReturnType<typeof buildPreviewParticipants>} */
  const preview = Reflect.apply(buildPreviewParticipants, undefined, [
    participants,
  ]);
  assert.deepEqual(
    preview.map(({ profileId }) => profileId),
    ["p1", "p2", "p3", "p4", "p5", "p6", "p7"],
  );
  assert.equal(mapEventStatusToNavigationStatus("active"), "active");
  assert.equal(
    Reflect.apply(getListSortAtMs, undefined, [{ startedAtMs: 300 }, "active"]),
    300,
  );
});

test("game projection status keeps automatch, event rating, and rematch precedence", () => {
  assert.equal(
    deriveProjectionStatus({
      inviteId: "regular",
      inviteData: invite(),
      automatchStateHint: null,
      latestMatchRatingCompleted: false,
    }),
    "waiting",
  );
  assert.equal(
    deriveProjectionStatus({
      inviteId: "auto_example",
      inviteData: invite(),
      automatchStateHint: "pending",
      latestMatchRatingCompleted: false,
    }),
    "pending",
  );
  assert.equal(
    deriveProjectionStatus({
      inviteId: "regular",
      inviteData: invite({ guestId: "guest" }),
      automatchStateHint: null,
      latestMatchRatingCompleted: false,
    }),
    "active",
  );
  assert.equal(
    deriveProjectionStatus({
      inviteId: "event-match",
      inviteData: invite({ eventOwned: true }),
      automatchStateHint: null,
      latestMatchRatingCompleted: true,
    }),
    "ended",
  );
  assert.equal(
    shouldProjectInvite({
      inviteId: "auto_example",
      inviteData: invite(),
      automatchStateHint: null,
    }),
    false,
  );
});

test("game projection ignores legacy rating markers and keeps ordinary games active", () => {
  for (const inviteData of [
    {
      eventOwned: true,
      guestId: "guest",
      matchesRatingUpdates: { match1: true },
    },
    { guestId: "guest" },
  ]) {
    assert.equal(
      deriveProjectionStatus({
        inviteId: "regular",
        inviteData: invite(inviteData),
        automatchStateHint: null,
        latestMatchRatingCompleted: !inviteData.eventOwned,
      }),
      "active",
    );
  }
});

test("game projection normalization preserves timestamps, identity display, and list order", () => {
  assert.equal(readTimestampMillis(12_500.9), 12_500);
  assert.equal(readTimestampMillis({ milliseconds: 12_500 }), null);
  assert.equal(
    Reflect.apply(getProfileDisplayName, undefined, [
      profile({ username: " player " }),
    ]),
    "player",
  );
  assert.equal(
    Reflect.apply(getProfileDisplayName, undefined, [
      profile({ eth: "0x1234567890abcdef" }),
    ]),
    "0x12...cdef",
  );
  assert.equal(
    Reflect.apply(getProfileDisplayName, undefined, [
      profile({ sol: "short" }),
    ]),
    "anon",
  );
  assert.equal(
    Reflect.apply(getProfileEmoji, undefined, [profile({ emoji: 3 })]),
    3,
  );
  assert.deepEqual(
    getOwnerContext({
      ownerProfileId: "guest-profile",
      hostProfileId: "host-profile",
      guestProfileId: "guest-profile",
      hostLoginId: "host-login",
      guestLoginId: "guest-login",
    }),
    {
      ownerRole: "guest",
      ownerLoginId: "guest-login",
      opponentProfileId: "host-profile",
      opponentLoginId: "host-login",
    },
  );
  assert.equal(
    pickListSortMillis({
      options: {},
      status: "pending",
      automatchData: { timestamp: 500 },
      nowMs: 600,
      existingListSortMs: 700,
    }),
    700,
  );
  assert.equal(
    pickListSortMillis({
      options: { preserveListSortAt: true },
      status: "active",
      automatchData: null,
      nowMs: 900,
      existingListSortMs: 700,
    }),
    700,
  );
});
