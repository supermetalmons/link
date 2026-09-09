import assert from "node:assert/strict";
import test from "node:test";
import {
  MATCH_SYNC_SOCKET_PROTOCOL,
  isReadMatchSyncResponse,
  type MatchSyncSnapshot,
} from "@mons/shared/match-sync";
import { AuthApiFailure } from "../src/authErrors.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import type { InviteMetadataSnapshot } from "@mons/shared/invite-metadata";
import {
  handleMatchSyncRoute,
  type MatchSyncRouteDependencies,
} from "../src/matchSyncRoute.ts";
import { handleRequest } from "../src/router.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };
const token = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJob3N0LWxvZ2luIn0.signature";
const metadata: InviteMetadataSnapshot = {
  inviteId: "invite-one",
  revision: 3,
  hostId: "host-login",
  guestId: "guest-login",
  hostColor: "white",
  hostRematches: "1",
  guestRematches: "1",
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
    `https://api.mons.link${path || `/invites/invite-one/matches/invite-one1/${socket ? "socket" : "snapshot"}`}`,
    {
      method,
      headers: {
        Origin: "https://mons.link",
        "CF-Connecting-IP": "192.0.2.1",
        ...(socket
          ? {
              Upgrade: "websocket",
              "Sec-WebSocket-Protocol": `${MATCH_SYNC_SOCKET_PROTOCOL}${authenticated ? `, bearer.${token}` : ""}`,
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
  guestId = "guest-login" as string | null,
  passwordProtected = false,
  caller = "host-login",
} = {}) {
  const calls = {
    reads: 0,
    auth: 0,
    existence: 0,
    rates: [] as string[],
    sockets: [] as Request[],
  };
  const rate = (binding: string) => ({
    limit: async ({ key }: { key: string }) => {
      calls.rates.push(`${binding}:${key}`);
      return { success: true };
    },
  });
  const env = {
    ...TELEGRAM_TEST_ENV,
    MATCH_SYNC_RATE_LIMITER: rate("read"),
    REACTION_RATE_LIMITER: rate("connect"),
  } as Env;
  const source = {
    ...metadata,
    guestId,
    ...(passwordProtected ? { password: "private-seed" } : {}),
  };
  const snapshot: MatchSyncSnapshot = {
    inviteId: source.inviteId,
    matchId: "invite-one1",
    revision: 7,
    hostPlayerId: source.hostId,
    guestPlayerId: guestId,
    hostMatch: null,
    guestMatch: null,
  };
  const repository = createGameplayRepository(env);
  repository.getRtdbPath = async (path) => {
    calls.existence++;
    assert.equal(path, "invites/invite-one");
    return source;
  };
  repository.readProfileOwnershipSnapshot = async (query) => ({
    canonicalProfileIdByProfileId: new Map(),
    loginOwnerByUid: new Map(query.loginUids.map((uid) => [uid, null])),
    loginUidsByProfileId: new Map(),
    profileById: new Map(),
  });
  const dependencies: MatchSyncRouteDependencies = {
    repository,
    room: {
      readMatches: async (inviteId, matchId) => {
        calls.reads++;
        assert.equal(inviteId, snapshot.inviteId);
        assert.equal(matchId, snapshot.matchId);
        return {
          status: "ok",
          snapshot,
          metadata: {
            status: "ok",
            snapshot: { ...metadata, guestId },
            passwordProtected,
            automatchOperationIds: {},
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
      return { uid: caller };
    },
    logFailure: () => undefined,
  };
  const handle = (incoming = request()) =>
    handleMatchSyncRoute(incoming, env, ctx, dependencies);
  return { env, dependencies, repository, source, snapshot, calls, handle };
}

test("match sync routes preflight before identity, rate limits and storage", async () => {
  const state = setup();
  assert.equal(
    (
      await handleRequest(
        request({ method: "OPTIONS" }),
        state.env,
        { matchSync: state.dependencies },
        ctx,
      )
    ).status,
    204,
  );
  assert.deepEqual(state.calls, {
    reads: 0,
    auth: 0,
    existence: 0,
    rates: [],
    sockets: [],
  });
  assert.equal((await state.handle(request({ method: "POST" }))).status, 405);
});

test("paired spectators receive a bounded no-store snapshot without private metadata", async () => {
  const state = setup({ passwordProtected: true });
  const response = await state.handle();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json();
  assert.ok(isReadMatchSyncResponse(body));
  assert.deepEqual(body, { ok: true, snapshot: state.snapshot });
  assert.deepEqual(state.calls.rates, ["read:match-read:spectator:192.0.2.1"]);
  assert.equal(JSON.stringify(body).includes("private-seed"), false);
});

test("pending invitations preserve participant and spectator access rules", async () => {
  for (const passwordProtected of [false, true]) {
    const state = setup({ guestId: null, passwordProtected });
    assert.equal((await state.handle()).status, 403);
    assert.equal(
      (await state.handle(request({ authenticated: true }))).status,
      200,
    );
    const outsider = setup({
      guestId: null,
      passwordProtected,
      caller: "outsider",
    });
    assert.equal(
      (await outsider.handle(request({ authenticated: true }))).status,
      passwordProtected ? 403 : 200,
    );
  }
});

test("missing, invalid and unregistered canonical invites do not allocate a room", async () => {
  for (const [source, expected] of [
    [null, 404],
    [{ hostId: "invalid/slash" }, 409],
    [{ ...metadata, hostRematches: "", guestRematches: "" }, 404],
    [new Error("source-unavailable"), 503],
  ] as const) {
    const state = setup();
    state.repository.getRtdbPath = async () => {
      if (source instanceof Error) throw source;
      return source;
    };
    state.dependencies.room = undefined;
    assert.equal((await state.handle()).status, expected);
    assert.equal(state.calls.reads, 0);
  }
});

test("malformed paths and query credentials are rejected before storage", async () => {
  for (const path of [
    "/invites/invite%2Fone/matches/invite-one1/snapshot",
    "/invites/invite-one/matches/%E0%A4%A/socket",
    "/invites/invite-one/matches/%20invite-one1/snapshot",
    "/invites/invite-one/matches/invite-one1/snapshot?token=secret",
  ]) {
    const state = setup();
    assert.equal((await state.handle(request({ path }))).status, 400);
    assert.equal(state.calls.existence, 0);
  }
});

test("read and connect buckets fail closed before accessing match state", async () => {
  for (const socket of [false, true]) {
    for (const unavailable of [false, true]) {
      const state = setup();
      state.env[socket ? "REACTION_RATE_LIMITER" : "MATCH_SYNC_RATE_LIMITER"] =
        {
          limit: async () => {
            if (unavailable) throw new Error("limiter-unavailable");
            return { success: false };
          },
        };
      const response = await state.handle(request({ socket }));
      assert.equal(response.status, unavailable ? 503 : 429);
      if (!unavailable) assert.equal(response.headers.get("Retry-After"), "60");
      assert.equal(state.calls.existence, 0);
    }
  }
});

test("socket admission forwards verified identity and match revision without its bearer token", async () => {
  const state = setup({ passwordProtected: true });
  const response = await state.handle(
    request({ socket: true, authenticated: true }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(state.calls.rates, [
    "connect:match-connect:identity:host-login",
  ]);
  const forwarded = state.calls.sockets[0];
  assert.equal(forwarded.url, "https://reactions.internal/matches/socket");
  assert.equal(
    forwarded.headers.get("Sec-WebSocket-Protocol"),
    MATCH_SYNC_SOCKET_PROTOCOL,
  );
  assert.equal(forwarded.headers.get("Authorization"), null);
  assert.equal(forwarded.headers.get("X-Mons-Match-Invite"), "invite-one");
  assert.equal(forwarded.headers.get("X-Mons-Match-Match"), "invite-one1");
  assert.equal(forwarded.headers.get("X-Mons-Match-Revision"), "7");
  assert.equal(forwarded.headers.get("X-Mons-Match-Actor"), "host-login");
  assert.equal(forwarded.headers.get("X-Mons-Match-Role"), "host");
  assert.equal(forwarded.headers.get("X-Mons-Match-Protected"), "1");
  assert.equal(forwarded.headers.get("X-Mons-Match-Authenticated"), "1");
});

test("same-profile logins use canonical ownership for socket actor admission", async () => {
  const state = setup({ caller: "linked-login" });
  state.repository.readProfileOwnershipSnapshot = async (query) => ({
    canonicalProfileIdByProfileId: new Map(),
    loginOwnerByUid: new Map(
      query.loginUids.map((uid) => [
        uid,
        uid === "guest-login" ? null : { profileId: "profile", revision: 1 },
      ]),
    ),
    loginUidsByProfileId: new Map([
      ["profile", ["host-login", "linked-login"]],
    ]),
    profileById: new Map([
      [
        "profile",
        {
          revision: 1,
          profile: {
            profileId: "profile",
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
  assert.equal(
    (await state.handle(request({ socket: true, authenticated: true }))).status,
    200,
  );
  assert.equal(
    state.calls.sockets[0].headers.get("X-Mons-Match-Actor"),
    "host-login",
  );
});

test("socket origin, upgrade and bearer protocol checks precede storage", async () => {
  for (const [headers, status] of [
    [{ Origin: "https://untrusted.example" }, 403],
    [{ Upgrade: "none" }, 426],
    [{ "Sec-WebSocket-Protocol": "wrong" }, 400],
    [
      {
        "Sec-WebSocket-Protocol": `${MATCH_SYNC_SOCKET_PROTOCOL}, bearer.invalid`,
      },
      400,
    ],
  ] as const) {
    const state = setup();
    assert.equal(
      (await state.handle(request({ socket: true, headers }))).status,
      status,
    );
    assert.equal(state.calls.existence, 0);
  }
  const state = setup();
  state.dependencies.verifyIdentity = async () => {
    throw new AuthApiFailure(401, "unauthenticated", "invalid-token");
  };
  assert.equal(
    (await state.handle(request({ socket: true, authenticated: true }))).status,
    401,
  );
});

test("socket admission retries one canonical refresh after a concurrent change", async () => {
  const state = setup();
  state.dependencies.room!.fetch = async (incoming) => {
    state.calls.sockets.push(incoming);
    if (state.calls.sockets.length === 1) {
      state.snapshot.revision++;
      return new Response("stale", { status: 409 });
    }
    return new Response("upgrade");
  };
  assert.equal((await state.handle(request({ socket: true }))).status, 200);
  assert.equal(state.calls.reads, 2);
  assert.deepEqual(
    state.calls.sockets.map((value) =>
      value.headers.get("X-Mons-Match-Revision"),
    ),
    ["7", "8"],
  );
  state.dependencies.room!.fetch = async () =>
    new Response("stale", { status: 409 });
  assert.equal((await state.handle(request({ socket: true }))).status, 503);
});

test("missing, invalid and oversized or mismatched snapshots fail closed", async () => {
  for (const status of ["missing", "invalid"] as const) {
    const state = setup();
    state.dependencies.room!.readMatches = async () => ({ status });
    assert.equal(
      (await state.handle()).status,
      status === "missing" ? 404 : 409,
    );
  }
  for (const mutation of [
    (snapshot: MatchSyncSnapshot) => {
      snapshot.matchId = "another-match";
    },
    (snapshot: MatchSyncSnapshot) => {
      snapshot.hostPlayerId = "another-player";
    },
    (snapshot: MatchSyncSnapshot) => {
      snapshot.inviteId = "x".repeat(2 ** 21);
    },
  ]) {
    const state = setup();
    mutation(state.snapshot);
    state.dependencies.room!.readMatches = async () => ({
      status: "ok",
      snapshot: state.snapshot,
      metadata: {
        status: "ok",
        snapshot: metadata,
        passwordProtected: false,
        automatchOperationIds: {},
      },
    });
    assert.equal((await state.handle()).status, 503);
  }
  const state = setup();
  state.dependencies.room!.readMatches = async () => {
    throw new Error("upstream-unavailable");
  };
  assert.equal((await state.handle()).status, 503);
});
