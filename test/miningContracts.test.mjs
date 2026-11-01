import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMaterialDeltas,
  applyMaterialDeltasWithCap,
  computeAcceptedReservation,
  createEmptyMaterials,
  createEmptyMiningSnapshot,
  createDropsForMiningEvent,
  parseMiningMaterials,
  parseMiningSnapshot,
} from "@mons/shared/mining";

const empty = { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 };

test("canonical mining parsers reject coercion and incomplete material maps", () => {
  for (const materials of [
    undefined,
    null,
    [],
    {},
    { dust: 1 },
    { ...empty, dust: "2" },
    { ...empty, dust: true },
    { ...empty, dust: -1 },
    { ...empty, dust: 1.5 },
    { ...empty, dust: Infinity },
    { ...empty, dust: NaN },
    { ...empty, extra: 1 },
  ]) {
    assert.equal(parseMiningMaterials(materials), null);
    assert.equal(parseMiningSnapshot({ lastRockDate: null, materials }), null);
  }
  for (const snapshot of [
    undefined,
    null,
    {},
    { materials: empty },
    { lastRockDate: 123, materials: empty },
    { lastRockDate: null, materials: empty, extra: true },
  ])
    assert.equal(parseMiningSnapshot(snapshot), null);
});

test("canonical mining parsing clones exact values and explicit fresh snapshots stay independent", () => {
  const source = {
    lastRockDate: "2026-10-31",
    materials: { ...empty, dust: 5 },
  };
  const parsed = parseMiningSnapshot(source);
  assert.ok(parsed);
  assert.deepEqual(parsed, source);
  assert.notStrictEqual(parsed, source);
  assert.notStrictEqual(parsed.materials, source.materials);
  source.materials.dust = 99;
  assert.equal(parsed.materials.dust, 5);
  const first = createEmptyMiningSnapshot();
  const second = createEmptyMiningSnapshot();
  assert.deepEqual(first, { lastRockDate: null, materials: empty });
  first.materials.dust = 2;
  assert.equal(second.materials.dust, 0);
  assert.deepEqual(createDropsForMiningEvent("profile", "2026-10-31", second), {
    drops: ["dust"],
    delta: { ...empty, dust: 1 },
  });
  assert.throws(
    () =>
      Reflect.apply(createDropsForMiningEvent, undefined, [
        "profile",
        "2026-10-31",
        undefined,
      ]),
    /invalid-mining-snapshot/,
  );
});

test("typed material deltas and reservations preserve valid arithmetic without parsing strings", () => {
  const current = { ...empty, dust: 4, slime: 3 };
  assert.deepEqual(applyMaterialDeltas(current, { dust: -8, gum: 2 }), {
    ...empty,
    slime: 3,
    gum: 2,
  });
  assert.deepEqual(
    applyMaterialDeltasWithCap(
      current,
      { dust: 5 },
      { ...empty, dust: 7, slime: 9 },
    ),
    { ...empty, dust: 7, slime: 3 },
  );
  assert.deepEqual(
    computeAcceptedReservation(
      current,
      "dust",
      5,
      { material: "slime", count: 2 },
      { ...empty, dust: 7, slime: 9 },
    ),
    {
      acceptedCount: 3,
      appliedDelta: { dust: 3, slime: -2 },
      materials: { ...empty, dust: 7, slime: 1 },
    },
  );
  assert.deepEqual(current, { ...empty, dust: 4, slime: 3 });
  for (const deltas of [
    { dust: "2" },
    { dust: null },
    { dust: undefined },
    { dust: 0.5 },
    { dust: Infinity },
    { extra: 1 },
  ])
    assert.throws(
      () => Reflect.apply(applyMaterialDeltas, undefined, [current, deltas]),
      /invalid-mining-deltas/,
    );
  assert.throws(
    () =>
      Reflect.apply(applyMaterialDeltas, undefined, [{ dust: 4 }, { dust: 1 }]),
    /invalid-mining-materials/,
  );
  assert.throws(
    () =>
      Reflect.apply(computeAcceptedReservation, undefined, [
        current,
        "dust",
        "2",
        null,
        createEmptyMaterials(),
      ]),
    /invalid-mining-reservation/,
  );
  assert.throws(
    () =>
      Reflect.apply(computeAcceptedReservation, undefined, [
        current,
        "dust",
        2,
        { material: "slime", count: "1" },
        createEmptyMaterials(),
      ]),
    /invalid-mining-reservation/,
  );
});
