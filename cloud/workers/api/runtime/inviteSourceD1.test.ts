import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
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
  createInviteSourceD1Store,
  inviteSourceAdmissionGuardStatements,
  isInviteSourceRevisionConflict,
  normalizeInviteSource,
  readInviteSourceControl,
  releaseInviteSourceAdmission,
} from "../src/inviteSourceD1.ts";
import { createAutomatchPersistence } from "../src/automatchPersistence.ts";
import type { FirebaseRtdbClient } from "../src/firebaseRtdb.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const raw: FirebaseRtdbClient = {
  async getPath() {
    throw new Error("unexpected-firebase-read");
  },
  async patchRoot() {
    throw new Error("unexpected-firebase-write");
  },
  async transactPath() {
    throw new Error("unexpected-firebase-write");
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
          return (statements: D1PreparedStatement[]) =>
            target.batch(
              statements.map(
                (statement) => nativeStatements.get(statement) ?? statement,
              ),
            );
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

describe("canonical invite source", () => {
  beforeAll(() => applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS));
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM invite_source_write_admissions"),
      db.prepare("DELETE FROM invite_sources"),
      db.prepare("DELETE FROM automatch_write_admissions"),
      db.prepare("DELETE FROM automatch_entries"),
      db.prepare("DELETE FROM game_session_transition_resources"),
      db.prepare("DELETE FROM game_session_transitions"),
      db.prepare(`UPDATE invite_source_control SET backend = 'rtdb', state = 'active',
        epoch = 0, freeze_generation = 0, verified_at_ms = NULL, activated_at_ms = NULL,
        metadata_json = NULL WHERE singleton = 1`),
      db.prepare(
        "UPDATE automatch_runtime_control SET backend = 'd1', state = 'active' WHERE singleton = 1",
      ),
    ]);
  });

  it("preserves private and unknown metadata while excluding retired sources", () => {
    const value = {
      password: "",
      hostId: "anonymous",
      hostRematches: "1x2",
      custom: { future: [1, null, true] },
      sessionTransition: { sequence: 4 },
      wagers: { stale: true },
      matchesWagerResolutions: { stale: true },
      reactions: { stale: true },
    };
    expect(normalizeInviteSource(value)).toEqual({
      password: "",
      hostId: "anonymous",
      hostRematches: "1x2",
      custom: { future: [1, null, true] },
      sessionTransition: { sequence: 4 },
    });
    expect(normalizeInviteSource({ reactions: { old: true } })).toEqual({});
    expect(() => normalizeInviteSource(null)).toThrow(
      "invalid-invite-source-json",
    );
  });

  it("rejects a retired source mode and never falls back for missing D1 rows", async () => {
    let firebaseReads = 0;
    const raw: FirebaseRtdbClient = {
      async getPath() {
        firebaseReads++;
        return { hostId: "stale-firebase" };
      },
      async patchRoot() {
        throw new Error("unexpected-firebase-write");
      },
      async transactPath() {
        throw new Error("unexpected-firebase-write");
      },
    };
    const coordinator = createAutomatchPersistence(db, raw);
    await expect(coordinator.client.getPath("invites/one")).rejects.toThrow(
      "invite-source-backend-retired",
    );
    expect(firebaseReads).toBe(0);
    await activate();
    const store = createInviteSourceD1Store(db);
    await db.batch(
      store.buildCommitStatements(
        await store.preparePatch(
          {
            "invites/one": {
              hostId: "canonical",
              password: "secret",
              settings: { color: "white" },
            },
          },
          100,
        ),
        100,
      ),
    );
    expect(await coordinator.client.getPath("invites/one/hostId")).toBe(
      "canonical",
    );
    expect(
      await coordinator.client.getPath("invites/one", { shallow: true }),
    ).toEqual({ hostId: true, password: true, settings: true });
    expect(await coordinator.client.getPath("invites/missing")).toBeNull();
    expect(firebaseReads).toBe(0);
    await db
      .prepare("DELETE FROM invite_source_control WHERE singleton = 1")
      .run();
    await expect(coordinator.client.getPath("invites/one")).rejects.toThrow(
      "invite-source-control-unavailable",
    );
    expect(firebaseReads).toBe(0);
    await db
      .prepare(
        `INSERT INTO invite_source_control (singleton, backend, state, epoch, freeze_generation)
      VALUES (1, 'rtdb', 'active', 0, 0)`,
      )
      .run();
  });

  it("merges root fields, resolves server values once, and preserves provenance", async () => {
    await activate();
    const store = createInviteSourceD1Store(db);
    await db
      .prepare(`INSERT INTO invite_sources VALUES ('one', ?, 4, 1)`)
      .bind(
        JSON.stringify({
          hostId: "host",
          password: "",
          hostRematches: "1",
          guestRematches: "",
          sessionTransition: { sequence: 7 },
          automatchOperationIds: { host: "first" },
        }),
      )
      .run();
    const mutations = await store.preparePatch(
      {
        "invites/one/guestId": "guest",
        "invites/one/hostRematches": "1;2",
        "invites/one/automatchCanceledAt": null,
        "invites/one/lastTouched": { ".sv": "timestamp" },
      },
      345,
    );
    await db.batch(store.buildCommitStatements(mutations, 900));
    const next = await store.preparePatch(
      {
        "invites/one": {
          guestRematches: "1",
          count: { ".sv": { increment: 2 } },
        },
      },
      1000,
    );
    await db.batch(store.buildCommitStatements(next, 1000));
    expect(await store.read("one")).toMatchObject({
      revision: 6,
      value: {
        hostId: "host",
        guestId: "guest",
        password: "",
        hostRematches: "1;2",
        guestRematches: "1",
        lastTouched: 345,
        count: 2,
        sessionTransition: { sequence: 7 },
        automatchOperationIds: { host: "first" },
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
    expect((await store.read("one")).value).toEqual({ hostId: "first" });
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
      const coordinator = createAutomatchPersistence(connection, raw);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (operation === "patch") {
          await coordinator.client.patchRoot({
            "automatch/one": { uid: "host" },
          });
          expect(await coordinator.client.getPath("automatch/one")).toEqual({
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

  it("retries an INSERT that failed before committing with the same admission ID", async () => {
    await activate();
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
    const admission = await acquireInviteSourceAdmission(connection, "retry", {
      now: () => 10,
    });
    expect(insertedIds).toEqual([admission.admissionId, admission.admissionId]);
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
  });

  it("recovers one committed admission after its response and first primary readback fail", async () => {
    await activate();
    const insertedIds: unknown[] = [];
    let readbacks = 0;
    const connection = interceptAdmissions(
      async (query, bindings, primary, execute) => {
        if (query.trimStart().startsWith("INSERT")) {
          insertedIds.push(bindings[0]);
          const result = await execute();
          if (insertedIds.length === 1) throw new Error("lost-insert-response");
          return result;
        }
        if (query.trimStart().startsWith("SELECT")) {
          expect(primary).toBe(true);
          if (++readbacks === 1) throw new Error("readback-unavailable");
        }
        return execute();
      },
    );
    const admission = await acquireInviteSourceAdmission(connection, "retry", {
      now: () => 10,
    });
    expect(insertedIds).toEqual([admission.admissionId, admission.admissionId]);
    expect(readbacks).toBe(2);
    expect(await admissionRows()).toHaveLength(1);
    await releaseInviteSourceAdmission(connection, admission);
    expect(await admissionRows()).toEqual([]);
  });

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
    expect(JSON.parse(String(errorLog.mock.calls[0][0]))).toEqual({
      event: "invite_source_admission_release_failed",
      ...admission,
    });
    await releaseInviteSourceAdmission(db, admission);
    expect(await admissionRows()).toMatchObject([
      { admission_id: other.admissionId },
    ]);
  });

  it("retains an uncertain committed admission when every primary readback fails", async () => {
    await activate();
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
      acquireInviteSourceAdmission(connection, "uncertain", { now: () => 10 }),
    ).rejects.toThrow();
    expect(insertedIds).toHaveLength(3);
    expect(new Set(insertedIds).size).toBe(1);
    expect(await admissionRows()).toMatchObject([
      { admission_id: insertedIds[0], kind: "uncertain" },
    ]);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorLog.mock.calls[0][0]))).toEqual({
      event: "invite_source_admission_acquire_unconfirmed",
      admissionId: insertedIds[0],
      backend: "d1",
      epoch: 1,
      freezeGeneration: 0,
      kind: "uncertain",
      createdAtMs: 10,
    });
  });

  it("recovers its committed admission after control freezes so the fenced writer can release it", async () => {
    await activate();
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
    const admission = await acquireInviteSourceAdmission(connection, "raced", {
      now: () => 10,
    });
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
  });

  it.each([
    "state = 'frozen', freeze_generation = 1",
    "epoch = 2",
    "backend = 'rtdb', epoch = 0",
  ])(
    "rejects acquisition when control changes before INSERT: %s",
    async (change) => {
      await activate();
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
        acquireInviteSourceAdmission(connection, "raced"),
      ).rejects.toThrow();
      expect(changed).toBe(true);
      expect(await admissionRows()).toEqual([]);
    },
  );

  it("does not recover or delete an admission whose exact tuple changed", async () => {
    await activate();
    let changed = false;
    const connection = interceptAdmissions(
      async (query, bindings, _primary, execute) => {
        const result = await execute();
        if (query.trimStart().startsWith("INSERT") && !changed) {
          changed = true;
          await db
            .prepare(
              "UPDATE invite_source_write_admissions SET kind = 'other' WHERE admission_id = ?",
            )
            .bind(bindings[0])
            .run();
          throw new Error("lost-insert-response");
        }
        return result;
      },
    );
    await expect(
      acquireInviteSourceAdmission(connection, "raced", { now: () => 10 }),
    ).rejects.toThrow();
    const rows = await admissionRows();
    expect(rows).toMatchObject([{ kind: "other" }]);
    await releaseInviteSourceAdmission(db, {
      admissionId: rows[0].admission_id as string,
      backend: "d1",
      epoch: 1,
      freezeGeneration: 0,
      kind: "raced",
      createdAtMs: 10,
    });
    expect(await admissionRows()).toEqual(rows);
  });

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
