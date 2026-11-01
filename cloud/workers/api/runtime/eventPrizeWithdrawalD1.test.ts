import { applyCanonicalTestMigrations } from "./canonicalTestMigrations.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { reset, type D1Migration } from "cloudflare:test";
import {
  createD1EventPrizeWithdrawalStorage,
  createD1EventPrizeWithdrawalReader,
  createD1EventPrizeWithdrawalStore,
  EventPrizeWithdrawalD1Failure,
  MAX_TRANSACTION_ATTEMPTS,
  readEventPrizeWithdrawalStorageControl,
  readEventPrizeWithdrawalStorageMode,
} from "../src/eventPrizeWithdrawalD1.ts";
import { canonicalWithdrawalFixture } from "../test/canonicalWithdrawalFixture.ts";
import { buildWithdrawalCompletion } from "../../../runtime/eventPrizeWithdrawalState.js";
import {
  writeSubmittedWithdrawal,
  writeBlockedWithdrawal,
  readWithdrawalDocument,
} from "../../../runtime/eventPrizes/records.js";
import { createEventPrizeContext } from "../src/eventPrizeWithdrawal/context.ts";

const testEnv = env as Env & {
  TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS: D1Migration[];
};
const db = testEnv.EVENT_PRIZE_WITHDRAWALS_DB;
const eventId = "NN3eRzoZo80",
  prizeId = "1092",
  address = "11111111111111111111111111111111";
const evidence = {
  transactionSignature: "signature",
  signedTransactionBase64: "AQID",
  blockhash: address,
  lastValidBlockHeight: 123,
};
const processing = (updatedAtMs: number) => {
  const value = canonicalWithdrawalFixture({
    eventId,
    prizeId,
    leaseId: "lease-1",
    startedAtMs: 1,
    updatedAtMs,
  });
  if (value.status !== "processing")
    throw new Error("invalid-processing-fixture");
  return value;
};
function completed(updatedAtMs = 300) {
  const initial = writeSubmittedWithdrawal(processing(100), evidence, 150, 150);
  return buildWithdrawalCompletion({
    withdrawal: initial,
    profileId: initial.profileId,
    eventId,
    prizeId,
    assetAddress: initial.assetAddress,
    recipientAddress: address,
    transactionSignature: "signature",
    completedAtMs: updatedAtMs,
  });
}
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
const freeze = () =>
  db
    .prepare(
      "UPDATE event_prize_withdrawal_runtime_control SET storage_mode='frozen',previous_storage_mode='d1' WHERE singleton=1",
    )
    .run();

describe("canonical withdrawal D1 repository", () => {
  beforeEach(async () => {
    await reset();
    await applyCanonicalTestMigrations(
      db,
      testEnv.TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS,
    );
    await db
      .prepare(
        "UPDATE event_prize_withdrawal_runtime_control SET storage_mode='d1',previous_storage_mode=NULL WHERE singleton=1",
      )
      .run();
  });
  it.each([
    [
      "record",
      (database: D1Database) =>
        createD1EventPrizeWithdrawalStorage(database).get(eventId, prizeId),
    ],
    ["control", readEventPrizeWithdrawalStorageControl],
    [
      "event",
      (database: D1Database) =>
        createD1EventPrizeWithdrawalReader(database)(eventId),
    ],
  ] as const)(
    "preserves provider failure causes for %s reads",
    async (_name, read) => {
      const cause = new Error("provider-failure");
      const failure: unknown = await read(failingDatabase(cause)).catch(
        (error) => error,
      );
      expect(failure).toBeInstanceOf(EventPrizeWithdrawalD1Failure);
      expect(failure instanceof Error && failure.cause).toBe(cause);
      const domain = new EventPrizeWithdrawalD1Failure(
        "invalid-event-prize-withdrawal-record",
        { cause },
      );
      await expect(read(failingDatabase(domain))).rejects.toBe(domain);
    },
  );
  it("persists typed state and respects logical aborts across cold adapters", async () => {
    const storage = createD1EventPrizeWithdrawalStorage(db),
      record = storage.record(eventId, prizeId),
      initial = processing(100);
    expect(
      (
        await record.transaction(() => ({
          value: initial,
          decision: "created",
        }))
      ).value,
    ).toBe(initial);
    expect(
      await createD1EventPrizeWithdrawalStorage(db).get(eventId, prizeId),
    ).toEqual(initial);
    expect(
      await record.transaction(() => ({ commit: false, decision: "declined" })),
    ).toEqual({ committed: false, decision: "declined", value: initial });
    await record.transaction((current) => {
      if (!current) throw new Error("missing");
      return { value: writeBlockedWithdrawal(current, address, 200) };
    });
    expect(await record.read()).toMatchObject({
      status: "blocked",
      leaseId: null,
      leaseExpiresAtMs: null,
      blockedAtMs: 200,
    });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'event_prize_withdrawals'",
        )
        .first("count"),
    ).toBe(0);
  });
  it("retries optimistic conflicts against authoritative records without losing increments", async () => {
    const storages = Array.from({ length: 12 }, () =>
      createD1EventPrizeWithdrawalStorage(db),
    );
    await Promise.all(
      storages.map((storage) =>
        storage.record(eventId, prizeId).transaction((current) => ({
          value: {
            ...(current ?? processing(100)),
            updatedAtMs: (current?.updatedAtMs ?? 100) + 1,
          },
        })),
      ),
    );
    expect(
      await createD1EventPrizeWithdrawalStorage(db).get(eventId, prizeId),
    ).toMatchObject({ updatedAtMs: 112 });
    expect(MAX_TRANSACTION_ATTEMPTS).toBe(12);
  });
  it("uses the validated document timestamp and never a fallback clock", async () => {
    let calls = 0;
    const storage = createD1EventPrizeWithdrawalStorage(db, {
        now: () => {
          calls++;
          return 1000;
        },
      }),
      value = processing(200);
    const result = await storage
      .record(eventId, prizeId)
      .transaction(() => ({ value }));
    expect(result.value).toBe(value);
    expect(calls).toBe(0);
    expect(
      await db
        .prepare("SELECT updated_at_ms FROM event_prize_withdrawals_canonical")
        .first("updated_at_ms"),
    ).toBe(200);
  });
  it("deletes active or absent rows while retaining transaction decisions", async () => {
    const record = createD1EventPrizeWithdrawalStorage(db, {
      now: () => {
        throw new Error("unexpected-clock");
      },
    }).record(eventId, prizeId);
    await record.transaction(() => ({ value: processing(100) }));
    for (const decision of ["deleted", "already-absent"])
      expect(
        await record.transaction(() => ({ value: null, decision })),
      ).toEqual({ committed: true, value: null, decision });
    expect(await record.read()).toBeNull();
  });
  it.each([
    "wrong identity",
    "unknown field",
    "string timestamp",
    "impossible lifecycle",
  ])("rejects %s before persistence without retrying", async (kind) => {
    let decisions = 0;
    const value: Record<string, unknown> = { ...processing(100) };
    if (kind === "wrong identity") value.eventId = "different";
    else if (kind === "unknown field") value.futureEvidence = { keep: true };
    else if (kind === "string timestamp") value.updatedAtMs = "100";
    else value.status = "completed";
    expect(readWithdrawalDocument(value)).toBe(
      kind === "wrong identity" ? value : null,
    );
    await expect(
      createD1EventPrizeWithdrawalStorage(db)
        .record(eventId, prizeId)
        .transaction(() => {
          decisions++;
          return { value: JSON.parse(JSON.stringify(value)) };
        }),
    ).rejects.toThrow("invalid-event-prize-withdrawal-record");
    expect(decisions).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM event_prize_withdrawals_canonical",
        )
        .first("count"),
    ).toBe(0);
  });
  it("stores completed receipts and rejects changes to confirmed financial evidence", async () => {
    const commands = createD1EventPrizeWithdrawalStore(db),
      value = completed();
    await commands.replaceCompleted([{ eventId, prizeId, value }]);
    expect(await commands.get(eventId, prizeId)).toEqual(value);
    await expect(
      commands.replaceCompleted([
        {
          eventId,
          prizeId,
          value: { ...value, transactionSignature: "changed" },
        },
      ]),
    ).rejects.toThrow();
    expect(await commands.get(eventId, prizeId)).toEqual(value);
  });
  it("blocks new or replacement leases after freeze while an existing submission drains", async () => {
    const storage = createD1EventPrizeWithdrawalStorage(db),
      record = storage.record(eventId, prizeId),
      initial = processing(100);
    await record.transaction(() => ({ value: initial }));
    await freeze();
    expect(await readEventPrizeWithdrawalStorageMode(db)).toBe("frozen");
    await expect(
      record.transaction(() => ({
        value: { ...initial, leaseId: "replacement", updatedAtMs: 200 },
      })),
    ).rejects.toThrow("storage is frozen");
    const late = canonicalWithdrawalFixture({
      prizeId: "1111",
      leaseId: "new",
      startedAtMs: 1,
      updatedAtMs: 200,
    });
    await expect(
      storage.record(eventId, "1111").transaction(() => ({ value: late })),
    ).rejects.toThrow("storage is frozen");
    const submitted = writeSubmittedWithdrawal(initial, evidence, 150, 150);
    expect(
      (await record.transaction(() => ({ value: submitted }))).committed,
    ).toBe(true);
    await expect(
      record.transaction(() => ({
        value: { ...submitted, leaseId: "replacement", updatedAtMs: 200 },
      })),
    ).rejects.toThrow("storage is frozen");
    const receipt = completed(300);
    await record.transaction(() => ({ value: receipt }));
    expect(await record.read()).toEqual(receipt);
  });
  it("routes public commands through owner checks and exact signed evidence", async () => {
    const storage = createD1EventPrizeWithdrawalStorage(db),
      initial = processing(100);
    await storage
      .record(eventId, prizeId)
      .transaction(() => ({ value: initial }));
    const commands = createD1EventPrizeWithdrawalStore(db, {
      now: () => 200,
    }).record(eventId, prizeId);
    expect((await commands.releaseProcessing("stale")).value).toEqual(initial);
    expect(
      await commands.discardSubmission({
        leaseId: "stale",
        transactionSignature: "signature",
      }),
    ).toMatchObject({ committed: false, decision: "stale" });
    expect(
      (
        await commands.persistSubmission({
          leaseId: initial.leaseId!,
          ...evidence,
        })
      ).value,
    ).toMatchObject({ status: "submitted", ...evidence });
    expect(
      (
        await commands.block({
          leaseId: initial.leaseId!,
          observedOwner: address,
        })
      ).value,
    ).toMatchObject({ status: "blocked", ...evidence, leaseId: null });
  });
  it("reads event reconciliation state exclusively from canonical storage", async () => {
    const storage = createD1EventPrizeWithdrawalStorage(db),
      value = completed();
    await storage.replaceRecords([{ eventId, prizeId, value }]);
    expect(await createD1EventPrizeWithdrawalReader(db)(eventId)).toEqual({
      [prizeId]: value,
    });
  });
  it("allows read-only prize context checks while execution storage is frozen", async () => {
    await freeze();
    await expect(createEventPrizeContext(env)).rejects.toThrow(
      "temporarily unavailable",
    );
    await expect(
      createEventPrizeContext(env, { allowFrozen: true }),
    ).resolves.toHaveProperty("withdrawals");
  });
  it("rejects unsupported storage modes and fails closed when the control row is missing", async () => {
    await expect(
      db
        .prepare(
          "UPDATE event_prize_withdrawal_runtime_control SET storage_mode='firebase'",
        )
        .run(),
    ).rejects.toThrow();
    expect(await readEventPrizeWithdrawalStorageControl(db)).toEqual({
      storageMode: "d1",
      previousStorageMode: null,
    });
    await db
      .prepare("DELETE FROM event_prize_withdrawal_runtime_control")
      .run();
    await expect(readEventPrizeWithdrawalStorageControl(db)).rejects.toThrow(
      "invalid-event-prize-withdrawal-storage-mode",
    );
  });
});
