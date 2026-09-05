import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import {
  acquireWagerReservationAdmission,
  assertWagerReservationAdmission,
  markWagerReservationAdmissionUncertain,
  readWagerReservationControl,
  releaseWagerReservationAdmission,
} from "../src/wagerReservationControl.ts";
import { createWagerReservationRuntime } from "../src/wagerReservationRuntime.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import { reserveFrozenMaterialsOnce } from "../src/wagerReservationOperations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_DB;
const total = { dust: 10, slime: 0, gum: 0, metal: 0, ice: 0 };

describe("wager reservation storage activation", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      db,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "a".repeat(64),
    );
  });

  it("drains admissions, gates writes, activates once, and isolates D1 from Firebase", async () => {
    expect((await readWagerReservationControl(db)).storageMode).toBe(
      "firebase",
    );
    const clean = await acquireWagerReservationAdmission(db, "send", 1_000);
    const uncertain = await acquireWagerReservationAdmission(
      db,
      "settlement",
      1_000,
    );
    await assertWagerReservationAdmission(db, clean, 1_001);
    await markWagerReservationAdmissionUncertain(db, uncertain);
    await releaseWagerReservationAdmission(db, uncertain);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM wager_reservation_write_admissions",
        )
        .first("count"),
    ).toBe(2);
    await db
      .prepare(
        "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
      )
      .run();
    await db
      .prepare(
        `UPDATE wager_reservation_runtime_control
      SET storage_mode = 'frozen', previous_storage_mode = 'firebase',
          freeze_generation = 1, verified_import_generation = NULL WHERE singleton = 1`,
      )
      .run();
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
          `UPDATE wager_reservation_runtime_control
      SET verified_import_generation = 1 WHERE singleton = 1`,
        )
        .run(),
    ).rejects.toThrow();
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
    await expect(
      db
        .prepare(
          `UPDATE wager_reservation_runtime_control
      SET storage_mode = 'd1', previous_storage_mode = NULL, activated_at_ms = 2000000
      WHERE singleton = 1`,
        )
        .run(),
    ).rejects.toThrow();
    await db
      .prepare(
        `UPDATE wager_reservation_runtime_control
      SET import_attempt_id = 'first-import', import_started_at_ms = 1000000
      WHERE singleton = 1`,
      )
      .run();
    await expect(
      db
        .prepare(
          `UPDATE wager_reservation_runtime_control
      SET import_attempt_id = 'second-import', import_started_at_ms = 1000001
      WHERE singleton = 1`,
        )
        .run(),
    ).rejects.toThrow();
    await db
      .prepare(
        `UPDATE wager_reservation_runtime_control
      SET verified_import_generation = 1, import_attempt_id = NULL, import_started_at_ms = NULL,
          source_digest = ?, source_balance_count = 0,
          source_operation_count = 0, source_first_exported_at_ms = 1000000,
          source_exported_at_ms = 2000000, queues_paused_at_ms = 1000000,
          bridge_deployed_at_ms = 900000, bridge_version_id = 'bridge'
      WHERE singleton = 1`,
      )
      .bind("a".repeat(64))
      .run();
    await db
      .prepare(
        `UPDATE wager_reservation_runtime_control
      SET storage_mode = 'd1', previous_storage_mode = NULL, activated_at_ms = 2000000
      WHERE singleton = 1`,
      )
      .run();
    expect((await readWagerReservationControl(db)).storageMode).toBe("d1");

    const repository = createGameplayRepository(env);
    repository.getRtdbPath = async () => {
      throw new Error("unexpected-firebase-read");
    };
    repository.transactRtdbPath = async () => {
      throw new Error("unexpected-firebase-write");
    };
    const runtime = createWagerReservationRuntime(env, repository, {
      now: () => 2_000_000,
    });
    expect(await runtime.readBalance("host")).toEqual({
      frozen: { ...total, dust: 0 },
      revision: 0,
    });
    await expect(
      runtime.assertClientVersion(
        new Request("https://api.mons.link/wagers/proposals/send"),
      ),
    ).rejects.toThrow("Reload this page");
    await expect(
      runtime.assertClientVersion(
        new Request("https://api.mons.link/wagers/proposals/send", {
          headers: { "X-Mons-Wager-Storage-Version": "1" },
        }),
      ),
    ).resolves.toBeUndefined();
    await db
      .prepare(
        "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
      )
      .run();
    const count = await runtime.run("send", (admitted) =>
      reserveFrozenMaterialsOnce(
        admitted,
        "host",
        "operation",
        "dust",
        3,
        total,
        () => 2_000_000,
        new AbortController().signal,
      ),
    );
    expect(count).toBe(3);
    expect(await runtime.readBalance("host")).toEqual({
      frozen: { ...total, dust: 3 },
      revision: 1,
    });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM wager_reservation_write_admissions",
        )
        .first("count"),
    ).toBe(0);
    await expect(
      db
        .prepare(
          `UPDATE wager_reservation_runtime_control
      SET storage_mode = 'firebase', activated_at_ms = NULL WHERE singleton = 1`,
        )
        .run(),
    ).rejects.toThrow();
    await db
      .prepare(
        "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
      )
      .run();
    await db
      .prepare(
        `UPDATE wager_reservation_runtime_control
      SET storage_mode = 'frozen', previous_storage_mode = 'd1',
          freeze_generation = 2, verified_import_generation = NULL WHERE singleton = 1`,
      )
      .run();
    expect((await runtime.readBalance("host")).frozen.dust).toBe(3);
    await expect(
      db
        .prepare(
          `UPDATE wager_reservation_runtime_control
      SET storage_mode = 'firebase', previous_storage_mode = NULL WHERE singleton = 1`,
        )
        .run(),
    ).rejects.toThrow();
    await db
      .prepare(
        `UPDATE wager_reservation_runtime_control
      SET storage_mode = 'd1', previous_storage_mode = NULL WHERE singleton = 1`,
      )
      .run();
    await db
      .prepare(
        "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
      )
      .run();
    const expired = await acquireWagerReservationAdmission(
      db,
      "expired",
      2_000_000,
    );
    await expect(
      assertWagerReservationAdmission(db, expired, expired.expiresAtMs),
    ).rejects.toThrow();
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM wager_reservation_write_admissions",
        )
        .first("count"),
    ).toBe(1);
  });
});
