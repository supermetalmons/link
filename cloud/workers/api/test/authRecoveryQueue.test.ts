import assert from "node:assert/strict";
import test from "node:test";
import { handleAuthRecoveryMessage } from "../src/authRecovery.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const task = { kind: "auth-profile-recovery", profileId: "profile-1" };

function fixture(body: unknown = task) {
  const operations: unknown[] = [];
  const message: Message<unknown> = {
    id: "auth-recovery-message",
    attempts: 3,
    timestamp: new Date(0),
    body,
    ack: () => operations.push("ack"),
    retry: (options) => operations.push({ retry: options }),
  };
  const logger = {
    info: (entry: string) => operations.push({ info: JSON.parse(entry) }),
    error: (entry: string) => operations.push({ error: JSON.parse(entry) }),
  };
  return { message, logger, operations };
}

test("acknowledges and reports invalid auth recovery tasks without recovering", async () => {
  const { message, logger, operations } = fixture({ ...task, extra: true });
  await handleAuthRecoveryMessage(
    message,
    TELEGRAM_TEST_ENV,
    async () => {
      assert.fail("invalid task must not start recovery");
    },
    logger,
  );
  assert.deepEqual(operations, [
    "ack",
    {
      error: {
        event: "auth_recovery_queue_invalid_message",
        messageId: message.id,
        attempts: 3,
      },
    },
  ]);
});

test("preserves completed and deferred auth recovery outcomes", async () => {
  for (const status of ["done", "deferred"] as const) {
    const { message, logger, operations } = fixture();
    await handleAuthRecoveryMessage(
      message,
      TELEGRAM_TEST_ENV,
      async (profileId) => {
        assert.equal(profileId, task.profileId);
        assert.deepEqual(operations, []);
        return status;
      },
      logger,
    );
    assert.deepEqual(operations, [
      status === "done" ? "ack" : { retry: { delaySeconds: 60 } },
      {
        info: {
          event:
            status === "done"
              ? "auth_recovery_queue_processed"
              : "auth_recovery_queue_retrying",
          profileId: task.profileId,
          status,
          messageId: message.id,
          attempts: 3,
        },
      },
    ]);
  }
});

test("enqueues confirmed progress before acknowledging even at the retry limit", async () => {
  const { message, logger, operations } = fixture();
  let acceptSend!: () => void;
  const pendingSend = new Promise<void>((resolve) => {
    acceptSend = resolve;
  });
  let startedSend!: () => void;
  const sending = new Promise<void>((resolve) => {
    startedSend = resolve;
  });
  const env = {
    ...TELEGRAM_TEST_ENV,
    AUTH_RECOVERY_QUEUE: {
      ...TELEGRAM_TEST_ENV.AUTH_RECOVERY_QUEUE,
      async send(body, options) {
        operations.push({ send: { body, options } });
        startedSend();
        await pendingSend;
        return TELEGRAM_TEST_ENV.AUTH_RECOVERY_QUEUE.send();
      },
    },
  } satisfies Env;
  const handling = handleAuthRecoveryMessage(
    { ...message, attempts: 100 },
    env,
    async () => "continued",
    logger,
  );
  await sending;
  assert.deepEqual(operations, [
    { send: { body: task, options: { delaySeconds: 0 } } },
  ]);
  acceptSend();
  await handling;
  assert.deepEqual(operations, [
    { send: { body: task, options: { delaySeconds: 0 } } },
    "ack",
    {
      info: {
        event: "auth_recovery_queue_processed",
        profileId: task.profileId,
        status: "continued",
        messageId: message.id,
        attempts: 100,
      },
    },
  ]);
});

test("retries a failed continuation send without acknowledging", async () => {
  const { message, logger, operations } = fixture();
  const env = {
    ...TELEGRAM_TEST_ENV,
    AUTH_RECOVERY_QUEUE: {
      ...TELEGRAM_TEST_ENV.AUTH_RECOVERY_QUEUE,
      async send(body, options) {
        operations.push({ send: { body, options } });
        throw new Error("queue-unavailable");
      },
    },
  } satisfies Env;
  await handleAuthRecoveryMessage(
    message,
    env,
    async () => "continued",
    logger,
  );
  assert.deepEqual(operations, [
    { send: { body: task, options: { delaySeconds: 0 } } },
    { retry: { delaySeconds: 60 } },
    {
      error: {
        event: "auth_recovery_queue_failed",
        profileId: task.profileId,
        code: "queue-unavailable",
        messageId: message.id,
        attempts: 3,
      },
    },
  ]);
});

test("retries auth recovery failures with their cause and message identity", async () => {
  for (const error of [new Error("profile-db-unavailable"), null]) {
    const { message, logger, operations } = fixture();
    await handleAuthRecoveryMessage(
      message,
      TELEGRAM_TEST_ENV,
      async () => {
        throw error;
      },
      logger,
    );
    assert.deepEqual(operations, [
      { retry: { delaySeconds: 60 } },
      {
        error: {
          event: "auth_recovery_queue_failed",
          profileId: task.profileId,
          code: error instanceof Error ? error.message : "unknown",
          messageId: message.id,
          attempts: 3,
        },
      },
    ]);
  }
});
