import assert from "node:assert/strict";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";
import { required } from "./fixtures/canonicalData.mjs";

registerTypeScriptTestHooks();

const previousLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
/** @type {Map<string, string>} */
const storedValues = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (/** @type {string} */ key) => storedValues.get(key) ?? null,
    setItem: (/** @type {string} */ key, /** @type {string} */ value) =>
      storedValues.set(key, String(value)),
    removeItem: (/** @type {string} */ key) => storedValues.delete(key),
  },
});

const { readAvailableMaterials, subscribeAvailableMaterials } =
  await import("../src/services/availableMaterials.ts");
const { rocksMiningService } =
  await import("../src/services/rocksMiningService.ts");
const {
  applyFrozenMaterialsDelta,
  resetWagerMaterialsState,
  setFrozenMaterials,
  setFrozenMaterialsStatus,
} = await import("../src/services/wagerMaterialsService.ts");
const { storage } = await import("../src/utils/storage.ts");

const materials = (dust = 0) => ({ dust, slime: 0, gum: 0, metal: 0, ice: 0 });
const mining = (dust = 0) => ({
  lastRockDate: null,
  materials: materials(dust),
});

test.beforeEach(() => {
  storedValues.clear();
  storage.setProfileId("profile-a");
  rocksMiningService.setFromServer(mining(10), { persist: false });
  resetWagerMaterialsState();
});

test.after(() => {
  if (previousLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("reads current availability and distinguishes unknown from confirmed zero reservations", () => {
  assert.deepEqual(readAvailableMaterials(), {
    availableMaterials: materials(10),
    frozenMaterialsStatus: "idle",
    hasConfirmedSnapshot: false,
  });
  setFrozenMaterials(materials(), "ready");
  const confirmed = readAvailableMaterials();
  assert.equal(confirmed.hasConfirmedSnapshot, true);
  assert.equal(confirmed.frozenMaterialsStatus, "ready");
  confirmed.availableMaterials.dust = 100;
  assert.equal(readAvailableMaterials().availableMaterials.dust, 10);
  setFrozenMaterials(materials(15), "ready");
  assert.equal(readAvailableMaterials().availableMaterials.dust, 0);
});

test("delivers mining and reservation changes synchronously with status and confirmation", (t) => {
  /** @type {import("../src/services/availableMaterials.ts").AvailableMaterialsSnapshot[]} */
  const changes = [];
  t.after(subscribeAvailableMaterials((snapshot) => changes.push(snapshot)));
  assert.equal(changes.length, 1);

  rocksMiningService.setFromServer(mining(12), { persist: false });
  assert.equal(required(changes.at(-1)).availableMaterials.dust, 12);
  setFrozenMaterials(materials(3), "ready");
  assert.deepEqual(changes.at(-1), {
    availableMaterials: materials(9),
    frozenMaterialsStatus: "ready",
    hasConfirmedSnapshot: true,
  });
  setFrozenMaterialsStatus("updating");
  applyFrozenMaterialsDelta({ dust: 2 });
  assert.deepEqual(changes.at(-1), {
    availableMaterials: materials(7),
    frozenMaterialsStatus: "updating",
    hasConfirmedSnapshot: true,
  });
  setFrozenMaterialsStatus("unavailable");
  assert.equal(required(changes.at(-1)).hasConfirmedSnapshot, true);
  setFrozenMaterials(null, "loading");
  assert.deepEqual(changes.at(-1), {
    availableMaterials: materials(12),
    frozenMaterialsStatus: "loading",
    hasConfirmedSnapshot: false,
  });
});

test("fresh reads and subsequent reservation events include silent mining corrections", (t) => {
  /** @type {import("../src/services/availableMaterials.ts").AvailableMaterialsSnapshot[]} */
  const changes = [];
  t.after(subscribeAvailableMaterials((snapshot) => changes.push(snapshot)));
  rocksMiningService.setFromServer(mining(18), {
    persist: false,
    notify: false,
  });
  assert.equal(changes.length, 1);
  assert.equal(readAvailableMaterials().availableMaterials.dust, 18);
  setFrozenMaterials(materials(4), "ready");
  assert.equal(required(changes.at(-1)).availableMaterials.dust, 14);
});

test("follows profile resets without retaining the previous balance or confirmation", (t) => {
  /** @type {import("../src/services/availableMaterials.ts").AvailableMaterialsSnapshot[]} */
  const changes = [];
  t.after(subscribeAvailableMaterials((snapshot) => changes.push(snapshot)));
  setFrozenMaterials(materials(4), "ready");
  storage.setProfileId("");
  rocksMiningService.resetProfileMiningState();
  resetWagerMaterialsState();
  assert.deepEqual(changes.at(-1), {
    availableMaterials: materials(),
    frozenMaterialsStatus: "idle",
    hasConfirmedSnapshot: false,
  });

  storage.setProfileId("profile-b");
  rocksMiningService.resetProfileMiningState();
  rocksMiningService.setFromServer(mining(2), { persist: false });
  setFrozenMaterials(materials(), "ready");
  assert.deepEqual(changes.at(-1), {
    availableMaterials: materials(2),
    frozenMaterialsStatus: "ready",
    hasConfirmedSnapshot: true,
  });
});

test("cleans up both subscriptions and can subscribe again with a fresh snapshot", () => {
  /** @type {import("../src/services/availableMaterials.ts").AvailableMaterialsSnapshot[]} */
  const oldChanges = [];
  const unsubscribe = subscribeAvailableMaterials((snapshot) =>
    oldChanges.push(snapshot),
  );
  unsubscribe();
  unsubscribe();
  rocksMiningService.setFromServer(mining(7), { persist: false });
  setFrozenMaterials(materials(3), "ready");
  assert.equal(oldChanges.length, 1);

  /** @type {import("../src/services/availableMaterials.ts").AvailableMaterialsSnapshot[]} */
  const nextChanges = [];
  const dispose = subscribeAvailableMaterials((snapshot) =>
    nextChanges.push(snapshot),
  );
  assert.equal(nextChanges.length, 1);
  assert.equal(required(nextChanges[0]).availableMaterials.dust, 4);
  dispose();
});

test("rejects malformed server mining snapshots without publishing or replacing balances", () => {
  for (const value of [
    { lastRockDate: null, materials: { dust: 7 } },
    { lastRockDate: null, materials: { ...materials(), dust: "7" } },
    { lastRockDate: 123, materials: materials(7) },
  ])
    assert.throws(
      () =>
        Reflect.apply(rocksMiningService.setFromServer, rocksMiningService, [
          value,
          { persist: false },
        ]),
      /invalid-mining-snapshot/,
    );
  assert.deepEqual(rocksMiningService.getSnapshot(), mining(10));
  rocksMiningService.setFromServer(null, { persist: false });
  assert.deepEqual(rocksMiningService.getSnapshot(), mining());
});
