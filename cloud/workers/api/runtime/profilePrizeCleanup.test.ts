import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { EventPrizeAssignmentRecord } from "../../../runtime/eventReads.js";
import { removeMatchingProfileEventPrizeAssignment } from "../src/eventD1/profilePrizeCleanup.ts";
import {
  acquireEventWriteAdmission,
  releaseEventWriteAdmission,
} from "../src/eventD1/coordination.ts";
import {
  EventD1Conflict,
  EventWritesDisabled,
  MAX_EVENT_TRANSACTION_ATTEMPTS,
  type EventD1Connection,
  type EventTransactionOptions,
} from "../src/eventD1/types.ts";
import { createEventPrizeRepository } from "../src/eventPrizeRepository.ts";
import {
  applyEventTestMigrations,
  transitionEventStorageMode,
} from "./eventTestMigrations.ts";

const testEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };
const eventId = "NN3eRzoZo80";
const siblingEventId = "other-event";
const profileId = "cleanup-owner";
const prizeId = "1092";
const otherPrizeId = "1111";
const input = { profileId, eventId, prizeId };

function assignment(
  overrides: Partial<EventPrizeAssignmentRecord> = {},
): EventPrizeAssignmentRecord {
  return {
    eventId,
    profileId,
    prizeId,
    place: 1,
    assignedAtMs: 100,
    futureMetadata: { edition: 2, labels: ["keep", "exact"] },
    ...overrides,
  };
}

async function seedAssignment(
  value: EventPrizeAssignmentRecord,
  { revision = 1, json = JSON.stringify(value) } = {},
) {
  await testEnv.EVENT_DB.batch([
    testEnv.EVENT_DB.prepare(
      `INSERT INTO profile_event_prizes
         (profile_id, event_id, assignment_json, updated_at_ms)
       VALUES (?, ?, ?, 100)
       ON CONFLICT (profile_id, event_id) DO UPDATE SET
         assignment_json = excluded.assignment_json,
         updated_at_ms = excluded.updated_at_ms`,
    ).bind(value.profileId, value.eventId, json),
    testEnv.EVENT_DB.prepare(
      `INSERT INTO profile_event_prize_revisions
         (profile_id, revision, updated_at_ms)
       VALUES (?, ?, 100)
       ON CONFLICT (profile_id) DO UPDATE SET
         revision = excluded.revision, updated_at_ms = excluded.updated_at_ms`,
    ).bind(value.profileId, revision),
  ]);
}

async function readStorage() {
  const results = await testEnv.EVENT_DB.batch<Record<string, unknown>>([
    testEnv.EVENT_DB.prepare(
      "SELECT * FROM profile_event_prizes ORDER BY profile_id, event_id",
    ),
    testEnv.EVENT_DB.prepare(
      "SELECT * FROM profile_event_prize_revisions ORDER BY profile_id",
    ),
    testEnv.EVENT_DB.prepare("SELECT * FROM event_records ORDER BY event_id"),
  ]);
  return {
    prizes: results[0].results,
    revisions: results[1].results,
    events: results[2].results,
  };
}

async function admissionCount() {
  return testEnv.EVENT_DB.prepare(
    "SELECT COUNT(*) AS count FROM event_write_admissions",
  ).first<number>("count");
}

async function cleanup(
  db: EventD1Connection = testEnv.EVENT_DB,
  target = input,
  options: Omit<EventTransactionOptions, "admission"> = {},
) {
  const admission = await acquireEventWriteAdmission(db);
  try {
    return await removeMatchingProfileEventPrizeAssignment(db, target, {
      now: () => 300,
      ...options,
      admission,
    });
  } finally {
    await releaseEventWriteAdmission(db, admission);
  }
}

function beforeFirstCommit(change: () => Promise<void>) {
  let batches = 0;
  const db: EventD1Connection = {
    prepare: (sql) => testEnv.EVENT_DB.prepare(sql),
    async batch(statements) {
      if (batches++ === 0) await change();
      return testEnv.EVENT_DB.batch(statements);
    },
  };
  return { db, batches: () => batches };
}

describe("conditional profile prize cleanup", () => {
  beforeAll(async () => {
    await applyEventTestMigrations(
      testEnv.EVENT_DB,
      testEnv.TEST_EVENT_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare("DELETE FROM event_write_admissions"),
      testEnv.EVENT_DB.prepare("DELETE FROM profile_event_prizes"),
      testEnv.EVENT_DB.prepare("DELETE FROM profile_event_prize_revisions"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_leases"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_records"),
    ]);
    const control = await testEnv.EVENT_DB.prepare(
      "SELECT storage_mode FROM event_runtime_control WHERE singleton = 1",
    ).first<string>("storage_mode");
    if (control === "frozen") {
      await transitionEventStorageMode(testEnv.EVENT_DB, {
        expected: { storageMode: "frozen" },
        next: { storageMode: "d1" },
        nowMs: 10,
      });
    }
    for (const id of [eventId, siblingEventId]) {
      await testEnv.EVENT_DB.prepare(
        `INSERT INTO event_records
           (event_id, status, start_at_ms, updated_at_ms, revision, record_json)
         VALUES (?, 'ended', 10, 100, 1, ?)`,
      )
        .bind(
          id,
          JSON.stringify({
            eventId: id,
            status: "ended",
            prizeAssignments: { "1": assignment({ eventId: id }) },
          }),
        )
        .run();
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it("deletes matching prizes once without changing historical records or siblings", async () => {
    await seedAssignment(assignment());
    const sibling = assignment({
      eventId: siblingEventId,
      prizeId: "future-prize",
    });
    await seedAssignment(sibling);
    const before = await readStorage();
    expect(await cleanup()).toBe(true);
    const after = await readStorage();
    expect(after.prizes).toEqual(
      before.prizes.filter((row) => row.event_id !== eventId),
    );
    expect(after.revisions).toEqual([
      { profile_id: profileId, revision: 2, updated_at_ms: 300 },
    ]);
    expect(after.events).toEqual(before.events);
    expect(await cleanup()).toBe(true);
    expect(await readStorage()).toEqual(after);
    expect(await admissionCount()).toBe(0);
  });

  it("confirms absence without creating a profile prize revision", async () => {
    const before = await readStorage();
    expect(await cleanup()).toBe(true);
    expect(await readStorage()).toEqual(before);
    expect(await admissionCount()).toBe(0);
  });

  it("preserves mismatched assignment bytes, metadata, revision, and timestamps", async () => {
    const value = assignment({ prizeId: otherPrizeId });
    await seedAssignment(value, {
      revision: 5,
      json: JSON.stringify(value, null, 3),
    });
    const before = await readStorage();
    expect(await cleanup()).toBe(false);
    expect(await readStorage()).toEqual(before);
    expect(await admissionCount()).toBe(0);
  });

  it("retains catalog validation for a mismatched historical prize but permits matching deletion", async () => {
    await seedAssignment(assignment({ prizeId: "future-prize" }));
    const before = await readStorage();
    await expect(cleanup()).rejects.toThrow("invalid-event-prize-assignment");
    expect(await readStorage()).toEqual(before);
    expect(
      await cleanup(testEnv.EVENT_DB, { ...input, prizeId: "future-prize" }),
    ).toBe(true);
    expect((await readStorage()).prizes).toEqual([]);
    expect(await admissionCount()).toBe(0);
  });

  it.each([
    "missing-fields",
    "wrong-profile",
    "wrong-event",
    "unsafe-revision",
  ])("rejects %s without changing target state", async (malformation) => {
    await seedAssignment(assignment());
    if (malformation === "unsafe-revision") {
      await testEnv.EVENT_DB.prepare(
        "UPDATE profile_event_prize_revisions SET revision = 9007199254740992 WHERE profile_id = ?",
      )
        .bind(profileId)
        .run();
    } else {
      const value =
        malformation === "missing-fields"
          ? {}
          : assignment(
              malformation === "wrong-profile"
                ? { profileId: "other-owner" }
                : { eventId: "wrong-event" },
            );
      await testEnv.EVENT_DB.prepare(
        "UPDATE profile_event_prizes SET assignment_json = ? WHERE profile_id = ? AND event_id = ?",
      )
        .bind(JSON.stringify(value), profileId, eventId)
        .run();
    }
    const before = await readStorage();
    await expect(cleanup()).rejects.toThrow();
    expect(await readStorage()).toEqual(before);
    expect(await admissionCount()).toBe(0);
  });

  it("does not inspect malformed sibling assignments during no-op cleanup", async () => {
    await seedAssignment(assignment({ prizeId: otherPrizeId }));
    await seedAssignment(assignment({ eventId: siblingEventId }), {
      json: "{}",
    });
    const before = await readStorage();
    expect(await cleanup()).toBe(false);
    expect(
      await cleanup(testEnv.EVENT_DB, { ...input, eventId: "missing-event" }),
    ).toBe(true);
    expect(await readStorage()).toEqual(before);
  });

  it("retries an absent snapshot when the matching prize appears before confirmation", async () => {
    const race = beforeFirstCommit(() => seedAssignment(assignment()));
    expect(await cleanup(race.db)).toBe(true);
    expect(race.batches()).toBe(2);
    expect((await readStorage()).prizes).toEqual([]);
    expect((await readStorage()).revisions).toEqual([
      { profile_id: profileId, revision: 2, updated_at_ms: 300 },
    ]);
  });

  it("does not delete a different prize that replaces a matching snapshot", async () => {
    await seedAssignment(assignment());
    const replacement = assignment({
      prizeId: otherPrizeId,
      assignedAtMs: 200,
    });
    const race = beforeFirstCommit(() =>
      seedAssignment(replacement, { revision: 2 }),
    );
    expect(await cleanup(race.db)).toBe(false);
    expect(race.batches()).toBe(2);
    const after = await readStorage();
    expect(after.prizes).toMatchObject([
      { assignment_json: JSON.stringify(replacement) },
    ]);
    expect(after.revisions).toEqual([
      { profile_id: profileId, revision: 2, updated_at_ms: 100 },
    ]);
  });

  it("retries a mismatched snapshot when it becomes the matching prize", async () => {
    await seedAssignment(assignment({ prizeId: otherPrizeId }));
    const race = beforeFirstCommit(() =>
      seedAssignment(assignment(), { revision: 2 }),
    );
    expect(await cleanup(race.db)).toBe(true);
    expect(race.batches()).toBe(2);
    expect((await readStorage()).prizes).toEqual([]);
    expect((await readStorage()).revisions).toEqual([
      { profile_id: profileId, revision: 3, updated_at_ms: 300 },
    ]);
  });

  it("retries no-op confirmation after a sibling revision changes", async () => {
    await seedAssignment(assignment({ prizeId: otherPrizeId }));
    const sibling = assignment({
      eventId: siblingEventId,
      prizeId: "future-prize",
    });
    const race = beforeFirstCommit(() =>
      seedAssignment(sibling, { revision: 2 }),
    );
    expect(await cleanup(race.db)).toBe(false);
    expect(race.batches()).toBe(2);
    const after = await readStorage();
    expect(after.prizes).toHaveLength(2);
    expect(after.revisions).toEqual([
      { profile_id: profileId, revision: 2, updated_at_ms: 100 },
    ]);
  });

  it("keeps the twelve-attempt conflict limit for no-op confirmations", async () => {
    await seedAssignment(assignment({ prizeId: otherPrizeId }));
    const before = await readStorage();
    let attempts = 0;
    const db: EventD1Connection = {
      prepare: (sql) => testEnv.EVENT_DB.prepare(sql),
      async batch(statements) {
        attempts++;
        await testEnv.EVENT_DB.prepare(
          "UPDATE profile_event_prize_revisions SET revision = revision + 1 WHERE profile_id = ?",
        )
          .bind(profileId)
          .run();
        return testEnv.EVENT_DB.batch(statements);
      },
    };
    await expect(cleanup(db)).rejects.toBeInstanceOf(EventD1Conflict);
    expect(attempts).toBe(MAX_EVENT_TRANSACTION_ATTEMPTS);
    expect(attempts).toBe(12);
    const after = await readStorage();
    expect(after.prizes).toEqual(before.prizes);
    expect(after.revisions).toEqual([
      { profile_id: profileId, revision: 13, updated_at_ms: 100 },
    ]);
    expect(await admissionCount()).toBe(0);
  });

  it("rejects a frozen store before admitting absent cleanup", async () => {
    await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "d1" },
      next: { storageMode: "frozen" },
      nowMs: 200,
    });
    const before = await readStorage();
    const repository = createEventPrizeRepository(
      testEnv.PROFILE_DB,
      testEnv.EVENT_DB,
    );
    await expect(
      repository.removeMatchingProfileEventPrizeAssignment(input),
    ).rejects.toBeInstanceOf(EventWritesDisabled);
    expect(await readStorage()).toEqual(before);
    expect(await admissionCount()).toBe(0);
  });

  it.each(["expired", "revoked", "new-generation", "frozen"])(
    "checks %s admission state when confirming a no-op",
    async (change) => {
      await seedAssignment(assignment({ prizeId: otherPrizeId }));
      const before = await readStorage();
      const race = beforeFirstCommit(async () => {
        if (change === "expired") {
          await testEnv.EVENT_DB.prepare(
            "UPDATE event_write_admissions SET created_at_ms = 0, expires_at_ms = 1",
          ).run();
          return;
        }
        const previousAdmissionId = await testEnv.EVENT_DB.prepare(
          "SELECT admission_id FROM event_write_admissions LIMIT 1",
        ).first<string>("admission_id");
        await testEnv.EVENT_DB.prepare(
          "DELETE FROM event_write_admissions",
        ).run();
        if (change === "revoked") return;
        await transitionEventStorageMode(testEnv.EVENT_DB, {
          expected: { storageMode: "d1" },
          next: { storageMode: "frozen" },
          nowMs: 200,
        });
        if (change === "new-generation") {
          await transitionEventStorageMode(testEnv.EVENT_DB, {
            expected: { storageMode: "frozen" },
            next: { storageMode: "d1" },
            nowMs: 201,
          });
          await acquireEventWriteAdmission(testEnv.EVENT_DB, {
            admissionId: previousAdmissionId!,
          });
        }
      });
      await expect(cleanup(race.db)).rejects.toThrow(
        change === "frozen"
          ? "event-writes-disabled"
          : "event-write-admission-invalid",
      );
      expect(race.batches()).toBe(1);
      expect(await readStorage()).toEqual(before);
    },
  );

  it("retains an optional event lease guard for absent cleanup", async () => {
    const before = await readStorage();
    await expect(
      cleanup(testEnv.EVENT_DB, input, {
        eventLease: { eventId, lockId: "missing-lease", ownerUid: "owner" },
      }),
    ).rejects.toThrow("event-lease-lost");
    expect(await readStorage()).toEqual(before);
  });

  it("retains cancellation and validation before no-op confirmation", async () => {
    const before = await readStorage();
    const failure = new Error("cancelled-cleanup");
    await expect(
      cleanup(testEnv.EVENT_DB, input, {
        signal: AbortSignal.abort(failure),
      }),
    ).rejects.toBe(failure);
    await expect(
      cleanup(testEnv.EVENT_DB, { ...input, eventId: "invalid/id" }),
    ).rejects.toThrow("invalid-event-path");
    await expect(
      cleanup(testEnv.EVENT_DB, input, { now: () => NaN }),
    ).rejects.toThrow();
    expect(await readStorage()).toEqual(before);
    expect(await admissionCount()).toBe(0);
  });

  it.each(["absent", "different-prize"])(
    "preserves confirmed %s cleanup when cancellation arrives after the guard batch",
    async (state) => {
      if (state === "different-prize")
        await seedAssignment(assignment({ prizeId: otherPrizeId }));
      const before = await readStorage();
      const controller = new AbortController();
      const cancellation = new Error("cancelled-after-confirmation");
      let batches = 0;
      const db: EventD1Connection = {
        prepare: (sql) => testEnv.EVENT_DB.prepare(sql),
        async batch<T>(statements: D1PreparedStatement[]) {
          batches++;
          const result = await testEnv.EVENT_DB.batch<T>(statements);
          controller.abort(cancellation);
          return result;
        },
      };
      await expect(
        cleanup(db, input, { signal: controller.signal }),
      ).resolves.toBe(state === "absent");
      expect(controller.signal.reason).toBe(cancellation);
      expect(batches).toBe(1);
      expect(await readStorage()).toEqual(before);
      expect(await admissionCount()).toBe(0);
    },
  );

  it("honors cancellation after a real conflict without reading another snapshot", async () => {
    await seedAssignment(assignment({ prizeId: otherPrizeId }));
    const before = await readStorage();
    const controller = new AbortController();
    const cancellation = new Error("cancelled-after-prize-conflict");
    let snapshotReads = 0;
    let batches = 0;
    const db: EventD1Connection = {
      prepare(sql) {
        if (/^\s*SELECT\b/i.test(sql)) snapshotReads++;
        return testEnv.EVENT_DB.prepare(sql);
      },
      async batch(statements) {
        batches++;
        await testEnv.EVENT_DB.prepare(
          "UPDATE profile_event_prize_revisions SET revision = revision + 1 WHERE profile_id = ?",
        )
          .bind(profileId)
          .run();
        try {
          return await testEnv.EVENT_DB.batch(statements);
        } catch (error) {
          controller.abort(cancellation);
          throw error;
        }
      },
    };
    await expect(
      cleanup(db, input, { signal: controller.signal }),
    ).rejects.toBe(cancellation);
    expect(snapshotReads).toBe(1);
    expect(batches).toBe(1);
    expect(await readStorage()).toEqual({
      ...before,
      revisions: [{ profile_id: profileId, revision: 2, updated_at_ms: 100 }],
    });
    expect(await admissionCount()).toBe(0);
  });

  it("preserves no-op outcomes and original validation failures when admission release fails", async () => {
    await seedAssignment(assignment({ prizeId: otherPrizeId }));
    const repository = createEventPrizeRepository(
      testEnv.PROFILE_DB,
      testEnv.EVENT_DB,
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await testEnv.EVENT_DB.prepare(
      "CREATE TRIGGER cleanup_release_failure BEFORE DELETE ON event_write_admissions BEGIN SELECT RAISE(ABORT, 'release-failed'); END",
    ).run();
    const before = await readStorage();
    try {
      await expect(
        repository.removeMatchingProfileEventPrizeAssignment(input),
      ).resolves.toBe(false);
      await expect(
        repository.removeMatchingProfileEventPrizeAssignment({
          ...input,
          eventId: "missing-event",
        }),
      ).resolves.toBe(true);
      await expect(
        repository.removeMatchingProfileEventPrizeAssignment({
          ...input,
          eventId: "invalid/id",
        }),
      ).rejects.toThrow("invalid-event-path");
      expect(await readStorage()).toEqual(before);
      expect(log.mock.calls).toHaveLength(3);
      for (const [message] of log.mock.calls) {
        expect(JSON.parse(String(message))).toMatchObject({
          event: "event_write_admission_release_failed",
          context: "event-path-transaction",
          attempts: 1,
        });
      }
    } finally {
      await testEnv.EVENT_DB.prepare(
        "DROP TRIGGER cleanup_release_failure",
      ).run();
      await testEnv.EVENT_DB.prepare(
        "DELETE FROM event_write_admissions",
      ).run();
    }
  });
});
