import {
  env,
  reset,
  runInDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";
import {
  preTimerRetirementTestMigrations,
  TIMER_RETIREMENT_MIGRATION,
} from "./canonicalTestMigrations.ts";
import { applicationWriteFenceSql } from "../src/applicationDataControl.ts";
import { fenceApplicationDatabase } from "../src/applicationD1.ts";
import { createGameSessionMutationLockStore } from "../src/gameplayCoordinationD1.ts";
import { readMatchStateRoutes } from "../src/matchStateD1.ts";
import { ensureInviteRoomSchema } from "../src/inviteRoomSchema.ts";
import { initializeApplicationObjectControl } from "../src/applicationObjectStorage.ts";
import { MatchWriterStore } from "../src/matchWriterStore.ts";
import { MatchStateStore } from "../src/matchStateStore.ts";
import { matchDocumentFixture } from "../test/matchRecordFixture.ts";
import {
  fenceTimerHandoffD1,
  completeTimerHandoffD1,
} from "./timerStorageBridgeFixture.ts";
import {
  timerHandoffCopyReceipt,
  type TimerHandoffIdentity,
  type TimerHandoffOwnership,
} from "./timerHandoffReceiptFixture.ts";

const raw = env.PROFILE_GAMES_DB;
const migrations = (env as Env & { TEST_D1_MIGRATIONS: D1Migration[] })
  .TEST_D1_MIGRATIONS;
const migration = migrations.find(
  (item) => item.name === TIMER_RETIREMENT_MIGRATION,
)!;
const DROP_TABLES = new Set([
  "match_timer_starts_canonical",
  "timer_storage_handoff_delete_context",
]);

beforeEach(async () => {
  await reset();
});

async function schema() {
  return (
    await raw
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name != 'd1_migrations' ORDER BY type,name",
      )
      .all<{ type: string; name: string; tbl_name: string; sql: string }>()
  ).results;
}
async function contents(excluded = new Set<string>()) {
  const output: Record<string, unknown[]> = {};
  for (const table of (await schema()).filter(
    (item) => item.type === "table" && !excluded.has(item.name),
  ))
    output[table.name] = (
      await raw.prepare(`SELECT * FROM "${table.name}"`).all()
    ).results
      .map((row) => JSON.stringify(row))
      .sort();
  return output;
}
async function applyRetirement(extra: string[] = []) {
  return raw.batch(
    [...migration.queries, ...extra].map((sql) => raw.prepare(sql)),
  );
}

async function fixture(
  options: {
    fences?: boolean;
    complete?: boolean;
    markers?: boolean;
    staleContext?: boolean;
  } = {},
) {
  await applyStrictMatchStateTestMigrations(
    raw,
    preTimerRetirementTestMigrations(migrations),
  );
  const db = fenceApplicationDatabase(raw, {
    kind: "business",
    generation: 3,
    dataEpoch: 1,
    operationId: "retirement-fixture",
  });
  if (options.fences) {
    const guards = [...DROP_TABLES].flatMap(
      (table) =>
        applicationWriteFenceSql(table).match(/CREATE TRIGGER[\s\S]*?END;/g) ??
        [],
    );
    await raw.batch(guards.map((sql) => raw.prepare(sql)));
  }
  const inviteId = `retirement-${crypto.randomUUID()}`;
  const object = env.INVITE_REACTIONS.getByName(inviteId);
  const identity: TimerHandoffIdentity = {
    schemaVersion: 1,
    handoffId: crypto.randomUUID(),
    inviteId,
    objectId: object.id.toString(),
  };
  const ownership: TimerHandoffOwnership[] = [
    { actorUid: "guest", matchId: inviteId, opponentUid: "host" },
    { actorUid: "host", matchId: inviteId, opponentUid: "guest" },
  ];
  await db.batch(
    ownership.map((owner) =>
      db
        .prepare(
          "INSERT INTO match_state_routes_canonical VALUES (?,?,'durable',?,2)",
        )
        .bind(owner.actorUid, owner.matchId, inviteId),
    ),
  );
  if (options.markers !== false)
    await db.batch(
      ownership.map((owner) =>
        db
          .prepare(
            "INSERT INTO match_timer_starts_canonical(match_id,player_id,opponent_id,turn_number,deadline_at_ms,updated_at_ms) VALUES (?,?,?,7,100,20)",
          )
          .bind(owner.matchId, owner.actorUid, owner.opponentUid),
      ),
    );
  const snapshot = await fenceTimerHandoffD1(db, identity, ownership);
  const receipt = await timerHandoffCopyReceipt({
    ...identity,
    ownershipDigest: snapshot.ownershipDigest,
    snapshotDigest: snapshot.snapshotDigest,
    revision: 1,
    markerCount: snapshot.markers.length,
  });
  if (options.complete !== false) {
    const completion = options.staleContext
      ? {
          prepare: (sql: string) =>
            db.prepare(
              sql.startsWith("DELETE FROM timer_storage_handoff_delete_context")
                ? "SELECT ? AS retained_context"
                : sql,
            ),
          batch: db.batch.bind(db),
        }
      : db;
    await completeTimerHandoffD1(completion, receipt);
  }
  await db.batch(
    Array.from({ length: 5 }, (_, index) =>
      db
        .prepare(
          "INSERT INTO application_data_admissions(operation_id,generation,data_epoch,kind,started_at_ms,status,failure_code,parent_operation_id) VALUES (?,3,1,'http',?,'running',NULL,NULL)",
        )
        .bind(`retained-http-${index}`, index + 1),
    ),
  );
  return { db, identity, ownership, snapshot, receipt, object };
}

async function unchangedFailure() {
  const beforeSchema = await schema(),
    beforeRows = await contents();
  await expect(applyRetirement()).rejects.toThrow();
  expect(await schema()).toEqual(beforeSchema);
  expect(await contents()).toEqual(beforeRows);
}

describe("canonical D1 timer retirement", () => {
  it.each([false, true])(
    "drops exactly two retired tables with application fences=%s and preserves live evidence/admissions",
    async (fences) => {
      const f = await fixture({ fences });
      const beforeSchema = await schema(),
        beforeRows = await contents(DROP_TABLES);
      const owners = (
        await raw
          .prepare(
            "SELECT * FROM timer_storage_handoff_owners ORDER BY actor_uid,match_id",
          )
          .all()
      ).results;
      await applyRetirement();
      expect(
        (await schema()).filter((item) => DROP_TABLES.has(item.tbl_name)),
      ).toEqual([]);
      expect(await schema()).toEqual(
        beforeSchema.filter((item) => !DROP_TABLES.has(item.tbl_name)),
      );
      expect(await contents()).toEqual(beforeRows);
      expect(
        (await raw.prepare("SELECT * FROM pragma_foreign_key_check").all())
          .results,
      ).toEqual([]);
      expect(
        await raw
          .prepare(
            "SELECT COUNT(*) AS count FROM application_data_admissions WHERE status='running'",
          )
          .first<number>("count"),
      ).toBe(5);
      expect(
        (
          await raw
            .prepare(
              "SELECT * FROM timer_storage_handoff_owners ORDER BY actor_uid,match_id",
            )
            .all()
        ).results,
      ).toEqual(owners);
      await expect(
        f.db
          .prepare("DELETE FROM timer_storage_handoffs WHERE handoff_id=?")
          .bind(f.identity.handoffId)
          .run(),
      ).rejects.toThrow("timer-handoff-immutable");
      await expect(
        f.db
          .prepare(
            "DELETE FROM timer_storage_handoff_owners WHERE handoff_id=?",
          )
          .bind(f.identity.handoffId)
          .run(),
      ).rejects.toThrow("timer-handoff-owner-immutable");
      await expect(
        f.db
          .prepare("DELETE FROM match_state_routes_canonical WHERE invite_id=?")
          .bind(f.identity.inviteId)
          .run(),
      ).rejects.toThrow("timer-handoff-route-fenced");
      const routes = await readMatchStateRoutes(
        f.db,
        f.ownership.map((owner) => ({
          playerId: owner.actorUid,
          matchId: owner.matchId,
        })),
      );
      expect(routes).toHaveLength(2);
      const locks = createGameSessionMutationLockStore(f.db);
      const lock = {
        lockId: "current-invite",
        operationId: "current-operation",
      };
      await expect(
        locks.acquire(lock, "current-owner", 1000),
      ).resolves.toBeUndefined();
      expect(
        await raw
          .prepare(
            "SELECT owner_id FROM game_session_mutation_locks WHERE lock_id=?",
          )
          .bind(lock.lockId)
          .first<string>("owner_id"),
      ).toBe("current-owner");
      await locks.release(lock, "current-owner");
    },
  );

  it("cannot touch current local Durable Object timers and preserves their post-drop operation", async () => {
    const f = await fixture({ fences: true });
    await runInDurableObject(f.object, async (_instance, ctx) => {
      await initializeApplicationObjectControl(ctx.storage, {
        kind: "business",
        generation: 3,
        dataEpoch: 1,
        operationId: "local-fixture",
      });
      ensureInviteRoomSchema(ctx.storage, { fresh: true });
      const writer = new MatchWriterStore(ctx.storage);
      writer.initializeFreshLocalLayout();
      const storage = writer.guardStorage();
      const store = new MatchStateStore(storage, {
        now: () => 200,
        resolveGame: () => ({
          activeColor: "black",
          historyValid: true,
          turnNumber: 7,
          winner: undefined,
        }),
      });
      const input = {
        inviteId: f.identity.inviteId,
        matchId: f.identity.inviteId,
        playerId: "host",
        opponentId: "guest",
        epoch: 2,
      };
      const creation = {
        inviteId: input.inviteId,
        epoch: input.epoch,
        records: ["host", "guest"].map((playerId, index) => ({
          matchId: input.matchId,
          playerId,
          marker: `${playerId}-created`,
          value: matchDocumentFixture({
            color: index === 0 ? "white" : "black",
            timer:
              index === 0
                ? { state: "running", turnNumber: 7, deadlineAtMs: 100 }
                : { state: "idle" },
          }),
        })),
      };
      await writer.runWriter({ kind: "create", request: creation }, () =>
        store.createRecords(creation),
      );
      await writer.runWriter({ kind: "start-timer", request: input }, () => {
        for (const marker of f.snapshot.markers)
          storage.sql.exec(
            "INSERT INTO match_state_timer_starts_canonical(match_id,player_id,opponent_id,turn_number,deadline_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?)",
            marker.matchId,
            marker.playerId,
            marker.opponentId,
            marker.turnNumber,
            marker.deadlineAtMs,
            marker.updatedAtMs,
          );
      });
      const before = ctx.storage.sql
        .exec(
          "SELECT * FROM match_state_timer_starts_canonical ORDER BY player_id",
        )
        .toArray();
      await applyRetirement();
      expect(
        ctx.storage.sql
          .exec(
            "SELECT * FROM match_state_timer_starts_canonical ORDER BY player_id",
          )
          .toArray(),
      ).toEqual(before);
      await expect(
        writer.runWriter({ kind: "claim-timer", request: input }, () =>
          store.claimTimer(input),
        ),
      ).resolves.toEqual({ ok: true });
      expect(
        ctx.storage.sql
          .exec(
            "SELECT * FROM match_state_timer_starts_canonical ORDER BY player_id",
          )
          .toArray(),
      ).toEqual(before);
      await ctx.storage.deleteAlarm();
    });
  });

  it.each(["generation", "epoch", "phase", "match-control"])(
    "fails closed on %s control mismatch",
    async (kind) => {
      await fixture();
      if (kind === "generation")
        await raw
          .prepare("UPDATE application_data_control SET generation=4")
          .run();
      if (kind === "epoch")
        await raw
          .prepare("UPDATE application_data_control SET data_epoch=0")
          .run();
      if (kind === "phase")
        await raw
          .prepare(
            "UPDATE application_data_control SET phase='closing', migration_id='held'",
          )
          .run();
      if (kind === "match-control")
        await raw
          .prepare("UPDATE match_state_control SET state='frozen'")
          .run();
      await unchangedFailure();
    },
  );

  it("rejects an unfinished zero-marker handoff", async () => {
    await fixture({ markers: false, complete: false });
    await unchangedFailure();
  });

  it("rejects even an expired unowned marker", async () => {
    const f = await fixture();
    await f.db
      .prepare(
        "INSERT INTO match_timer_starts_canonical VALUES ('unknown','unknown-host','unknown-guest',1,1,0)",
      )
      .run();
    await unchangedFailure();
  });

  it("rejects an actual completion that retained its authorized deletion context", async () => {
    await fixture({ staleContext: true });
    expect(
      await raw
        .prepare(
          "SELECT COUNT(*) AS count FROM timer_storage_handoff_delete_context",
        )
        .first<number>("count"),
    ).toBe(1);
    expect(
      await raw
        .prepare("SELECT phase FROM timer_storage_handoffs")
        .first<string>("phase"),
    ).toBe("local");
    await unchangedFailure();
  });

  it.each([
    "column",
    "index",
    "trigger",
    "view",
    "partial-fences",
    "missing-table",
  ])("rejects an unreviewed %s schema change", async (kind) => {
    await fixture();
    if (kind === "column")
      await raw
        .prepare(
          "ALTER TABLE match_timer_starts_canonical ADD COLUMN extra TEXT",
        )
        .run();
    if (kind === "index")
      await raw
        .prepare("DROP INDEX idx_match_timer_starts_canonical_updated")
        .run();
    if (kind === "trigger")
      await raw
        .prepare(
          "CREATE TRIGGER unreviewed_timer_trigger AFTER UPDATE ON match_timer_starts_canonical BEGIN SELECT 1; END",
        )
        .run();
    if (kind === "view")
      await raw
        .prepare(
          "CREATE VIEW unreviewed_timer_view AS SELECT * FROM match_timer_starts_canonical",
        )
        .run();
    if (kind === "partial-fences")
      await raw
        .prepare(
          applicationWriteFenceSql("match_timer_starts_canonical").match(
            /CREATE TRIGGER[\s\S]*?END;/g,
          )![0]!,
        )
        .run();
    if (kind === "missing-table")
      await raw
        .prepare("DROP TABLE timer_storage_handoff_delete_context")
        .run();
    await unchangedFailure();
  });

  it("rolls back both drops if the containing D1 batch later fails", async () => {
    await fixture({ fences: true });
    const beforeSchema = await schema(),
      beforeRows = await contents();
    await expect(
      applyRetirement(["SELECT json('forced-retirement-rollback')"]),
    ).rejects.toThrow();
    expect(await schema()).toEqual(beforeSchema);
    expect(await contents()).toEqual(beforeRows);
  });
});
