import assert from "node:assert/strict";
import test from "node:test";
import { notifyEventUpdates } from "../src/eventUpdatesNotifications.ts";

const epoch = "446cba4b-31c0-4c5e-8daa-af7d235fbe0f";

function environment(
  notify: (eventId: string, epoch: string, revision: number) => Promise<void>,
) {
  return {
    EVENT_DB_BOOKMARK_EPOCH: epoch.toUpperCase(),
    EVENT_UPDATES: {
      getByName: (eventId: string) => ({
        notifyEventChanged: async (
          incomingId: string,
          incomingEpoch: string,
          revision: number,
        ) => {
          assert.equal(incomingId, eventId);
          await notify(eventId, incomingEpoch, revision);
        },
      }),
    },
  };
}

test("event updates publish committed revisions in the configured epoch", async () => {
  const updates: unknown[] = [];
  await notifyEventUpdates(
    environment(async (...update) => {
      updates.push(update);
    }),
    { "event-one": 2, "event-two": 31 },
  );
  assert.deepEqual(updates, [
    ["event-one", epoch, 2],
    ["event-two", epoch, 31],
  ]);
});

test("empty and invalid commit targets cannot notify an event room", async () => {
  let updates = 0;
  const env = environment(async () => {
    updates++;
  });
  await notifyEventUpdates(env, {});
  await notifyEventUpdates(env, {
    "": 1,
    " event-one": 1,
    "event/one": 1,
    "event-zero": 0,
    "event-negative": -1,
    "event-fraction": 1.5,
    "event-unsafe": Number.MAX_SAFE_INTEGER + 1,
  });
  assert.equal(updates, 0);
  await notifyEventUpdates({ EVENT_DB_BOOKMARK_EPOCH: epoch }, { event: 1 });
});

test("event notification failure and timeout cannot reject committed work", async () => {
  for (const notify of [
    async () => {
      throw new Error("room-unavailable");
    },
    () => new Promise<void>(() => undefined),
  ]) {
    let failures = 0;
    await notifyEventUpdates(
      environment(notify),
      { event: 1 },
      {
        timeoutMs: 1,
        logFailure: () => {
          failures++;
        },
      },
    );
    assert.equal(failures, 1);
  }
});

test("invalid epochs suppress delivery without rejecting committed work", async () => {
  let updates = 0;
  let failures = 0;
  await notifyEventUpdates(
    {
      ...environment(async () => {
        updates++;
      }),
      EVENT_DB_BOOKMARK_EPOCH: "invalid",
    },
    { event: 1 },
    { logFailure: () => failures++ },
  );
  assert.equal(updates, 0);
  assert.equal(failures, 1);
});

test("one failed room does not suppress the other committed events", async () => {
  const updates: string[] = [];
  await notifyEventUpdates(
    environment(async (eventId) => {
      updates.push(eventId);
      if (eventId === "event-one") throw new Error("room-unavailable");
    }),
    { "event-one": 1, "event-two": 2 },
    { logFailure: () => undefined },
  );
  assert.deepEqual(updates, ["event-one", "event-two"]);
});
