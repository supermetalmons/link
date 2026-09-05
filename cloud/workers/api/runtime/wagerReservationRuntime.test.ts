import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createEmptyMaterials } from "@mons/shared/mining";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import { createWagerReservationRuntime } from "../src/wagerReservationRuntime.ts";
import { reserveFrozenMaterialsOnce } from "../src/wagerReservationOperations.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";

const testEnv = env as Env & { TEST_PROFILE_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_DB;

function versionedRequest() {
  return new Request("https://api.mons.link/wagers/proposals/send", {
    headers: { "X-Mons-Wager-Storage-Version": "1" },
  });
}

describe("retired Firebase wager reservation runtime", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      db,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "a".repeat(64),
    );
  });

  it("rejects legacy storage without touching Firebase and keeps D1 reads available during maintenance", async () => {
    let firebaseAccesses = 0;
    let legacyWork = 0;
    const unexpectedFirebase = async () => {
      firebaseAccesses++;
      throw new Error("unexpected-firebase-reservation-access");
    };
    const repository = {
      getRtdbPath: unexpectedFirebase,
      transactRtdbPath: unexpectedFirebase,
      patchRtdbRoot: unexpectedFirebase,
    } as unknown as GameplayRepository;
    const runtime = createWagerReservationRuntime(env, repository, {
      now: () => 2_000_000,
    });
    const assertLegacyUnavailable = async () => {
      await expect(runtime.readBalance("host")).rejects.toThrow(
        "wager-reservation-unavailable",
      );
      await expect(
        runtime.assertClientVersion(versionedRequest()),
      ).rejects.toThrow("wager-reservation-unavailable");
      await expect(
        runtime.run("send", async () => {
          legacyWork++;
        }),
      ).rejects.toThrow("wager-reservation-unavailable");
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM wager_reservation_write_admissions",
          )
          .first("count"),
      ).toBe(0);
      expect(legacyWork).toBe(0);
      expect(firebaseAccesses).toBe(0);
    };
    await assertLegacyUnavailable();
    await expect(
      runtime.assertClientVersion(
        new Request("https://api.mons.link/wagers/proposals/send"),
      ),
    ).rejects.toThrow("Reload this page");
    await db.batch([
      db.prepare(
        "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
      ),
      db.prepare(`UPDATE wager_reservation_runtime_control
        SET storage_mode = 'frozen', previous_storage_mode = 'firebase',
            freeze_generation = 1, verified_import_generation = NULL WHERE singleton = 1`),
    ]);
    await assertLegacyUnavailable();
    await db.batch([
      db.prepare(
        `UPDATE wager_reservation_runtime_control SET import_attempt_id = 'retirement-test', import_started_at_ms = 1000000 WHERE singleton = 1`,
      ),
      db
        .prepare(
          `INSERT INTO wager_frozen_balances (player_uid, frozen_json, revision, updated_at_ms)
        VALUES ('host', ?, 1, 2000000)`,
        )
        .bind(JSON.stringify({ ...createEmptyMaterials(), dust: 3 })),
      db
        .prepare(
          `UPDATE wager_reservation_runtime_control
        SET verified_import_generation = 1, import_attempt_id = NULL, import_started_at_ms = NULL,
            source_digest = ?, source_balance_count = 1, source_operation_count = 0,
            source_first_exported_at_ms = 1000000, source_exported_at_ms = 2000000,
            queues_paused_at_ms = 1000000, bridge_deployed_at_ms = 900000, bridge_version_id = 'bridge' WHERE singleton = 1`,
        )
        .bind("a".repeat(64)),
      db.prepare(`UPDATE wager_reservation_runtime_control
        SET storage_mode = 'd1', previous_storage_mode = NULL, activated_at_ms = 2000000 WHERE singleton = 1`),
    ]);
    expect(await runtime.readBalance("host")).toEqual({
      frozen: { ...createEmptyMaterials(), dust: 3 },
      revision: 1,
    });
    await expect(
      runtime.assertClientVersion(versionedRequest()),
    ).resolves.toBeUndefined();
    await db
      .prepare(
        "UPDATE profile_canonical_control SET state = 'active' WHERE singleton = 1",
      )
      .run();
    expect(
      await runtime.run("send", (admitted) =>
        reserveFrozenMaterialsOnce(
          admitted,
          "host",
          "after-retirement",
          "dust",
          2,
          { ...createEmptyMaterials(), dust: 10 },
          () => 2_000_000,
          new AbortController().signal,
        ),
      ),
    ).toBe(2);
    expect(await runtime.readBalance("host")).toEqual({
      frozen: { ...createEmptyMaterials(), dust: 5 },
      revision: 2,
    });
    await db.batch([
      db.prepare(
        "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
      ),
      db.prepare(`UPDATE wager_reservation_runtime_control
        SET storage_mode = 'frozen', previous_storage_mode = 'd1',
            freeze_generation = 2, verified_import_generation = NULL WHERE singleton = 1`),
    ]);
    expect(await runtime.readBalance("host")).toEqual({
      frozen: { ...createEmptyMaterials(), dust: 5 },
      revision: 2,
    });
    await expect(
      runtime.run("send", async () => {
        legacyWork++;
      }),
    ).rejects.toThrow("wager-reservation-writes-disabled");
    expect(legacyWork).toBe(0);
    expect(firebaseAccesses).toBe(0);
  });

  it("fails unavailable D1 control closed without querying legacy storage", async () => {
    let firebaseAccesses = 0;
    const repository = {
      getRtdbPath: async () => {
        firebaseAccesses++;
        return null;
      },
    } as unknown as GameplayRepository;
    const brokenDb = new Proxy(db, {
      get(target, property) {
        if (property === "prepare")
          return () => {
            throw new Error("control-unavailable");
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const runtime = createWagerReservationRuntime(
      { ...env, PROFILE_DB: brokenDb },
      repository,
    );
    await expect(runtime.readBalance("host")).rejects.toThrow(
      "wager-reservation-unavailable",
    );
    await expect(
      runtime.run("send", async () => {
        throw new Error("unexpected-work");
      }),
    ).rejects.toThrow("wager-reservation-unavailable");
    expect(firebaseAccesses).toBe(0);
  });
});
