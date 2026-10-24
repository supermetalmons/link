import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { createVersionedJsonRowStore } from "../src/versionedJsonD1.ts";
import { createD1TelegramRepository } from "../src/telegramD1.ts";
import { createD1EventPrizeWithdrawalStore } from "../src/eventPrizeWithdrawalD1.ts";

const testEnv = env as Env & {
  TEST_TELEGRAM_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS: D1Migration[];
};

function firstWriteChanges(db: D1Database, changes: number): D1Database {
  let writes = 0;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values));
        }
        if (property === "run") {
          return async () => {
            const result = await target.run();
            return ++writes === 1
              ? { ...result, meta: { ...result.meta, changes } }
              : result;
          };
        }
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => wrap(target.prepare(query));
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

describe("versioned JSON row persistence", () => {
  beforeAll(async () => {
    await applyD1Migrations(
      testEnv.TELEGRAM_DB,
      testEnv.TEST_TELEGRAM_D1_MIGRATIONS,
    );
    await applyD1Migrations(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      testEnv.TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    await testEnv.TELEGRAM_DB.batch([
      testEnv.TELEGRAM_DB.prepare("DELETE FROM telegram_messages"),
      testEnv.TELEGRAM_DB.prepare("DELETE FROM telegram_delivery_control"),
    ]);
    await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      "DELETE FROM event_prize_withdrawals",
    ).run();
  });

  it.each([
    {
      identity: { table: "telegram_messages", key: ["message-1"] },
      database: () => testEnv.TELEGRAM_DB,
    },
    {
      identity: { table: "telegram_delivery_control", key: [1] },
      database: () => testEnv.TELEGRAM_DB,
    },
    {
      identity: {
        table: "event_prize_withdrawals",
        key: ["event-1", "prize-1"],
      },
      database: () => testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
    },
  ] as const)(
    "rejects stale writes and preserves stored JSON for $identity.table",
    async ({ identity, database }) => {
      const rows = createVersionedJsonRowStore(database(), identity);
      const first = '{ "unknownField": null, "count": 1 }';
      const next = '{ "unknownField": null, "count": 2 }';
      expect(await rows.read()).toBeNull();
      expect(await rows.insertIfAbsent(first, 100)).toBe(1);
      expect(await rows.insertIfAbsent(next, 200)).toBe(0);
      expect(await rows.updateIfVersion(2, next, 200)).toBe(0);
      expect(await rows.deleteIfVersion(2)).toBe(0);
      expect(await rows.read()).toEqual({ record_json: first, version: 1 });
      expect(await rows.updateIfVersion(1, next, 200)).toBe(1);
      expect(await rows.deleteIfVersion(1)).toBe(0);
      expect(await rows.read()).toEqual({ record_json: next, version: 2 });
      expect(await rows.deleteIfVersion(2)).toBe(1);
      expect(await rows.read()).toBeNull();
      expect(await rows.deleteIfVersion(2)).toBe(0);
    },
  );

  it("isolates both parts of withdrawal keys", async () => {
    const rows = [
      ["event-1", "prize-1"],
      ["event-1", "prize-2"],
      ["event-2", "prize-1"],
    ].map(([eventId, prizeId]) =>
      createVersionedJsonRowStore(testEnv.EVENT_PRIZE_WITHDRAWALS_DB, {
        table: "event_prize_withdrawals",
        key: [eventId, prizeId],
      }),
    );
    for (const row of rows) await row.insertIfAbsent("{}", 100);
    await rows[0].updateIfVersion(1, '{"changed":true}', 200);
    await rows[0].deleteIfVersion(2);
    expect(await rows[0].read()).toBeNull();
    for (const row of rows.slice(1)) {
      expect(await row.read()).toEqual({ record_json: "{}", version: 1 });
    }
  });

  it.each(["insert", "update", "delete"] as const)(
    "preserves each adapter's affected-row predicate for %s",
    async (operation) => {
      const value = {
        eventId: "event-1",
        prizeId: "prize-1",
        status: "completed",
        updatedAtMs: 100,
      };
      const messageKey = "message-1";
      if (operation !== "insert") {
        await createD1TelegramRepository(testEnv.TELEGRAM_DB).transactMessage(
          messageKey,
          () => ({ value }),
        );
        await createD1EventPrizeWithdrawalStore(
          testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
        )
          .record(value.eventId, value.prizeId)
          .transaction(() => ({ value }));
      }
      let telegramDecisions = 0;
      let withdrawalDecisions = 0;
      const proposed = operation === "delete" ? null : value;
      const telegramResult = await createD1TelegramRepository(
        firstWriteChanges(testEnv.TELEGRAM_DB, 2),
      ).transactMessage(messageKey, () => {
        telegramDecisions++;
        return { value: proposed };
      });
      const withdrawalResult = await createD1EventPrizeWithdrawalStore(
        firstWriteChanges(testEnv.EVENT_PRIZE_WITHDRAWALS_DB, 2),
      )
        .record(value.eventId, value.prizeId)
        .transaction(() => {
          withdrawalDecisions++;
          return { value: proposed };
        });
      expect(telegramResult.committed).toBe(true);
      expect(withdrawalResult.committed).toBe(true);
      expect(telegramDecisions).toBe(2);
      expect(withdrawalDecisions).toBe(1);
    },
  );
});
