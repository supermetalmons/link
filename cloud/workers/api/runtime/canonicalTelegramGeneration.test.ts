import { applyCanonicalTestMigrations } from "./canonicalTestMigrations.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createD1TelegramRepository,
  createD1TelegramAnnouncementRepository,
} from "../src/telegramD1.ts";
import {
  buildTelegramSendDesired,
  createTelegramDeliveryEngine,
} from "../../../runtime/telegram/deliveryEngine.js";
import {
  messageDocument,
  updateTelegramMessage,
} from "../../../runtime/telegram/records.js";
const testEnv = env as Env & { TEST_TELEGRAM_D1_MIGRATIONS: D1Migration[] };
const db = testEnv.TELEGRAM_DB;

describe("canonical Telegram generation", () => {
  beforeAll(async () => {
    await applyCanonicalTestMigrations(db, testEnv.TEST_TELEGRAM_D1_MIGRATIONS);
  });
  it("persists strict message receipts and does not send twice", async () => {
    const repository = createD1TelegramRepository(db, { now: () => 1000 });
    const key = `canonical:${crypto.randomUUID()}`;
    const desired = buildTelegramSendDesired({
      destination: "community",
      instanceKey: key,
      text: "canonical delivery",
      sourceRevision: "one",
    });
    await repository.transactMessage(key, (current) => ({
      value: updateTelegramMessage(messageDocument(current), { desired }),
      decision: "seed",
    }));
    let sends = 0;
    const engine = createTelegramDeliveryEngine({
      repository,
      now: () => 1000,
      resolveDestination: () => "chat",
      createOwnerToken: () => "owner",
      createAttemptId: () => "attempt",
      client: {
        sendTelegramMessage: async () => {
          sends++;
          return { ok: true, outcome: "sent", httpStatus: 200, messageId: 42 };
        },
        editTelegramMessage: async () => ({
          ok: true,
          outcome: "edited",
          httpStatus: 200,
        }),
        deleteTelegramMessage: async () => ({
          ok: true,
          outcome: "deleted",
          httpStatus: 200,
        }),
      },
    });
    expect((await engine.reconcile({ messageKey: key })).status).toBe(
      "delivered",
    );
    await engine.reconcile({ messageKey: key });
    expect(sends).toBe(1);
    expect((await repository.getMessage(key))?.applied?.messageId).toBe(42);
    expect(
      await db
        .prepare(
          "SELECT count(*) count FROM sqlite_schema WHERE type = 'table' AND name = 'telegram_messages'",
        )
        .first(),
    ).toEqual({ count: 0 });
  });
  it("rejects legacy or opaque records at SQL and repository boundaries", async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO telegram_messages_canonical VALUES ('invalid', '{}', 1, 1)",
        )
        .run(),
    ).rejects.toThrow();
    const repository = createD1TelegramRepository(db);
    await expect(
      repository.transactMessage("invalid", () => ({
        value: JSON.parse('{"schemaVersion":1,"opaque":{}}'),
        decision: "invalid",
      })),
    ).rejects.toThrow();
  });
  it("keeps confirmed announcements immutable and deduplicates attempts", async () => {
    const repository = createD1TelegramAnnouncementRepository(db);
    const requestId = `receipt:${crypto.randomUUID()}`;
    expect(
      await repository.reserve({
        requestId,
        payloadDigest: "digest",
        createdAtMs: 1000,
      }),
    ).toBe("reserved");
    expect(
      await repository.storeOutcome({
        requestId,
        payloadDigest: "digest",
        status: "sent",
        updatedAtMs: 1001,
        messageIds: [12, 13],
      }),
    ).toBe(true);
    expect(
      await repository.reserve({
        requestId,
        payloadDigest: "digest",
        createdAtMs: 1002,
      }),
    ).toMatchObject({ schemaVersion: 1, status: "sent", messageIds: [12, 13] });
    await expect(
      db
        .prepare(
          "UPDATE telegram_event_prize_announcements_canonical SET message_ids_json='[14]' WHERE request_id=?",
        )
        .bind(requestId)
        .run(),
    ).rejects.toThrow();
  });
});
