import assert from "node:assert/strict";
import test from "node:test";
import type { EventProgressOutboxRecord } from "../../../runtime/events.js";
import type { EventProgressOutboxWriter } from "../src/eventStoreContracts.ts";
import type { RatingGameplayReader } from "../src/ratingContracts.ts";
import { createRatingRepository } from "../src/ratingRepository.ts";

const outbox: EventProgressOutboxRecord = {
  schemaVersion: 1,
  eventId: "event-1",
  sourceKey: "rating:invite-1:match-1",
  reason: "rating-completed",
  runAtMs: null,
  firstQueuedAtMs: 1_000,
  lastQueuedAtMs: 1_000,
};

const gameplayReads: RatingGameplayReader = {
  readInviteMetadata: async () => ({ hostId: "player-1" }),
  readMatchRecord: async () => null,
  readMatchPair: async (input) => ({
    ...input,
    epoch: 1,
    revision: 0,
    playerMatch: null,
    opponentMatch: null,
    claim: null,
  }),
  readProfileOwnershipSnapshot: async () => ({
    canonicalProfileIdByProfileId: new Map(),
    loginOwnerByUid: new Map(),
    loginUidsByProfileId: new Map(),
    profileById: new Map(),
  }),
};

test("ratings accept only gameplay reads and an explicit event outbox writer", async () => {
  const db = new Proxy({} as D1Database, {
    get() {
      assert.fail(
        "forwarded reads and outbox writes must not access profile D1",
      );
    },
  });
  const calls: Parameters<
    EventProgressOutboxWriter["putEventProgressOutbox"]
  >[] = [];
  const writer: EventProgressOutboxWriter = {
    async putEventProgressOutbox(...args) {
      assert.equal(this, writer);
      calls.push(args);
    },
  };
  const rating = createRatingRepository(db, gameplayReads, writer);

  assert.deepEqual(await rating.readInviteMetadata("invite-1"), {
    hostId: "player-1",
  });
  assert.equal(
    await rating.readMatchRecord({ playerId: "player-1", matchId: "match-1" }),
    null,
  );
  const pair = {
    inviteId: "invite-1",
    matchId: "match-1",
    playerId: "player-1",
    opponentId: "player-2",
  };
  assert.deepEqual(await rating.readMatchPair(pair), {
    ...pair,
    epoch: 1,
    revision: 0,
    playerMatch: null,
    opponentMatch: null,
    claim: null,
  });
  assert.deepEqual(
    await rating.readProfileOwnershipSnapshot({
      loginUids: [],
      profileIds: [],
    }),
    await gameplayReads.readProfileOwnershipSnapshot({
      loginUids: [],
      profileIds: [],
    }),
  );
  await rating.putEventProgressOutbox("outbox-1", outbox);
  assert.deepEqual(calls, [["outbox-1", outbox]]);
  assert.equal(calls[0][1], outbox);
});

test("ratings propagate the injected outbox failure without changing its identity", async () => {
  const failure = new Error("event-outbox-unavailable");
  const rating = createRatingRepository({} as D1Database, gameplayReads, {
    async putEventProgressOutbox() {
      throw failure;
    },
  });

  await assert.rejects(
    rating.putEventProgressOutbox("outbox-1", outbox),
    (error) => error === failure,
  );
});
