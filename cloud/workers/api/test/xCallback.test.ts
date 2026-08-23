import assert from "node:assert/strict";
import test from "node:test";
import {
  XFlowConflict,
  type XFlowRepository,
  type XRedirectFlow,
} from "../src/firestore.ts";
import { handleXCallback } from "../src/xCallback.ts";
import { XProviderFailure, type XOAuthProvider } from "../src/xProvider.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const FLOW_ID = "abcdefghijklmnopqrstuvwx";
const CALLBACK_URL = `https://api.mons.link/auth/x/callback?state=${FLOW_ID}`;
const UPDATE_TIME = "2026-08-22T00:00:00Z";

const env = {
  ...TELEGRAM_TEST_ENV,
  FIRESTORE_SERVICE_ACCOUNT_EMAIL: "worker@example.iam.gserviceaccount.com",
  FIRESTORE_SERVICE_ACCOUNT_PRIVATE_KEY: "test-private-key",
  HELIUS_RPC_API_KEY: "test-helius-key",
  AUTH_DISABLE_X_VERIFY: "false",
  AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  NFT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  X_CLIENT_ID: "test-x-client",
  X_CLIENT_SECRET: "test-x-secret",
} as Env;

function flow(overrides: Partial<XRedirectFlow> = {}): XRedirectFlow {
  return {
    returnUrl: "https://mons.link/settings?tab=identity",
    consentSource: "settings",
    status: "created",
    errorCode: "",
    expiresAtMs: 1_500_000,
    createdAtMs: 900_000,
    callbackUri: "https://api.mons.link/auth/x/callback",
    codeVerifier: "verifier",
    processingStartedAtMs: 0,
    updateTime: UPDATE_TIME,
    ...overrides,
  };
}

function createRepository(
  value: XRedirectFlow | null = flow(),
  updates: Array<Record<string, unknown>> = [],
): XFlowRepository {
  return {
    getFlow: async () => value,
    updateFlow: async (_flowId, update) => {
      updates.push(update);
      return "2026-08-22T00:00:01Z";
    },
  };
}

function createProvider(
  overrides: Partial<XOAuthProvider> = {},
): XOAuthProvider {
  return {
    exchangeCode: async () => "x-access-token",
    fetchAuthenticatedUser: async () => ({
      id: "2244994945",
      username: "mons",
    }),
    ...overrides,
  };
}

function assertSecurityHeaders(response: Response) {
  assert.match(response.headers.get("cache-control") || "", /no-store/i);
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("expires"), "0");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

function redirectParameters(response: Response) {
  const location = response.headers.get("location");
  assert.ok(location);
  return new URL(location);
}

test("rejects unsupported methods and invalid states before dependencies", async () => {
  const repository: XFlowRepository = {
    getFlow: async () => {
      throw new Error("must not read");
    },
    updateFlow: async () => {
      throw new Error("must not write");
    },
  };
  for (const [request, status] of [
    [new Request(CALLBACK_URL, { method: "POST" }), 405],
    [new Request("https://api.mons.link/auth/x/callback"), 400],
    [new Request("https://api.mons.link/auth/x/callback?state=short"), 400],
  ] as const) {
    const response = await handleXCallback(request, env, { repository });
    assert.equal(response.status, status);
    assertSecurityHeaders(response);
    assert.equal(response.headers.get("location"), null);
  }
});

test("returns a bounded not-found response for an unknown flow", async () => {
  const response = await handleXCallback(new Request(CALLBACK_URL), env, {
    repository: createRepository(null),
  });
  assert.equal(response.status, 400);
  assert.equal(await response.text(), "X auth session not found.");
  assertSecurityHeaders(response);
});

test("redirects verified and completed flows without calling X or Firestore writes", async () => {
  for (const status of ["verified", "completed"]) {
    let providerCalls = 0;
    const updates: Array<Record<string, unknown>> = [];
    const response = await handleXCallback(new Request(CALLBACK_URL), env, {
      repository: createRepository(flow({ status }), updates),
      provider: createProvider({
        exchangeCode: async () => {
          providerCalls++;
          return "unused";
        },
      }),
    });
    assert.equal(response.status, 302);
    assertSecurityHeaders(response);
    const location = redirectParameters(response);
    assert.equal(location.origin, "https://mons.link");
    assert.equal(location.pathname, "/settings");
    assert.equal(location.searchParams.get("tab"), "identity");
    assert.equal(location.searchParams.get("x_auth_flow"), FLOW_ID);
    assert.equal(location.searchParams.get("x_auth_status"), "ready");
    assert.equal(location.searchParams.get("x_auth_error"), null);
    assert.equal(location.searchParams.get("x_auth_consent"), "settings");
    assert.equal(providerCalls, 0);
    assert.deepEqual(updates, []);
  }
});

test("redirects failed flows with the stored error", async () => {
  const response = await handleXCallback(new Request(CALLBACK_URL), env, {
    repository: createRepository(
      flow({ status: "failed", errorCode: "x-oauth-access-denied" }),
    ),
  });
  const location = redirectParameters(response);
  assert.equal(response.status, 302);
  assert.equal(location.searchParams.get("x_auth_status"), "failed");
  assert.equal(
    location.searchParams.get("x_auth_error"),
    "x-oauth-access-denied",
  );
});

test("persists expiration, X denial, and missing-code failures", async () => {
  const cases = [
    {
      request: new Request(CALLBACK_URL),
      value: flow({ expiresAtMs: 999_999 }),
      errorCode: "x-redirect-expired",
    },
    {
      request: new Request(`${CALLBACK_URL}&error=access_denied`),
      value: flow(),
      errorCode: "x-oauth-access_denied",
    },
    {
      request: new Request(CALLBACK_URL),
      value: flow(),
      errorCode: "x-oauth-missing-code",
    },
  ];
  for (const item of cases) {
    const updates: Array<Record<string, unknown>> = [];
    const response = await handleXCallback(item.request, env, {
      repository: createRepository(item.value, updates),
      now: () => 1_000_000,
    });
    assert.equal(response.status, 302);
    assert.deepEqual(updates, [
      {
        status: "failed",
        errorCode: item.errorCode,
        updatedAtMs: 1_000_000,
      },
    ]);
    assert.equal(
      redirectParameters(response).searchParams.get("x_auth_error"),
      item.errorCode,
    );
  }
});

test("claims a callback before exchanging its single-use code", async () => {
  let current = flow();
  let version = 0;
  let exchanges = 0;
  let initialReads = 0;
  let releaseInitialReads!: () => void;
  let releaseExchange!: () => void;
  const initialReadGate = new Promise<void>((resolve) => {
    releaseInitialReads = resolve;
  });
  const exchangeGate = new Promise<void>((resolve) => {
    releaseExchange = resolve;
  });
  const repository: XFlowRepository = {
    getFlow: async () => {
      const snapshot = structuredClone(current);
      if (initialReads < 2) {
        initialReads++;
        if (initialReads === 2) {
          releaseInitialReads();
        }
        await initialReadGate;
      }
      return snapshot;
    },
    updateFlow: async (_flowId, update, updateTime) => {
      if (updateTime !== current.updateTime) {
        throw new XFlowConflict();
      }
      version++;
      current = {
        ...current,
        ...update,
        processingStartedAtMs:
          typeof update.processingStartedAtMs === "number"
            ? update.processingStartedAtMs
            : 0,
        updateTime: `2026-08-22T00:00:0${version}Z`,
      };
      return current.updateTime;
    },
  };
  const provider = createProvider({
    exchangeCode: async () => {
      exchanges++;
      if (exchanges > 1) {
        throw new XProviderFailure("x-token-exchange-invalid-grant");
      }
      await exchangeGate;
      return "x-access-token";
    },
  });
  const first = handleXCallback(
    new Request(`${CALLBACK_URL}&code=authorization-code`),
    env,
    { repository, provider, now: () => 1_000_000 },
  );
  const second = handleXCallback(
    new Request(`${CALLBACK_URL}&code=authorization-code`),
    env,
    { repository, provider, now: () => 1_000_000 },
  );
  const duplicate = await Promise.race([first, second]);
  const exchangeCountBeforeRelease = exchanges;
  releaseExchange();
  const responses = await Promise.all([first, second]);
  const response = responses.find((candidate) => candidate.status === 302);

  assert.equal(duplicate.status, 503);
  assert.equal(duplicate.headers.get("Retry-After"), "2");
  assert.equal(exchangeCountBeforeRelease, 1);
  assert.equal(exchanges, 1);
  assert.ok(response);
  assert.equal(response.status, 302);
  assert.equal(
    redirectParameters(response).searchParams.get("x_auth_status"),
    "ready",
  );
  assert.equal(current.status, "verified");
});

test("keeps a processing lease active across negative clock skew", async () => {
  let exchanges = 0;
  const response = await handleXCallback(
    new Request(`${CALLBACK_URL}&code=authorization-code`),
    env,
    {
      repository: createRepository(
        flow({ status: "processing", processingStartedAtMs: 1_000_100 }),
      ),
      provider: createProvider({
        exchangeCode: async () => {
          exchanges++;
          return "x-access-token";
        },
      }),
      now: () => 1_000_000,
    },
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "2");
  assert.equal(exchanges, 0);
});

test("reclaims a stale callback processing lease", async () => {
  const updates: Array<Record<string, unknown>> = [];
  let exchanges = 0;
  const response = await handleXCallback(
    new Request(`${CALLBACK_URL}&code=authorization-code`),
    env,
    {
      repository: createRepository(
        flow({ status: "processing", processingStartedAtMs: 900_000 }),
        updates,
      ),
      provider: createProvider({
        exchangeCode: async () => {
          exchanges++;
          return "x-access-token";
        },
      }),
      now: () => 1_000_000,
    },
  );

  assert.equal(exchanges, 1);
  assert.equal(response.status, 302);
  assert.deepEqual(
    updates.map((update) => update.status),
    ["processing", "verified"],
  );
});

test("returns a completed redirect when a claimed callback loses its final write", async () => {
  const values = [
    flow(),
    flow({
      status: "completed",
      updateTime: "2026-08-22T00:00:02Z",
    }),
  ];
  let exchanges = 0;
  let userReads = 0;
  let writes = 0;
  const response = await handleXCallback(
    new Request(`${CALLBACK_URL}&code=authorization-code`),
    env,
    {
      repository: {
        getFlow: async () => values.shift() || null,
        updateFlow: async (_flowId, update, updateTime) => {
          writes++;
          if (writes === 1) {
            assert.equal(update.status, "processing");
            assert.equal(updateTime, UPDATE_TIME);
            return "2026-08-22T00:00:01Z";
          }
          assert.equal(update.status, "verified");
          assert.equal(updateTime, "2026-08-22T00:00:01Z");
          throw new XFlowConflict();
        },
      },
      provider: createProvider({
        exchangeCode: async () => {
          exchanges++;
          return "x-access-token";
        },
        fetchAuthenticatedUser: async () => {
          userReads++;
          return { id: "2244994945", username: "mons" };
        },
      }),
      now: () => 1_000_000,
    },
  );

  assert.equal(exchanges, 1);
  assert.equal(userReads, 1);
  const location = redirectParameters(response);
  assert.equal(location.searchParams.get("x_auth_status"), "ready");
});

test("retries a transient final write without re-exchanging the code", async () => {
  let current = flow();
  let version = 0;
  let exchanges = 0;
  let verifiedWrites = 0;
  const repository: XFlowRepository = {
    getFlow: async () => structuredClone(current),
    updateFlow: async (_flowId, update, updateTime) => {
      if (updateTime !== current.updateTime) {
        throw new XFlowConflict();
      }
      if (update.status === "verified" && verifiedWrites++ === 0) {
        throw new Error("transient-write-failure");
      }
      version++;
      current = {
        ...current,
        ...update,
        processingStartedAtMs:
          typeof update.processingStartedAtMs === "number"
            ? update.processingStartedAtMs
            : 0,
        updateTime: `2026-08-22T00:00:0${version}Z`,
      };
      return current.updateTime;
    },
  };
  const response = await handleXCallback(
    new Request(`${CALLBACK_URL}&code=authorization-code`),
    env,
    {
      repository,
      provider: createProvider({
        exchangeCode: async () => {
          exchanges++;
          return "x-access-token";
        },
      }),
      now: () => 1_000_000,
    },
  );

  assert.equal(response.status, 302);
  assert.equal(exchanges, 1);
  assert.equal(verifiedWrites, 2);
  assert.equal(current.status, "verified");
});

test("exchanges the stored callback URI and verifier before persisting success", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const calls: Array<Record<string, unknown>> = [];
  const provider = createProvider({
    exchangeCode: async (input) => {
      calls.push(input);
      return "private-access-token";
    },
    fetchAuthenticatedUser: async (accessToken) => {
      calls.push({ accessToken });
      return { id: "2244994945", username: "XDevelopers" };
    },
  });
  const response = await handleXCallback(
    new Request(`${CALLBACK_URL}&code=authorization-code`),
    env,
    {
      repository: createRepository(flow(), updates),
      provider,
      now: () => 1_000_000,
    },
  );
  assert.deepEqual(calls, [
    {
      code: "authorization-code",
      callbackUri: "https://api.mons.link/auth/x/callback",
      codeVerifier: "verifier",
    },
    { accessToken: "private-access-token" },
  ]);
  assert.deepEqual(updates, [
    {
      status: "processing",
      processingStartedAtMs: 1_000_000,
      errorCode: null,
      updatedAtMs: 1_000_000,
    },
    {
      status: "verified",
      xUserId: "2244994945",
      xUsername: "XDevelopers",
      errorCode: null,
      processingStartedAtMs: null,
      updatedAtMs: 1_000_000,
    },
  ]);
  assert.equal(response.status, 302);
  assert.equal(
    redirectParameters(response).searchParams.get("x_auth_status"),
    "ready",
  );
});

test("persists sanitized provider failures without logging credentials", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const logged: string[] = [];
  const response = await handleXCallback(
    new Request(`${CALLBACK_URL}&code=sensitive-code`),
    env,
    {
      repository: createRepository(flow(), updates),
      provider: createProvider({
        exchangeCode: async () => {
          throw new XProviderFailure("x-token-exchange-invalid-grant");
        },
      }),
      now: () => 1_000_000,
      logFailure: (kind) => logged.push(kind),
    },
  );
  assert.deepEqual(logged, ["x-provider"]);
  assert.deepEqual(updates, [
    {
      status: "processing",
      processingStartedAtMs: 1_000_000,
      errorCode: null,
      updatedAtMs: 1_000_000,
    },
    {
      status: "failed",
      errorCode: "x-token-exchange-invalid-grant",
      processingStartedAtMs: null,
      updatedAtMs: 1_000_000,
    },
  ]);
  const serialized = JSON.stringify({ logged, updates });
  assert.equal(serialized.includes("sensitive-code"), false);
  assert.equal(serialized.includes("test-x-secret"), false);
  assert.equal(response.status, 302);
});

test("fails closed on Firestore read and write failures", async () => {
  const logged: string[] = [];
  const readFailure = await handleXCallback(new Request(CALLBACK_URL), env, {
    repository: {
      getFlow: async () => {
        throw new Error("private-read-detail");
      },
      updateFlow: async () => UPDATE_TIME,
    },
    logFailure: (kind) => logged.push(kind),
  });
  assert.equal(readFailure.status, 503);
  assert.equal(await readFailure.text(), "Service Unavailable");
  assertSecurityHeaders(readFailure);

  const writeFailure = await handleXCallback(
    new Request(`${CALLBACK_URL}&error=access_denied`),
    env,
    {
      repository: {
        getFlow: async () => flow(),
        updateFlow: async () => {
          throw new Error("private-write-detail");
        },
      },
      logFailure: (kind) => logged.push(kind),
    },
  );
  assert.equal(writeFailure.status, 503);
  assert.equal(writeFailure.headers.get("location"), null);
  assert.deepEqual(logged, ["firestore-read", "firestore-update"]);
});

test("falls back to mons.link for an unsafe stored return URL", async () => {
  const response = await handleXCallback(new Request(CALLBACK_URL), env, {
    repository: createRepository(
      flow({ status: "verified", returnUrl: "https://attacker.invalid/path" }),
    ),
  });
  const location = redirectParameters(response);
  assert.equal(location.origin, "https://mons.link");
  assert.equal(location.pathname, "/");
});
