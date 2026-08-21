"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseArgs,
  replayTelegramProjections,
} = require("../admin/replayTelegramProjections");

test("projection replay defaults safe and requires explicit execution", () => {
  assert.deepEqual(parseArgs(["--project", "mons-link"]), {
    adminArgs: ["--project", "mons-link"],
    dryRun: true,
  });
  assert.deepEqual(parseArgs(["--execute", "--database-url", "https://db"]), {
    adminArgs: ["--database-url", "https://db"],
    dryRun: false,
  });
  assert.throws(() => parseArgs(["--execute", "--dry-run"]));
  assert.throws(() => parseArgs(["--unknown"]));
});

test("projection replay reports pending work without mutating in dry-run", async () => {
  const result = await replayTelegramProjections(
    { dryRun: true },
    {
      database: {},
      firestore: {},
      readPendingProjections: async () => ({
        automatch: [{ inviteId: "auto_one", requestId: "request-1" }],
        ratings: [{ operationId: "rating-1" }],
      }),
      projectAutomatch: async () => {
        throw new Error("unexpected projection");
      },
    },
  );
  assert.deepEqual(result, {
    dryRun: true,
    automatch: 1,
    ratings: 1,
    failures: [],
  });
});

test("projection replay drains both source outboxes before rollback", async () => {
  const calls = [];
  const ratingUpdates = [];
  const database = {
    ref(path) {
      return {
        async transaction(updater) {
          calls.push({ path, cleared: updater({ requestId: "request-1" }) });
          return {
            committed: true,
            snapshot: { val: () => null },
          };
        },
      };
    },
  };
  const result = await replayTelegramProjections(
    { dryRun: false },
    {
      database,
      firestore: {},
      readPendingProjections: async () => ({
        automatch: [{ inviteId: "auto_one", requestId: "request-1" }],
        ratings: [
          {
            operationId: "rating-1",
            data: { inviteId: "auto_two" },
            ref: {
              async update(value) {
                ratingUpdates.push(value);
              },
            },
          },
        ],
      }),
      projectAutomatch: async (inviteId) => {
        calls.push({ inviteId });
        return { status: "queued" };
      },
      projectRating: async (data) => {
        calls.push({ rating: data.inviteId });
        return { status: "inserted" };
      },
    },
  );
  assert.deepEqual(result, {
    dryRun: false,
    automatch: 1,
    ratings: 1,
    failures: [],
  });
  assert.deepEqual(calls, [
    { inviteId: "auto_one" },
    {
      path: "telegramProjectionOutbox/automatch/auto_one",
      cleared: null,
    },
    { rating: "auto_two" },
    { inviteId: "auto_two" },
  ]);
  assert.equal(ratingUpdates.length, 1);
  assert.equal(ratingUpdates[0].telegramProjectionState, "done");
});

test("projection replay reports failures after processing later records", async () => {
  const projected = [];
  const ratingUpdates = [];
  const result = await replayTelegramProjections(
    { dryRun: false },
    {
      database: {
        ref(path) {
          return {
            transaction: async () =>
              path.endsWith("/auto_changed")
                ? {
                    committed: false,
                    snapshot: {
                      val: () => ({
                        status: "pending",
                        requestId: "new-request",
                      }),
                    },
                  }
                : {
                    committed: true,
                    snapshot: { val: () => null },
                  },
          };
        },
      },
      firestore: {},
      readPendingProjections: async () => ({
        automatch: [
          { inviteId: "auto_bad", requestId: "request-1" },
          { inviteId: "auto_changed", requestId: "request-2" },
          { inviteId: "auto_good", requestId: "request-2" },
        ],
        ratings: [
          {
            operationId: "rating_good",
            data: { inviteId: "auto_rating" },
            ref: {
              async update(value) {
                ratingUpdates.push(value);
              },
            },
          },
        ],
      }),
      projectAutomatch: async (inviteId) => {
        projected.push(inviteId);
        return { status: inviteId === "auto_bad" ? "skipped" : "queued" };
      },
      projectRating: async () => ({ status: "inserted" }),
    },
  );
  assert.deepEqual(projected, [
    "auto_bad",
    "auto_changed",
    "auto_good",
    "auto_rating",
  ]);
  assert.equal(ratingUpdates[0].telegramProjectionState, "done");
  assert.deepEqual(result.failures, [
    {
      kind: "automatch",
      id: "auto_bad",
      error: "projection-skipped",
    },
    {
      kind: "automatch",
      id: "auto_changed",
      error: "outbox-changed",
    },
  ]);
});
