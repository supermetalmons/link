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
