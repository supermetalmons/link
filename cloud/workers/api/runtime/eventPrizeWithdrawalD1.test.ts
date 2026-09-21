import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import {
  createD1EventPrizeWithdrawalReader,
  createD1EventPrizeWithdrawalStore,
  EventPrizeWithdrawalD1Failure,
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

function failingDatabase(error: Error): D1Database {
  const fail = () => {
    throw error;
  };
  return {
    batch: fail,
    dump: fail,
    exec: fail,
    prepare: fail,
    withSession: fail,
  };
}

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

  it.each([
    [
      "record",
      (db: D1Database) =>
        createD1EventPrizeWithdrawalStore(db).get(eventId, prizeId),
    ],
    ["storage control", readEventPrizeWithdrawalStorageControl],
    [
      "event",
      (db: D1Database) => createD1EventPrizeWithdrawalReader(db)(eventId),
    ],
  ] as const)(
    "preserves the D1 failure cause from %s reads",
    async (_, read) => {
      const cause = new Error("provider-failure");
      const failure: unknown = await read(failingDatabase(cause)).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(EventPrizeWithdrawalD1Failure);
      expect(failure).toHaveProperty(
        "message",
        "event-prize-withdrawal-d1-unavailable",
      );
      expect(failure instanceof Error && failure.cause).toBe(cause);

      const domainFailure = new EventPrizeWithdrawalD1Failure(
        "invalid-event-prize-withdrawal-record",
        { cause },
      );
      await expect(read(failingDatabase(domainFailure))).rejects.toBe(
        domainFailure,
      );
    },
  );

  it("persists and conditionally updates a withdrawal record", async () => {
    const store = createD1EventPrizeWithdrawalStore(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      { now: () => 100 },
    );
    const reference = store.record(eventId, prizeId);
    const created = await reference.transaction(() => ({
      value: processing(100),
    }));
    expect(created.committed).toBe(true);
    expect(await store.get(eventId, prizeId)).toEqual(processing(100));

    const aborted = await reference.transaction(() => ({ commit: false }));
    expect(aborted.committed).toBe(false);
    expect(aborted.value).toEqual(processing(100));

    await reference.transaction((current) => ({
      value: { ...current, status: "blocked", updatedAtMs: 200 },
    }));
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
        store.record(eventId, prizeId).transaction((current) => ({
          value: {
            ...(current && typeof current === "object"
              ? current
              : processing(1)),
            attempts:
              typeof (current as { attempts?: unknown } | null)?.attempts ===
              "number"
                ? Number((current as { attempts: number }).attempts) + 1
                : 1,
          },
        })),
      ),
    );
    expect(await stores[0].get(eventId, prizeId)).toMatchObject({
      attempts: 12,
    });
  });

  it("deletes existing and absent records without consulting the fallback clock", async () => {
    const store = createD1EventPrizeWithdrawalStore(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      {
        now: () => {
          throw new Error("unexpected-clock-read");
        },
      },
    );
    const reference = store.record(eventId, prizeId);
    await reference.transaction(() => ({ value: processing(100) }));
    for (const decision of ["deleted", "already-absent"]) {
      await expect(
        reference.transaction(() => ({ value: null, decision })),
      ).resolves.toEqual({
        committed: true,
        decision,
        value: null,
      });
      await expect(reference.read()).resolves.toBeNull();
    }
  });

  it("does not retry domain validation or timestamp failures", async () => {
    let decisions = 0;
    let clockCalls = 0;
    const reference = createD1EventPrizeWithdrawalStore(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      {
        now: () => {
          clockCalls++;
          return Number.NaN;
        },
      },
    ).record(eventId, prizeId);
    await expect(
      reference.transaction(() => {
        decisions++;
        return { value: { ...processing(100), eventId: "different-event" } };
      }),
    ).rejects.toThrow("invalid-event-prize-withdrawal-record");
    expect(decisions).toBe(1);
    expect(clockCalls).toBe(0);
    await expect(
      reference.transaction(() => {
        decisions++;
        return { value: processing(0) };
      }),
    ).rejects.toThrow("event-prize-withdrawal-d1-unavailable");
    expect(decisions).toBe(2);
    expect(clockCalls).toBe(1);
    await expect(reference.read()).resolves.toBeNull();
  });

  it("preserves serialization failures without retrying the transaction", async () => {
    const reference = createD1EventPrizeWithdrawalStore(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      { now: () => 100 },
    ).record(eventId, prizeId);
    const circular: Record<string, unknown> = processing(100);
    circular.self = circular;
    let decisions = 0;
    await expect(
      reference.transaction(() => {
        decisions++;
        return { value: circular };
      }),
    ).rejects.toMatchObject({
      message: "invalid-event-prize-withdrawal-record",
      cause: expect.any(TypeError),
    });
    expect(decisions).toBe(1);
    await expect(reference.read()).resolves.toBeNull();
  });

  it("replaces completed records and reports D1 storage control mode", async () => {
    const store = createD1EventPrizeWithdrawalStore(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      { now: () => 300 },
    );
    await store.replaceRecords([
      {
        eventId,
        prizeId,
        value: {
          eventId,
          prizeId,
          status: "completed",
          transactionSignature: "signature",
          updatedAtMs: 300,
        },
      },
    ]);
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

  it("blocks late claims after freeze while existing work drains", async () => {
    const store = createD1EventPrizeWithdrawalStore(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      { now: () => 500 },
    );
    const existing = store.record(eventId, prizeId);
    const latePrizeId = "1111";
    await existing.transaction(() => ({ value: processing(100) }));
    await expect(store.get(eventId, latePrizeId)).resolves.toBeNull();
    const observedExisting = await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      `SELECT version FROM event_prize_withdrawals
       WHERE event_id = ? AND prize_id = ?`,
    )
      .bind(eventId, prizeId)
      .first<{ version: number }>();
    expect(observedExisting?.version).toBe(1);

    await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      `UPDATE event_prize_withdrawal_runtime_control
       SET storage_mode = 'frozen', previous_storage_mode = 'd1'
       WHERE singleton = 1`,
    ).run();

    await expect(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
        `INSERT INTO event_prize_withdrawals (
           event_id, prize_id, record_json, version, updated_at_ms
         ) VALUES (?, ?, ?, 1, ?)`,
      )
        .bind(
          eventId,
          latePrizeId,
          JSON.stringify({
            ...processing(500),
            prizeId: latePrizeId,
            leaseId: "late-lease",
          }),
          500,
        )
        .run(),
    ).rejects.toThrow("event prize withdrawal storage is frozen");
    await expect(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
        `UPDATE event_prize_withdrawals
         SET record_json = ?, version = version + 1, updated_at_ms = ?
         WHERE event_id = ? AND prize_id = ? AND version = ?`,
      )
        .bind(
          JSON.stringify({
            ...processing(500),
            leaseId: "replacement-lease",
          }),
          500,
          eventId,
          prizeId,
          observedExisting!.version,
        )
        .run(),
    ).rejects.toThrow("event prize withdrawal storage is frozen");

    await expect(
      store.replaceRecords([{ eventId, prizeId, value: processing(550) }]),
    ).resolves.toBeUndefined();
    await expect(
      existing.transaction((current) => ({
        value: {
          ...(current as Record<string, unknown>),
          status: "submitted",
          transactionSignature: "signature",
          updatedAtMs: 600,
        },
      })),
    ).resolves.toMatchObject({ committed: true });
    await expect(
      existing.transaction((current) => ({
        value: {
          ...(current as Record<string, unknown>),
          leaseId: "submitted-replacement-lease",
          updatedAtMs: 650,
        },
      })),
    ).rejects.toThrow("event prize withdrawal storage is frozen");
    await expect(
      existing.transaction((current) => ({
        value: { ...current, updatedAtMs: 675 },
      })),
    ).resolves.toMatchObject({
      committed: true,
      value: {
        status: "submitted",
        transactionSignature: "signature",
        updatedAtMs: 675,
      },
    });
    await expect(
      store.replaceRecords([
        {
          eventId,
          prizeId,
          value: {
            eventId,
            prizeId,
            status: "completed",
            transactionSignature: "signature",
            updatedAtMs: 700,
          },
        },
      ]),
    ).resolves.toBeUndefined();
    await expect(store.get(eventId, prizeId)).resolves.toMatchObject({
      status: "completed",
      transactionSignature: "signature",
    });
    await expect(
      existing.transaction(() => ({ value: processing(800) })),
    ).rejects.toThrow("event prize withdrawal storage is frozen");

    await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      `UPDATE event_prize_withdrawal_runtime_control
       SET storage_mode = 'd1', previous_storage_mode = NULL
       WHERE singleton = 1`,
    ).run();
    const resumed = store.record(eventId, latePrizeId);
    await expect(
      resumed.transaction(() => ({
        value: { ...processing(900), prizeId: latePrizeId },
      })),
    ).resolves.toMatchObject({ committed: true });
    await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      `UPDATE event_prize_withdrawal_runtime_control
       SET storage_mode = 'frozen', previous_storage_mode = 'd1'
       WHERE singleton = 1`,
    ).run();
    await expect(
      resumed.transaction(() => ({ value: null })),
    ).resolves.toMatchObject({
      committed: true,
    });
    await expect(store.get(eventId, latePrizeId)).resolves.toBeNull();
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
    ).replaceRecords([{ eventId, prizeId, value: current }]);
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
    const sourceValues = new Map<string, unknown>();
    let sourceWrites = 0;
    const repository = {
      readProfileOwnershipSnapshot: async () => {
        throw new Error("unexpected-profile-ownership-read");
      },
      readProfileEventPrizeAssignment: async () => {
        throw new Error("unexpected-profile-prize-read");
      },
      transactProfileEventPrize: async () => {
        sourceWrites++;
        throw new Error("unexpected-profile-prize-transaction");
      },
    };
    const runtime = await createEventPrizeRuntimeDependencies(testEnv, {
      repository,
    });
    await runtime.withdrawals
      .record(eventId, prizeId)
      .transaction(() => ({ value: processing(500) }));
    expect(await runtime.readWithdrawal(eventId, prizeId)).toEqual(
      processing(500),
    );
    expect(sourceValues.has(path)).toBe(false);
    expect(sourceWrites).toBe(0);
    await expect(runtime.readWithdrawal(eventId, prizeId)).resolves.toEqual(
      processing(500),
    );
    await expect(
      runtime.withdrawals.record(eventId, prizeId).transaction((current) => ({
        value: {
          ...(current as Record<string, unknown>),
          updatedAtMs: 550,
        },
      })),
    ).resolves.toMatchObject({ committed: true });
    expect(sourceWrites).toBe(0);
    await runtime.withdrawals.replaceRecords([
      {
        eventId,
        prizeId,
        value: {
          eventId,
          prizeId,
          status: "completed",
          updatedAtMs: 600,
        },
      },
    ]);
    expect(await runtime.readWithdrawal(eventId, prizeId)).toMatchObject({
      status: "completed",
    });
    expect(sourceValues.has(path)).toBe(false);
    expect(sourceWrites).toBe(0);

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
      {
        name: "event_prize_withdrawals_reject_frozen_lease_update",
        type: "trigger",
      },
      {
        name: "event_prize_withdrawals_reject_frozen_processing_insert",
        type: "trigger",
      },
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
