import { socketTestIdentity } from "./socketTestSession.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  INVITE_METADATA_SOCKET_PROTOCOL,
  isReadInviteMetadataResponse,
  type InviteMetadataSnapshot,
} from "@mons/shared/invite-metadata";
import { AuthApiFailure } from "../src/authErrors.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import {
  handleInviteMetadataRoute,
  type InviteMetadataRouteDependencies,
} from "../src/inviteMetadataRoute.ts";
import { handleRequest } from "../src/router.ts";
import { TELEGRAM_TEST_ENV, withInviteSourceReads } from "./testEnv.ts";

const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };
const token = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJob3N0LWxvZ2luIn0.signature";
const operationId = "00000000-0000-4000-8000-000000000001";
const initialSnapshot: InviteMetadataSnapshot = {
  inviteId: "invite-one",
  revision: 1,
  hostId: "host-login",
  guestId: "guest-login",
  hostColor: "white",
  hostRematches: "",
  guestRematches: "",
  automatchStateHint: null,
  eventId: null,
  eventOwned: false,
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
  headers?: HeadersInit;
} = {}): Request {
  return new Request(
    `https://api.mons.link${path || `/invites/invite-one/metadata${socket ? "/socket" : ""}`}`,
    {
      method,
      headers: {
        Origin: "https://mons.link",
        "CF-Connecting-IP": "192.0.2.1",
        ...(socket
          ? {
              Upgrade: "websocket",
              "Sec-WebSocket-Protocol": `${INVITE_METADATA_SOCKET_PROTOCOL}${authenticated ? `, bearer.${token}` : ""}`,
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
  snapshot = initialSnapshot,
  passwordProtected = false,
  caller = "host-login",
}: {
  snapshot?: InviteMetadataSnapshot;
  passwordProtected?: boolean;
  caller?: string;
} = {}) {
  const calls = {
    sources: 0,
    reads: 0,
    auth: 0,
    rates: [] as string[],
    sockets: [] as Request[],
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
      assert.equal(inviteId, snapshot.inviteId);
      return { hostId: snapshot.hostId, guestId: snapshot.guestId };
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
  const dependencies: InviteMetadataRouteDependencies = {
    repository,
    room: {
      readMetadata: async () => {
        calls.reads++;
        return {
          status: "ok",
          snapshot,
          passwordProtected,
          automatchOperationIds: {
            [caller]: operationId,
            someoneElse: operationId,
          },
        };
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
    logFailure: () => undefined,
  };
  return { env, identity, dependencies, repository, calls };
}

test("metadata preflight and routing precede auth and storage", async () => {
  const state = setup();
  const response = await handleRequest(
    request({ method: "OPTIONS" }),
    state.env,
    { metadata: state.dependencies },
    ctx,
  );
  assert.equal(response.status, 204);
  assert.equal(state.calls.reads, 0);
  assert.equal(state.calls.auth, 0);
  const invalidPreflight = await handleInviteMetadataRoute(
    request({
      method: "OPTIONS",
      path: "/invites/invite-one/metadata?extra=1",
    }),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(invalidPreflight.status, 400);
  assert.equal(state.calls.sources, 0);
  assert.equal(state.calls.rates.length, 0);
  assert.equal(
    (
      await handleInviteMetadataRoute(
        request({ method: "POST" }),
        state.env,
        ctx,
        state.dependencies,
      )
    ).status,
    405,
  );
});

test("paired public reads expose only metadata and anonymous viewer fields", async () => {
  const state = setup();
  const response = await handleInviteMetadataRoute(
    request(),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json();
  assert.equal(isReadInviteMetadataResponse(body), true);
  assert.deepEqual(body, {
    ok: true,
    snapshot: initialSnapshot,
    viewer: { role: "watch", actorUid: null, automatchOperationId: null },
  });
});

test("unknown invites and failed existence checks never access a Durable Object", async () => {
  for (const socket of [false, true]) {
    for (const source of [null, undefined, new Error("source-unavailable")]) {
      const state = setup();
      let roomAccesses = 0;
      state.dependencies.room = undefined;
      Object.defineProperty(state.env, "INVITE_REACTIONS", {
        value: {
          getByName: () => {
            roomAccesses++;
            throw new Error("unexpected-room-access");
          },
        },
      });
      state.repository.readInviteMetadata = async (inviteId) => {
        assert.equal(inviteId, "invite-one");
        if (source instanceof Error) throw source;
        return source ?? null;
      };
      const response = await handleInviteMetadataRoute(
        request({ socket }),
        state.env,
        ctx,
        state.dependencies,
      );
      assert.equal(response.status, source instanceof Error ? 503 : 404);
      assert.equal(roomAccesses, 0);
      assert.equal(state.calls.reads, 0);
      assert.equal(state.calls.sockets.length, 0);
    }
  }
});

test("pending open and private invitations preserve authenticated access", async () => {
  for (const passwordProtected of [false, true]) {
    const state = setup({
      snapshot: { ...initialSnapshot, guestId: null },
      passwordProtected,
    });
    assert.equal(
      (
        await handleInviteMetadataRoute(
          request(),
          state.env,
          ctx,
          state.dependencies,
        )
      ).status,
      403,
    );
    const response = await handleInviteMetadataRoute(
      request({ authenticated: true }),
      state.env,
      ctx,
      state.dependencies,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { viewer: unknown };
    assert.deepEqual(body.viewer, {
      role: "host",
      actorUid: "host-login",
      automatchOperationId: operationId,
    });
    const outsider = setup({
      snapshot: { ...initialSnapshot, guestId: null },
      passwordProtected,
      caller: "outsider",
    });
    assert.equal(
      (
        await handleInviteMetadataRoute(
          request({ authenticated: true }),
          outsider.env,
          ctx,
          outsider.dependencies,
        )
      ).status,
      passwordProtected ? 403 : 200,
    );
  }
});

test("linked host ownership is resolved from canonical D1 for the same snapshot", async () => {
  const state = setup({
    snapshot: { ...initialSnapshot, guestId: null },
    passwordProtected: true,
    caller: "linked-login",
  });
  state.repository.readProfileOwnershipSnapshot = async (query) => ({
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
  });
  const response = await handleInviteMetadataRoute(
    request({ authenticated: true }),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    viewer: { role: string; actorUid: string };
  };
  assert.equal(body.viewer.role, "host");
  assert.equal(body.viewer.actorUid, "host-login");
  assert.equal(state.calls.reads, 1);
});

test("metadata upgrade strips credentials and binds admission to authorized snapshot", async () => {
  const state = setup({
    snapshot: { ...initialSnapshot, guestId: null },
    passwordProtected: true,
  });
  const response = await handleInviteMetadataRoute(
    request({
      socket: true,
      authenticated: true,
      headers: {
        Authorization: `Bearer ${token}`,
        Cookie: "private-session",
        "X-Mons-Metadata-Role": "spectator",
        "X-Mons-Metadata-Actor": "intruder",
        "X-Mons-Metadata-Revision": "999",
        "X-Mons-Metadata-Protected": "0",
        "X-Mons-Session-Id": "untrusted",
        "X-Mons-Session-Expires-At": "9999999999999",
      },
    }),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(response.status, 200);
  const forwarded = state.calls.sockets[0];
  assert.equal(forwarded.url, "https://reactions.internal/metadata/socket");
  assert.deepEqual(Object.fromEntries(forwarded.headers), {
    "sec-websocket-protocol": INVITE_METADATA_SOCKET_PROTOCOL,
    upgrade: "websocket",
    "x-mons-session-id": state.identity.sid,
    "x-mons-session-expires-at": String(state.identity.authExpiresAtMs),
    "x-mons-metadata-actor": "host-login",
    "x-mons-metadata-authenticated": "1",
    "x-mons-metadata-invite": "invite-one",
    "x-mons-metadata-ip": "192.0.2.1",
    "x-mons-metadata-protected": "1",
    "x-mons-metadata-revision": "1",
    "x-mons-metadata-role": "host",
  });
});

test("metadata admission retries fresh revisions twice and cancels rejected bodies", async () => {
  for (const finalStatus of [200, 409]) {
    const snapshot = { ...initialSnapshot };
    const state = setup({ snapshot });
    let canceled = 0;
    state.dependencies.room!.fetch = async (incoming) => {
      state.calls.sockets.push(incoming);
      const attempt = state.calls.sockets.length;
      assert.equal(
        incoming.headers.get("X-Mons-Metadata-Revision"),
        String(attempt),
      );
      if (attempt === 2 && finalStatus === 200) return new Response("upgrade");
      snapshot.revision++;
      return new Response(
        new ReadableStream({
          cancel() {
            canceled++;
          },
        }),
        { status: 409 },
      );
    };
    const response = await handleInviteMetadataRoute(
      request({ socket: true, authenticated: true }),
      state.env,
      ctx,
      state.dependencies,
    );
    assert.equal(response.status, finalStatus === 200 ? 200 : 503);
    assert.equal(state.calls.auth, 1);
    assert.equal(state.calls.sources, 1);
    assert.deepEqual(state.calls.rates, [
      "metadata:connect:identity:host-login",
    ]);
    assert.equal(state.calls.reads, 2);
    assert.equal(state.calls.sockets.length, 2);
    assert.equal(canceled, finalStatus === 200 ? 1 : 2);
  }
});

test("metadata admission retry rechecks changed access before another upgrade", async () => {
  const snapshot = { ...initialSnapshot };
  const state = setup({
    snapshot,
    passwordProtected: true,
    caller: "outsider",
  });
  state.dependencies.room!.fetch = async (incoming) => {
    state.calls.sockets.push(incoming);
    snapshot.guestId = null;
    snapshot.revision++;
    return new Response("changed", { status: 409 });
  };
  const response = await handleInviteMetadataRoute(
    request({ socket: true, authenticated: true }),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(response.status, 403);
  assert.equal(state.calls.reads, 2);
  assert.equal(state.calls.sockets.length, 1);
});

test("metadata checks forbidden access before validating the response snapshot", async () => {
  for (const authenticated of [false, true]) {
    const state = setup({
      snapshot: { ...initialSnapshot, guestId: null, revision: -1 },
      passwordProtected: true,
      caller: "outsider",
    });
    const response = await handleInviteMetadataRoute(
      request({ authenticated }),
      state.env,
      ctx,
      state.dependencies,
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "permission-denied",
      message: "permission-denied",
    });
    assert.equal(state.calls.sockets.length, 0);
  }
});

test("metadata passes through non-conflict room responses without another read", async () => {
  for (const status of [400, 401, 429, 503]) {
    const state = setup();
    const rejection = new Response("admission failed", {
      status,
      headers: { "Retry-After": "30" },
    });
    state.dependencies.room!.fetch = async () => rejection;
    const response = await handleInviteMetadataRoute(
      request({ socket: true }),
      state.env,
      ctx,
      state.dependencies,
    );
    assert.equal(response, rejection);
    assert.equal(response.headers.get("Retry-After"), "30");
    assert.equal(await response.text(), "admission failed");
    assert.equal(state.calls.reads, 1);
  }
});

test("metadata rejects malformed paths, origins, protocols and credentials before reading", async () => {
  const cases: Array<Parameters<typeof request>[0]> = [
    { path: "/invites/a%2Fb/metadata" },
    { path: "/invites/%20invite-one/metadata" },
    { path: "/invites/invite-one/metadata?extra=true" },
    { headers: { Origin: "https://evil.example" } },
    {
      socket: true,
      headers: { "Sec-WebSocket-Protocol": "mons-reactions-v1" },
    },
    {
      socket: true,
      headers: {
        "Sec-WebSocket-Protocol": `${INVITE_METADATA_SOCKET_PROTOCOL}, bearer.not-a-token`,
      },
    },
    {
      socket: true,
      headers: {
        "Sec-WebSocket-Protocol": `${INVITE_METADATA_SOCKET_PROTOCOL}, extra`,
      },
    },
  ];
  for (const options of cases) {
    const state = setup();
    const response = await handleInviteMetadataRoute(
      request(options),
      state.env,
      ctx,
      state.dependencies,
    );
    assert.ok([400, 403].includes(response.status));
    assert.equal(state.calls.reads, 0);
  }
});

test("missing, malformed, forbidden and transient source failures stay distinct", async () => {
  const state = setup();
  for (const [result, status] of [
    ["missing", 404],
    ["invalid", 409],
  ] as const) {
    state.dependencies.room!.readMetadata = async () => ({ status: result });
    assert.equal(
      (
        await handleInviteMetadataRoute(
          request(),
          state.env,
          ctx,
          state.dependencies,
        )
      ).status,
      status,
    );
  }
  state.dependencies.room!.readMetadata = async () => {
    throw new Error("secret-provider-response");
  };
  const failed = await handleInviteMetadataRoute(
    request(),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes("secret-provider-response"));
  state.dependencies.verifyIdentity = async () => {
    throw new AuthApiFailure(401, "unauthenticated", "invalid-token");
  };
  assert.equal(
    (
      await handleInviteMetadataRoute(
        request({ authenticated: true }),
        state.env,
        ctx,
        state.dependencies,
      )
    ).status,
    401,
  );
});

test("metadata rate limiting returns retry guidance without fetching the invite", async () => {
  const state = setup();
  state.env.REACTION_RATE_LIMITER.limit = async () => ({ success: false });
  const response = await handleInviteMetadataRoute(
    request(),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(
    response.headers.get("Access-Control-Expose-Headers"),
    "Retry-After",
  );
  assert.equal(state.calls.reads, 0);
});
