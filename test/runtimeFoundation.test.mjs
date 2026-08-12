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

const { createCachedResource } =
  await import("../src/resources/cachedResource.ts");
const { bindIslandButtonDimmer, setIslandButtonDimmed } =
  await import("../src/runtime/islandButtonPort.ts");
const { getIsMuted, setIsMuted, subscribeToMuteState } =
  await import("../src/runtime/muteStore.ts");

test("deduplicates concurrent resource loads and retains successful values", async () => {
  let loadCount = 0;
  const resource = createCachedResource(
    async () => {
      loadCount += 1;
      return { id: loadCount };
    },
    () => assert.fail("unexpected load failure"),
  );

  const [first, second] = await Promise.all([resource.load(), resource.load()]);

  assert.equal(loadCount, 1);
  assert.strictEqual(first, second);
  assert.strictEqual(resource.getCachedValue(), first);
  assert.strictEqual(await resource.load(), first);
});

test("retries failed resource loads without caching failure", async () => {
  let loadCount = 0;
  const failures = [];
  const resource = createCachedResource(
    async () => {
      loadCount += 1;
      if (loadCount === 1) {
        throw new Error("first-load-failed");
      }
      return "loaded";
    },
    (error) => failures.push(error),
  );

  assert.equal(await resource.load(), null);
  assert.equal(resource.getCachedValue(), null);
  assert.equal(await resource.load(), "loaded");
  assert.equal(loadCount, 2);
  assert.equal(failures.length, 1);
});

test("publishes mute changes only when the value changes", () => {
  const original = getIsMuted();
  let notifications = 0;
  const unsubscribe = subscribeToMuteState(() => {
    notifications += 1;
  });

  setIsMuted(original);
  setIsMuted(!original);
  setIsMuted(!original);

  assert.equal(getIsMuted(), !original);
  assert.equal(notifications, 1);
  unsubscribe();
  setIsMuted(original);
  assert.equal(notifications, 1);
});

test("routes island dimming through the bound runtime port", () => {
  const values = [];
  bindIslandButtonDimmer((dimmed) => values.push(dimmed));

  setIslandButtonDimmed(true);
  setIslandButtonDimmed(false);

  assert.deepEqual(values, [true, false]);
});
