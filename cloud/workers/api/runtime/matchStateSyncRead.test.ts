import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MatchStateStore } from "../src/matchStateStore.ts";
import type { MatchStateSyncReadRequest } from "../src/matchStateTypes.ts";

type SqlCall = {
  query: string;
  cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
};

function observedStore(storage: DurableObjectStorage) {
  const calls: SqlCall[] = [];
  const sql = new Proxy(storage.sql, {
    get(target, property) {
      if (property === "exec")
        return (query: string, ...bindings: unknown[]) => {
          const cursor = target.exec(query, ...bindings);
          calls.push({ query, cursor });
          return cursor;
        };
      return Reflect.get(target, property, target);
    },
  });
  const measured = new Proxy(storage, {
    get(target, property) {
      if (property === "sql") return sql;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const store = new MatchStateStore(measured, {
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

function fixture(
  work: (
    input: MatchStateSyncReadRequest,
    storage: DurableObjectStorage,
  ) => void,
) {
  const inviteId = `sync-read-${crypto.randomUUID()}`;
  const room = env.INVITE_REACTIONS.getByName(inviteId);
  return runInDurableObject(room, (_instance, state) => {
    work(
      {
        inviteId,
        epoch: 1,
        matchId: inviteId,
        playerId: "host-login",
        opponentId: "guest-login",
      },
      state.storage,
    );
  });
}

function createPair(store: MatchStateStore, input: MatchStateSyncReadRequest) {
  return store.createRecords({
    ...input,
    records: [
      {
        matchId: input.matchId,
        playerId: input.playerId,
        marker: "host-created",
        value: { color: "white", fen: "initial", flatMovesString: "" },
      },
      {
        matchId: input.matchId,
        playerId: input.opponentId!,
        marker: "guest-created",
        value: { color: "black", fen: "initial", flatMovesString: "" },
      },
    ],
  });
}

afterEach(() => vi.restoreAllMocks());

describe("conditional canonical sync reads", () => {
  it("checks authority and revision without reading or parsing unchanged records", async () => {
    await fixture((input, storage) => {
      const { store, calls } = observedStore(storage);
      createPair(store, input);
      storage.sql.exec(
        "INSERT INTO match_state_claims(match_id, value_json) VALUES (?, ?)",
        input.matchId,
        '{"status":"claimed"}',
      );
      calls.length = 0;
      const pair = store.readPair(input);
      expect(calls).toHaveLength(5);
      const payloads = new Set(
        storage.sql
          .exec<{ value_json: string }>(
            "SELECT value_json FROM match_state_records WHERE match_id = ?",
            input.matchId,
          )
          .toArray()
          .map(({ value_json }) => value_json),
      );
      const parse = vi.spyOn(JSON, "parse");
      calls.length = 0;
      expect(
        store.readSyncState({ ...input, knownRevision: pair.revision }),
      ).toEqual({
        status: "unchanged",
        epoch: input.epoch,
        revision: pair.revision,
      });
      expect(calls).toHaveLength(2);
      expect(calls[0].query).toContain("FROM match_state_source");
      expect(calls[1].query).toContain("FROM match_state_revisions");
      expect(
        calls.reduce((total, call) => total + call.cursor.rowsRead, 0),
      ).toBe(2);
      expect(parse.mock.calls.some(([value]) => payloads.has(value))).toBe(
        false,
      );
      expect(
        calls.some(({ query }) => /match_state_(records|claims)/.test(query)),
      ).toBe(false);
    });
  });

  it("reads records synchronously when cold or changed and never loads claims", async () => {
    await fixture((input, storage) => {
      const { store, calls } = observedStore(storage);
      const created = createPair(store, input);
      storage.sql.exec(
        "INSERT INTO match_state_claims(match_id, value_json) VALUES (?, ?)",
        input.matchId,
        "invalid-json",
      );
      calls.length = 0;
      const cold = store.readSyncState(input);
      expect(cold).toEqual({
        status: "changed",
        epoch: input.epoch,
        revision: 1,
        playerMatch: created.records[0].value,
        opponentMatch: created.records[1].value,
      });
      expect(calls).toHaveLength(4);
      expect(
        calls.filter(({ query }) => query.includes("FROM match_state_records")),
      ).toHaveLength(2);
      expect(
        calls.some(({ query }) => query.includes("match_state_claims")),
      ).toBe(false);
      storage.sql.exec(
        "DELETE FROM match_state_claims WHERE match_id = ?",
        input.matchId,
      );
      store.move({
        inviteId: input.inviteId,
        epoch: input.epoch,
        matchId: input.matchId,
        playerId: input.playerId,
        previousFlatMovesString: "",
        flatMovesString: "a",
        fen: "moved",
      });
      calls.length = 0;
      expect(
        store.readSyncState({ ...input, knownRevision: cold.revision }),
      ).toMatchObject({
        status: "changed",
        revision: cold.revision + 1,
        playerMatch: { fen: "moved" },
      });
      expect(calls).toHaveLength(4);
      expect(
        calls.some(({ query }) => query.includes("match_state_claims")),
      ).toBe(false);
      calls.length = 0;
      expect(store.readSyncState({ ...input, opponentId: null })).toMatchObject(
        {
          status: "changed",
          opponentMatch: null,
        },
      );
      expect(calls).toHaveLength(3);
    });
  });

  it("supports retained revision-zero and missing records without treating cold reads as unchanged", async () => {
    await fixture((input, storage) => {
      const { store } = observedStore(storage);
      createPair(store, input);
      storage.sql.exec(
        "DELETE FROM match_state_revisions WHERE match_id = ?",
        input.matchId,
      );
      expect(store.readSyncState(input)).toMatchObject({
        status: "changed",
        revision: 0,
        playerMatch: { fen: "initial" },
      });
      expect(store.readSyncState({ ...input, knownRevision: 0 })).toEqual({
        status: "unchanged",
        epoch: input.epoch,
        revision: 0,
      });
      expect(
        store.readSyncState({ ...input, matchId: `${input.matchId}1` }),
      ).toEqual({
        status: "changed",
        epoch: input.epoch,
        revision: 0,
        playerMatch: null,
        opponentMatch: null,
      });
    });
  });

  it("validates authority and targets before accepting a matching revision", async () => {
    await fixture((input, storage) => {
      const { store, calls } = observedStore(storage);
      createPair(store, input);
      const known = { ...input, knownRevision: store.readPair(input).revision };
      const invalid = [
        { epoch: input.epoch + 1 },
        { inviteId: "different-invite" },
        { matchId: "different-invite" },
        { playerId: "bad/player" },
        { opponentId: input.playerId },
        { opponentId: "bad/opponent" },
      ];
      for (const changes of invalid) {
        calls.length = 0;
        expect(() => store.readSyncState({ ...known, ...changes })).toThrow();
        expect(
          calls.some(({ query }) =>
            /match_state_(records|claims|revisions)/.test(query),
          ),
        ).toBe(false);
      }
      storage.sql.exec(
        "UPDATE match_state_source SET active_epoch = NULL WHERE singleton = 1",
      );
      calls.length = 0;
      expect(() => store.readSyncState(known)).toThrow(
        "match-state-authority-unavailable",
      );
      expect(calls).toHaveLength(1);
    });
  });

  it("rejects invalid revision hints before any storage reads", async () => {
    await fixture((input, storage) => {
      const { store, calls } = observedStore(storage);
      for (const knownRevision of [
        -1,
        0.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        null,
        "1",
      ]) {
        expect(() =>
          store.readSyncState({
            ...input,
            knownRevision,
          } as MatchStateSyncReadRequest),
        ).toThrow("match-state-invalid-revision");
        expect(calls).toHaveLength(0);
      }
    });
  });
});
