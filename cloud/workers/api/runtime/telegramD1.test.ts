import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import {
  createD1TelegramAnnouncementRepository,
  createD1TelegramRepository,
  readTelegramStorageMode,
} from "../src/telegramD1.ts";

const testEnv = env as Env & {
  TEST_TELEGRAM_D1_MIGRATIONS: D1Migration[];
};

describe("Telegram D1 repositories", () => {
  beforeAll(async () => {
    await applyD1Migrations(
      testEnv.TELEGRAM_DB,
      testEnv.TEST_TELEGRAM_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    await testEnv.TELEGRAM_DB.batch([
      testEnv.TELEGRAM_DB.prepare("DELETE FROM telegram_messages"),
      testEnv.TELEGRAM_DB.prepare(
        "DELETE FROM telegram_event_prize_announcements",
      ),
      testEnv.TELEGRAM_DB.prepare(
        `UPDATE telegram_delivery_control
         SET record_json = '{}', version = 1, updated_at_ms = 1
         WHERE singleton = 1`,
      ),
      testEnv.TELEGRAM_DB.prepare(
        `INSERT INTO telegram_runtime_control (
           singleton, storage_mode, updated_at_ms
         ) VALUES (1, 'd1', 1)
         ON CONFLICT (singleton) DO UPDATE SET
           storage_mode = 'd1', updated_at_ms = 1`,
      ),
    ]);
  });

  it("persists JSON records and respects logical aborts across cold adapters", async () => {
    const first = createD1TelegramRepository(testEnv.TELEGRAM_DB, {
      now: () => 100,
    });
    await first.transactMessage("message-1", () => ({
      value: { desired: { revision: "a" }, count: 1 },
      decision: "created",
    }));
    const second = createD1TelegramRepository(testEnv.TELEGRAM_DB, {
      now: () => 200,
    });
    const aborted = await second.transactMessage("message-1", (current) => ({
      commit: false,
      decision: (current as { count: number }).count === 1 ? "same" : "wrong",
    }));
    expect(aborted).toMatchObject({ committed: false, decision: "same" });
    expect(await second.getMessage("message-1")).toEqual({
      desired: { revision: "a" },
      count: 1,
    });
  });

  it("retries optimistic conflicts without losing concurrent increments", async () => {
    const repositories = Array.from({ length: 12 }, (_, index) =>
      createD1TelegramRepository(testEnv.TELEGRAM_DB, {
        now: () => 1_000 + index,
      }),
    );
    await Promise.all(
      repositories.map((repository) =>
        repository.transactMessage("counter", (current) => ({
          value: {
            count:
              typeof (current as { count?: unknown } | null)?.count === "number"
                ? Number((current as { count: number }).count) + 1
                : 1,
          },
        })),
      ),
    );
    expect(await repositories[0].getMessage("counter")).toEqual({ count: 12 });
  });

  it("serializes the bot-wide retry barrier and API gate", async () => {
    const repository = createD1TelegramRepository(testEnv.TELEGRAM_DB, {
      now: () => 1_000,
    });
    await expect(repository.extendRetryNotBeforeMs(5_000)).resolves.toBe(5_000);
    await expect(repository.getRetryNotBeforeMs()).resolves.toBe(5_000);
    await expect(
      repository.acquireApiGate({
        owner: "owner-a",
        messageKey: "message-1",
        revision: "revision-1",
        operation: "send",
        acquiredAtMs: 6_000,
      }),
    ).resolves.toMatchObject({ acquired: true });
    await expect(
      repository.acquireApiGate({
        owner: "owner-b",
        messageKey: "message-2",
        revision: "revision-2",
        operation: "send",
        acquiredAtMs: 6_001,
      }),
    ).resolves.toMatchObject({ acquired: false, reason: "gate-held" });
    await expect(repository.releaseApiGate("owner-a")).resolves.toBe(true);
  });

  it("reserves and replays event-prize announcement receipts", async () => {
    const repository = createD1TelegramAnnouncementRepository(
      testEnv.TELEGRAM_DB,
    );
    const input = {
      requestId: "18ea8b32-ca88-4492-8ecb-42f87670a901",
      payloadDigest: "digest",
      createdAtMs: 100,
    };
    await expect(repository.reserve(input)).resolves.toBe("reserved");
    await expect(repository.reserve(input)).resolves.toMatchObject({
      payloadDigest: "digest",
      status: "sending",
    });
    await expect(
      repository.storeOutcome({
        requestId: input.requestId,
        payloadDigest: input.payloadDigest,
        status: "sent",
        updatedAtMs: 200,
        messageIds: [10, 11],
      }),
    ).resolves.toBe(true);
    await expect(repository.get(input.requestId)).resolves.toMatchObject({
      messageIds: [10, 11],
      status: "sent",
      eventId: null,
      attemptId: null,
      kind: "prizes",
    });
  });

  it("allows only one concurrent automatic album claim per event", async () => {
    const repositories = Array.from({ length: 4 }, () =>
      createD1TelegramAnnouncementRepository(testEnv.TELEGRAM_DB),
    );
    const input = {
      requestId: "event:prize-event:prizes:v1",
      payloadDigest: "album-digest",
      createdAtMs: 1_000,
      attempt: {
        eventId: "prize-event",
        startAtMs: 3_601_000,
        runAtMs: 1_000,
        firstQueuedAtMs: 500,
        payload: { text: "album", imageUrls: ["a", "b"] },
        attemptId: "attempt-a",
        expectedAttemptId: null,
      },
    };
    const results = await Promise.all(
      repositories.map((repository, index) =>
        repository.reserve({
          ...input,
          attempt: { ...input.attempt, attemptId: `attempt-${index}` },
        }),
      ),
    );
    expect(results.filter((result) => result === "reserved")).toHaveLength(1);
    const receipt = await repositories[0].get(input.requestId);
    expect(receipt).toMatchObject({
      status: "sending",
      eventId: "prize-event",
      firstQueuedAtMs: 500,
      attemptCount: 1,
      payload: input.attempt.payload,
      kind: "prizes",
    });
    await expect(
      repositories[0].reserve({
        ...input,
        createdAtMs: 1_000_000,
        attempt: {
          ...input.attempt,
          expectedAttemptId: receipt!.attemptId!,
        },
      }),
    ).resolves.toMatchObject({ status: "sending", attemptCount: 1 });
  });

  it("retries only due safe failures and fences outcomes from earlier attempts", async () => {
    const repository = createD1TelegramAnnouncementRepository(
      testEnv.TELEGRAM_DB,
    );
    const input = {
      requestId: "event:retry-event:prizes:v1",
      payloadDigest: "album-digest",
      createdAtMs: 1_000,
      attempt: {
        eventId: "retry-event",
        startAtMs: 3_601_000,
        runAtMs: 1_000,
        firstQueuedAtMs: 500,
        payload: { text: "album", imageUrls: ["a", "b"] },
        attemptId: "attempt-a",
        expectedAttemptId: null,
      },
    };
    await expect(repository.reserve(input)).resolves.toBe("reserved");
    await expect(
      repository.storeOutcome({
        requestId: input.requestId,
        payloadDigest: input.payloadDigest,
        attemptId: "attempt-a",
        status: "retryable",
        retryAtMs: 4_000,
        errorCode: "rate-limited",
        updatedAtMs: 2_000,
      }),
    ).resolves.toBe(true);
    const retry = {
      ...input,
      createdAtMs: 3_000,
      attempt: {
        ...input.attempt,
        attemptId: "attempt-b",
        expectedAttemptId: "attempt-a",
      },
    };
    await expect(repository.reserve(retry)).resolves.toMatchObject({
      status: "retryable",
    });
    await expect(
      repository.reserve({ ...retry, createdAtMs: 4_000 }),
    ).resolves.toBe("reserved");
    await expect(
      repository.storeOutcome({
        requestId: input.requestId,
        payloadDigest: input.payloadDigest,
        attemptId: "attempt-a",
        status: "sent",
        messageIds: [10, 11],
        updatedAtMs: 5_000,
      }),
    ).resolves.toBe(false);
    await expect(
      repository.storeOutcome({
        requestId: input.requestId,
        payloadDigest: input.payloadDigest,
        attemptId: "attempt-b",
        status: "sent",
        messageIds: [12, 13],
        updatedAtMs: 5_000,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.reserve({ ...retry, createdAtMs: 10_000 }),
    ).resolves.toMatchObject({
      status: "sent",
      messageIds: [12, 13],
      attemptId: "attempt-b",
      attemptCount: 2,
      retryAtMs: null,
    });
  });

  it("keeps uncertain albums reserved across cold repository instances", async () => {
    const repository = createD1TelegramAnnouncementRepository(
      testEnv.TELEGRAM_DB,
    );
    const input = {
      requestId: "event:uncertain-event:prizes:v1",
      payloadDigest: "album-digest",
      createdAtMs: 1_000,
      attempt: {
        eventId: "uncertain-event",
        startAtMs: 3_601_000,
        runAtMs: 1_000,
        firstQueuedAtMs: 500,
        payload: { text: "album", imageUrls: ["a", "b"] },
        attemptId: "attempt-a",
        expectedAttemptId: null,
      },
    };
    await repository.reserve(input);
    await repository.storeOutcome({
      requestId: input.requestId,
      payloadDigest: input.payloadDigest,
      attemptId: "attempt-a",
      status: "uncertain",
      errorCode: "timeout",
      updatedAtMs: 2_000,
    });
    const cold = createD1TelegramAnnouncementRepository(testEnv.TELEGRAM_DB);
    await expect(
      cold.reserve({ ...input, createdAtMs: 10_000 }),
    ).resolves.toMatchObject({
      status: "uncertain",
      errorCode: "timeout",
      attemptCount: 1,
    });
  });

  it("stores independent reminder and prize receipts for one event while retaining per-kind uniqueness", async () => {
    const repository = createD1TelegramAnnouncementRepository(
      testEnv.TELEGRAM_DB,
    );
    const prizes = {
      requestId: "event:shared-event:prizes:v1",
      payloadDigest: "album-digest",
      createdAtMs: 1_000,
      attempt: {
        eventId: "shared-event",
        startAtMs: 10_801_000,
        runAtMs: 7_201_000,
        firstQueuedAtMs: 500,
        payload: { text: "album", imageUrls: ["a", "b"] },
        attemptId: "prize-attempt",
        expectedAttemptId: null,
      },
    };
    const reminder = {
      ...prizes,
      requestId: "event:shared-event:reminder:v1",
      payloadDigest: "reminder-digest",
      attempt: {
        ...prizes.attempt,
        kind: "reminder" as const,
        runAtMs: 1_000,
        payload: { text: "reminder" },
        attemptId: "reminder-attempt",
      },
    };
    expect(
      await Promise.all([
        repository.reserve(prizes),
        repository.reserve(reminder),
      ]),
    ).toEqual(["reserved", "reserved"]);
    await repository.storeOutcome({
      requestId: reminder.requestId,
      payloadDigest: reminder.payloadDigest,
      attemptId: reminder.attempt.attemptId,
      status: "uncertain",
      updatedAtMs: 2_000,
    });
    await repository.storeOutcome({
      requestId: prizes.requestId,
      payloadDigest: prizes.payloadDigest,
      attemptId: prizes.attempt.attemptId,
      status: "sent",
      messageIds: [101, 102],
      updatedAtMs: 7_202_000,
    });
    await expect(repository.get(reminder.requestId)).resolves.toMatchObject({
      kind: "reminder",
      status: "uncertain",
    });
    await expect(repository.get(prizes.requestId)).resolves.toMatchObject({
      kind: "prizes",
      status: "sent",
      messageIds: [101, 102],
    });
    await expect(
      repository.reserve({ ...reminder, requestId: "duplicate-reminder" }),
    ).rejects.toThrow("telegram-d1-unavailable");
    const row = await testEnv.TELEGRAM_DB.prepare(
      "SELECT COUNT(*) AS count FROM telegram_event_prize_announcements WHERE event_id = ?",
    )
      .bind("shared-event")
      .first<{ count: number }>();
    expect(row?.count).toBe(2);
  });

  it("cannot change an existing retry receipt to a different announcement kind", async () => {
    const repository = createD1TelegramAnnouncementRepository(
      testEnv.TELEGRAM_DB,
    );
    const input = {
      requestId: "event:kind-event:reminder:v1",
      payloadDigest: "reminder-digest",
      createdAtMs: 1_000,
      attempt: {
        kind: "reminder" as const,
        eventId: "kind-event",
        startAtMs: 10_801_000,
        runAtMs: 1_000,
        firstQueuedAtMs: 500,
        payload: { text: "reminder" },
        attemptId: "reminder-attempt",
        expectedAttemptId: null,
      },
    };
    await repository.reserve(input);
    await repository.storeOutcome({
      requestId: input.requestId,
      payloadDigest: input.payloadDigest,
      attemptId: input.attempt.attemptId,
      status: "retryable",
      retryAtMs: 2_000,
      updatedAtMs: 1_500,
    });
    const retry = {
      ...input,
      createdAtMs: 2_000,
      attempt: {
        ...input.attempt,
        attemptId: "retry-attempt",
        expectedAttemptId: input.attempt.attemptId,
      },
    };
    await expect(
      repository.reserve({
        ...retry,
        attempt: { ...retry.attempt, kind: "prizes" },
      }),
    ).resolves.toMatchObject({
      kind: "reminder",
      status: "retryable",
      attemptCount: 1,
    });
    await expect(repository.reserve(retry)).resolves.toBe("reserved");
    await expect(
      repository.storeOutcome({
        requestId: retry.requestId,
        payloadDigest: retry.payloadDigest,
        attemptId: retry.attempt.attemptId,
        status: "sent",
        messageIds: [104],
        updatedAtMs: 2_001,
      }),
    ).resolves.toBe(true);
    await expect(repository.get(input.requestId)).resolves.toMatchObject({
      kind: "reminder",
      status: "sent",
      messageIds: [104],
      attemptCount: 2,
    });
  });

  it("fails closed when runtime control is absent", async () => {
    await testEnv.TELEGRAM_DB.prepare(
      "DELETE FROM telegram_runtime_control WHERE singleton = 1",
    ).run();
    await expect(readTelegramStorageMode(testEnv.TELEGRAM_DB)).resolves.toBe(
      "frozen",
    );
  });

  it("rejects restoring retired Firebase storage", async () => {
    await expect(
      testEnv.TELEGRAM_DB.prepare(
        `UPDATE telegram_runtime_control
         SET storage_mode = 'firebase'
         WHERE singleton = 1`,
      ).run(),
    ).rejects.toThrow(/firebase Telegram storage is retired/);
  });
});
