import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationWorkflowStep,
  currentApplicationAdmission,
  runApplicationOperation,
  scopedApplicationEnv,
} from "../src/applicationExecution.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

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
