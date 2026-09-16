import assert from "node:assert/strict";
import test from "node:test";
import type {
  CompletePlayerProfile,
  ProfileLookupResponse,
} from "@mons/shared/profiles";
import {
  buildSessionRefreshToken,
  isSessionTokenResponse,
} from "@mons/shared/session-auth";
import { isSessionIdentityBootstrap } from "@mons/shared/session-bootstrap";
import { AuthApiFailure } from "../src/authErrors.ts";
import { handleAuthRoute } from "../src/authRoutes.ts";
import { handleRequest } from "../src/router.ts";
import {
  readSessionIdentityBootstrap,
  GAME_BOOTSTRAP_ENRICHMENT_TIMEOUT_MS,
} from "../src/sessionBootstrap.ts";
import {
  handleSessionRoute,
  type SessionRouteDependencies,
} from "../src/sessionRoutes.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const uid = "a".repeat(28);
const input = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  refreshSecret: "A".repeat(43),
  revokeSecret: `${"B".repeat(42)}A`,
};
const profile: CompletePlayerProfile = {
  id: "identity-profile",
  username: "Alice",
  eth: null,
  sol: null,
  rating: 1500,
  nonce: 2,
  totalManaPoints: 3,
  win: true,
  emoji: 4,
  mining: {
    lastRockDate: null,
    materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  },
};
const env: Env = { ...TELEGRAM_TEST_ENV };

function request(
  endpoint = "refresh",
  query = "bootstrapIdentity=1",
  signal?: AbortSignal,
): Request {
  return new Request(
    `https://api.mons.link/auth/session/${endpoint}${query ? `?${query}` : ""}`,
    {
      method: "POST",
      signal,
      headers: {
        Origin: "https://mons.link",
        ...(endpoint === "anonymous"
          ? { "Content-Type": "application/json" }
          : {
              Authorization: `Bearer ${buildSessionRefreshToken(input.sessionId, input.refreshSecret)}`,
            }),
      },
      ...(endpoint === "anonymous" ? { body: JSON.stringify(input) } : {}),
    },
  );
}

function dependencies(
  readIdentity: (uid: string) => Promise<ProfileLookupResponse>,
): SessionRouteDependencies {
  return {
    repository: {
      create: async () => ({ uid, sessionId: input.sessionId }),
      refresh: async () => ({ uid, sessionId: input.sessionId }),
      revoke: async () => undefined,
    },
    identity: { readIdentity },
  };
}

test("opt-in create and refresh include a full identity seed; ordinary tokens keep their exact shape and timings", async () => {
  for (const endpoint of ["anonymous", "refresh"]) {
    for (const include of [false, true]) {
      const calls: string[] = [];
      const response = await handleSessionRoute(
        request(endpoint, include ? "bootstrapIdentity=1" : ""),
        env,
        dependencies(async (loginUid) => {
          calls.push(loginUid);
          return { ok: true, profile };
        }),
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, unknown>;
      const { identityBootstrap, ...token } = body;
      assert.ok(isSessionTokenResponse(token));
      assert.deepEqual(calls, include ? [uid] : []);
      if (include) {
        assert.ok(isSessionIdentityBootstrap(identityBootstrap));
        assert.deepEqual(identityBootstrap, { ok: true, profile });
        assert.match(
          response.headers.get("Server-Timing") || "",
          /identity;dur=/,
        );
      } else {
        assert.ok(isSessionTokenResponse(body));
        assert.equal(Object.hasOwn(body, "identityBootstrap"), false);
      }
      assert.match(response.headers.get("Server-Timing") || "", /session;dur=/);
      assert.match(response.headers.get("Server-Timing") || "", /total;dur=/);
      assert.equal(
        response.headers.get("Timing-Allow-Origin"),
        "https://mons.link",
      );
      assert.match(
        response.headers.get("Access-Control-Expose-Headers") || "",
        /Server-Timing/,
      );
    }
  }
});

test("invalid identity opt-ins fail before session allocation or identity lookup", async () => {
  const deps = dependencies(async () => {
    throw new Error("unexpected-identity-read");
  });
  deps.repository!.create = async () => {
    throw new Error("unexpected-allocation");
  };
  for (const query of [
    "bootstrapIdentity=0",
    "bootstrapIdentity=true",
    "bootstrapIdentity=",
    "bootstrapIdentity=1&bootstrapIdentity=1",
    "bootstrapIdentity=1&uid=chosen-user",
  ]) {
    assert.equal(
      (await handleSessionRoute(request("anonymous", query), env, deps)).status,
      400,
    );
  }
  assert.equal(
    (await handleSessionRoute(request("logout"), env, deps)).status,
    400,
  );
});

test("missing ownership, repair, read failure and oversized profiles preserve valid session tokens", async () => {
  for (const [readIdentity, expected] of [
    [
      async () => ({ ok: true as const, profile: null }),
      { ok: true, profile: null },
    ],
    [
      async () => {
        throw new AuthApiFailure(
          409,
          "failed-precondition",
          "profile-repair-required",
        );
      },
      { ok: false, status: 409 },
    ],
    [
      async () => {
        throw new Error("private-d1-detail");
      },
      { ok: false, status: 503 },
    ],
    [
      async () => ({
        ok: true as const,
        profile: { ...profile, cardStickers: "x".repeat(65_536) },
      }),
      { ok: false, status: 503 },
    ],
  ] as const) {
    const response = await handleSessionRoute(
      request(),
      env,
      dependencies(readIdentity),
    );
    assert.equal(response.status, 200);
    const { identityBootstrap, ...token } = (await response.json()) as Record<
      string,
      unknown
    >;
    assert.ok(isSessionTokenResponse(token));
    assert.deepEqual(identityBootstrap, expected);
  }
});

test("identity deadline and cancellation preserve the issued token and reject late data", async () => {
  let expire: (() => void) | undefined;
  let resolveRead: ((value: ProfileLookupResponse) => void) | undefined;
  let cleared = 0;
  const deps = dependencies(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
  );
  deps.identity!.setTimer = (callback, ms) => {
    assert.equal(ms, GAME_BOOTSTRAP_ENRICHMENT_TIMEOUT_MS);
    expire = callback;
    return 1;
  };
  deps.identity!.clearTimer = () => {
    cleared++;
  };
  const result = handleSessionRoute(request(), env, deps);
  while (!expire) await new Promise<void>((resolve) => setImmediate(resolve));
  expire();
  const response = await result;
  const { identityBootstrap, ...token } = (await response.json()) as Record<
    string,
    unknown
  >;
  assert.ok(isSessionTokenResponse(token));
  assert.deepEqual(identityBootstrap, { ok: false, status: 503 });
  resolveRead!({ ok: true, profile });
  assert.equal(cleared, 1);

  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await readSessionIdentityBootstrap(
      request("refresh", "bootstrapIdentity=1", controller.signal),
      uid,
      env,
      {
        readIdentity: async () => {
          throw new Error("unexpected-read");
        },
      },
    ),
    { ok: false, status: 503 },
  );
});

test("failed session authentication never reads identity", async () => {
  const deps = dependencies(async () => {
    throw new Error("unexpected-identity-read");
  });
  deps.repository!.refresh = async () => {
    throw new AuthApiFailure(401, "unauthenticated", "session-revoked");
  };
  assert.equal((await handleSessionRoute(request(), env, deps)).status, 401);
});

test("authenticated identity route derives the login from the token and keeps failures distinct", async () => {
  for (const result of [profile, null]) {
    const response = await handleRequest(
      new Request("https://api.mons.link/auth/identity", {
        headers: { Origin: "https://mons.link" },
      }),
      env,
      {
        auth: {
          verifyIdentity: async () => ({ uid }),
          readIdentity: async (loginUid) => {
            assert.equal(loginUid, uid);
            return { ok: true, profile: result };
          },
        },
      },
      { waitUntil() {} },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, profile: result });
    assert.match(response.headers.get("Server-Timing") || "", /identity;dur=/);
  }
  for (const status of [409, 503]) {
    const response = await handleAuthRoute(
      new Request("https://api.mons.link/auth/identity"),
      env,
      { waitUntil() {} },
      {
        verifyIdentity: async () => ({ uid }),
        readIdentity: async () => {
          if (status === 409)
            throw new AuthApiFailure(
              409,
              "failed-precondition",
              "profile-repair-required",
            );
          throw new Error("private");
        },
        logFailure: () => undefined,
      },
    );
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /private/);
  }
});

test("identity route rejects foreign origins, wrong methods, identity parameters and unauthenticated callers before profile reads", async () => {
  for (const [request, expected] of [
    [
      new Request("https://api.mons.link/auth/identity", {
        headers: { Origin: "https://foreign.invalid" },
      }),
      403,
    ],
    [
      new Request("https://api.mons.link/auth/identity", { method: "POST" }),
      405,
    ],
    [new Request("https://api.mons.link/auth/identity?uid=another-user"), 400],
  ] as const) {
    const response = await handleAuthRoute(
      request,
      env,
      { waitUntil() {} },
      {
        verifyIdentity: async () => ({ uid }),
        readIdentity: async () => {
          throw new Error("unexpected-read");
        },
      },
    );
    assert.equal(response.status, expected);
  }
  const response = await handleAuthRoute(
    new Request("https://api.mons.link/auth/identity"),
    env,
    { waitUntil() {} },
    {
      verifyIdentity: async () => {
        throw new AuthApiFailure(
          401,
          "unauthenticated",
          "authentication-required",
        );
      },
      readIdentity: async () => {
        throw new Error("unexpected-read");
      },
    },
  );
  assert.equal(response.status, 401);
});
