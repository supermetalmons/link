import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveEventPreview,
  getEventStatusLabel,
  getGameStatusLabel,
  partitionNavigationItems,
} from "../src/ui/navigation/navigationPickerModel.ts";

/**
 * @typedef {import("@mons/shared/navigation").NavigationGameItem} GameItem
 * @typedef {import("@mons/shared/navigation").NavigationEventItem} EventItem
 */
/** @param {string} id @param {GameItem["status"]} [status] @returns {GameItem} */
const game = (id, status = "active") => ({
  id,
  entityType: "game",
  inviteId: id,
  kind: "direct",
  sortBucket: 1,
  hostLoginId: null,
  guestLoginId: null,
  opponentProfileId: null,
  opponentName: null,
  opponentEmoji: null,
  automatchStateHint: null,
  isPendingAutomatch: false,
  status,
  listSortAtMs: Date.UTC(2026, 5, 10),
});
/** @param {Partial<EventItem>} [overrides] @returns {EventItem} */
const event = (overrides = {}) => ({
  id: "event",
  entityType: "event",
  eventId: "event",
  sortBucket: 1,
  startAtMs: null,
  updatedAtMs: null,
  endedAtMs: null,
  winnerDisplayName: null,
  status: "waiting",
  listSortAtMs: Date.UTC(2026, 5, 10),
  participantCount: 0,
  participantPreview: [],
  ...overrides,
});
/** @param {{ id: string }[]} items */
const ids = (items) => items.map((item) => item.id);
const participants = (/** @type {(number | null)[]} */ ...emojiIds) =>
  emojiIds.map((emojiId) => ({
    profileId: null,
    displayName: null,
    emojiId,
    aura: null,
  }));

test("navigation sections preserve source order while grouping waiting games and hiding dismissed events", () => {
  const top = [
    game("active"),
    game("waiting-top", "waiting"),
    event({ id: "waiting-event" }),
    game("pending", "pending"),
    event({ id: "dismissed-top", status: "dismissed" }),
  ];
  const paged = [
    game("ended", "ended"),
    game("waiting-page", "waiting"),
    event({ id: "dismissed-page", status: "dismissed" }),
    event({ id: "ended-event", status: "ended" }),
  ];
  const before = structuredClone({ top, paged });
  const sections = partitionNavigationItems(top, paged);
  assert.deepEqual(ids(sections.waitingGames), ["waiting-top", "waiting-page"]);
  assert.deepEqual(ids(sections.topItems), [
    "active",
    "waiting-event",
    "pending",
  ]);
  assert.deepEqual(ids(sections.pagedItems), ["ended", "ended-event"]);
  assert.equal(sections.waitingGames[0], top[1]);
  assert.deepEqual({ top, paged }, before);
  assert.deepEqual(partitionNavigationItems([], []), {
    waitingGames: [],
    topItems: [],
    pagedItems: [],
  });
});

test("game status labels preserve local dates, year inclusion, and invalid timestamp fallback", () => {
  const now = new Date(2026, 9, 22);
  assert.equal(getGameStatusLabel(game("pending", "pending"), now), "pending");
  assert.equal(getGameStatusLabel(game("active"), now), "active");
  assert.equal(getGameStatusLabel(game("waiting", "waiting"), now), "waiting");
  for (const date of [new Date(2026, 5, 10), new Date(2025, 5, 10)]) {
    const item = { ...game("ended", "ended"), listSortAtMs: date.getTime() };
    assert.equal(
      getGameStatusLabel(item, now),
      date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        ...(date.getFullYear() === now.getFullYear()
          ? {}
          : { year: "numeric" }),
      }),
    );
  }
  for (const listSortAtMs of [0, NaN, Infinity, Date.UTC(1999, 11, 31), 9e15]) {
    assert.equal(
      getGameStatusLabel({ ...game("ended", "ended"), listSortAtMs }, now),
      "long ago",
    );
  }
});

test("event status labels keep timestamp precedence and treat invalid chosen timestamps as unknown", () => {
  const now = new Date(2026, 9, 22);
  const endedAtMs = new Date(2026, 3, 1).getTime();
  const updatedAtMs = new Date(2025, 4, 2).getTime();
  const listSortAtMs = new Date(2024, 5, 3).getTime();
  for (const status of /** @type {const} */ (["ended", "dismissed"])) {
    const item = event({ status, endedAtMs, updatedAtMs, listSortAtMs });
    const label = (/** @type {number} */ timestamp) =>
      getGameStatusLabel(
        { ...game("ended", "ended"), listSortAtMs: timestamp },
        now,
      );
    assert.equal(getEventStatusLabel(item, now), label(endedAtMs));
    assert.equal(
      getEventStatusLabel({ ...item, endedAtMs: null }, now),
      label(updatedAtMs),
    );
    assert.equal(
      getEventStatusLabel({ ...item, endedAtMs: null, updatedAtMs: null }, now),
      label(listSortAtMs),
    );
    for (const invalid of [0, NaN, Infinity, 9e15]) {
      assert.equal(
        getEventStatusLabel({ ...item, endedAtMs: invalid }, now),
        "long ago",
      );
    }
  }
  assert.equal(getEventStatusLabel(event(), now), "SOON");
  assert.equal(getEventStatusLabel(event({ status: "active" }), now), "active");
});

test("event previews keep the six-avatar boundary and reserve a slot for overflow", () => {
  const preview = (/** @type {number} */ participantCount) =>
    deriveEventPreview(
      event({
        participantCount,
        participantPreview: participants(1, 2, 3, 4, 5, 6, 7),
      }),
    );
  assert.deepEqual(preview(6), {
    emojiIds: [1, 2, 3, 4, 5, 6],
    showUnknownOpponent: false,
    overflowCount: null,
  });
  assert.deepEqual(preview(7), {
    emojiIds: [1, 2, 3, 4, 5],
    showUnknownOpponent: false,
    overflowCount: 2,
  });
  assert.deepEqual(
    deriveEventPreview(
      event({ participantCount: 1, participantPreview: participants(7) }),
    ),
    {
      emojiIds: [7],
      showUnknownOpponent: true,
      overflowCount: null,
    },
  );
  assert.equal(
    deriveEventPreview(event({ status: "active", participantCount: 1 }))
      .showUnknownOpponent,
    false,
  );
});

test("event previews retain canonical avatar order including zero and explicit unknown slots", () => {
  assert.deepEqual(
    deriveEventPreview(
      event({
        participantCount: 7,
        participantPreview: participants(null, 0, 3, 4, 5, 6, 7),
      }),
    ),
    {
      emojiIds: [0, 3, 4, 5, 6],
      showUnknownOpponent: false,
      overflowCount: 2,
    },
  );
  assert.deepEqual(
    deriveEventPreview(
      event({ participantCount: 7, participantPreview: participants(null, 5) }),
    ),
    {
      emojiIds: [5],
      showUnknownOpponent: false,
      overflowCount: 6,
    },
  );
  assert.deepEqual(deriveEventPreview(event({ participantCount: 0 })), {
    emojiIds: [],
    showUnknownOpponent: false,
    overflowCount: null,
  });
});
