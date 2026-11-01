import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  TransactionDecision,
  TransactionResult,
} from "../../../runtime/transactions.js";
import {
  acquireEventWriteAdmission,
  releaseEventWriteAdmission,
  transactEventLease,
  transactEventSyncThrottle,
} from "../src/eventD1/coordination.ts";
import { readEventLease, readEventSyncThrottle } from "../src/eventD1/reads.ts";
import {
  EventD1Conflict,
  EventWritesDisabled,
  type EventD1Connection,
  type EventLeaseRecord,
  type EventSyncThrottleRecord,
  type EventWriteAdmission,
} from "../src/eventD1/types.ts";
import { observeD1FailureDatabase } from "./d1FailureTestUtils.ts";
import {
  applyEventTestMigrations,
  transitionEventStorageMode,
} from "./eventTestMigrations.ts";

const db = env.EVENT_DB;
const migrations = (env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] })
  .TEST_EVENT_D1_MIGRATIONS;
const eventId = "coordination-test";

beforeAll(async () => {
  await applyEventTestMigrations(db, migrations);
});

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM event_leases"),
    db.prepare("DELETE FROM event_sync_throttles"),
    db.prepare("DELETE FROM event_write_admissions"),
  ]);
});

async function withAdmission<T>(
  work: (admission: EventWriteAdmission) => Promise<T>,
): Promise<T> {
  const admission = await acquireEventWriteAdmission(db);
  try {
    return await work(admission);
  } finally {
    await releaseEventWriteAdmission(db, admission);
  }
}

function coordinationTests<
  T extends EventLeaseRecord | EventSyncThrottleRecord,
>(domain: {
  name: string;
  record: (version: number) => T;
  read: (connection: EventD1Connection, key: string) => Promise<T | null>;
  transact: (
    connection: EventD1Connection,
    key: string,
    updater: (current: T | null) => TransactionDecision<T>,
    options: { admission: EventWriteAdmission },
  ) => Promise<TransactionResult<T>>;
  mutateGuard: (current: T) => void;
  mutateOther: (current: T) => void;
  invalid: Array<{ name: string; value: unknown; error: string }>;
}) {
  describe(`event ${domain.name} coordination`, () => {
    it("invokes updaters without a receiver", async () => {
      await withAdmission(async (admission) => {
        const result = await domain.transact(
          db,
          eventId,
          function (this: unknown) {
            expect(this).toBeUndefined();
            return { value: domain.record(1) };
          },
          { admission },
        );
        expect(result.committed).toBe(true);
      });
    });

    it("preserves insert, update, delete and missing-delete results", async () => {
      await withAdmission(async (admission) => {
        const observed = observeD1FailureDatabase(db);
        for (const [value, decision] of [
          [domain.record(1), "inserted"],
          [domain.record(2), "updated"],
          [null, "deleted"],
          [null, "already-missing"],
        ] as const) {
          expect(
            await domain.transact(
              observed.database,
              eventId,
              () => ({ value, decision }),
              { admission },
            ),
          ).toEqual({ committed: true, decision, value });
          expect(await domain.read(db, eventId)).toEqual(value);
        }
        expect(observed.writeBatches).toHaveLength(3);
        expect(observed.writeBatches.every((batch) => batch.length === 2)).toBe(
          true,
        );
      });
    });

    it("returns the updater's current object on abort without cloning or writing", async () => {
      await withAdmission(async (admission) => {
        const original = domain.record(1);
        await domain.transact(db, eventId, () => ({ value: original }), {
          admission,
        });
        const observed = observeD1FailureDatabase(db);
        let seen: T | null = null;
        const result = await domain.transact(
          observed.database,
          eventId,
          (current) => {
            if (!current) throw new Error("missing-current");
            seen = current;
            domain.mutateOther(current);
            Object.assign(current, { extra: undefined });
            return { commit: false, decision: "busy" };
          },
          { admission },
        );
        expect(result).toMatchObject({ committed: false, decision: "busy" });
        expect(result.value).toBe(seen);
        expect(result.value).toHaveProperty("extra", undefined);
        expect(await domain.read(db, eventId)).toEqual(original);
        expect(observed.writeBatches).toHaveLength(0);
      });
    });

    it("deep clones successful proposals while persisting only domain columns", async () => {
      await withAdmission(async (admission) => {
        const proposal = Object.assign(domain.record(1), {
          extra: { values: [1, 2] },
        });
        const result = await domain.transact(
          db,
          eventId,
          () => ({ value: proposal }),
          { admission },
        );
        expect(result.value).toEqual(proposal);
        expect(result.value).not.toBe(proposal);
        proposal.extra.values.push(3);
        expect(result.value).toHaveProperty("extra.values", [1, 2]);
        expect(await domain.read(db, eventId)).toEqual(domain.record(1));
      });
    });

    it("preserves clone validation after a successful SQL commit", async () => {
      await withAdmission(async (admission) => {
        const observed = observeD1FailureDatabase(db);
        await expect(
          domain.transact(
            observed.database,
            eventId,
            () => ({
              value: Object.assign(domain.record(1), { extra: undefined }),
            }),
            { admission },
          ),
        ).rejects.toThrow("invalid-event-json");
        expect(observed.writeBatches).toHaveLength(1);
        expect(await domain.read(db, eventId)).toEqual(domain.record(1));
      });
    });

    it.each(["insert", "update", "delete"] as const)(
      "rereads after a competing %s write and accepts the next abort decision",
      async (operation) => {
        await withAdmission(async (admission) => {
          const original = domain.record(1);
          const successor = domain.record(2);
          if (operation !== "insert")
            await domain.transact(db, eventId, () => ({ value: original }), {
              admission,
            });
          const observed = observeD1FailureDatabase(db, {
            async beforeWriteBatch(attempt) {
              if (attempt === 1)
                await domain.transact(
                  db,
                  eventId,
                  () => ({ value: successor }),
                  { admission },
                );
            },
          });
          const seen: Array<T | null> = [];
          const result = await domain.transact(
            observed.database,
            eventId,
            (current) => {
              seen.push(current);
              return seen.length === 1
                ? {
                    value: operation === "delete" ? null : domain.record(3),
                  }
                : { commit: false, decision: "superseded" };
            },
            { admission },
          );
          expect(seen).toEqual([
            operation === "insert" ? null : original,
            successor,
          ]);
          expect(result).toEqual({
            committed: false,
            decision: "superseded",
            value: successor,
          });
          expect(observed.writeBatches).toHaveLength(1);
          expect(await domain.read(db, eventId)).toEqual(successor);
        });
      },
    );

    it("recomputes a successful write after a CAS conflict", async () => {
      await withAdmission(async (admission) => {
        const observed = observeD1FailureDatabase(db, {
          async beforeWriteBatch(attempt) {
            if (attempt === 1)
              await domain.transact(
                db,
                eventId,
                () => ({ value: domain.record(1) }),
                { admission },
              );
          },
        });
        let calls = 0;
        const result = await domain.transact(
          observed.database,
          eventId,
          () => ({ value: domain.record(++calls + 1), decision: `${calls}` }),
          { admission },
        );
        expect(calls).toBe(2);
        expect(result).toEqual({
          committed: true,
          decision: "2",
          value: domain.record(3),
        });
        expect(await domain.read(db, eventId)).toEqual(domain.record(3));
        expect(observed.writeBatches).toHaveLength(2);
      });
    });

    it("exhausts exactly 12 CAS misses without cloning rejected proposals", async () => {
      await withAdmission(async (admission) => {
        let reads = 0;
        let decisions = 0;
        const observed = observeD1FailureDatabase(db, {
          async afterRead() {
            reads++;
          },
          async beforeWriteBatch(attempt) {
            await domain.transact(
              db,
              eventId,
              () => ({ value: domain.record(attempt) }),
              { admission },
            );
          },
        });
        await expect(
          domain.transact(
            observed.database,
            eventId,
            () => {
              decisions++;
              return {
                value: Object.assign(domain.record(99), { extra: undefined }),
              };
            },
            { admission },
          ),
        ).rejects.toThrow("event-d1-conflict");
        expect(reads).toBe(12);
        expect(decisions).toBe(12);
        expect(observed.writeBatches).toHaveLength(12);
        expect(await domain.read(db, eventId)).toEqual(domain.record(12));
      });
    });

    it("retains current-object mutations in the CAS predicate", async () => {
      await withAdmission(async (admission) => {
        const original = domain.record(1);
        await domain.transact(db, eventId, () => ({ value: original }), {
          admission,
        });
        const observed = observeD1FailureDatabase(db);
        let calls = 0;
        await expect(
          domain.transact(
            observed.database,
            eventId,
            (current) => {
              if (!current) throw new Error("missing-current");
              calls++;
              domain.mutateGuard(current);
              return { value: current };
            },
            { admission },
          ),
        ).rejects.toThrow("event-d1-conflict");
        expect(calls).toBe(12);
        expect(observed.writeBatches).toHaveLength(12);
        expect(await domain.read(db, eventId)).toEqual(original);
      });
    });

    it("commits in-place changes to fields outside the CAS predicate", async () => {
      await withAdmission(async (admission) => {
        await domain.transact(
          db,
          eventId,
          () => ({ value: domain.record(1) }),
          {
            admission,
          },
        );
        let proposal: T | null = null;
        const result = await domain.transact(
          db,
          eventId,
          (current) => {
            if (!current) throw new Error("missing-current");
            domain.mutateOther(current);
            proposal = current;
            return { value: current };
          },
          { admission },
        );
        expect(result.committed).toBe(true);
        expect(result.value).toEqual(proposal);
        expect(result.value).not.toBe(proposal);
        expect(await domain.read(db, eventId)).toEqual(proposal);
      });
    });

    it.each(["released", "expired", "frozen"] as const)(
      "%s admissions reject writes but leave aborts and missing deletions read-only",
      async (mode) => {
        const admission = await acquireEventWriteAdmission(
          db,
          mode === "expired" ? { nowMs: 1, ttlMs: 1 } : {},
        );
        if (mode !== "expired") await releaseEventWriteAdmission(db, admission);
        if (mode === "frozen")
          await transitionEventStorageMode(db, {
            expected: { storageMode: "d1" },
            next: { storageMode: "frozen" },
            nowMs: 100,
          });
        try {
          const observed = observeD1FailureDatabase(db);
          expect(
            await domain.transact(
              observed.database,
              eventId,
              () => ({ commit: false, decision: "skip" }),
              { admission },
            ),
          ).toEqual({ committed: false, decision: "skip", value: null });
          expect(
            await domain.transact(
              observed.database,
              eventId,
              () => ({ value: null, decision: "missing" }),
              { admission },
            ),
          ).toEqual({ committed: true, decision: "missing", value: null });
          expect(observed.writeBatches).toHaveLength(0);
          const failure = await domain
            .transact(
              observed.database,
              eventId,
              () => ({ value: domain.record(1) }),
              { admission },
            )
            .catch((error: unknown) => error);
          expect(failure).toHaveProperty(
            "message",
            mode === "frozen"
              ? "event-writes-disabled"
              : "event-write-admission-invalid",
          );
          if (mode === "frozen")
            expect(failure).toBeInstanceOf(EventWritesDisabled);
          expect(failure).toHaveProperty("cause", observed.errors[0]);
          expect(observed.writeBatches).toHaveLength(1);
          expect(observed.sessions).toEqual(["first-primary"]);
          expect(await domain.read(db, eventId)).toBeNull();
        } finally {
          if (mode === "frozen")
            await transitionEventStorageMode(db, {
              expected: { storageMode: "frozen" },
              next: { storageMode: "d1" },
              nowMs: 101,
            });
          await releaseEventWriteAdmission(db, admission);
        }
      },
    );

    it.each(["read", "updater", "write", "thrown-conflict"] as const)(
      "propagates %s failures without retrying",
      async (stage) => {
        await withAdmission(async (admission) => {
          const failure =
            stage === "thrown-conflict"
              ? new EventD1Conflict()
              : new Error(`${stage}-unavailable`);
          let reads = 0;
          let decisions = 0;
          const observed = observeD1FailureDatabase(db, {
            async afterRead() {
              reads++;
              if (stage === "read") throw failure;
            },
            async beforeWriteBatch() {
              if (stage === "write" || stage === "thrown-conflict")
                throw failure;
            },
          });
          await expect(
            domain.transact(
              observed.database,
              eventId,
              () => {
                decisions++;
                if (stage === "updater") throw failure;
                return { value: domain.record(1) };
              },
              { admission },
            ),
          ).rejects.toBe(failure);
          expect(reads).toBe(1);
          expect(decisions).toBe(stage === "read" ? 0 : 1);
          expect(observed.writeBatches).toHaveLength(
            stage === "write" || stage === "thrown-conflict" ? 1 : 0,
          );
          expect(await domain.read(db, eventId)).toBeNull();
        });
      },
    );

    it.each(domain.invalid)(
      "rejects $name before writing",
      async ({ value, error }) => {
        await withAdmission(async (admission) => {
          const observed = observeD1FailureDatabase(db);
          let calls = 0;
          await expect(
            domain.transact(
              observed.database,
              eventId,
              () => {
                calls++;
                return { value: value as T };
              },
              { admission },
            ),
          ).rejects.toThrow(error);
          expect(calls).toBe(1);
          expect(observed.writeBatches).toHaveLength(0);
          expect(await domain.read(db, eventId)).toBeNull();
        });
      },
    );

    it("rejects invalid event keys asynchronously without reading", async () => {
      await withAdmission(async (admission) => {
        let reads = 0;
        const observed = observeD1FailureDatabase(db, {
          async afterRead() {
            reads++;
          },
        });
        let pending: Promise<TransactionResult<T>> | undefined;
        expect(() => {
          pending = domain.transact(
            observed.database,
            "invalid/event",
            () => ({ value: domain.record(1) }),
            { admission },
          );
        }).not.toThrow();
        await expect(pending).rejects.toThrow("invalid-event-path");
        expect(reads).toBe(0);
        expect(observed.writeBatches).toHaveLength(0);
      });
    });
  });
}

function lease(version: number): EventLeaseRecord {
  return {
    lockId: `lock-${version}`,
    ownerUid: `owner-${version}`,
    acquiredAtMs: version * 10,
    refreshedAtMs: version * 10 + 1,
    expiresAtMs: version * 10 + 100,
  };
}

function throttle(version: number): EventSyncThrottleRecord {
  return {
    ownerUid: `owner-${version}`,
    token: `token-${version}`,
    startedAtMs: version * 10,
  };
}

coordinationTests({
  name: "lease",
  record: lease,
  read: readEventLease,
  transact: transactEventLease,
  mutateGuard: (current) => {
    current.lockId = "mutated-lock";
  },
  mutateOther: (current) => {
    current.acquiredAtMs = 0;
  },
  invalid: [
    { name: "array proposals", value: [], error: "invalid-event-lease" },
    {
      name: "invalid owners",
      value: { ...lease(1), ownerUid: " owner " },
      error: "invalid-event-lease",
    },
    {
      name: "invalid expiration",
      value: { ...lease(1), expiresAtMs: 11 },
      error: "invalid-event-integer",
    },
  ],
});

coordinationTests({
  name: "throttle",
  record: throttle,
  read: readEventSyncThrottle,
  transact: transactEventSyncThrottle,
  mutateGuard: (current) => {
    current.token = "mutated-token";
  },
  mutateOther: (current) => {
    current.ownerUid = "mutated-owner";
  },
  invalid: [
    {
      name: "array proposals",
      value: [],
      error: "invalid-event-sync-throttle",
    },
    {
      name: "invalid tokens",
      value: { ...throttle(1), token: "bad/token" },
      error: "invalid-event-sync-throttle",
    },
    {
      name: "invalid timestamps",
      value: { ...throttle(1), startedAtMs: -1 },
      error: "invalid-event-integer",
    },
  ],
});
