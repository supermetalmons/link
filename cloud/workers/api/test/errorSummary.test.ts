import assert from "node:assert/strict";
import test from "node:test";
import { summarizeError, type ErrorSummary } from "../src/errorSummary.ts";

test("error summaries preserve nested causes and aggregate children", () => {
  const cause = Object.assign(new Error("database-unavailable"), {
    code: "D1_ERROR",
  });
  assert.deepEqual(
    summarizeError(
      new AggregateError(
        [new Error("dispatch-failed", { cause }), new TypeError("bad-record")],
        "recovery-failed",
      ),
    ),
    {
      name: "AggregateError",
      message: "recovery-failed",
      errors: [
        {
          name: "Error",
          message: "dispatch-failed",
          cause: {
            name: "Error",
            message: "database-unavailable",
            code: "D1_ERROR",
          },
        },
        { name: "TypeError", message: "bad-record" },
      ],
    },
  );
});

test("error summaries exclude stacks, object codes and arbitrary payloads", () => {
  const failure = Object.assign(new Error("failed"), {
    code: { token: "private" },
    request: { authorization: "private" },
    record: { contents: "private" },
  });
  assert.deepEqual(summarizeError(failure), {
    name: "Error",
    message: "failed",
  });
  assert.deepEqual(summarizeError({ token: "private" }), { type: "object" });
  for (const value of [undefined, "private", 42, true, 1n, Symbol("private")]) {
    assert.deepEqual(summarizeError(value), { type: typeof value });
  }
  assert.deepEqual(summarizeError(null), { type: "null" });
  for (const code of [42, false, null]) {
    assert.equal(
      summarizeError(Object.assign(new Error(), { code })).code,
      code,
    );
  }
  for (const code of [Infinity, NaN]) {
    assert.equal(
      Object.hasOwn(
        summarizeError(Object.assign(new Error(), { code })),
        "code",
      ),
      false,
    );
  }
});

test("error summaries bound every string and mark truncation", () => {
  const failure = Object.assign(new Error("m".repeat(257)), {
    name: "n".repeat(257),
    code: "c".repeat(257),
  });
  assert.deepEqual(summarizeError(failure), {
    name: "n".repeat(256),
    message: "m".repeat(256),
    code: "c".repeat(256),
    truncated: true,
  });
});

test("error summaries stop at four levels without an extra marker node", () => {
  let failure = new Error("fifth");
  for (let index = 4; index >= 1; index--) {
    failure = new Error(String(index), { cause: failure });
  }
  const summary = summarizeError(failure);
  assert.deepEqual(summary.cause?.cause?.cause, {
    name: "Error",
    message: "4",
    truncated: true,
  });
});

test("error summaries share an eight-node budget across causes and aggregates", () => {
  const failure = new AggregateError(
    Array.from({ length: 20 }, (_, index) => new Error(String(index))),
    "many-failures",
    { cause: new Error("cause", { cause: new Error("root") }) },
  );
  const summary = summarizeError(failure);
  const count = (value: ErrorSummary): number =>
    1 +
    (value.cause ? count(value.cause) : 0) +
    (value.errors || []).reduce((total, child) => total + count(child), 0);
  assert.equal(count(summary), 8);
  assert.equal(summary.errors?.length, 5);
  assert.equal(summary.truncated, true);
});

test("error summaries identify cycles without treating shared errors as cycles", () => {
  const loop = new Error("loop");
  loop.cause = loop;
  const summary = summarizeError(new AggregateError([loop, loop], "shared"));
  assert.deepEqual(summary.errors, [
    { name: "Error", message: "loop", cause: { cycle: true } },
    { name: "Error", message: "loop", cause: { cycle: true } },
  ]);
  const aggregate = new AggregateError([], "loop");
  aggregate.errors.push(aggregate);
  assert.deepEqual(summarizeError(aggregate).errors, [{ cycle: true }]);
});

test("error summaries do not throw for hostile getters or revoked proxies", () => {
  const failure = new Error("failed");
  for (const property of ["name", "code", "cause"]) {
    Object.defineProperty(failure, property, {
      get() {
        throw new Error("unreadable");
      },
    });
  }
  assert.deepEqual(summarizeError(failure), {
    name: "Error",
    message: "failed",
    truncated: true,
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.deepEqual(summarizeError(revoked.proxy), {
    type: "object",
    truncated: true,
  });
  const children = Proxy.revocable([], {});
  children.revoke();
  const aggregate = new AggregateError([], "failed");
  aggregate.errors = children.proxy;
  assert.doesNotThrow(() => JSON.stringify(summarizeError(aggregate)));
});
