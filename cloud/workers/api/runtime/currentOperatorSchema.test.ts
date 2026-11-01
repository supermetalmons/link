import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { applyCanonicalTestMigrations } from "./canonicalTestMigrations.ts";
import { manageMatchState } from "../../../../scripts/manage-match-state.ts";
import { inspectState } from "../../../../scripts/inspect-state.ts";
import { createSqlDependencies as automatchDependencies } from "../../../../scripts/manage-automatch-state.ts";
import { readPendingTransitionRows } from "../../../../scripts/manage-events.ts";
import {
  readRemoteSnapshot,
  summarize,
} from "../../../../scripts/manage-event-prize-withdrawals.ts";
import { createProfileD1Reader, parseD1Rows } from "../../../admin/_d1.ts";
import type { SqlRunner } from "../../../../scripts/operator/runtime.ts";
import {
  OperatorMaintenanceFailure,
  runGuardedOperatorMaintenance,
  type MaintenanceTransport,
} from "../../../../scripts/operator/guardedMaintenance.ts";
import { parseAutomatchRecord } from "../../../runtime/automatchRecords.js";
import {
  applicationWriteBatch,
  applicationWriteFenceSql,
} from "../src/applicationDataControl.ts";
import { createDefaultProfileAppearance } from "@mons/shared/appearance";
import { createStoredPlayerProfile } from "../src/profileCanonical/contracts.ts";
import {
  commitCanonicalPlan,
  materializeCanonicalProfile,
} from "../src/profileCanonicalD1.ts";
import { createEmptyWager } from "../src/wagerModel.ts";
import { eventDocumentFixture } from "../test/eventCompatibilityFixture.ts";
import { eventIntentFixture } from "../test/transitionIntentFixture.ts";
import { matchDocumentFixture } from "../test/matchRecordFixture.ts";
import { canonicalWithdrawalFixture } from "../test/canonicalWithdrawalFixture.ts";
import {
  acquireEventWriteAdmission,
  releaseEventWriteAdmission,
  commitEventMutations,
  createEventTransitionIntent,
} from "../src/eventD1.ts";

const migrationEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS: D1Migration[];
  TEST_TELEGRAM_D1_MIGRATIONS: D1Migration[];
};
const queries: string[] = [];
const version = "11111111-1111-4111-8111-111111111111";
const address = `0x${"1".repeat(40)}`;
const automatch = parseAutomatchRecord("automatch", {
  schemaVersion: 1,
  uid: "operator-host",
  profileId: null,
  timestamp: 10,
  rating: 1500,
  hostColor: "white",
  password: "fixture",
  gameVariant: "Classic",
  telegramDeliveryVersion: null,
  username: "",
  ethAddress: "",
  solAddress: "",
  emojiId: 7,
});
const withdrawal = canonicalWithdrawalFixture({ status: "submitted" });
const databases: Record<string, D1Database> = {
  "mons-link-profile-games": env.PROFILE_GAMES_DB,
  "mons-link-profiles": env.PROFILE_DB,
  "mons-link-events": env.EVENT_DB,
  "mons-link-telegram": env.TELEGRAM_DB,
  "mons-link-event-prize-withdrawals": env.EVENT_PRIZE_WITHDRAWALS_DB,
};
const run: SqlRunner = async (
  sql,
  database = "mons-link-profiles",
  values = [],
) => {
  expect(sql.trimStart()).toMatch(/^SELECT\b/);
  queries.push(sql);
  const binding = databases[database];
  if (!binding) throw new Error("unexpected-operator-database");
  return (
    await binding
      .prepare(sql)
      .bind(...values)
      .all<Record<string, unknown>>()
  ).results;
};

function maintenanceTransport(): MaintenanceTransport {
  const targets = {
    PROFILE_GAMES_DB: env.PROFILE_GAMES_DB,
    PROFILE_DB: env.PROFILE_DB,
    EVENT_DB: env.EVENT_DB,
    EVENT_PRIZE_WITHDRAWALS_DB: env.EVENT_PRIZE_WITHDRAWALS_DB,
  };
  return {
    async readControl() {
      return (
        await env.PROFILE_GAMES_DB.prepare(
          "SELECT singleton, generation, data_epoch, phase, migration_id FROM application_data_control WHERE singleton = 1",
        ).all()
      ).results;
    },
    async atomicBatch(binding, statements) {
      const database = targets[binding];
      return database.batch<Record<string, unknown>>(
        statements.map(({ sql, bindings }) =>
          database.prepare(sql).bind(...bindings),
        ),
      );
    },
  };
}

const maintenanceInput = () => ({
  transport: maintenanceTransport(),
  binding: "EVENT_DB" as const,
  generation: 3,
  dataEpoch: 1 as const,
  statements: [
    {
      sql: "UPDATE event_runtime_control SET updated_at_ms = updated_at_ms + ? WHERE singleton = 1",
      bindings: [1],
    },
  ],
});

async function maintenanceState() {
  return {
    control: await env.EVENT_DB.prepare(
      "SELECT * FROM event_runtime_control WHERE singleton = 1",
    ).first<Record<string, unknown>>(),
    contexts: (
      await env.EVENT_DB.prepare(
        "SELECT * FROM application_write_context",
      ).all()
    ).results,
    admissions: (
      await env.PROFILE_GAMES_DB.prepare(
        "SELECT * FROM application_data_admissions",
      ).all<Record<string, unknown>>()
    ).results,
  };
}

async function absent(db: D1Database, tables: string[]) {
  const placeholders = tables.map(() => "?").join(",");
  expect(
    (
      await db
        .prepare(
          `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (${placeholders})`,
        )
        .bind(...tables)
        .all()
    ).results,
  ).toEqual([]);
}

beforeAll(async () => {
  await applyStrictMatchStateTestMigrations(
    env.PROFILE_GAMES_DB,
    migrationEnv.TEST_D1_MIGRATIONS,
  );
  await applyRetiredProfileMigrations(
    env.PROFILE_DB,
    migrationEnv.TEST_PROFILE_D1_MIGRATIONS,
    "a".repeat(64),
  );
  await applyEventTestMigrations(
    env.EVENT_DB,
    migrationEnv.TEST_EVENT_D1_MIGRATIONS,
  );
  await applyCanonicalTestMigrations(
    env.EVENT_PRIZE_WITHDRAWALS_DB,
    migrationEnv.TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS,
  );
  await applyCanonicalTestMigrations(
    env.TELEGRAM_DB,
    migrationEnv.TEST_TELEGRAM_D1_MIGRATIONS,
  );
  await env.PROFILE_GAMES_DB.batch([
    env.PROFILE_GAMES_DB.prepare(
      "INSERT INTO match_state_routes_canonical VALUES ('operator-host','operator-match','durable','operator-invite',2)",
    ),
    env.PROFILE_GAMES_DB.prepare(
      "INSERT INTO match_state_routes_canonical VALUES ('operator-guest','operator-match','durable','operator-invite',2)",
    ),
    env.PROFILE_GAMES_DB.prepare(
      "INSERT INTO login_match_discovery_canonical VALUES ('operator-host','operator-match','operator-match','operator-invite','resolved','capture',10)",
    ),
    env.PROFILE_GAMES_DB.prepare(
      "INSERT INTO match_presentation_registrations_canonical VALUES ('operator-invite','operator-match','operator-host',?,'creation','operator-source',10)",
    ).bind("a".repeat(64)),
    env.PROFILE_GAMES_DB.prepare(
      "INSERT INTO match_presentation_source_exceptions_canonical VALUES ('operator-migration','operator-invite','operator-match','historical-actor','archive',?,?,?, ?,NULL,NULL,?,10)",
    ).bind(
      "a".repeat(64),
      "b".repeat(64),
      JSON.stringify(matchDocumentFixture({})),
      JSON.stringify({
        schemaVersion: 1,
        disposition: "archive",
        sourceDigest: "b".repeat(64),
        ownership: [],
        profileId: "operator-profile",
        reason: "no-canonical-owner",
      }),
      "c".repeat(64),
    ),
    env.PROFILE_GAMES_DB.prepare(
      "INSERT INTO automatch_entries_canonical VALUES ('operator-entry',?,1,10)",
    ).bind(JSON.stringify(automatch)),
  ]);
  const profile = createStoredPlayerProfile(
    "operator-profile",
    createDefaultProfileAppearance(7),
    { nonce: 8, totalManaPoints: 11, username: "operator", eth: address },
  );
  await commitCanonicalPlan(env.PROFILE_DB, {
    expectations: [{ kind: "profile-absent", profileId: profile.id }],
    mutations: [
      {
        kind: "insert-active-profile",
        value: materializeCanonicalProfile({
          profile,
          createdAtMs: 10,
          updatedAtMs: 10,
        }),
      },
    ],
  });
  await env.PROFILE_DB.batch([
    env.PROFILE_DB.prepare(
      "INSERT INTO profile_auth_methods_canonical(method,normalized_value,profile_id,raw_value,created_at_ms,updated_at_ms) VALUES ('eth',?,'operator-profile',?,10,10)",
    ).bind(address, address),
    env.PROFILE_DB.prepare(
      "INSERT INTO invite_wager_states_canonical VALUES ('operator-invite','operator-match',?,0,2,10)",
    ).bind(JSON.stringify(createEmptyWager())),
    env.PROFILE_DB.prepare(
      "INSERT INTO invite_wager_states_canonical VALUES ('operator-invite','another-match',NULL,1,3,10)",
    ),
  ]);
  const event = eventDocumentFixture({ eventId: "operator-event" });
  const admission = await acquireEventWriteAdmission(env.EVENT_DB);
  try {
    await commitEventMutations(
      env.EVENT_DB,
      [{ kind: "event", eventId: event.eventId, value: event }],
      { admission },
    );
    await createEventTransitionIntent(
      env.EVENT_DB,
      eventIntentFixture({
        schemaVersion: 3,
        transitionId: "operator-transition",
        eventId: event.eventId,
        expectedRevision: 1,
        canonicalUpdates: { [`events/${event.eventId}/updatedAtMs`]: 20 },
        effects: {},
        createdAtMs: 10,
        updatedAtMs: 20,
      }),
      { admission },
    );
  } finally {
    await releaseEventWriteAdmission(env.EVENT_DB, admission);
  }
  await env.EVENT_DB.prepare(
    "UPDATE event_transition_intents_canonical SET attempts=4,last_error='retry-needed' WHERE transition_id='operator-transition'",
  ).run();
  await env.EVENT_PRIZE_WITHDRAWALS_DB.prepare(
    "INSERT INTO event_prize_withdrawals_canonical VALUES (?,?,?,1,?)",
  )
    .bind(
      withdrawal.eventId,
      withdrawal.prizeId,
      JSON.stringify(withdrawal),
      withdrawal.updatedAtMs,
    )
    .run();
  for (const [database, table] of [
    [env.PROFILE_GAMES_DB, "automatch_runtime_control"],
    [env.PROFILE_GAMES_DB, "automatch_write_admissions"],
    [env.PROFILE_GAMES_DB, "invite_source_write_admissions"],
    [env.PROFILE_DB, "profile_canonical_control"],
    [env.PROFILE_DB, "wager_reservation_runtime_control"],
    [env.PROFILE_DB, "wager_reservation_write_admissions"],
    [env.EVENT_DB, "event_runtime_control"],
    [env.EVENT_DB, "event_write_admissions"],
    [env.EVENT_PRIZE_WITHDRAWALS_DB, "event_prize_withdrawal_runtime_control"],
  ] as const) {
    const statements = applicationWriteFenceSql(table).match(
      /CREATE TRIGGER[\s\S]*?END;/g,
    );
    if (!statements || statements.length !== 3)
      throw new Error("invalid-fixture-fences");
    await database.batch(statements.map((sql) => database.prepare(sql)));
  }
});

describe("retained operators on the canonical schema after cold cleanup", () => {
  afterEach(async () => {
    await env.EVENT_DB.prepare("DELETE FROM application_write_context").run();
    await env.EVENT_DB.prepare(
      "UPDATE application_data_control SET data_epoch = 1, phase = 'active', migration_id = NULL WHERE singleton = 1",
    ).run();
    await env.PROFILE_GAMES_DB.prepare(
      "DELETE FROM application_data_admissions",
    ).run();
    await env.PROFILE_GAMES_DB.prepare(
      "UPDATE application_data_control SET phase = 'active', migration_id = NULL WHERE singleton = 1",
    ).run();
  });
  it("reads real canonical counts without any cold-table fallback", async () => {
    await absent(env.PROFILE_GAMES_DB, [
      "game_session_transitions",
      "game_session_transition_resources",
      "match_state_routes",
      "login_match_discovery",
      "match_presentation_registrations",
      "match_presentation_source_exceptions",
    ]);
    if (
      migrationEnv.TEST_D1_MIGRATIONS.some(({ name }) =>
        name.startsWith("0039_"),
      )
    )
      await absent(env.PROFILE_GAMES_DB, [
        "match_timer_starts_canonical",
        "timer_storage_handoff_delete_context",
      ]);
    await absent(env.EVENT_DB, ["event_transition_intents"]);
    await absent(env.PROFILE_DB, [
      "invite_wager_states",
      "profile_records",
      "profile_auth_methods",
    ]);
    const logs: Record<string, unknown>[] = [];
    await manageMatchState(
      { operation: "status" },
      { run, now: () => 1000, log: (value) => logs.push(value) },
    );
    expect(logs[0]?.counts).toMatchObject({
      routes: 2,
      event_intents: 1,
      session_intents: 0,
      session_resources: 0,
    });
    for (const domain of [
      "match-discovery",
      "match-presentations",
      "wagers",
      "event-receipts",
    ] as const) {
      const output: Record<string, unknown>[] = [];
      await inspectState(
        { domain },
        {
          run,
          log: (value) => output.push(value),
          receiptProvider: {
            deployment: async () => version,
            workflowPage: async () => ({
              rows: [],
              totalCount: 0,
              totalPages: 1,
            }),
          },
        },
      );
      if (domain === "match-discovery")
        expect(output[0]?.counts).toEqual([
          { provenance: "capture", resolution: "resolved", count: 1 },
        ]);
      if (domain === "match-presentations") {
        expect(output[0]?.counts).toEqual([
          { provenance: "creation", count: 1 },
        ]);
        expect(output[0]?.sourceExceptions).toEqual([
          { disposition: "archive", count: 1 },
        ]);
      }
      if (domain === "wagers")
        expect(output[0]?.current).toEqual({
          rowCount: 2,
          wagerCount: 1,
          markerCount: 2,
        });
      if (domain === "event-receipts")
        expect(output[0]?.maintenance).toMatchObject({ intents: 1 });
    }
  });

  it("reads pending event recovery attempts from the canonical intent table", async () => {
    let sql = "";
    readPendingTransitionRows((statement) => {
      sql = statement;
      return [];
    });
    const rows = (
      await env.EVENT_DB.prepare(sql).all<Record<string, unknown>>()
    ).results;
    const pending = readPendingTransitionRows((statement) => {
      expect(statement).toBe(sql);
      return rows;
    });
    expect(pending).toEqual([
      {
        transitionId: "operator-transition",
        eventId: "operator-event",
        expectedRevision: 1,
        attempts: 4,
        lastError: "retry-needed",
        createdAtMs: 10,
        updatedAtMs: 20,
        applicationLeaseExpiresAtMs: null,
      },
    ]);
  });

  it("reads exact canonical admission target values and nullable absent targets", async () => {
    const deps = automatchDependencies(run, {
      assertDeployment: async () => undefined,
    });
    const admission = {
      admissionId: "admission",
      backend: "d1" as const,
      epoch: 2,
      freezeGeneration: 0,
      kind: "owned-patch",
      createdAtMs: 10,
      phase: "prepared" as const,
      proofJson: null,
      auditRevision: 0,
      updatedAtMs: 0,
      completedAtMs: null,
    };
    expect(
      await deps.readAdmissionPath(admission, "automatch/operator-entry"),
    ).toEqual(automatch);
    for (const root of [
      "telegramAutomatches",
      "telegramProjectionOutbox/automatch",
      "profileGameProjectionOutbox/automatch",
      "gameplayMutationReceipts",
      "gameplayMutationReceiptExpirations",
    ])
      expect(
        await deps.readAdmissionPath(admission, `${root}/absent`),
      ).toBeNull();
  });

  it("admin exports and leaderboards use canonical typed scalar columns", async () => {
    const reader = createProfileD1Reader({
      query: async (sql, parameters = []) =>
        parseD1Rows(
          (
            await env.PROFILE_DB.prepare(sql)
              .bind(...parameters)
              .all()
          ).results,
        ),
    });
    expect(await reader.listAddresses()).toEqual([
      { method: "eth", value: address },
    ]);
    expect(await reader.readLeaderboard("gp", 5)).toMatchObject([
      { id: "operator-profile", emoji: 7, nonce: 8 },
    ]);
    expect(await reader.readLeaderboard("mp", 5)).toMatchObject([
      { id: "operator-profile", emoji: 7, totalManaPoints: 11 },
    ]);
  });

  it("withdrawal diagnostics preserve canonical submitted transaction data and reject epoch zero", async () => {
    await absent(env.EVENT_PRIZE_WITHDRAWALS_DB, ["event_prize_withdrawals"]);
    let sql = "";
    readRemoteSnapshot(1, (args) => {
      sql = args[1]!;
      return [];
    });
    const rows = (
      await env.EVENT_PRIZE_WITHDRAWALS_DB.prepare(sql).all<
        Record<string, unknown>
      >()
    ).results;
    const snapshot = readRemoteSnapshot(1, (args) => {
      expect(args[1]).toBe(sql);
      return rows;
    });
    expect(snapshot[withdrawal.eventId]?.[withdrawal.prizeId]).toEqual(
      withdrawal,
    );
    expect(summarize(snapshot, 30)).toMatchObject({
      records: 1,
      statuses: { submitted: 1 },
      activeLeases: 1,
    });
    expect(() =>
      readRemoteSnapshot(0 as never, () => {
        throw new Error("unexpected-query");
      }),
    ).toThrow("invalid-withdrawal-data-epoch");
  });
  it("preserves application fences and demonstrates the existing guarded batch interface without changing policy", async () => {
    const db = env.EVENT_DB;
    const before = await db
      .prepare("SELECT * FROM event_runtime_control WHERE singleton=1")
      .first();
    const statement = () =>
      db.prepare(
        "UPDATE event_runtime_control SET updated_at_ms=updated_at_ms WHERE singleton=1",
      );
    await expect(statement().run()).rejects.toThrow("application-write-fenced");
    const context = {
      kind: "business" as const,
      generation: 3,
      dataEpoch: 1 as const,
      operationId: "operator-transport-fixture",
    };
    await db.batch(applicationWriteBatch(db, context, [statement()]));
    expect(
      await db
        .prepare("SELECT * FROM event_runtime_control WHERE singleton=1")
        .first(),
    ).toEqual(before);
    await expect(
      db.batch(
        applicationWriteBatch(db, { ...context, dataEpoch: 0 }, [statement()]),
      ),
    ).rejects.toThrow("application-write-fenced");
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM application_write_context")
        .first("count"),
    ).toBe(0);
  });

  it("guarded operator maintenance completes its real admission and removes only its own context", async () => {
    const before = await maintenanceState();
    const result = await runGuardedOperatorMaintenance(maintenanceInput());
    expect(result).toHaveLength(1);
    expect(result[0]?.meta.changes).toBe(1);
    expect(await maintenanceState()).toEqual({
      control: {
        ...before.control,
        updated_at_ms: Number(before.control?.updated_at_ms) + 1,
      },
      contexts: [],
      admissions: [],
    });
  });

  it("a failed maintenance statement rolls back earlier statements and the owned context while retaining a blocked admission", async () => {
    const before = await maintenanceState();
    const input = maintenanceInput();
    input.statements.push({
      sql: "UPDATE event_runtime_control SET freeze_generation = ? WHERE singleton = 1",
      bindings: [-1],
    });
    const failure = await runGuardedOperatorMaintenance(input).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(OperatorMaintenanceFailure);
    expect(failure).toMatchObject({
      stage: "mutation",
      admissionBlocked: true,
    });
    const after = await maintenanceState();
    expect(after.control).toEqual(before.control);
    expect(after.contexts).toEqual([]);
    expect(after.admissions).toMatchObject([
      {
        operation_id: (failure as OperatorMaintenanceFailure).operationId,
        generation: 3,
        data_epoch: 1,
        kind: "rpc",
        status: "blocked",
        failure_code: "operator-maintenance-unconfirmed",
        parent_operation_id: null,
      },
    ]);
  });

  it("an occupied context rejects maintenance without replacing or deleting the existing context", async () => {
    await env.EVENT_DB.prepare(
      "INSERT INTO application_write_context VALUES (1, 3, 1, 'existing-operation', NULL)",
    ).run();
    const before = await maintenanceState();
    await expect(
      runGuardedOperatorMaintenance(maintenanceInput()),
    ).rejects.toMatchObject({ stage: "mutation", admissionBlocked: true });
    const after = await maintenanceState();
    expect(after.control).toEqual(before.control);
    expect(after.contexts).toEqual(before.contexts);
  });

  it("a different target epoch remains fenced and rolls back the context", async () => {
    const before = await maintenanceState();
    await env.EVENT_DB.prepare(
      "UPDATE application_data_control SET data_epoch = 0 WHERE singleton = 1",
    ).run();
    await expect(
      runGuardedOperatorMaintenance(maintenanceInput()),
    ).rejects.toMatchObject({ stage: "mutation", admissionBlocked: true });
    const after = await maintenanceState();
    expect(after.control).toEqual(before.control);
    expect(after.contexts).toEqual([]);
  });

  it("closing central admission control rejects a new operator mutation", async () => {
    const before = await maintenanceState();
    await env.PROFILE_GAMES_DB.prepare(
      "UPDATE application_data_control SET phase = 'closing', migration_id = 'operator-fixture' WHERE singleton = 1",
    ).run();
    await expect(
      runGuardedOperatorMaintenance(maintenanceInput()),
    ).rejects.toThrow("operator-maintenance-control-mismatch");
    expect(await maintenanceState()).toEqual(before);
  });

  it("a lost mutation response is never retried and keeps the real admission blocked", async () => {
    const before = await maintenanceState();
    const input = maintenanceInput();
    const native = input.transport.atomicBatch;
    let targetCalls = 0;
    input.transport.atomicBatch = async (binding, statements) => {
      const result = await native(binding, statements);
      if (binding === "EVENT_DB") {
        targetCalls++;
        throw new Error("lost-response");
      }
      return result;
    };
    await expect(runGuardedOperatorMaintenance(input)).rejects.toMatchObject({
      stage: "mutation",
      admissionBlocked: true,
    });
    const after = await maintenanceState();
    expect(targetCalls).toBe(1);
    expect(after.control).toEqual({
      ...before.control,
      updated_at_ms: Number(before.control?.updated_at_ms) + 1,
    });
    expect(after.contexts).toEqual([]);
    expect(after.admissions).toMatchObject([{ status: "blocked" }]);
  });

  it("an uncertain admission response stops before the target and preserves the admission identity", async () => {
    const input = maintenanceInput();
    const native = input.transport.atomicBatch;
    let calls = 0;
    input.transport.atomicBatch = async (binding, statements) => {
      calls++;
      await native(binding, statements);
      throw new Error("lost-response");
    };
    const failure = await runGuardedOperatorMaintenance(input).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      stage: "admission",
      admissionBlocked: false,
    });
    expect(calls).toBe(1);
    const state = await maintenanceState();
    expect(state.contexts).toEqual([]);
    expect(state.admissions).toMatchObject([
      {
        operation_id: (failure as OperatorMaintenanceFailure).operationId,
        status: "running",
      },
    ]);
  });
});
