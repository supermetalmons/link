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
  getCachedMaterialImageUrls,
  getMaterialImageUrl,
  subscribeMaterialImageLoads,
} = await import("../src/resources/materialImageResources.ts");

test("shares material requests and retains one blob URL for later consumers", async (t) => {
  assert.deepEqual(getCachedMaterialImageUrls(), {
    dust: null,
    slime: null,
    gum: null,
    metal: null,
    ice: null,
  });
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (/** @type {Parameters<typeof fetch>[0]} */ url) => {
      assert.equal(url, "https://cdn.lil.org/mons/rocks/materials/dust.webp");
      return new Response("dust-image");
    },
  );
  const objectUrlMock = t.mock.method(
    URL,
    "createObjectURL",
    (/** @type {Blob} */ blob) => {
      assert.ok(blob instanceof Blob);
      return "blob:dust";
    },
  );

  const first = getMaterialImageUrl("dust");
  const second = getMaterialImageUrl("dust");
  assert.strictEqual(first, second);
  assert.deepEqual(await Promise.all([first, second]), [
    "blob:dust",
    "blob:dust",
  ]);
  assert.equal(await getMaterialImageUrl("dust"), "blob:dust");
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(objectUrlMock.mock.callCount(), 1);
  const cached = getCachedMaterialImageUrls();
  assert.equal(cached.dust, "blob:dust");
  cached.dust = null;
  assert.equal(getCachedMaterialImageUrls().dust, "blob:dust");
});

test("retries a failed HTTP response on a subsequent material request", async (t) => {
  let attempts = 0;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    return attempts === 1
      ? new Response(null, { status: 503 })
      : new Response("slime-image");
  });
  const objectUrlMock = t.mock.method(
    URL,
    "createObjectURL",
    () => "blob:slime",
  );

  assert.deepEqual(
    await Promise.all([
      getMaterialImageUrl("slime"),
      getMaterialImageUrl("slime"),
    ]),
    [null, null],
  );
  assert.equal(getCachedMaterialImageUrls().slime, null);
  assert.equal(objectUrlMock.mock.callCount(), 0);
  assert.equal(await getMaterialImageUrl("slime"), "blob:slime");
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(objectUrlMock.mock.callCount(), 1);
});

test("does not cache network or blob URL failures", async (t) => {
  let attempts = 0;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("network unavailable");
    return new Response("gum-image");
  });
  let objectUrlAttempts = 0;
  const objectUrlMock = t.mock.method(URL, "createObjectURL", () => {
    objectUrlAttempts += 1;
    if (objectUrlAttempts === 1) throw new Error("blob URL unavailable");
    return "blob:gum";
  });

  assert.equal(await getMaterialImageUrl("gum"), null);
  assert.equal(getCachedMaterialImageUrls().gum, null);
  assert.equal(await getMaterialImageUrl("gum"), null);
  assert.equal(getCachedMaterialImageUrls().gum, null);
  assert.equal(await getMaterialImageUrl("gum"), "blob:gum");
  assert.equal(fetchMock.mock.callCount(), 3);
  assert.equal(objectUrlMock.mock.callCount(), 2);
});

test("publishes an external retry success once to mounted consumers", async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("network unavailable");
    return new Response("metal-image");
  });
  t.mock.method(URL, "createObjectURL", () => "blob:metal");
  /** @type {{ name: Parameters<typeof getMaterialImageUrl>[0], url: string }[]} */
  const changes = [];
  const unsubscribe = subscribeMaterialImageLoads((name, url) => {
    assert.equal(getCachedMaterialImageUrls()[name], url);
    changes.push({ name, url });
  });
  t.after(unsubscribe);

  assert.equal(await getMaterialImageUrl("metal"), null);
  assert.deepEqual(changes, []);
  const retry = getMaterialImageUrl("metal");
  assert.strictEqual(getMaterialImageUrl("metal"), retry);
  assert.equal(await retry, "blob:metal");
  assert.deepEqual(changes, [{ name: "metal", url: "blob:metal" }]);
  assert.equal(await getMaterialImageUrl("metal"), "blob:metal");
  assert.equal(changes.length, 1);
});

test("does not notify an unmounted consumer when its pending image loads", async (t) => {
  /** @type {PromiseWithResolvers<Response>} */
  const { promise: response, resolve: resolveFetch } = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", () => response);
  t.mock.method(URL, "createObjectURL", () => "blob:ice");
  /** @type {{ name: Parameters<typeof getMaterialImageUrl>[0], url: string }[]} */
  const changes = [];
  const unsubscribe = subscribeMaterialImageLoads((name, url) => {
    changes.push({ name, url });
  });
  const pending = getMaterialImageUrl("ice");

  unsubscribe();
  resolveFetch(new Response("ice-image"));

  assert.equal(await pending, "blob:ice");
  assert.deepEqual(changes, []);
  assert.equal(getCachedMaterialImageUrls().ice, "blob:ice");
});
