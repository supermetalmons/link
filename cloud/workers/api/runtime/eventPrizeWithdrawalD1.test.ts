import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import {
  createD1EventPrizeWithdrawalReader,
  createD1EventPrizeWithdrawalStore,
  MAX_TRANSACTION_ATTEMPTS,
  readEventPrizeWithdrawalStorageControl,
  readEventPrizeWithdrawalStorageMode,
} from "../src/eventPrizeWithdrawalD1.ts";
import { createEventPrizeRuntimeDependencies } from "../src/eventPrizeWithdrawal.ts";

const testEnv = env as Env & {
  TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS: D1Migration[];
};

const eventId = "NN3eRzoZo80";
const prizeId = "1092";

function processing(updatedAtMs: number) {
  return {
    eventId,
    prizeId,
    status: "processing",
    leaseId: "lease-1",
    updatedAtMs,
  };
}

describe("event prize withdrawal D1 repository", () => {
  beforeAll(async () => {
    await applyD1Migrations(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      testEnv.TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.batch([
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
        "DELETE FROM event_prize_withdrawals",
      ),
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
        `UPDATE event_prize_withdrawal_runtime_control
         SET storage_mode = 'd1', source_digest = NULL,
             source_record_count = NULL, source_exported_at_ms = NULL,
             cutover_at_ms = NULL, previous_storage_mode = NULL,
             updated_at_ms = 1
         WHERE singleton = 1`,
      ),
    ]);
  });

  it("persists and conditionally updates a withdrawal record", async () => {
    const store = createD1EventPrizeWithdrawalStore(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      { now: () => 100 },
    );
    const reference = store.reference(eventId, prizeId);
    const created = await reference.transaction(() => processing(100));
    expect(created.committed).toBe(true);
    expect(await store.get(eventId, prizeId)).toEqual(processing(100));

    const aborted = await reference.transaction(() => undefined);
    expect(aborted.committed).toBe(false);
    expect(aborted.snapshot.val()).toEqual(processing(100));

    await reference.update({ status: "blocked", updatedAtMs: 200 });
    expect(await store.get(eventId, prizeId)).toMatchObject({
      status: "blocked",
      updatedAtMs: 200,
    });
  });

  it("retries optimistic conflicts without losing state transitions", async () => {
    const stores = Array.from({ length: 12 }, (_, index) =>
      createD1EventPrizeWithdrawalStore(testEnv.EVENT_PRIZE_WITHDRAWALS_DB, {
        now: () => 1_000 + index,
      }),
    );
    await Promise.all(
      stores.map((store) =>
        store.reference(eventId, prizeId).transaction((current) => ({
          ...(current && typeof current === "object" ? current : processing(1)),
          attempts:
            typeof (current as { attempts?: unknown } | null)?.attempts ===
            "number"
              ? Number((current as { attempts: number }).attempts) + 1
              : 1,
        })),
      ),
    );
    expect(await stores[0].get(eventId, prizeId)).toMatchObject({
      attempts: 12,
    });
  });

  it("replaces completed records and reports D1 storage control mode", async () => {
    const store = createD1EventPrizeWithdrawalStore(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      { now: () => 300 },
    );
    await store.replacePaths({
      [`eventPrizeWithdrawals/${eventId}/${prizeId}`]: {
        eventId,
        prizeId,
        status: "completed",
        transactionSignature: "signature",
        updatedAtMs: 300,
      },
    });
    expect(await store.get(eventId, prizeId)).toMatchObject({
      status: "completed",
      transactionSignature: "signature",
    });
    await expect(
      readEventPrizeWithdrawalStorageMode(testEnv.EVENT_PRIZE_WITHDRAWALS_DB),
    ).resolves.toBe("d1");
    await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      `UPDATE event_prize_withdrawal_runtime_control
       SET storage_mode = 'frozen', previous_storage_mode = 'd1'
       WHERE singleton = 1`,
    ).run();
    await expect(
      readEventPrizeWithdrawalStorageMode(testEnv.EVENT_PRIZE_WITHDRAWALS_DB),
    ).resolves.toBe("frozen");
  });

  it("retains bounded optimistic retries", () => {
    expect(MAX_TRANSACTION_ATTEMPTS).toBe(12);
  });

  it("reads event reconciliation state from the canonical store", async () => {
    await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      `UPDATE event_prize_withdrawal_runtime_control
       SET storage_mode = 'd1'
       WHERE singleton = 1`,
    ).run();
    const current = { ...processing(300), leaseId: "canonical-lease" };
    await createD1EventPrizeWithdrawalStore(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
    ).replacePaths({
      [`eventPrizeWithdrawals/${eventId}/${prizeId}`]: current,
    });
    const readEvent = createD1EventPrizeWithdrawalReader(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
    );

    await expect(readEvent(eventId)).resolves.toEqual({ [prizeId]: current });
  });

  it("routes withdrawal references only through D1 and fails closed while frozen", async () => {
    await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      `UPDATE event_prize_withdrawal_runtime_control
       SET storage_mode = 'd1'
       WHERE singleton = 1`,
    ).run();
    const path = `eventPrizeWithdrawals/${eventId}/${prizeId}`;
    const firebaseValues = new Map<string, unknown>();
    let firebaseWrites = 0;
    const repository = {
      getRtdbPath: async (candidatePath: string) =>
        firebaseValues.get(candidatePath) ?? null,
      patchRtdbRoot: async (updates: Record<string, unknown>) => {
        firebaseWrites += 1;
        for (const [candidatePath, value] of Object.entries(updates)) {
          if (value === null) firebaseValues.delete(candidatePath);
          else firebaseValues.set(candidatePath, value);
        }
      },
      transactRtdbPath: async (
        candidatePath: string,
        updater: (current: unknown) => unknown,
      ) => {
        const current = firebaseValues.get(candidatePath) ?? null;
        const decision = updater(current) as {
          commit?: false;
          decision?: string;
          value?: unknown;
        };
        if (decision.commit === false) {
          return {
            committed: false,
            decision: decision.decision,
            value: current,
          };
        }
        firebaseValues.set(candidatePath, decision.value);
        return {
          committed: true,
          decision: decision.decision,
          value: decision.value,
        };
      },
    };
    const runtime = await createEventPrizeRuntimeDependencies(testEnv, {
      repository,
    });
    await runtime.admin
      .database()
      .ref(path)
      .transaction(() => processing(500));
    expect(await runtime.readWithdrawal(eventId, prizeId)).toEqual(
      processing(500),
    );
    expect(firebaseValues.has(path)).toBe(false);
    expect(firebaseWrites).toBe(0);
    await expect(runtime.readWithdrawal(eventId, prizeId)).resolves.toEqual(
      processing(500),
    );
    await expect(
      runtime.admin
        .database()
        .ref(path)
        .transaction((current) => ({
          ...(current as Record<string, unknown>),
          updatedAtMs: 550,
        })),
    ).resolves.toMatchObject({ committed: true });
    expect(firebaseWrites).toBe(0);
    await runtime.admin
      .database()
      .ref()
      .update({
        [path]: {
          eventId,
          prizeId,
          status: "completed",
          updatedAtMs: 600,
        },
      });
    expect(await runtime.readWithdrawal(eventId, prizeId)).toMatchObject({
      status: "completed",
    });
    expect(firebaseValues.has(path)).toBe(false);
    expect(firebaseWrites).toBe(0);

    await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      `UPDATE event_prize_withdrawal_runtime_control
       SET storage_mode = 'frozen', previous_storage_mode = 'd1'
       WHERE singleton = 1`,
    ).run();
    await expect(
      readEventPrizeWithdrawalStorageControl(
        testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      ),
    ).resolves.toEqual({
      storageMode: "frozen",
      previousStorageMode: "d1",
    });
    await expect(
      createEventPrizeRuntimeDependencies(testEnv, { repository }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("applies the permanent D1 schema and rejects Firebase control state", async () => {
    const schema = await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      `SELECT name, type FROM sqlite_schema
       WHERE name LIKE 'event_prize_withdrawal%'
       ORDER BY type, name`,
    ).all<{ name: string; type: string }>();
    expect(schema.results).toEqual([
      { name: "event_prize_withdrawal_runtime_control", type: "table" },
      { name: "event_prize_withdrawals", type: "table" },
    ]);
    await expect(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
        `UPDATE event_prize_withdrawal_runtime_control
         SET storage_mode = 'firebase'
         WHERE singleton = 1`,
      ).run(),
    ).rejects.toThrow();
  });

  it("fails closed when storage control is missing", async () => {
    await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      "DELETE FROM event_prize_withdrawal_runtime_control WHERE singleton = 1",
    ).run();
    try {
      await expect(
        readEventPrizeWithdrawalStorageControl(
          testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
        ),
      ).rejects.toThrow("invalid-event-prize-withdrawal-storage-mode");
    } finally {
      await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
        `INSERT INTO event_prize_withdrawal_runtime_control (
           singleton, storage_mode, updated_at_ms, previous_storage_mode
         ) VALUES (1, 'd1', 1, NULL)`,
      ).run();
    }
  });
});
