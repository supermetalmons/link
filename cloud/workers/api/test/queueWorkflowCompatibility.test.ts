import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { queueFor } from "../src/queueProducers.ts";
import { retainEventProgressRecord } from "../../../runtime/eventProgressRecords.js";
import { validateEventProgressOutbox } from "../src/eventD1/validation.ts";
import { parseEventProgressOutbox } from "../src/eventProgressCodec.ts";

function declarations(file: string, names: readonly string[]): string {
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL(file, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const statements = source.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name &&
      names.includes(node.name.text),
  );
  assert.equal(statements.length, names.length);
  return ts.transpileModule(
    statements
      .map((node) => node.getText(source).replace(/^export\s+/, ""))
      .join("\n"),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.None,
      },
    },
  ).outputText;
}

test("Queue producer access retains the binding, receiver, argument order, arity, and Promise", async () => {
  const calls: unknown[] = [];
  const sent = Promise.resolve({ metrics: { retained: true } });
  const binding = {
    get send() {
      calls.push("send lookup");
      return function (this: unknown, ...args: unknown[]) {
        calls.push([this, args]);
        return sent;
      };
    },
    get sendBatch() {
      calls.push("batch lookup");
      return function (this: unknown, ...args: unknown[]) {
        calls.push([this, args]);
        return sent;
      };
    },
  };
  const env = {
    get AUTH_RECOVERY_QUEUE() {
      calls.push("binding lookup");
      return binding;
    },
  } as unknown as Pick<Env, "AUTH_RECOVERY_QUEUE">;
  const body = () => {
    calls.push("body");
    return { kind: "auth-profile-recovery" as const, profileId: "profile" };
  };
  const options = () => {
    calls.push("options");
    return { delaySeconds: 60 };
  };
  assert.equal(queueFor(env, "AUTH_RECOVERY_QUEUE"), binding);
  calls.length = 0;
  const result = queueFor(env, "AUTH_RECOVERY_QUEUE").send(body(), options());
  assert.equal(result, sent);
  assert.deepEqual(calls.slice(0, 4), [
    "binding lookup",
    "send lookup",
    "body",
    "options",
  ]);
  const invocation = calls[4] as [unknown, unknown[]];
  assert.equal(invocation[0], binding);
  assert.deepEqual(invocation[1], [
    { kind: "auth-profile-recovery", profileId: "profile" },
    { delaySeconds: 60 },
  ]);
  calls.length = 0;
  assert.equal(queueFor(env, "AUTH_RECOVERY_QUEUE").send(body()), sent);
  assert.equal((calls[3] as [unknown, unknown[]])[1].length, 1);
  calls.length = 0;
  assert.equal(
    queueFor(env, "AUTH_RECOVERY_QUEUE").sendBatch([{ body: body() }]),
    sent,
  );
  assert.deepEqual(calls.slice(0, 3), [
    "binding lookup",
    "batch lookup",
    "body",
  ]);
  assert.equal((calls[3] as [unknown, unknown[]])[0], binding);
  assert.equal(await result, await sent);
});

test("Queue binding and method failures stay synchronous and precede body evaluation", () => {
  for (const failureAt of ["binding", "method", "call"]) {
    const failure = new Error(failureAt);
    const calls: string[] = [];
    const env = {
      get AUTH_RECOVERY_QUEUE() {
        calls.push("binding");
        if (failureAt === "binding") throw failure;
        return {
          get send() {
            calls.push("method");
            if (failureAt === "method") throw failure;
            return () => {
              calls.push("call");
              throw failure;
            };
          },
        };
      },
    } as unknown as Pick<Env, "AUTH_RECOVERY_QUEUE">;
    assert.throws(
      () =>
        queueFor(env, "AUTH_RECOVERY_QUEUE").send(
          (() => {
            calls.push("body");
            return { kind: "auth-profile-recovery", profileId: "profile" };
          })(),
        ),
      (error) => error === failure,
    );
    assert.deepEqual(
      calls,
      failureAt === "binding"
        ? ["binding"]
        : failureAt === "method"
          ? ["binding", "method"]
          : ["binding", "method", "body", "call"],
    );
  }
});

test("retained Workflow transport preserves receiver and callee-before-plan reads", async () => {
  const source = declarations("../src/eventProgressDispatch.ts", [
    "retainedProgressWorkflow",
    "ensureEventProgressWorkflowInstance",
  ]);
  const helpers = new Function(
    `${source}\nreturn { retainedProgressWorkflow, ensureEventProgressWorkflowInstance };`,
  )() as {
    retainedProgressWorkflow: (value: unknown) => unknown;
    ensureEventProgressWorkflowInstance: (
      workflow: unknown,
      plan: unknown,
    ) => Promise<unknown>;
  };
  const calls: unknown[] = [];
  const instance = {};
  const params = { retained: true };
  const workflow = {
    get createBatch() {
      calls.push("create lookup");
      return function (this: unknown, options: unknown) {
        calls.push([this, options]);
        return Promise.resolve([instance]);
      };
    },
    get() {
      assert.fail("fallback must not run");
    },
  };
  assert.equal(helpers.retainedProgressWorkflow(workflow), workflow);
  const plan = {
    get workflowId() {
      calls.push("id");
      return "workflow";
    },
    get params() {
      calls.push("params");
      return params;
    },
  };
  assert.equal(
    await helpers.ensureEventProgressWorkflowInstance(workflow, plan),
    instance,
  );
  assert.deepEqual(calls.slice(0, 3), ["create lookup", "id", "params"]);
  assert.equal((calls[3] as [unknown])[0], workflow);
  assert.deepEqual((calls[3] as [unknown, unknown])[1], [
    {
      id: "workflow",
      params,
      retention: { successRetention: "1 day", errorRetention: "30 days" },
    },
  ]);
  const first = new Error("create failed");
  const fallback = {
    createBatch() {
      throw first;
    },
    get(this: unknown, id: string) {
      assert.equal(this, fallback);
      assert.equal(id, "workflow");
      return Promise.resolve(instance);
    },
  };
  assert.equal(
    await helpers.ensureEventProgressWorkflowInstance(fallback, plan),
    instance,
  );
  fallback.get = () => {
    throw new Error("lookup failed");
  };
  await assert.rejects(
    helpers.ensureEventProgressWorkflowInstance(fallback, plan),
    (error) => error === first,
  );
});

test("retained plan branding returns the assembler Promise without observing the input", async () => {
  const source = declarations("../src/eventProgressCodec.ts", [
    "buildRetainedEventProgressPlan",
  ]);
  const calls: unknown[] = [];
  const promise = Promise.resolve({ retained: true });
  const build = new Function(
    "assembleEventProgressPlan",
    `${source}\nreturn buildRetainedEventProgressPlan;`,
  )((...args: unknown[]) => {
    calls.push(args);
    return promise;
  }) as (input: unknown, now: unknown) => Promise<unknown>;
  const input = {
    get eventId() {
      return assert.fail("branding must not observe fields");
    },
  };
  assert.equal(build(input, 7), promise);
  assert.deepEqual(calls, [[input, 7]]);
  assert.deepEqual(await promise, { retained: true });
  const failure = new Error("assembler failure");
  const failing = new Function(
    "assembleEventProgressPlan",
    `${source}\nreturn buildRetainedEventProgressPlan;`,
  )(() => {
    throw failure;
  }) as (input: unknown, now: unknown) => Promise<unknown>;
  await assert.rejects(failing(input, 7), (error) => error === failure);
});

test("retained progress records preserve raw identity and the partial storage validator", async () => {
  for (const raw of [
    null,
    undefined,
    false,
    0,
    "legacy",
    [1],
    { extension: true },
  ]) {
    assert.equal(retainEventProgressRecord("pending", raw), raw);
    assert.equal(retainEventProgressRecord("dead", raw), raw);
  }
  const raw = {
    schemaVersion: 1,
    eventId: "event",
    runAtMs: 12,
    lastQueuedAtMs: 34,
    reason: false,
    firstQueuedAtMs: "56",
    extension: { keep: true },
  };
  const stored = validateEventProgressOutbox("outbox", raw);
  assert.deepEqual(stored, { ...raw, runAtMs: 12, lastQueuedAtMs: 34 });
  assert.notEqual(stored, raw);
  assert.deepEqual(Object.keys(stored), Object.keys(raw));
  assert.equal(await parseEventProgressOutbox("outbox", stored), null);
  assert.throws(
    () => validateEventProgressOutbox("outbox", { ...raw, runAtMs: "12" }),
    { message: "invalid-event-integer" },
  );
});
