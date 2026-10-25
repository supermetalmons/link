import { createWithdrawalStorageFixture as createD1EventPrizeWithdrawalStore } from "../test/withdrawalStorageFixture.ts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import {
  createD1EventPrizeWithdrawalReader,
  createD1EventPrizeWithdrawalStore as createWithdrawalCommands,
  EventPrizeWithdrawalD1Failure,
  MAX_TRANSACTION_ATTEMPTS,
  readEventPrizeWithdrawalStorageControl,
  readEventPrizeWithdrawalStorageMode,
} from "../src/eventPrizeWithdrawalD1.ts";
import { buildWithdrawalCompletion } from "../../../runtime/eventPrizeWithdrawalState.js";
import {
  withdrawalStatus,
  writeCompletedWithdrawal,
} from "../../../runtime/eventPrizes/records.js";
import { createEventPrizeRuntimeDependencies } from "../src/eventPrizeWithdrawal.ts";
import { createEventPrizeContext } from "../src/eventPrizeWithdrawal/context.ts";

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

  it("returns the proposed object and retains its valid stored timestamp", async () => {
    let clockCalls = 0;
    const store = createD1EventPrizeWithdrawalStore(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      { now: () => ++clockCalls },
    );
    const value = {
      ...processing(100),
      updatedAtMs: "200",
      omitted: undefined,
    };
    const result = await store
      .record(eventId, prizeId)
      .transaction(() => ({ value }));
    expect(result.value).toBe(value);
    expect(clockCalls).toBe(0);
    expect(await store.get(eventId, prizeId)).toEqual({
      ...processing(100),
      updatedAtMs: "200",
    });
    expect(
      await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
        `SELECT updated_at_ms FROM event_prize_withdrawals
         WHERE event_id = ? AND prize_id = ?`,
      )
        .bind(eventId, prizeId)
        .first<number>("updated_at_ms"),
    ).toBe(200);
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

  it("routes public commands through the existing CAS write and abort behavior", async () => {
    const raw = createD1EventPrizeWithdrawalStore(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
    );
    await raw
      .record(eventId, prizeId)
      .transaction(() => ({ value: processing(100) }));
    let metadataClockCalls = 0;
    const commands = createWithdrawalCommands(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
      {
        now: () => {
          metadataClockCalls++;
          return 200;
        },
      },
    ).record(eventId, prizeId);
    const version = () =>
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
        "SELECT version FROM event_prize_withdrawals WHERE event_id = ? AND prize_id = ?",
      )
        .bind(eventId, prizeId)
        .first<number>("version");
    for (const [expectedVersion, execute] of [
      [2, () => commands.releaseProcessing("stale")],
      [3, () => commands.block({ leaseId: "stale", observedOwner: "other" })],
      [
        4,
        () =>
          commands.persistSubmission({
            leaseId: "stale",
            transactionSignature: "signature",
            signedTransactionBase64: "AQID",
            blockhash: "hash",
            lastValidBlockHeight: 123,
          }),
      ],
    ] as const) {
      await expect(execute()).resolves.toMatchObject({
        committed: true,
        value: processing(100),
      });
      expect(await version()).toBe(expectedVersion);
    }
    await expect(
      commands.discardSubmission({
        leaseId: "stale",
        transactionSignature: "signature",
      }),
    ).resolves.toMatchObject({ committed: false, decision: "stale" });
    expect(await version()).toBe(4);
    expect(await commands.read()).toEqual(processing(100));
    expect(metadataClockCalls).toBe(0);
  });

  it("preserves storage-compatible legacy statuses until a public claim replaces them", async () => {
    const source = {
      eventId,
      prizeId,
      assetAddress: "asset",
      profileId: "profile",
      requesterUid: "uid",
      recipientAddress: "recipient",
      status: ["submitted"],
      updatedAtMs: "100",
      futureEvidence: { retained: true },
    };
    const raw = createD1EventPrizeWithdrawalStore(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
    );
    await raw.replaceRecords([{ eventId, prizeId, value: source }]);
    const store = createWithdrawalCommands(testEnv.EVENT_PRIZE_WITHDRAWALS_DB);
    const observed = await store.get(eventId, prizeId);
    expect(observed).toEqual(source);
    expect(withdrawalStatus(observed)).toBeNull();
    await expect(
      store.record(eventId, prizeId).claim({
        eventId,
        prizeId,
        assetAddress: "asset",
        profileId: "profile",
        place: 1,
        recipientAddress: "recipient",
        requesterUid: "uid",
        leaseId: "claim",
      }),
    ).resolves.toMatchObject({ committed: true });
    const stored = await raw.get(eventId, prizeId);
    expect(stored?.status).toBe("processing");
    expect(stored?.leaseId).toBe("claim");
    expect(Object.hasOwn(stored!, "futureEvidence")).toBe(false);
  });

  it("public completion replaces submission evidence without adding a lease guard", async () => {
    const raw = createD1EventPrizeWithdrawalStore(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
    );
    const submitted = {
      eventId,
      prizeId,
      status: "submitted",
      profileId: "original-profile",
      entitledProfileId: " original-profile ",
      requesterUid: " uid ",
      place: "2",
      startedAtMs: "12.9",
      submittedAtMs: "0",
      updatedAtMs: 100,
      signedTransactionBase64: "AQID",
      futureEvidence: { retained: true },
    };
    await raw.replaceRecords([{ eventId, prizeId, value: submitted }]);
    const store = createWithdrawalCommands(testEnv.EVENT_PRIZE_WITHDRAWALS_DB);
    const observed = await store.get(eventId, prizeId);
    if (!observed) throw new Error("missing-test-withdrawal");
    const completed = buildWithdrawalCompletion({
      withdrawal: observed,
      profileId: "canonical-profile",
      eventId,
      prizeId,
      assetAddress: "asset",
      recipientAddress: "recipient",
      transactionSignature: "confirmed-signature",
      completedAtMs: 300,
    });
    await raw.record(eventId, prizeId).transaction((current) => ({
      value: {
        ...current,
        leaseId: "changed-after-observation",
        updatedAtMs: 200,
      },
    }));
    await store.replaceCompleted([{ eventId, prizeId, value: completed }]);
    const row = await testEnv.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
      "SELECT record_json, version, updated_at_ms FROM event_prize_withdrawals WHERE event_id = ? AND prize_id = ?",
    )
      .bind(eventId, prizeId)
      .first<{ record_json: string; version: number; updated_at_ms: number }>();
    expect(row).toEqual({
      record_json: JSON.stringify(completed),
      version: 3,
      updated_at_ms: 300,
    });
    expect(await raw.get(eventId, prizeId)).toEqual({
      eventId,
      prizeId,
      assetAddress: "asset",
      assetStandard: "core",
      profileId: "canonical-profile",
      entitledProfileId: "original-profile",
      place: 2,
      recipientAddress: "recipient",
      requesterUid: "uid",
      status: "completed",
      transactionSignature: "confirmed-signature",
      startedAtMs: 12.9,
      submittedAtMs: 300,
      completedAtMs: 300,
      updatedAtMs: 300,
    });
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

  it("routes the prize context through D1 and preserves execution freeze behavior", async () => {
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
      removeMatchingProfileEventPrizeAssignment: async () => {
        sourceWrites++;
        throw new Error("unexpected-profile-prize-cleanup");
      },
    };
    const runtime = await createEventPrizeContext(testEnv, {
      repository,
    });
    expect("createEventPrizeUmi" in runtime).toBe(false);
    const persisted = createD1EventPrizeWithdrawalStore(
      testEnv.EVENT_PRIZE_WITHDRAWALS_DB,
    );
    await persisted
      .record(eventId, prizeId)
      .transaction(() => ({ value: processing(500) }));
    expect(await runtime.withdrawals.record(eventId, prizeId).read()).toEqual(
      processing(500),
    );
    expect(await runtime.readWithdrawal(eventId, prizeId)).toEqual(
      processing(500),
    );
    expect(sourceValues.has(path)).toBe(false);
    expect(sourceWrites).toBe(0);
    await expect(runtime.readWithdrawal(eventId, prizeId)).resolves.toEqual(
      processing(500),
    );
    await expect(
      runtime.withdrawals.record(eventId, prizeId).persistSubmission({
        leaseId: "lease-1",
        transactionSignature: "signature",
        signedTransactionBase64: "AQID",
        blockhash: "hash",
        lastValidBlockHeight: 123,
      }),
    ).resolves.toMatchObject({ committed: true });
    expect(await persisted.get(eventId, prizeId)).toMatchObject({
      status: "submitted",
      transactionSignature: "signature",
      signedTransactionBase64: "AQID",
    });
    expect(sourceWrites).toBe(0);
    const completed = writeCompletedWithdrawal({
      eventId,
      prizeId,
      assetAddress: "asset",
      assetStandard: "core",
      profileId: "profile",
      entitledProfileId: "profile",
      place: 1,
      recipientAddress: "recipient",
      requesterUid: "uid",
      status: "completed",
      transactionSignature: "signature",
      startedAtMs: 500,
      submittedAtMs: 550,
      completedAtMs: 600,
      updatedAtMs: 600,
    });
    await runtime.withdrawals.replaceCompleted([
      {
        eventId,
        prizeId,
        value: completed,
      },
    ]);
    expect(await runtime.readWithdrawal(eventId, prizeId)).toMatchObject({
      status: "completed",
    });
    expect(await persisted.get(eventId, prizeId)).toEqual(completed);
    expect(sourceValues.has(path)).toBe(false);
    expect(sourceWrites).toBe(0);
    const execution = await createEventPrizeRuntimeDependencies(testEnv, {
      repository,
    });
    expect(typeof execution.createEventPrizeUmi).toBe("function");
    await expect(execution.readWithdrawal(eventId, prizeId)).resolves.toEqual(
      await runtime.readWithdrawal(eventId, prizeId),
    );

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
      createEventPrizeContext(testEnv, { repository }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      createEventPrizeRuntimeDependencies(testEnv, { repository }),
    ).rejects.toMatchObject({ code: "unavailable" });
    const preflight = await createEventPrizeRuntimeDependencies(testEnv, {
      repository,
      allowFrozen: true,
    });
    expect(typeof preflight.createEventPrizeUmi).toBe("function");
    await expect(preflight.readWithdrawal(eventId, prizeId)).resolves.toEqual(
      await runtime.readWithdrawal(eventId, prizeId),
    );
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
