import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { createEventPrizeSelectionCoordinator } =
  await import("../src/ui/event/prizeSelectionCoordinator.ts");

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const createHarness = () => {
  const mutations = [];
  const pendingStates = [];
  const selections = [];
  const errors = [];
  const coordinator = createEventPrizeSelectionCoordinator({
    profileId: "local",
    mutate: (prizeId) => {
      const operation = deferred();
      mutations.push({ prizeId, ...operation });
      return operation.promise;
    },
    onError: (error) => errors.push(error),
    onPendingChange: (isPending) => pendingStates.push(isPending),
    onSelectionsChange: (nextSelections) => selections.push(nextSelections),
  });
  return { coordinator, errors, mutations, pendingStates, selections };
};

test("applies a local selection immediately and merges remote updates", async () => {
  const harness = createHarness();
  harness.coordinator.receiveAuthoritative({ remote: "1111" });
  harness.coordinator.toggle("1092");

  assert.deepEqual(harness.selections.at(-1), {
    local: "1092",
    remote: "1111",
  });
  assert.deepEqual(
    harness.mutations.map(({ prizeId }) => prizeId),
    ["1092"],
  );
  assert.deepEqual(harness.pendingStates, [true]);

  harness.coordinator.receiveAuthoritative({ remote: "1514" });
  assert.deepEqual(harness.selections.at(-1), {
    local: "1092",
    remote: "1514",
  });

  harness.mutations[0].resolve("1092");
  await flushPromises();
  assert.deepEqual(harness.pendingStates, [true, false]);
  const emittedCount = harness.selections.length;

  harness.coordinator.receiveAuthoritative({
    local: "1092",
    remote: "1514",
  });
  assert.equal(harness.selections.length, emittedCount);
});

test("keeps a newer authoritative selection after a delayed response", async () => {
  const harness = createHarness();
  harness.coordinator.receiveAuthoritative({});
  harness.coordinator.toggle("1092");
  harness.coordinator.receiveAuthoritative({ local: "1092" });
  harness.coordinator.receiveAuthoritative({ local: "1111" });

  assert.deepEqual(harness.selections.at(-1), { local: "1092" });
  harness.mutations[0].resolve("1092");
  await flushPromises();

  assert.deepEqual(harness.selections.at(-1), { local: "1111" });
  assert.deepEqual(harness.pendingStates, [true, false]);
});

test("coalesces rapid moves and deselection to the latest intent", async () => {
  const harness = createHarness();
  harness.coordinator.receiveAuthoritative({});
  harness.coordinator.toggle("1092");
  harness.coordinator.toggle("1111");
  harness.coordinator.toggle("1111");

  assert.deepEqual(harness.selections.at(-1), {});
  assert.deepEqual(
    harness.mutations.map(({ prizeId }) => prizeId),
    ["1092"],
  );

  harness.mutations[0].resolve("1092");
  await flushPromises();
  assert.deepEqual(
    harness.mutations.map(({ prizeId }) => prizeId),
    ["1092", "1092"],
  );
  assert.deepEqual(harness.selections.at(-1), {});
  assert.deepEqual(harness.pendingStates, [true]);

  harness.mutations[1].resolve(null);
  await flushPromises();
  assert.deepEqual(harness.selections.at(-1), {});
  assert.deepEqual(harness.pendingStates, [true, false]);
});

test("serializes a rapid move to the latest selected prize", async () => {
  const harness = createHarness();
  harness.coordinator.receiveAuthoritative({});
  harness.coordinator.toggle("1092");
  harness.coordinator.toggle("1111");

  harness.mutations[0].resolve("1092");
  await flushPromises();
  assert.deepEqual(
    harness.mutations.map(({ prizeId }) => prizeId),
    ["1092", "1111"],
  );
  assert.deepEqual(harness.selections.at(-1), { local: "1111" });

  harness.mutations[1].resolve("1111");
  await flushPromises();
  assert.deepEqual(harness.selections.at(-1), { local: "1111" });
  assert.deepEqual(harness.pendingStates, [true, false]);
});

test("rolls back a failed mutation to the newest authoritative state", async () => {
  const harness = createHarness();
  const failure = new Error("unavailable");
  harness.coordinator.receiveAuthoritative({
    local: "1092",
    remote: "1111",
  });
  harness.coordinator.toggle("1514");
  harness.coordinator.receiveAuthoritative({
    local: "1092",
    remote: "1514",
  });

  assert.deepEqual(harness.selections.at(-1), {
    local: "1514",
    remote: "1514",
  });
  harness.mutations[0].reject(failure);
  await flushPromises();

  assert.deepEqual(harness.selections.at(-1), {
    local: "1092",
    remote: "1514",
  });
  assert.deepEqual(harness.pendingStates, [true, false]);
  assert.deepEqual(harness.errors, [failure]);
});

test("ignores mutation completions and snapshots after disposal", async () => {
  const harness = createHarness();
  harness.coordinator.receiveAuthoritative({});
  harness.coordinator.toggle("1092");
  const selectionCount = harness.selections.length;
  const pendingCount = harness.pendingStates.length;

  harness.coordinator.dispose();
  harness.mutations[0].resolve("1092");
  await flushPromises();
  harness.coordinator.receiveAuthoritative({ local: "1111" });
  harness.coordinator.toggle("1514");

  assert.equal(harness.selections.length, selectionCount);
  assert.equal(harness.pendingStates.length, pendingCount);
  assert.equal(harness.mutations.length, 1);
});
