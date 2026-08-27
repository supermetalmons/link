import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import {
  canonicalEventPrizeWithdrawalStorageMode,
  createCanonicalEventPrizeWithdrawalReader,
  createD1EventPrizeWithdrawalStore,
  listEventPrizeWithdrawalShadowRepairs,
  MAX_SHADOW_REPAIR_PAGE_SIZE,
  MAX_TRANSACTION_ATTEMPTS,
  readEventPrizeWithdrawalStorageControl,
  readEventPrizeWithdrawalStorageMode,
} from "../src/eventPrizeWithdrawalD1.ts";
import {
  createEventPrizeRuntimeDependencies,
  repairEventPrizeWithdrawalShadows,
} from "../src/eventPrizeWithdrawal.ts";

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
        "DELETE FROM event_prize_withdrawal_shadow_repairs",
      ),
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
        `UPDATE event_prize_withdrawal_runtime_control
         SET storage_mode = 'firebase', source_digest = NULL,
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

  it("replaces completed records and reports storage control mode", async () => {
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
    ).resolves.toBe("firebase");
    await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      `UPDATE event_prize_withdrawal_runtime_control
       SET storage_mode = 'd1'
       WHERE singleton = 1`,
    ).run();
    await expect(
      readEventPrizeWithdrawalStorageMode(testEnv.EVENT_PRIZE_WITHDRAWALS_DB),
    ).resolves.toBe("d1");
  });

  it("re-enqueues canonical state after a stale mirror arrives last", async () => {
    const store = createD1EventPrizeWithdrawalStore(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      { now: () => 300 },
    );
    const path = `eventPrizeWithdrawals/${eventId}/${prizeId}`;
    const older = processing(100);
    const newer = { ...processing(200), leaseId: "lease-2" };
    await store.replacePaths({ [path]: older });
    await store.replacePaths({ [path]: newer });
    await store.acknowledgeShadowPaths({ [path]: newer });
    expect(
      await listEventPrizeWithdrawalShadowRepairs(
        testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      ),
    ).toHaveLength(0);
    await store.acknowledgeShadowPaths({ [path]: older });
    expect(
      await listEventPrizeWithdrawalShadowRepairs(
        testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      ),
    ).toEqual([
      {
        eventId,
        prizeId,
        path,
        value: newer,
      },
    ]);
  });

  it("bounds repair pages below the Free-plan D1 query limit", async () => {
    expect(MAX_TRANSACTION_ATTEMPTS).toBe(12);
    expect(MAX_SHADOW_REPAIR_PAGE_SIZE).toBe(4);
    await expect(
      listEventPrizeWithdrawalShadowRepairs(
        testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
        MAX_SHADOW_REPAIR_PAGE_SIZE + 1,
      ),
    ).rejects.toThrow("invalid-event-prize-withdrawal-shadow-limit");
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
    let firebaseReads = 0;
    const readEvent = createCanonicalEventPrizeWithdrawalReader(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      async () => {
        firebaseReads += 1;
        return { [prizeId]: processing(100) };
      },
    );

    await expect(readEvent(eventId)).resolves.toEqual({ [prizeId]: current });
    expect(firebaseReads).toBe(0);
  });

  it("routes withdrawal references through D1 and fails closed while frozen", async () => {
    await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      `UPDATE event_prize_withdrawal_runtime_control
       SET storage_mode = 'd1'
       WHERE singleton = 1`,
    ).run();
    const path = `eventPrizeWithdrawals/${eventId}/${prizeId}`;
    const firebaseValues = new Map<string, unknown>();
    let shadowFailure = false;
    let shadowWrites = 0;
    const repository = {
      getRtdbPath: async (candidatePath: string) =>
        firebaseValues.get(candidatePath) ?? null,
      patchRtdbRoot: async (updates: Record<string, unknown>) => {
        shadowWrites += 1;
        if (shadowFailure) throw new Error("shadow-unavailable");
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
    expect(firebaseValues.get(path)).toEqual(processing(500));
    shadowFailure = true;
    const writesBeforeRead = shadowWrites;
    await expect(runtime.readWithdrawal(eventId, prizeId)).resolves.toEqual(
      processing(500),
    );
    expect(shadowWrites).toBe(writesBeforeRead);
    await expect(
      runtime.admin
        .database()
        .ref(path)
        .transaction((current) => ({
          ...(current as Record<string, unknown>),
          updatedAtMs: 550,
        })),
    ).resolves.toMatchObject({ committed: true });
    expect(
      await listEventPrizeWithdrawalShadowRepairs(
        testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      ),
    ).toHaveLength(1);
    shadowFailure = false;
    await expect(
      repairEventPrizeWithdrawalShadows(testEnv, { repository }),
    ).resolves.toBe(1);
    expect(
      await listEventPrizeWithdrawalShadowRepairs(
        testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      ),
    ).toHaveLength(0);
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
    expect(firebaseValues.get(path)).toMatchObject({ status: "completed" });

    await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      `UPDATE event_prize_withdrawal_runtime_control
       SET storage_mode = 'frozen', previous_storage_mode = 'd1'
       WHERE singleton = 1`,
    ).run();
    expect(
      canonicalEventPrizeWithdrawalStorageMode(
        await readEventPrizeWithdrawalStorageControl(
          testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
        ),
      ),
    ).toBe("d1");
    await expect(
      createEventPrizeRuntimeDependencies(testEnv, { repository }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
