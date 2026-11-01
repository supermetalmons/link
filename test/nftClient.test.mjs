import { required } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerTypeScriptTestHooks } from "./support/typescriptHooks.mjs";
import test from "node:test";
import {
  fetchCachedNfts,
  NFT_CACHE_TTL_MS,
  resetNftCache,
} from "../src/services/nftCache.ts";
import { fetchNftsFromApi } from "../src/services/nftApi.ts";

registerTypeScriptTestHooks();

const { fetchNftsForIdentity, getNftIdentityKey } =
  await import("../src/services/nftService.ts");

const NFT_API_URL = "https://api.mons.link/nfts";
const SOL_ADDRESS = "11111111111111111111111111111111";
const ETH_ADDRESS = "0x0000000000000000000000000000000000000001";
/** @type {import("@mons/shared/nfts").NftApiResponse} */
const EMPTY_RESPONSE = {
  ok: true,
  specials: [],
  swagpack_avatars: [],
  swagpack_reactions: [],
};

/**
 * @param {test.TestContext} t
 */
function prepareCacheTest(t) {
  resetNftCache();
  t.after(resetNftCache);
}

/** @param {unknown} error */
function assertGenericApiError(error) {
  assert.ok(error instanceof Error);
  assert.equal(error.message, "NFT inventory is unavailable.");
  return true;
}

/** @param {AbortSignal | null | undefined} signal @returns {Promise<never>} */
function rejectWhenAborted(signal) {
  signal = required(signal);
  return new Promise((_, reject) => {
    const rejectRequest = () => reject(new Error("transport aborted"));
    if (signal.aborted) {
      rejectRequest();
      return;
    }
    signal.addEventListener("abort", rejectRequest, { once: true });
  });
}

test("wires the authenticated identity into the cached API request", async (t) => {
  prepareCacheTest(t);
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (
      /** @type {Parameters<typeof fetch>[0]} */ input,
      /** @type {RequestInit | undefined} */ init,
    ) => {
      calls += 1;
      assert.equal(String(input), NFT_API_URL);
      assert.equal(init?.method, "POST");
      assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), {
        accept: "application/json",
        "content-type": "application/json",
        "x-mons-data-epoch": "1",
      });
      assert.equal(init?.cache, "no-store");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        sol: SOL_ADDRESS,
        eth: ETH_ADDRESS,
      });
      return Response.json({
        ok: true,
        specials: [{ id: 2, count: 1 }],
        swagpack_avatars: [{ id: 9, count: 2 }],
        swagpack_reactions: [{ id: 9, count: 2 }],
      });
    },
  );

  /** @type {import("../src/connection/authModels.ts").AuthState} */
  const identity = {
    authStatus: "authenticated",
    profileId: "profile-id",
    solAddress: SOL_ADDRESS,
    ethAddress: ETH_ADDRESS,
  };
  assert.equal(
    getNftIdentityKey(identity),
    JSON.stringify(["profile-id", SOL_ADDRESS, ETH_ADDRESS]),
  );

  const fetchInventory = () => fetchNftsForIdentity(identity);
  const first = await fetchInventory();
  const second = await fetchInventory();

  assert.deepEqual(first.data, {
    ok: true,
    specials: [{ id: 2, count: 1 }],
    swagpack_avatars: [{ id: 9, count: 2 }],
    swagpack_reactions: [{ id: 9, count: 2 }],
  });
  assert.equal(first.expiresAtMs, now + NFT_CACHE_TTL_MS);
  assert.equal(second, first);
  assert.equal(calls, 1);
});

test("maps transport and response failures to one client error", async (t) => {
  const responses = [
    () => Promise.reject(new Error("network details")),
    () => Response.json({ error: "provider details" }, { status: 502 }),
    () => new Response("{"),
    () =>
      Response.json({
        ok: true,
        specials: [{ id: 2, count: 0 }],
        swagpack_avatars: [],
        swagpack_reactions: [],
      }),
  ];
  t.mock.method(globalThis, "fetch", () => responses.shift()?.());

  for (let index = 0; index < 4; index += 1) {
    await assert.rejects(
      fetchNftsFromApi(SOL_ADDRESS, ETH_ADDRESS),
      assertGenericApiError,
    );
  }
});

test("does not wait for failed-response cancellation", async (t) => {
  /** @type {PromiseWithResolvers<void>} */
  const { promise: cancellation, resolve: releaseCancellation } =
    Promise.withResolvers();
  let cancellationStarted = false;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancellationStarted = true;
            return cancellation;
          },
        }),
        { status: 502 },
      ),
  );

  const request = fetchNftsFromApi(SOL_ADDRESS, ETH_ADDRESS);
  let settled = false;
  void request.catch(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const settledBeforeCancellation = settled;
  required(releaseCancellation)();

  await assert.rejects(request, assertGenericApiError);
  assert.equal(cancellationStarted, true);
  assert.equal(settledBeforeCancellation, true);
});

test("times out a stalled transport, deduplicates it, and permits retry", async (t) => {
  prepareCacheTest(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    (
      /** @type {Parameters<typeof fetch>[0]} */ _input,
      /** @type {RequestInit | undefined} */ init,
    ) => {
      calls += 1;
      assert.equal(init?.signal instanceof AbortSignal, true);
      if (calls === 1) {
        return rejectWhenAborted(required(init).signal);
      }
      return Promise.resolve(Response.json(EMPTY_RESPONSE));
    },
  );

  const fetchInventory = () =>
    fetchCachedNfts("identity", () =>
      fetchNftsFromApi(SOL_ADDRESS, ETH_ADDRESS),
    );
  const first = fetchInventory();
  const duplicate = fetchInventory();
  const firstRejection = assert.rejects(first, assertGenericApiError);
  const duplicateRejection = assert.rejects(duplicate, assertGenericApiError);

  assert.equal(calls, 1);
  t.mock.timers.runAll();
  await Promise.all([firstRejection, duplicateRejection]);

  assert.deepEqual((await fetchInventory()).data, EMPTY_RESPONSE);
  assert.equal(calls, 2);
});

test("keeps the deadline active while reading the response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  /** @type {AbortSignal | null | undefined} */
  let signal;

  /** @type {PromiseWithResolvers<void>} */
  const { promise: bodyStarted, resolve: markBodyStarted } =
    Promise.withResolvers();
  t.mock.method(
    globalThis,
    "fetch",
    async (
      /** @type {Parameters<typeof fetch>[0]} */ _input,
      /** @type {RequestInit | undefined} */ init,
    ) => {
      signal = init?.signal;
      assert.equal(signal instanceof AbortSignal, true);
      return {
        ok: true,
        headers: new Headers(),
        json: () => {
          markBodyStarted();
          return rejectWhenAborted(signal);
        },
      };
    },
  );

  const request = fetchNftsFromApi(SOL_ADDRESS, ETH_ADDRESS);
  await bodyStarted;
  const rejection = assert.rejects(request, assertGenericApiError);
  assert.equal(required(signal).aborted, false);
  t.mock.timers.runAll();
  await rejection;
  assert.equal(required(signal).aborted, true);
});

test("clears the request deadline after a successful response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  /** @type {AbortSignal | null | undefined} */
  let signal;
  t.mock.method(
    globalThis,
    "fetch",
    async (
      /** @type {Parameters<typeof fetch>[0]} */ _input,
      /** @type {RequestInit | undefined} */ init,
    ) => {
      signal = init?.signal;
      return Response.json(EMPTY_RESPONSE);
    },
  );

  assert.deepEqual(
    await fetchNftsFromApi(SOL_ADDRESS, ETH_ADDRESS),
    EMPTY_RESPONSE,
  );
  assert.equal(signal instanceof AbortSignal, true);
  assert.equal(required(signal).aborted, false);
  t.mock.timers.runAll();
  assert.equal(required(signal).aborted, false);
});

test("expires successful entries after five minutes", async (t) => {
  prepareCacheTest(t);
  let now = 5_000;
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  const fetchInventory = () =>
    fetchCachedNfts("identity", async () => {
      calls += 1;
      return { ...EMPTY_RESPONSE, request: calls };
    });

  const first = await fetchInventory();
  assert.equal(first.expiresAtMs, now + NFT_CACHE_TTL_MS);
  assert.equal(fixtureField((await fetchInventory()).data, "request"), 1);

  now = first.expiresAtMs;
  const refreshed = await fetchInventory();
  assert.equal(fixtureField(refreshed.data, "request"), 2);
  assert.equal(refreshed.expiresAtMs, now + NFT_CACHE_TTL_MS);
  assert.equal(calls, 2);
});

test("does not cache failures and retries the next request", async (t) => {
  prepareCacheTest(t);
  let calls = 0;
  const fetchInventory = () =>
    fetchCachedNfts("identity", async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("temporary failure");
      }
      return EMPTY_RESPONSE;
    });

  await assert.rejects(fetchInventory(), /temporary failure/);
  assert.deepEqual((await fetchInventory()).data, EMPTY_RESPONSE);
  assert.equal(calls, 2);
});

test("deduplicates a key without sharing requests between identities", async (t) => {
  prepareCacheTest(t);
  /** @type {PromiseWithResolvers<import("@mons/shared/nfts").NftApiResponse & {identity: string}>} */
  const { promise: firstResponse, resolve: resolveFirst } =
    Promise.withResolvers();
  let firstIdentityCalls = 0;
  let secondIdentityCalls = 0;
  const fetchFirstIdentity = () =>
    fetchCachedNfts("first", () => {
      firstIdentityCalls += 1;
      return firstResponse;
    });
  const first = fetchFirstIdentity();
  const duplicate = fetchFirstIdentity();
  const second = fetchCachedNfts("second", async () => {
    secondIdentityCalls += 1;
    return { ...EMPTY_RESPONSE, identity: "second" };
  });

  assert.equal(firstIdentityCalls, 1);
  assert.equal(secondIdentityCalls, 1);
  required(resolveFirst)({ ...EMPTY_RESPONSE, identity: "first" });

  assert.equal(fixtureField((await first).data, "identity"), "first");
  assert.equal(fixtureField((await duplicate).data, "identity"), "first");
  assert.equal(fixtureField((await second).data, "identity"), "second");
});

test("reset prevents an in-flight response from repopulating the cache", async (t) => {
  prepareCacheTest(t);
  /** @type {PromiseWithResolvers<import("@mons/shared/nfts").NftApiResponse & {version: string}>} */
  const { promise: staleResponse, resolve: resolveStale } =
    Promise.withResolvers();
  const staleRequest = fetchCachedNfts("identity", () => staleResponse);

  resetNftCache();
  let freshCalls = 0;
  const fresh = await fetchCachedNfts("identity", async () => {
    freshCalls += 1;
    return { ...EMPTY_RESPONSE, version: "fresh" };
  });
  required(resolveStale)({ ...EMPTY_RESPONSE, version: "stale" });
  const stale = await staleRequest;
  const cached = await fetchCachedNfts("identity", async () => {
    freshCalls += 1;
    return { ...EMPTY_RESPONSE, version: "unexpected" };
  });

  assert.equal(stale.expiresAtMs, 0);
  assert.equal(fixtureField(fresh.data, "version"), "fresh");
  assert.equal(fixtureField(cached.data, "version"), "fresh");
  assert.equal(freshCalls, 1);
});

test("keeps loading and unauthenticated identities off the API", async (t) => {
  prepareCacheTest(t);
  const now = 25_000;
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json(EMPTY_RESPONSE);
  });

  for (const authStatus of /** @type {const} */ ([
    "loading",
    "unauthenticated",
  ])) {
    assert.deepEqual(
      await fetchNftsForIdentity({
        authStatus,
        profileId: "profile-id",
        solAddress: SOL_ADDRESS,
        ethAddress: ETH_ADDRESS,
      }),
      {
        data: EMPTY_RESPONSE,
        expiresAtMs: now + NFT_CACHE_TTL_MS,
      },
    );
  }
  assert.equal(calls, 0);
});

test("keeps authenticated identities without Solana addresses off the API", async (t) => {
  prepareCacheTest(t);
  const now = 30_000;
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json(EMPTY_RESPONSE);
  });

  /** @type {import("../src/connection/authModels.ts").AuthState} */
  const identity = {
    authStatus: "authenticated",
    profileId: "profile-id",
    solAddress: "",
    ethAddress: ETH_ADDRESS,
  };
  const first = await fetchNftsForIdentity(identity);
  const second = await fetchNftsForIdentity(identity);

  assert.deepEqual(first, {
    data: EMPTY_RESPONSE,
    expiresAtMs: now + NFT_CACHE_TTL_MS,
  });
  assert.equal(second, first);
  assert.equal(calls, 0);
});

/** @param {unknown} value @param {string} key @returns {unknown} */
function fixtureField(value, key) {
  assert.ok(value !== null && typeof value === "object" && key in value);
  return Reflect.get(value, key);
}
