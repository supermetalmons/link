import assert from "node:assert/strict";
import test from "node:test";
import { createEventProfileGameProjectionRepository } from "../src/eventProfileGameProjectionProducer.ts";
import { getEventProfileGameProjectionOutboxPath } from "../src/profileGameProjectionOutbox.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

function repository(input: {
  get?: GameplayRepository["getRtdbPath"];
  patch: GameplayRepository["patchRtdbRoot"];
}): GameplayRepository {
  return {
    applyWagerTransferOnce: async () => "applied",
    deleteNavigationGame: async () => "deleted",
    readProfileOwnershipSnapshot: async () => {
      throw new Error("unexpected-profile-ownership-read");
    },
    getMiningMaterials: async () => ({
      dust: 0,
      gum: 0,
      ice: 0,
      metal: 0,
      slime: 0,
    }),
    getMiningSnapshot: async () => null,
    getNavigationGame: async () => null,
    getRtdbPath: input.get || (async () => null),
    patchRtdbRoot: input.patch,
    transactRtdbPath: async () => ({ committed: false, value: null }),
  };
}

test("event mutations persist cleanup owners before enqueueing", async () => {
  const patches: Record<string, unknown>[] = [];
  const enqueued: Array<Record<string, string>> = [];
  let patchCompleted = false;
  let requestIndex = 0;
  const wrapped = createEventProfileGameProjectionRepository(
    TELEGRAM_TEST_ENV,
    repository({
      get: async (path) => {
        assert.equal(path, "events/event-1");
        return {
          participants: {
            source: { profileId: "source-profile" },
            target: { profileId: "target-profile" },
          },
        };
      },
      patch: async (updates) => {
        patches.push(updates);
        patchCompleted = true;
      },
    }),
    {
      createRequestId: () => `request-${++requestIndex}`,
      enqueue: async (task) => {
        assert.equal(patchCompleted, true);
        enqueued.push(task);
      },
      now: () => 123,
    },
  );

  await wrapped.patchRtdbRoot({
    "events/event-1/participants/source-profile": null,
    "events/event-1/updatedAtMs": 123,
  });

  const outbox = getEventProfileGameProjectionOutboxPath("event-1");
  assert.deepEqual(enqueued, [
    {
      kind: "event-profile-game-projection",
      eventId: "event-1",
      requestId: "request-1",
    },
  ]);
  assert.equal(patches[0][`${outbox}/schemaVersion`], 1);
  assert.equal(patches[0][`${outbox}/status`], "pending");
  assert.equal(patches[0][`${outbox}/requestId`], "request-1");
  assert.equal(patches[0][`${outbox}/lastQueuedAtMs`], 123);
  assert.equal(
    patches[0][`${outbox}/cleanupOwnerProfileIds/source-profile`],
    true,
  );
  assert.equal(
    patches[0][`${outbox}/cleanupOwnerProfileIds/target-profile`],
    true,
  );
  assert.equal(Object.hasOwn(patches[0], outbox), false);
});

test("event deletion captures every pre-mutation owner", async () => {
  let persisted: Record<string, unknown> = {};
  const wrapped = createEventProfileGameProjectionRepository(
    TELEGRAM_TEST_ENV,
    repository({
      get: async () => ({
        participants: { owner: { profileId: "owner-profile" } },
      }),
      patch: async (updates) => {
        persisted = updates;
      },
    }),
    {
      createRequestId: () => "request-delete",
      enqueue: async () => undefined,
      now: () => 456,
    },
  );
  await wrapped.patchRtdbRoot({ "events/event-1": null });
  const outbox = getEventProfileGameProjectionOutboxPath("event-1");
  assert.equal(
    persisted[`${outbox}/cleanupOwnerProfileIds/owner-profile`],
    true,
  );
});

test("superseding event writes preserve accumulated cleanup children", async () => {
  const patches: Record<string, unknown>[] = [];
  let previousOwner = "owner-a";
  const wrapped = createEventProfileGameProjectionRepository(
    TELEGRAM_TEST_ENV,
    repository({
      get: async () => ({
        participants: { owner: { profileId: previousOwner } },
      }),
      patch: async (updates) => {
        patches.push(updates);
      },
    }),
    {
      createRequestId: () => `request-${patches.length + 1}`,
      enqueue: async () => undefined,
      now: () => patches.length + 1,
    },
  );
  await wrapped.patchRtdbRoot({ "events/event-1/status": "active" });
  previousOwner = "owner-b";
  await wrapped.patchRtdbRoot({ "events/event-1/status": "ended" });
  const outbox = getEventProfileGameProjectionOutboxPath("event-1");
  assert.equal(patches[0][`${outbox}/cleanupOwnerProfileIds/owner-a`], true);
  assert.equal(patches[1][`${outbox}/cleanupOwnerProfileIds/owner-b`], true);
  assert.equal(
    Object.hasOwn(patches[1], `${outbox}/cleanupOwnerProfileIds/owner-a`),
    false,
  );
  assert.equal(Object.hasOwn(patches[1], outbox), false);
});

test("enqueue failure leaves the committed event marker recoverable", async () => {
  let persisted: Record<string, unknown> = {};
  const logs: string[] = [];
  const wrapped = createEventProfileGameProjectionRepository(
    TELEGRAM_TEST_ENV,
    repository({
      patch: async (updates) => {
        persisted = updates;
      },
    }),
    {
      createRequestId: () => "request-1",
      enqueue: async () => {
        throw new Error("queue-unavailable");
      },
      logger: { error: (message) => logs.push(String(message)) },
      now: () => 789,
    },
  );
  await wrapped.patchRtdbRoot({ "events/event-1/status": "active" });
  const outbox = getEventProfileGameProjectionOutboxPath("event-1");
  assert.equal(persisted[`${outbox}/requestId`], "request-1");
  assert.equal(logs.length, 1);
});

test("non-event writes pass through and scheduled dispatch is detached", async () => {
  const patches: Record<string, unknown>[] = [];
  let enqueues = 0;
  const scheduled: Promise<void>[] = [];
  let finishEnqueue: (() => void) | undefined;
  const enqueueBlocked = new Promise<void>((resolve) => {
    finishEnqueue = resolve;
  });
  const wrapped = createEventProfileGameProjectionRepository(
    TELEGRAM_TEST_ENV,
    repository({
      patch: async (updates) => {
        patches.push(updates);
      },
    }),
    {
      createRequestId: () => "request-1",
      enqueue: () => {
        enqueues += 1;
        return enqueueBlocked;
      },
      schedule: (work) => scheduled.push(work),
    },
  );
  const inviteUpdate = { "invites/invite-1/status": "active" };
  await wrapped.patchRtdbRoot(inviteUpdate);
  assert.deepEqual(patches, [inviteUpdate]);
  assert.equal(enqueues, 0);
  const irrelevantEventUpdate = { "events/event-1/rounds/0": {} };
  await wrapped.patchRtdbRoot(irrelevantEventUpdate);
  assert.deepEqual(patches, [inviteUpdate, irrelevantEventUpdate]);
  assert.equal(enqueues, 0);
  await wrapped.patchRtdbRoot({ "events/event-1/status": "active" });
  assert.equal(scheduled.length, 1);
  finishEnqueue?.();
  await scheduled[0];
});
