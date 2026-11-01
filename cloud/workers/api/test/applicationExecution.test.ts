import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationWorkflowStep,
  currentApplicationAdmission,
  runApplicationOperation,
  scopedApplicationEnv,
} from "../src/applicationExecution.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";
import { notifyEventUpdates } from "../src/eventUpdatesNotifications.ts";
import { readApplicationRpcAdmission } from "../src/applicationRoomRpc.ts";

test("execution waits for waitUntil work before releasing its admission", async () => {
  const statements: string[] = [];
  const database = new Proxy(TELEGRAM_TEST_ENV.PROFILE_GAMES_DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          statements.push(sql);
          return target.prepare(sql);
        };
      const value: unknown = Reflect.get(target, property, target);
      return value;
    },
  });
  const background: Promise<unknown>[] = [];
  const pending = Promise.withResolvers<void>();
  const result = await runApplicationOperation(
    { ...TELEGRAM_TEST_ENV, PROFILE_GAMES_DB: database },
    "http",
    1,
    async (_env, ctx) => {
      assert.ok(currentApplicationAdmission());
      ctx?.waitUntil(pending.promise);
      return "response";
    },
    {
      waitUntil: (promise: Promise<unknown>) => {
        background.push(promise);
      },
    },
  );
  assert.equal(result, "response");
  assert.equal(currentApplicationAdmission(), undefined);
  assert.equal(
    statements.some((sql) =>
      sql.startsWith("DELETE FROM application_data_admissions"),
    ),
    false,
  );
  pending.resolve();
  await Promise.all(background);
  assert.equal(
    statements.some((sql) =>
      sql.startsWith("DELETE FROM application_data_admissions"),
    ),
    true,
  );
});

test("lazy Workflow repositories cannot write outside an admitted step", async () => {
  const env = scopedApplicationEnv(TELEGRAM_TEST_ENV);
  const statement = env.PROFILE_DB.prepare("UPDATE balances SET amount = 10");
  await assert.rejects(statement.run(), /application-data-unavailable/);
  const native = {
    calls: 0,
    async do<T>(_name: string, work: () => Promise<T>): Promise<T> {
      this.calls++;
      assert.equal(currentApplicationAdmission(), undefined);
      return work();
    },
    async sleep() {
      assert.equal(currentApplicationAdmission(), undefined);
    },
  };
  const step = applicationWorkflowStep(native, TELEGRAM_TEST_ENV, 1);
  const result = await step.do("business write", async () => {
    assert.ok(currentApplicationAdmission());
    return (await statement.run()).success;
  });
  assert.equal(result, true);
  assert.equal(native.calls, 1);
  assert.equal(currentApplicationAdmission(), undefined);
  await step.sleep();
  await assert.rejects(statement.run(), /application-data-unavailable/);
});

test("staging without an event-update binding preserves optional notifications", async () => {
  const staging = new Proxy(TELEGRAM_TEST_ENV, {
    get(target, property) {
      return property === "EVENT_UPDATES"
        ? undefined
        : Reflect.get(target, property, target);
    },
  });
  const scoped = scopedApplicationEnv(staging);
  assert.equal(scoped.EVENT_UPDATES, undefined);
  await notifyEventUpdates(
    scoped,
    { "event-one": 1 },
    {
      logFailure: () =>
        assert.fail("absent binding is not a notification failure"),
    },
  );
  await runApplicationOperation(staging, "http", 1, async (admitted) => {
    assert.equal(admitted.EVENT_UPDATES, undefined);
    await notifyEventUpdates(admitted, { "event-one": 1 });
  });
});

test("configured event-update namespaces retain application admission fencing", async () => {
  const calls: unknown[][] = [];
  const namespace = new Proxy(TELEGRAM_TEST_ENV.EVENT_UPDATES, {
    get(target, property) {
      if (property === "getByName")
        return (name: string) => {
          assert.equal(name, "event-one");
          return {
            async notifyEventChanged(...args: unknown[]) {
              readApplicationRpcAdmission(args[3]);
              calls.push(args);
            },
          };
        };
      return Reflect.get(target, property, target);
    },
  });
  const configured = { ...TELEGRAM_TEST_ENV, EVENT_UPDATES: namespace };
  const scoped = scopedApplicationEnv(configured);
  const notify = () =>
    scoped.EVENT_UPDATES.getByName("event-one").notifyEventChanged(
      "event-one",
      configured.EVENT_DB_BOOKMARK_EPOCH,
      4,
    );
  assert.throws(notify, /application-data-unavailable/);
  await runApplicationOperation(configured, "http", 1, async () => {
    const admission = currentApplicationAdmission();
    await notify();
    assert.deepEqual(calls, [
      ["event-one", configured.EVENT_DB_BOOKMARK_EPOCH, 4, admission],
    ]);
  });
  assert.throws(notify, /application-data-unavailable/);
  assert.equal(calls.length, 1);
});
