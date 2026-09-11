import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  acquireMatchStateAdmission,
  assertMatchStateAdmission,
  buildMatchStateRouteStatements,
  completeMatchStateAdmission,
  extendMatchStateAdmissionResources,
  markMatchStateAdmissionUncertain,
  readLegacyMatchState,
  readMatchStateControl,
  readMatchStateRoute,
} from "../src/matchStateD1.ts";

const runtime = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;

beforeEach(async () => {
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'match_state_%'",
    )
    .all<{ name: string }>();
  for (const { name } of tables.results)
    await db.prepare(`DROP TABLE ${name}`).run();
  const migration = runtime.TEST_D1_MIGRATIONS.find((item) =>
    item.name.startsWith("0024_"),
  );
  if (!migration) throw new Error("match-state-test-migration-missing");
  await db.batch(migration.queries.map((query) => db.prepare(query)));
});

describe("match state D1 authority and admissions", () => {
  it("starts on Firebase and permits reads of empty routes", async () => {
    expect(await readMatchStateControl(db)).toMatchObject({
      backend: "rtdb",
      state: "active",
      epoch: 1,
      freezeGeneration: 0,
    });
    expect(await readMatchStateRoute(db, "host", "game")).toBeNull();
    expect(await readLegacyMatchState(db, "host", "game")).toBeNull();
  });

  it("drains existing admissions while refusing new work and allows only named recovery", async () => {
    const existing = await acquireMatchStateAdmission(db, {
      kind: "move",
      resources: ["players/host/matches/game"],
    });
    await db
      .prepare(
        "UPDATE match_state_control SET state = 'draining' WHERE singleton = 1",
      )
      .run();
    await expect(
      assertMatchStateAdmission(db, existing),
    ).resolves.toBeUndefined();
    await expect(
      acquireMatchStateAdmission(db, { kind: "move", resources: [] }),
    ).rejects.toThrow("writes-disabled");
    await expect(
      acquireMatchStateAdmission(db, {
        kind: "recover",
        resources: [],
        transitionId: "unlisted",
      }),
    ).rejects.toThrow("writes-disabled");
    await db
      .prepare(
        "INSERT INTO match_state_recovery_ids (transition_id, freeze_generation) VALUES ('transition', 0)",
      )
      .run();
    const recovery = await acquireMatchStateAdmission(db, {
      kind: "recover",
      resources: ["game"],
      transitionId: "transition",
    });
    await completeMatchStateAdmission(db, existing);
    await completeMatchStateAdmission(db, recovery);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS count FROM match_state_write_admissions")
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
  });

  it("revokes an admitted writer at the freeze generation fence", async () => {
    const admitted = await acquireMatchStateAdmission(db, {
      kind: "move",
      resources: ["game"],
    });
    await db
      .prepare(
        "UPDATE match_state_control SET state = 'frozen', freeze_generation = 1 WHERE singleton = 1",
      )
      .run();
    await expect(assertMatchStateAdmission(db, admitted)).rejects.toThrow(
      "admission-lost",
    );
    await expect(
      acquireMatchStateAdmission(db, { kind: "new", resources: [] }),
    ).rejects.toThrow("writes-disabled");
  });

  it("records the exact write scope before nested operations during drain", async () => {
    const admitted = await acquireMatchStateAdmission(db, {
      kind: "gameplay",
      resources: [],
    });
    await db
      .prepare(
        "UPDATE match_state_control SET state = 'draining' WHERE singleton = 1",
      )
      .run();
    await extendMatchStateAdmissionResources(db, admitted, [
      "players/host/matches/game",
      "matchTimerClaims/game",
    ]);
    await extendMatchStateAdmissionResources(db, admitted, [
      "players/host/matches/game",
    ]);
    expect(admitted.resources).toEqual([
      "matchTimerClaims/game",
      "players/host/matches/game",
    ]);
    expect(
      (
        await db
          .prepare(
            "SELECT resources_json FROM match_state_write_admissions WHERE admission_id = ?",
          )
          .bind(admitted.admissionId)
          .first<{ resources_json: string }>()
      )?.resources_json,
    ).toBe(JSON.stringify(admitted.resources));
    await markMatchStateAdmissionUncertain(db, admitted);
    await expect(
      extendMatchStateAdmissionResources(db, admitted, ["another"]),
    ).rejects.toThrow();
  });

  it("retains uncertain outcomes and does not release them based on age", async () => {
    const admitted = await acquireMatchStateAdmission(db, {
      kind: "timer",
      resources: ["matchTimerClaims/game"],
      nowMs: 1,
    });
    await markMatchStateAdmissionUncertain(db, admitted);
    await expect(assertMatchStateAdmission(db, admitted)).rejects.toThrow(
      "admission-lost",
    );
    await expect(completeMatchStateAdmission(db, admitted)).rejects.toThrow(
      "release-unconfirmed",
    );
    expect(
      await db
        .prepare(
          "SELECT phase, created_at_ms FROM match_state_write_admissions WHERE admission_id = ?",
        )
        .bind(admitted.admissionId)
        .first(),
    ).toEqual({ phase: "uncertain", created_at_ms: 1 });
  });

  it("does not let another admission tuple release a writer", async () => {
    const admitted = await acquireMatchStateAdmission(db, {
      kind: "move",
      resources: ["game"],
    });
    await expect(
      completeMatchStateAdmission(db, { ...admitted, resources: [] }),
    ).rejects.toThrow("release-unconfirmed");
    await completeMatchStateAdmission(db, admitted);
  });

  it("preserves immutable exact routes and raw legacy values", async () => {
    const route = {
      actorUid: "old",
      matchId: "old-game",
      kind: "legacy" as const,
      inviteId: null,
      epoch: 2,
    };
    await db.batch(buildMatchStateRouteStatements(db, [route]));
    await db.batch(buildMatchStateRouteStatements(db, [route]));
    expect(await readMatchStateRoute(db, "old", "old-game")).toEqual(route);
    await expect(readLegacyMatchState(db, "old", "old-game")).rejects.toThrow(
      "legacy-record-unavailable",
    );
    await expect(
      db.batch(
        buildMatchStateRouteStatements(db, [
          { ...route, kind: "durable", inviteId: "game" },
        ]),
      ),
    ).rejects.toThrow("route-conflict");
    await db
      .prepare(
        "INSERT INTO match_state_legacy_records VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        "old",
        "old-game",
        '[1,{"legacy":true}]',
        "a".repeat(64),
        "import",
        "malformed",
      )
      .run();
    expect(await readLegacyMatchState(db, "old", "old-game")).toEqual([
      1,
      { legacy: true },
    ]);
    await expect(
      db
        .prepare(
          "UPDATE match_state_legacy_records SET record_json = '{}' WHERE actor_uid = 'old'",
        )
        .run(),
    ).rejects.toThrow("immutable");
  });

  it("requires verified evidence before authority changes and rejects rollback", async () => {
    await expect(
      db
        .prepare(
          "UPDATE match_state_control SET backend = 'durable', epoch = 2 WHERE singleton = 1",
        )
        .run(),
    ).rejects.toThrow();
    await db
      .prepare(
        `UPDATE match_state_control SET backend = 'durable', epoch = 2, state = 'frozen',
      candidate_version_id = 'candidate', import_id = 'import', source_digest = ?, verified_digest = ?, fence_digest = ?,
      source_record_count = 0, source_claim_count = 0, source_bundle_count = 0, verified_at_ms = 1, activated_at_ms = 2 WHERE singleton = 1`,
      )
      .bind("a".repeat(64), "a".repeat(64), "b".repeat(64))
      .run();
    await expect(
      db
        .prepare(
          "UPDATE match_state_control SET backend = 'rtdb' WHERE singleton = 1",
        )
        .run(),
    ).rejects.toThrow("one-way");
  });
});
