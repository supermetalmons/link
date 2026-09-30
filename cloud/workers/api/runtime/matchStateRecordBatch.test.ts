import { env } from "cloudflare:workers";
import { runInDurableObject, type D1Migration } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildMatchStateRouteStatements } from "../src/matchStateD1.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "../src/matchStateRpc.ts";
import { createMatchStateSource } from "../src/matchStateSource.ts";
import { MatchStateStore } from "../src/matchStateStore.ts";
import {
  MAX_MATCH_STATE_RECORD_READS,
  type MatchStateRecordsRequest,
} from "../src/matchStateTypes.ts";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };
const db = env.PROFILE_GAMES_DB;

beforeAll(async () => {
  await applyStrictMatchStateTestMigrations(db, testEnv.TEST_D1_MIGRATIONS);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db
    .prepare(
      "UPDATE match_state_control SET state = 'active' WHERE singleton = 1",
    )
    .run();
});

async function roomFixture() {
  const inviteId = `record-batch-${crypto.randomUUID()}`;
  const rpc = getMatchStateRpc(env, inviteId);
  const records = [
    {
      matchId: inviteId,
      playerId: "host-login",
      marker: "host-created",
      value: { color: "white", fen: "host-position" },
    },
    {
      matchId: inviteId,
      playerId: "guest-login",
      marker: "guest-created",
      value: { color: "black", fen: "guest-position" },
    },
    {
      matchId: `${inviteId}1`,
      playerId: "host-login",
      marker: "rematch-created",
      value: { color: "black", fen: "rematch-position" },
    },
  ];
  const created = unwrapMatchStateRpc(
    await rpc.createCanonicalMatch({ inviteId, epoch: 2, records }),
  );
  const targets = records.map(({ matchId, playerId }) => ({
    matchId,
    playerId,
  }));
  const values = created.records.map(({ value }) => value);
  const register = async (indices: number[]) => {
    await db.batch(
      buildMatchStateRouteStatements(
        db,
        indices.map((index) => ({
          actorUid: targets[index].playerId,
          matchId: targets[index].matchId,
          kind: "durable" as const,
          inviteId,
          epoch: 2,
        })),
      ),
    );
  };
  return { inviteId, rpc, targets, values, register };
}

function observedSource() {
  const calls: MatchStateRecordsRequest[] = [];
  const d1Calls: Array<{ session: number; queries: string[] }> = [];
  let sessionId = 0;
  const database = new Proxy(env.PROFILE_GAMES_DB, {
    get(target, property) {
      if (property === "withSession")
        return (constraint: string) => {
          expect(constraint).toBe("first-primary");
          const session = target.withSession(constraint);
          const id = ++sessionId;
          const statements = new Map<
            D1PreparedStatement,
            { query: string; statement: D1PreparedStatement }
          >();
          const observe = (query: string, statement: D1PreparedStatement) => {
            const observed = new Proxy(statement, {
              get(target, property) {
                if (property === "bind")
                  return (...values: unknown[]) =>
                    observe(query, target.bind(...values));
                if (property === "first")
                  return () => {
                    d1Calls.push({ session: id, queries: [query] });
                    return target.first();
                  };
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
            statements.set(observed, { query, statement });
            return observed;
          };
          return {
            prepare: (query: string) => observe(query, session.prepare(query)),
            batch: (batch: D1PreparedStatement[]) => {
              const originals = batch.map((statement) =>
                statements.get(statement)!,
              );
              d1Calls.push({
                session: id,
                queries: originals.map(({ query }) => query),
              });
              return session.batch(originals.map(({ statement }) => statement));
            },
            getBookmark: () => session.getBookmark(),
          };
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const workerEnv = new Proxy(env, {
    get(target, property, receiver) {
      if (property === "PROFILE_GAMES_DB") return database;
      if (property === "INVITE_REACTIONS")
        return {
          getByName: (inviteId: string) => ({
            readCanonicalMatchRecords: (input: MatchStateRecordsRequest) => {
              expect(input.inviteId).toBe(inviteId);
              calls.push(structuredClone(input));
              return getMatchStateRpc(env, inviteId).readCanonicalMatchRecords(
                input,
              );
            },
          }),
        };
      return Reflect.get(target, property, receiver);
    },
  });
  return { source: createMatchStateSource(workerEnv), calls, d1Calls };
}

function observedStore(storage: DurableObjectStorage) {
  const calls: Array<{
    query: string;
    bindings: unknown[];
    cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
  }> = [];
  const sql = new Proxy(storage.sql, {
    get(target, property) {
      if (property === "exec")
        return (query: string, ...bindings: unknown[]) => {
          const cursor = target.exec(query, ...bindings);
          calls.push({ query, bindings, cursor });
          return cursor;
        };
      return Reflect.get(target, property, target);
    },
  });
  const measuredStorage = new Proxy(storage, {
    get(target, property) {
      if (property === "sql") return sql;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const store = new MatchStateStore(measuredStorage, {
    timerStarts: {
      getOrAdvance: () => {
        throw new Error("unexpected-timer-write");
      },
      deletePair: () => {
        throw new Error("unexpected-timer-write");
      },
    },
  });
  calls.length = 0;
  return { store, calls };
}

describe("routed match record batches", () => {
  it("uses two primary D1 calls for canonical and missing records with a separate final authority check", async () => {
    const fixture = await roomFixture();
    await fixture.register([0, 1, 2]);
    const { source, calls, d1Calls } = observedSource();
    const targets = [
      fixture.targets[2],
      { playerId: "missing-login", matchId: fixture.inviteId },
      fixture.targets[0],
      fixture.targets[1],
    ];
    expect(await source.readMatchRecords(targets)).toEqual([
      fixture.values[2],
      null,
      fixture.values[0],
      fixture.values[1],
    ]);
    expect(calls).toHaveLength(1);
    expect(d1Calls).toHaveLength(2);
    expect(d1Calls[0].queries).toHaveLength(targets.length + 1);
    expect(d1Calls[0].queries[0]).toContain("FROM match_state_control");
    expect(
      d1Calls[0].queries
        .slice(1)
        .every((query) => query.includes("FROM match_state_routes")),
    ).toBe(true);
    expect(d1Calls[1].queries).toHaveLength(1);
    expect(d1Calls[1].queries[0]).toContain("FROM match_state_control");
    expect(d1Calls[0].session).not.toBe(d1Calls[1].session);
    d1Calls.length = 0;
    expect(await source.readMatchRecord(targets[1])).toBeNull();
    expect(d1Calls.map(({ queries }) => queries.length)).toEqual([2, 1]);
    expect(d1Calls[0].session).not.toBe(d1Calls[1].session);
    expect(calls).toHaveLength(1);
  });

  it("reads only requested records in order despite unrelated corrupt state", async () => {
    const fixture = await roomFixture();
    await runInDurableObject(
      env.INVITE_REACTIONS.getByName(fixture.inviteId),
      (_instance, state) => {
        state.storage.sql.exec(
          "INSERT INTO match_state_claims(match_id, value_json) VALUES (?, ?)",
          fixture.inviteId,
          "invalid-json",
        );
        state.storage.sql.exec(
          "INSERT INTO match_state_records(match_id, player_id, value_json) VALUES (?, ?, ?)",
          fixture.inviteId,
          "unrelated-login",
          "invalid-json",
        );
      },
    );
    const missing = { matchId: fixture.inviteId, playerId: "missing-login" };
    expect(
      unwrapMatchStateRpc(
        await fixture.rpc.readCanonicalMatchRecords({
          inviteId: fixture.inviteId,
          epoch: 2,
          requests: [
            fixture.targets[1],
            fixture.targets[0],
            missing,
            fixture.targets[1],
          ],
        }),
      ),
    ).toEqual([fixture.values[1], fixture.values[0], null, fixture.values[1]]);
    expect(
      unwrapMatchStateRpc(
        await fixture.rpc.readCanonicalMatchRecords({
          inviteId: fixture.inviteId,
          epoch: 2,
          requests: Array.from(
            { length: MAX_MATCH_STATE_RECORD_READS },
            () => fixture.targets[0],
          ),
        }),
      ),
    ).toEqual(Array(MAX_MATCH_STATE_RECORD_READS).fill(fixture.values[0]));
    await fixture.register([0]);
    const { source } = observedSource();
    expect(await source.readMatchRecord(fixture.targets[0])).toEqual(
      fixture.values[0],
    );
  });

  it("fails the entire RPC when a requested record contains corrupt JSON", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = await roomFixture();
    await runInDurableObject(
      env.INVITE_REACTIONS.getByName(fixture.inviteId),
      (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE match_state_records SET value_json = ? WHERE match_id = ? AND player_id = ?",
          "invalid-json",
          fixture.targets[1].matchId,
          fixture.targets[1].playerId,
        );
      },
    );
    expect(
      await fixture.rpc.readCanonicalMatchRecords({
        inviteId: fixture.inviteId,
        epoch: 2,
        requests: [fixture.targets[0], fixture.targets[1]],
      }),
    ).toEqual({
      ok: false,
      status: 503,
      code: "unavailable",
      message: "match-state-unavailable",
    });
  });

  it("returns independently parsed duplicate records with retained JSON intact", async () => {
    const fixture = await roomFixture();
    const value = { nested: { absent: null, retained: [1, true] }, timer: "" };
    await runInDurableObject(
      env.INVITE_REACTIONS.getByName(fixture.inviteId),
      (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE match_state_records SET value_json = ? WHERE match_id = ? AND player_id = ?",
          JSON.stringify(value),
          fixture.targets[0].matchId,
          fixture.targets[0].playerId,
        );
      },
    );
    const records = unwrapMatchStateRpc(
      await fixture.rpc.readCanonicalMatchRecords({
        inviteId: fixture.inviteId,
        epoch: 2,
        requests: [fixture.targets[0], fixture.targets[0]],
      }),
    );
    expect(records).toEqual([value, value]);
    expect(records[0]).not.toBe(records[1]);
    expect(records[0]?.nested).not.toBe(records[1]?.nested);
  });

  it("rejects malformed and oversized RPC batches and preserves authority checks", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = await roomFixture();
    for (const requests of [
      null,
      {},
      [],
      Array(MAX_MATCH_STATE_RECORD_READS + 1).fill(fixture.targets[0]),
    ]) {
      expect(
        await fixture.rpc.readCanonicalMatchRecords({
          inviteId: fixture.inviteId,
          epoch: 2,
          requests,
        } as MatchStateRecordsRequest),
      ).toMatchObject({ ok: false, message: "match-state-unavailable" });
    }
    expect(
      await fixture.rpc.readCanonicalMatchRecords({
        inviteId: fixture.inviteId,
        epoch: 3,
        requests: [fixture.targets[0]],
      }),
    ).toMatchObject({
      ok: false,
      message: "match-state-authority-unavailable",
    });
    expect(
      await fixture.rpc.readCanonicalMatchRecords({
        inviteId: fixture.inviteId,
        epoch: 2,
        requests: [{ playerId: "host-login", matchId: "different-invite" }],
      }),
    ).toMatchObject({ ok: false, message: "match-state-unavailable" });
  });

  it("rejects invalid batch bounds before pinning an unused invite", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const inviteId = `invalid-batch-${crypto.randomUUID()}`;
    const rpc = getMatchStateRpc(env, inviteId);
    expect(
      await rpc.readCanonicalMatchRecords({ inviteId, epoch: 2, requests: [] }),
    ).toMatchObject({ ok: false, message: "match-state-unavailable" });
    await runInDurableObject(
      env.INVITE_REACTIONS.getByName(inviteId),
      (_instance, state) => {
        expect(
          state.storage.sql
            .exec("SELECT invite_id FROM invite_metadata")
            .toArray(),
        ).toEqual([]);
      },
    );
  });

  it("validates store batch bounds and every target before reading records", async () => {
    const fixture = await roomFixture();
    await runInDurableObject(
      env.INVITE_REACTIONS.getByName(fixture.inviteId),
      (_instance, state) => {
        const { store, calls } = observedStore(state.storage);
        const input = { inviteId: fixture.inviteId, epoch: 2 };
        for (const requests of [
          null,
          {},
          [],
          Array(MAX_MATCH_STATE_RECORD_READS + 1).fill(fixture.targets[0]),
        ]) {
          expect(() =>
            store.readRecords({
              ...input,
              requests,
            } as MatchStateRecordsRequest),
          ).toThrow("match-state-invalid-read-batch");
          expect(calls).toEqual([]);
        }
        expect(() =>
          store.readRecords({
            ...input,
            requests: [
              fixture.targets[0],
              { matchId: "different-invite", playerId: "host-login" },
            ],
          }),
        ).toThrow("match-state-invalid-target");
        expect(calls).toHaveLength(1);
        expect(calls[0].query).toContain("FROM match_state_source");
      },
    );
    expect(
      await fixture.rpc.readCanonicalMatchRecords({
        inviteId: fixture.inviteId,
        epoch: 2,
        requests: [
          fixture.targets[0],
          { matchId: "different-invite", playerId: "host-login" },
        ],
      }),
    ).toMatchObject({ ok: false, message: "match-state-unavailable" });
  });

  it("uses two indexed SQL reads for eight records regardless of unrelated history", async () => {
    const fixture = await roomFixture();
    await runInDurableObject(
      env.INVITE_REACTIONS.getByName(fixture.inviteId),
      (_instance, state) => {
        const { store, calls } = observedStore(state.storage);
        const requests = Array.from(
          { length: MAX_MATCH_STATE_RECORD_READS },
          (_, index) => ({
            matchId: `${fixture.inviteId}${index + 2}`,
            playerId: "host-login",
          }),
        );
        for (const request of requests) {
          state.storage.sql.exec(
            "INSERT INTO match_state_records(match_id, player_id, value_json) VALUES (?, ?, ?)",
            request.matchId,
            request.playerId,
            JSON.stringify({ match: request.matchId }),
          );
        }
        const input = { inviteId: fixture.inviteId, epoch: 2, requests };
        const values = requests.map((request) =>
          store.readRecord({
            ...request,
            inviteId: input.inviteId,
            epoch: input.epoch,
          }),
        );
        expect(calls).toHaveLength(2 * MAX_MATCH_STATE_RECORD_READS);
        const previousRowsRead = calls.reduce(
          (sum, call) => sum + call.cursor.rowsRead,
          0,
        );
        calls.length = 0;
        expect(store.readRecords(input)).toEqual(values);
        expect(calls).toHaveLength(2);
        expect(calls[0].query).toContain("FROM match_state_source");
        expect(calls[1].bindings).toHaveLength(
          2 * MAX_MATCH_STATE_RECORD_READS,
        );
        const rowsRead = calls.reduce(
          (sum, call) => sum + call.cursor.rowsRead,
          0,
        );
        expect(rowsRead).toBeLessThan(previousRowsRead);
        expect(calls.every((call) => call.cursor.rowsWritten === 0)).toBe(true);
        for (let index = 0; index < 256; index++) {
          state.storage.sql.exec(
            "INSERT INTO match_state_records(match_id, player_id, value_json) VALUES (?, ?, ?)",
            `${fixture.inviteId}${index + 100}`,
            "unrelated-login",
            "invalid-json",
          );
        }
        calls.length = 0;
        expect(store.readRecords(input)).toEqual(values);
        expect(calls).toHaveLength(2);
        expect(calls.reduce((sum, call) => sum + call.cursor.rowsRead, 0)).toBe(
          rowsRead,
        );
        expect(calls.every((call) => call.cursor.rowsWritten === 0)).toBe(true);
      },
    );
  });

  it("groups base matches and rematches by their stored room route and preserves order", async () => {
    const first = await roomFixture();
    const second = await roomFixture();
    await first.register([0, 1, 2]);
    await second.register([0]);
    const { source, calls } = observedSource();
    const requests = [
      first.targets[2],
      second.targets[0],
      first.targets[1],
      first.targets[0],
    ];
    expect(await source.readMatchRecords(requests)).toEqual([
      first.values[2],
      second.values[0],
      first.values[1],
      first.values[0],
    ]);
    expect(calls).toHaveLength(2);
    expect(
      calls.find((call) => call.inviteId === first.inviteId)?.requests,
    ).toEqual([first.targets[2], first.targets[1], first.targets[0]]);
    expect(calls.every((call) => call.epoch === 2)).toBe(true);
    expect(await source.readMatchRecord(first.targets[2])).toEqual(
      first.values[2],
    );
    expect(calls.at(-1)).toEqual({
      inviteId: first.inviteId,
      epoch: 2,
      requests: [first.targets[2]],
    });
  });

  it("preserves mixed legacy values, duplicate requests and durable records in order", async () => {
    const fixture = await roomFixture();
    await fixture.register([0]);
    const legacyValues = [[1, { legacy: true }], null, false];
    const legacy = legacyValues.map(() => ({
      playerId: "legacy-login",
      matchId: `legacy-${crypto.randomUUID()}`,
    }));
    await db.batch([
      ...buildMatchStateRouteStatements(
        db,
        legacy.map(({ playerId, matchId }) => ({
          actorUid: playerId,
          matchId,
          kind: "legacy",
          inviteId: null,
          epoch: 2,
        })),
      ),
      ...legacy.map(({ playerId, matchId }, index) =>
        db
          .prepare(
            "INSERT INTO match_state_legacy_records VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(
            playerId,
            matchId,
            JSON.stringify(legacyValues[index]),
            "a".repeat(64),
            "record-batch-import",
            "malformed",
          ),
      ),
    ]);
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected-fetch"));
    const { source, calls } = observedSource();
    expect(
      await source.readMatchRecords([
        legacy[2],
        fixture.targets[0],
        legacy[0],
        fixture.targets[1],
        legacy[1],
        legacy[2],
        fixture.targets[0],
        legacy[0],
      ]),
    ).toEqual([
      false,
      fixture.values[0],
      legacyValues[0],
      null,
      null,
      false,
      fixture.values[0],
      legacyValues[0],
    ]);
    for (let index = 0; index < legacy.length; index++) {
      expect(await source.readMatchRecord(legacy[index])).toEqual(
        legacyValues[index],
      );
    }
    expect(await source.readMatchRecord(fixture.targets[1])).toBeNull();
    expect(
      await source.readMatchRecord({
        playerId: "missing-login",
        matchId: `missing-${crypto.randomUUID()}`,
      }),
    ).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].requests).toEqual([fixture.targets[0], fixture.targets[0]]);
    expect(network).not.toHaveBeenCalled();
  });

  it.each(["durable", "legacy"] as const)(
    "fails closed when a %s route has no physical record",
    async (kind) => {
      const fixture = await roomFixture();
      const missing = { playerId: "missing-login", matchId: fixture.inviteId };
      await db.batch(
        buildMatchStateRouteStatements(db, [
          {
            actorUid: missing.playerId,
            matchId: missing.matchId,
            kind,
            inviteId: kind === "durable" ? fixture.inviteId : null,
            epoch: 2,
          },
        ]),
      );
      const { source } = observedSource();
      await expect(source.readMatchRecords([missing])).rejects.toThrow(
        kind === "durable"
          ? "match-state-record-unavailable"
          : "match-state-legacy-record-unavailable",
      );
      await expect(source.readMatchRecord(missing)).rejects.toThrow(
        kind === "durable"
          ? "match-state-record-unavailable"
          : "match-state-legacy-record-unavailable",
      );
    },
  );

  it("allows frozen reads while rejecting stale route epochs before room calls", async () => {
    const fixture = await roomFixture();
    await fixture.register([0]);
    const stale = { playerId: "stale-login", matchId: fixture.inviteId };
    await db.batch(
      buildMatchStateRouteStatements(db, [
        {
          actorUid: stale.playerId,
          matchId: stale.matchId,
          kind: "durable",
          inviteId: fixture.inviteId,
          epoch: 1,
        },
      ]),
    );
    await db
      .prepare(
        "UPDATE match_state_control SET state = 'frozen' WHERE singleton = 1",
      )
      .run();
    const { source, calls } = observedSource();
    expect(await source.readMatchRecords([fixture.targets[0]])).toEqual([
      fixture.values[0],
    ]);
    expect(await source.readMatchRecord(fixture.targets[0])).toEqual(
      fixture.values[0],
    );
    const callsBefore = calls.length;
    await expect(source.readMatchRecords([stale])).rejects.toThrow(
      "match-state-route-epoch-conflict",
    );
    await expect(source.readMatchRecord(stale)).rejects.toThrow(
      "match-state-route-epoch-conflict",
    );
    expect(calls).toHaveLength(callsBefore);
  });
});
