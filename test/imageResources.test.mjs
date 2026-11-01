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

const { getImageResource } = await import("../src/resources/imageResources.ts");

test("loads lazily and shares a request and successful blob URL by source", async (t) => {
  const source = "https://images.example/shared.webp";
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (/** @type {Parameters<typeof fetch>[0]} */ url) => {
      assert.equal(url, source);
      return new Response("image");
    },
  );
  const objectUrlMock = t.mock.method(
    URL,
    "createObjectURL",
    (/** @type {Blob | MediaSource} */ blob) => {
      assert.ok(blob instanceof Blob);
      return "blob:shared";
    },
  );
  const first = getImageResource(source);
  assert.strictEqual(getImageResource(source), first);
  assert.equal(first.getCachedValue(), null);
  assert.equal(fetchMock.mock.callCount(), 0);

  const pending = first.load();
  assert.strictEqual(getImageResource(source).load(), pending);
  assert.equal(await pending, "blob:shared");
  assert.equal(first.getCachedValue(), "blob:shared");
  assert.equal(await getImageResource(source).load(), "blob:shared");
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(objectUrlMock.mock.callCount(), 1);
});

test("keeps resources for distinct source URLs separate", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (/** @type {BodyInit | null | undefined} */ url) => new Response(url),
  );
  let nextUrl = 0;
  t.mock.method(URL, "createObjectURL", () => `blob:distinct-${++nextUrl}`);
  const first = getImageResource("https://images.example/first.webp");
  const second = getImageResource("https://images.example/second.webp");

  assert.notStrictEqual(first, second);
  const urls = await Promise.all([first.load(), second.load()]);
  assert.notEqual(urls[0], urls[1]);
  assert.equal(first.getCachedValue(), urls[0]);
  assert.equal(second.getCachedValue(), urls[1]);
});

for (const failure of ["http", "network", "blob-read", "blob-url"]) {
  test(`retries ${failure} failures only on a subsequent load`, async (t) => {
    let fetchAttempts = 0;
    const fetchMock = t.mock.method(globalThis, "fetch", async () => {
      fetchAttempts += 1;
      if (fetchAttempts === 1) {
        if (failure === "http") return new Response(null, { status: 503 });
        if (failure === "network") throw new TypeError("offline");
        if (failure === "blob-read") {
          return {
            ok: true,
            blob: async () => {
              throw new Error("body unavailable");
            },
          };
        }
      }
      return new Response("image");
    });
    t.mock.method(URL, "createObjectURL", () => {
      if (failure === "blob-url" && fetchAttempts === 1) {
        throw new Error("blob URL unavailable");
      }
      return `blob:recovered-${failure}`;
    });
    const resource = getImageResource(`https://images.example/${failure}.webp`);
    const pending = resource.load();
    assert.strictEqual(resource.load(), pending);
    assert.equal(await pending, null);
    assert.equal(resource.getCachedValue(), null);
    assert.equal(fetchMock.mock.callCount(), 1);

    assert.equal(await resource.load(), `blob:recovered-${failure}`);
    assert.equal(resource.getCachedValue(), `blob:recovered-${failure}`);
    assert.equal(await resource.load(), `blob:recovered-${failure}`);
    assert.equal(fetchMock.mock.callCount(), 2);
  });
}
