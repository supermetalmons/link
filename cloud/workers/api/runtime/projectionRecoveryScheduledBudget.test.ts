import { applyCanonicalTestMigrations } from "./canonicalTestMigrations.ts";
import { canonicalAutomatchFixture } from "../test/automatchRecordFixture.ts";
import { canonicalQueuePayloadFixture } from "../test/canonicalQueueFixture.ts";
import { eventDocumentFixture } from "../test/eventCompatibilityFixture.ts";
import {
  canonicalRatingFixture,
  canonicalRatingInsert,
} from "./canonicalRatingFixture.ts";
import { runApplicationOperation } from "../src/applicationExecution.ts";
import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { handleScheduled } from "../src/workerHandler.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";
import { seedCombinedCronAuth } from "./combinedCronAuthFixture.ts";
import {
  assertCombinedCronEventProgress,
  createCombinedCronWorkflowRecorder,
  seedCombinedCronEventProgress,
} from "./combinedCronEventProgressFixture.ts";
import { seedCombinedCronTransitions } from "./combinedCronTransitionFixture.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_AUTH_STATE_D1_MIGRATIONS: D1Migration[];
  TEST_TELEGRAM_D1_MIGRATIONS: D1Migration[];
};
const nowMs = 1_800_000_000_000;
const pageStreamSize = 21;
const eventTelegramStreamSize = 101;

function observeDatabase(db: D1Database, onCall: () => void) {
  const executions: { queries: string[]; session: boolean }[] = [];
  const sessions: (D1SessionConstraint | D1SessionBookmark | undefined)[] = [];
  const originals = new WeakMap<
    D1PreparedStatement,
    { statement: D1PreparedStatement; query: string }
  >();
  let failedCalls = 0;
  const execute = async <T>(
    queries: string[],
    session: boolean,
    work: () => T | Promise<T>,
  ): Promise<T> => {
    executions.push({ queries, session });
    try {
      onCall();
      return await work();
    } catch (error) {
      failedCalls++;
      throw error;
    }
  };
  const statement = (
    value: D1PreparedStatement,
    query: string,
    session: boolean,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(value, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            statement(target.bind(...values), query, session);
        const method = Reflect.get(target, property, target);
        if (typeof method !== "function") return method;
        if (["all", "first", "raw", "run"].includes(String(property)))
          return (...args: unknown[]) =>
            execute([query], session, () =>
              Reflect.apply(method, target, args),
            );
        return method.bind(target);
      },
    });
    originals.set(wrapped, { statement: value, query });
    return wrapped;
  };
  const database = <T extends D1Database | D1DatabaseSession>(
    value: T,
    session = false,
  ): T =>
    new Proxy(value, {
      get(target, property) {
        if (property === "prepare")
          return (query: string) =>
            statement(target.prepare(query), query, session);
        if (property === "batch")
          return (statements: D1PreparedStatement[]) => {
            const prepared = statements.map((item) => {
              const original = originals.get(item);
              if (!original) throw new Error("unobserved-scheduled-statement");
              return original;
            });
            return execute(
              prepared.map(({ query }) => query),
              session,
              () => target.batch(prepared.map(({ statement }) => statement)),
            );
          };
        if (property === "withSession" && "withSession" in target)
          return (constraint?: D1SessionConstraint | D1SessionBookmark) => {
            sessions.push(constraint);
            return database(target.withSession(constraint), true);
          };
        if (property === "exec")
          return () => {
            throw new Error("unexpected-scheduled-exec");
          };
        const member = Reflect.get(target, property, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  return {
    database: database(db),
    executions,
    sessions,
    summary: () => ({
      bindingCalls: executions.length,
      sqlStatements: executions.reduce(
        (count, call) => count + call.queries.length,
        0,
      ),
      failedCalls,
    }),
  };
}

function recordQueue(onCall: () => void, allowIndividualSends = false) {
  const batches: unknown[][] = [];
  const messages: { body: unknown; options: QueueSendOptions | undefined }[] =
    [];
  const queue: Queue = {
    metrics: async () => {
      onCall();
      return { backlogCount: 0, backlogBytes: 0 };
    },
    send: async (body, options) => {
      if (!allowIndividualSends)
        throw new Error("unexpected-scheduled-individual-send");
      onCall();
      messages.push({ body: canonicalQueuePayloadFixture(body), options });
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    async sendBatch(messages) {
      onCall();
      batches.push(
        Array.from(messages, ({ body }) => canonicalQueuePayloadFixture(body)),
      );
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  };
  return { queue, batches, messages };
}

function observeInviteRooms(
  namespace: Env["INVITE_REACTIONS"],
  onCall: () => void,
): Env["INVITE_REACTIONS"] {
  const wrap = <T extends object>(stub: T): T =>
    new Proxy(stub, {
      get(target, property) {
        const member = Reflect.get(target, property, target);
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          onCall();
          return Reflect.apply(member, target, args);
        };
      },
    });
  return new Proxy(namespace, {
    get(target, property) {
      if (property === "getByName")
        return (...args: Parameters<typeof target.getByName>) =>
          wrap(target.getByName(...args));
      if (property === "get")
        return (...args: Parameters<typeof target.get>) =>
          wrap(target.get(...args));
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

async function writeBatches(db: D1Database, statements: D1PreparedStatement[]) {
  for (let index = 0; index < statements.length; index += 100)
    await db.batch(statements.slice(index, index + 100));
}

function ids(prefix: string, count = pageStreamSize): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index).padStart(3, "0")}`,
  );
}

async function seedAutomatch() {
  const db = testEnv.PROFILE_GAMES_DB;
  const statements = [
    db.prepare(
      "UPDATE automatch_runtime_control SET backend = 'd1', state = 'active', epoch = 1 WHERE singleton = 1",
    ),
    db.prepare(
      "UPDATE invite_source_control SET backend = 'd1', state = 'active', epoch = 1, verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1",
    ),
  ];
  for (const family of ["profile", "telegram"] as const) {
    for (const inviteId of ids(`automatch-${family}`)) {
      const raw = {
        schemaVersion: 1,
        status: "pending",
        requestId: `request-${inviteId}`,
        ...(family === "telegram"
          ? { updatedAtMs: 100 }
          : {
              sourceUpdatedAtMs: 100,
              lastQueuedAtMs: 100,
              reason: "automatch-queue",
            }),
      };
      const table =
        family === "telegram"
          ? "automatch_telegram_projection_outbox_canonical"
          : "game_session_projection_outbox_canonical";
      const value = canonicalAutomatchFixture(
        family === "telegram"
          ? "telegramProjectionOutbox/automatch"
          : "profileGameProjectionOutbox/automatch",
        raw,
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO ${table} (record_key, payload_json, revision, updated_at_ms) VALUES (?, ?, 1, 100)`,
          )
          .bind(inviteId, JSON.stringify(value)),
      );
    }
  }
  for (const id of ids("cleanup", 10)) {
    statements.push(
      db
        .prepare(
          "INSERT INTO game_session_mutation_locks (lock_id, owner_id, operation_id, expires_at_ms, writer_generation, writer_owner_id) VALUES (?, 'owner', 'operation', 100, 2, 'owner')",
        )
        .bind(id),
      db
        .prepare(
          "INSERT INTO profile_game_projection_locks (scope, resource_id, owner_id, expires_at_ms) VALUES ('invite', ?, 'owner', 100)",
        )
        .bind(id),
      db
        .prepare(
          "INSERT INTO game_session_mutation_receipts_canonical (record_key, payload_json, revision, expiration_json, expiration_revision, updated_at_ms) VALUES (?, ?, 1, ?, 1, 100)",
        )
        .bind(
          id,
          JSON.stringify(
            canonicalAutomatchFixture("gameplayMutationReceipts", {
              kind: "invite-create",
              inviteId: id,
              completedAtMs: 100,
            }),
          ),
          JSON.stringify({ schemaVersion: 1, completedAtMs: 100 }),
        ),
    );
  }
  await writeBatches(db, statements);
}

async function seedProfiles() {
  const db = testEnv.PROFILE_DB;
  const statements = ids("profile-link").map((loginUid) =>
    db
      .prepare(
        `INSERT INTO profile_link_catchup_jobs_canonical
     (login_uid, request_id, profile_id, cleanup_profile_ids_json, source_updated_at_ms, last_queued_at_ms, revision)
     VALUES (?, ?, 'profile', '[]', 100, 100, 1)`,
      )
      .bind(loginUid, `request-${loginUid}`),
  );
  for (const family of ["profile", "telegram"] as const) {
    for (const inviteId of ids(`rating-${family}`)) {
      const value = canonicalRatingFixture(inviteId, {
        matchId: inviteId,
        profileState: family === "profile" ? "pending" : "done",
        telegramState: family === "telegram" ? "pending" : "done",
        eventState: "done",
      });
      statements.push(
        canonicalRatingInsert(db, {
          ...value,
          profileGameProjectionUpdatedAtMs: 100,
          telegramProjectionUpdatedAtMs: 100,
          eventProgressUpdatedAtMs: 100,
        }),
      );
    }
  }
  await writeBatches(db, statements);
}

async function seedEvents() {
  const db = testEnv.EVENT_DB;
  const statements: D1PreparedStatement[] = [];
  for (const family of ["profile", "telegram"] as const) {
    for (const eventId of ids(
      `event-${family}`,
      family === "telegram" ? eventTelegramStreamSize : pageStreamSize,
    )) {
      const requestId = `request-${eventId}`;
      statements.push(
        db
          .prepare(
            "INSERT INTO event_records_canonical (event_id, status, start_at_ms, updated_at_ms, revision, record_json) VALUES (?, 'ended', 1, 2, 1, ?)",
          )
          .bind(
            eventId,
            JSON.stringify(
              eventDocumentFixture({
                eventId,
                status: "ended",
                createdAtMs: 1,
                startedAtMs: 1,
                endedAtMs: 2,
                updatedAtMs: 2,
                startAtMs: 1,
              }),
            ),
          ),
      );
      const value = {
        schemaVersion: 1,
        status: "pending",
        requestId,
        ...(family === "profile"
          ? { lastQueuedAtMs: 100, cleanupOwnerProfileIds: {} }
          : { firstQueuedAtMs: 100, updatedAtMs: 100 }),
      };
      statements.push(
        family === "profile"
          ? db
              .prepare(
                "INSERT INTO event_profile_game_projection_outboxes_canonical (event_id, request_id, status, last_queued_at_ms, record_json) VALUES (?, ?, 'pending', 100, ?)",
              )
              .bind(eventId, requestId, JSON.stringify(value))
          : db
              .prepare(
                "INSERT INTO event_telegram_projection_outboxes_canonical (event_id, request_id, status, first_queued_at_ms, updated_at_ms, record_json) VALUES (?, ?, 'pending', 100, 100, ?)",
              )
              .bind(eventId, requestId, JSON.stringify(value)),
      );
    }
  }
  await writeBatches(db, statements);
}

beforeAll(async () => {
  await Promise.all([
    applyStrictMatchStateTestMigrations(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
    ),
    applyRetiredProfileMigrations(
      testEnv.PROFILE_DB,
      testEnv.TEST_PROFILE_D1_MIGRATIONS,
      "a".repeat(64),
    ),
    applyEventTestMigrations(
      testEnv.EVENT_DB,
      testEnv.TEST_EVENT_D1_MIGRATIONS,
    ),
    applyCanonicalTestMigrations(
      testEnv.AUTH_STATE_DB,
      testEnv.TEST_AUTH_STATE_D1_MIGRATIONS,
    ),
    applyCanonicalTestMigrations(
      testEnv.TELEGRAM_DB,
      testEnv.TEST_TELEGRAM_D1_MIGRATIONS,
    ),
  ]);
  for (const binding of [
    "PROFILE_GAMES_DB",
    "PROFILE_DB",
    "EVENT_DB",
    "AUTH_STATE_DB",
    "TELEGRAM_DB",
  ] as const)
    await testEnv[binding]
      .prepare(
        "UPDATE application_data_control SET data_epoch = 1 WHERE singleton = 1",
      )
      .run();
  await testEnv.TELEGRAM_DB.prepare(
    "UPDATE telegram_runtime_control SET storage_mode = 'd1' WHERE singleton = 1",
  ).run();
}, 30_000);

afterEach(() => vi.restoreAllMocks());

it("bounds failed scheduled workflows and announcement-heavy background recovery alongside saturated cron lanes", async () => {
  vi.spyOn(Date, "now").mockReturnValue(nowMs);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await Promise.all([seedAutomatch(), seedProfiles(), seedEvents()]);
  const [authFixture, progressFixture, transitionFixture] = await Promise.all([
    seedCombinedCronAuth(testEnv, nowMs),
    seedCombinedCronEventProgress(testEnv, nowMs),
    runApplicationOperation(testEnv, "scheduled", 1, (admitted) =>
      seedCombinedCronTransitions(admitted, nowMs),
    ),
  ]);
  const calls = { d1: 0, workflow: 0, queue: 0, durableObject: 0 };
  const consume = (kind: keyof typeof calls) => {
    calls[kind]++;
    if (
      Object.values(calls).reduce((total, count) => total + count, 0) > 10_000
    )
      throw new Error("scheduled-subrequest-budget-exhausted");
  };
  const workflows = createCombinedCronWorkflowRecorder(
    progressFixture,
    () => consume("workflow"),
    { scheduledWorkflow: "terminal" },
  );
  const bindings = [
    "PROFILE_GAMES_DB",
    "PROFILE_DB",
    "EVENT_DB",
    "AUTH_STATE_DB",
    "TELEGRAM_DB",
  ] as const;
  const observed = Object.fromEntries(
    bindings.map((binding) => [
      binding,
      observeDatabase(testEnv[binding], () => consume("d1")),
    ]),
  ) as Record<(typeof bindings)[number], ReturnType<typeof observeDatabase>>;
  const profile = recordQueue(() => consume("queue"));
  const event = recordQueue(() => consume("queue"));
  const telegram = recordQueue(() => consume("queue"));
  const auth = recordQueue(() => consume("queue"), true);
  const measuredEnv: Env = {
    ...testEnv,
    ...Object.fromEntries(
      bindings.map((binding) => [binding, observed[binding].database]),
    ),
    PROFILE_GAME_PROJECTION_QUEUE: profile.queue,
    EVENT_PROFILE_GAME_PROJECTION_QUEUE: event.queue,
    TELEGRAM_PROJECTION_QUEUE: telegram.queue,
    AUTH_RECOVERY_QUEUE: auth.queue,
    EVENT_PROGRESS_WORKFLOW: workflows.workflow,
    INVITE_REACTIONS: observeInviteRooms(testEnv.INVITE_REACTIONS, () =>
      consume("durableObject"),
    ),
  };
  await runApplicationOperation(measuredEnv, "scheduled", 1, (admitted) =>
    handleScheduled(
      { scheduledTime: nowMs, cron: "*/5 * * * *", noRetry() {} },
      admitted,
    ),
  );
  const tasks = [
    ...profile.batches.flat(),
    ...event.batches.flat(),
    ...telegram.batches.flat(),
  ] as Array<{ kind: string; inviteId?: string }>;
  const count = (kind: string) =>
    tasks.filter((task) => task.kind === kind).length;
  expect({
    automatchProfile: count("automatch-profile-game-projection"),
    ratingProfile: count("rating-profile-game-projection"),
    profileLink: count("profile-link-profile-game-projection"),
    eventProfile: count("event-profile-game-projection"),
    automatchTelegram: count("automatch-telegram-projection"),
    ratingTelegram: count("rating-telegram-projection"),
    eventTelegram: count("event-telegram-projection"),
  }).toEqual({
    automatchProfile: 20,
    ratingProfile: 20,
    profileLink: 20,
    eventProfile: 20,
    automatchTelegram: 20,
    ratingTelegram: 20,
    eventTelegram: 100,
  });
  expect(tasks).toHaveLength(220);
  expect(new Set(tasks.map((task) => JSON.stringify(task))).size).toBe(
    tasks.length,
  );
  expect(
    tasks.filter((task) => task.inviteId?.startsWith("automatch-malformed-")),
  ).toHaveLength(0);
  expect(auth.batches).toEqual([]);
  expect(auth.messages).toEqual(
    authFixture.expectedTasks.map((body) => ({
      body,
      options: { delaySeconds: authFixture.expectedDelaySeconds },
    })),
  );
  await authFixture.assertAfterScheduled();
  await assertCombinedCronEventProgress(
    testEnv,
    nowMs,
    progressFixture,
    workflows,
  );
  await transitionFixture.assertAfterScheduled();
  const summary = Object.fromEntries(
    bindings.map((binding) => [binding, observed[binding].summary()]),
  );
  const bindingCalls = Object.values(summary).reduce(
    (sum, value) => sum + value.bindingCalls,
    0,
  );
  const sqlStatements = Object.values(summary).reduce(
    (sum, value) => sum + value.sqlStatements,
    0,
  );
  const writeFences = Object.values(observed)
    .flatMap(({ executions }) => executions)
    .filter(({ queries }) =>
      queries.some((query) =>
        /^\s*INSERT INTO application_write_context\b/.test(query),
      ),
    );
  for (const { queries } of writeFences) {
    expect(queries[0]).toMatch(/^\s*INSERT INTO application_write_context\b/);
    expect(queries.at(-1)).toMatch(
      /^\s*DELETE FROM application_write_context\b/,
    );
    expect(
      queries.filter((query) =>
        /^\s*(?:INSERT INTO|DELETE FROM) application_write_context\b/.test(
          query,
        ),
      ),
    ).toHaveLength(2);
  }
  expect(
    Object.values(summary).every(({ failedCalls }) => failedCalls === 0),
    JSON.stringify(summary),
  ).toBe(true);
  expect(bindingCalls, JSON.stringify(summary)).toBeLessThan(6_000);
  expect(
    sqlStatements - writeFences.length * 2,
    JSON.stringify(summary),
  ).toBeLessThan(14_000);
  expect(calls.d1).toBe(bindingCalls);
  expect(calls.workflow).toBe(workflows.operations.length);
  expect(calls.queue).toBe(
    profile.batches.length +
      event.batches.length +
      telegram.batches.length +
      auth.messages.length,
  );
  expect(calls.durableObject).toBeGreaterThanOrEqual(10);
  expect(
    Object.values(calls).reduce((total, count) => total + count, 0),
    JSON.stringify(calls),
  ).toBeLessThan(9_500);
  expect(sqlStatements).toBeGreaterThan(bindingCalls);
  const pageQueries = Object.values(observed)
    .flatMap(({ executions }) => executions.flatMap(({ queries }) => queries))
    .filter((query) => query.includes("AS recovery_scan_identity"));
  for (const [source, expected] of [
    ["FROM automatch_telegram_projection_outbox", 2],
    ["FROM game_session_projection_outbox_canonical", 3],
    ["FROM profile_link_catchup_jobs", 2],
    ["rating.profile_game_projection_state = 'pending'", 2],
    ["rating.telegram_projection_state = 'pending'", 2],
    ["rating.event_progress_state = 'pending'", 1],
    ["FROM event_profile_game_projection_outboxes", 2],
    ["FROM event_telegram_projection_outboxes", 1],
  ] as const) {
    expect(
      pageQueries.filter((query) => query.includes(source)),
      source,
    ).toHaveLength(expected);
  }
  expect(observed.PROFILE_GAMES_DB.sessions.length).toBeGreaterThan(0);
  expect(
    observed.PROFILE_GAMES_DB.executions.some(
      ({ session, queries }) => session && queries.length > 1,
    ),
  ).toBe(true);
  expect(
    errors.mock.calls.filter(([value]) =>
      String(value).includes('"event":"scheduled_task_failed"'),
    ),
  ).toEqual([]);
  for (const table of [
    "game_session_mutation_locks",
    "profile_game_projection_locks",
    "automatch_write_admissions",
    "invite_source_write_admissions",
  ]) {
    expect(
      await testEnv.PROFILE_GAMES_DB.prepare(
        `SELECT COUNT(*) AS count FROM ${table}`,
      ).first("count"),
      table,
    ).toBe(0);
  }
  expect(
    await testEnv.PROFILE_GAMES_DB.prepare(
      "SELECT COUNT(*) AS count FROM game_session_mutation_receipts_canonical WHERE record_key LIKE 'cleanup-%' AND payload_json IS NOT NULL",
    ).first("count"),
  ).toBe(0);
  expect(
    await testEnv.EVENT_DB.prepare(
      "SELECT COUNT(*) AS count FROM event_write_admissions",
    ).first("count"),
  ).toBe(0);
  const remainders = [
    {
      db: testEnv.PROFILE_GAMES_DB,
      query:
        "SELECT json_extract(payload_json, '$.lastQueuedAtMs') AS timestamp FROM game_session_projection_outbox_canonical WHERE record_key = 'automatch-profile-020'",
      expected: 100,
    },
    {
      db: testEnv.PROFILE_GAMES_DB,
      query:
        "SELECT json_extract(payload_json, '$.updatedAtMs') AS timestamp FROM automatch_telegram_projection_outbox_canonical WHERE record_key = 'automatch-telegram-020'",
      expected: 100,
    },
    {
      db: testEnv.PROFILE_DB,
      query:
        "SELECT last_queued_at_ms AS timestamp FROM profile_link_catchup_jobs_canonical WHERE login_uid = 'profile-link-020'",
      expected: 100,
    },
    {
      db: testEnv.PROFILE_DB,
      query:
        "SELECT profile_game_projection_updated_at_ms AS timestamp FROM rating_updates_canonical WHERE operation_id = 'rating-profile-020__rating-profile-020'",
      expected: 100,
    },
    {
      db: testEnv.PROFILE_DB,
      query:
        "SELECT telegram_projection_updated_at_ms AS timestamp FROM rating_updates_canonical WHERE operation_id = 'rating-telegram-020__rating-telegram-020'",
      expected: 100,
    },
    {
      db: testEnv.EVENT_DB,
      query:
        "SELECT last_queued_at_ms AS timestamp FROM event_profile_game_projection_outboxes_canonical WHERE event_id = 'event-profile-020'",
      expected: 100,
    },
    {
      db: testEnv.EVENT_DB,
      query:
        "SELECT updated_at_ms AS timestamp FROM event_telegram_projection_outboxes_canonical WHERE event_id = 'event-telegram-100'",
      expected: 100,
    },
  ];
  await Promise.all(
    remainders.map(async ({ db, query, expected }) => {
      expect(await db.prepare(query).first("timestamp"), query).toBe(expected);
    }),
  );
}, 120_000);
