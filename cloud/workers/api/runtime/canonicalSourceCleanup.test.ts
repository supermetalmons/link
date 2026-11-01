import { env } from "cloudflare:workers";
import { preTimerRetirementTestMigrations } from "./canonicalTestMigrations.ts";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";
import { applicationWriteFenceSql } from "../src/applicationDataControl.ts";
import { fenceApplicationDatabase } from "../src/applicationD1.ts";
import { createWagerStateD1Store } from "../src/wagerStateD1.ts";
import { createStoredPlayerProfile } from "../src/profileCanonical/contracts.ts";
import { createDefaultProfileAppearance } from "@mons/shared/appearance";
import {
  commitCanonicalPlan,
  materializeCanonicalProfile,
  readCanonicalProfile,
} from "../src/profileCanonicalD1.ts";
import { createAuthStateRepository } from "../src/authStateD1.ts";
import { eventDocumentFixture } from "../test/eventCompatibilityFixture.ts";
import {
  acquireEventWriteAdmission,
  commitEventMutations,
  readEvent,
  releaseEventWriteAdmission,
} from "../src/eventD1.ts";
import { createD1EventPrizeWithdrawalStorage } from "../src/eventPrizeWithdrawalD1.ts";
import { canonicalWithdrawalFixture } from "../test/canonicalWithdrawalFixture.ts";
import { getEventPrizeDefinitions } from "@mons/shared/event-prizes";
import { createD1TelegramRepository } from "../src/telegramD1.ts";
import { buildTelegramSendDesired } from "../../../runtime/telegram/deliveryEngine.js";
import {
  messageDocument,
  updateTelegramMessage,
} from "../../../runtime/telegram/records.js";

const migrationEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
  TEST_AUTH_STATE_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS: D1Migration[];
  TEST_TELEGRAM_D1_MIGRATIONS: D1Migration[];
};
const SOURCE_TABLES = {
  PROFILE_GAMES_DB: [
    "automatch_entries",
    "automatch_live_tickets",
    "automatch_pending_enqueues",
    "automatch_telegram_projection_outbox",
    "automatch_telegram_projection_outbox_recovery3",
    "automatch_telegram_sources",
    "game_session_mutation_receipts",
    "game_session_projection_outbox",
    "game_session_projection_outbox_recovery3",
    "game_session_transition_resources",
    "game_session_transitions",
    "historical_match_pairs",
    "invite_sources",
    "login_match_discovery",
    "match_presentation_registrations",
    "match_presentation_source_exceptions",
    "match_state_legacy_claims",
    "match_state_legacy_records",
    "match_state_routes",
    "match_timer_starts",
    "profile_game_projections",
  ],
  PROFILE_DB: [
    "invite_wager_states",
    "legacy_rating_completions",
    "profile_auth_methods",
    "profile_auth_operations",
    "profile_auth_recovery_jobs",
    "profile_auth_recovery_jobs_recovery3",
    "profile_auth_recovery_quarantine",
    "profile_auth_recovery_quarantine_recovery3",
    "profile_february_opponents",
    "profile_link_catchup_jobs",
    "profile_link_catchup_jobs_recovery3",
    "profile_link_catchup_quarantine",
    "profile_link_catchup_quarantine_recovery3",
    "profile_login_owners",
    "profile_merge_targets",
    "profile_records",
    "rating_projection_recovery_quarantine",
    "rating_updates",
    "wager_frozen_balances",
    "wager_frozen_operations",
    "wager_settlements",
  ],
  AUTH_STATE_DB: ["auth_intents", "x_redirect_flows"],
  EVENT_DB: [
    "event_prize_selections",
    "event_profile_game_projection_outboxes",
    "event_profile_game_projection_outboxes_recovery3",
    "event_progress_outboxes",
    "event_progress_outboxes_recovery3",
    "event_records",
    "event_telegram_projection_outboxes",
    "event_telegram_projection_outboxes_recovery3",
    "event_telegram_projection_state",
    "event_transition_intents",
    "profile_event_prize_revisions",
    "profile_event_prizes",
  ],
  EVENT_PRIZE_WITHDRAWALS_DB: ["event_prize_withdrawals"],
  TELEGRAM_DB: [
    "telegram_delivery_control",
    "telegram_event_prize_announcements",
    "telegram_messages",
  ],
} as const;

type Binding = keyof typeof SOURCE_TABLES;
type SchemaRow = {
  name: string;
  tbl_name: string;
  type: string;
  sql: string | null;
};
type CleanupFixture = {
  binding: Binding;
  migrations: D1Migration[];
  initialize?: (db: D1Database, migrations: D1Migration[]) => Promise<void>;
  seed: (db: D1Database) => Promise<() => Promise<void>>;
};

function identifier(value: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value))
    throw new Error("invalid-fixture-table");
  return `"${value}"`;
}

async function run(db: D1Database, sql: string, ...values: unknown[]) {
  return db
    .prepare(sql)
    .bind(...values)
    .run();
}

async function schema(db: D1Database) {
  return (
    await db
      .prepare(
        "SELECT name, tbl_name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name != 'd1_migrations' ORDER BY type, name",
      )
      .all<SchemaRow>()
  ).results;
}

async function retainedContents(db: D1Database, excluded: ReadonlySet<string>) {
  const result: Record<string, string[]> = {};
  for (const table of (await schema(db)).filter(
    (row) => row.type === "table" && !excluded.has(row.name),
  ))
    result[table.name] = (
      await db.prepare(`SELECT * FROM ${identifier(table.name)}`).all()
    ).results
      .map((row) => JSON.stringify(row))
      .sort();
  return result;
}

async function seedEvidence(db: D1Database) {
  await run(
    db,
    "INSERT INTO application_retired_executions VALUES ('rating', 'preserved-execution', 'preserved-business', 0, 'preserved-migration', ?, ?, 10, 'blocked', 'outcome-uncertain')",
    "a".repeat(64),
    "b".repeat(64),
  );
  await run(
    db,
    "INSERT INTO application_migration_selection VALUES ('preserved-migration', 3, 1, ?, 10)",
    "c".repeat(64),
  );
}

async function installApplicationFences(db: D1Database) {
  const objects = await schema(db);
  const names = new Set(objects.map((row) => row.name));
  const statements: D1PreparedStatement[] = [];
  for (const table of objects.filter(
    (row) => row.type === "table" && !row.name.startsWith("application_"),
  )) {
    const fences = applicationWriteFenceSql(table.name).match(
      /CREATE TRIGGER[\s\S]*?END;/g,
    );
    if (!fences || fences.length !== 3)
      throw new Error("invalid-fixture-fence");
    for (const fence of fences) {
      const name = /^CREATE TRIGGER "([a-z0-9_]+)"/.exec(fence)?.[1];
      if (!name) throw new Error("invalid-fixture-fence");
      if (!names.has(name)) statements.push(db.prepare(fence));
    }
  }
  if (statements.length) await db.batch(statements);
}

async function seedGameplay(db: D1Database) {
  await db.batch([
    db.prepare(
      "INSERT INTO invite_sources VALUES ('source-invite', '{\"preserved\":true}', 1, 1)",
    ),
    db.prepare(
      "INSERT INTO game_session_transitions VALUES ('source-transition', 'source-invite', '{}', 'pending', 1, 1, 0, NULL)",
    ),
    db.prepare(
      "INSERT INTO game_session_transition_resources VALUES ('source-resource', 'source-transition')",
    ),
    db.prepare(
      "INSERT INTO game_session_projection_outbox_recovery3(record_key,payload_json,revision,updated_at_ms) VALUES ('source-recovery', '{}', 1, 1)",
    ),
    db.prepare(
      "INSERT INTO match_state_routes_canonical VALUES ('host', 'live-match', 'durable', 'live-invite', 2)",
    ),
    db.prepare(
      "INSERT INTO match_state_routes_canonical VALUES ('guest', 'live-match', 'durable', 'live-invite', 2)",
    ),
  ]);
  await run(
    db,
    "INSERT INTO match_timer_starts_canonical VALUES ('live-match','host','guest',2,100,10)",
  );
  return async () => {
    expect(
      await db
        .prepare(
          "SELECT * FROM match_timer_starts_canonical WHERE match_id = 'live-match'",
        )
        .all(),
    ).toMatchObject({
      results: [
        {
          match_id: "live-match",
          player_id: "host",
          opponent_id: "guest",
          turn_number: 2,
          deadline_at_ms: 100,
          updated_at_ms: 10,
        },
      ],
    });
    await run(
      db,
      "INSERT INTO game_session_mutation_locks(lock_id,owner_id,operation_id,expires_at_ms,writer_generation,writer_owner_id) VALUES ('post-cleanup-lock','post-cleanup-owner','post-cleanup-operation',100,2,'post-cleanup-owner')",
    );
    expect(
      await db
        .prepare(
          "SELECT operation_id FROM game_session_mutation_locks WHERE lock_id = 'post-cleanup-lock'",
        )
        .first("operation_id"),
    ).toBe("post-cleanup-operation");
    await expect(
      run(
        db,
        "INSERT INTO automatch_admission_cancellations(admission_table,admission_id,operation_id,original_row_json,original_row_digest,controls_json,plan_digest,source_audit_digest,historical_review_digest,revoked_at_ms,outcome,historical_outcome) VALUES ('invite_source_write_admissions','new-admission','00000000-0000-4000-8000-000000000000','{\"admission_id\":\"new-admission\",\"backend\":\"d1\",\"kind\":\"session-receipt-expiry\",\"created_at_ms\":1}',?,'{}',?,?,?,10,'write-authority-revoked','unknown-preserved')",
        ...Array<string>(4).fill("a".repeat(64)),
      ),
    ).rejects.toThrow("cancellation-source-generation-retired");
  };
}

async function seedProfile(db: D1Database) {
  await db.batch([
    db.prepare(
      "INSERT INTO profile_records(profile_id,state,payload_json,created_at_ms,updated_at_ms,rating_sort_present,mana_points_sort_present,nonce_sort_present,dust_sort_present,slime_sort_present,gum_sort_present,metal_sort_present,ice_sort_present,win_present,emoji_present) VALUES ('source-profile','active','{}',1,1,0,0,0,0,0,0,0,0,0,0)",
    ),
    db.prepare(
      "INSERT INTO profile_login_owners(login_uid,profile_id,created_at_ms,updated_at_ms) VALUES ('source-login','source-profile',1,1)",
    ),
    db.prepare(
      "INSERT INTO profile_auth_recovery_jobs_recovery3(profile_id,login_uids_json,source_profile_ids_json,source_phase,phase_started_at_ms,last_enqueued_at_ms,created_at_ms,updated_at_ms) VALUES ('source-profile','[]','[]','prizes',1,1,1,1)",
    ),
    db.prepare(
      "INSERT INTO profile_auth_recovery_quarantine_recovery3 VALUES ('source-profile','source-revision','invalid-record',1)",
    ),
    db.prepare(
      "INSERT INTO invite_wager_states VALUES ('source-invite','source-match','{}',NULL,1,1)",
    ),
  ]);
  const profileId = "canonical-profile";
  await commitCanonicalPlan(db, {
    expectations: [
      { kind: "profile-absent", profileId },
      { kind: "login-owner-absent", loginUid: "canonical-login" },
    ],
    mutations: [
      {
        kind: "insert-active-profile",
        value: materializeCanonicalProfile({
          profile: createStoredPlayerProfile(
            profileId,
            createDefaultProfileAppearance(0),
          ),
          createdAtMs: 10,
          updatedAtMs: 10,
        }),
      },
      {
        kind: "insert-login-owner",
        value: {
          loginUid: "canonical-login",
          profileId,
          createdAtMs: 10,
          updatedAtMs: 10,
        },
      },
    ],
  });
  const store = createWagerStateD1Store(db, {
    writeGuards: () => [],
    now: () => 20,
  });
  const key = { inviteId: "canonical-invite", matchId: "canonical-match" };
  const current = await store.read(key);
  await store.commit([
    { current, value: { wager: null, resolutionMarker: false } },
  ]);
  return async () => {
    expect(await readCanonicalProfile(db, profileId)).not.toBeNull();
    const previous = await store.read(key);
    expect(
      await store.commit([
        { current: previous, value: { wager: null, resolutionMarker: true } },
      ]),
    ).toBe(true);
    expect(await store.read(key)).toMatchObject({
      resolutionMarker: true,
      revision: 2,
    });
    await expect(
      run(
        db,
        "UPDATE wager_state_activation SET activation_epoch = 0 WHERE singleton = 1",
      ),
    ).rejects.toThrow();
    await expect(
      run(db, "DELETE FROM wager_state_activation WHERE singleton = 1"),
    ).rejects.toThrow();
  };
}

async function seedAuth(db: D1Database) {
  await db.batch([
    db.prepare(
      "INSERT INTO auth_intents(intent_id,uid,method,nonce,state,created_at_ms,expires_at_ms) VALUES ('source-intent','source-login','x','nonce','state',1,100)",
    ),
    db.prepare(
      "INSERT INTO x_redirect_flows(flow_id,intent_id,uid,method,callback_uri,code_challenge,code_verifier,consent_source,return_url,status,created_at_ms,expires_at_ms,updated_at_ms) VALUES ('source-flow','source-intent','source-login','x','https://api.mons.link/auth/x/callback','challenge','verifier','signin','https://mons.link/','created',1,100,1)",
    ),
    db
      .prepare(
        "INSERT INTO anonymous_sessions VALUES ('00000000-0000-4000-8000-000000000000', ?, ?, ?, 1, NULL)",
      )
      .bind("a".repeat(28), "b".repeat(64), "c".repeat(64)),
    db
      .prepare(
        "INSERT INTO anonymous_sessions VALUES ('00000000-0000-4000-8000-000000000001', NULL, NULL, ?, 1, 2)",
      )
      .bind("d".repeat(64)),
  ]);
  const repository = createAuthStateRepository(db);
  const intent = {
    intentId: "canonical-intent",
    uid: "canonical-login",
    method: "x" as const,
    nonce: "nonce",
    state: "state",
    createdAtMs: 10,
    expiresAtMs: 100,
    consumedAtMs: null,
  };
  await repository.createAuthIntent(intent);
  await repository.createXFlow({
    flowId: "canonical-flow",
    intentId: intent.intentId,
    uid: intent.uid,
    method: "x",
    callbackUri: "https://api.mons.link/auth/x/callback",
    codeChallenge: "challenge",
    codeVerifier: "verifier",
    consentSource: "signin",
    returnUrl: "https://mons.link/",
    status: "created",
    createdAtMs: 10,
    updatedAtMs: 10,
    expiresAtMs: 100,
    xUserId: null,
    xUsername: null,
    errorCode: null,
  });
  return async () => {
    expect(
      await repository.consumeAuthIntent({
        intentId: intent.intentId,
        method: "x",
        uid: intent.uid,
        consumedAtMs: 20,
        consumedByOpId: "operation",
      }),
    ).toBe(true);
    expect(await repository.getAuthIntent(intent.intentId)).toMatchObject({
      status: "consumed",
      consumedAtMs: 20,
    });
    expect(await repository.getXFlow("canonical-flow")).toMatchObject({
      intentId: intent.intentId,
      status: "created",
    });
  };
}

async function seedEvents(db: D1Database) {
  await db.batch([
    db.prepare(
      "INSERT INTO event_records(event_id,status,start_at_ms,updated_at_ms,record_json) VALUES ('source-event','scheduled',1,1,'{}')",
    ),
    db.prepare(
      "INSERT INTO event_prize_selections VALUES ('source-event','source-profile','source-prize',1)",
    ),
    db.prepare(
      "INSERT INTO event_profile_game_projection_outboxes_recovery3 VALUES ('source-event','source-request','pending',1,'{}')",
    ),
  ]);
  const event = eventDocumentFixture({ eventId: "canonical-event" });
  const admission = await acquireEventWriteAdmission(db);
  try {
    await commitEventMutations(
      db,
      [{ kind: "event", eventId: event.eventId, value: event }],
      { admission },
    );
  } finally {
    await releaseEventWriteAdmission(db, admission);
  }
  await run(
    db,
    "INSERT INTO event_prize_selections_canonical VALUES ('canonical-event','canonical-profile','canonical-prize',1)",
  );
  return async () => {
    const nextAdmission = await acquireEventWriteAdmission(db);
    try {
      await commitEventMutations(
        db,
        [
          {
            kind: "event-field",
            eventId: event.eventId,
            field: "winnerProfileId",
            value: null,
          },
        ],
        { admission: nextAdmission },
      );
    } finally {
      await releaseEventWriteAdmission(db, nextAdmission);
    }
    expect(await readEvent(db, event.eventId)).toEqual(event);
  };
}

async function seedWithdrawals(db: D1Database) {
  await run(
    db,
    "UPDATE event_prize_withdrawal_runtime_control SET storage_mode = 'd1', previous_storage_mode = NULL WHERE singleton = 1",
  );
  await run(
    db,
    'INSERT INTO event_prize_withdrawals VALUES (\'source-event\',\'source-prize\',\'{"status":"submitted","transactionSignature":"source-signature"}\',1,1)',
  );
  const storage = createD1EventPrizeWithdrawalStorage(db);
  const blocked = canonicalWithdrawalFixture({
    status: "blocked",
    leaseId: null,
    leaseExpiresAtMs: null,
    blockReason: "canonical-data-cutover",
    blockedAtMs: 20,
    updatedAtMs: 20,
    sourceDigest: "d".repeat(64),
    transactionSignature: "uncertain-signature",
    signedTransactionBase64: "AQID",
    blockhash: "11111111111111111111111111111111",
    lastValidBlockHeight: 123,
    submittedAtMs: 15,
  });
  await storage
    .record(blocked.eventId, blocked.prizeId)
    .transaction(() => ({ value: blocked, decision: "seed" }));
  return async () => {
    expect(await storage.get(blocked.eventId, blocked.prizeId)).toEqual(
      blocked,
    );
    const prize = getEventPrizeDefinitions(blocked.eventId).find(
      (entry) => entry.id !== blocked.prizeId,
    )!;
    const processing = canonicalWithdrawalFixture({
      eventId: blocked.eventId,
      prizeId: prize.id,
    });
    await storage
      .record(processing.eventId, processing.prizeId)
      .transaction(() => ({ value: processing, decision: "claim" }));
    expect(await storage.get(processing.eventId, processing.prizeId)).toEqual(
      processing,
    );
  };
}

async function seedTelegram(db: D1Database) {
  await run(
    db,
    "INSERT INTO telegram_messages VALUES ('source-message','{\"uncertain\":true}',1,1)",
  );
  const repository = createD1TelegramRepository(db, { now: () => 20 });
  const desired = (revision: string) =>
    buildTelegramSendDesired({
      destination: "community",
      instanceKey: "canonical-message",
      text: "preserved delivery",
      sourceRevision: revision,
    });
  await repository.transactMessage("canonical-message", (current) => ({
    value: updateTelegramMessage(messageDocument(current), {
      desired: desired("one"),
    }),
    decision: "seed",
  }));
  return async () => {
    await repository.transactMessage("canonical-message", (current) => ({
      value: updateTelegramMessage(messageDocument(current), {
        desired: desired("two"),
      }),
      decision: "update",
    }));
    expect((await repository.getMessage("canonical-message"))?.desired).toEqual(
      desired("two"),
    );
  };
}

const fixtures: CleanupFixture[] = [
  {
    binding: "PROFILE_GAMES_DB",
    migrations: preTimerRetirementTestMigrations(
      migrationEnv.TEST_D1_MIGRATIONS,
    ),
    initialize: applyStrictMatchStateTestMigrations,
    seed: seedGameplay,
  },
  {
    binding: "PROFILE_DB",
    migrations: migrationEnv.TEST_PROFILE_D1_MIGRATIONS,
    initialize: (db, migrations) =>
      applyRetiredProfileMigrations(db, migrations, "a".repeat(64)),
    seed: seedProfile,
  },
  {
    binding: "AUTH_STATE_DB",
    migrations: migrationEnv.TEST_AUTH_STATE_D1_MIGRATIONS,
    seed: seedAuth,
  },
  {
    binding: "EVENT_DB",
    migrations: migrationEnv.TEST_EVENT_D1_MIGRATIONS,
    initialize: applyEventTestMigrations,
    seed: seedEvents,
  },
  {
    binding: "EVENT_PRIZE_WITHDRAWALS_DB",
    migrations: migrationEnv.TEST_EVENT_PRIZE_WITHDRAWAL_D1_MIGRATIONS,
    seed: seedWithdrawals,
  },
  {
    binding: "TELEGRAM_DB",
    migrations: migrationEnv.TEST_TELEGRAM_D1_MIGRATIONS,
    seed: seedTelegram,
  },
];

describe("physical canonical source cleanup", () => {
  it("has an exact sixty-table cold-source scope", () => {
    expect(
      Object.values(SOURCE_TABLES).reduce(
        (sum, tables) => sum + tables.length,
        0,
      ),
    ).toBe(60);
    expect(
      Object.values(SOURCE_TABLES)
        .flat()
        .some(
          (name) =>
            name.endsWith("_canonical") || name.startsWith("application_"),
        ),
    ).toBe(false);
  });

  for (const fixture of fixtures)
    it(`${fixture.binding} preserves all surviving bytes and current operations while removing nonempty source dependencies`, async () => {
      const db = env[fixture.binding];
      const cleanup = fixture.migrations.filter((migration) =>
        migration.name.endsWith("_retire_canonical_source_tables.sql"),
      );
      expect(cleanup).toHaveLength(1);
      const historical = fixture.migrations.slice(
        0,
        fixture.migrations.indexOf(cleanup[0]!),
      );
      await (fixture.initialize ?? applyD1Migrations)(db, historical);
      await run(
        db,
        "UPDATE application_data_control SET generation = 3, data_epoch = 1 WHERE singleton = 1",
      );
      const businessDb = fenceApplicationDatabase(db, {
        kind: "business",
        generation: 3,
        dataEpoch: 1,
        operationId: `cleanup-rehearsal-${fixture.binding}`,
      });
      const verifyCurrentOperations = await fixture.seed(businessDb);
      await seedEvidence(db);
      await installApplicationFences(db);
      const removed = new Set<string>(SOURCE_TABLES[fixture.binding]);
      const beforeSchema = await schema(db);
      expect(
        beforeSchema.filter(
          (row) => row.type === "table" && removed.has(row.name),
        ),
      ).toHaveLength(removed.size);
      await run(
        db,
        "UPDATE application_data_control SET phase = 'closing', migration_id = 'cleanup-rehearsal' WHERE singleton = 1",
      );
      await expect(applyD1Migrations(db, cleanup)).rejects.toThrow();
      expect(await schema(db)).toEqual(beforeSchema);
      await run(
        db,
        "UPDATE application_data_control SET phase = 'active', migration_id = NULL WHERE singleton = 1",
      );
      const before = await retainedContents(db, removed);
      await applyD1Migrations(db, cleanup);
      const afterSchema = await schema(db);
      expect(afterSchema.some((row) => removed.has(row.name))).toBe(false);
      const replaced = new Set([
        "automatch_cancellation_source_guard",
        "wager_state_activation_verified",
      ]);
      const retiredViews = new Set([
        "automatch_ready_tickets",
        "automatch_expected_pending_enqueues",
        "automatch_expected_live_tickets",
      ]);
      expect(afterSchema.filter((row) => !replaced.has(row.name))).toEqual(
        beforeSchema.filter(
          (row) =>
            !removed.has(row.tbl_name) &&
            !removed.has(row.name) &&
            !replaced.has(row.name) &&
            !retiredViews.has(row.name),
        ),
      );
      expect(await retainedContents(db, removed)).toEqual(before);
      expect(
        (await db.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
      for (const row of afterSchema)
        for (const name of removed)
          expect(
            new RegExp(`\\b${name}\\b`).test(row.sql ?? ""),
            `${row.name} still depends on ${name}`,
          ).toBe(false);
      await applyD1Migrations(db, cleanup);
      expect(await retainedContents(db, removed)).toEqual(before);
      await expect(
        run(
          db,
          "DELETE FROM application_retired_executions WHERE execution_id = 'preserved-execution'",
        ),
      ).rejects.toThrow("retired-execution-immutable");
      await verifyCurrentOperations();
      expect(
        (await db.prepare("PRAGMA foreign_key_check").all()).results,
      ).toEqual([]);
    });
});
