import assert from "node:assert/strict";
import test from "node:test";
import {
  authErrorResponse,
  ProfileWritesDisabledFailure,
} from "../src/authErrors.ts";
import {
  PROFILE_STORAGE_MODES,
  ProfileStorageModeFailure,
  parseProfileStorageMode,
  profileStorageUsesD1,
  profileStorageUsesFirestore,
  readProfileStorageMode,
} from "../src/profileStorageMode.ts";
import workerHandler from "../src/workerHandler.ts";
import { AUTH_RECOVERY_QUEUE_NAME } from "../src/authRecovery.ts";
import { PROFILE_GAME_PROJECTION_QUEUE_NAME } from "../src/profileGameProjectionTasks.ts";
import { PROFILE_READ_PROJECTION_QUEUE_NAME } from "../src/profileReadProjectionTasks.ts";
import { TELEGRAM_PROJECTION_QUEUE_NAME } from "../src/telegramProjectionTasks.ts";
import { TELEGRAM_TEST_ENV, withProfileControl } from "./testEnv.ts";

test("parses exactly the two profile storage backends", () => {
  assert.deepEqual(PROFILE_STORAGE_MODES, ["firestore", "d1"]);
  for (const mode of PROFILE_STORAGE_MODES) {
    assert.equal(parseProfileStorageMode(mode), mode);
    assert.equal(readProfileStorageMode({ PROFILE_STORAGE_MODE: mode }), mode);
    assert.equal(profileStorageUsesD1(mode), mode === "d1");
    assert.equal(profileStorageUsesFirestore(mode), mode === "firestore");
  }
  for (const value of [
    undefined,
    null,
    "",
    "FIRESTORE",
    "frozen",
    "firestore-frozen",
    "d1-frozen",
    "invalid",
  ]) {
    assert.throws(
      () => parseProfileStorageMode(value),
      ProfileStorageModeFailure,
    );
  }
});

test("returns one sanitized retryable profile freeze response", async () => {
  const response = authErrorResponse(new ProfileWritesDisabledFailure(), {
    Vary: "Origin",
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "unavailable",
    message: "profile-writes-disabled",
  });
});

function queueMessage(body: unknown) {
  let acknowledgements = 0;
  const retries: QueueRetryOptions[] = [];
  const message = {
    id: "message-1",
    timestamp: new Date(0),
    body,
    attempts: 1,
    ack() {
      acknowledgements++;
    },
    retry(options?: QueueRetryOptions) {
      retries.push(options || {});
    },
  } satisfies Message<unknown>;
  return {
    message,
    acknowledgements: () => acknowledgements,
    retries,
  };
}

function queueBatch(queue: string, messages: Message<unknown>[]) {
  return {
    queue,
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll: () => undefined,
    ackAll: () => undefined,
  } satisfies MessageBatch<unknown>;
}

test("retries profile Queue batches without acknowledging after import begins", async () => {
  for (const queue of [
    AUTH_RECOVERY_QUEUE_NAME,
    PROFILE_GAME_PROJECTION_QUEUE_NAME,
    PROFILE_READ_PROJECTION_QUEUE_NAME,
    TELEGRAM_PROJECTION_QUEUE_NAME,
  ]) {
    for (const state of ["importing", "frozen", "active"] as const) {
      const tracked = queueMessage({ kind: "task" });
      await workerHandler.queue(
        queueBatch(queue, [tracked.message]),
        withProfileControl(TELEGRAM_TEST_ENV as unknown as Env, state),
      );
      assert.equal(tracked.acknowledgements(), 0, `${queue}:${state}`);
      assert.deepEqual(
        tracked.retries,
        [{ delaySeconds: 300 }],
        `${queue}:${state}`,
      );
    }
  }
});

test("fails unreadable control closed without acknowledging", async () => {
  const tracked = queueMessage({ kind: "task" });
  await workerHandler.queue(
    queueBatch(AUTH_RECOVERY_QUEUE_NAME, [tracked.message]),
    {
      ...TELEGRAM_TEST_ENV,
      PROFILE_DB: {
        ...TELEGRAM_TEST_ENV.PROFILE_DB,
        prepare() {
          throw new Error("profile-control-unavailable");
        },
      } as unknown as D1Database,
    } as unknown as Env,
  );
  assert.equal(tracked.acknowledgements(), 0);
  assert.deepEqual(tracked.retries, [{ delaySeconds: 300 }]);
});

test("freezes wager settlement retries without blocking unrelated Telegram work", async () => {
  const settlement = queueMessage({
    kind: "wager-settlement",
    inviteId: "invite-1",
    matchId: "match-1",
    operationId: "operation-1",
  });
  const unrelated = queueMessage({ kind: "invalid-telegram-task" });
  await workerHandler.queue(
    queueBatch("mons-link-telegram-delivery", [
      settlement.message,
      unrelated.message,
    ]),
    withProfileControl(TELEGRAM_TEST_ENV as unknown as Env, "active"),
  );
  assert.equal(settlement.acknowledgements(), 0);
  assert.deepEqual(settlement.retries, [{ delaySeconds: 300 }]);
  assert.equal(unrelated.acknowledgements(), 1);
  assert.deepEqual(unrelated.retries, []);
});

test("keeps unrelated Telegram work independent of profile D1", async () => {
  const unrelated = queueMessage({ kind: "invalid-telegram-task" });
  await workerHandler.queue(
    queueBatch("mons-link-telegram-delivery", [unrelated.message]),
    {
      ...TELEGRAM_TEST_ENV,
      PROFILE_DB: {
        prepare() {
          throw new Error("profile-d1-unavailable");
        },
      } as unknown as D1Database,
    } as unknown as Env,
  );
  assert.equal(unrelated.acknowledgements(), 1);
  assert.deepEqual(unrelated.retries, []);
});

test("keeps the old projection consumer blocked after cutover", async () => {
  const tracked = queueMessage({ kind: "invalid" });
  await workerHandler.queue(
    queueBatch(PROFILE_READ_PROJECTION_QUEUE_NAME, [tracked.message]),
    withProfileControl(TELEGRAM_TEST_ENV as unknown as Env, "active"),
  );
  assert.equal(tracked.acknowledgements(), 0);
  assert.deepEqual(tracked.retries, [{ delaySeconds: 300 }]);
});
