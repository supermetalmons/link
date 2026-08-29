import assert from "node:assert/strict";
import test from "node:test";
import {
  extractIdFromJsonUri,
  handleRequest,
  type ProviderFetch,
} from "../src/workerHandler.ts";
import {
  PRIMARY_COLLECTION_ID,
  SPECIALS_COLLECTION_ID,
} from "../src/helius.ts";
import { isValidSolanaAddress } from "@mons/shared/solana";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const VALID_SOLANA_ADDRESS = "11111111111111111111111111111111";
const API_KEY = "test-helius-secret";
const HELIUS_PAGE_LIMIT = 1000;
const HELIUS_MAX_PAGES_PER_COLLECTION = 3;
const MAX_HELIUS_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
const env = {
  ...TELEGRAM_TEST_ENV,
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_EMAIL:
    "worker@example.iam.gserviceaccount.com",
  FIREBASE_IDENTITY_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: API_KEY,
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  NFT_RATE_LIMITER: {
    limit: async () => ({ success: true }),
  },
  X_CLIENT_ID: "test-x-client",
  X_CLIENT_SECRET: "test-x-secret",
} as Env;

function post(body: unknown, headers?: HeadersInit) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Content-Type", "application/json");
  return new Request("https://api.mons.link/nfts", {
    method: "POST",
    headers: requestHeaders,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function jsonResult(items: unknown[], total = items.length, cursor?: unknown) {
  return rpcResult({ items, total, cursor });
}

function rpcResult(result: Record<string, unknown>, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Response(JSON.stringify({ result }), {
    ...init,
    headers,
  });
}

function rpcPayload(result: Record<string, unknown>) {
  return JSON.stringify({ result });
}

function providerParams(init: RequestInit | undefined) {
  return (
    JSON.parse(String(init?.body)) as {
      params: { grouping: string[]; cursor?: string };
    }
  ).params;
}

function providerErrorBody(onCancel: () => void) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("provider details"));
    },
    cancel() {
      onCancel();
    },
  });
}

function responseWithBody(body: BodyInit, status = 200, headers?: HeadersInit) {
  return new Response(body, {
    status,
    headers,
  });
}

function item(jsonUri: unknown) {
  return { content: { json_uri: jsonUri } };
}

async function responseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("routes OPTIONS, rejected methods, and unknown paths without Helius", async () => {
  let calls = 0;
  let rateLimitCalls = 0;
  const providerFetch: ProviderFetch = async () => {
    calls += 1;
    return jsonResult([]);
  };
  const routingEnv = {
    ...env,
    NFT_RATE_LIMITER: {
      limit: async () => {
        rateLimitCalls += 1;
        return { success: true };
      },
    },
  } as Env;

  const options = await handleRequest(
    new Request("https://api.mons.link/nfts", { method: "OPTIONS" }),
    routingEnv,
    { providerFetch },
  );
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(
    options.headers.get("Access-Control-Allow-Methods"),
    "POST, OPTIONS",
  );
  assert.equal(options.headers.get("Cache-Control"), "no-store");

  const get = await handleRequest(
    new Request("https://api.mons.link/nfts", { method: "GET" }),
    routingEnv,
    { providerFetch },
  );
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("Allow"), "POST, OPTIONS");
  assert.equal(get.headers.get("Access-Control-Allow-Origin"), "*");

  const missing = await handleRequest(
    new Request("https://api.mons.link/other", { method: "OPTIONS" }),
    routingEnv,
    { providerFetch },
  );
  assert.equal(missing.status, 404);

  const xCallback = await handleRequest(
    new Request("https://api.mons.link/auth/x/callback"),
    routingEnv,
    { providerFetch },
  );
  assert.equal(xCallback.status, 400);
  assert.match(xCallback.headers.get("Cache-Control") || "", /no-store/);
  assert.equal(calls, 0);
  assert.equal(rateLimitCalls, 0);
});

test("rate limits NFT posts before reading bodies or calling Helius", async () => {
  const keys: string[] = [];
  let providerCalls = 0;
  const deniedEnv = {
    ...env,
    NFT_RATE_LIMITER: {
      limit: async ({ key }: RateLimitOptions) => {
        keys.push(key);
        return { success: false };
      },
    },
  } as Env;
  const request = post("{", { "CF-Connecting-IP": "203.0.113.7" });
  const response = await handleRequest(request, deniedEnv, {
    providerFetch: async () => {
      providerCalls += 1;
      return jsonResult([]);
    },
  });

  assert.equal(response.status, 429);
  assert.deepEqual(await responseJson(response), {
    ok: false,
    error: "rate-limited",
  });
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(request.bodyUsed, false);
  assert.deepEqual(keys, ["nfts:203.0.113.7"]);
  assert.equal(providerCalls, 0);
});

test("fails closed when the rate-limit binding is unavailable", async () => {
  let logged = 0;
  let providerCalls = 0;
  const unavailableEnv = {
    ...env,
    NFT_RATE_LIMITER: {
      limit: async () => {
        throw new Error("binding details");
      },
    },
  } as Env;
  const request = post({ sol: VALID_SOLANA_ADDRESS, eth: "" });
  const response = await handleRequest(request, unavailableEnv, {
    providerFetch: async () => {
      providerCalls += 1;
      return jsonResult([]);
    },
    logRateLimitFailure: () => {
      logged += 1;
    },
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await responseJson(response), {
    ok: false,
    error: "rate-limit-unavailable",
  });
  assert.equal(request.bodyUsed, false);
  assert.equal(logged, 1);
  assert.equal(providerCalls, 0);
});

test("admits every NFT post before validating its body", async () => {
  const keys: string[] = [];
  const admittingEnv = {
    ...env,
    NFT_RATE_LIMITER: {
      limit: async ({ key }: RateLimitOptions) => {
        keys.push(key);
        return { success: true };
      },
    },
  } as Env;

  const malformed = await handleRequest(post("{"), admittingEnv);
  const empty = await handleRequest(post({ sol: "", eth: "" }), admittingEnv);

  assert.equal(malformed.status, 400);
  assert.equal(empty.status, 200);
  assert.deepEqual(keys, ["nfts:unknown", "nfts:unknown"]);
});

test("returns 400 for malformed bodies and invalid field types", async () => {
  const bodies: unknown[] = [
    "{",
    "null",
    "[]",
    "{}",
    JSON.stringify({ sol: VALID_SOLANA_ADDRESS }),
    JSON.stringify({ sol: 1, eth: "" }),
    JSON.stringify({ sol: "", eth: null }),
  ];
  for (const body of bodies) {
    const response = await handleRequest(post(body), env);
    assert.equal(response.status, 400, String(body));
    assert.deepEqual(await responseJson(response), {
      ok: false,
      error: "invalid-request",
    });
  }
});

test("does not wait for malformed-body cancellation", async () => {
  let releaseCancellation: () => void = () => undefined;
  const cancellation = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  let cancellationStarted = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(255));
    },
    cancel() {
      cancellationStarted = true;
      return cancellation;
    },
  });
  const request = new Request("https://api.mons.link/nfts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const responsePromise = handleRequest(request, env);
  let settled = false;
  void responsePromise.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settledBeforeCancellation = settled;
  releaseCancellation();

  const response = await responsePromise;
  assert.equal(response.status, 400);
  assert.equal(cancellationStarted, true);
  assert.equal(settledBeforeCancellation, true);
});

test("rejects declared and streamed oversized bodies before calling Helius", async () => {
  let calls = 0;
  const providerFetch: ProviderFetch = async () => {
    calls += 1;
    return jsonResult([]);
  };
  const declaredOversizedRequest = new Request("https://api.mons.link/nfts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": "4097",
    },
    body: "{}",
  });

  const declaredResponse = await handleRequest(declaredOversizedRequest, env, {
    providerFetch,
  });
  assert.equal(declaredResponse.status, 400);
  assert.equal(declaredOversizedRequest.bodyUsed, false);

  const streamedResponse = await handleRequest(
    post({ sol: "", eth: "x".repeat(5000) }),
    env,
    { providerFetch },
  );
  assert.equal(streamedResponse.status, 400);
  assert.equal(calls, 0);
});

test("empty Solana addresses return the exact empty response without Helius", async () => {
  let calls = 0;
  const response = await handleRequest(
    post({ sol: "", eth: "0xunused" }),
    env,
    {
      providerFetch: async () => {
        calls += 1;
        return jsonResult([]);
      },
    },
  );
  assert.equal(response.status, 200);
  const body = await responseJson(response);
  assert.deepEqual(body, {
    ok: true,
    specials: [],
    swagpack_avatars: [],
    swagpack_reactions: [],
  });
  assert.deepEqual(Object.keys(body), [
    "ok",
    "specials",
    "swagpack_avatars",
    "swagpack_reactions",
  ]);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(calls, 0);
});

test("validates non-empty Solana addresses as 32-byte base58 values", async () => {
  assert.equal(isValidSolanaAddress(VALID_SOLANA_ADDRESS), true);
  assert.equal(isValidSolanaAddress("not-base58"), false);
  assert.equal(isValidSolanaAddress("1111"), false);
  assert.equal(isValidSolanaAddress(` ${VALID_SOLANA_ADDRESS}`), false);
  assert.equal(isValidSolanaAddress(null), false);

  for (const sol of ["not-base58", "1111", ` ${VALID_SOLANA_ADDRESS}`]) {
    const response = await handleRequest(post({ sol, eth: "" }), env);
    assert.equal(response.status, 400, sol);
  }
});

test("extracts legacy numeric URI tails", () => {
  assert.equal(extractIdFromJsonUri("https://assets.example/9?x=1#top"), 9);
  assert.equal(extractIdFromJsonUri("ipfs://collection/17#fragment"), 17);
  assert.equal(extractIdFromJsonUri("26.json"), 26);
  assert.equal(extractIdFromJsonUri("https://assets.example/31extra"), 31);
  assert.equal(extractIdFromJsonUri("https://assets.example/"), null);
  assert.equal(extractIdFromJsonUri("nonnumeric"), null);
  assert.equal(extractIdFromJsonUri(undefined), null);
});

test("starts both collection lookups concurrently", async () => {
  const pending: Array<(response: Response) => void> = [];
  const providerFetch: ProviderFetch = () =>
    new Promise((resolve) => {
      pending.push(resolve);
    });
  const responsePromise = handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    env,
    { providerFetch },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(pending.length, 2);
  for (const resolve of pending) {
    resolve(jsonResult([]));
  }
  assert.equal((await responsePromise).status, 200);
});

test("preserves pagination, duplicate counts, reactions, and response shape", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const firstPage = [
    item("https://assets.example/9"),
    item("https://assets.example/9?copy=2"),
    item("ipfs://assets/8#avatar"),
    ...Array.from({ length: HELIUS_PAGE_LIMIT - 3 }, () => item("invalid")),
  ];
  const providerFetch: ProviderFetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body)) as {
      params: Record<string, unknown>;
    };
    calls.push(payload.params);
    const grouping = payload.params.grouping as string[];
    if (grouping[1] === SPECIALS_COLLECTION_ID) {
      return jsonResult([item("https://assets.example/2")], 1, null);
    }
    if (!payload.params.cursor) {
      return jsonResult(firstPage, HELIUS_PAGE_LIMIT + 2, "next-page");
    }
    return jsonResult(
      [item("https://assets.example/9"), item("https://assets.example/17")],
      HELIUS_PAGE_LIMIT + 2,
    );
  };

  const response = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "unused" }),
    env,
    { providerFetch },
  );
  assert.equal(response.status, 200);
  const body = await responseJson(response);
  assert.deepEqual(body, {
    ok: true,
    specials: [{ id: 2, count: 1 }],
    swagpack_avatars: [
      { id: 9, count: 3 },
      { id: 8, count: 1 },
      { id: 17, count: 1 },
    ],
    swagpack_reactions: [
      { id: 9, count: 3 },
      { id: 17, count: 1 },
    ],
  });
  assert.deepEqual(Object.keys(body), [
    "ok",
    "specials",
    "swagpack_avatars",
    "swagpack_reactions",
  ]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]?.grouping, ["collection", PRIMARY_COLLECTION_ID]);
  assert.equal(calls[0]?.ownerAddress, VALID_SOLANA_ADDRESS);
  assert.equal(calls[0]?.limit, HELIUS_PAGE_LIMIT);
  assert.equal(calls[0]?.tokenType, "nonFungible");
  assert.deepEqual(calls[0]?.options, {
    showUnverifiedCollections: false,
    showCollectionMetadata: false,
    showGrandTotal: false,
    showNativeBalance: false,
    showZeroBalance: false,
  });
  assert.equal(calls[2]?.cursor, "next-page");
});

test("accepts a terminal third Helius page", async () => {
  let primaryCalls = 0;
  const fullPage = Array.from({ length: HELIUS_PAGE_LIMIT }, () =>
    item("https://assets.example/9"),
  );
  const response = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    env,
    {
      providerFetch: async (_input, init) => {
        const params = providerParams(init);
        if (params.grouping[1] === SPECIALS_COLLECTION_ID) {
          return jsonResult([]);
        }
        primaryCalls += 1;
        return jsonResult(
          fullPage,
          HELIUS_PAGE_LIMIT * HELIUS_MAX_PAGES_PER_COLLECTION,
          primaryCalls < HELIUS_MAX_PAGES_PER_COLLECTION
            ? `page-${primaryCalls}`
            : undefined,
        );
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(primaryCalls, HELIUS_MAX_PAGES_PER_COLLECTION);
  const body = await responseJson(response);
  assert.deepEqual(body.swagpack_avatars, [
    {
      id: 9,
      count: HELIUS_PAGE_LIMIT * HELIUS_MAX_PAGES_PER_COLLECTION,
    },
  ]);
});

test("refuses a fourth Helius page", async () => {
  let primaryCalls = 0;
  const fullPage = Array.from({ length: HELIUS_PAGE_LIMIT }, () =>
    item("https://assets.example/9"),
  );
  const response = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    env,
    {
      providerFetch: async (_input, init) => {
        const params = providerParams(init);
        if (params.grouping[1] === SPECIALS_COLLECTION_ID) {
          return jsonResult([]);
        }
        primaryCalls += 1;
        return rpcResult({ items: fullPage, cursor: `page-${primaryCalls}` });
      },
      logProviderFailure: () => undefined,
    },
  );

  assert.equal(response.status, 502);
  assert.equal(primaryCalls, HELIUS_MAX_PAGES_PER_COLLECTION);
  assert.deepEqual(await responseJson(response), {
    ok: false,
    error: "nft-provider-unavailable",
  });
});

test("rejects totals beyond the Helius work budget after one page", async () => {
  let primaryCalls = 0;
  const response = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    env,
    {
      providerFetch: async (_input, init) => {
        const params = providerParams(init);
        if (params.grouping[1] === SPECIALS_COLLECTION_ID) {
          return jsonResult([]);
        }
        primaryCalls += 1;
        return jsonResult(
          [item("https://assets.example/9")],
          HELIUS_PAGE_LIMIT * HELIUS_MAX_PAGES_PER_COLLECTION + 1,
          "next",
        );
      },
      logProviderFailure: () => undefined,
    },
  );

  assert.equal(response.status, 502);
  assert.equal(primaryCalls, 1);
});

test("continues short pages while a supplied total has remaining items", async () => {
  let primaryCalls = 0;
  const providerFetch: ProviderFetch = async (_input, init) => {
    const params = providerParams(init);
    if (params.grouping[1] === SPECIALS_COLLECTION_ID) {
      return jsonResult([]);
    }
    primaryCalls += 1;
    if (!params.cursor) {
      return jsonResult([item("https://assets.example/9")], 2, "next");
    }
    return jsonResult([item("https://assets.example/17")], 2);
  };

  const response = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    env,
    { providerFetch },
  );
  assert.equal(response.status, 200);
  assert.equal(primaryCalls, 2);
  assert.deepEqual(await responseJson(response), {
    ok: true,
    specials: [],
    swagpack_avatars: [
      { id: 9, count: 1 },
      { id: 17, count: 1 },
    ],
    swagpack_reactions: [
      { id: 9, count: 1 },
      { id: 17, count: 1 },
    ],
  });
});

test("continues short cursor pages without totals until an empty page", async () => {
  let primaryCalls = 0;
  const providerFetch: ProviderFetch = async (_input, init) => {
    const params = providerParams(init);
    if (params.grouping[1] === SPECIALS_COLLECTION_ID) {
      return jsonResult([]);
    }
    primaryCalls += 1;
    if (!params.cursor) {
      return rpcResult({
        items: [item("https://assets.example/9")],
        cursor: "first",
      });
    }
    if (params.cursor === "first") {
      return rpcResult({
        items: [item("https://assets.example/17")],
        cursor: "second",
      });
    }
    return rpcResult({ items: [] });
  };

  const response = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    env,
    { providerFetch },
  );
  assert.equal(response.status, 200);
  assert.equal(primaryCalls, 3);
  assert.deepEqual(await responseJson(response), {
    ok: true,
    specials: [],
    swagpack_avatars: [
      { id: 9, count: 1 },
      { id: 17, count: 1 },
    ],
    swagpack_reactions: [
      { id: 9, count: 1 },
      { id: 17, count: 1 },
    ],
  });
});

test("accepts terminal pages without requiring a continuation cursor", async () => {
  const fullPage = Array.from({ length: HELIUS_PAGE_LIMIT }, () =>
    item("https://assets.example/9"),
  );
  const scenarios: Array<{
    name: string;
    result: Record<string, unknown>;
    count: number;
  }> = [
    {
      name: "short page reaches total with cursor",
      result: {
        items: [item("https://assets.example/9")],
        total: 1,
        cursor: "unused",
      },
      count: 1,
    },
    {
      name: "short page without total or cursor",
      result: { items: [item("https://assets.example/9")] },
      count: 1,
    },
    {
      name: "full page reaches total without cursor",
      result: { items: fullPage, total: HELIUS_PAGE_LIMIT },
      count: HELIUS_PAGE_LIMIT,
    },
  ];

  for (const scenario of scenarios) {
    let primaryCalls = 0;
    const response = await handleRequest(
      post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
      env,
      {
        providerFetch: async (_input, init) => {
          const params = providerParams(init);
          if (params.grouping[1] === SPECIALS_COLLECTION_ID) {
            return jsonResult([]);
          }
          primaryCalls += 1;
          return rpcResult(scenario.result);
        },
      },
    );
    assert.equal(response.status, 200, scenario.name);
    assert.equal(primaryCalls, 1, scenario.name);
    const body = await responseJson(response);
    assert.deepEqual(
      body.swagpack_avatars,
      [{ id: 9, count: scenario.count }],
      scenario.name,
    );
  }
});

test("uses one provider timeout signal across collections and pages", async () => {
  const signals: AbortSignal[] = [];
  let primaryCalls = 0;
  const firstPage = Array.from({ length: HELIUS_PAGE_LIMIT }, () =>
    item("invalid"),
  );
  const providerFetch: ProviderFetch = async (_input, init) => {
    assert.ok(init?.signal);
    signals.push(init.signal);
    const payload = JSON.parse(String(init.body)) as {
      params: { grouping: string[]; cursor?: string };
    };
    if (payload.params.grouping[1] === SPECIALS_COLLECTION_ID) {
      return jsonResult([]);
    }
    primaryCalls += 1;
    if (!payload.params.cursor) {
      return jsonResult(firstPage, HELIUS_PAGE_LIMIT + 1, "next-page");
    }
    return jsonResult(
      [item("https://assets.example/9")],
      HELIUS_PAGE_LIMIT + 1,
    );
  };

  const response = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    env,
    { providerFetch },
  );
  assert.equal(response.status, 200);
  assert.equal(primaryCalls, 2);
  assert.equal(signals.length, 3);
  assert.equal(new Set(signals).size, 1);
  assert.equal(signals[0]?.aborted, false);
});

test("rejects repeated, cyclic, invalid, and missing cursors", async () => {
  const fullPage = Array.from({ length: HELIUS_PAGE_LIMIT }, () =>
    item("https://assets.example/9"),
  );
  const scenarios: Array<{
    name: string;
    pages: Array<{ items: unknown[]; total: number; cursor?: unknown }>;
  }> = [
    {
      name: "repeated",
      pages: [
        {
          items: fullPage,
          total: HELIUS_PAGE_LIMIT + 1,
          cursor: "same",
        },
        {
          items: [item("https://assets.example/9")],
          total: HELIUS_PAGE_LIMIT + 1,
          cursor: "same",
        },
      ],
    },
    {
      name: "cyclic",
      pages: [
        {
          items: fullPage,
          total: HELIUS_PAGE_LIMIT * 2 + 1,
          cursor: "a",
        },
        {
          items: fullPage,
          total: HELIUS_PAGE_LIMIT * 2 + 1,
          cursor: "b",
        },
        {
          items: [item("https://assets.example/9")],
          total: HELIUS_PAGE_LIMIT * 2 + 1,
          cursor: "a",
        },
      ],
    },
    {
      name: "invalid",
      pages: [
        {
          items: fullPage,
          total: HELIUS_PAGE_LIMIT + 1,
          cursor: { invalid: true },
        },
      ],
    },
    {
      name: "invalid-terminal",
      pages: [
        {
          items: [item("https://assets.example/9")],
          total: 1,
          cursor: { invalid: true },
        },
      ],
    },
    {
      name: "missing",
      pages: [{ items: fullPage, total: HELIUS_PAGE_LIMIT + 1 }],
    },
    {
      name: "missing-short",
      pages: [
        {
          items: [item("https://assets.example/9")],
          total: 2,
        },
      ],
    },
  ];

  for (const scenario of scenarios) {
    let primaryCalls = 0;
    const logged: string[] = [];
    const providerFetch: ProviderFetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as {
        params: { grouping: string[] };
      };
      if (payload.params.grouping[1] === SPECIALS_COLLECTION_ID) {
        return jsonResult([]);
      }
      const page = scenario.pages[primaryCalls];
      assert.ok(page, scenario.name);
      primaryCalls += 1;
      return new Response(JSON.stringify({ result: page }), {
        headers: { "Content-Type": "application/json" },
      });
    };

    const response = await handleRequest(
      post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
      env,
      {
        providerFetch,
        logProviderFailure: (kind) => logged.push(kind),
      },
    );
    assert.equal(response.status, 502, scenario.name);
    assert.deepEqual(await responseJson(response), {
      ok: false,
      error: "nft-provider-unavailable",
    });
    assert.equal(primaryCalls, scenario.pages.length, scenario.name);
    assert.deepEqual(logged, ["unavailable"], scenario.name);
  }
});

test("rejects invalid and contradictory Helius totals", async () => {
  const invalidTotals: unknown[] = [
    "1",
    true,
    {},
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ];

  for (const total of invalidTotals) {
    const response = await handleRequest(
      post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
      env,
      {
        providerFetch: async () => rpcResult({ items: [], total }),
        logProviderFailure: () => undefined,
      },
    );
    assert.equal(response.status, 502, String(total));
  }

  const infiniteTotal = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    env,
    {
      providerFetch: async () =>
        responseWithBody('{"result":{"items":[],"total":1e309}}'),
      logProviderFailure: () => undefined,
    },
  );
  assert.equal(infiniteTotal.status, 502);

  const contradictory = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    env,
    {
      providerFetch: async (_input, init) => {
        const params = providerParams(init);
        return params.grouping[1] === SPECIALS_COLLECTION_ID
          ? jsonResult([])
          : jsonResult(
              [
                item("https://assets.example/9"),
                item("https://assets.example/17"),
              ],
              1,
            );
      },
      logProviderFailure: () => undefined,
    },
  );
  assert.equal(contradictory.status, 502);
});

test("accepts null as an omitted Helius total", async () => {
  const response = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    env,
    {
      providerFetch: async () => rpcResult({ items: [], total: null }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), {
    ok: true,
    specials: [],
    swagpack_avatars: [],
    swagpack_reactions: [],
  });
});

test("enforces the default Helius response limit for declared and streamed bodies", async () => {
  const scenarios = [
    {
      name: "declared",
      createBody(onCancel: () => void) {
        return {
          body: new ReadableStream<Uint8Array>({
            cancel: onCancel,
          }),
          headers: {
            "Content-Length": String(MAX_HELIUS_RESPONSE_BODY_BYTES + 1),
          },
        };
      },
    },
    {
      name: "streamed",
      createBody(onCancel: () => void) {
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new Uint8Array(MAX_HELIUS_RESPONSE_BODY_BYTES + 1),
              );
            },
            cancel: onCancel,
          }),
          headers: { "Content-Length": "1" },
        };
      },
    },
  ];

  for (const scenario of scenarios) {
    let canceled = false;
    const { body, headers } = scenario.createBody(() => {
      canceled = true;
    });
    const response = await handleRequest(
      post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
      env,
      {
        providerFetch: async (_input, init) => {
          const params = providerParams(init);
          return params.grouping[1] === SPECIALS_COLLECTION_ID
            ? jsonResult([])
            : responseWithBody(body, 200, headers);
        },
        logProviderFailure: () => undefined,
      },
    );
    assert.equal(response.status, 502, scenario.name);
    assert.deepEqual(await responseJson(response), {
      ok: false,
      error: "nft-provider-unavailable",
    });
    assert.equal(canceled, true, scenario.name);
  }
});

test("rejects declared oversized Helius bodies before reading them", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
    },
    cancel() {
      canceled = true;
    },
  });
  const response = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    env,
    {
      providerFetch: async (_input, init) => {
        const params = providerParams(init);
        return params.grouping[1] === SPECIALS_COLLECTION_ID
          ? jsonResult([])
          : responseWithBody(body, 200, { "Content-Length": "65" });
      },
      providerMaxResponseBodyBytes: 64,
      logProviderFailure: () => undefined,
    },
  );
  assert.equal(response.status, 502);
  assert.equal(canceled, true);
});

test("rejects and cancels streamed oversized Helius bodies", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(65));
    },
    cancel() {
      canceled = true;
    },
  });
  const response = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    env,
    {
      providerFetch: async (_input, init) => {
        const params = providerParams(init);
        return params.grouping[1] === SPECIALS_COLLECTION_ID
          ? jsonResult([])
          : responseWithBody(body, 200, { "Content-Length": "1" });
      },
      providerMaxResponseBodyBytes: 64,
      logProviderFailure: () => undefined,
    },
  );
  assert.equal(response.status, 502);
  assert.equal(canceled, true);
});

test("accepts a valid Helius body exactly at the configured byte limit", async () => {
  const payload = rpcPayload({
    items: [item("https://assets.example/9")],
    total: 1,
  });
  const maxBytes = new TextEncoder().encode(payload).byteLength;
  const response = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    env,
    {
      providerFetch: async (_input, init) => {
        const params = providerParams(init);
        return params.grouping[1] === SPECIALS_COLLECTION_ID
          ? jsonResult([])
          : responseWithBody(payload);
      },
      providerMaxResponseBodyBytes: maxBytes,
    },
  );
  assert.equal(response.status, 200);
  const result = await responseJson(response);
  assert.deepEqual(result.swagpack_avatars, [{ id: 9, count: 1 }]);
});

test("cancels unused non-success Helius bodies without changing status mapping", async () => {
  const scenarios = [
    { status: 500, expected: 502, cancelThrows: false },
    { status: 504, expected: 504, cancelThrows: false },
    { status: 500, expected: 502, cancelThrows: true },
    { status: 504, expected: 504, cancelThrows: true },
  ];

  for (const scenario of scenarios) {
    let canceled = false;
    const response = await handleRequest(
      post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
      env,
      {
        providerFetch: async (_input, init) => {
          const params = providerParams(init);
          if (params.grouping[1] === SPECIALS_COLLECTION_ID) {
            return jsonResult([]);
          }
          return responseWithBody(
            providerErrorBody(() => {
              canceled = true;
              if (scenario.cancelThrows) {
                throw new Error("cancel failed");
              }
            }),
            scenario.status,
          );
        },
        logProviderFailure: () => undefined,
      },
    );
    assert.equal(response.status, scenario.expected, String(scenario.status));
    assert.equal(canceled, true, String(scenario.status));
  }
});

test("maps Helius HTTP, JSON-RPC, and malformed responses to generic 502s", async () => {
  const failures: ProviderFetch[] = [
    async () => new Response("provider details", { status: 500 }),
    async () =>
      new Response(JSON.stringify({ error: { message: "secret details" } })),
    async () => new Response(JSON.stringify({ result: { items: null } })),
    async () => new Response("not-json"),
  ];

  for (const providerFetch of failures) {
    const logged: string[] = [];
    const response = await handleRequest(
      post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
      env,
      {
        providerFetch,
        logProviderFailure: (kind) => logged.push(kind),
      },
    );
    assert.equal(response.status, 502);
    const serialized = JSON.stringify(await responseJson(response));
    assert.equal(serialized.includes(API_KEY), false);
    assert.equal(serialized.includes(VALID_SOLANA_ADDRESS), false);
    assert.equal(serialized.includes("helius-rpc.com"), false);
    assert.deepEqual(logged, ["unavailable"]);
  }
});

test("maps provider timeouts to a generic 504 without logging request data", async () => {
  const logged: string[] = [];
  const providerFetch: ProviderFetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  const response = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    env,
    {
      providerFetch,
      providerTimeoutMs: 5,
      logProviderFailure: (kind) => logged.push(kind),
    },
  );
  assert.equal(response.status, 504);
  assert.deepEqual(await responseJson(response), {
    ok: false,
    error: "nft-provider-timeout",
  });
  assert.deepEqual(logged, ["timeout"]);
  assert.equal(JSON.stringify(logged).includes(VALID_SOLANA_ADDRESS), false);
  assert.equal(JSON.stringify(logged).includes(API_KEY), false);
});

test("maps provider response-body timeouts to a generic 504", async () => {
  const logged: string[] = [];
  const providerFetch: ProviderFetch = async (_input, init) => {
    assert.ok(init?.signal);
    const signal = init.signal;
    const body = new ReadableStream({
      start(controller) {
        signal.addEventListener(
          "abort",
          () => controller.error(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const response = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    env,
    {
      providerFetch,
      providerTimeoutMs: 5,
      logProviderFailure: (kind) => logged.push(kind),
    },
  );
  assert.equal(response.status, 504);
  assert.deepEqual(await responseJson(response), {
    ok: false,
    error: "nft-provider-timeout",
  });
  assert.deepEqual(logged, ["timeout"]);
});

test("cancels sibling provider work while preserving the original failure", async () => {
  let siblingAborted = false;
  const logged: string[] = [];
  const providerFetch: ProviderFetch = async (_input, init) => {
    assert.ok(init?.signal);
    const payload = JSON.parse(String(init.body)) as {
      params: { grouping: string[] };
    };
    if (payload.params.grouping[1] === SPECIALS_COLLECTION_ID) {
      return new Response(null, { status: 500 });
    }
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => {
          siblingAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
  };

  const response = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    env,
    {
      providerFetch,
      logProviderFailure: (kind) => logged.push(kind),
    },
  );
  assert.equal(response.status, 502);
  assert.deepEqual(await responseJson(response), {
    ok: false,
    error: "nft-provider-unavailable",
  });
  assert.equal(siblingAborted, true);
  assert.deepEqual(logged, ["unavailable"]);
});

test("treats upstream timeout statuses as 504", async () => {
  for (const status of [408, 504]) {
    const response = await handleRequest(
      post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
      env,
      {
        providerFetch: async () => new Response(null, { status }),
        logProviderFailure: () => undefined,
      },
    );
    assert.equal(response.status, 504, String(status));
  }
});

test("returns a generic 502 when the required secret is unavailable", async () => {
  const logged: string[] = [];
  const response = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    { ...env, HELIUS_RPC_API_KEY: "" },
    { logProviderFailure: (kind) => logged.push(kind) },
  );
  assert.equal(response.status, 502);
  assert.deepEqual(logged, ["configuration"]);
});

test("normalizes the configured Helius secret before provider calls", async () => {
  const urls: string[] = [];
  const response = await handleRequest(
    post({ sol: VALID_SOLANA_ADDRESS, eth: "" }),
    { ...env, HELIUS_RPC_API_KEY: `  ${API_KEY}\n` },
    {
      providerFetch: async (input) => {
        urls.push(String(input));
        return jsonResult([]);
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(urls.length, 2);
  assert.equal(
    urls.every((url) => url.endsWith(`?api-key=${API_KEY}`)),
    true,
  );
});
