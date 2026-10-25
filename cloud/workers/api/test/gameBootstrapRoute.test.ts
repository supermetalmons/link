import { retainedInviteSourceFixture } from "./inviteDocumentFixture.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  GAME_BOOTSTRAP_MAX_RESPONSE_BYTES,
  isReadGameBootstrapResponse,
  type ReadGameBootstrapResponse,
} from "@mons/shared/game-bootstrap";
import { selectInviteMatch } from "@mons/shared/rematches";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  handleGameBootstrapRoute,
  type GameBootstrapRouteDependencies,
} from "../src/gameBootstrapRoute.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import { normalizeInviteMetadata } from "../src/inviteMetadata.ts";
import {
  createMatchSyncSnapshot,
  type MatchSyncMetadata,
} from "../src/matchSync.ts";
import { handleRequest } from "../src/router.ts";
import { socketTestIdentity } from "./socketTestSession.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };
const inviteId = "bootstrap-invite";
const operationId = "00000000-0000-4000-8000-000000000001";
const match = {
  version: 2,
  color: "white",
  emojiId: 1,
  aura: "",
  gameVariant: "standard",
  fen: "initial",
  status: "",
  flatMovesString: "",
  timer: "",
};

function metadata(value: Record<string, unknown> = {}): MatchSyncMetadata {
  const normalized = normalizeInviteMetadata(inviteId, {
    hostId: "host-login",
    guestId: "guest-login",
    hostColor: "white",
    automatchOperationIds: { "host-login": operationId },
    ...value,
  });
  assert.equal(normalized.status, "ok");
  if (normalized.status !== "ok") throw new Error("invalid-fixture");
  return { ...normalized, snapshot: { ...normalized.snapshot, revision: 7 } };
}

function request({
  path = `/invites/${inviteId}/bootstrap`,
  method = "GET",
  headers = {},
  signal,
}: {
  path?: string;
  method?: string;
  headers?: HeadersInit;
  signal?: AbortSignal;
} = {}) {
  return new Request(`https://api.mons.link${path}`, {
    method,
    headers: {
      Origin: "https://mons.link",
      Authorization: "Bearer token",
      ...headers,
    },
    signal,
  });
}

function setup(source = metadata(), caller = "host-login") {
  const calls = {
    auth: 0,
    admission: 0,
    roles: 0,
    metadata: 0,
    matches: [] as string[],
    fresh: [] as boolean[],
    rates: [] as string[],
  };
  const env: Env = {
    ...TELEGRAM_TEST_ENV,
    MATCH_SYNC_RATE_LIMITER: {
      limit: async ({ key }) => {
        calls.rates.push(key);
        return { success: true };
      },
    },
  };
  const repository = createGameplayRepository(env);
  repository.readInviteMetadata = async (id) => {
    calls.admission++;
    assert.equal(id, inviteId);
    return retainedInviteSourceFixture({
      ...source.snapshot,
      ...(source.passwordProtected ? { password: true } : {}),
      automatchOperationIds: source.automatchOperationIds,
    });
  };
  repository.readMatchRecord = async () => {
    throw new Error("unexpected-record-read");
  };
  repository.readProfileOwnershipSnapshot = async (query) => {
    calls.roles++;
    return {
      canonicalProfileIdByProfileId: new Map(),
      loginOwnerByUid: new Map(query.loginUids.map((uid) => [uid, null])),
      loginUidsByProfileId: new Map(),
      profileById: new Map(),
    };
  };
  const room: NonNullable<GameBootstrapRouteDependencies["room"]> = {
    readMetadata: async () => {
      calls.metadata++;
      return source;
    },
    readMatches: async (id, matchId, options) => {
      assert.equal(id, inviteId);
      calls.matches.push(matchId);
      calls.fresh.push(options?.fresh === true);
      return {
        status: "ok",
        metadata: source,
        snapshot: {
          ...createMatchSyncSnapshot(
            source,
            matchId,
            match,
            source.snapshot.guestId ? { ...match, color: "black" } : null,
          ),
          revision: 3,
        },
      };
    },
  };
  let at = 0;
  const dependencies: GameBootstrapRouteDependencies = {
    repository,
    readAdmission: (id, signal) => repository.readInviteMetadata(id, signal),
    room,
    verifyIdentity: async (incoming) => {
      calls.auth++;
      if (incoming.headers.get("Authorization") !== "Bearer token") {
        throw new AuthApiFailure(
          401,
          "unauthenticated",
          "authentication-required",
        );
      }
      return socketTestIdentity(caller);
    },
    now: () => at++,
    logFailure: () => undefined,
  };
  return { env, repository, room, calls, dependencies, source };
}

async function read(state: ReturnType<typeof setup>, incoming = request()) {
  return handleGameBootstrapRoute(incoming, state.env, ctx, state.dependencies);
}

test("bootstrap accepts ownership-only injection without reading unrelated bindings", async () => {
  const state = setup(metadata(), "spectator-login");
  state.dependencies.repository = {
    readProfileOwnershipSnapshot: state.repository.readProfileOwnershipSnapshot,
  };
  for (const key of [
    "PROFILE_DB",
    "PROFILE_GAMES_DB",
    "INVITE_REACTIONS",
    "EVENT_DB",
  ] as const)
    Object.defineProperty(state.env, key, {
      get() {
        throw new Error(`unexpected-${key}`);
      },
    });
  const response = await read(state);
  assert.equal(response.status, 200);
  assert.equal(state.calls.admission, 1);
  assert.equal(state.calls.roles, 1);
  assert.equal(state.calls.metadata, 0);
  assert.deepEqual(state.calls.matches, [inviteId]);
});

test("default bootstrap ownership does not construct an invite metadata repository", async () => {
  const state = setup();
  state.dependencies.repository = undefined;
  for (const key of [
    "PROFILE_GAMES_DB",
    "INVITE_REACTIONS",
    "EVENT_DB",
  ] as const)
    Object.defineProperty(state.env, key, {
      get() {
        throw new Error(`unexpected-${key}`);
      },
    });
  const response = await read(state);
  assert.equal(response.status, 200);
  assert.equal(state.calls.admission, 1);
  assert.equal(state.calls.roles, 0);
  assert.equal(state.calls.metadata, 0);
});

test("shared selection preserves actor proposals, approved prefixes and end overrides", () => {
  const base = metadata().snapshot;
  const cases: Array<
    [string, string, string | null, boolean, string, boolean]
  > = [
    ["", "", "host-login", false, inviteId, false],
    ["1;2", "1;2", "guest-login", false, `${inviteId}2`, false],
    ["1;2;3", "1;2", "host-login", false, `${inviteId}3`, true],
    ["1;2;3", "1;2", "guest-login", false, `${inviteId}2`, false],
    ["1;2", "1;2;3", "guest-login", false, `${inviteId}3`, true],
    ["1;2;3", "1;2", null, false, `${inviteId}2`, false],
    ["1;2;3", "1;2", "host-login", true, `${inviteId}2`, false],
    ["1;2;3x", "1;2", "host-login", false, `${inviteId}2`, false],
    ["1;2", "1;3", "host-login", false, `${inviteId}1`, false],
    ["1", "", "host-login", false, `${inviteId}1`, true],
  ];
  for (const [
    hostRematches,
    guestRematches,
    actor,
    preferApproved,
    matchId,
    hasPendingProposal,
  ] of cases) {
    assert.deepEqual(
      selectInviteMatch(
        inviteId,
        { ...base, hostRematches, guestRematches },
        actor,
        { preferApproved },
      ),
      { matchId, hasPendingProposal },
    );
  }
});

test("bootstrap routes a single admission and pair read with coherent public data and timing", async () => {
  const state = setup();
  const response = await handleRequest(
    request(),
    state.env,
    { gameBootstrap: state.dependencies },
    ctx,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(isReadGameBootstrapResponse(body), true);
  assert.deepEqual(body, {
    ok: true,
    schemaVersion: 1,
    metadata: state.source.snapshot,
    viewer: {
      role: "host",
      actorUid: "host-login",
      automatchOperationId: operationId,
    },
    match: {
      ...createMatchSyncSnapshot(state.source, inviteId, match, {
        ...match,
        color: "black",
      }),
      revision: 3,
    },
    hasPendingProposal: false,
  });
  assert.equal(state.calls.admission, 1);
  assert.deepEqual(state.calls.matches, [inviteId]);
  assert.deepEqual(state.calls.fresh, [false]);
  assert.equal(state.calls.metadata, 0);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(
    response.headers.get("Timing-Allow-Origin"),
    "https://mons.link",
  );
  for (const stage of ["auth", "admission", "role", "match", "total"]) {
    assert.match(
      response.headers.get("Server-Timing") || "",
      new RegExp(`${stage};dur=\\d+\\.\\d`),
    );
  }
});

test("bootstrap validates preflight, method, path, query and authentication before storage", async () => {
  const preflight = setup();
  const response = await read(preflight, request({ method: "OPTIONS" }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Server-Timing"), "total;dur=1.0");
  assert.equal(
    response.headers.get("Timing-Allow-Origin"),
    "https://mons.link",
  );
  assert.equal(
    response.headers.get("Access-Control-Expose-Headers"),
    "Retry-After, Server-Timing",
  );
  assert.equal(preflight.calls.auth, 0);
  for (const [incoming, status] of [
    [request({ method: "POST" }), 405],
    [request({ path: "/invites/a%2Fb/bootstrap" }), 400],
    [request({ path: "/invites/%20bad/bootstrap" }), 400],
    [request({ path: `/invites/${inviteId}/bootstrap?x=1` }), 400],
    [request({ path: `/invites/${inviteId}/bootstrap?selection=latest` }), 400],
    [
      request({
        path: `/invites/${inviteId}/bootstrap?selection=current&selection=approved`,
      }),
      400,
    ],
    [request({ headers: { Origin: "https://untrusted.example" } }), 403],
    [request({ headers: { Authorization: "" } }), 401],
  ] as const) {
    const state = setup();
    assert.equal((await read(state, incoming)).status, status);
    assert.equal(state.calls.admission, 0);
    assert.equal(state.calls.matches.length, 0);
  }
});

test("unknown or invalid invites and failed admission never access a Durable Object", async () => {
  for (const [value, status] of [
    [null, 404],
    [{ invalid: true }, 409],
    [new Error("secret"), 503],
  ] as const) {
    const state = setup();
    state.dependencies.room = undefined;
    let accesses = 0;
    Object.defineProperty(state.env, "INVITE_REACTIONS", {
      value: {
        getByName: () => {
          accesses++;
          throw new Error("unexpected-room");
        },
      },
    });
    state.repository.readInviteMetadata = async () => {
      if (value instanceof Error) throw value;
      return retainedInviteSourceFixture(value);
    };
    const response = await read(state);
    assert.equal(response.status, status);
    assert.equal(accesses, 0);
    assert.ok(!(await response.text()).includes("secret"));
  }
});

test("bootstrap keeps guest, spectator, unjoined and protected invite access", async () => {
  for (const [caller, guestId, passwordProtected, status, role] of [
    ["guest-login", "guest-login", false, 200, "guest"],
    ["outsider", "guest-login", true, 200, "watch"],
    ["host-login", null, true, 200, "host"],
    ["outsider", null, false, 200, "watch"],
    ["outsider", null, true, 403, null],
  ] as const) {
    const state = setup(
      metadata({ guestId, ...(passwordProtected ? { password: true } : {}) }),
      caller,
    );
    const response = await read(state);
    assert.equal(response.status, status);
    if (status === 200) {
      const body = (await response.json()) as ReadGameBootstrapResponse;
      assert.equal(body.viewer.role, role);
      assert.equal(body.match.guestPlayerId, guestId);
      assert.equal(
        body.viewer.automatchOperationId,
        caller === "host-login" ? operationId : null,
      );
      assert.equal(state.calls.roles, caller === "outsider" ? 1 : 0);
    }
  }
});

test("approved selection suppresses an actor's pending rematch", async () => {
  const state = setup(metadata({ hostRematches: "1;2", guestRematches: "1" }));
  const current = (await (
    await read(state)
  ).json()) as ReadGameBootstrapResponse;
  assert.equal(current.match.matchId, `${inviteId}2`);
  assert.equal(current.hasPendingProposal, true);
  const approved = (await (
    await read(
      state,
      request({ path: `/invites/${inviteId}/bootstrap?selection=approved` }),
    )
  ).json()) as ReadGameBootstrapResponse;
  assert.equal(approved.match.matchId, `${inviteId}1`);
  assert.equal(approved.hasPendingProposal, false);
});

test("bootstrap resolves linked host ownership once for its selected snapshot", async () => {
  const state = setup(
    metadata({ guestId: null, password: true }),
    "linked-login",
  );
  state.repository.readProfileOwnershipSnapshot = async (query) => {
    state.calls.roles++;
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
              emoji: 1,
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
  const response = await read(state);
  assert.equal(response.status, 200);
  const body = (await response.json()) as ReadGameBootstrapResponse;
  assert.equal(body.viewer.role, "host");
  assert.equal(body.viewer.actorUid, "host-login");
  assert.equal(body.viewer.automatchOperationId, null);
  assert.equal(state.calls.roles, 1);
});

test("bootstrap reselects a rematch when room metadata advances during admission", async () => {
  const state = setup();
  const advanced = metadata({ hostRematches: "1", guestRematches: "1" });
  state.room.readMatches = async (_id, matchId) => {
    state.calls.matches.push(matchId);
    return {
      status: "ok",
      metadata: advanced,
      snapshot: createMatchSyncSnapshot(advanced, matchId, match, {
        ...match,
        color: "black",
      }),
    };
  };
  const response = await read(state);
  const body = (await response.json()) as ReadGameBootstrapResponse;
  assert.equal(response.status, 200);
  assert.deepEqual(state.calls.matches, [inviteId, inviteId, `${inviteId}1`]);
  assert.equal(body.match.matchId, `${inviteId}1`);
  assert.deepEqual(body.metadata, advanced.snapshot);
  assert.equal(state.calls.admission, 1);
  assert.match(
    response.headers.get("Server-Timing") || "",
    /(?:^|, )match;dur=3\.0(?:,|$)/,
  );
});

test("bootstrap refreshes stale membership, rematch endings, protection and operation IDs", async () => {
  for (const [cached, current, caller] of [
    [metadata({ guestId: null }), metadata(), "guest-login"],
    [
      metadata({ hostRematches: "1", guestRematches: "1" }),
      metadata({ hostRematches: "1x", guestRematches: "1" }),
      "host-login",
    ],
    [
      metadata({ guestId: null }),
      metadata({ guestId: null, password: true }),
      "host-login",
    ],
    [metadata({ automatchOperationIds: {} }), metadata(), "host-login"],
  ] as const) {
    const state = setup(current, caller);
    state.room.readMatches = async (_id, matchId, options) => {
      state.calls.matches.push(matchId);
      state.calls.fresh.push(options?.fresh === true);
      const source = options?.fresh ? current : cached;
      return {
        status: "ok",
        metadata: source,
        snapshot: createMatchSyncSnapshot(
          source,
          matchId,
          match,
          source.snapshot.guestId ? { ...match, color: "black" } : null,
        ),
      };
    };
    const response = await read(state);
    assert.equal(response.status, 200);
    const body = (await response.json()) as ReadGameBootstrapResponse;
    assert.deepEqual(body.metadata, current.snapshot);
    assert.equal(body.viewer.role, caller === "guest-login" ? "guest" : "host");
    assert.equal(
      body.viewer.automatchOperationId,
      current.automatchOperationIds[caller] ?? null,
    );
    assert.deepEqual(state.calls.fresh, [false, true]);
  }
});

test("bootstrap rechecks protection on a fresh pair and rejects protected admission before room access", async () => {
  const state = setup(metadata({ guestId: null }), "outsider");
  const protectedMetadata = metadata({ guestId: null, password: true });
  state.room.readMatches = async (_id, matchId, options) => {
    state.calls.fresh.push(options?.fresh === true);
    return {
      status: "ok",
      metadata: protectedMetadata,
      snapshot: createMatchSyncSnapshot(
        protectedMetadata,
        matchId,
        match,
        null,
      ),
    };
  };
  assert.equal((await read(state)).status, 403);
  assert.deepEqual(state.calls.fresh, [false, true]);
  const denied = setup(protectedMetadata, "outsider");
  assert.equal((await read(denied)).status, 403);
  assert.deepEqual(denied.calls.matches, []);
});

test("fresh bootstrap retries remain bounded when rematch selection keeps changing", async () => {
  const state = setup();
  state.room.readMatches = async (_id, matchId, options) => {
    state.calls.matches.push(matchId);
    state.calls.fresh.push(options?.fresh === true);
    const indices = Array.from(
      { length: state.calls.matches.length },
      (_value, index) => index + 1,
    ).join(";");
    const source = metadata({
      hostRematches: indices,
      guestRematches: indices,
    });
    return {
      status: "ok",
      metadata: source,
      snapshot: createMatchSyncSnapshot(source, matchId, match, {
        ...match,
        color: "black",
      }),
    };
  };
  assert.equal((await read(state)).status, 503);
  assert.deepEqual(state.calls.matches, [inviteId, inviteId, `${inviteId}2`]);
  assert.deepEqual(state.calls.fresh, [false, true, true]);
});

test("bootstrap rechecks viewer access when room membership or protection changes", async () => {
  const state = setup();
  const changed = metadata({
    hostId: "replacement-host",
    guestId: null,
    password: true,
  });
  state.room.readMatches = async (_id, matchId) => ({
    status: "ok",
    metadata: changed,
    snapshot: createMatchSyncSnapshot(changed, matchId, match, null),
  });
  assert.equal((await read(state)).status, 403);
});

test("bootstrap retries missing selections and caps changing metadata at three pair reads", async () => {
  const state = setup();
  state.room.readMatches = async (_id, matchId) => {
    state.calls.matches.push(matchId);
    return { status: "missing" };
  };
  assert.equal((await read(state)).status, 503);
  assert.equal(state.calls.matches.length, 3);
  assert.equal(state.calls.metadata, 3);
});

test("missing participant records remain null without mutation and invalid sources stay errors", async () => {
  const state = setup();
  state.room.readMatches = async (_id, matchId) => ({
    status: "ok",
    metadata: state.source,
    snapshot: createMatchSyncSnapshot(state.source, matchId, null, match),
  });
  const response = await read(state);
  assert.equal(response.status, 200);
  const body = (await response.json()) as ReadGameBootstrapResponse;
  assert.equal(body.match.hostMatch, null);
  for (const status of ["missing", "invalid"] as const) {
    state.room.readMetadata = async () => ({ status });
    state.room.readMatches = async () => ({ status });
    assert.equal((await read(state)).status, status === "missing" ? 404 : 409);
  }
  state.room.readMatches = async () => {
    throw new Error("source-secret");
  };
  const unavailable = await read(state);
  assert.equal(unavailable.status, 503);
  assert.ok(!(await unavailable.text()).includes("source-secret"));
});

test("rate limiting and cancellation avoid bootstrap source work", async () => {
  const limited = setup();
  limited.env.MATCH_SYNC_RATE_LIMITER.limit = async () => ({ success: false });
  const response = await read(limited);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(limited.calls.admission, 0);
  const canceled = setup();
  const controller = new AbortController();
  controller.abort();
  const canceledResponse = await read(
    canceled,
    request({ signal: controller.signal }),
  );
  assert.equal(canceledResponse.status, 503);
  assert.equal(canceledResponse.headers.get("Server-Timing"), "total;dur=1.0");
  assert.equal(canceled.calls.auth, 0);
  assert.equal(canceled.calls.admission, 0);
});

test("cancellation after authentication records auth timing without starting bootstrap reads", async () => {
  const state = setup();
  const controller = new AbortController();
  state.dependencies.verifyIdentity = async () => {
    state.calls.auth++;
    controller.abort();
    return socketTestIdentity("host-login");
  };
  const response = await read(state, request({ signal: controller.signal }));
  assert.equal(response.status, 503);
  assert.equal(
    response.headers.get("Server-Timing"),
    "auth;dur=1.0, total;dur=3.0",
  );
  assert.equal(state.calls.auth, 1);
  assert.equal(state.calls.admission, 0);
  assert.deepEqual(state.calls.rates, []);
  assert.deepEqual(state.calls.matches, []);
});

test("bootstrap contract rejects cross-invite pairs, malformed roles and inconsistent selection", async () => {
  const state = setup();
  const valid = (await (await read(state)).json()) as ReadGameBootstrapResponse;
  assert.ok(JSON.stringify(valid).length < GAME_BOOTSTRAP_MAX_RESPONSE_BYTES);
  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, schemaVersion: 2 },
    { ...valid, hasPendingProposal: true },
    { ...valid, metadata: { ...valid.metadata, inviteId: "another" } },
    { ...valid, match: { ...valid.match, hostPlayerId: "someone-else" } },
    { ...valid, match: { ...valid.match, matchId: `${inviteId}1` } },
    { ...valid, viewer: { ...valid.viewer, actorUid: "guest-login" } },
    { ...valid, viewer: { ...valid.viewer, privateSecret: true } },
  ])
    assert.equal(isReadGameBootstrapResponse(invalid), false);
});
