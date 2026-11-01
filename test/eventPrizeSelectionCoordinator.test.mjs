import assert from "node:assert/strict";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";

registerTypeScriptTestHooks();

const { createEventPrizeSelectionCoordinator } =
  await import("../src/ui/event/prizeSelectionCoordinator.ts");

/** @typedef {Parameters<typeof createEventPrizeSelectionCoordinator>[0]} Dependencies */
/** @returns {PromiseWithResolvers<Awaited<ReturnType<Dependencies["mutate"]>>>} */
const deferred = () => Promise.withResolvers();

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const createHarness = () => {
  /** @type {(ReturnType<typeof deferred> & { prizeId: Parameters<Dependencies["mutate"]>[0] })[]} */
  const mutations = [];
  /** @type {boolean[]} */
  const pendingStates = [];
  /** @type {Parameters<Dependencies["onSelectionsChange"]>[0][]} */
  const selections = [];
  /** @type {Parameters<NonNullable<Dependencies["onError"]>>[0][]} */
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
  /** @param {number} index */
  const mutation = (index) => {
    const value = mutations[index];
    assert.ok(value);
    return value;
  };
  return {
    coordinator,
    errors,
    mutations,
    pendingStates,
    selections,
    mutation,
  };
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

  harness.mutation(0).resolve("1092");
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
  harness.mutation(0).resolve("1092");
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

  harness.mutation(0).resolve("1092");
  await flushPromises();
  assert.deepEqual(
    harness.mutations.map(({ prizeId }) => prizeId),
    ["1092", "1092"],
  );
  assert.deepEqual(harness.selections.at(-1), {});
  assert.deepEqual(harness.pendingStates, [true]);

  harness.mutation(1).resolve(null);
  await flushPromises();
  assert.deepEqual(harness.selections.at(-1), {});
  assert.deepEqual(harness.pendingStates, [true, false]);
});

test("serializes a rapid move to the latest selected prize", async () => {
  const harness = createHarness();
  harness.coordinator.receiveAuthoritative({});
  harness.coordinator.toggle("1092");
  harness.coordinator.toggle("1111");

  harness.mutation(0).resolve("1092");
  await flushPromises();
  assert.deepEqual(
    harness.mutations.map(({ prizeId }) => prizeId),
    ["1092", "1111"],
  );
  assert.deepEqual(harness.selections.at(-1), { local: "1111" });

  harness.mutation(1).resolve("1111");
  await flushPromises();
  assert.deepEqual(harness.selections.at(-1), { local: "1111" });
  assert.deepEqual(harness.pendingStates, [true, false]);
});

test("exposes pending work synchronously until the queued selection settles", async () => {
  const harness = createHarness();
  harness.coordinator.receiveAuthoritative({});
  assert.equal(harness.coordinator.isPending(), false);

  harness.coordinator.toggle("1092");
  assert.equal(harness.coordinator.isPending(), true);
  harness.coordinator.toggle("1111");
  harness.coordinator.receiveAuthoritative({});
  assert.equal(harness.coordinator.isPending(), true);

  harness.mutation(0).resolve("1092");
  await flushPromises();
  assert.equal(harness.coordinator.isPending(), true);
  assert.equal(harness.mutation(1).prizeId, "1111");

  harness.mutation(1).resolve("1111");
  await flushPromises();
  assert.equal(harness.coordinator.isPending(), false);
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
  harness.mutation(0).reject(failure);
  await flushPromises();

  assert.deepEqual(harness.selections.at(-1), {
    local: "1092",
    remote: "1514",
  });
  assert.deepEqual(harness.pendingStates, [true, false]);
  assert.deepEqual(harness.errors, [failure]);
  assert.equal(harness.coordinator.isPending(), false);
});

test("ignores mutation completions and snapshots after disposal", async () => {
  const harness = createHarness();
  harness.coordinator.receiveAuthoritative({});
  harness.coordinator.toggle("1092");
  const selectionCount = harness.selections.length;
  const pendingCount = harness.pendingStates.length;

  harness.coordinator.dispose();
  assert.equal(harness.coordinator.isPending(), false);
  harness.mutation(0).resolve("1092");
  await flushPromises();
  harness.coordinator.receiveAuthoritative({ local: "1111" });
  harness.coordinator.toggle("1514");

  assert.equal(harness.selections.length, selectionCount);
  assert.equal(harness.pendingStates.length, pendingCount);
  assert.equal(harness.mutations.length, 1);
});
