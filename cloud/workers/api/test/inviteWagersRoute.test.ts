import { socketTestIdentity } from "./socketTestSession.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { InviteMetadataSnapshot } from "@mons/shared/invite-metadata";
import {
  INVITE_WAGERS_MAX_MESSAGE_BYTES,
  INVITE_WAGERS_SOCKET_PROTOCOL,
  isReadInviteWagersResponse,
  type InviteWagersSnapshot,
} from "@mons/shared/invite-wagers";
import { AuthApiFailure } from "../src/authErrors.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import type { InviteWagersReadResult } from "../src/inviteWagers.ts";
import {
  handleInviteWagersRoute,
  isInviteWagersPath,
  type InviteWagersRouteDependencies,
} from "../src/inviteWagersRoute.ts";
import { handleRequest } from "../src/router.ts";
import { TELEGRAM_TEST_ENV, withInviteSourceReads } from "./testEnv.ts";

const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };
const token = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJob3N0LWxvZ2luIn0.signature";
const metadata: InviteMetadataSnapshot = {
  inviteId: "invite-one",
  revision: 4,
  hostId: "host-login",
  guestId: "guest-login",
  hostColor: "white",
  hostRematches: "1",
  guestRematches: "1",
  automatchStateHint: null,
  eventId: null,
  eventOwned: false,
};
const snapshot: InviteWagersSnapshot = {
  inviteId: "invite-one",
  revision: 7,
  wagers: {
    "invite-one": {
      proposedBy: { "host-login": true, "guest-login": true },
      agreed: {
        material: "dust",
        count: 3,
        total: 6,
        proposerId: "host-login",
        accepterId: "guest-login",
        acceptedAt: 100,
      },
      resolved: {
        material: "dust",
        count: 3,
        total: 6,
        winnerId: "guest-login",
        loserId: "host-login",
        resolvedAt: 200,
      },
    },
    "invite-one1": {
      proposals: {
        "host-login": { material: "slime", count: 2, createdAt: 300 },
      },
      proposedBy: { "host-login": true },
    },
  },
};

function request({
  socket = false,
  authenticated = false,
  path,
  method = "GET",
  headers = {},
}: {
  socket?: boolean;
  authenticated?: boolean;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
} = {}): Request {
  return new Request(
    `https://api.mons.link${path ?? `/invites/invite-one/wagers${socket ? "/socket" : ""}`}`,
    {
      method,
      headers: {
        Origin: "https://mons.link",
        "CF-Connecting-IP": "192.0.2.1",
        ...(socket
          ? {
              Upgrade: "websocket",
              "Sec-WebSocket-Protocol": `${INVITE_WAGERS_SOCKET_PROTOCOL}${authenticated ? `, bearer.${token}` : ""}`,
            }
          : authenticated
            ? { Authorization: `Bearer ${token}` }
            : {}),
        ...headers,
      },
    },
  );
}

function setup({
  guestId = "guest-login",
  passwordProtected = false,
  caller = "host-login",
}: {
  guestId?: string | null;
  passwordProtected?: boolean;
  caller?: string;
} = {}) {
  const calls = {
    sources: 0,
    reads: 0,
    auth: 0,
    logs: 0,
    rates: [] as string[],
    sockets: [] as Request[],
  };
  const state = {
    result: {
      status: "ok",
      snapshot: structuredClone(snapshot),
      metadata: {
        status: "ok",
        snapshot: { ...metadata, guestId },
        passwordProtected,
        automatchOperationIds: { [caller]: "private-operation-id" },
      },
    } as InviteWagersReadResult,
  };
  const env = withInviteSourceReads(
    {
      ...TELEGRAM_TEST_ENV,
      REACTION_RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          calls.rates.push(key);
          return { success: true };
        },
      },
    } as Env,
    (inviteId) => {
      calls.sources++;
      assert.equal(inviteId, metadata.inviteId);
      return { hostId: metadata.hostId, guestId: guestId };
    },
  );
  const repository = createGameplayRepository(env, {
    stateClient: {
      getPath: async () => {
        throw new Error("unexpected-source-read");
      },
      patchRoot: async () => {
        throw new Error("unexpected-write");
      },
      transactPath: async () => {
        throw new Error("unexpected-write");
      },
    },
  });
  repository.getStatePath = async () => {
    throw new Error("unexpected-full-state-read");
  };
  repository.readProfileOwnershipSnapshot = async (query) => ({
    canonicalProfileIdByProfileId: new Map(),
    loginOwnerByUid: new Map(query.loginUids.map((uid) => [uid, null])),
    loginUidsByProfileId: new Map(),
    profileById: new Map(),
  });
  const identity = socketTestIdentity(caller);
  const dependencies: InviteWagersRouteDependencies = {
    repository,
    room: {
      readWagers: async (inviteId) => {
        assert.equal(inviteId, "invite-one");
        calls.reads++;
        return state.result;
      },
      fetch: async (incoming) => {
        calls.sockets.push(incoming);
        return new Response("upgrade");
      },
    },
    verifyIdentity: async (incoming) => {
      calls.auth++;
      assert.equal(incoming.headers.get("Authorization"), `Bearer ${token}`);
      return identity;
    },
    logFailure: () => {
      calls.logs++;
    },
  };
  return { env, identity, dependencies, repository, calls, state };
}

test("wager routes and preflight dispatch without touching identity or storage", async () => {
  for (const path of [
    "/invites/invite-one/wagers",
    "/invites/invite-one/wagers/socket",
  ]) {
    assert.equal(isInviteWagersPath(path), true);
  }
  for (const path of [
    "/invites/invite-one/metadata",
    "/invites/invite-one/wagers/extra",
    "/wagers/send",
  ]) {
    assert.equal(isInviteWagersPath(path), false);
  }
  const h = setup();
  const preflight = await handleRequest(
    request({ method: "OPTIONS" }),
    h.env,
    { wagers: h.dependencies },
    ctx,
  );
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("Access-Control-Allow-Origin"),
    "https://mons.link",
  );
  assert.equal(preflight.headers.get("Cache-Control"), "no-store");
  const invalidPreflight = await handleInviteWagersRoute(
    request({ method: "OPTIONS", path: "/invites/invite-one/wagers?extra=1" }),
    h.env,
    ctx,
    h.dependencies,
  );
  assert.equal(invalidPreflight.status, 400);
  for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
    const response = await handleRequest(
      request({ method }),
      h.env,
      { wagers: h.dependencies },
      ctx,
    );
    assert.equal(response.status, 405);
  }
  const unavailable = await handleRequest(request(), h.env, {
    wagers: h.dependencies,
  });
  assert.equal(unavailable.status, 503);
  assert.equal(h.calls.auth, 0);
  assert.equal(h.calls.sources, 0);
  assert.equal(h.calls.reads, 0);
  assert.equal(h.calls.rates.length, 0);
});

test("paired public reads expose the wager contract without metadata or admission secrets", async () => {
  for (const passwordProtected of [false, true]) {
    const h = setup({ passwordProtected });
    const response = await handleRequest(
      request(),
      h.env,
      { wagers: h.dependencies },
      ctx,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = await response.json();
    assert.equal(isReadInviteWagersResponse(body), true);
    assert.deepEqual(body, { ok: true, snapshot });
    assert.equal(h.calls.auth, 0);
    assert.deepEqual(h.calls.rates, ["wagers:read:spectator:192.0.2.1"]);
  }
});

test("HTTP and socket access preserve pending open, private and paired invite permissions", async () => {
  for (const socket of [false, true]) {
    for (const guestId of [null, "guest-login"]) {
      for (const passwordProtected of [false, true]) {
        for (const caller of [null, "host-login", "guest-login", "outsider"]) {
          const h = setup({
            guestId,
            passwordProtected,
            caller: caller ?? "host-login",
          });
          const response = await handleInviteWagersRoute(
            request({ socket, authenticated: caller !== null }),
            h.env,
            ctx,
            h.dependencies,
          );
          const allowed =
            guestId !== null ||
            (caller !== null &&
              (!passwordProtected || caller === "host-login"));
          assert.equal(
            response.status,
            allowed ? 200 : 403,
            JSON.stringify({ socket, guestId, passwordProtected, caller }),
          );
          if (socket && allowed) {
            const forwarded = h.calls.sockets[0];
            assert.equal(
              forwarded.headers.get("X-Mons-Wagers-Authenticated"),
              caller ? "1" : "0",
            );
            assert.equal(
              forwarded.headers.get("X-Mons-Wagers-Role"),
              caller === "host-login"
                ? "host"
                : caller && caller === guestId
                  ? "guest"
                  : "spectator",
            );
          }
        }
      }
    }
  }
});

test("private linked-host admission resolves canonical D1 ownership without Firebase shadows", async () => {
  for (const socket of [false, true]) {
    const h = setup({
      guestId: null,
      passwordProtected: true,
      caller: "linked-login",
    });
    const ownershipReads: string[][] = [];
    h.repository.readProfileOwnershipSnapshot = async (query) => {
      ownershipReads.push([...query.loginUids]);
      return {
        canonicalProfileIdByProfileId: new Map(),
        loginOwnerByUid: new Map(
          query.loginUids.map((uid) => [
            uid,
            { profileId: "profile-one", revision: 1 },
          ]),
        ),
        loginUidsByProfileId: new Map([
          ["profile-one", ["host-login", "linked-login"]],
        ]),
        profileById: new Map([
          [
            "profile-one",
            {
              revision: 1,
              profile: {
                profileId: "profile-one",
                aura: "",
                emoji: 1000,
                eth: "",
                sol: "",
                username: "",
                rating: 1500,
              },
            },
          ],
        ]),
      };
    };
    const response = await handleInviteWagersRoute(
      request({ socket, authenticated: true }),
      h.env,
      ctx,
      h.dependencies,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(ownershipReads, [["linked-login", "host-login"]]);
    assert.equal(h.calls.sources, 1);
    if (socket) {
      assert.equal(
        h.calls.sockets[0].headers.get("X-Mons-Wagers-Role"),
        "host",
      );
      assert.equal(
        h.calls.sockets[0].headers.get("X-Mons-Wagers-Actor"),
        "host-login",
      );
    }
  }
});

test("upgrade strips caller credentials and spoofed admission headers", async () => {
  const h = setup({ guestId: null, passwordProtected: true });
  const response = await handleInviteWagersRoute(
    request({
      socket: true,
      authenticated: true,
      headers: {
        Authorization: `Bearer ${token}`,
        Cookie: "private-session",
        "X-Mons-Wagers-Role": "spectator",
        "X-Mons-Wagers-Actor": "intruder",
        "X-Mons-Wagers-Revision": "999",
        "X-Mons-Wagers-Protected": "0",
        "X-Mons-Session-Id": "untrusted",
        "X-Mons-Session-Expires-At": "9999999999999",
      },
    }),
    h.env,
    ctx,
    h.dependencies,
  );
  assert.equal(response.status, 200);
  const forwarded = h.calls.sockets[0];
  assert.equal(forwarded.url, "https://reactions.internal/wagers/socket");
  assert.deepEqual(Object.fromEntries(forwarded.headers), {
    "sec-websocket-protocol": INVITE_WAGERS_SOCKET_PROTOCOL,
    upgrade: "websocket",
    "x-mons-session-id": h.identity.sid,
    "x-mons-session-expires-at": String(h.identity.authExpiresAtMs),
    "x-mons-wagers-actor": "host-login",
    "x-mons-wagers-authenticated": "1",
    "x-mons-wagers-invite": "invite-one",
    "x-mons-wagers-ip": "192.0.2.1",
    "x-mons-wagers-protected": "1",
    "x-mons-wagers-revision": "7",
    "x-mons-wagers-role": "host",
  });
  assert.deepEqual(h.calls.rates, ["wagers:connect:identity:host-login"]);
});

test("Authorization-only socket authentication uses the wager protocol and verifies once", async () => {
  const h = setup();
  const response = await handleInviteWagersRoute(
    request({ socket: true, headers: { Authorization: `Bearer ${token}` } }),
    h.env,
    ctx,
    h.dependencies,
  );
  assert.equal(response.status, 200);
  assert.equal(h.calls.auth, 1);
  assert.equal(h.calls.sockets[0].headers.get("Authorization"), null);
});

test("malformed routes, origins, protocols and socket tokens fail before auth or storage", async () => {
  const cases: Array<{
    options: Parameters<typeof request>[0];
    status: number;
  }> = [
    ...[
      "/invites/a%2Fb/wagers",
      "/invites/%20invite-one/wagers",
      "/invites/invite-one%20/wagers",
      "/invites/%E0%A4%A/wagers",
      "/invites/invite-one/wagers?extra=true",
      "/invites/invite-one/wagers/socket?token=secret",
    ].map((path) => ({ options: { path }, status: 400 })),
    { options: { headers: { Origin: "https://evil.example" } }, status: 403 },
    { options: { socket: true, headers: { Origin: "" } }, status: 403 },
    {
      options: { socket: true, headers: { Origin: "https://evil.example" } },
      status: 403,
    },
    { options: { socket: true, headers: { Upgrade: "" } }, status: 426 },
    ...[
      "",
      "mons-reactions-v1",
      "mons-invite-metadata-v1",
      `bearer.${token}, ${INVITE_WAGERS_SOCKET_PROTOCOL}`,
      `${INVITE_WAGERS_SOCKET_PROTOCOL}, extra`,
      `${INVITE_WAGERS_SOCKET_PROTOCOL}, bearer.not-a-token`,
      `${INVITE_WAGERS_SOCKET_PROTOCOL}, bearer.${token}, bearer.${token}`,
      `${INVITE_WAGERS_SOCKET_PROTOCOL},`,
      "x".repeat(20_000),
    ].map((protocol) => ({
      options: {
        socket: true,
        headers: { "Sec-WebSocket-Protocol": protocol },
      },
      status: 400,
    })),
    {
      options: {
        socket: true,
        authenticated: true,
        headers: { Authorization: "Bearer other.payload.signature" },
      },
      status: 400,
    },
    {
      options: { socket: true, headers: { Authorization: "Basic secret" } },
      status: 400,
    },
    {
      options: {
        socket: true,
        headers: { Authorization: `Bearer ${"x".repeat(20_000)}` },
      },
      status: 400,
    },
  ];
  for (const { options, status } of cases) {
    const h = setup();
    const response = await handleInviteWagersRoute(
      request(options),
      h.env,
      ctx,
      h.dependencies,
    );
    assert.equal(response.status, status, JSON.stringify(options));
    assert.equal(h.calls.auth, 0);
    assert.equal(h.calls.sources, 0);
    assert.equal(h.calls.reads, 0);
    assert.equal(h.calls.rates.length, 0);
  }
});

test("invalid HTTP bearer tokens fail authentication before any source read", async () => {
  for (const authorization of [
    "Basic secret",
    "Bearer not-a-token",
    "Bearer ",
  ]) {
    const h = setup();
    h.dependencies.verifyIdentity = undefined;
    const response = await handleInviteWagersRoute(
      request({ headers: { Authorization: authorization } }),
      h.env,
      ctx,
      h.dependencies,
    );
    assert.equal(response.status, 401);
    assert.equal(h.calls.sources, 0);
    assert.equal(h.calls.reads, 0);
    assert.equal(h.calls.rates.length, 0);
  }
  const h = setup();
  h.dependencies.verifyIdentity = async () => {
    throw new AuthApiFailure(401, "unauthenticated", "invalid-token");
  };
  const response = await handleInviteWagersRoute(
    request({ authenticated: true }),
    h.env,
    ctx,
    h.dependencies,
  );
  assert.equal(response.status, 401);
  assert.equal(h.calls.sources, 0);
});

test("missing invites and failed existence checks never allocate a room", async () => {
  for (const socket of [false, true]) {
    for (const source of [
      null,
      undefined,
      new Error("secret-source-failure"),
    ]) {
      const h = setup();
      let allocations = 0;
      h.dependencies.room = undefined;
      Object.defineProperty(h.env, "INVITE_REACTIONS", {
        value: {
          getByName: () => {
            allocations++;
            throw new Error("unexpected-room-access");
          },
        },
      });
      h.repository.readInviteMetadata = async () => {
        if (source instanceof Error) throw source;
        return source ?? null;
      };
      const response = await handleInviteWagersRoute(
        request({ socket }),
        h.env,
        ctx,
        h.dependencies,
      );
      assert.equal(response.status, source instanceof Error ? 503 : 404);
      assert.equal(allocations, 0);
      assert.equal(h.calls.reads, 0);
      assert.equal(h.calls.sockets.length, 0);
      assert.ok(!(await response.text()).includes("secret-source-failure"));
    }
  }
});

test("missing, malformed and unavailable room sources have bounded sanitized errors", async () => {
  for (const [result, status] of [
    [{ status: "missing" }, 404],
    [{ status: "invalid" }, 503],
  ] as const) {
    const h = setup();
    h.state.result = result;
    const response = await handleInviteWagersRoute(
      request(),
      h.env,
      ctx,
      h.dependencies,
    );
    assert.equal(response.status, status);
    assert.equal(h.calls.sockets.length, 0);
  }
  const h = setup();
  h.dependencies.room!.readWagers = async () => {
    throw new Error("secret-provider-response");
  };
  const response = await handleInviteWagersRoute(
    request(),
    h.env,
    ctx,
    h.dependencies,
  );
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("secret-provider-response"));
  assert.equal(h.calls.logs, 1);
});

test("malformed, mismatched and oversized snapshots fail closed before admission", async () => {
  const oversized = {
    ...snapshot,
    wagers: Object.fromEntries(
      Array.from({ length: 2500 }, (_, index) => [
        `${"a".repeat(500)}${index}`,
        {},
      ]),
    ),
  };
  assert.ok(
    new TextEncoder().encode(JSON.stringify({ ok: true, snapshot: oversized }))
      .byteLength > INVITE_WAGERS_MAX_MESSAGE_BYTES,
  );
  for (const invalid of [
    null,
    {},
    { ...snapshot, inviteId: "another-invite" },
    { ...snapshot, revision: -1 },
    { ...snapshot, wagers: { "invite-one": { settlementClaim: "secret" } } },
    oversized,
  ]) {
    for (const socket of [false, true]) {
      const h = setup();
      assert.equal(h.state.result.status, "ok");
      h.state.result = {
        ...h.state.result,
        snapshot: invalid,
      } as unknown as InviteWagersReadResult;
      const response = await handleInviteWagersRoute(
        request({ socket }),
        h.env,
        ctx,
        h.dependencies,
      );
      assert.equal(response.status, 503);
      assert.equal(h.calls.sockets.length, 0);
      assert.ok(!(await response.text()).includes("settlementClaim"));
    }
  }
});

test("invalid access metadata fails closed before public or authenticated authorization", async () => {
  for (const invalid of [
    { ...metadata, inviteId: "another-invite" },
    { ...metadata, hostId: null },
    { ...metadata, guestId: true },
    { ...metadata, guestId: "host-login" },
  ]) {
    for (const authenticated of [false, true]) {
      const h = setup();
      assert.equal(h.state.result.status, "ok");
      h.state.result = {
        ...h.state.result,
        metadata: {
          status: "ok",
          snapshot: invalid,
          passwordProtected: false,
          automatchOperationIds: {},
        },
      } as unknown as InviteWagersReadResult;
      const response = await handleInviteWagersRoute(
        request({ authenticated }),
        h.env,
        ctx,
        h.dependencies,
      );
      assert.equal(
        response.status,
        503,
        JSON.stringify({ invalid, authenticated }),
      );
      assert.equal(h.calls.sockets.length, 0);
    }
  }
});

test("rate limits return Retry-After without any source or room reads", async () => {
  for (const socket of [false, true]) {
    const h = setup();
    h.env.REACTION_RATE_LIMITER.limit = async () => ({ success: false });
    const response = await handleInviteWagersRoute(
      request({ socket }),
      h.env,
      ctx,
      h.dependencies,
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal(
      response.headers.get("Access-Control-Expose-Headers"),
      "Retry-After",
    );
    assert.equal(h.calls.sources, 0);
    assert.equal(h.calls.reads, 0);
  }
});

test("wagers validate access metadata before checking forbidden access", async () => {
  for (const authenticated of [false, true]) {
    const h = setup({
      guestId: null,
      passwordProtected: true,
      caller: "outsider",
    });
    assert.equal(h.state.result.status, "ok");
    h.state.result.metadata.snapshot.revision = -1;
    const response = await handleInviteWagersRoute(
      request({ authenticated }),
      h.env,
      ctx,
      h.dependencies,
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "unavailable",
      message: "invite-wagers-unavailable",
    });
    assert.equal(h.calls.sockets.length, 0);
  }
});

test("wagers pass through non-conflict room responses without another read", async () => {
  for (const status of [400, 401, 429, 503]) {
    const h = setup();
    const rejection = new Response("admission failed", {
      status,
      headers: { "Retry-After": "30" },
    });
    h.dependencies.room!.fetch = async () => rejection;
    const response = await handleInviteWagersRoute(
      request({ socket: true }),
      h.env,
      ctx,
      h.dependencies,
    );
    assert.equal(response, rejection);
    assert.equal(response.headers.get("Retry-After"), "30");
    assert.equal(await response.text(), "admission failed");
    assert.equal(h.calls.reads, 1);
  }
});

test("admission conflicts retry fresh revision exactly twice and cancel rejected bodies", async () => {
  for (const finalStatus of [200, 409]) {
    const h = setup();
    let attempts = 0;
    let canceled = 0;
    h.dependencies.room!.fetch = async (incoming) => {
      h.calls.sockets.push(incoming);
      attempts++;
      assert.equal(
        incoming.headers.get("X-Mons-Wagers-Revision"),
        String(attempts === 1 ? 7 : 8),
      );
      assert.equal(incoming.headers.get("Authorization"), null);
      assert.equal(
        incoming.headers.get("Sec-WebSocket-Protocol"),
        INVITE_WAGERS_SOCKET_PROTOCOL,
      );
      if (attempts === 2 && finalStatus === 200) return new Response("upgrade");
      assert.equal(h.state.result.status, "ok");
      if (h.state.result.status === "ok")
        h.state.result.snapshot = { ...snapshot, revision: 8 };
      return new Response(
        new ReadableStream({
          cancel() {
            canceled++;
          },
        }),
        { status: 409 },
      );
    };
    const response = await handleInviteWagersRoute(
      request({ socket: true, authenticated: true }),
      h.env,
      ctx,
      h.dependencies,
    );
    assert.equal(response.status, finalStatus === 200 ? 200 : 503);
    assert.equal(h.calls.auth, 1);
    assert.equal(h.calls.sources, 1);
    assert.equal(h.calls.reads, 2);
    assert.equal(attempts, 2);
    assert.equal(canceled, finalStatus === 200 ? 1 : 2);
  }
});

test("admission retry rechecks changed access instead of reusing the prior permission", async () => {
  const h = setup({ caller: "outsider" });
  h.dependencies.room!.fetch = async (incoming) => {
    h.calls.sockets.push(incoming);
    assert.equal(h.state.result.status, "ok");
    if (h.state.result.status === "ok") {
      h.state.result.metadata.snapshot = { ...metadata, guestId: null };
      h.state.result.metadata.passwordProtected = true;
      h.state.result.snapshot = { ...snapshot, revision: 8 };
    }
    return new Response("changed", { status: 409 });
  };
  const response = await handleInviteWagersRoute(
    request({ socket: true, authenticated: true }),
    h.env,
    ctx,
    h.dependencies,
  );
  assert.equal(response.status, 403);
  assert.equal(h.calls.reads, 2);
  assert.equal(h.calls.sockets.length, 1);
});
