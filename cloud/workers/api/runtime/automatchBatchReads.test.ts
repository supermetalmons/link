import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";
import { createAutomatchPersistence } from "../src/automatchPersistence.ts";
import { matchTestPort } from "../test/gameSessionTestPorts.ts";
import {
  acquireAutomatchAdmissions,
  releaseAutomatchAdmissions,
} from "../src/automatchAdmissions.ts";
import {
  withAutomatchTelemetry,
  measureAutomatchPhase,
} from "../src/automatchTelemetry.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;
const raw = matchTestPort({
  getPath: async () => {
    throw new Error("unexpected-match-read");
  },
  transactPath: async () => {
    throw new Error("unexpected-match-write");
  },
});

type AdmissionBatchHook = (
  run: () => Promise<D1Result[]>,
) => Promise<D1Result[]>;

function withAdmissionBatchHooks(hooks: {
  write?: AdmissionBatchHook;
  readback?: AdmissionBatchHook;
  release?: AdmissionBatchHook;
}): D1Database {
  let acquisitionSession = true;
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch" && hooks.release)
        return (statements: D1PreparedStatement[]) =>
          hooks.release!(() => target.batch(statements));
      if (property === "withSession")
        return (constraint?: string) => {
          expect(constraint).toBe("first-primary");
          const hook = acquisitionSession ? hooks.write : hooks.readback;
          acquisitionSession = false;
          const session = target.withSession(constraint);
          return new Proxy(session, {
            get(value, name) {
              if (name === "batch" && hook)
                return (statements: D1PreparedStatement[]) =>
                  hook(() => value.batch(statements));
              const method = Reflect.get(value, name, value);
              return typeof method === "function" ? method.bind(value) : method;
            },
          });
        };
      const method = Reflect.get(target, property, target);
      return typeof method === "function" ? method.bind(target) : method;
    },
  });
}

describe("batched automatch coordination", () => {
  beforeAll(() =>
    applyStrictMatchStateTestMigrations(db, testEnv.TEST_D1_MIGRATIONS),
  );
  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM automatch_write_admissions"),
      db.prepare("DELETE FROM invite_source_write_admissions"),
      db.prepare(
        "UPDATE automatch_runtime_control SET backend = 'd1', state = 'active', epoch = 1, freeze_generation = 0",
      ),
      db.prepare(
        "UPDATE invite_source_control SET backend = 'd1', state = 'active', epoch = 1, freeze_generation = 0, verified_at_ms = 1, activated_at_ms = 1",
      ),
    ]);
  });

  it("reads a clean receipt in one database call and isolates concurrent timings", async () => {
    const records: Record<string, unknown>[] = [];
    const read = () =>
      withAutomatchTelemetry(
        env,
        async (measured) => {
          const persistence = createAutomatchPersistence(
            measured.PROFILE_GAMES_DB,
            raw,
          );
          expect(
            await measureAutomatchPhase("receipt", () =>
              persistence.client.readAutomatchReceipt(crypto.randomUUID()),
            ),
          ).toEqual({ kind: "missing" });
          return new Response("ok");
        },
        { sample: () => true, log: (record) => records.push(record) },
      );
    const responses = await Promise.all([read(), read()]);
    for (const response of responses)
      expect(response.headers.get("Server-Timing")).toContain(
        'd1;desc="1 calls"',
      );
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.d1Calls).toBe(1);
      expect(record.phases).toMatchObject({ receipt: { d1Calls: 1 } });
    }
  });

  it("acquires and releases both admissions in two database calls", async () => {
    const response = await withAutomatchTelemetry(
      env,
      async (measured) => {
        const pair = await acquireAutomatchAdmissions(
          measured.PROFILE_GAMES_DB,
          "test-batch",
          () => 10,
        );
        expect(pair.automatch.admissionId).toBe(pair.invite.admissionId);
        await releaseAutomatchAdmissions(measured.PROFILE_GAMES_DB, pair);
        return new Response("ok");
      },
      { sample: () => false },
    );
    expect(response.headers.get("Server-Timing")).toContain(
      'd1;desc="2 calls"',
    );
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM automatch_write_admissions")
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM invite_source_write_admissions")
        .first("n"),
    ).toBe(0);
  });

  it("reports native session batch metadata without counting first as metadata", async () => {
    const records: Record<string, unknown>[] = [];
    const nativeResults: D1Result[] = [];
    const response = await withAutomatchTelemetry(
      env,
      async (measured) => {
        const session = measured.PROFILE_GAMES_DB.withSession("first-primary");
        const results = await session.batch([
          session
            .prepare(
              "SELECT state FROM automatch_runtime_control WHERE singleton = ?",
            )
            .bind(1),
          session
            .prepare(
              "SELECT epoch FROM invite_source_control WHERE singleton = ?",
            )
            .bind(1),
        ]);
        nativeResults.push(...results);
        expect(results[0].results).toEqual([{ state: "active" }]);
        expect(results[1].results).toEqual([{ epoch: 1 }]);
        expect(
          await session
            .prepare(
              "SELECT epoch FROM invite_source_control WHERE singleton = ?",
            )
            .bind(1)
            .first("epoch"),
        ).toBe(1);
        expect(["string", "object"]).toContain(typeof session.getBookmark());
        return new Response("ok");
      },
      { sample: () => true, log: (record) => records.push(record) },
    );
    expect(response.headers.get("Server-Timing")).toContain(
      'd1;desc="2 calls"',
    );
    expect(records).toHaveLength(1);
    expect(records[0].d1).toMatchObject({
      calls: 2,
      failedCalls: 0,
      metadataResults: 2,
      callsWithoutMetadata: 1,
      rowsRead: nativeResults.reduce(
        (sum, result) => sum + result.meta.rows_read,
        0,
      ),
      rowsWritten: nativeResults.reduce(
        (sum, result) => sum + result.meta.rows_written,
        0,
      ),
      sqlDurationMs: nativeResults.reduce(
        (sum, result) =>
          sum + (result.meta.timings?.sql_duration_ms ?? result.meta.duration),
        0,
      ),
    });
    expect(records[0].databases).toMatchObject({
      PROFILE_GAMES_DB: records[0].d1,
    });
  });

  it("rolls back the first admission if the other authority is frozen", async () => {
    await db.prepare("UPDATE invite_source_control SET state = 'frozen'").run();
    await expect(
      acquireAutomatchAdmissions(db, "test-frozen", () => 10),
    ).rejects.toThrow("invite-source-writes-frozen");
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM automatch_write_admissions")
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM invite_source_write_admissions")
        .first("n"),
    ).toBe(0);
  });

  it("rejects corrupt authority snapshots and releases the acquired pair", async () => {
    await db
      .prepare(
        "UPDATE invite_source_control SET verified_at_ms = NULL, activated_at_ms = NULL",
      )
      .run();
    await expect(
      acquireAutomatchAdmissions(db, "test-corrupt", () => 10),
    ).rejects.toThrow("invite-source-control-unavailable");
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM automatch_write_admissions")
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM invite_source_write_admissions")
        .first("n"),
    ).toBe(0);
  });

  it.each([
    ["automatch_runtime_control", "epoch"],
    ["automatch_runtime_control", "freeze_generation"],
    ["invite_source_control", "epoch"],
    ["invite_source_control", "freeze_generation"],
  ])(
    "rolls back both admissions for fractional %s.%s",
    async (table, field) => {
      await db.prepare(`UPDATE ${table} SET ${field} = 1.5`).run();
      await expect(
        acquireAutomatchAdmissions(db, "test-fractional-control", () => 10),
      ).rejects.toThrow();
      expect(
        await db
          .prepare("SELECT COUNT(*) AS n FROM automatch_write_admissions")
          .first("n"),
      ).toBe(0);
      expect(
        await db
          .prepare("SELECT COUNT(*) AS n FROM invite_source_write_admissions")
          .first("n"),
      ).toBe(0);
    },
  );

  it("reconciles a lost retry commit on primary after an earlier absent read", async () => {
    let writeAttempts = 0;
    const queries = new WeakMap<D1PreparedStatement, string>();
    const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
    const uncertain = new Proxy(db, {
      get(target, property) {
        if (property === "withSession")
          return (constraint?: string) => {
            const session = target.withSession(constraint);
            let replicaSnapshot: D1Result[] | undefined;
            return new Proxy(session, {
              get(value, name) {
                if (name === "prepare")
                  return (query: string) => {
                    const statement = value.prepare(query);
                    const wrapped = new Proxy(statement, {
                      get(prepared, key) {
                        if (key === "bind")
                          return (...bindings: unknown[]) => {
                            const bound = prepared.bind(...bindings);
                            queries.set(bound, query);
                            return bound;
                          };
                        const method = Reflect.get(prepared, key, prepared);
                        return typeof method === "function"
                          ? method.bind(prepared)
                          : method;
                      },
                    });
                    queries.set(wrapped, query);
                    originals.set(wrapped, statement);
                    return wrapped;
                  };
                if (name === "batch")
                  return async (statements: D1PreparedStatement[]) => {
                    const unwrapped = statements.map(
                      (statement) => originals.get(statement) || statement,
                    );
                    if (
                      statements.some((statement) =>
                        /^\s*INSERT\b/.test(queries.get(statement) || ""),
                      )
                    ) {
                      writeAttempts++;
                      if (writeAttempts === 2) {
                        await value.batch(unwrapped);
                        throw new Error("response-lost-after-retry-commit");
                      }
                      throw new Error("transport-failed-before-commit");
                    }
                    if (replicaSnapshot)
                      return structuredClone(replicaSnapshot);
                    expect(constraint).toBe("first-primary");
                    const result = await value.batch(unwrapped);
                    replicaSnapshot = structuredClone(result);
                    return result;
                  };
                const method = Reflect.get(value, name, value);
                return typeof method === "function"
                  ? method.bind(value)
                  : method;
              },
            });
          };
        const method = Reflect.get(target, property, target);
        return typeof method === "function" ? method.bind(target) : method;
      },
    });
    const pair = await acquireAutomatchAdmissions(
      uncertain,
      "test-lost-retry-commit",
      () => 10,
    );
    expect(writeAttempts).toBe(2);
    expect(pair.automatch.admissionId).toBe(pair.invite.admissionId);
    await releaseAutomatchAdmissions(db, pair);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM automatch_write_admissions")
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM invite_source_write_admissions")
        .first("n"),
    ).toBe(0);
  });

  it("reconciles an uncertain admission batch using the original identities", async () => {
    let lost = false;
    const uncertain = new Proxy(db, {
      get(target, property) {
        if (property === "withSession")
          return (constraint?: string) => {
            const session = target.withSession(constraint);
            return new Proxy(session, {
              get(value, name) {
                if (name === "batch")
                  return async (statements: D1PreparedStatement[]) => {
                    const result = await value.batch(statements);
                    if (!lost) {
                      lost = true;
                      throw new Error("response-lost");
                    }
                    return result;
                  };
                const method = Reflect.get(value, name, value);
                return typeof method === "function"
                  ? method.bind(value)
                  : method;
              },
            });
          };
        const method = Reflect.get(target, property, target);
        return typeof method === "function" ? method.bind(target) : method;
      },
    });
    const pair = await acquireAutomatchAdmissions(
      uncertain,
      "test-uncertain",
      () => 10,
    );
    expect(lost).toBe(true);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM automatch_write_admissions")
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM invite_source_write_admissions")
        .first("n"),
    ).toBe(1);
    await releaseAutomatchAdmissions(db, pair);
  });

  it.each(["before", "after"] as const)(
    "retries paired release failures %s commit without deleting another pair",
    async (failureStage) => {
      const pair = await acquireAutomatchAdmissions(db, "release", () => 10);
      const other = await acquireAutomatchAdmissions(db, "other", () => 20);
      let attempts = 0;
      const connection = withAdmissionBatchHooks({
        async release(run) {
          attempts++;
          if (failureStage === "before" && attempts < 3)
            throw new Error("release-unavailable");
          const result = await run();
          if (failureStage === "after" && attempts < 3)
            throw new Error("release-response-lost");
          return result;
        },
      });
      await releaseAutomatchAdmissions(connection, pair);
      expect(attempts).toBe(3);
      for (const table of [
        "automatch_write_admissions",
        "invite_source_write_admissions",
      ]) {
        expect(
          (await db.prepare(`SELECT admission_id FROM ${table}`).all()).results,
        ).toEqual([{ admission_id: other.automatch.admissionId }]);
      }
    },
  );

  it("retains uncertain paired admissions with the original identity after exhaustion", async () => {
    let writes = 0;
    let reads = 0;
    let clockReads = 0;
    let lastReadFailure: Error | undefined;
    const connection = withAdmissionBatchHooks({
      async write(run) {
        writes++;
        await run();
        throw new Error(`lost-write-${writes}`);
      },
      async readback() {
        reads++;
        lastReadFailure = new Error(`failed-read-${reads}`);
        throw lastReadFailure;
      },
    });
    await expect(
      acquireAutomatchAdmissions(connection, "uncertain-retained", () => {
        clockReads++;
        return 10;
      }),
    ).rejects.toSatisfy(
      (error: Error) =>
        error.message === "automatch-admission-unconfirmed" &&
        error.cause === lastReadFailure,
    );
    expect({ writes, reads, clockReads }).toEqual({
      writes: 3,
      reads: 3,
      clockReads: 1,
    });
    const automatch = await db
      .prepare(
        "SELECT admission_id, kind, created_at_ms FROM automatch_write_admissions",
      )
      .all();
    const invite = await db
      .prepare(
        "SELECT admission_id, kind, created_at_ms FROM invite_source_write_admissions",
      )
      .all();
    expect(automatch.results).toHaveLength(1);
    expect(invite.results).toEqual(automatch.results);
    expect(automatch.results[0]).toMatchObject({
      kind: "uncertain-retained",
      created_at_ms: 10,
    });
  });

  it("fails immediately on a partially confirmed pair and retains its evidence", async () => {
    let writes = 0;
    let reads = 0;
    const connection = withAdmissionBatchHooks({
      async write(run) {
        writes++;
        await run();
        await db
          .prepare(
            "DELETE FROM invite_source_write_admissions WHERE kind = 'partial-pair'",
          )
          .run();
        throw new Error("response-lost");
      },
      async readback(run) {
        reads++;
        return run();
      },
    });
    await expect(
      acquireAutomatchAdmissions(connection, "partial-pair", () => 10),
    ).rejects.toThrow("automatch-admission-partial");
    expect({ writes, reads }).toEqual({ writes: 1, reads: 1 });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM automatch_write_admissions")
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM invite_source_write_admissions")
        .first("n"),
    ).toBe(0);
  });

  it("propagates failed validation cleanup without retrying acquisition", async () => {
    await db
      .prepare(
        "UPDATE invite_source_control SET verified_at_ms = NULL, activated_at_ms = NULL",
      )
      .run();
    let writes = 0;
    let releases = 0;
    const releaseFailure = new Error("cleanup-unavailable");
    const connection = withAdmissionBatchHooks({
      async write(run) {
        writes++;
        return run();
      },
      readback: async () => {
        throw new Error("unexpected-readback");
      },
      release: async () => {
        releases++;
        throw releaseFailure;
      },
    });
    await expect(
      acquireAutomatchAdmissions(connection, "cleanup-failed", () => 10),
    ).rejects.toBe(releaseFailure);
    expect({ writes, releases }).toEqual({ writes: 1, releases: 3 });
    for (const table of [
      "automatch_write_admissions",
      "invite_source_write_admissions",
    ]) {
      expect(
        await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n"),
      ).toBe(1);
    }
  });
});
