"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildPreviewParticipants,
  getListSortAtMs,
  mapEventStatusToNavigationStatus,
} = require("../functions/events/eventProjectionModel");
const {
  deriveProjectionStatus,
  getOwnerContext,
  getProfileDisplayName,
  getProfileEmoji,
  pickListSortMillis,
  readTimestampMillis,
  shouldProjectInvite,
} = require("../functions/events/gameProjectionModel");

test("event projection previews normalize ordering and limits", () => {
  const participants = Object.fromEntries(
    Array.from({ length: 7 }, (_, index) => {
      const position = 7 - index;
      return [
        `key-${position}`,
        {
          profileId: `p${position}`,
          displayName: `Player ${position}`,
          emojiId: String(position),
          joinedAtMs: position,
        },
      ];
    }),
  );
  const preview = buildPreviewParticipants(participants);
  assert.deepEqual(
    preview.map(({ profileId }) => profileId),
    ["p1", "p2", "p3", "p4", "p5", "p6", "p7"],
  );
  assert.equal(mapEventStatusToNavigationStatus("active"), "active");
  assert.equal(getListSortAtMs({ startedAtMs: 300 }, "active"), 300);
});

test("game projection status keeps automatch, event rating, and rematch precedence", () => {
  assert.equal(
    deriveProjectionStatus({
      inviteId: "regular",
      inviteData: {},
      automatchStateHint: null,
      latestMatchId: null,
    }),
    "waiting",
  );
  assert.equal(
    deriveProjectionStatus({
      inviteId: "auto_example",
      inviteData: {},
      automatchStateHint: "pending",
      latestMatchId: null,
    }),
    "pending",
  );
  assert.equal(
    deriveProjectionStatus({
      inviteId: "regular",
      inviteData: { guestId: "guest" },
      automatchStateHint: null,
      latestMatchId: null,
    }),
    "active",
  );
  assert.equal(
    deriveProjectionStatus({
      inviteId: "event-match",
      inviteData: {
        eventOwned: true,
        matchesRatingUpdates: { match1: true },
      },
      automatchStateHint: null,
      latestMatchId: "match1",
    }),
    "ended",
  );
  assert.equal(
    shouldProjectInvite({
      inviteId: "auto_example",
      inviteData: {},
      automatchStateHint: null,
    }),
    false,
  );
});

test("game projection normalization preserves timestamps, identity display, and list order", () => {
  assert.equal(readTimestampMillis(12_500.9), 12_500);
  assert.equal(readTimestampMillis({ milliseconds: 12_500 }), null);
  assert.equal(getProfileDisplayName({ username: " player " }), "player");
  assert.equal(
    getProfileDisplayName({ eth: "0x1234567890abcdef" }),
    "0x12...cdef",
  );
  assert.equal(getProfileDisplayName({ sol: "short" }), "anon");
  assert.equal(getProfileEmoji({ custom: { emoji: "7" }, emoji: 3 }), 7);
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
