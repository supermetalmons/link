import { applyCanonicalTestMigrations } from "./canonicalTestMigrations.ts";
import { inviteDocumentFixture } from "../test/inviteDocumentFixture.ts";
import {
  matchTestPort,
  legacySessionClient,
} from "../test/gameSessionTestPorts.ts";
import { createLegacyInviteSourceD1Store as createInviteSourceD1Store } from "../test/legacyInviteSourceFixture.ts";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  acquireInviteSourceAdmission,
  createInviteSourceD1Store as createProductionInviteSourceD1Store,
  inviteSourceAdmissionGuardStatements,
  isInviteSourceRevisionConflict,
  normalizeInviteSource,
  readInviteSourceControl,
  releaseInviteSourceAdmission,
} from "../src/inviteSourceD1.ts";
import { createAutomatchPersistenceCompatibility as createAutomatchPersistence } from "../src/automatchPersistence.ts";
import { isAutomatchRevisionConflict } from "../src/automatchD1.ts";
import { classifyD1Failure } from "../src/d1Failure.ts";
import { observeD1FailureDatabase } from "./d1FailureTestUtils.ts";
import type { StateRepository } from "../test/stateRepositoryTestTypes.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const raw: StateRepository = {
  async getPath() {
    throw new Error("unexpected-source-read");
  },
  async patchRoot() {
    throw new Error("unexpected-source-write");
  },
  async transactPath() {
    throw new Error("unexpected-source-write");
  },
};

function interceptAdmissions(
  intercept: (
    query: string,
    bindings: unknown[],
    primary: boolean,
    execute: () => Promise<unknown>,
  ) => Promise<unknown>,
): D1Database {
  const nativeStatements = new WeakMap<object, D1PreparedStatement>();
  const statementQueries = new WeakMap<
    object,
    { query: string; bindings: unknown[]; primary: boolean }
  >();
  const wrapStatement = (
    statement: D1PreparedStatement,
    query: string,
    primary: boolean,
    bindings: unknown[] = [],
  ): D1PreparedStatement => {
    if (!query.includes("invite_source_write_admissions")) return statement;
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            wrapStatement(target.bind(...values), query, primary, values);
        if (property === "first" || property === "run")
          return (...args: unknown[]) =>
            intercept(query, bindings, primary, () =>
              Reflect.apply(
                Reflect.get(target, property, target),
                target,
                args,
              ),
            );
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    nativeStatements.set(wrapped, statement);
    statementQueries.set(wrapped, { query, bindings, primary });
    return wrapped;
  };
  const wrapDatabase = <T extends D1Database | D1DatabaseSession>(
    database: T,
    primary = false,
  ): T =>
    new Proxy(database, {
      get(target, property) {
        if (property === "prepare")
          return (query: string) =>
            wrapStatement(target.prepare(query), query, primary);
        if (property === "batch")
          return (statements: D1PreparedStatement[]) => {
            const execute = () =>
              target.batch(
                statements.map(
                  (statement) => nativeStatements.get(statement) ?? statement,
                ),
              );
            const observed = statements
              .map((statement) => statementQueries.get(statement))
              .find(
                (entry) =>
                  entry &&
                  /^(INSERT INTO|DELETE FROM) invite_source_write_admissions|^SELECT[\s\S]*FROM invite_source_write_admissions/.test(
                    entry.query.trimStart(),
                  ),
              );
            return observed
              ? intercept(
                  observed.query,
                  observed.bindings,
                  observed.primary,
                  execute,
                )
              : execute();
          };
        if (property === "withSession")
          return (constraint?: D1SessionConstraint | D1SessionBookmark) =>
            wrapDatabase(
              db.withSession(constraint),
              constraint === "first-primary",
            );
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return wrapDatabase(db);
}

async function admissionRows() {
  return (
    await db
      .prepare(
        "SELECT * FROM invite_source_write_admissions ORDER BY admission_id",
      )
      .all()
  ).results;
}

async function activate() {
  await db
    .prepare(
      `UPDATE invite_source_control SET backend = 'd1', epoch = 1,
    verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1`,
    )
    .run();
}

const admissionControlSources = ["read", "supplied"] as const;

async function admissionOptions(
  controlSource: (typeof admissionControlSources)[number],
) {
  return {
    now: () => 10,
    ...(controlSource === "supplied"
      ? { expectedControl: await readInviteSourceControl(db) }
      : {}),
  };
}

function observePreparationReads(
  afterBatch?: (results: D1Result<Record<string, unknown>>[]) => void,
) {
  const sessions: (D1SessionConstraint | D1SessionBookmark | undefined)[] = [];
  const queries: string[] = [];
  const batches: number[] = [];
  const database = new Proxy(db, {
    get(target, property) {
      if (property === "prepare" || property === "batch")
        return () => {
          throw new Error("unexpected-unscoped-read");
        };
      if (property === "withSession") {
        return (constraint?: D1SessionConstraint | D1SessionBookmark) => {
          sessions.push(constraint);
          const session = target.withSession(constraint);
          return {
            prepare(query: string) {
              queries.push(query);
              return session.prepare(query);
            },
            async batch(statements: D1PreparedStatement[]) {
              batches.push(statements.length);
              const results =
                await session.batch<Record<string, unknown>>(statements);
              afterBatch?.(results);
              return results;
            },
            getBookmark: session.getBookmark.bind(session),
          };
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    store: createProductionInviteSourceD1Store(database),
    sessions,
    queries,
    batches,
  };
}

describe("canonical invite source", () => {
  beforeAll(() => applyCanonicalTestMigrations(db, testEnv.TEST_D1_MIGRATIONS));
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM invite_source_write_admissions"),
      db.prepare("DELETE FROM invite_sources_canonical"),
      db.prepare("DELETE FROM automatch_write_admissions"),
      db.prepare("DELETE FROM automatch_entries_canonical"),
      db.prepare("DELETE FROM game_session_transition_resources_canonical"),
      db.prepare("DELETE FROM game_session_transitions_canonical"),
      db.prepare(`UPDATE invite_source_control SET backend = 'rtdb', state = 'active',
        epoch = 0, freeze_generation = 0, verified_at_ms = NULL, activated_at_ms = NULL,
        metadata_json = NULL WHERE singleton = 1`),
      db.prepare(
        "UPDATE automatch_runtime_control SET backend = 'd1', state = 'active' WHERE singleton = 1",
      ),
    ]);
  });

  it("preloads control and unique invites in one primary batch while preserving change order", async () => {
    await activate();
    const original = inviteDocumentFixture({
      hostId: "host",
      password: "private",
      sessionTransition: {
        transitionId: "prior-transition",
        sequence: 7,
        digest: "a".repeat(64),
      },
      automatchOperationIds: { host: "first" },
    });
    await db
      .prepare(
        "INSERT INTO invite_sources_canonical VALUES ('z-existing', ?, 4, 1)",
      )
      .bind(JSON.stringify(original))
      .run();
    const created = inviteDocumentFixture({ hostId: "created" });
    const observed = observePreparationReads();
    const prepared = await observed.store.prepareChanges(
      [
        {
          inviteId: "z-existing",
          value: { guestId: "guest" },
          operationIds: { host: "second" },
        },
        { inviteId: "a-missing", value: created },
        {
          inviteId: "z-existing",
          value: { hostRematches: { state: "open", indices: [1, 2] } },
          operationIds: { host: "third", guest: "joined" },
        },
        { inviteId: "a-missing", value: { hostColor: "black" } },
      ],
      345,
    );
    expect(observed.sessions).toEqual(["first-primary"]);
    expect(observed.batches).toEqual([3]);
    expect(observed.queries).toHaveLength(3);
    expect(observed.queries[0]).toContain("FROM invite_source_control");
    expect(
      observed.queries
        .slice(1)
        .every((query) =>
          query.includes("FROM invite_sources_canonical WHERE invite_id = ?"),
        ),
    ).toBe(true);
    expect(prepared).toEqual([
      {
        current: { inviteId: "z-existing", value: original, revision: 4 },
        value: {
          ...original,
          guestId: "guest",
          hostRematches: { state: "open", indices: [1, 2] },
          automatchOperationIds: { host: "third", guest: "joined" },
        },
      },
      {
        current: { inviteId: "a-missing", value: null, revision: 0 },
        value: { ...created, hostColor: "black" },
      },
    ]);
  });

  it.each(["retired", "missing", "invalid activation"])(
    "validates %s control before decoding preloaded records",
    async (control) => {
      await activate();
      const observed = observePreparationReads((results) => {
        if (control === "missing") results[0]!.results = [];
        else if (control === "retired") {
          results[0]!.results[0]!.backend = "rtdb";
          results[0]!.results[0]!.epoch = 0;
        } else results[0]!.results[0]!.verified_at_ms = null;
      });
      await expect(
        observed.store.prepareChanges([{ inviteId: "one", value: {} }], 10),
      ).rejects.toThrow(
        control === "retired"
          ? "invite-source-not-activated"
          : "invite-source-control-unavailable",
      );
      expect(observed.batches).toEqual([2]);
    },
  );

  it.each([
    { name: "retired fields", value: { wagers: {} }, revision: 1 },
    {
      name: "invalid nested keys",
      value: { settings: { "bad/key": true } },
      revision: 1,
    },
    {
      name: "fractional revisions",
      value: inviteDocumentFixture({ hostId: "host" }),
      revision: 1.5,
    },
  ])("rejects preloaded records with $name", async ({ value, revision }) => {
    await activate();
    const observed = observePreparationReads((results) => {
      results[1]!.results = [{ source_json: JSON.stringify(value), revision }];
    });
    await expect(
      observed.store.prepareChanges([{ inviteId: "one", value: {} }], 10),
    ).rejects.toThrow("invite-source-corrupt");
  });

  it("rejects server-value markers and unknown fields before persistence", async () => {
    await activate();
    const observed = observePreparationReads();
    for (const value of [
      { count: { ".sv": { increment: 1 } } },
      { automatchCanceledAt: { ".sv": "timestamp" } },
      { hostRematches: "1;2" },
    ]) {
      await expect(
        Reflect.apply(observed.store.prepareChanges, observed.store, [
          [{ inviteId: "one", value }],
          345,
        ]),
      ).rejects.toThrow(
        /reserved-invite-source-field|invalid-invite-source-json|invalid-invite-rematches/,
      );
    }
  });

  it("does no preparation I/O for empty changes or an already aborted request", async () => {
    const observed = observePreparationReads();
    const reason = new Error("preparation-canceled");
    const signal = AbortSignal.abort(reason);
    expect(await observed.store.prepareChanges([], 1, signal)).toEqual([]);
    await expect(
      observed.store.prepareChanges(
        [{ inviteId: "one", value: {} }],
        1,
        signal,
      ),
    ).rejects.toBe(reason);
    expect(observed.sessions).toEqual([]);
    expect(observed.queries).toEqual([]);
    expect(observed.batches).toEqual([]);
  });

  it("honors cancellation after the batch before validating its results", async () => {
    const controller = new AbortController();
    const reason = new Error("preparation-canceled-after-read");
    const observed = observePreparationReads(() => controller.abort(reason));
    await expect(
      observed.store.prepareChanges(
        [{ inviteId: "one", value: {} }],
        10,
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(observed.sessions).toEqual(["first-primary"]);
    expect(observed.batches).toEqual([2]);
  });

  it("rejects stale preloaded revisions without committing another invite", async () => {
    await activate();
    const store = createProductionInviteSourceD1Store(db);
    const first = await store.prepareChanges(
      [{ inviteId: "one", value: inviteDocumentFixture({ hostId: "first" }) }],
      1,
    );
    const stale = await store.prepareChanges(
      [
        { inviteId: "two", value: inviteDocumentFixture({ hostId: "two" }) },
        { inviteId: "one", value: inviteDocumentFixture({ hostId: "loser" }) },
      ],
      1,
    );
    await db.batch(store.buildCommitStatements(first, 1));
    let failure: unknown;
    try {
      await db.batch(store.buildCommitStatements(stale, 2));
    } catch (error) {
      failure = error;
    }
    expect(isInviteSourceRevisionConflict(failure)).toBe(true);
    expect(classifyD1Failure(failure)).toBe("invite-source-conflict");
    expect(isAutomatchRevisionConflict(failure)).toBe(false);
    expect(await store.read("one")).toEqual({
      inviteId: "one",
      value: inviteDocumentFixture({ hostId: "first" }),
      revision: 1,
    });
    expect(await store.read("two")).toEqual({
      inviteId: "two",
      value: null,
      revision: 0,
    });
  });

  it("permits frozen preparation while fencing a stale write admission", async () => {
    await activate();
    const admission = await acquireInviteSourceAdmission(db, "preparation", {
      now: () => 10,
    });
    const store = createProductionInviteSourceD1Store(db, {
      writeGuards: () => inviteSourceAdmissionGuardStatements(db, admission),
    });
    const prepared = await store.prepareChanges(
      [{ inviteId: "one", value: inviteDocumentFixture({ hostId: "host" }) }],
      10,
    );
    await db
      .prepare(
        "UPDATE invite_source_control SET state = 'frozen', freeze_generation = 1 WHERE singleton = 1",
      )
      .run();
    expect(
      await store.prepareChanges(
        [{ inviteId: "one", value: inviteDocumentFixture({ hostId: "host" }) }],
        10,
      ),
    ).toEqual(prepared);
    const observed = observeD1FailureDatabase(db);
    await expect(
      observed.database.batch(store.buildCommitStatements(prepared, 11)),
    ).rejects.toThrow();
    expect(observed.errors).toHaveLength(1);
    expect(classifyD1Failure(observed.errors[0])).toBe("integrity");
    expect(isInviteSourceRevisionConflict(observed.errors[0])).toBe(false);
    expect((await store.read("one")).value).toBeNull();
    await releaseInviteSourceAdmission(db, admission);
  });

  it("preserves canonical private metadata and rejects retired fields", () => {
    const value = inviteDocumentFixture({
      hostId: "anonymous",
      password: "private",
      hostRematches: { state: "open", indices: [1, 2] },
      sessionTransition: {
        transitionId: "transition",
        sequence: 4,
        digest: "a".repeat(64),
      },
    });
    expect(normalizeInviteSource(value)).toEqual(value);
    for (const patch of [
      { custom: { future: [1, null, true] } },
      { wagers: {} },
      { matchesWagerResolutions: {} },
      { reactions: {} },
    ])
      expect(() => normalizeInviteSource({ ...value, ...patch })).toThrow(
        "invalid-invite-source-json",
      );
    expect(() => normalizeInviteSource(null)).toThrow(
      "invalid-invite-source-json",
    );
  });

  it("rejects a retired source mode and never falls back for missing D1 rows", async () => {
    let sourceReads = 0;
    const raw: StateRepository = {
      async getPath() {
        sourceReads++;
        return { hostId: "stale-source" };
      },
      async patchRoot() {
        throw new Error("unexpected-source-write");
      },
      async transactPath() {
        throw new Error("unexpected-source-write");
      },
    };
    const coordinator = createAutomatchPersistence(db, matchTestPort(raw));
    await expect(
      legacySessionClient(coordinator.rawClient).getPath("invites/one"),
    ).rejects.toThrow("invite-source-backend-retired");
    expect(sourceReads).toBe(0);
    await activate();
    const store = createInviteSourceD1Store(db);
    await db.batch(
      store.buildCommitStatements(
        await store.preparePatch(
          {
            "invites/one": {
              hostId: "canonical",
              password: "secret",
            },
          },
          100,
        ),
        100,
      ),
    );
    expect(
      await legacySessionClient(coordinator.rawClient).getPath(
        "invites/one/hostId",
      ),
    ).toBe("canonical");
    expect(await coordinator.client.readInviteMetadata("one")).toEqual(
      inviteDocumentFixture({ hostId: "canonical", password: "secret" }),
    );
    expect(
      await legacySessionClient(coordinator.rawClient).getPath(
        "invites/missing",
      ),
    ).toBeNull();
    expect(sourceReads).toBe(0);
    await db
      .prepare("DELETE FROM invite_source_control WHERE singleton = 1")
      .run();
    await expect(
      legacySessionClient(coordinator.rawClient).getPath("invites/one"),
    ).rejects.toThrow("invite-source-control-unavailable");
    expect(sourceReads).toBe(0);
    await db
      .prepare(
        `INSERT INTO invite_source_control (singleton, backend, state, epoch, freeze_generation)
      VALUES (1, 'rtdb', 'active', 0, 0)`,
      )
      .run();
  });

  it("merges canonical fields and rematches while preserving transition provenance", async () => {
    await activate();
    const store = createProductionInviteSourceD1Store(db);
    const original = inviteDocumentFixture({
      hostId: "host",
      password: "private",
      hostRematches: { state: "open", indices: [1] },
      sessionTransition: {
        transitionId: "original",
        sequence: 7,
        digest: "a".repeat(64),
      },
      automatchOperationIds: { host: "first" },
    });
    await db
      .prepare("INSERT INTO invite_sources_canonical VALUES ('one', ?, 4, 1)")
      .bind(JSON.stringify(original))
      .run();
    const mutations = await store.prepareChanges(
      [
        { inviteId: "one", value: { guestId: "guest" } },
        {
          inviteId: "one",
          value: { hostRematches: { state: "open", indices: [1, 2] } },
        },
      ],
      345,
    );
    await db.batch(store.buildCommitStatements(mutations, 900));
    const next = await store.prepareChanges(
      [
        {
          inviteId: "one",
          value: { guestRematches: { state: "open", indices: [1] } },
        },
      ],
      1_000,
    );
    await db.batch(store.buildCommitStatements(next, 1_000));
    expect(await store.read("one")).toEqual({
      inviteId: "one",
      revision: 6,
      value: {
        ...original,
        guestId: "guest",
        hostRematches: { state: "open", indices: [1, 2] },
        guestRematches: { state: "open", indices: [1] },
      },
    });
  });

  it("rejects stale revisions without partially committing another invite", async () => {
    await activate();
    const store = createInviteSourceD1Store(db);
    const first = await store.preparePatch(
      { "invites/one": { hostId: "first" } },
      1,
    );
    const stale = await store.preparePatch(
      { "invites/one": { hostId: "loser" }, "invites/two": { hostId: "two" } },
      1,
    );
    await db.batch(store.buildCommitStatements(first, 1));
    let failure: unknown;
    try {
      await db.batch(store.buildCommitStatements(stale, 2));
    } catch (error) {
      failure = error;
    }
    expect(isInviteSourceRevisionConflict(failure)).toBe(true);
    expect((await store.read("one")).value).toEqual(
      inviteDocumentFixture({ hostId: "first" }),
    );
    expect((await store.read("two")).value).toBeNull();
  });

  it("fences stale admissions and permits frozen reads", async () => {
    await activate();
    const admission = await acquireInviteSourceAdmission(db, "test", {
      now: () => 10,
    });
    const store = createInviteSourceD1Store(db, {
      writeGuards: () => inviteSourceAdmissionGuardStatements(db, admission),
    });
    const prepared = await store.preparePatch(
      { "invites/one": { hostId: "host" } },
      10,
    );
    await db
      .prepare(
        "UPDATE invite_source_control SET state = 'frozen', freeze_generation = 1 WHERE singleton = 1",
      )
      .run();
    await expect(
      db.batch(store.buildCommitStatements(prepared, 11)),
    ).rejects.toThrow();
    await expect(acquireInviteSourceAdmission(db, "new")).rejects.toThrow(
      "invite-source-writes-frozen",
    );
    expect((await store.read("one")).value).toBeNull();
    expect((await readInviteSourceControl(db)).state).toBe("frozen");
    await releaseInviteSourceAdmission(db, admission);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM invite_source_write_admissions")
        .first("n"),
    ).toBe(0);
  });

  it("acquires from a validated control snapshot in one database call", async () => {
    await activate();
    const options = await admissionOptions("supplied");
    const queries: string[] = [];
    const database = interceptAdmissions(
      async (query, _bindings, _primary, execute) => {
        queries.push(query);
        return execute();
      },
    );
    const connection = new Proxy(database, {
      get(target, property) {
        if (property === "withSession")
          return () => {
            throw new Error("unexpected-control-read");
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const admission = await acquireInviteSourceAdmission(
      connection,
      "supplied",
      options,
    );
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(
      /^\s*INSERT INTO invite_source_write_admissions/,
    );
    expect(admission).toMatchObject({
      backend: "d1",
      epoch: 1,
      freezeGeneration: 0,
      kind: "supplied",
      createdAtMs: 10,
    });
    await releaseInviteSourceAdmission(db, admission);
    expect(await admissionRows()).toEqual([]);
  });

  it("pins the supplied control tuple before an uncertain insert", async () => {
    await activate();
    const expectedControl = await readInviteSourceControl(db);
    let lostResponse = false;
    const connection = interceptAdmissions(
      async (query, _bindings, _primary, execute) => {
        const result = await execute();
        if (query.trimStart().startsWith("INSERT") && !lostResponse) {
          lostResponse = true;
          expectedControl.backend = "rtdb";
          expectedControl.epoch = 0;
          expectedControl.freezeGeneration = 1;
          throw new Error("lost-insert-response");
        }
        return result;
      },
    );
    const admission = await acquireInviteSourceAdmission(connection, "pinned", {
      expectedControl,
      now: () => 10,
    });
    expect(lostResponse).toBe(true);
    expect(admission).toMatchObject({
      backend: "d1",
      epoch: 1,
      freezeGeneration: 0,
    });
    await releaseInviteSourceAdmission(db, admission);
    expect(await admissionRows()).toEqual([]);
  });

  it.each(["patch", "sweep"])(
    "releases a committed admission after its INSERT response is lost during coordinator %s",
    async (operation) => {
      await activate();
      let lostResponses = 0;
      const connection = interceptAdmissions(
        async (query, _bindings, primary, execute) => {
          if (query.trimStart().startsWith("SELECT"))
            expect(primary).toBe(true);
          const result = await execute();
          if (query.trimStart().startsWith("INSERT") && lostResponses === 0) {
            lostResponses++;
            expect(await admissionRows()).toHaveLength(1);
            throw new Error("lost-insert-response");
          }
          return result;
        },
      );
      const coordinator = createAutomatchPersistence(
        connection,
        matchTestPort(raw),
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        if (operation === "patch") {
          await legacySessionClient(coordinator.rawClient).patchRoot({
            "automatch/one": { uid: "host" },
          });
          expect(
            await legacySessionClient(coordinator.rawClient).getPath(
              "automatch/one",
            ),
          ).toMatchObject({
            uid: "host",
          });
        } else {
          expect(await coordinator.sweep()).toEqual({
            recovered: 0,
            failed: 0,
          });
        }
        expect(await admissionRows()).toEqual([]);
        expect(
          await db
            .prepare("SELECT COUNT(*) AS n FROM automatch_write_admissions")
            .first("n"),
        ).toBe(0);
      }
      expect(lostResponses).toBe(1);
    },
  );

  it.each(admissionControlSources)(
    "retries an INSERT that failed before committing with the same admission ID (%s control)",
    async (controlSource) => {
      await activate();
      const options = await admissionOptions(controlSource);
      const insertedIds: unknown[] = [];
      const connection = interceptAdmissions(
        async (query, bindings, _primary, execute) => {
          if (query.trimStart().startsWith("INSERT")) {
            insertedIds.push(bindings[0]);
            if (insertedIds.length === 1) throw new Error("insert-unavailable");
          }
          return execute();
        },
      );
      const admission = await acquireInviteSourceAdmission(
        connection,
        "retry",
        options,
      );
      expect(insertedIds).toEqual([
        admission.admissionId,
        admission.admissionId,
      ]);
      expect(await admissionRows()).toEqual([
        {
          admission_id: admission.admissionId,
          backend: "d1",
          epoch: 1,
          freeze_generation: 0,
          kind: "retry",
          created_at_ms: 10,
        },
      ]);
      await releaseInviteSourceAdmission(connection, admission);
      expect(await admissionRows()).toEqual([]);
    },
  );

  it.each(admissionControlSources)(
    "recovers one committed admission after its response and first primary readback fail (%s control)",
    async (controlSource) => {
      await activate();
      const options = await admissionOptions(controlSource);
      const insertedIds: unknown[] = [];
      let readbacks = 0;
      const connection = interceptAdmissions(
        async (query, bindings, primary, execute) => {
          if (query.trimStart().startsWith("INSERT")) {
            insertedIds.push(bindings[0]);
            const result = await execute();
            if (insertedIds.length === 1)
              throw new Error("lost-insert-response");
            return result;
          }
          if (query.trimStart().startsWith("SELECT")) {
            expect(primary).toBe(true);
            if (++readbacks === 1) throw new Error("readback-unavailable");
          }
          return execute();
        },
      );
      const admission = await acquireInviteSourceAdmission(
        connection,
        "retry",
        options,
      );
      expect(insertedIds).toEqual([
        admission.admissionId,
        admission.admissionId,
      ]);
      expect(readbacks).toBe(2);
      expect(await admissionRows()).toHaveLength(1);
      await releaseInviteSourceAdmission(connection, admission);
      expect(await admissionRows()).toEqual([]);
    },
  );

  it.each(["before", "after"])(
    "retries a failed release %s DELETE commit without deleting another admission",
    async (failure) => {
      await activate();
      const admission = await acquireInviteSourceAdmission(db, "release", {
        now: () => 10,
      });
      const other = await acquireInviteSourceAdmission(db, "other", {
        now: () => 10,
      });
      let deletes = 0;
      const connection = interceptAdmissions(
        async (query, _bindings, _primary, execute) => {
          if (query.trimStart().startsWith("DELETE") && ++deletes === 1) {
            if (failure === "after") await execute();
            throw new Error("lost-delete-response");
          }
          return execute();
        },
      );
      await releaseInviteSourceAdmission(connection, admission);
      expect(deletes).toBe(2);
      expect(await admissionRows()).toMatchObject([
        { admission_id: other.admissionId },
      ]);
    },
  );

  it("retains exhausted release failures for reconciliation and preserves another admission", async () => {
    await activate();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const admission = await acquireInviteSourceAdmission(db, "release", {
      now: () => 10,
    });
    const other = await acquireInviteSourceAdmission(db, "other", {
      now: () => 10,
    });
    const before = await admissionRows();
    let deletes = 0;
    const connection = interceptAdmissions(
      async (query, bindings, _primary, execute) => {
        if (query.trimStart().startsWith("DELETE")) {
          deletes++;
          expect(bindings[0]).toBe(admission.admissionId);
          throw new Error("delete-unavailable");
        }
        return execute();
      },
    );
    await expect(
      releaseInviteSourceAdmission(connection, admission),
    ).rejects.toThrow();
    expect(deletes).toBe(3);
    expect(await admissionRows()).toEqual(before);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorLog.mock.calls[0]![0]!))).toEqual({
      event: "invite_source_admission_release_failed",
      ...admission,
    });
    await releaseInviteSourceAdmission(db, admission);
    expect(await admissionRows()).toMatchObject([
      { admission_id: other.admissionId },
    ]);
  });

  it.each(admissionControlSources)(
    "retains an uncertain committed admission when every primary readback fails (%s control)",
    async (controlSource) => {
      await activate();
      const options = await admissionOptions(controlSource);
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const insertedIds: unknown[] = [];
      const connection = interceptAdmissions(
        async (query, bindings, primary, execute) => {
          if (query.trimStart().startsWith("INSERT")) {
            insertedIds.push(bindings[0]);
            await execute();
            throw new Error("lost-insert-response");
          }
          expect(primary).toBe(true);
          throw new Error("readback-unavailable");
        },
      );
      await expect(
        acquireInviteSourceAdmission(connection, "uncertain", options),
      ).rejects.toThrow();
      expect(insertedIds).toHaveLength(3);
      expect(new Set(insertedIds).size).toBe(1);
      expect(await admissionRows()).toMatchObject([
        { admission_id: insertedIds[0], kind: "uncertain" },
      ]);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(errorLog.mock.calls[0]![0]!))).toEqual({
        event: "invite_source_admission_acquire_unconfirmed",
        admissionId: insertedIds[0],
        backend: "d1",
        epoch: 1,
        freezeGeneration: 0,
        kind: "uncertain",
        createdAtMs: 10,
      });
    },
  );

  it.each(admissionControlSources)(
    "recovers its committed admission after control freezes so the fenced writer can release it (%s control)",
    async (controlSource) => {
      await activate();
      const options = await admissionOptions(controlSource);
      const connection = interceptAdmissions(
        async (query, _bindings, _primary, execute) => {
          const result = await execute();
          if (query.trimStart().startsWith("INSERT")) {
            await db
              .prepare(
                "UPDATE invite_source_control SET state = 'frozen', freeze_generation = 1 WHERE singleton = 1",
              )
              .run();
            throw new Error("lost-insert-response");
          }
          return result;
        },
      );
      const admission = await acquireInviteSourceAdmission(
        connection,
        "raced",
        options,
      );
      expect(admission).toMatchObject({
        backend: "d1",
        epoch: 1,
        freezeGeneration: 0,
      });
      await expect(
        db.batch(inviteSourceAdmissionGuardStatements(db, admission)),
      ).rejects.toThrow();
      await releaseInviteSourceAdmission(connection, admission);
      expect(await admissionRows()).toEqual([]);
    },
  );

  it.each(
    admissionControlSources.flatMap((controlSource) =>
      [
        "state = 'frozen', freeze_generation = 1",
        "epoch = 2",
        "backend = 'rtdb', epoch = 0",
      ].map((change) => ({ controlSource, change })),
    ),
  )(
    "rejects acquisition when control changes before INSERT: $change ($controlSource control)",
    async ({ controlSource, change }) => {
      await activate();
      const options = await admissionOptions(controlSource);
      let changed = false;
      const connection = interceptAdmissions(
        async (query, _bindings, _primary, execute) => {
          if (query.trimStart().startsWith("INSERT") && !changed) {
            changed = true;
            await db
              .prepare(
                `UPDATE invite_source_control SET ${change} WHERE singleton = 1`,
              )
              .run();
          }
          return execute();
        },
      );
      await expect(
        acquireInviteSourceAdmission(connection, "raced", options),
      ).rejects.toThrow();
      expect(changed).toBe(true);
      expect(await admissionRows()).toEqual([]);
    },
  );

  it.each(
    admissionControlSources.flatMap((controlSource) =>
      [
        { column: "backend", value: "rtdb" },
        { column: "epoch", value: 2 },
        { column: "freeze_generation", value: 1 },
        { column: "kind", value: "other" },
        { column: "created_at_ms", value: 11 },
      ].map((change) => ({ controlSource, ...change })),
    ),
  )(
    "does not recover or delete an admission whose $column changed ($controlSource control)",
    async ({ controlSource, column, value }) => {
      await activate();
      const options = await admissionOptions(controlSource);
      let changed = false;
      const connection = interceptAdmissions(
        async (query, bindings, _primary, execute) => {
          const result = await execute();
          if (query.trimStart().startsWith("INSERT") && !changed) {
            changed = true;
            await db
              .prepare(
                `UPDATE invite_source_write_admissions SET ${column} = ? WHERE admission_id = ?`,
              )
              .bind(value, bindings[0])
              .run();
            throw new Error("lost-insert-response");
          }
          return result;
        },
      );
      await expect(
        acquireInviteSourceAdmission(connection, "raced", options),
      ).rejects.toThrow();
      const rows = await admissionRows();
      expect(rows).toMatchObject([{ [column]: value }]);
      await releaseInviteSourceAdmission(db, {
        admissionId: rows[0]!.admission_id as string,
        backend: "d1",
        epoch: 1,
        freezeGeneration: 0,
        kind: "raced",
        createdAtMs: 10,
      });
      expect(await admissionRows()).toEqual(rows);
    },
  );

  it("rejects unsupported mutation and query shapes before writing", async () => {
    await activate();
    const store = createInviteSourceD1Store(db);
    for (const updates of [
      { "invites/one": null },
      { "invites/one/wagers/match": {} },
      { "invites/one/sessionTransition": {} },
      { "invites/one": {}, "invites/one/hostId": "host" },
    ])
      await expect(store.preparePatch(updates, 1)).rejects.toThrow();
    await expect(store.getPath("invites")).rejects.toThrow(
      "root-scan-unsupported",
    );
    await expect(
      store.getPath("invites/one", { orderBy: "hostId" }),
    ).rejects.toThrow("query-unsupported");
    expect((await store.read("one")).value).toBeNull();
  });
});
