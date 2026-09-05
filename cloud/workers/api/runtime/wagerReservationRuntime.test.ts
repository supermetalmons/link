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

describe("D1 wager reservation runtime", () => {
  beforeAll(async () => {
    await applyRetiredProfileMigrations(
      db,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "a".repeat(64),
    );
  });

  it("uses D1 exclusively, releases successful admissions, and permits frozen reads", async () => {
    let firebaseAccesses = 0;
    let frozenWork = 0;
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
    await expect(
      runtime.assertClientVersion(
        new Request("https://api.mons.link/wagers/proposals/send"),
      ),
    ).rejects.toThrow("Reload this page");
    await expect(
      runtime.assertClientVersion(versionedRequest()),
    ).resolves.toBeUndefined();
    expect(
      await runtime.run("send", (admitted) =>
        reserveFrozenMaterialsOnce(
          admitted,
          "host",
          "reservation",
          "dust",
          3,
          { ...createEmptyMaterials(), dust: 10 },
          () => 2_000_000,
          new AbortController().signal,
        ),
      ),
    ).toBe(3);
    expect(await runtime.readBalance("host")).toEqual({
      frozen: { ...createEmptyMaterials(), dust: 3 },
      revision: 1,
    });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM wager_reservation_write_admissions",
        )
        .first("count"),
    ).toBe(0);
    await db.batch([
      db.prepare(
        "UPDATE profile_canonical_control SET state = 'frozen' WHERE singleton = 1",
      ),
      db.prepare(
        "UPDATE wager_reservation_runtime_control SET storage_mode = 'frozen', freeze_generation = freeze_generation + 1 WHERE singleton = 1",
      ),
    ]);
    expect((await runtime.readBalance("host")).frozen.dust).toBe(3);
    await expect(
      runtime.run("send", async () => {
        frozenWork++;
      }),
    ).rejects.toThrow("wager-reservation-writes-disabled");
    expect(frozenWork).toBe(0);
    expect(firebaseAccesses).toBe(0);
  });

  it("fails unavailable D1 control closed without querying gameplay storage", async () => {
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
