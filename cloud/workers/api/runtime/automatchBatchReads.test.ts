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
              persistence.client.readMutationReceipt(crypto.randomUUID()),
            ),
          ).toBeNull();
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
});
