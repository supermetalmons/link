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

const {
  DISMISS_ALLOWED_TRIANGLE_A,
  ISLAND_HOTSPOTS,
  STAR_SHINE_PENTAGON,
  STAR_SHINE_PENTAGON_BOUNDS,
  clampWalkTarget,
  computeOverlapArea,
  createSafeAreaEllipse,
  isInsideEllipse,
  isInsideHole,
  isInsideSmoothEllipse,
  isInsideWalkArea,
  pointInPolygon,
  pointInTriangle,
} = await import("../src/ui/island/geometry.ts");
const { decidePendingMiningHydration, decideProfileMiningHydration } =
  await import("../src/island/miningHydration.ts");
const {
  createEmptyMiningMaterials,
  getRockVariantIndex,
  loadStoredMiningState,
  shouldShowMiningRock,
} = await import("../src/island/miningState.ts");
const { bindMiningConnection, getMiningConnection } =
  await import("../src/island/miningConnectionPort.ts");
const { getMonBoundsWidthFrac } = await import("../src/ui/island/layout.ts");

const mining = (lastRockDate = null, dust = 0) => ({
  lastRockDate,
  materials: { dust, slime: 0, gum: 0, metal: 0, ice: 0 },
});

test("island geometry preserves hotspots, hit regions, and walk clamping", () => {
  assert.equal(ISLAND_HOTSPOTS.length, 11);
  assert.equal(pointInTriangle(0.05, 0.95, DISMISS_ALLOWED_TRIANGLE_A), true);
  assert.equal(pointInTriangle(0.5, 0.5, DISMISS_ALLOWED_TRIANGLE_A), false);
  assert.equal(pointInPolygon(0.7, 0.7, STAR_SHINE_PENTAGON), true);
  assert.deepEqual(STAR_SHINE_PENTAGON_BOUNDS, {
    minX: 0.465,
    maxX: 0.9532,
    minY: 0.2415,
    maxY: 0.9558,
  });

  assert.equal(isInsideSmoothEllipse(0.5, 0.2), true);
  assert.equal(isInsideHole(0.2, 0.45), true);
  assert.equal(isInsideWalkArea(0.2, 0.45), false);
  const from = { x: 0.5, y: 0.2 };
  const clamped = clampWalkTarget(from, { x: 2, y: 2 });
  assert.equal(isInsideWalkArea(clamped.x, clamped.y), true);
  const outsideHole = clampWalkTarget(from, { x: 0.2, y: 0.45 });
  assert.equal(isInsideHole(outsideHole.x, outsideHole.y), false);
});

test("island overlap and safe-area geometry retain exact calculations", () => {
  assert.equal(
    computeOverlapArea(
      { left: 0, top: 0, right: 0.5, bottom: 0.5 },
      { left: 0.25, top: 0.1, right: 0.75, bottom: 0.4 },
    ),
    0.07500000000000001,
  );
  const safeArea = createSafeAreaEllipse({
    left: 0.4,
    top: 0.1,
    right: 0.6,
    bottom: 0.3,
  });
  assert.equal(safeArea.cx, 0.5);
  assert.ok(Math.abs(safeArea.cy - 0.242) < Number.EPSILON);
  assert.equal(safeArea.rx, 0.63);
  assert.equal(safeArea.ry, 0.36);
  assert.equal(isInsideEllipse(0.5, 0.242, safeArea), true);
  assert.equal(isInsideEllipse(2, 2, safeArea), false);
  assert.equal(getMonBoundsWidthFrac("royal_aguapwoshi_drainer"), 0.09);
  assert.equal(getMonBoundsWidthFrac("unknown"), 0.115);
});

test("mining state keeps anonymous storage empty and rock visibility gated", () => {
  const stored = loadStoredMiningState({
    profileId: "profile",
    lastRockDate: "2026-08-11",
    materials: { dust: "3" },
  });
  assert.deepEqual(stored, mining("2026-08-11", 3));
  assert.deepEqual(
    loadStoredMiningState({
      profileId: "",
      lastRockDate: "2026-08-11",
      materials: { dust: 9 },
    }),
    mining("2026-08-11", 0),
  );
  assert.equal(
    shouldShowMiningRock({
      testingMode: false,
      profileId: "profile",
      serverSnapshotLoaded: false,
      snapshot: mining(null),
      today: "2026-08-12",
    }),
    false,
  );
  assert.equal(
    shouldShowMiningRock({
      testingMode: false,
      profileId: "profile",
      serverSnapshotLoaded: true,
      snapshot: mining("2026-08-11"),
      today: "2026-08-12",
    }),
    true,
  );
  assert.equal(
    shouldShowMiningRock({
      testingMode: false,
      profileId: "profile",
      serverSnapshotLoaded: true,
      snapshot: mining("2026-08-12"),
      today: "2026-08-12",
    }),
    false,
  );
  const firstVariant = getRockVariantIndex("profile", "2026-08-12");
  assert.ok(firstVariant >= 1 && firstVariant <= 27);
  assert.equal(getRockVariantIndex("profile", "2026-08-12"), firstVariant);
  assert.notStrictEqual(
    createEmptyMiningMaterials(),
    createEmptyMiningMaterials(),
  );
});

test("profile mining hydration preserves apply, cache, clear, and wait policies", () => {
  const profile = { id: "profile", mining: mining("2026-08-12", 2) };
  assert.deepEqual(decideProfileMiningHydration("profile", profile), {
    action: "apply",
    mining: profile.mining,
  });
  const cached = decideProfileMiningHydration("", profile);
  assert.deepEqual(cached, {
    action: "cache",
    profileId: "profile",
    mining: profile.mining,
  });
  assert.notStrictEqual(cached.mining, profile.mining);
  assert.notStrictEqual(cached.mining.materials, profile.mining.materials);
  assert.deepEqual(decideProfileMiningHydration("other", profile), {
    action: "ignore",
  });
  assert.deepEqual(decidePendingMiningHydration("", null), { action: "wait" });
  assert.deepEqual(
    decidePendingMiningHydration("other", {
      profileId: "profile",
      mining: profile.mining,
    }),
    { action: "clear" },
  );
  assert.deepEqual(
    decidePendingMiningHydration("profile", {
      profileId: "profile",
      mining: profile.mining,
    }),
    { action: "apply", mining: profile.mining },
  );
});

test("mining transport is provided through the typed local port", () => {
  const port = {
    createSessionGuard: () => () => true,
    mineRock: async () => null,
  };
  bindMiningConnection(port);
  assert.strictEqual(getMiningConnection(), port);
});
