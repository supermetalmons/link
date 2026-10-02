import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureInviteRoomSchema } from "../src/inviteRoomSchema.ts";
import { MatchStateStore } from "../src/matchStateStore.ts";
import { LEGACY_INVITE_ROOM_SCHEMA } from "./legacyInviteRoomSchemaFixture.ts";
import { seedRetainedMatchState } from "./retainedMatchStateFixture.ts";

const VERSION_KEY = "invite-room:schema-version";

function fixture() {
  return env.INVITE_REACTIONS.getByName(`schema-${crypto.randomUUID()}`);
}

function schema(storage: DurableObjectStorage) {
  return storage.sql
    .exec<{ name: string; type: string; sql: string }>(
      `SELECT name, type, sql FROM sqlite_schema
       WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_*'
       ORDER BY type, name`,
    )
    .toArray();
}

function snapshot(storage: DurableObjectStorage) {
  const objects = schema(storage);
  return {
    schema: objects,
    rows: Object.fromEntries(
      objects
        .filter(({ type }) => type === "table")
        .map(({ name }) => [
          name,
          storage.sql.exec(`SELECT * FROM "${name}" ORDER BY rowid`).toArray(),
        ]),
    ),
  };
}

function seedLegacyRows(storage: DurableObjectStorage) {
  for (const statement of LEGACY_INVITE_ROOM_SCHEMA)
    storage.sql.exec(statement);
  seedRetainedMatchState(storage, {
    inviteId: "legacy-invite",
    epoch: 3,
    importId: "retained-import",
    records: [
      {
        matchId: "legacy-match",
        playerId: "host",
        value: { color: "white", fen: "retained", extra: { retained: true } },
      },
    ],
    claims: [{ matchId: "legacy-match", value: { status: "claimed" } }],
  });
  storage.sql.exec(`
    INSERT INTO invite_metadata VALUES (1, 'legacy-invite', '{"metadata":"retained"}', 7);
    INSERT INTO invite_wagers VALUES (1, 'legacy-invite', '{"wager":"retained"}', 9, 'fingerprint');
    INSERT INTO invite_refresh_schedule VALUES (1, 2000000000000);
    INSERT INTO match_presentations VALUES ('legacy-match', 'host', 4, 'aura', 5, 'operation', '{"retained":true}');
    INSERT INTO frozen_match_presentations VALUES ('legacy-match', 'host', 3, 'frozen-aura', 4);
    INSERT INTO match_presentation_seeds VALUES ('legacy-match', 'host', 'legacy-invite', 'digest', 2, 'seed-aura', 'retained', 'source');
    INSERT INTO latest_reactions VALUES ('host', '{"reaction":"retained"}');
    INSERT INTO match_state_revisions VALUES ('legacy-match', 8);
    INSERT INTO match_state_effects VALUES ('pending', '{"effect":"pending"}', 2000000000001, 2, NULL);
    INSERT INTO match_state_effects VALUES ('complete', '{"effect":"complete"}', NULL, 3, 1900000000000);
    INSERT INTO match_state_event_receipts VALUES ('receipt', '{"receipt":"retained"}');
    INSERT INTO match_state_timer_cohorts VALUES ('legacy-match', 'local', 1);
    INSERT INTO match_state_timer_cohorts VALUES ('d1-match', 'd1', 1);
    INSERT INTO match_state_timer_starts VALUES ('legacy-match', 'host', 'guest', 'retained-timer', 11, 1900000000001);
    INSERT INTO match_sync_snapshots VALUES ('legacy-match', '{"snapshot":"retained"}', 12, 2000000000002);
  `);
  storage.kv.put("unrelated-key", { retained: true });
}

function expectCompleteSchema(storage: DurableObjectStorage) {
  const objects = schema(storage);
  expect(objects.filter(({ type }) => type === "table")).toHaveLength(16);
  expect(
    objects.filter(({ type }) => type === "index").map(({ name }) => name),
  ).toEqual(["match_state_effects_due"]);
  expect(storage.kv.get(VERSION_KEY)).toBe(1);
}

function forbidInitializationWork(storage: DurableObjectStorage) {
  const kv = new Proxy(storage.kv, {
    get(target, property) {
      if (property !== "get")
        throw new Error(`unexpected-kv-${String(property)}`);
      return target.get.bind(target);
    },
  });
  return new Proxy(storage, {
    get(target, property) {
      if (property === "kv") return kv;
      if (property === "sql" || property === "transactionSync")
        throw new Error(`unexpected-${String(property)}`);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("invite room schema initialization", () => {
  it("initializes genuinely empty storage before store operations", async () => {
    await runInDurableObject(fixture(), async (_instance, { storage }) => {
      await storage.deleteAll();
      expect(schema(storage)).toEqual([]);
      expect(storage.kv.get(VERSION_KEY)).toBeUndefined();

      ensureInviteRoomSchema(storage);
      expectCompleteSchema(storage);
      const store = new MatchStateStore(storage, {
        timerStarts: {
          getOrAdvance: async () => {
            throw new Error("unexpected-timer-write");
          },
          deletePair: async () => {
            throw new Error("unexpected-timer-write");
          },
        },
        newMatchTimerStorage: "local",
      });
      const input = {
        inviteId: "fresh-invite",
        matchId: "fresh-invite",
        playerId: "host",
        epoch: 1,
      };
      store.createRecords({
        ...input,
        records: [
          {
            matchId: input.matchId,
            playerId: input.playerId,
            marker: "created",
            value: { color: "white", fen: "initial", flatMovesString: "" },
          },
        ],
      });
      expect(store.readRecord(input)).toMatchObject({ fen: "initial" });
      expect(
        storage.sql.exec("SELECT mode FROM match_state_timer_cohorts").one(),
      ).toEqual({ mode: "local" });
    });
  });

  it("adopts all legacy rows and retained staging tables without rewriting them", async () => {
    await runInDurableObject(fixture(), async (_instance, { storage }) => {
      await storage.deleteAll();
      seedLegacyRows(storage);
      const before = snapshot(storage);
      expect(storage.kv.get(VERSION_KEY)).toBeUndefined();

      ensureInviteRoomSchema(storage);

      expect(snapshot(storage)).toEqual(before);
      expect(storage.kv.get(VERSION_KEY)).toBe(1);
      expect(storage.kv.get("unrelated-key")).toEqual({ retained: true });
    });
  });

  it.each([
    ["invite metadata", "CREATE TABLE IF NOT EXISTS invite_metadata "],
    ["match records", "CREATE TABLE IF NOT EXISTS match_state_records "],
    ["presentations", "CREATE TABLE IF NOT EXISTS match_presentations "],
  ])("completes a partial schema containing %s", async (_label, prefix) => {
    await runInDurableObject(fixture(), async (_instance, { storage }) => {
      await storage.deleteAll();
      const statement = LEGACY_INVITE_ROOM_SCHEMA.find((sql) =>
        sql.startsWith(prefix),
      );
      expect(statement).toBeDefined();
      storage.sql.exec(statement!);
      if (prefix.includes("invite_metadata "))
        storage.sql.exec(
          "INSERT INTO invite_metadata VALUES (1, 'retained', '{}', 7)",
        );
      else if (prefix.includes("match_state_records "))
        storage.sql.exec(
          "INSERT INTO match_state_records VALUES ('match', 'host', '{}')",
        );
      else
        storage.sql.exec(
          "INSERT INTO match_presentations VALUES ('match', 'host', 1, '', 2, NULL, NULL)",
        );
      const before = snapshot(storage);

      ensureInviteRoomSchema(storage);

      expectCompleteSchema(storage);
      expect(snapshot(storage).rows).toMatchObject(before.rows);
      expect(schema(storage)).toEqual(expect.arrayContaining(before.schema));
    });
  });

  it("preserves persisted rows when the production constructor runs after eviction", async () => {
    const room = fixture();
    const before = await runInDurableObject(
      room,
      async (_instance, { storage }) => {
        await storage.deleteAll();
        seedLegacyRows(storage);
        ensureInviteRoomSchema(storage);
        return snapshot(storage);
      },
    );
    await evictDurableObject(room);
    await runInDurableObject(room, (_instance, { storage }) => {
      expect(snapshot(storage)).toEqual(before);
      expect(storage.kv.get(VERSION_KEY)).toBe(1);
    });
  });

  it("does no SQL, transaction, or KV writes for the current version", async () => {
    await runInDurableObject(fixture(), async (_instance, { storage }) => {
      await storage.deleteAll();
      ensureInviteRoomSchema(storage);
      const before = snapshot(storage);

      ensureInviteRoomSchema(forbidInitializationWork(storage));

      expect(snapshot(storage)).toEqual(before);
      expect(storage.kv.get(VERSION_KEY)).toBe(1);
    });
  });

  it.each([0, 2, "1", null, false, { version: 1 }])(
    "rejects an unsupported marker %j without changing storage",
    async (version) => {
      await runInDurableObject(fixture(), async (_instance, { storage }) => {
        await storage.deleteAll();
        storage.kv.put(VERSION_KEY, version);

        expect(() =>
          ensureInviteRoomSchema(forbidInitializationWork(storage)),
        ).toThrow("invite-room-schema-version-unsupported");

        expect(schema(storage)).toEqual([]);
        expect(storage.kv.get(VERSION_KEY)).toEqual(version);
      });
    },
  );

  it("rolls back partial DDL after a real SQL failure and allows retry", async () => {
    await runInDurableObject(fixture(), async (_instance, { storage }) => {
      await storage.deleteAll();
      storage.sql.exec("CREATE TABLE match_state_effects_due (retained TEXT)");
      storage.sql.exec(
        "INSERT INTO match_state_effects_due VALUES ('unchanged')",
      );
      storage.kv.put("unrelated-key", "unchanged");
      const before = snapshot(storage);

      expect(() => ensureInviteRoomSchema(storage)).toThrow();

      expect(snapshot(storage)).toEqual(before);
      expect(storage.kv.get(VERSION_KEY)).toBeUndefined();
      expect(storage.kv.get("unrelated-key")).toBe("unchanged");
      storage.sql.exec("DROP TABLE match_state_effects_due");
      ensureInviteRoomSchema(storage);
      expectCompleteSchema(storage);
    });
  });

  it("rolls back the version marker together with DDL and retries cleanly", async () => {
    await runInDurableObject(fixture(), async (_instance, { storage }) => {
      await storage.deleteAll();
      storage.kv.put("unrelated-key", "unchanged");

      expect(() =>
        storage.transactionSync(() => {
          ensureInviteRoomSchema(storage);
          expect(storage.kv.get(VERSION_KEY)).toBe(1);
          throw new Error("injected-after-initialization");
        }),
      ).toThrow("injected-after-initialization");

      expect(schema(storage)).toEqual([]);
      expect(storage.kv.get(VERSION_KEY)).toBeUndefined();
      expect(storage.kv.get("unrelated-key")).toBe("unchanged");
      ensureInviteRoomSchema(storage);
      expectCompleteSchema(storage);
    });
  });
});
