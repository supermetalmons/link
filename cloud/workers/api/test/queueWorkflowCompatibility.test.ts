import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { queueFor } from "../src/queueProducers.ts";
import { parseQueueEnvelope } from "../src/queueEnvelope.ts";
import { retainEventProgressRecord } from "../../../runtime/eventProgressRecords.js";
import { validateEventProgressOutbox } from "../src/eventD1/validation.ts";
import {
  buildEventProgressPlan,
  buildRetainedEventProgressPlan,
  parseEventProgressOutbox,
} from "../src/eventProgressCodec.ts";

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

test("Queue producers preserve native delivery while adding the canonical envelope", async () => {
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
  assert.notEqual(queueFor(env, "AUTH_RECOVERY_QUEUE"), binding);
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
  const envelope = parseQueueEnvelope(invocation[1][0], "AUTH_RECOVERY_QUEUE");
  assert.ok(envelope);
  assert.deepEqual(envelope.payload, {
    kind: "auth-profile-recovery",
    profileId: "profile",
  });
  assert.deepEqual(invocation[1][1], { delaySeconds: 60 });
  calls.length = 0;
  assert.equal(queueFor(env, "AUTH_RECOVERY_QUEUE").send(body()), sent);
  assert.equal((calls[3] as [unknown, unknown[]])[1].length, 2);
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
    "ensureEventProgressWorkflowInstance",
  ]);
  const helpers = new Function(
    `${source}\nreturn { ensureEventProgressWorkflowInstance };`,
  )() as {
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

test("progress plans use concrete data-epoch-one identities", async () => {
  assert.equal(buildRetainedEventProgressPlan, buildEventProgressPlan);
  const plan = await buildEventProgressPlan(
    {
      eventId: "event",
      sourceKey: "start:event:12",
      reason: "scheduled-start",
      runAtMs: 12,
    },
    7,
  );
  assert.equal(plan.outbox.schemaVersion, 2);
  assert.equal(plan.outbox.dataEpoch, 1);
  assert.match(plan.workflowId, /^data1_event-progress-[a-f0-9]{64}$/);
  assert.deepEqual(
    await parseEventProgressOutbox(plan.outboxId, plan.outbox),
    plan,
  );
});

test("progress records reject opaque values and preserve complete canonical documents", async () => {
  for (const raw of [
    null,
    undefined,
    false,
    0,
    "legacy",
    [1],
    { extension: true },
  ]) {
    assert.throws(
      () => retainEventProgressRecord("pending", raw),
      /invalid-canonical-event-progress-record/,
    );
    assert.throws(
      () => retainEventProgressRecord("dead", raw),
      /invalid-canonical-event-progress-record/,
    );
  }
  const plan = await buildEventProgressPlan(
    {
      eventId: "event",
      sourceKey: "start:event:12",
      reason: "scheduled-start",
      runAtMs: 12,
    },
    7,
  );
  assert.deepEqual(
    retainEventProgressRecord("pending", plan.outbox),
    plan.outbox,
  );
  assert.deepEqual(
    validateEventProgressOutbox(plan.outboxId, plan.outbox),
    plan.outbox,
  );
  assert.throws(
    () =>
      validateEventProgressOutbox(plan.outboxId, {
        ...plan.outbox,
        runAtMs: "12",
      }),
    /invalid-event-progress-outbox/,
  );
  const dead = {
    schemaVersion: 1,
    dataEpoch: 1,
    deadAtMs: 34,
    sourceDigest: "a".repeat(64),
    originalRecord: plan.outbox,
    reason: "invalid-event-progress-outbox",
  };
  assert.deepEqual(retainEventProgressRecord("dead", dead), dead);
});
