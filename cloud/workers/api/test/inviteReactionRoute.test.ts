import assert from "node:assert/strict";
import test from "node:test";
import {
  REACTION_AUTH_PROTOCOL_PREFIX,
  REACTION_SOCKET_PROTOCOL,
  type InviteReaction,
} from "@mons/shared/reactions";
import { AuthApiFailure } from "../src/authErrors.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import {
  handleInviteReactionRoute,
  isInviteReactionPath,
  type InviteReactionRouteDependencies,
} from "../src/inviteReactionRoute.ts";
import { handleRequest } from "../src/router.ts";
import type { ProfileOwnershipSnapshot } from "../src/profileOwnership.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const reaction: InviteReaction = {
  uuid: "00000000-0000-4000-8000-000000000001",
  kind: "yo",
  variation: 1,
  matchId: "invite-one",
};
const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };
const socketToken =
  "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJob3N0LWxvZ2luIn0.signature";
const socketProtocols = `${REACTION_SOCKET_PROTOCOL}, ${REACTION_AUTH_PROTOCOL_PREFIX}${socketToken}`;

function request(
  socket = false,
  options: {
    body?: unknown;
    headers?: HeadersInit;
    method?: string;
    path?: string;
  } = {},
) {
  return new Request(
    `https://api.mons.link${options.path || `/invites/invite-one/reactions${socket ? "/socket" : ""}`}`,
    {
      method: options.method || (socket ? "GET" : "POST"),
      headers: {
        Origin: "https://mons.link",
        "CF-Connecting-IP": "192.0.2.1",
        ...(socket
          ? { Upgrade: "websocket" }
          : {
              Authorization: "Bearer test-token",
              "Content-Type": "application/json",
            }),
        ...options.headers,
      },
      ...(!socket && options.method !== "OPTIONS" && options.method !== "GET"
        ? { body: JSON.stringify(options.body ?? reaction) }
        : {}),
    },
  );
}

function setup(
  invite: unknown = { hostId: "host-login", guestId: "guest-login" },
  caller = "host-login",
) {
  const socketRequests: Request[] = [];
  const verifiedRequests: Request[] = [];
  const calls: {
    auth: number;
    reads: string[];
    rates: string[];
    published: unknown[];
    sockets: number;
  } = {
    auth: 0,
    reads: [],
    rates: [],
    published: [],
    sockets: 0,
  };
  const env = {
    ...TELEGRAM_TEST_ENV,
    REACTION_RATE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        calls.rates.push(key);
        return { success: true };
      },
    },
  } as Env;
  const repository = createGameplayRepository(env, {
    rtdbClient: {
      getPath: async (path) => {
        calls.reads.push(path);
        return invite;
      },
      patchRoot: async () => {
        throw new Error("unexpected-write");
      },
      transactPath: async () => {
        throw new Error("unexpected-write");
      },
    },
  });
  repository.readProfileOwnershipSnapshot = async (query) => ({
    canonicalProfileIdByProfileId: new Map(),
    loginOwnerByUid: new Map(query.loginUids.map((uid) => [uid, null])),
    loginUidsByProfileId: new Map(),
    profileById: new Map(),
  });
  const dependencies: InviteReactionRouteDependencies = {
    repository,
    verifyIdentity: async (incoming) => {
      calls.auth++;
      verifiedRequests.push(incoming);
      return { uid: caller };
    },
    room: {
      fetch: async (incoming) => {
        calls.sockets++;
        socketRequests.push(incoming);
        assert.equal(incoming.headers.get("Authorization"), null);
        assert.ok(
          !incoming.headers
            .get("Sec-WebSocket-Protocol")
            ?.includes(REACTION_AUTH_PROTOCOL_PREFIX),
        );
        assert.equal(incoming.url, "https://reactions.internal/socket");
        return new Response("upgrade", {
          headers: incoming.headers.has("Sec-WebSocket-Protocol")
            ? { "Sec-WebSocket-Protocol": REACTION_SOCKET_PROTOCOL }
            : {},
        });
      },
      publish: async (senderUid, payload) => {
        calls.published.push({ senderUid, reaction: payload });
        return "published";
      },
    },
    logFailure: () => undefined,
  };
  return {
    calls,
    dependencies,
    env,
    repository,
    socketRequests,
    verifiedRequests,
  };
}

test("routes reaction endpoints and preflights before authentication or storage", async () => {
  assert.equal(isInviteReactionPath("/invites/a/reactions"), true);
  assert.equal(isInviteReactionPath("/invites/a/reactions/socket"), true);
  assert.equal(isInviteReactionPath("/invites/a/reactions/other"), false);
  const state = setup();
  const response = await handleRequest(
    request(false, { method: "OPTIONS" }),
    state.env,
    { reactions: state.dependencies },
    ctx,
  );
  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://mons.link",
  );
  assert.deepEqual(state.calls, {
    auth: 0,
    reads: [],
    rates: [],
    published: [],
    sockets: 0,
  });
});

test("publishes as the authenticated participant, including event games and rematches", async () => {
  const state = setup({
    hostId: "host-login",
    guestId: "guest-login",
    eventId: "event-one",
  });
  const payload = { ...reaction, matchId: "invite-one1" };
  const response = await handleInviteReactionRoute(
    request(false, { body: payload }),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(state.calls.published, [
    { senderUid: "host-login", reaction: payload },
  ]);
  assert.deepEqual(state.calls.reads, ["invites/invite-one"]);
  assert.deepEqual(state.calls.rates, ["reactions:publish:192.0.2.1"]);
});

test("uses canonical linked-profile ownership and the original participant UID", async () => {
  const state = setup(undefined, "linked-login");
  const profile = {
    profileId: "profile-one",
    aura: "",
    emoji: 1,
    eth: "",
    sol: "",
    rating: 0,
    username: "mons",
  };
  state.repository.readProfileOwnershipSnapshot = async (
    query,
  ): Promise<ProfileOwnershipSnapshot> => ({
    canonicalProfileIdByProfileId: new Map(),
    loginOwnerByUid: new Map(
      query.loginUids.map((uid) => [
        uid,
        uid === "guest-login"
          ? null
          : { profileId: "profile-one", revision: 1 },
      ]),
    ),
    loginUidsByProfileId: new Map([
      ["profile-one", ["host-login", "linked-login"]],
    ]),
    profileById: new Map([["profile-one", { profile, revision: 1 }]]),
  });
  const response = await handleInviteReactionRoute(
    request(),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(state.calls.published, [
    { senderUid: "host-login", reaction },
  ]);
  const socketResponse = await handleInviteReactionRoute(
    request(true, { headers: { "Sec-WebSocket-Protocol": socketProtocols } }),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(socketResponse.status, 200);
  assert.equal(
    state.socketRequests[0].headers.get("X-Mons-Reaction-Role"),
    "host",
  );
  assert.equal(
    state.calls.rates.at(-1),
    "reactions:connect:participant:host-login",
  );
});

test("rejects spectators, pending invites, invalid identities, and unrelated match IDs", async () => {
  for (const [invite, caller] of [
    [{ hostId: "host-login", guestId: "guest-login" }, "spectator"],
    [{ hostId: "host-login" }, "host-login"],
    [{ hostId: "host-login", guestId: "host-login" }, "host-login"],
  ] as const) {
    const state = setup(invite, caller);
    const response = await handleInviteReactionRoute(
      request(),
      state.env,
      ctx,
      state.dependencies,
    );
    assert.ok(response.status >= 400);
    assert.equal(state.calls.published.length, 0);
  }
  const state = setup();
  for (const payload of [
    { ...reaction, matchId: "another-invite" },
    { ...reaction, kind: "../injected" },
    { ...reaction, variation: 100 },
    { ...reaction, uuid: "x".repeat(5000) },
    { ...reaction, senderUid: "guest-login" },
  ]) {
    const response = await handleInviteReactionRoute(
      request(false, { body: payload }),
      state.env,
      ctx,
      state.dependencies,
    );
    assert.equal(response.status, 400);
  }
  assert.equal(state.calls.published.length, 0);
});

test("allows anonymous public subscriptions only after valid pairing", async () => {
  const state = setup({
    hostId: "host-login",
    guestId: "guest-login",
    password: "private-before-join",
  });
  const response = await handleInviteReactionRoute(
    request(true),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(response.status, 200);
  assert.equal(state.calls.auth, 0);
  assert.equal(state.calls.sockets, 1);
  assert.deepEqual(state.calls.rates, [
    "reactions:connect:spectator:192.0.2.1",
  ]);
  for (const invite of [
    null,
    {},
    { hostId: "host-login" },
    { hostId: "host-login", guestId: "host-login" },
  ]) {
    const pending = setup(invite);
    const result = await handleInviteReactionRoute(
      request(true),
      pending.env,
      ctx,
      pending.dependencies,
    );
    assert.ok(result.status >= 400);
    assert.equal(pending.calls.sockets, 0);
  }
});

test("requires approved browser socket origins and an actual upgrade", async () => {
  const state = setup();
  for (const origin of [
    "",
    "null",
    "https://evil.invalid",
    "https://mons.link.evil.invalid",
  ]) {
    const response = await handleInviteReactionRoute(
      request(true, { headers: { Origin: origin } }),
      state.env,
      ctx,
      state.dependencies,
    );
    assert.equal(response.status, 403);
  }
  const response = await handleInviteReactionRoute(
    request(true, { headers: { Upgrade: "" } }),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(response.status, 426);
  assert.equal(state.calls.sockets, 0);
  assert.deepEqual(state.calls.reads, []);
});

test("authenticates participant subprotocols and strips credentials from the room request and response", async () => {
  const state = setup();
  const response = await handleInviteReactionRoute(
    request(true, {
      headers: {
        "Sec-WebSocket-Protocol": socketProtocols,
        "X-Mons-Reaction-Role": "guest",
        "X-Mons-Reaction-IP": "spoofed",
      },
    }),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("Sec-WebSocket-Protocol"),
    REACTION_SOCKET_PROTOCOL,
  );
  assert.equal(state.calls.auth, 1);
  assert.equal(
    state.verifiedRequests[0].headers.get("Authorization"),
    `Bearer ${socketToken}`,
  );
  assert.equal(
    state.verifiedRequests[0].headers.get("Sec-WebSocket-Protocol"),
    null,
  );
  assert.deepEqual(Object.fromEntries(state.socketRequests[0].headers), {
    "sec-websocket-protocol": REACTION_SOCKET_PROTOCOL,
    upgrade: "websocket",
    "x-mons-reaction-ip": "192.0.2.1",
    "x-mons-reaction-role": "host",
  });
  assert.deepEqual(state.calls.rates, [
    "reactions:connect:identity:host-login",
    "reactions:connect:participant:host-login",
  ]);
  const publicState = setup();
  await handleInviteReactionRoute(
    request(true, {
      headers: {
        "X-Mons-Reaction-Role": "host",
        "X-Mons-Reaction-IP": "spoofed",
      },
    }),
    publicState.env,
    ctx,
    publicState.dependencies,
  );
  assert.equal(
    publicState.socketRequests[0].headers.get("X-Mons-Reaction-Role"),
    "spectator",
  );
  assert.equal(
    publicState.socketRequests[0].headers.get("X-Mons-Reaction-IP"),
    "192.0.2.1",
  );
  assert.equal(publicState.calls.auth, 0);
});

test("supports native bearer headers and rejects malformed or conflicting websocket credentials", async () => {
  const native = setup();
  const response = await handleInviteReactionRoute(
    request(true, { headers: { Authorization: `Bearer ${socketToken}` } }),
    native.env,
    ctx,
    native.dependencies,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Sec-WebSocket-Protocol"), null);
  const invalidHeaders: Record<string, string>[] = [
    { "Sec-WebSocket-Protocol": "" },
    { "Sec-WebSocket-Protocol": REACTION_SOCKET_PROTOCOL },
    { "Sec-WebSocket-Protocol": `${socketProtocols}, extra` },
    { "Sec-WebSocket-Protocol": `other, bearer.${socketToken}` },
    {
      "Sec-WebSocket-Protocol": `${REACTION_SOCKET_PROTOCOL}, bearer.bad-token`,
    },
    { "Sec-WebSocket-Protocol": `${REACTION_SOCKET_PROTOCOL}, bearer.a.b.c=` },
    {
      "Sec-WebSocket-Protocol": `${REACTION_SOCKET_PROTOCOL}, bearer.${"a".repeat(4096)}.b.c`,
    },
    { Authorization: "Bearer invalid" },
    { Authorization: `Bearer ${socketToken}.extra` },
    {
      Authorization: "Bearer different.payload.signature",
      "Sec-WebSocket-Protocol": socketProtocols,
    },
  ];
  for (const headers of invalidHeaders) {
    const state = setup();
    const rejected = await handleInviteReactionRoute(
      request(true, { headers }),
      state.env,
      ctx,
      state.dependencies,
    );
    assert.equal(rejected.status, 400);
    assert.equal(state.calls.auth, 0);
    assert.equal(state.calls.sockets, 0);
    assert.deepEqual(state.calls.rates, []);
  }
});

test("invalid auth and authenticated spectators cannot fall back to public admission", async () => {
  const denied = setup();
  denied.dependencies.verifyIdentity = async () => {
    throw new AuthApiFailure(401, "unauthenticated", "authentication-required");
  };
  const spectator = setup(undefined, "spectator");
  for (const state of [denied, spectator]) {
    const response = await handleInviteReactionRoute(
      request(true, { headers: { "Sec-WebSocket-Protocol": socketProtocols } }),
      state.env,
      ctx,
      state.dependencies,
    );
    assert.equal(response.status, state === denied ? 401 : 403);
    assert.equal(state.calls.sockets, 0);
    assert.deepEqual(
      state.calls.rates,
      state === denied ? [] : ["reactions:connect:identity:spectator"],
    );
  }
});

test("limits verified spectators before reading invite or ownership data", async () => {
  const state = setup(undefined, "spectator");
  state.env.REACTION_RATE_LIMITER = {
    limit: async ({ key }) => {
      state.calls.rates.push(key);
      return { success: false };
    },
  };
  const response = await handleInviteReactionRoute(
    request(true, { headers: { "Sec-WebSocket-Protocol": socketProtocols } }),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(response.status, 429);
  assert.deepEqual(state.calls.reads, []);
  assert.deepEqual(state.calls.rates, ["reactions:connect:identity:spectator"]);
  assert.equal(state.calls.sockets, 0);
});

test("public connection rate exhaustion cannot consume participant admission on the same IP", async () => {
  const state = setup();
  state.env.REACTION_RATE_LIMITER = {
    limit: async ({ key }) => {
      state.calls.rates.push(key);
      if (key.startsWith("reactions:connect:identity:")) {
        assert.equal(state.calls.auth, 1);
        assert.deepEqual(state.calls.reads, []);
        return { success: true };
      }
      if (key.startsWith("reactions:connect:participant:")) {
        assert.equal(state.calls.auth, 1);
        assert.deepEqual(state.calls.reads, ["invites/invite-one"]);
        return { success: true };
      }
      return { success: false };
    },
  };
  assert.equal(
    (
      await handleInviteReactionRoute(
        request(true),
        state.env,
        ctx,
        state.dependencies,
      )
    ).status,
    429,
  );
  assert.equal(
    (
      await handleInviteReactionRoute(
        request(true, {
          headers: { "Sec-WebSocket-Protocol": socketProtocols },
        }),
        state.env,
        ctx,
        state.dependencies,
      )
    ).status,
    200,
  );
  assert.deepEqual(state.calls.rates, [
    "reactions:connect:spectator:192.0.2.1",
    "reactions:connect:identity:host-login",
    "reactions:connect:participant:host-login",
  ]);
});

test("rejects URL tokens, malformed IDs and wrong methods before accessing a room", async () => {
  const state = setup();
  for (const path of [
    "/invites/a%2Fb/reactions",
    "/invites/%20invite-one/reactions",
    "/invites/%ZZ/reactions",
    "/invites/invite-one/reactions?token=secret",
  ]) {
    const response = await handleInviteReactionRoute(
      request(false, { path }),
      state.env,
      ctx,
      state.dependencies,
    );
    assert.equal(response.status, 400);
  }
  const response = await handleInviteReactionRoute(
    request(false, { method: "GET" }),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(response.status, 405);
  assert.deepEqual(state.calls.reads, []);
});

test("fails closed on auth, rate limit and ownership failures and reports conflicts", async () => {
  const denied = setup();
  denied.dependencies.verifyIdentity = async () => {
    throw new AuthApiFailure(401, "unauthenticated", "authentication-required");
  };
  assert.equal(
    (
      await handleInviteReactionRoute(
        request(),
        denied.env,
        ctx,
        denied.dependencies,
      )
    ).status,
    401,
  );
  assert.equal(denied.calls.published.length, 0);
  const limited = setup();
  limited.env.REACTION_RATE_LIMITER = {
    limit: async () => ({ success: false }),
  };
  const rateResponse = await handleInviteReactionRoute(
    request(),
    limited.env,
    ctx,
    limited.dependencies,
  );
  assert.equal(rateResponse.status, 429);
  assert.equal(rateResponse.headers.get("Retry-After"), "60");
  assert.equal(limited.calls.auth, 0);
  const failed = setup();
  failed.env.REACTION_RATE_LIMITER = {
    limit: async () => {
      throw new Error("offline");
    },
  };
  assert.equal(
    (
      await handleInviteReactionRoute(
        request(),
        failed.env,
        ctx,
        failed.dependencies,
      )
    ).status,
    503,
  );
  const ownership = setup(undefined, "linked-login");
  ownership.repository.readProfileOwnershipSnapshot = async () => {
    throw new Error("offline");
  };
  assert.equal(
    (
      await handleInviteReactionRoute(
        request(),
        ownership.env,
        ctx,
        ownership.dependencies,
      )
    ).status,
    503,
  );
  assert.equal(ownership.calls.published.length, 0);
  const conflict = setup();
  conflict.dependencies.room!.publish = async () => "conflict";
  assert.equal(
    (
      await handleInviteReactionRoute(
        request(),
        conflict.env,
        ctx,
        conflict.dependencies,
      )
    ).status,
    409,
  );
  conflict.dependencies.room!.publish = async () => "duplicate";
  assert.equal(
    (
      await handleInviteReactionRoute(
        request(),
        conflict.env,
        ctx,
        conflict.dependencies,
      )
    ).status,
    200,
  );
});
