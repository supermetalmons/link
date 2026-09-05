import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import {
  acquireWagerReservationAdmission,
  assertWagerReservationAdmission,
  readWagerReservationControl,
  releaseWagerReservationAdmission,
} from "../src/wagerReservationControl.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_DB;

describe("wager reservation maintenance", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      db,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "a".repeat(64),
    );
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
