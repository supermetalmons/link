import assert from "node:assert/strict";
import test from "node:test";
import { resetEnsCache, resolveENS } from "../src/utils/ensResolver.ts";

const originalFetch = globalThis.fetch;
const address = "0x0000000000000000000000000000000000000001";
/** @type {Parameters<typeof fetch>[0][]} */
const requests = [];
/** @type {() => Response | Promise<Response>} */
let fetchResponse;

test.beforeEach(() => {
  resetEnsCache();
  requests.length = 0;
  globalThis.fetch = async (url) => {
    requests.push(url);
    return fetchResponse();
  };
});
test.after(() => {
  globalThis.fetch = originalFetch;
  resetEnsCache();
});

test("ENS boundary compatibility: valid names retain whitespace and cache by address", async () => {
  fetchResponse = () =>
    Response.json({ name: "  player.eth  ", avatar: null, extra: "retained" });
  assert.equal(await resolveENS(address), "  player.eth  ");
  assert.equal(await resolveENS(address), "  player.eth  ");
  assert.deepEqual(requests, [
    `https://api.ensideas.com/ens/resolve/${address}`,
  ]);
});

test("ENS boundary compatibility: absent and empty names are cached as misses", async () => {
  for (const payload of [{}, { name: null }, { name: "" }]) {
    resetEnsCache();
    const before = requests.length;
    fetchResponse = () => Response.json(payload);
    assert.equal(await resolveENS(address), null);
    assert.equal(await resolveENS(address), null);
    assert.equal(requests.length, before + 1);
  }
});

test("ENS rejects malformed name values as cached misses", async () => {
  for (const payload of [
    null,
    false,
    7,
    "name.eth",
    [],
    { name: 7 },
    { name: true },
    { name: [] },
    { name: {} },
  ]) {
    resetEnsCache();
    const before = requests.length;
    fetchResponse = () => Response.json(payload);
    assert.equal(await resolveENS(address), null);
    assert.equal(await resolveENS(address), null);
    assert.equal(requests.length, before + 1);
  }
});

test("ENS boundary compatibility: unsuccessful HTTP responses do not decode their body", async () => {
  fetchResponse = () => {
    const response = new Response(null, { status: 503 });
    response.json = async () => {
      throw new Error("unexpected-body-read");
    };
    return response;
  };
  assert.equal(await resolveENS(address), null);
  assert.equal(await resolveENS(address), null);
  assert.equal(requests.length, 1);
});

test("ENS boundary compatibility: resetting during a lookup prevents stale cache publication", async () => {
  /** @type {PromiseWithResolvers<Response>} */
  const { promise: oldResponse, resolve: finishOldResponse } =
    Promise.withResolvers();
  fetchResponse = () => oldResponse;
  const oldLookup = resolveENS(address);
  resetEnsCache();
  fetchResponse = () => Response.json({ name: "current.eth" });
  assert.equal(await resolveENS(address), "current.eth");
  finishOldResponse(Response.json({ name: "previous.eth" }));
  assert.equal(await oldLookup, "previous.eth");
  assert.equal(await resolveENS(address), "current.eth");
  assert.equal(requests.length, 2);
});
