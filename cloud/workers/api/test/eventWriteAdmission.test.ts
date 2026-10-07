import assert from "node:assert/strict";
import test from "node:test";
import {
  EventWritesDisabled,
  type EventD1Connection,
  type EventWriteAdmission,
} from "../src/eventD1/types.ts";
import { withEventWriteAdmission } from "../src/eventWriteAdmission.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

type Outcome<T> = { value: T } | { error: unknown };
type Policy = "mutation" | "dispatch" | "match-effect";

function database({
  acquire = { value: true },
  release = { value: true },
}: {
  acquire?: Outcome<boolean>;
  release?: Outcome<boolean>;
} = {}) {
  const operations: string[] = [];
  let admissionId: unknown;
  const db: EventD1Connection = {
    batch: () => assert.fail("unexpected-batch"),
    prepare(sql) {
      const acquiring = sql.trimStart().startsWith("INSERT");
      assert.match(
        sql,
        acquiring
          ? /INTO event_write_admissions/
          : /^DELETE FROM event_write_admissions/,
      );
      const source = TELEGRAM_TEST_ENV.EVENT_DB.prepare(sql);
      const statement: D1PreparedStatement = {
        ...source,
        first: () => assert.fail("unexpected-first"),
        raw: source.raw.bind(source),
        bind(...values) {
          if (acquiring) admissionId = values[0];
          else assert.equal(values[0], admissionId);
          return statement;
        },
        async all<T>() {
          assert.equal(acquiring, true);
          operations.push("acquire");
          if ("error" in acquire) throw acquire.error;
          return {
            ...(await source.all<T>()),
            results: (acquire.value ? [{ freeze_generation: 7 }] : []) as T[],
          };
        },
        async run<T>() {
          assert.equal(acquiring, false);
          operations.push("release");
          if ("error" in release) throw release.error;
          const result = await source.run<T>();
          return {
            ...result,
            meta: { ...result.meta, changes: release.value ? 1 : 0 },
          };
        },
      };
      return statement;
    },
  };
  return { db, operations, admissionId: () => admissionId };
}

function run(
  db: EventD1Connection,
  policy: Policy,
  work: (admission: EventWriteAdmission) => Promise<void>,
): Promise<void> {
  if (policy === "dispatch")
    return withEventWriteAdmission(db, { kind: "dispatch" }, work);
  if (policy === "match-effect")
    return withEventWriteAdmission(db, { kind: "match-effect" }, work);
  return withEventWriteAdmission(
    db,
    { kind: "mutation", context: "event-root-patch" },
    work,
  );
}

for (const policy of ["mutation", "dispatch", "match-effect"] as const) {
  for (const workFails of [false, true]) {
    for (const release of ["confirmed", "unconfirmed", "throws"] as const) {
      test(`${policy}: ${workFails ? "failed" : "successful"} work and ${release} release`, async (t) => {
        const workFailure = new Error("work-failed");
        const releaseFailure = new TypeError("release-failed");
        const fixture = database({
          release:
            release === "throws"
              ? { error: releaseFailure }
              : { value: release === "confirmed" },
        });
        const log = t.mock.method(console, "error", () => {});
        const operation = run(fixture.db, policy, async (admission) => {
          fixture.operations.push("work");
          assert.equal(admission.admissionId, fixture.admissionId());
          assert.equal(admission.freezeGeneration, 7);
          if (workFails) throw workFailure;
        });
        if (policy === "match-effect" && release === "throws") {
          await assert.rejects(operation, (error) => error === releaseFailure);
        } else if (workFails) {
          await assert.rejects(operation, (error) => error === workFailure);
        } else if (policy === "match-effect" && release === "unconfirmed") {
          await assert.rejects(operation, {
            message: "match-event-admission-release-unconfirmed",
          });
        } else {
          assert.equal(await operation, undefined);
        }
        assert.deepEqual(fixture.operations, ["acquire", "work", "release"]);
        const logs = log.mock.calls.map(({ arguments: [entry] }) =>
          JSON.parse(String(entry)),
        );
        if (policy === "match-effect" || release === "confirmed") {
          assert.deepEqual(logs, []);
        } else if (policy === "mutation") {
          assert.deepEqual(logs, [
            {
              event: "event_write_admission_release_failed",
              admissionId: fixture.admissionId(),
              freezeGeneration: 7,
              attempts: 1,
              context: "event-root-patch",
              kind: release === "throws" ? "TypeError" : "missing",
            },
          ]);
        } else {
          assert.deepEqual(logs, [
            {
              event: "event_progress_dispatch_admission_release_failed",
              kind: release === "throws" ? "TypeError" : "unconfirmed",
            },
          ]);
        }
      });
    }
  }

  test(`${policy}: frozen acquisition never starts work or releases`, async () => {
    const fixture = database({ acquire: { value: false } });
    const operation = run(fixture.db, policy, async () =>
      assert.fail("unexpected-work"),
    );
    if (policy === "dispatch") await operation;
    else await assert.rejects(operation, EventWritesDisabled);
    assert.deepEqual(fixture.operations, ["acquire"]);
  });

  test(`${policy}: acquisition failure is preserved without release`, async () => {
    const failure = new Error("admission-response-lost");
    const fixture = database({ acquire: { error: failure } });
    await assert.rejects(
      run(fixture.db, policy, async () => assert.fail("unexpected-work")),
      (error) => error === failure,
    );
    assert.deepEqual(fixture.operations, ["acquire"]);
  });

  test(`${policy}: EventWritesDisabled from work is never swallowed`, async () => {
    const failure = new EventWritesDisabled();
    const fixture = database();
    await assert.rejects(
      run(fixture.db, policy, async () => {
        fixture.operations.push("work");
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.deepEqual(fixture.operations, ["acquire", "work", "release"]);
  });
}

test("mutation and match-effect admissions return the original work result", async () => {
  const value = { committed: true };
  const mutation = database();
  assert.equal(
    await withEventWriteAdmission(
      mutation.db,
      { kind: "mutation", context: "transition-recovery" },
      async () => value,
    ),
    value,
  );
  const effect = database();
  assert.equal(
    await withEventWriteAdmission(
      effect.db,
      { kind: "match-effect" },
      async () => value,
    ),
    value,
  );
});

test("release waits for pending work before the caller can continue", async () => {
  const fixture = database();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const operation = run(fixture.db, "dispatch", async () => {
    fixture.operations.push("work");
    started.resolve();
    await finish.promise;
  }).then(() => fixture.operations.push("caller"));
  await started.promise;
  assert.deepEqual(fixture.operations, ["acquire", "work"]);
  finish.resolve();
  await operation;
  assert.deepEqual(fixture.operations, [
    "acquire",
    "work",
    "release",
    "caller",
  ]);
});

test("release logging retains non-Error and empty-name exception behavior", async (t) => {
  const unnamed = new Error("release-failed");
  unnamed.name = "";
  const log = t.mock.method(console, "error", () => {});
  for (const policy of ["mutation", "dispatch"] as const) {
    for (const error of [undefined, "unavailable", unnamed]) {
      const fixture = database({ release: { error } });
      await run(fixture.db, policy, async () => {});
    }
  }
  const logs = log.mock.calls.map(({ arguments: [entry] }) =>
    JSON.parse(String(entry)),
  );
  assert.deepEqual(
    logs.map(({ kind }) => kind),
    ["undefined", "string", "", "undefined", "string"],
  );
});
