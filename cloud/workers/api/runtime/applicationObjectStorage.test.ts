import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  fenceApplicationObjectStorage,
  initializeApplicationObjectControl,
} from "../src/applicationObjectStorage.ts";
import {
  applicationWriteFenceSql,
  type ApplicationWriteContext,
} from "../src/applicationDataControl.ts";

describe("application object storage fence", () => {
  it("does not initialize business state merely by constructing an object", async () => {
    const stub = env.INVITE_REACTIONS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'",
          )
          .toArray(),
      ).toEqual([]);
      expect(Array.from(state.storage.kv.list())).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("fences SQL, KV and alarms after a generation changes and retains write cursors", async () => {
    const stub = env.INVITE_REACTIONS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      let context: ApplicationWriteContext = {
        kind: "business",
        generation: 1,
        dataEpoch: 1,
        operationId: "original",
      };
      await initializeApplicationObjectControl(state.storage, context);
      state.storage.sql.exec(
        "CREATE TABLE balances (id TEXT PRIMARY KEY, amount INTEGER NOT NULL) STRICT",
      );
      state.storage.sql.exec(applicationWriteFenceSql("balances"));
      const guarded = fenceApplicationObjectStorage(
        state.storage,
        () => context,
      );
      const result = guarded.sql.exec(
        "INSERT INTO balances VALUES ('first', 10), ('second', 20) RETURNING id, amount",
      );
      expect(result.toArray()).toHaveLength(2);
      expect(
        state.storage.sql
          .exec("SELECT * FROM application_write_context")
          .toArray(),
      ).toEqual([]);
      guarded.transactionSync(() => {
        guarded.sql.exec("UPDATE balances SET amount = amount + 1");
        guarded.kv.put("version", 1);
      });
      expect(guarded.kv.get("version")).toBe(1);
      state.storage.sql.exec(
        "UPDATE application_data_control SET generation = 2, phase = 'closed', migration_id = 'migration'",
      );
      expect(() => guarded.sql.exec("UPDATE balances SET amount = 0")).toThrow(
        "application-data-unavailable",
      );
      expect(() => guarded.kv.put("version", 2)).toThrow(
        "application-data-unavailable",
      );
      expect(() => guarded.setAlarm(Date.now() + 60_000)).toThrow(
        "application-data-unavailable",
      );
      context = {
        kind: "migration",
        generation: 2,
        dataEpoch: 1,
        operationId: "convert",
        migrationId: "migration",
      };
      guarded.sql.exec("UPDATE balances SET amount = amount + 1");
      expect(
        guarded.sql.exec("SELECT SUM(amount) AS total FROM balances").one()
          .total,
      ).toBe(34);
      expect(() =>
        guarded.transactionSync(() => {
          guarded.sql.exec("UPDATE balances SET amount = 0");
          throw new Error("abort conversion");
        }),
      ).toThrow("abort conversion");
      expect(
        guarded.sql.exec("SELECT SUM(amount) AS total FROM balances").one()
          .total,
      ).toBe(34);
      expect(
        state.storage.sql
          .exec("SELECT * FROM application_write_context")
          .toArray(),
      ).toEqual([]);
    });
  });

  it("rejects unmigrated object data instead of initializing a canonical control around it", async () => {
    const stub = env.INVITE_REACTIONS.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put("old-record", { retained: true });
      await expect(
        initializeApplicationObjectControl(state.storage, {
          kind: "business",
          generation: 1,
          dataEpoch: 1,
          operationId: "new",
        }),
      ).rejects.toThrow("application-data-unavailable");
      expect(
        state.storage.sql
          .exec(
            "SELECT name FROM sqlite_schema WHERE name = 'application_data_control'",
          )
          .toArray(),
      ).toEqual([]);
      expect(state.storage.kv.get("old-record")).toEqual({ retained: true });
    });
  });
});
