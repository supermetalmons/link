import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionRefreshToken,
  isSessionTokenResponse,
} from "@mons/shared/session-auth";
import {
  isSessionBootstrapResponse,
  isSessionEventBootstrapResponse,
  type SessionBootstrapResponse,
} from "@mons/shared/session-bootstrap";
import { eventSnapshotEtag, type EventSnapshotSeed } from "@mons/shared/events";
import { AuthApiFailure } from "../src/authErrors.ts";
import { createGameplayRepository } from "../src/gameplayRepository.ts";
import { normalizeInviteMetadata } from "../src/inviteMetadata.ts";
import { createMatchSyncSnapshot } from "../src/matchSync.ts";
import { handleRequest } from "../src/router.ts";
import {
  GAME_BOOTSTRAP_ENRICHMENT_TIMEOUT_MS,
  type SessionBootstrapDependencies,
} from "../src/sessionBootstrap.ts";
import type { SessionRouteDependencies } from "../src/sessionRoutes.ts";
import { TELEGRAM_TEST_ENV } from "./testEnv.ts";

const uid = "a".repeat(28);
const inviteId = "composed-invite";
const input = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  refreshSecret: "A".repeat(43),
  revokeSecret: `${"B".repeat(42)}A`,
};
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
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const eventSeed: EventSnapshotSeed = {
  snapshot: {
    ok: true,
    eventId: "event-one",
    revision: 2,
    event: { eventId: "event-one", status: "scheduled" },
    prizeSelections: {},
  },
  etag: eventSnapshotEtag("event-one", 2),
  bookmark: "mons-d1-v1:00000000-0000-4000-8000-000000000001:native",
};

function setup(source: Record<string, unknown> = {}) {
  const raw = { hostId: uid, guestId: "guest", hostColor: "white", ...source };
  const metadata = normalizeInviteMetadata(inviteId, raw);
  if (metadata.status !== "ok") throw new Error("invalid-fixture");
  const calls = {
    sessions: 0,
    admission: 0,
    pairs: [] as string[],
    authRates: [] as string[],
    gameRates: [] as string[],
  };
  const env: Env = {
    ...TELEGRAM_TEST_ENV,
    AUTH_RATE_LIMITER: {
      limit: async ({ key }) => {
        calls.authRates.push(key);
        return { success: true };
      },
    },
    MATCH_SYNC_RATE_LIMITER: {
      limit: async ({ key }) => {
        calls.gameRates.push(key);
        return { success: true };
      },
    },
  };
  const repository = createGameplayRepository(env);
  repository.readProfileOwnershipSnapshot = async (query) => ({
    canonicalProfileIdByProfileId: new Map(),
    loginOwnerByUid: new Map(query.loginUids.map((id) => [id, null])),
    loginUidsByProfileId: new Map(),
    profileById: new Map(),
  });
  const bootstrap: SessionBootstrapDependencies = {
    repository,
    readAdmission: async () => {
      calls.admission++;
      return raw;
    },
    room: {
      readMetadata: async () => metadata,
      readMatches: async (_id, matchId) => {
        calls.pairs.push(matchId);
        return {
          status: "ok",
          metadata,
          snapshot: createMatchSyncSnapshot(metadata, matchId, match, {
            ...match,
            color: "black",
          }),
        };
      },
    },
    logFailure: () => undefined,
  };
  const session = async () => {
    calls.sessions++;
    return { uid, sessionId: input.sessionId };
  };
  const dependencies: SessionRouteDependencies = {
    repository: {
      create: session,
      refresh: session,
      revoke: async () => undefined,
    },
    bootstrap,
  };
  const request = (
    endpoint = "anonymous",
    query = `bootstrapInviteId=${inviteId}`,
    signal?: AbortSignal,
  ) =>
    new Request(
      `https://api.mons.link/auth/session/${endpoint}${query ? `?${query}` : ""}`,
      {
        method: "POST",
        headers: {
          Origin: "https://mons.link",
          ...(endpoint === "anonymous"
            ? { "Content-Type": "application/json" }
            : {
                Authorization: `Bearer ${buildSessionRefreshToken(input.sessionId, input.refreshSecret)}`,
              }),
        },
        ...(endpoint === "anonymous" ? { body: JSON.stringify(input) } : {}),
        signal,
      },
    );
  const read = (incoming = request()) =>
    handleRequest(incoming, env, { session: dependencies });
  return { env, dependencies, bootstrap, calls, raw, request, read };
}

async function composed(response: Response): Promise<SessionBootstrapResponse> {
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(isSessionBootstrapResponse(body), true);
  if (!isSessionBootstrapResponse(body)) throw new Error("invalid-response");
  const { gameBootstrap: _bootstrap, ...session } = body;
  assert.equal(isSessionTokenResponse(session), true);
  assert.ok(!JSON.stringify(body).includes(input.refreshSecret));
  assert.ok(!JSON.stringify(body).includes(input.revokeSecret));
  return body;
}

test("creation and refresh compose a bootstrap with independent limits and timing", async () => {
  for (const endpoint of ["anonymous", "refresh"]) {
    const h = setup();
    const response = await h.read(h.request(endpoint));
    const body = await composed(response);
    assert.equal(body.gameBootstrap.result.ok, true);
    assert.equal(body.gameBootstrap.inviteId, inviteId);
    assert.equal(body.gameBootstrap.selection, "current");
    assert.equal(h.calls.sessions, 1);
    assert.equal(h.calls.admission, 1);
    assert.deepEqual(h.calls.pairs, [inviteId]);
    assert.equal(h.calls.authRates.length, 1);
    assert.deepEqual(h.calls.gameRates, [
      `game-bootstrap:read:identity:${uid}`,
    ]);
    for (const stage of ["session", "admission", "role", "match", "total"])
      assert.match(
        response.headers.get("Server-Timing") || "",
        new RegExp(`${stage};dur=`),
      );
    assert.equal(
      response.headers.get("Timing-Allow-Origin"),
      "https://mons.link",
    );
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
});

test("event creation and refresh bootstrap snapshots without game reads", async () => {
  for (const endpoint of ["anonymous", "refresh"]) {
    const h = setup();
    h.bootstrap.readEventSnapshotSeed = async (eventId) => {
      assert.equal(eventId, "event-one");
      assert.equal(h.calls.sessions, 1);
      return eventSeed;
    };
    const response = await h.read(
      h.request(endpoint, "bootstrapEventId=event-one"),
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(isSessionEventBootstrapResponse(body));
    assert.deepEqual(body.eventBootstrap.result, eventSeed);
    assert.equal(h.calls.admission, 0);
    assert.deepEqual(h.calls.pairs, []);
    assert.match(
      response.headers.get("Server-Timing") || "",
      /event_snapshot;dur=/,
    );
  }
});

test("event bootstrap failures preserve valid issued tokens", async () => {
  const h = setup();
  h.bootstrap.readEventSnapshotSeed = async () => {
    throw new Error("storage-down");
  };
  const response = await h.read(
    h.request("anonymous", "bootstrapEventId=event-one"),
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(isSessionEventBootstrapResponse(body));
  assert.deepEqual(body.eventBootstrap, {
    eventId: "event-one",
    result: { ok: false, status: 503 },
  });
});

test("event bootstrap rejects ambiguous targets before allocating a session", async () => {
  for (const query of [
    "bootstrapEventId=",
    "bootstrapEventId=bad%2Fid",
    "bootstrapEventId=%20event",
    "bootstrapEventId=one&bootstrapEventId=two",
    "bootstrapEventId=one&bootstrapInviteId=invite",
    "bootstrapEventId=one&bootstrapSelection=current",
    "bootstrapEventId=one&extra=true",
  ]) {
    const h = setup();
    const response = await h.read(h.request("anonymous", query));
    assert.equal(response.status, 400);
    assert.equal(h.calls.sessions, 0);
  }
});

test("event bootstrap timeout returns its already issued token", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = setup();
  let started = false;
  h.bootstrap.readEventSnapshotSeed = async () => {
    started = true;
    return new Promise(() => undefined);
  };
  const pending = h.read(h.request("anonymous", "bootstrapEventId=event-one"));
  for (let attempt = 0; attempt < 20 && !started; attempt++) await flush();
  assert.equal(started, true);
  t.mock.timers.tick(1_000);
  const response = await pending;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(isSessionEventBootstrapResponse(body));
  assert.deepEqual(body.eventBootstrap.result, { ok: false, status: 503 });
});

test("session composition honors approved selection for pending rematches", async () => {
  for (const selection of ["current", "approved"]) {
    const h = setup({ hostRematches: "1", guestRematches: "" });
    const body = await composed(
      await h.read(
        h.request(
          "refresh",
          `bootstrapInviteId=${inviteId}&bootstrapSelection=${selection}`,
        ),
      ),
    );
    assert.equal(body.gameBootstrap.selection, selection);
    assert.deepEqual(h.calls.pairs, [
      selection === "current" ? `${inviteId}1` : inviteId,
    ]);
  }
});

test("missing, invalid, denied, failed and rate-limited game reads retain session success", async () => {
  for (const [status, source] of [
    [404, null],
    [409, { invalid: true }],
    [
      403,
      { hostId: "other", guestId: null, hostColor: "white", password: true },
    ],
    [503, new Error("private details")],
  ] as const) {
    const h = setup();
    h.bootstrap.readAdmission = async () => {
      if (source instanceof Error) throw source;
      return source;
    };
    const body = await composed(await h.read());
    assert.deepEqual(body.gameBootstrap.result, { ok: false, status });
    assert.deepEqual(h.calls.pairs, []);
  }
  const h = setup();
  h.env.MATCH_SYNC_RATE_LIMITER.limit = async () => ({ success: false });
  const body = await composed(await h.read());
  assert.deepEqual(body.gameBootstrap.result, {
    ok: false,
    status: 429,
    retryAfterMs: 60_000,
  });
  assert.equal(h.calls.sessions, 1);
  assert.equal(h.calls.admission, 0);
});

test("invalid opt-in and unsuccessful authentication never begin a game read", async () => {
  for (const query of [
    "bootstrapSelection=approved",
    "bootstrapInviteId=",
    "bootstrapInviteId=bad%2Fid",
    "bootstrapInviteId=%20invite",
    "bootstrapInviteId=one&bootstrapInviteId=two",
    "bootstrapInviteId=invite&bootstrapSelection=current&bootstrapSelection=approved",
    "bootstrapInviteId=invite&bootstrapSelection=latest",
    "bootstrapInviteId=invite&extra=true",
  ]) {
    const h = setup();
    assert.equal((await h.read(h.request("anonymous", query))).status, 400);
    assert.equal(h.calls.sessions, 0);
    assert.equal(h.calls.admission, 0);
  }
  for (const status of [401, 503]) {
    const h = setup();
    h.dependencies.repository!.refresh = async () => {
      throw new AuthApiFailure(
        status,
        "unauthenticated",
        "session-unavailable",
      );
    };
    assert.equal((await h.read(h.request("refresh"))).status, status);
    assert.equal(h.calls.admission, 0);
  }
  const limited = setup();
  limited.env.AUTH_RATE_LIMITER.limit = async () => ({ success: false });
  assert.equal((await limited.read()).status, 429);
  assert.equal(limited.calls.sessions, 0);
  assert.equal(limited.calls.admission, 0);
  const legacy = setup();
  assert.equal(
    isSessionTokenResponse(
      await (await legacy.read(legacy.request("refresh", ""))).json(),
    ),
    true,
  );
  assert.equal(legacy.calls.admission, 0);
});

test("a bounded enrichment timeout preserves the session and blocks late room work", async () => {
  const h = setup();
  let resolve: (value: unknown) => void = () => undefined;
  let timeout: (() => void) | undefined;
  let cleared = false;
  let signal: AbortSignal | undefined;
  const timer = setTimeout(() => undefined, 60_000);
  clearTimeout(timer);
  h.bootstrap.setTimer = (callback, delay) => {
    assert.equal(delay, GAME_BOOTSTRAP_ENRICHMENT_TIMEOUT_MS);
    timeout = callback;
    return timer;
  };
  h.bootstrap.clearTimer = () => {
    cleared = true;
  };
  h.bootstrap.readAdmission = async (_id, incomingSignal) => {
    signal = incomingSignal;
    return new Promise((yes) => {
      resolve = yes;
    });
  };
  const pending = h.read();
  for (let attempt = 0; attempt < 20 && !signal; attempt++) await flush();
  assert.ok(signal);
  assert.ok(timeout);
  timeout();
  const body = await composed(await pending);
  assert.deepEqual(body.gameBootstrap.result, { ok: false, status: 503 });
  assert.equal(signal.aborted, true);
  assert.equal(cleared, true);
  resolve(h.raw);
  await flush();
  assert.deepEqual(h.calls.pairs, []);
});

test("deadline checks reject a late source before delayed timers fire", async () => {
  const h = setup();
  let now = 0;
  h.bootstrap.now = () => now;
  h.bootstrap.readAdmission = async () => {
    now = GAME_BOOTSTRAP_ENRICHMENT_TIMEOUT_MS;
    return h.raw;
  };
  const body = await composed(await h.read());
  assert.deepEqual(body.gameBootstrap.result, { ok: false, status: 503 });
  assert.deepEqual(h.calls.pairs, []);
});

test("request cancellation stops enrichment while retaining the established session", async () => {
  const h = setup();
  const controller = new AbortController();
  h.bootstrap.readAdmission = async () => {
    controller.abort();
    return h.raw;
  };
  const body = await composed(
    await h.read(h.request("refresh", undefined, controller.signal)),
  );
  assert.deepEqual(body.gameBootstrap.result, { ok: false, status: 503 });
  assert.deepEqual(h.calls.pairs, []);
});
