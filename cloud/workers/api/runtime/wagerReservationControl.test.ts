import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import {
  isWagerAdmissionInsert,
  observeWagerAdmissionDatabase,
} from "./wagerAdmissionTestUtils.ts";
import {
  acquireWagerReservationAdmission,
  assertWagerReservationAdmission,
  readWagerReservationControl,
  releaseWagerReservationAdmission,
} from "../src/wagerReservationControl.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_DB;

async function admissionCount(database = db): Promise<number | null> {
  return database
    .prepare("SELECT COUNT(*) AS count FROM wager_reservation_write_admissions")
    .first<number>("count");
}

describe("wager reservation maintenance", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      db,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "a".repeat(64),
    );
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM wager_reservation_write_admissions"),
      db.prepare(
        "UPDATE wager_reservation_runtime_control SET storage_mode = 'd1' WHERE singleton = 1",
      ),
      db.prepare(
        "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
      ),
    ]);
  });

  it.each([
    { kind: "send", now: 1_000 },
    { kind: "", now: 1_000.5 },
  ])("acquires $kind at $now in one database call", async ({ kind, now }) => {
    const control = await readWagerReservationControl(db);
    const observed = observeWagerAdmissionDatabase(db);
    const admission = await acquireWagerReservationAdmission(
      observed.database,
      kind,
      now,
    );
    expect(observed.queries).toHaveLength(1);
    expect(isWagerAdmissionInsert(observed.queries[0]!)).toBe(true);
    expect(observed.sessions).toEqual([]);
    expect(admission).toEqual({
      admissionId: expect.any(String),
      freezeGeneration: control.freezeGeneration,
      expiresAtMs: now + 900_000,
      writerEpoch: 1,
    });
    expect(
      await db
        .prepare("SELECT * FROM wager_reservation_write_admissions")
        .first(),
    ).toEqual({
      admission_id: admission.admissionId,
      freeze_generation: control.freezeGeneration,
      kind,
      created_at_ms: now,
      expires_at_ms: now + 900_000,
      writer_epoch: 1,
      uncertain: 0,
    });
  });

  it.each(["lost", "empty", "invalid"] as const)(
    "recovers an admission from a primary read after an %s insert response",
    async (response) => {
      const observed = observeWagerAdmissionDatabase(
        db,
        async (execute, query) => {
          const result = await execute();
          if (!isWagerAdmissionInsert(query)) return result;
          if (response === "lost") throw new Error("admission-response-lost");
          return response === "empty" ? null : { freeze_generation: "invalid" };
        },
      );
      const admission = await acquireWagerReservationAdmission(
        observed.database,
        "",
        1_000.5,
      );
      expect(observed.queries).toHaveLength(2);
      expect(observed.queries.filter(isWagerAdmissionInsert)).toHaveLength(1);
      expect(observed.sessions).toEqual(["first-primary"]);
      expect(await admissionCount()).toBe(1);
      expect(
        await db
          .prepare(
            "SELECT admission_id, freeze_generation FROM wager_reservation_write_admissions",
          )
          .first(),
      ).toEqual({
        admission_id: admission.admissionId,
        freeze_generation: admission.freezeGeneration,
      });
      expect(admission.expiresAtMs).toBe(901_000.5);
    },
  );

  it.each([
    ["identity", "admission_id = 'another-admission'"],
    ["kind", "kind = 'another-kind'"],
    ["creation", "created_at_ms = created_at_ms + 1"],
    ["expiry", "expires_at_ms = expires_at_ms + 1"],
    ["writer", "writer_epoch = 0"],
  ] as const)(
    "does not accept mismatched %s as proof of an ambiguous admission",
    async (_name, mutation) => {
      const observed = observeWagerAdmissionDatabase(
        db,
        async (execute, query) => {
          const result = await execute();
          if (isWagerAdmissionInsert(query)) {
            await db
              .prepare(
                `UPDATE wager_reservation_write_admissions SET ${mutation}`,
              )
              .run();
            throw new Error("admission-response-lost");
          }
          return result;
        },
      );
      await expect(
        acquireWagerReservationAdmission(observed.database, "send", 1_000),
      ).rejects.toThrow("wager-reservation-unavailable");
      expect(observed.queries).toHaveLength(3);
      expect(observed.queries.filter(isWagerAdmissionInsert)).toHaveLength(1);
      expect(observed.sessions).toEqual(["first-primary"]);
      expect(await admissionCount()).toBe(1);
    },
  );

  it("rejects a malformed recovered generation without deleting the admission", async () => {
    const observed = observeWagerAdmissionDatabase(
      db,
      async (execute, query) => {
        const result = await execute();
        if (isWagerAdmissionInsert(query)) {
          await db
            .prepare(
              "UPDATE wager_reservation_write_admissions SET freeze_generation = 1.5",
            )
            .run();
          throw new Error("admission-response-lost");
        }
        return result;
      },
    );
    await expect(
      acquireWagerReservationAdmission(observed.database, "send", 1_000),
    ).rejects.toThrow("wager-reservation-unavailable");
    expect(observed.queries).toHaveLength(2);
    expect(observed.queries.filter(isWagerAdmissionInsert)).toHaveLength(1);
    expect(await admissionCount()).toBe(1);
  });

  it.each(["insert", "proof"] as const)(
    "fails closed when the %s query is unavailable without retrying insertion",
    async (failure) => {
      const observed = observeWagerAdmissionDatabase(
        db,
        async (execute, query) => {
          if (isWagerAdmissionInsert(query)) {
            if (failure === "proof") await execute();
            throw new Error("admission-response-unavailable");
          }
          if (
            failure === "proof" &&
            query.includes("FROM wager_reservation_write_admissions")
          ) {
            throw new Error("admission-proof-unavailable");
          }
          return execute();
        },
      );
      await expect(
        acquireWagerReservationAdmission(observed.database, "send", 1_000),
      ).rejects.toThrow("wager-reservation-unavailable");
      expect(observed.queries).toHaveLength(3);
      expect(observed.queries.filter(isWagerAdmissionInsert)).toHaveLength(1);
      expect(await admissionCount()).toBe(failure === "proof" ? 1 : 0);
    },
  );

  it("recovers a committed admission after a concurrent freeze and preserves its fence", async () => {
    const control = await readWagerReservationControl(db);
    const observed = observeWagerAdmissionDatabase(
      db,
      async (execute, query) => {
        const result = await execute();
        if (isWagerAdmissionInsert(query)) {
          await db.batch([
            db.prepare(
              "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
            ),
            db.prepare(
              "UPDATE wager_reservation_runtime_control SET storage_mode = 'frozen', freeze_generation = freeze_generation + 1 WHERE singleton = 1",
            ),
          ]);
          throw new Error("admission-response-lost");
        }
        return result;
      },
    );
    const admission = await acquireWagerReservationAdmission(
      observed.database,
      "send",
      1_000,
    );
    expect(admission.freezeGeneration).toBe(control.freezeGeneration);
    expect(observed.queries).toHaveLength(2);
    expect(observed.sessions).toEqual(["first-primary"]);
    await expect(
      assertWagerReservationAdmission(db, admission, 1_001),
    ).rejects.toThrow("wager-reservation-writes-disabled");
    await releaseWagerReservationAdmission(db, admission);
    expect(await admissionCount()).toBe(0);
  });

  it("preserves lease fencing, uncertain admission recovery, and the drain barrier", async () => {
    const initial = await readWagerReservationControl(db);
    expect(initial.storageMode).toBe("d1");
    const clean = await acquireWagerReservationAdmission(db, "send", 1_000);
    const uncertain = await acquireWagerReservationAdmission(
      db,
      "settlement",
      1_000,
    );
    await assertWagerReservationAdmission(db, clean, 1_001);
    await db
      .prepare(
        "UPDATE wager_reservation_write_admissions SET uncertain = 1 WHERE admission_id = ?",
      )
      .bind(uncertain.admissionId)
      .run();
    await expect(
      assertWagerReservationAdmission(db, uncertain, 1_001),
    ).rejects.toThrow("wager-reservation-unavailable");
    await releaseWagerReservationAdmission(db, uncertain);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM wager_reservation_write_admissions",
        )
        .first("count"),
    ).toBe(2);
    await db.batch([
      db.prepare(
        "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
      ),
      db.prepare(
        "UPDATE wager_reservation_runtime_control SET storage_mode = 'frozen', freeze_generation = freeze_generation + 1 WHERE singleton = 1",
      ),
    ]);
    await expect(
      assertWagerReservationAdmission(db, clean, 1_002),
    ).rejects.toThrow("wager-reservation-writes-disabled");
    await expect(
      acquireWagerReservationAdmission(db, "send", 1_002),
    ).rejects.toThrow("wager-reservation-writes-disabled");
    await releaseWagerReservationAdmission(db, clean);
    await expect(
      db
        .prepare(
          "UPDATE wager_reservation_runtime_control SET storage_mode = 'd1' WHERE singleton = 1",
        )
        .run(),
    ).rejects.toThrow("not drained");
    expect(
      await db
        .prepare("SELECT uncertain FROM wager_reservation_write_admissions")
        .first("uncertain"),
    ).toBe(1);
    await db
      .prepare(
        "DELETE FROM wager_reservation_write_admissions WHERE admission_id = ?",
      )
      .bind(uncertain.admissionId)
      .run();
    await db.batch([
      db.prepare(
        "UPDATE wager_reservation_runtime_control SET storage_mode = 'd1' WHERE singleton = 1",
      ),
      db.prepare(
        "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
      ),
    ]);
    expect((await readWagerReservationControl(db)).freezeGeneration).toBe(
      initial.freezeGeneration + 1,
    );
    await expect(
      assertWagerReservationAdmission(db, clean, 1_003),
    ).rejects.toThrow("wager-reservation-writes-disabled");
    const expired = await acquireWagerReservationAdmission(
      db,
      "expired",
      2_000_000,
    );
    await expect(
      assertWagerReservationAdmission(db, expired, expired.expiresAtMs),
    ).rejects.toThrow("wager-reservation-writes-disabled");
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM wager_reservation_write_admissions",
        )
        .first("count"),
    ).toBe(1);
  });

  it("rejects source modes, control replacement, and generation changes outside a freeze", async () => {
    for (const sql of [
      "UPDATE wager_reservation_runtime_control SET storage_mode = 'firebase' WHERE singleton = 1",
      "DELETE FROM wager_reservation_runtime_control",
      "INSERT OR REPLACE INTO wager_reservation_runtime_control VALUES (1, 'd1', 0, 0)",
      "UPDATE wager_reservation_runtime_control SET freeze_generation = freeze_generation + 1 WHERE singleton = 1",
      "UPDATE wager_reservation_runtime_control SET storage_mode = 'frozen' WHERE singleton = 1",
    ])
      await expect(db.prepare(sql).run()).rejects.toThrow();
    await db
      .prepare(
        "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
      )
      .run();
    await expect(
      acquireWagerReservationAdmission(db, "disabled", 1_000),
    ).rejects.toThrow("wager-reservation-unavailable");
  });
});

describe("wager admission control validation", () => {
  const validationDb = env.AUTH_STATE_DB;

  beforeAll(async () => {
    await validationDb.batch([
      validationDb.prepare(
        "CREATE TABLE wager_reservation_runtime_control (singleton INTEGER PRIMARY KEY, storage_mode, freeze_generation)",
      ),
      validationDb.prepare(
        "CREATE TABLE profile_canonical_control (singleton INTEGER PRIMARY KEY, state)",
      ),
      validationDb.prepare(
        "CREATE TABLE wager_state_activation (singleton INTEGER PRIMARY KEY, activation_epoch)",
      ),
      validationDb.prepare(`CREATE TABLE wager_reservation_write_admissions (
        admission_id TEXT PRIMARY KEY, freeze_generation, kind TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
        writer_epoch INTEGER NOT NULL, uncertain INTEGER NOT NULL DEFAULT 0
      )`),
      validationDb.prepare(
        "INSERT INTO wager_reservation_runtime_control VALUES (1, 'd1', 1)",
      ),
      validationDb.prepare(
        "INSERT INTO profile_canonical_control VALUES (1, 'active')",
      ),
      validationDb.prepare("INSERT INTO wager_state_activation VALUES (1, 1)"),
    ]);
  });

  beforeEach(async () => {
    await validationDb.batch([
      validationDb.prepare("DELETE FROM wager_reservation_write_admissions"),
      validationDb.prepare("DELETE FROM wager_reservation_runtime_control"),
      validationDb.prepare(
        "INSERT INTO wager_reservation_runtime_control VALUES (1, 'd1', 1)",
      ),
      validationDb.prepare(
        "UPDATE profile_canonical_control SET state = 'active'",
      ),
      validationDb.prepare(
        "UPDATE wager_state_activation SET activation_epoch = 1",
      ),
    ]);
  });

  it.each([
    ["zero", "0", 0],
    ["safe maximum", "9007199254740991", Number.MAX_SAFE_INTEGER],
    ["integral REAL", "CAST(1 AS REAL)", 1],
    ["maximum REAL", "CAST(9007199254740991 AS REAL)", Number.MAX_SAFE_INTEGER],
  ] as const)(
    "accepts the existing valid %s generation",
    async (_name, value, expected) => {
      await validationDb
        .prepare(
          `UPDATE wager_reservation_runtime_control SET freeze_generation = ${value}`,
        )
        .run();
      expect(
        (await readWagerReservationControl(validationDb)).freezeGeneration,
      ).toBe(expected);
      const observed = observeWagerAdmissionDatabase(validationDb);
      const admission = await acquireWagerReservationAdmission(
        observed.database,
        "send",
        1_000,
      );
      expect(admission.freezeGeneration).toBe(expected);
      expect(observed.queries).toHaveLength(1);
      expect(await admissionCount(validationDb)).toBe(1);
    },
  );

  it.each([
    ["absent", "DELETE FROM wager_reservation_runtime_control"],
    [
      "null",
      "UPDATE wager_reservation_runtime_control SET freeze_generation = NULL",
    ],
    [
      "fractional",
      "UPDATE wager_reservation_runtime_control SET freeze_generation = 1.5",
    ],
    [
      "negative",
      "UPDATE wager_reservation_runtime_control SET freeze_generation = -1",
    ],
    [
      "unsafe",
      "UPDATE wager_reservation_runtime_control SET freeze_generation = 9007199254740992",
    ],
    [
      "text",
      "UPDATE wager_reservation_runtime_control SET freeze_generation = '1'",
    ],
    [
      "BLOB",
      "UPDATE wager_reservation_runtime_control SET freeze_generation = X'31'",
    ],
    [
      "source mode",
      "UPDATE wager_reservation_runtime_control SET storage_mode = 'firebase'",
    ],
  ] as const)(
    "rejects %s control values before creating an admission",
    async (_name, mutation) => {
      await validationDb.prepare(mutation).run();
      await expect(readWagerReservationControl(validationDb)).rejects.toThrow(
        "wager-reservation-unavailable",
      );
      const observed = observeWagerAdmissionDatabase(validationDb);
      await expect(
        acquireWagerReservationAdmission(observed.database, "send", 1_000),
      ).rejects.toThrow("wager-reservation-unavailable");
      expect(observed.queries.filter(isWagerAdmissionInsert)).toHaveLength(1);
      expect(await admissionCount(validationDb)).toBe(0);
    },
  );

  it.each([
    [
      "reservation freeze",
      "UPDATE wager_reservation_runtime_control SET storage_mode = 'frozen'",
      "wager-reservation-writes-disabled",
    ],
    [
      "profile freeze",
      "UPDATE profile_canonical_control SET state = 'frozen'",
      "wager-reservation-unavailable",
    ],
    [
      "writer epoch",
      "UPDATE wager_state_activation SET activation_epoch = 0",
      "wager-reservation-unavailable",
    ],
  ] as const)(
    "preserves the %s admission gate",
    async (_name, mutation, failure) => {
      await validationDb.prepare(mutation).run();
      await expect(
        acquireWagerReservationAdmission(validationDb, "send", 1_000),
      ).rejects.toThrow(failure);
      expect(await admissionCount(validationDb)).toBe(0);
    },
  );
});
