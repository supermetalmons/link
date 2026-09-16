import assert from "node:assert/strict";
import test from "node:test";
import { eventSnapshotEtag, type EventSnapshotSeed } from "@mons/shared/events";
import { readOptionalEventSnapshotSeed } from "../src/eventSnapshotResponse.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const seed: EventSnapshotSeed = {
  snapshot: {
    ok: true,
    eventId: "event-one",
    revision: 1,
    event: { eventId: "event-one", status: "active" },
    prizeSelections: {},
  },
  etag: eventSnapshotEtag("event-one", 1),
  bookmark: "mons-d1-v1:00000000-0000-4000-8000-000000000001:native",
};

test("optional snapshot enrichment stops at one second and tolerates a late rejection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reject: (error: Error) => void = () => undefined;
  const pending = new Promise<EventSnapshotSeed>((_resolve, rejectRead) => {
    reject = rejectRead;
  });
  const result = readOptionalEventSnapshotSeed(
    TELEGRAM_TEST_ENV,
    "event-one",
    new AbortController().signal,
    { readEventSnapshotSeed: () => pending },
  );
  await Promise.resolve();
  t.mock.timers.tick(1_000);
  assert.equal(await result, null);
  reject(new Error("late-storage-error"));
  await Promise.resolve();
});

test("optional snapshot enrichment rejects foreign data and request cancellation", async () => {
  const controller = new AbortController();
  assert.deepEqual(
    await readOptionalEventSnapshotSeed(
      TELEGRAM_TEST_ENV,
      "event-one",
      controller.signal,
      { readEventSnapshotSeed: async () => seed },
    ),
    seed,
  );
  assert.equal(
    await readOptionalEventSnapshotSeed(
      TELEGRAM_TEST_ENV,
      "event-two",
      controller.signal,
      { readEventSnapshotSeed: async () => seed },
    ),
    null,
  );
  controller.abort();
  assert.equal(
    await readOptionalEventSnapshotSeed(
      TELEGRAM_TEST_ENV,
      "event-one",
      controller.signal,
      {
        readEventSnapshotSeed: async () => {
          throw new Error("must-not-read");
        },
      },
    ),
    null,
  );
});
