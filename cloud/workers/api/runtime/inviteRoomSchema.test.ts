import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  assertLocalInviteRoomLayout,
  ensureCanonicalInviteRoomSchema,
  ensureInviteRoomSchema,
} from "../src/inviteRoomSchema.ts";
import { initializeApplicationObjectControl } from "../src/applicationObjectStorage.ts";
import { MatchWriterStore } from "../src/matchWriterStore.ts";
import { MatchStateStore } from "../src/matchStateStore.ts";
import { matchDocumentFixture } from "../test/matchRecordFixture.ts";
import { activateCanonicalApplicationFixture } from "./applicationRoomFixture.ts";
import {
  currentApplicationAdmission,
  runApplicationOperation,
} from "../src/applicationExecution.ts";
import { APPLICATION_ADMISSION_HEADER } from "../src/applicationRoomRpc.ts";

const VERSION_KEY = "invite-room:schema-version";
const INDEX_KEY = "invite-room:match-sync-due-index";
const LAYOUT_KEY = "invite-room:timer-layout-version";

function room() {
  return env.INVITE_REACTIONS.getByName(`strict-schema-${crypto.randomUUID()}`);
}
function tables(storage: DurableObjectStorage) {
  return storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name",
    )
    .toArray()
    .map((row) => row.name);
}
function snapshot(storage: DurableObjectStorage) {
  return {
    schema: storage.sql
      .exec(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name",
      )
      .toArray(),
    rows: Object.fromEntries(
      tables(storage).map((name) => [
        name,
        storage.sql.exec(`SELECT * FROM "${name}"`).toArray(),
      ]),
    ),
    keys: Array.from(storage.kv.list()),
  };
}
async function bootstrap(storage: DurableObjectStorage) {
  await initializeApplicationObjectControl(storage, {
    kind: "business",
    generation: 3,
    dataEpoch: 1,
    operationId: "schema-fixture",
  });
  ensureInviteRoomSchema(storage, { fresh: true });
  const writer = new MatchWriterStore(storage);
  writer.initializeFreshLocalLayout();
  return writer;
}
function oldSchemaWithClaimedStamp(storage: DurableObjectStorage) {
  ensureCanonicalInviteRoomSchema(storage);
  storage.kv.put(VERSION_KEY, 1);
  storage.kv.put(INDEX_KEY, 1);
  storage.kv.put(LAYOUT_KEY, 2);
}

describe("strict local invite room schema", () => {
  it.each(["after-control", "after-layout"])(
    "rolls back a fresh %s bootstrap failure and retries without treating partial state as existing",
    async (stage) => {
      await activateCanonicalApplicationFixture();
      await runInDurableObject(room(), async (instance, ctx) => {
        const original: unknown = Reflect.get(instance, "initializeRuntime");
        if (typeof original !== "function")
          throw new Error("initializer-missing");
        Reflect.set(instance, "initializeRuntime", (...args: unknown[]) => {
          expect(tables(ctx.storage)).toContain("application_data_control");
          if (stage === "after-layout") Reflect.apply(original, instance, args);
          throw new Error("injected-fresh-bootstrap-failure");
        });
        await runApplicationOperation(env, "http", 1, async () => {
          const admission = currentApplicationAdmission();
          if (!admission) throw new Error("fixture-admission-missing");
          const request = () =>
            new Request("https://room.internal", {
              headers: {
                [APPLICATION_ADMISSION_HEADER]: JSON.stringify(admission),
              },
            });
          await expect(instance.fetch(request())).rejects.toThrow(
            "injected-fresh-bootstrap-failure",
          );
          expect(tables(ctx.storage)).toEqual([]);
          expect(Array.from(ctx.storage.kv.list())).toEqual([]);
          expect(await ctx.storage.getAlarm()).toBeNull();
          expect(Reflect.get(instance, "matchWriterStore")).toBeNull();
          Reflect.set(instance, "initializeRuntime", original);
          const response = await instance.fetch(request());
          expect(response.status).toBe(426);
          expect(ctx.storage.kv.get(LAYOUT_KEY)).toBe(2);
          expect(ctx.storage.kv.get("invite-room:writer-fence-version")).toBe(
            2,
          );
          assertLocalInviteRoomLayout(ctx.storage);
        });
      });
    },
  );

  it("initializes a genuinely fresh local layout with its permanent writer guards before creation", async () => {
    await runInDurableObject(room(), async (instance, ctx) => {
      expect("canonicalCleanup" in instance).toBe(false);
      expect(tables(ctx.storage)).toEqual([]);
      const writer = await bootstrap(ctx.storage);
      expect(ctx.storage.kv.get(VERSION_KEY)).toBe(1);
      expect(ctx.storage.kv.get(INDEX_KEY)).toBe(1);
      expect(ctx.storage.kv.get(LAYOUT_KEY)).toBe(2);
      expect(ctx.storage.kv.get("invite-room:writer-fence-version")).toBe(2);
      expect(
        tables(ctx.storage).filter((name) => name.endsWith("_canonical")),
      ).toHaveLength(16);
      const request = {
        inviteId: "fresh-invite",
        epoch: 1,
        records: [
          {
            matchId: "fresh-invite",
            playerId: "host",
            marker: "created",
            value: matchDocumentFixture({ color: "white" }),
          },
        ],
      };
      const store = new MatchStateStore(writer.guardStorage(), {});
      await writer.runWriter({ kind: "create", request }, () =>
        store.createRecords(request),
      );
      expect(
        ctx.storage.sql
          .exec("SELECT mode FROM match_state_timer_cohorts_canonical")
          .one().mode,
      ).toBe("local");
      expect(() =>
        ctx.storage.sql.exec(
          "UPDATE match_state_revisions_canonical SET revision = revision + 1",
        ),
      ).toThrow("timer-handoff-writer-fenced");
    });
  });

  it("keeps verified canonical data, cold evidence, KV and alarms unchanged on existing-room validation", async () => {
    await runInDurableObject(room(), async (_instance, ctx) => {
      await bootstrap(ctx.storage);
      ctx.storage.sql.exec(
        "CREATE TABLE match_state_records(id TEXT PRIMARY KEY, value TEXT); INSERT INTO match_state_records VALUES ('old','immutable source')",
      );
      ctx.storage.kv.put("retained-key", { source: true });
      const alarm = Date.now() + 120_000;
      await ctx.storage.setAlarm(alarm);
      const before = snapshot(ctx.storage);
      ensureInviteRoomSchema(ctx.storage);
      assertLocalInviteRoomLayout(ctx.storage);
      expect(snapshot(ctx.storage)).toEqual(before);
      expect(await ctx.storage.getAlarm()).toBe(alarm);
    });
  });

  it("rejects unverified existing storage without creating canonical tables or a layout stamp", async () => {
    await runInDurableObject(room(), (_instance, ctx) => {
      ctx.storage.sql.exec(
        "CREATE TABLE old_records(id TEXT PRIMARY KEY, value TEXT); INSERT INTO old_records VALUES ('saved','evidence')",
      );
      ctx.storage.kv.put("legacy", { retained: true });
      const before = snapshot(ctx.storage);
      expect(() => ensureInviteRoomSchema(ctx.storage)).toThrow(
        "invite-room-timer-layout-unverified",
      );
      expect(snapshot(ctx.storage)).toEqual(before);
    });
  });

  it("rejects a missing canonical table instead of recreating an empty replacement", async () => {
    await runInDurableObject(room(), async (_instance, ctx) => {
      await bootstrap(ctx.storage);
      ctx.storage.sql.exec("DROP TABLE match_state_timer_starts_canonical");
      const before = snapshot(ctx.storage);
      expect(() => ensureInviteRoomSchema(ctx.storage)).toThrow(
        "invite-room-canonical-schema-incomplete",
      );
      expect(snapshot(ctx.storage)).toEqual(before);
    });
  });

  it("rejects an old D1 cohort even if a corrupt or forged layout stamp exists", async () => {
    await runInDurableObject(room(), (_instance, ctx) => {
      oldSchemaWithClaimedStamp(ctx.storage);
      ctx.storage.sql.exec(
        "INSERT INTO match_state_timer_cohorts_canonical VALUES ('old-match','d1',1)",
      );
      const before = snapshot(ctx.storage);
      expect(() => ensureInviteRoomSchema(ctx.storage)).toThrow(
        "invite-room-timer-layout-invalid",
      );
      expect(snapshot(ctx.storage)).toEqual(before);
    });
  });

  it("rejects local markers whose cohort is missing without moving or deleting them", async () => {
    await runInDurableObject(room(), (_instance, ctx) => {
      oldSchemaWithClaimedStamp(ctx.storage);
      ctx.storage.sql.exec(
        "INSERT INTO match_state_timer_starts_canonical VALUES ('match','host','guest',100,1,10)",
      );
      const before = snapshot(ctx.storage);
      expect(() => ensureInviteRoomSchema(ctx.storage)).toThrow(
        "invite-room-timer-layout-invalid",
      );
      expect(snapshot(ctx.storage)).toEqual(before);
    });
  });

  it("requires retained schema metadata on existing rooms instead of repairing it silently", async () => {
    await runInDurableObject(room(), async (_instance, ctx) => {
      await bootstrap(ctx.storage);
      ctx.storage.kv.delete(INDEX_KEY);
      const before = snapshot(ctx.storage);
      expect(() => ensureInviteRoomSchema(ctx.storage)).toThrow(
        "invite-room-schema-metadata-missing",
      );
      expect(snapshot(ctx.storage)).toEqual(before);
    });
  });

  it.each([VERSION_KEY, INDEX_KEY])(
    "rejects unsupported %s metadata without writes",
    async (key) => {
      await runInDurableObject(room(), async (_instance, ctx) => {
        await bootstrap(ctx.storage);
        ctx.storage.kv.put(key, 3);
        const before = snapshot(ctx.storage);
        expect(() => ensureInviteRoomSchema(ctx.storage)).toThrow(
          "unsupported",
        );
        expect(snapshot(ctx.storage)).toEqual(before);
      });
    },
  );
});
