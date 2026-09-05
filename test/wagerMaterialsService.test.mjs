import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFrozenMaterialsDelta,
  getFrozenMaterials,
  getFrozenMaterialsStatus,
  hasConfirmedFrozenMaterials,
  resetWagerMaterialsState,
  setFrozenMaterials,
  setFrozenMaterialsStatus,
  subscribeToFrozenMaterials,
} from "../src/services/wagerMaterialsService.ts";

const empty = { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 };

test.afterEach(resetWagerMaterialsState);

test("distinguishes unknown balances from authoritative zero reservations", () => {
  setFrozenMaterials(null, "loading");
  assert.equal(hasConfirmedFrozenMaterials(), false);
  assert.equal(getFrozenMaterialsStatus(), "loading");
  setFrozenMaterials(null, "unavailable");
  assert.equal(hasConfirmedFrozenMaterials(), false);
  setFrozenMaterials(empty, "ready");
  assert.equal(hasConfirmedFrozenMaterials(), true);
  assert.deepEqual(getFrozenMaterials(), empty);
});

test("publishes optimistic deltas without falsely confirming them and clears actor state", () => {
  const changes = [];
  const unsubscribe = subscribeToFrozenMaterials(
    (materials, status, confirmed) =>
      changes.push({ materials, status, confirmed }),
  );
  setFrozenMaterials({ ...empty, dust: 2 }, "ready");
  setFrozenMaterialsStatus("updating");
  applyFrozenMaterialsDelta({ dust: 3 });
  assert.deepEqual(changes.at(-1), {
    materials: { ...empty, dust: 5 },
    status: "updating",
    confirmed: true,
  });
  setFrozenMaterials({ ...empty, dust: 2 }, "unavailable");
  assert.equal(hasConfirmedFrozenMaterials(), true);
  assert.equal(getFrozenMaterials().dust, 2);
  setFrozenMaterials(null, "loading");
  assert.equal(hasConfirmedFrozenMaterials(), false);
  assert.equal(getFrozenMaterials().dust, 0);
  unsubscribe();
});
