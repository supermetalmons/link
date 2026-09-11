import { socketTestIdentity } from "./socketTestSession.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { MatchPresentation } from "@mons/shared/match-presentation";
import { AuthApiFailure } from "../src/authErrors.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import {
  handleMatchPresentationRoute,
  isMatchPresentationPath,
  type MatchPresentationRouteDependencies,
} from "../src/matchPresentationRoute.ts";
import type { ProfileOwnershipSnapshot } from "../src/profileOwnership.ts";
import { handleRequest } from "../src/router.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const ctx = { waitUntil: (_promise: Promise<unknown>) => undefined };
const payload = {
  operationId: "00000000-0000-4000-8000-000000000001",
  expectedRevision: 0,
  emojiId: 1000,
  aura: "rainbow",
};
const paired = { hostId: "host-login", guestId: "guest-login" };

function request(
  method = "POST",
  options: {
    path?: string;
    body?: unknown;
    anonymous?: boolean;
    headers?: Record<string, string>;
  } = {},
) {
  return new Request(
    `https://api.mons.link${options.path || "/invites/invite-one/matches/invite-one/presentation"}`,
    {
      method,
      headers: {
        Origin: "https://mons.link",
        "CF-Connecting-IP": "192.0.2.1",
        ...(options.anonymous ? {} : { Authorization: "Bearer test-token" }),
        ...options.headers,
      },
      ...(method === "POST"
        ? { body: JSON.stringify(options.body ?? payload) }
        : {}),
    },
  );
}

function setup(invite: unknown = paired, uid = "host-login") {
  const calls = {
    auth: 0,
    reads: [] as string[],
    rates: [] as string[],
    ensured: [] as unknown[],
    updated: [] as unknown[],
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
  const records = new Map<string, unknown>([["invites/invite-one", invite]]);
  const presentations = new Map<string, MatchPresentation>();
  for (const matchId of ["invite-one", "invite-one1", "invite-one2"])
    for (const actorUid of ["host-login", "guest-login"])
      presentations.set(`${actorUid}/${matchId}`, {
        matchId,
        actorUid,
        emojiId: actorUid === "host-login" ? 10 : 1001,
        aura: "",
        revision: 0,
      });
  const repository = createGameplayRepository(env, {
    stateClient: {
      getPath: async (path) => {
        calls.reads.push(path);
        if (path.startsWith("players/"))
          throw new Error("unexpected-source-appearance-read");
        return records.get(path) ?? null;
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
  repository.readInviteMetadata = async (inviteId) => {
    calls.reads.push(`invites/${inviteId}`);
    return (records.get(`invites/${inviteId}`) ?? null) as Record<
      string,
      unknown
    > | null;
  };
  repository.readProfileOwnershipSnapshot = async (query) => ({
    canonicalProfileIdByProfileId: new Map(),
    loginOwnerByUid: new Map(
      query.loginUids.map((actorUid) => [actorUid, null]),
    ),
    loginUidsByProfileId: new Map(),
    profileById: new Map(),
  });
  const current: MatchPresentation = {
    matchId: "invite-one",
    actorUid: "host-login",
    emojiId: 1000,
    aura: "rainbow",
    revision: 1,
  };
  const dependencies: MatchPresentationRouteDependencies = {
    repository,
    readPresentationControl: async () => ({ phase: "durable" }),
    readRegisteredPresentations: async (_env, _inviteId, matchId) => ({
      matchId,
      players: Object.fromEntries(
        [...presentations.values()]
          .filter((presentation) => presentation.matchId === matchId)
          .map((presentation) => [presentation.actorUid, presentation]),
      ),
    }),
    verifyIdentity: async () => {
      calls.auth++;
      return socketTestIdentity(uid);
    },
    room: {
      ensurePresentations: async (matchId, seeds) => {
        calls.ensured.push({ matchId, seeds });
        return {
          matchId,
          players: Object.fromEntries(
            Object.entries(seeds).map(([actorUid, seed]) => [
              actorUid,
              { matchId, actorUid, ...seed, revision: 0 },
            ]),
          ),
        };
      },
      updatePresentation: async (actorUid, matchId, update) => {
        calls.updated.push({ actorUid, matchId, update });
        return {
          status: "updated",
          presentation: { ...current, actorUid, matchId },
        };
      },
    },
    logFailure: () => undefined,
  };
  return {
    env,
    dependencies,
    calls,
    records,
    presentations,
    repository,
    current,
  };
}

test("presentation routes preflight before authentication or reads", async () => {
  assert.equal(
    isMatchPresentationPath("/invites/a/matches/a/presentation"),
    true,
  );
  assert.equal(
    isMatchPresentationPath("/invites/a/matches/a/presentation/other"),
    false,
  );
  const state = setup();
  const response = await handleRequest(
    request("OPTIONS"),
    state.env,
    { presentation: state.dependencies },
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
    ensured: [],
    updated: [],
  });
});

test("presentation updates resolve the actor server-side with registered cosmetics", async () => {
  const state = setup({ ...paired, eventId: "event-one" });
  const response = await handleMatchPresentationRoute(
    request(),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    presentation: state.current,
  });
  assert.deepEqual(state.calls.updated, [
    { actorUid: "host-login", matchId: "invite-one", update: payload },
  ]);
  assert.deepEqual(state.calls.ensured, []);
  assert.deepEqual(state.calls.reads, ["invites/invite-one"]);
  assert.deepEqual(state.calls.rates, [
    "presentation:post:ip:192.0.2.1",
    "presentation:post:actor:host-login",
  ]);
});

test("waiting hosts may read and update privately, while public reads require pairing", async () => {
  for (const method of ["GET", "POST"]) {
    const state = setup({ hostId: "host-login", password: "secret" });
    assert.equal(
      (
        await handleMatchPresentationRoute(
          request(method),
          state.env,
          ctx,
          state.dependencies,
        )
      ).status,
      200,
    );
    const anonymous = await handleMatchPresentationRoute(
      request("GET", { anonymous: true }),
      state.env,
      ctx,
      state.dependencies,
    );
    assert.equal(anonymous.status, 409);
  }
  const state = setup();
  const publicRead = await handleMatchPresentationRoute(
    request("GET", { anonymous: true }),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(publicRead.status, 200);
  assert.equal(state.calls.auth, 0);
  const spectator = setup(undefined, "spectator");
  assert.equal(
    (
      await handleMatchPresentationRoute(
        request("GET"),
        spectator.env,
        ctx,
        spectator.dependencies,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await handleMatchPresentationRoute(
        request(),
        spectator.env,
        ctx,
        spectator.dependencies,
      )
    ).status,
    403,
  );
  assert.deepEqual(spectator.calls.updated, []);
});

test("linked accounts write the original player's presentation", async () => {
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
  assert.equal(
    (
      await handleMatchPresentationRoute(
        request(),
        state.env,
        ctx,
        state.dependencies,
      )
    ).status,
    200,
  );
  assert.deepEqual(state.calls.updated, [
    { actorUid: "host-login", matchId: "invite-one", update: payload },
  ]);
});

test("updates target each actor's latest match, including only their own pending rematch", async () => {
  for (const uid of ["host-login", "guest-login"]) {
    const state = setup(
      { ...paired, hostRematches: "1;2", guestRematches: "1" },
      uid,
    );
    const expected = uid === "host-login" ? 2 : 1;
    for (const index of [0, 1, 2]) {
      const path = `/invites/invite-one/matches/invite-one${index || ""}/presentation`;
      assert.equal(
        (
          await handleMatchPresentationRoute(
            request("POST", { path }),
            state.env,
            ctx,
            state.dependencies,
          )
        ).status,
        index === expected ? 200 : 409,
      );
    }
  }
  const finished = setup({
    ...paired,
    hostRematches: "1x",
    guestRematches: "1x",
  });
  assert.equal(
    (
      await handleMatchPresentationRoute(
        request("POST", {
          path: "/invites/invite-one/matches/invite-one1/presentation",
        }),
        finished.env,
        ctx,
        finished.dependencies,
      )
    ).status,
    200,
  );
});

test("an ended series keeps the latest approved match current when a proposal was unanswered", async () => {
  for (const uid of ["host-login", "guest-login"]) {
    const state = setup(
      { ...paired, hostRematches: "1", guestRematches: "x" },
      uid,
    );
    assert.equal(
      (
        await handleMatchPresentationRoute(
          request(),
          state.env,
          ctx,
          state.dependencies,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await handleMatchPresentationRoute(
          request("POST", {
            path: "/invites/invite-one/matches/invite-one1/presentation",
          }),
          state.env,
          ctx,
          state.dependencies,
        )
      ).status,
      409,
    );
  }
});

test("rejects invalid paths, match membership, payloads and missing actor records", async () => {
  const state = setup();
  for (const path of [
    "/invites/a%2Fb/matches/a%2Fb/presentation",
    "/invites/%20invite-one/matches/invite-one/presentation",
    "/invites/%ZZ/matches/invite-one/presentation",
    "/invites/invite-one/matches/another/presentation",
    "/invites/invite-one/matches/invite-one/presentation?token=secret",
    "/invites/invite-one/matches/invite-one01/presentation",
  ])
    assert.equal(
      (
        await handleMatchPresentationRoute(
          request("GET", { path }),
          state.env,
          ctx,
          state.dependencies,
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await handleMatchPresentationRoute(
        request("GET", {
          path: "/invites/invite-one/matches/invite-one2/presentation",
        }),
        state.env,
        ctx,
        state.dependencies,
      )
    ).status,
    404,
  );
  for (const body of [
    { ...payload, actorUid: "guest-login" },
    { ...payload, emojiId: 155 },
    { ...payload, expectedRevision: -1 },
    { ...payload, aura: "x".repeat(5000) },
  ])
    assert.equal(
      (
        await handleMatchPresentationRoute(
          request("POST", { body }),
          state.env,
          ctx,
          state.dependencies,
        )
      ).status,
      400,
    );
  state.presentations.delete("host-login/invite-one");
  assert.equal(
    (
      await handleMatchPresentationRoute(
        request(),
        state.env,
        ctx,
        state.dependencies,
      )
    ).status,
    409,
  );
  assert.deepEqual(state.calls.updated, []);
});

test("returns canonical state on conflicts and fails closed for authentication or backend failure", async () => {
  const state = setup();
  state.dependencies.room!.updatePresentation = async () => ({
    status: "conflict",
    presentation: state.current,
  });
  const conflict = await handleMatchPresentationRoute(
    request(),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    ok: false,
    error: "presentation-conflict",
    presentation: state.current,
  });
  state.dependencies.room!.updatePresentation = async () => ({
    status: "duplicate",
    presentation: state.current,
  });
  assert.equal(
    (
      await handleMatchPresentationRoute(
        request(),
        state.env,
        ctx,
        state.dependencies,
      )
    ).status,
    200,
  );
  state.dependencies.verifyIdentity = async () => {
    throw new AuthApiFailure(401, "unauthenticated", "authentication-required");
  };
  assert.equal(
    (
      await handleMatchPresentationRoute(
        request("GET"),
        state.env,
        ctx,
        state.dependencies,
      )
    ).status,
    401,
  );
  state.env.REACTION_RATE_LIMITER = {
    limit: async () => {
      throw new Error("offline");
    },
  };
  assert.equal(
    (
      await handleMatchPresentationRoute(
        request(),
        state.env,
        ctx,
        state.dependencies,
      )
    ).status,
    503,
  );
});

test("rate limits before storage and returns retry headers", async () => {
  const state = setup();
  state.env.REACTION_RATE_LIMITER = { limit: async () => ({ success: false }) };
  const response = await handleMatchPresentationRoute(
    request(),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(state.calls.auth, 0);
  assert.deepEqual(state.calls.reads, []);
});

test("durable presentation reads and updates use registered cosmetics without Firebase match reads", async () => {
  const state = setup();
  state.dependencies.readPresentationControl = async () => ({
    phase: "durable",
  });
  state.dependencies.readRegisteredPresentations = async (
    _env,
    inviteId,
    matchId,
  ) => {
    assert.equal(inviteId, "invite-one");
    return {
      matchId,
      players: { "host-login": { ...state.current, matchId } },
    };
  };
  state.dependencies.room!.ensurePresentations = async () => {
    throw new Error("unexpected-legacy-bootstrap");
  };
  for (const method of ["GET", "POST"]) {
    const response = await handleMatchPresentationRoute(
      request(method),
      state.env,
      ctx,
      state.dependencies,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { presentation: unknown };
    assert.deepEqual(
      body.presentation,
      method === "GET"
        ? { matchId: "invite-one", players: { "host-login": state.current } }
        : state.current,
    );
  }
  assert.equal(
    state.calls.reads.some((path) => path.startsWith("players/")),
    false,
  );
});

test("durable pending rematches expose only registered actors", async () => {
  const state = setup({ ...paired, hostRematches: "1", guestRematches: "" });
  state.dependencies.readPresentationControl = async () => ({
    phase: "durable",
  });
  state.dependencies.readRegisteredPresentations = async (
    _env,
    _inviteId,
    matchId,
  ) => ({
    matchId,
    players: Object.fromEntries(
      ["host-login"].map((actorUid) => [
        actorUid,
        { ...state.current, matchId, actorUid },
      ]),
    ),
  });
  const response = await handleMatchPresentationRoute(
    request("GET", {
      path: "/invites/invite-one/matches/invite-one1/presentation",
      anonymous: true,
    }),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    presentation: { players: Record<string, unknown> };
  };
  assert.deepEqual(Object.keys(body.presentation.players), ["host-login"]);
  assert.deepEqual(state.calls.ensured, []);
  assert.equal(
    state.calls.reads.some((path) => path.startsWith("players/")),
    false,
  );
});

test("durable ensured guest matches remain readable before a guest rematch proposal", async () => {
  const state = setup(
    { ...paired, hostRematches: "1", guestRematches: "" },
    "guest-login",
  );
  state.dependencies.readPresentationControl = async () => ({
    phase: "durable",
  });
  state.dependencies.readRegisteredPresentations = async (
    _env,
    _inviteId,
    matchId,
  ) => ({
    matchId,
    players: Object.fromEntries(
      ["host-login", "guest-login"].map((actorUid) => [
        actorUid,
        { ...state.current, matchId, actorUid },
      ]),
    ),
  });
  const path = "/invites/invite-one/matches/invite-one1/presentation";
  const response = await handleMatchPresentationRoute(
    request("GET", { path, anonymous: true }),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    presentation: { players: Record<string, unknown> };
  };
  assert.deepEqual(Object.keys(body.presentation.players).sort(), [
    "guest-login",
    "host-login",
  ]);
  const updateResponse = await handleMatchPresentationRoute(
    request("POST", { path }),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(updateResponse.status, 409);
  assert.equal(
    ((await updateResponse.json()) as { message: string }).message,
    "match-not-current",
  );
  assert.deepEqual(state.calls.updated, []);
  assert.equal(
    state.calls.reads.some((selected) => selected.startsWith("players/")),
    false,
  );
});

test("durable missing actors and unavailable registered storage never bootstrap Firebase appearance", async () => {
  const state = setup();
  state.dependencies.readPresentationControl = async () => ({
    phase: "durable",
  });
  state.dependencies.readRegisteredPresentations = async (
    _env,
    _inviteId,
    matchId,
  ) => ({
    matchId,
    players: {
      "guest-login": { ...state.current, matchId, actorUid: "guest-login" },
    },
  });
  const missingActor = await handleMatchPresentationRoute(
    request(),
    state.env,
    ctx,
    state.dependencies,
  );
  assert.equal(missingActor.status, 409);
  assert.equal(
    ((await missingActor.json()) as { message: string }).message,
    "actor-match-not-found",
  );
  state.dependencies.readRegisteredPresentations = async (
    _env,
    _inviteId,
    matchId,
  ) => ({ matchId, players: {} });
  assert.equal(
    (
      await handleMatchPresentationRoute(
        request("GET"),
        state.env,
        ctx,
        state.dependencies,
      )
    ).status,
    404,
  );
  state.dependencies.readRegisteredPresentations = async () => {
    throw new Error("registered-presentation-missing");
  };
  assert.equal(
    (
      await handleMatchPresentationRoute(
        request("GET"),
        state.env,
        ctx,
        state.dependencies,
      )
    ).status,
    503,
  );
  assert.deepEqual(state.calls.ensured, []);
  assert.deepEqual(state.calls.updated, []);
  assert.equal(
    state.calls.reads.some((path) => path.startsWith("players/")),
    false,
  );
});

test("retired appearance authorities fail without reading or initializing Firebase seeds", async () => {
  for (const phase of ["legacy", "capture"] as const) {
    const state = setup();
    state.dependencies.readPresentationControl = async () => ({ phase });
    state.dependencies.readRegisteredPresentations = async () => {
      throw new Error("unexpected-registered-read");
    };
    for (const method of ["GET", "POST"]) {
      const response = await handleMatchPresentationRoute(
        request(method),
        state.env,
        ctx,
        state.dependencies,
      );
      assert.equal(response.status, 503);
    }
    assert.deepEqual(state.calls.ensured, []);
    assert.deepEqual(state.calls.updated, []);
    assert.equal(
      state.calls.reads.some((path) => path.startsWith("players/")),
      false,
    );
  }
});
