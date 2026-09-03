const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
}: typeof import("node:fs") = require("node:fs");
const { tmpdir }: typeof import("node:os") = require("node:os");
const { join }: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const {
  DEFAULT_SMOKE_PROFILE,
  DEFAULT_SMOKE_SOL,
  parseArgs,
  smokeApi,
  smokeAuthenticatedAuthState,
  smokeEventReads,
  smokeFrozenProfileWrite,
} = require("./smoke-cloudflare-api.ts") as {
  DEFAULT_SMOKE_PROFILE: {
    loginId: string;
    profileId: string;
    invite?: { actorUid: string; id: string; role: "guest" | "host" };
    historicalMatch?: { inviteId: string; matchId: string };
    events?: {
      assignedPrizeId: string;
      currentId: string;
      endedId: string;
      selectionEventId?: string;
      selectionPrizeId: string;
    };
  };
  DEFAULT_SMOKE_SOL: string;
  parseArgs: (argv: string[]) => {
    baseUrl: string;
    readOnly: boolean;
    readOnlyAuthToken: string | null;
    requireHistory: boolean;
    requireEvents?: boolean;
    smokeProfile: {
      loginId: string;
      profileId: string;
      invite?: { actorUid: string; id: string; role: "guest" | "host" };
      historicalMatch?: { inviteId: string; matchId: string };
      events?: {
        assignedPrizeId: string;
        currentId: string;
        endedId: string;
        selectionEventId?: string;
        selectionPrizeId: string;
      };
    };
    smokeSol: string;
  };
  smokeApi: (
    options: {
      baseUrl: string;
      readOnlyAuthToken?: string | null;
      readOnly?: boolean;
      requireHistory: boolean;
      requireEvents?: boolean;
      smokeProfile: {
        loginId: string;
        profileId: string;
        invite?: { actorUid: string; id: string; role: "guest" | "host" };
        historicalMatch?: { inviteId: string; matchId: string };
        events?: {
          assignedPrizeId: string;
          currentId: string;
          endedId: string;
          selectionEventId?: string;
          selectionPrizeId: string;
        };
      };
      smokeSol: string;
    },
    dependencies: {
      fetch: typeof fetch;
      randomState: () => string;
      log: (message: string) => void;
    },
  ) => Promise<void>;
  smokeAuthenticatedAuthState: (
    baseUrl: string,
    smokeProfile: {
      loginId: string;
      profileId: string;
      invite?: { actorUid: string; id: string; role: "guest" | "host" };
      historicalMatch?: { inviteId: string; matchId: string };
      events?: {
        assignedPrizeId: string;
        currentId: string;
        endedId: string;
        selectionEventId?: string;
        selectionPrizeId: string;
      };
    },
    dependencies: {
      fetch: typeof fetch;
      randomState: () => string;
      log: (message: string) => void;
    },
    existingIdToken?: string,
    eventFixture?: {
      assignedPrizeId: string;
      currentId: string;
      endedId: string;
      selectionEventId?: string;
      selectionPrizeId: string;
    },
  ) => Promise<void>;
  smokeEventReads: (
    baseUrl: string,
    idToken: string,
    expectedProfileId: string | null,
    eventFixture:
      | {
          assignedPrizeId: string;
          currentId: string;
          endedId: string;
          selectionEventId?: string;
          selectionPrizeId: string;
        }
      | undefined,
    dependencies: {
      fetch: typeof fetch;
      randomState: () => string;
      log: (message: string) => void;
    },
  ) => Promise<void>;
  smokeFrozenProfileWrite: (
    baseUrl: string,
    idToken: string,
    dependencies: {
      fetch: typeof fetch;
      randomState: () => string;
      log: (message: string) => void;
    },
  ) => Promise<void>;
};

const WALLET = "11111111111111111111111111111111";
const LOGIN = "known-login";
const SMOKE_EVENTS = {
  assignedPrizeId: "1866",
  currentId: "NN3eRzoZo80",
  endedId: "FRkdorMWaYW",
  selectionPrizeId: "1092",
};
const EVENT_READ_CORS_HEADERS = {
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, If-None-Match, X-D1-Bookmark",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Origin": "https://mons.link",
  "Access-Control-Expose-Headers": "ETag, X-D1-Bookmark",
};
const SMOKE_PROFILE = {
  loginId: LOGIN,
  profileId: "profile-1",
  invite: { actorUid: "host-login", id: "invite-1", role: "host" as const },
  events: SMOKE_EVENTS,
};
const HISTORICAL_MATCH = {
  inviteId: "historygame",
  matchId: "historygame1",
};
const SMOKE_PROFILE_WITH_HISTORY = {
  ...SMOKE_PROFILE,
  historicalMatch: HISTORICAL_MATCH,
};
const HISTORICAL_MATCH_RECORD = {
  version: 2,
  color: "white" as const,
  emojiId: 1,
  aura: "",
  gameVariant: "Classic",
  fen: "fen",
  status: "surrendered",
  flatMovesString: "move",
  timer: "",
};
const HISTORICAL_MATCH_PAIR = {
  matchId: HISTORICAL_MATCH.matchId,
  hostPlayerId: "history-host",
  guestPlayerId: "history-guest",
  hostMatch: HISTORICAL_MATCH_RECORD,
  guestMatch: {
    ...HISTORICAL_MATCH_RECORD,
    color: "black" as const,
    emojiId: 2,
  },
};
const AUTH_TOKEN = `header.${Buffer.from(
  JSON.stringify({ sub: LOGIN }),
).toString("base64url")}.signature`;
const EMPTY_NFTS = {
  ok: true,
  specials: [],
  swagpack_avatars: [],
  swagpack_reactions: [],
};
const PROFILE = {
  id: "profile-1",
  nonce: 1,
  rating: 1500,
  totalManaPoints: 0,
  win: true,
  emoji: 1,
  username: null,
  eth: null,
  sol: null,
  mining: {
    lastRockDate: null,
    materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  },
};
function json(
  body: unknown,
  status: number,
  headers: HeadersInit = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function profileFixture(value: unknown = SMOKE_PROFILE): {
  cleanup(): void;
  path: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "mons-link-smoke-"));
  const path = join(directory, "profile.json");
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return {
    path,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function authTokenFixture(idToken = AUTH_TOKEN): {
  cleanup(): void;
  path: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "mons-link-smoke-auth-"));
  const path = join(directory, "auth.json");
  writeFileSync(path, JSON.stringify({ idToken }), { mode: 0o600 });
  return {
    path,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("parses only production and canonical preview smoke targets", () => {
  const fixture = profileFixture();
  const historyFixture = profileFixture(SMOKE_PROFILE_WITH_HISTORY);
  const authFixture = authTokenFixture();
  try {
    assert.deepEqual(parseArgs(["--base-url", "https://api.mons.link/"]), {
      baseUrl: "https://api.mons.link",
      readOnly: false,
      readOnlyAuthToken: null,
      requireHistory: false,
      smokeProfile: DEFAULT_SMOKE_PROFILE,
      smokeSol: DEFAULT_SMOKE_SOL,
    });
    assert.deepEqual(
      parseArgs([
        "--base-url",
        "https://api.mons.link/",
        "--smoke-sol",
        WALLET,
        "--smoke-profile-fixture",
        fixture.path,
      ]),
      {
        baseUrl: "https://api.mons.link",
        readOnly: false,
        readOnlyAuthToken: null,
        requireHistory: false,
        smokeProfile: SMOKE_PROFILE,
        smokeSol: WALLET,
      },
    );
    assert.deepEqual(
      parseArgs([
        "--base-url",
        "https://12ab34cd-mons-link-api.lil-org.workers.dev",
      ]),
      {
        baseUrl: "https://12ab34cd-mons-link-api.lil-org.workers.dev",
        readOnly: false,
        readOnlyAuthToken: null,
        requireHistory: false,
        smokeProfile: DEFAULT_SMOKE_PROFILE,
        smokeSol: DEFAULT_SMOKE_SOL,
      },
    );
    assert.deepEqual(
      parseArgs([
        "--base-url",
        "https://api.mons.link/",
        "--read-only",
        "--auth-token-fixture",
        authFixture.path,
        "--smoke-profile-fixture",
        fixture.path,
      ]),
      {
        baseUrl: "https://api.mons.link",
        readOnly: true,
        readOnlyAuthToken: AUTH_TOKEN,
        requireHistory: false,
        smokeProfile: SMOKE_PROFILE,
        smokeSol: DEFAULT_SMOKE_SOL,
      },
    );
    assert.deepEqual(
      parseArgs([
        "--base-url",
        "https://api.mons.link/",
        "--read-only",
        "--auth-token-fixture",
        authFixture.path,
        "--smoke-profile-fixture",
        historyFixture.path,
        "--require-history",
        "--require-events",
      ]),
      {
        baseUrl: "https://api.mons.link",
        readOnly: true,
        readOnlyAuthToken: AUTH_TOKEN,
        requireHistory: true,
        requireEvents: true,
        smokeProfile: SMOKE_PROFILE_WITH_HISTORY,
        smokeSol: DEFAULT_SMOKE_SOL,
      },
    );
    assert.throws(
      () => parseArgs(["--base-url", "https://api.mons.link", "--read-only"]),
      /Usage:/,
    );
    assert.throws(
      () =>
        parseArgs([
          "--base-url",
          "https://api.mons.link",
          "--auth-token-fixture",
          authFixture.path,
        ]),
      /Usage:/,
    );
    assert.throws(
      () =>
        parseArgs([
          "--base-url",
          "https://api.mons.link",
          "--smoke-profile-fixture",
          historyFixture.path,
          "--require-history",
        ]),
      /Usage:/,
    );
    assert.throws(
      () =>
        parseArgs([
          "--base-url",
          "https://api.mons.link",
          "--read-only",
          "--auth-token-fixture",
          authFixture.path,
          "--smoke-profile-fixture",
          fixture.path,
          "--require-history",
        ]),
      /Usage:/,
    );
    assert.throws(
      () =>
        parseArgs([
          "--base-url",
          "https://api.mons.link",
          "--read-only",
          "--auth-token-fixture",
          authFixture.path,
          "--smoke-profile-fixture",
          historyFixture.path,
          "--require-history",
          "--require-history",
        ]),
      /Usage:/,
    );
    assert.throws(
      () =>
        parseArgs([
          "--base-url",
          "https://api.mons.link/",
          "--read-only",
          "--read-only",
          "--auth-token-fixture",
          authFixture.path,
        ]),
      /Usage:/,
    );
    for (const target of [
      "http://api.mons.link",
      "https://evil.example",
      "https://api.mons.link/path",
      "https://user@api.mons.link",
    ]) {
      assert.throws(() => parseArgs(["--base-url", target]), /Usage:/);
    }
    chmodSync(fixture.path, 0o644);
    assert.throws(
      () =>
        parseArgs([
          "--base-url",
          "https://api.mons.link",
          "--smoke-profile-fixture",
          fixture.path,
        ]),
      /Usage:/,
    );
    chmodSync(authFixture.path, 0o644);
    assert.throws(
      () =>
        parseArgs([
          "--base-url",
          "https://api.mons.link",
          "--read-only",
          "--auth-token-fixture",
          authFixture.path,
        ]),
      /Usage:/,
    );
  } finally {
    fixture.cleanup();
    historyFixture.cleanup();
    authFixture.cleanup();
  }
});

test("rejects malformed historical match smoke fixtures", () => {
  const authFixture = authTokenFixture();
  const values = [
    {
      ...SMOKE_PROFILE,
      historicalMatch: { ...HISTORICAL_MATCH, extra: true },
    },
    {
      ...SMOKE_PROFILE,
      historicalMatch: { inviteId: "bad/id", matchId: "bad/id1" },
    },
    {
      ...SMOKE_PROFILE,
      historicalMatch: { inviteId: "historygame", matchId: "other" },
    },
    {
      ...SMOKE_PROFILE,
      historicalMatch: { inviteId: " historygame", matchId: " historygame1" },
    },
  ];
  try {
    for (const value of values) {
      const fixture = profileFixture(value);
      try {
        assert.throws(
          () =>
            parseArgs([
              "--base-url",
              "https://api.mons.link",
              "--read-only",
              "--auth-token-fixture",
              authFixture.path,
              "--smoke-profile-fixture",
              fixture.path,
              "--require-history",
            ]),
          /Usage:/,
        );
      } finally {
        fixture.cleanup();
      }
    }
  } finally {
    authFixture.cleanup();
  }
});

test("accepts prize selections on either required event snapshot", () => {
  for (const events of [
    { ...SMOKE_EVENTS, selectionEventId: SMOKE_EVENTS.currentId },
    {
      ...SMOKE_EVENTS,
      currentId: "active-event-without-prizes",
      selectionEventId: SMOKE_EVENTS.endedId,
      selectionPrizeId: SMOKE_EVENTS.assignedPrizeId,
    },
  ]) {
    const value = { ...SMOKE_PROFILE, events };
    const fixture = profileFixture(value);
    try {
      assert.deepEqual(
        parseArgs([
          "--base-url",
          "https://api.mons.link",
          "--smoke-profile-fixture",
          fixture.path,
        ]).smokeProfile,
        value,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("rejects invalid event selection fixtures", () => {
  for (const events of [
    { ...SMOKE_EVENTS, selectionEventId: "other-event" },
    { ...SMOKE_EVENTS, selectionEventId: "" },
    { ...SMOKE_EVENTS, selectionEventId: null },
    { ...SMOKE_EVENTS, selectionEventId: SMOKE_EVENTS.endedId },
    { ...SMOKE_EVENTS, extra: true },
    {
      ...SMOKE_EVENTS,
      selectionEventId: SMOKE_EVENTS.currentId,
      extra: true,
    },
  ]) {
    const fixture = profileFixture({ ...SMOKE_PROFILE, events });
    try {
      assert.throws(
        () =>
          parseArgs([
            "--base-url",
            "https://api.mons.link",
            "--smoke-profile-fixture",
            fixture.path,
          ]),
        /Usage:/,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("smokes public, unauthenticated, and internal routes", async () => {
  const requests: Array<{ authorized: boolean; method: string; url: string }> =
    [];
  const leaderboardTypes: string[] = [];
  let nftPosts = 0;
  let requiredHistoricalPayload: unknown = {
    ok: true,
    pair: HISTORICAL_MATCH_PAIR,
  };
  let requiredHistoricalStatus = 200;
  let requiredHistoryCacheControl = "no-store";
  const fetchStub: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    requests.push({
      authorized: new Headers(init?.headers).has("Authorization"),
      method,
      url,
    });
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.signal instanceof AbortSignal, true);

    if (url.endsWith("/nfts") && method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    }
    if (url.endsWith("/nfts") && method === "POST") {
      nftPosts += 1;
      return json(
        nftPosts === 1
          ? EMPTY_NFTS
          : {
              ...EMPTY_NFTS,
              specials: [{ id: 2, count: 1 }],
            },
        200,
      );
    }
    if (url.endsWith("/auth/intents") && method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "https://mons.link",
          "Cache-Control": "no-store",
        },
      });
    }
    if (url.endsWith("/auth/intents")) {
      if (new Headers(init?.headers).has("Authorization")) {
        return json(
          {
            ok: true,
            intentId: "abcdefghijklmnopqrstuvwx",
            nonce: "nonce",
            state: "state",
            expiresAtMs: 2_000_000,
          },
          200,
        );
      }
      return json({ error: "unauthenticated" }, 401);
    }
    if (url.endsWith("/auth/x/flows")) {
      return json(
        {
          ok: true,
          flowId: "zyxwvutsrqponmlkjihgfedc",
          authUrl:
            "https://x.com/i/oauth2/authorize?state=zyxwvutsrqponmlkjihgfedc",
          expiresAtMs: 2_000_000,
        },
        200,
      );
    }
    if (url.endsWith("/auth/methods")) {
      const authorization = new Headers(init?.headers).get("Authorization");
      return json(
        {
          ok: true,
          profileId:
            authorization === `Bearer ${AUTH_TOKEN}`
              ? SMOKE_PROFILE.profileId
              : null,
          linkedMethods: { apple: false, eth: false, sol: false, x: false },
          appleLinked: false,
        },
        200,
      );
    }
    if (
      (url.includes("/events/snapshot?") || url.endsWith("/events/prizes")) &&
      method === "OPTIONS"
    ) {
      return new Response(null, {
        status: 204,
        headers: {
          ...EVENT_READ_CORS_HEADERS,
          "Cache-Control": "no-store",
        },
      });
    }
    if (url.includes("/events/snapshot?") && method === "GET") {
      const headers = new Headers(init?.headers);
      if (headers.get("If-None-Match")) {
        return new Response(null, {
          status: 304,
          headers: {
            ...EVENT_READ_CORS_HEADERS,
            ETag: 'W/"event-snapshot"',
            "X-D1-Bookmark": "bookmark",
            "Cache-Control": "no-store",
          },
        });
      }
      const requestedEventId = new URL(url).searchParams.get("eventId");
      const fixtureStatus =
        requestedEventId === SMOKE_EVENTS.currentId
          ? "active"
          : requestedEventId === SMOKE_EVENTS.endedId
            ? "ended"
            : null;
      return json(
        {
          ok: true,
          eventId: requestedEventId,
          revision: fixtureStatus ? 1 : 0,
          event: fixtureStatus
            ? {
                eventId: requestedEventId,
                status: fixtureStatus,
                ...(fixtureStatus === "ended"
                  ? {
                      prizeAssignments: {
                        1: {
                          eventId: SMOKE_EVENTS.endedId,
                          profileId: SMOKE_PROFILE.profileId,
                          place: 1,
                          prizeId: SMOKE_EVENTS.assignedPrizeId,
                          assignedAtMs: 1,
                        },
                      },
                    }
                  : {}),
              }
            : null,
          prizeSelections:
            requestedEventId === SMOKE_EVENTS.currentId
              ? { [SMOKE_PROFILE.profileId]: SMOKE_EVENTS.selectionPrizeId }
              : {},
        },
        200,
        {
          ...EVENT_READ_CORS_HEADERS,
          ETag: 'W/"event-snapshot"',
          "X-D1-Bookmark": "bookmark",
        },
      );
    }
    if (url.endsWith("/events/prizes") && method === "GET") {
      if (new Headers(init?.headers).get("If-None-Match")) {
        return new Response(null, {
          status: 304,
          headers: {
            ...EVENT_READ_CORS_HEADERS,
            ETag: 'W/"profile-prizes"',
            "X-D1-Bookmark": "bookmark",
            "Cache-Control": "no-store",
          },
        });
      }
      const authorization = new Headers(init?.headers).get("Authorization");
      return json(
        {
          ok: true,
          profileId:
            authorization === `Bearer ${AUTH_TOKEN}`
              ? SMOKE_PROFILE.profileId
              : null,
          revision: authorization === `Bearer ${AUTH_TOKEN}` ? 1 : 0,
          prizes:
            authorization === `Bearer ${AUTH_TOKEN}`
              ? {
                  [SMOKE_EVENTS.endedId]: {
                    eventId: SMOKE_EVENTS.endedId,
                    profileId: SMOKE_PROFILE.profileId,
                    place: 1,
                    prizeId: SMOKE_EVENTS.assignedPrizeId,
                    assignedAtMs: 1,
                  },
                }
              : {},
        },
        200,
        {
          ...EVENT_READ_CORS_HEADERS,
          ETag: 'W/"profile-prizes"',
          "X-D1-Bookmark": "bookmark",
        },
      );
    }
    if (url.endsWith("/leaderboards/read")) {
      leaderboardTypes.push(String(JSON.parse(String(init?.body))?.type || ""));
      return json({ ok: true, profiles: [PROFILE] }, 200);
    }
    if (url.endsWith("/profiles/lookup")) {
      return json(
        {
          ok: true,
          profile: PROFILE,
        },
        200,
      );
    }
    if (url.includes("/matches/history?")) {
      const historyUrl = new URL(url);
      const isRequiredHistory =
        historyUrl.searchParams.get("inviteId") === HISTORICAL_MATCH.inviteId &&
        historyUrl.searchParams.get("matchId") === HISTORICAL_MATCH.matchId;
      return new Response(
        JSON.stringify(
          isRequiredHistory
            ? requiredHistoricalPayload
            : { ok: true, pair: null },
        ),
        {
          status: isRequiredHistory ? requiredHistoricalStatus : 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": isRequiredHistory
              ? requiredHistoryCacheControl
              : "no-store",
            "Content-Type": "application/json",
          },
        },
      );
    }
    if (
      url.endsWith("/invites/role/read") &&
      new Headers(init?.headers).has("Authorization")
    ) {
      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization === `Bearer ${AUTH_TOKEN}`) {
        assert.deepEqual(JSON.parse(String(init?.body)), {
          inviteId: SMOKE_PROFILE.invite.id,
        });
        return json(
          {
            ok: true,
            inviteId: SMOKE_PROFILE.invite.id,
            hostId: SMOKE_PROFILE.invite.actorUid,
            guestId: null,
            actorUid: SMOKE_PROFILE.invite.actorUid,
            role: SMOKE_PROFILE.invite.role,
          },
          200,
        );
      }
      return json(
        { ok: false, error: "not-found", message: "invite-not-found" },
        404,
      );
    }
    if (
      url.endsWith("/navigation/games/read") &&
      new Headers(init?.headers).has("Authorization")
    ) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        limit: 1,
        cursor: null,
      });
      return json(
        {
          ok: true,
          items: [
            {
              id: SMOKE_PROFILE.invite.id,
              entityType: "game",
              inviteId: SMOKE_PROFILE.invite.id,
              kind: "direct",
              status: "waiting",
              sortBucket: 30,
              listSortAtMs: 1,
              hostLoginId: SMOKE_PROFILE.invite.actorUid,
              guestLoginId: null,
              opponentProfileId: null,
              opponentName: null,
              opponentEmoji: null,
              automatchStateHint: null,
              isPendingAutomatch: false,
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
        200,
      );
    }
    if (url.includes("identitytoolkit.googleapis.com/v1/accounts:signUp")) {
      return json({ idToken: "firebase-id-token", localId: "smoke-uid" }, 200);
    }
    if (url.includes("identitytoolkit.googleapis.com/v1/accounts:delete")) {
      return json({}, 200);
    }
    if (
      [
        "/invites/create",
        "/invites/join",
        "/invites/role/read",
        "/matches/ensure",
        "/navigation/games/read",
        "/rematches/propose",
        "/rematches/end",
        "/events/create",
        "/events/start/postpone",
        "/events/matches/winners/disqualify",
        "/events/prize-selections/toggle",
        "/events/prizes/withdrawals",
        "/events/prizes/withdrawals/status",
        "/events/state/sync",
        "/profiles/custom",
      ].some((path) => url.endsWith(path))
    ) {
      return json({ error: "unauthenticated" }, 401);
    }
    if (url.includes("/auth/x/callback")) {
      return json({ error: "invalid-state" }, 400);
    }
    if (url.endsWith("/internal/telegram/delivery")) {
      return json({ error: "unauthenticated" }, 401);
    }
    throw new Error(`Unexpected smoke request: ${method} ${url}`);
  };
  const logs: string[] = [];

  await smokeApi(
    {
      baseUrl: "https://api.mons.link",
      requireHistory: false,
      smokeProfile: SMOKE_PROFILE,
      smokeSol: WALLET,
    },
    {
      fetch: fetchStub,
      randomState: () => "abcdefghijklmnopqrstuvwx",
      log: (message) => logs.push(message),
    },
  );

  assert.deepEqual(leaderboardTypes, [
    "rating",
    "mp",
    "dust",
    "slime",
    "gum",
    "metal",
    "ice",
  ]);
  assert.deepEqual(logs, ["[api-smoke] Passed https://api.mons.link"]);

  requests.length = 0;
  leaderboardTypes.length = 0;
  logs.length = 0;
  nftPosts = 0;
  await smokeApi(
    {
      baseUrl: "https://api.mons.link",
      readOnlyAuthToken: AUTH_TOKEN,
      readOnly: true,
      requireHistory: true,
      requireEvents: true,
      smokeProfile: SMOKE_PROFILE_WITH_HISTORY,
      smokeSol: WALLET,
    },
    {
      fetch: fetchStub,
      randomState: () => "abcdefghijklmnopqrstuvwx",
      log: (message) => logs.push(message),
    },
  );
  assert.deepEqual(leaderboardTypes, [
    "rating",
    "mp",
    "dust",
    "slime",
    "gum",
    "metal",
    "ice",
  ]);
  assert.equal(
    requests.some(
      ({ authorized, method, url }) =>
        authorized &&
        method === "POST" &&
        (url.endsWith("/auth/intents") || url.endsWith("/auth/x/flows")),
    ),
    false,
  );
  assert.deepEqual(
    Array.from(
      new Set(
        requests
          .filter(({ authorized }) => authorized)
          .map(({ method, url }) => `${method} ${new URL(url).pathname}`),
      ),
    ).sort(),
    [
      "GET /auth/methods",
      "GET /events/prizes",
      "GET /events/snapshot",
      "POST /invites/role/read",
      "POST /leaderboards/read",
      "POST /navigation/games/read",
      "POST /profiles/lookup",
    ].sort(),
  );
  assert.equal(
    requests.some(({ url }) => url.includes("identitytoolkit.googleapis.com")),
    false,
  );
  for (const pathname of ["/events/snapshot", "/events/prizes"]) {
    assert.equal(
      requests.some(
        ({ method, url }) =>
          method === "OPTIONS" && new URL(url).pathname === pathname,
      ),
      true,
      pathname,
    );
  }
  const historyRequests = requests.filter(({ url }) =>
    url.includes("/matches/history?"),
  );
  assert.equal(historyRequests.length, 2);
  assert.equal(
    historyRequests.every(({ authorized }) => !authorized),
    true,
  );
  assert.deepEqual(logs, ["[api-smoke] Passed https://api.mons.link"]);

  for (const payload of [
    { ok: true, pair: null },
    {
      ok: true,
      pair: { ...HISTORICAL_MATCH_PAIR, matchId: "different-match" },
    },
    { ok: true, pair: HISTORICAL_MATCH_PAIR, extra: true },
  ]) {
    requests.length = 0;
    leaderboardTypes.length = 0;
    logs.length = 0;
    nftPosts = 0;
    requiredHistoricalPayload = payload;
    await assert.rejects(
      smokeApi(
        {
          baseUrl: "https://api.mons.link",
          readOnlyAuthToken: AUTH_TOKEN,
          readOnly: true,
          requireHistory: true,
          smokeProfile: SMOKE_PROFILE_WITH_HISTORY,
          smokeSol: WALLET,
        },
        {
          fetch: fetchStub,
          randomState: () => "abcdefghijklmnopqrstuvwx",
          log: (message) => logs.push(message),
        },
      ),
      /Required historical match smoke response was invalid/,
    );
  }
  requiredHistoricalPayload = { ok: true, pair: HISTORICAL_MATCH_PAIR };
  requiredHistoryCacheControl = "public, max-age=60";
  nftPosts = 0;
  await assert.rejects(
    smokeApi(
      {
        baseUrl: "https://api.mons.link",
        readOnlyAuthToken: AUTH_TOKEN,
        readOnly: true,
        requireHistory: true,
        smokeProfile: SMOKE_PROFILE_WITH_HISTORY,
        smokeSol: WALLET,
      },
      {
        fetch: fetchStub,
        randomState: () => "abcdefghijklmnopqrstuvwx",
        log: () => undefined,
      },
    ),
    /cacheable/,
  );
  requiredHistoryCacheControl = "no-store";
  requiredHistoricalStatus = 503;
  nftPosts = 0;
  await assert.rejects(
    smokeApi(
      {
        baseUrl: "https://api.mons.link",
        readOnlyAuthToken: AUTH_TOKEN,
        readOnly: true,
        requireHistory: true,
        smokeProfile: SMOKE_PROFILE_WITH_HISTORY,
        smokeSol: WALLET,
      },
      {
        fetch: fetchStub,
        randomState: () => "abcdefghijklmnopqrstuvwx",
        log: () => undefined,
      },
    ),
    /returned 503/,
  );
});

test("rejects event read CORS without the allowed origin", async () => {
  await assert.rejects(
    smokeEventReads(
      "https://api.mons.link",
      AUTH_TOKEN,
      SMOKE_PROFILE.profileId,
      undefined,
      {
        fetch: async () =>
          new Response(null, {
            status: 204,
            headers: {
              ...EVENT_READ_CORS_HEADERS,
              "Access-Control-Allow-Origin": "",
              "Cache-Control": "no-store",
            },
          }),
        randomState: () => "abcdefghijklmnopqrstuvwx",
        log: () => undefined,
      },
    ),
    /Event CORS smoke failed/,
  );
});

test("requires conditional event snapshots to return cache metadata", async () => {
  const eventId = "smoke-abcdefghijklmnopqrstuvwx";
  const responses = [
    new Response(null, {
      status: 204,
      headers: { ...EVENT_READ_CORS_HEADERS, "Cache-Control": "no-store" },
    }),
    new Response(null, {
      status: 204,
      headers: { ...EVENT_READ_CORS_HEADERS, "Cache-Control": "no-store" },
    }),
    json(
      {
        ok: true,
        eventId,
        revision: 0,
        event: null,
        prizeSelections: {},
      },
      200,
      {
        ...EVENT_READ_CORS_HEADERS,
        ETag: 'W/"event"',
        "X-D1-Bookmark": "bookmark",
      },
    ),
    new Response(null, {
      status: 304,
      headers: { ...EVENT_READ_CORS_HEADERS, "Cache-Control": "no-store" },
    }),
  ];

  await assert.rejects(
    smokeEventReads(
      "https://api.mons.link",
      AUTH_TOKEN,
      SMOKE_PROFILE.profileId,
      undefined,
      {
        fetch: async () => {
          const response = responses.shift();
          assert.ok(response);
          return response;
        },
        randomState: () => "abcdefghijklmnopqrstuvwx",
        log: () => undefined,
      },
    ),
    /Event snapshot smoke response was invalid/,
  );
  assert.equal(responses.length, 0);
});

test("allows live prize changes but requires a stable cutover prize read", async () => {
  const headers = {
    ...EVENT_READ_CORS_HEADERS,
    ETag: 'W/"event"',
    "X-D1-Bookmark": "bookmark",
  };
  const createFetch = (): typeof fetch => async (input, init) => {
    const url = String(input);
    if (init?.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...EVENT_READ_CORS_HEADERS, "Cache-Control": "no-store" },
      });
    }
    if (url.includes("/events/snapshot?")) {
      if (new Headers(init?.headers).has("If-None-Match")) {
        return new Response(null, {
          status: 304,
          headers: { ...headers, "Cache-Control": "no-store" },
        });
      }
      const eventId = new URL(url).searchParams.get("eventId");
      return json(
        {
          ok: true,
          eventId,
          revision: 0,
          event: null,
          prizeSelections: {},
        },
        200,
        headers,
      );
    }
    return json(
      {
        ok: true,
        profileId: SMOKE_PROFILE.profileId,
        revision: 1,
        prizes: {
          [SMOKE_EVENTS.endedId]: {
            eventId: SMOKE_EVENTS.endedId,
            profileId: SMOKE_PROFILE.profileId,
            place: 1,
            prizeId: SMOKE_EVENTS.assignedPrizeId,
            assignedAtMs: 1,
          },
        },
      },
      200,
      headers,
    );
  };
  const dependencies = (fetch: typeof globalThis.fetch) => ({
    fetch,
    randomState: () => "abcdefghijklmnopqrstuvwx",
    log: () => undefined,
  });

  await smokeEventReads(
    "https://api.mons.link",
    AUTH_TOKEN,
    SMOKE_PROFILE.profileId,
    undefined,
    dependencies(createFetch()),
  );
  await assert.rejects(
    smokeEventReads(
      "https://api.mons.link",
      AUTH_TOKEN,
      SMOKE_PROFILE.profileId,
      SMOKE_EVENTS,
      dependencies(createFetch()),
    ),
    /returned 200/,
  );
});

test("verifies an ended selection while still requiring a current snapshot", async () => {
  const events = {
    ...SMOKE_EVENTS,
    currentId: "active-event-without-prizes",
    selectionEventId: SMOKE_EVENTS.endedId,
    selectionPrizeId: SMOKE_EVENTS.assignedPrizeId,
  };
  const assignment = {
    eventId: events.endedId,
    profileId: SMOKE_PROFILE.profileId,
    place: 1,
    prizeId: events.assignedPrizeId,
    assignedAtMs: 1,
  };
  const headers = {
    ...EVENT_READ_CORS_HEADERS,
    ETag: 'W/"event"',
    "X-D1-Bookmark": "bookmark",
    "Cache-Control": "no-store",
  };
  for (const scenario of [
    {
      selection: events.selectionPrizeId,
      currentStatus: "active",
      valid: true,
    },
    { selection: "wrong-prize", currentStatus: "active", valid: false },
    { selection: null, currentStatus: "active", valid: false },
    {
      selection: events.selectionPrizeId,
      currentStatus: "ended",
      valid: false,
    },
  ]) {
    const requestedEvents: string[] = [];
    const smoke = smokeEventReads(
      "https://api.mons.link",
      AUTH_TOKEN,
      SMOKE_PROFILE.profileId,
      events,
      {
        fetch: async (input, init) => {
          if (init?.method === "OPTIONS") {
            return new Response(null, { status: 204, headers });
          }
          if (new Headers(init?.headers).has("If-None-Match")) {
            return new Response(null, { status: 304, headers });
          }
          const url = new URL(String(input));
          if (url.pathname === "/events/prizes") {
            return json(
              {
                ok: true,
                profileId: SMOKE_PROFILE.profileId,
                revision: 1,
                prizes: { [events.endedId]: assignment },
              },
              200,
              headers,
            );
          }
          const eventId = url.searchParams.get("eventId") || "";
          requestedEvents.push(eventId);
          const event =
            eventId === events.currentId
              ? { eventId, status: scenario.currentStatus }
              : eventId === events.endedId
                ? {
                    eventId,
                    status: "ended",
                    prizeAssignments: { 1: assignment },
                  }
                : null;
          return json(
            {
              ok: true,
              eventId,
              revision: event ? 1 : 0,
              event,
              prizeSelections:
                eventId === events.selectionEventId && scenario.selection
                  ? { [SMOKE_PROFILE.profileId]: scenario.selection }
                  : {},
            },
            200,
            headers,
          );
        },
        randomState: () => "abcdefghijklmnopqrstuvwx",
        log: () => undefined,
      },
    );
    if (scenario.valid) {
      await smoke;
      assert.deepEqual(requestedEvents.slice(-2), [
        events.currentId,
        events.endedId,
      ]);
    } else {
      await assert.rejects(
        smoke,
        /Required event snapshot smoke response was invalid/,
      );
    }
  }
});

test("requires the ended event aggregate to contain the profile prize", async () => {
  const eventHeaders = {
    ...EVENT_READ_CORS_HEADERS,
    ETag: 'W/"event"',
    "X-D1-Bookmark": "bookmark",
  };
  const missingEventId = "smoke-abcdefghijklmnopqrstuvwx";
  const responses = [
    new Response(null, {
      status: 204,
      headers: { ...EVENT_READ_CORS_HEADERS, "Cache-Control": "no-store" },
    }),
    new Response(null, {
      status: 204,
      headers: { ...EVENT_READ_CORS_HEADERS, "Cache-Control": "no-store" },
    }),
    json(
      {
        ok: true,
        eventId: missingEventId,
        revision: 0,
        event: null,
        prizeSelections: {},
      },
      200,
      eventHeaders,
    ),
    new Response(null, {
      status: 304,
      headers: { ...eventHeaders, "Cache-Control": "no-store" },
    }),
    json(
      {
        ok: true,
        profileId: SMOKE_PROFILE.profileId,
        revision: 1,
        prizes: {
          [SMOKE_EVENTS.endedId]: {
            eventId: SMOKE_EVENTS.endedId,
            profileId: SMOKE_PROFILE.profileId,
            place: 1,
            prizeId: SMOKE_EVENTS.assignedPrizeId,
            assignedAtMs: 1,
          },
        },
      },
      200,
      eventHeaders,
    ),
    new Response(null, {
      status: 304,
      headers: { ...eventHeaders, "Cache-Control": "no-store" },
    }),
    json(
      {
        ok: true,
        eventId: SMOKE_EVENTS.currentId,
        revision: 1,
        event: { eventId: SMOKE_EVENTS.currentId, status: "active" },
        prizeSelections: {
          [SMOKE_PROFILE.profileId]: SMOKE_EVENTS.selectionPrizeId,
        },
      },
      200,
      eventHeaders,
    ),
    json(
      {
        ok: true,
        eventId: SMOKE_EVENTS.endedId,
        revision: 1,
        event: { eventId: SMOKE_EVENTS.endedId, status: "ended" },
        prizeSelections: {},
      },
      200,
      eventHeaders,
    ),
  ];

  await assert.rejects(
    smokeEventReads(
      "https://api.mons.link",
      AUTH_TOKEN,
      SMOKE_PROFILE.profileId,
      SMOKE_EVENTS,
      {
        fetch: async () => {
          const response = responses.shift();
          assert.ok(response);
          return response;
        },
        randomState: () => "abcdefghijklmnopqrstuvwx",
        log: () => undefined,
      },
    ),
    /Required event snapshot smoke response was invalid/,
  );
  assert.equal(responses.length, 0);
});

test("probes frozen profile writes with an authenticated mutation-safe body", async () => {
  let requests = 0;
  await smokeFrozenProfileWrite("https://api.mons.link", AUTH_TOKEN, {
    fetch: async (input, init) => {
      requests++;
      assert.equal(String(input), "https://api.mons.link/profiles/username");
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("Authorization"), `Bearer ${AUTH_TOKEN}`);
      assert.equal(headers.get("Origin"), "https://mons.link");
      assert.equal(headers.get("Content-Type"), "application/json");
      assert.equal(init?.body, "{}");
      return json(
        {
          ok: false,
          error: "unavailable",
          message: "profile-writes-disabled",
        },
        503,
        { "Retry-After": "60" },
      );
    },
    randomState: () => "unused",
    log: () => undefined,
  });
  assert.equal(requests, 1);
});

test("rejects malformed frozen profile write bodies", async () => {
  for (const body of [
    "{",
    JSON.stringify({
      ok: false,
      error: "unavailable",
      message: "profile-writes-disabled",
      details: "unexpected",
    }),
  ]) {
    await assert.rejects(
      smokeFrozenProfileWrite("https://api.mons.link", AUTH_TOKEN, {
        fetch: async () =>
          new Response(body, {
            status: 503,
            headers: { "Cache-Control": "no-store", "Retry-After": "60" },
          }),
        randomState: () => "unused",
        log: () => undefined,
      }),
      /Profile freeze smoke response was invalid/,
    );
  }
});

test("requires the exact frozen profile write retry delay", async () => {
  for (const retryAfter of [null, "59"]) {
    await assert.rejects(
      smokeFrozenProfileWrite("https://api.mons.link", AUTH_TOKEN, {
        fetch: async () =>
          json(
            {
              ok: false,
              error: "unavailable",
              message: "profile-writes-disabled",
            },
            503,
            retryAfter === null ? {} : { "Retry-After": retryAfter },
          ),
        randomState: () => "unused",
        log: () => undefined,
      }),
      /Profile freeze smoke response was invalid/,
    );
  }
});

test("fails on a malformed or cacheable response", async () => {
  const base = {
    baseUrl: "https://api.mons.link",
    requireHistory: false,
    smokeProfile: SMOKE_PROFILE,
    smokeSol: WALLET,
  };
  await assert.rejects(
    smokeApi(base, {
      fetch: async () => new Response(null, { status: 204 }),
      randomState: () => "abcdefghijklmnopqrstuvwx",
      log: () => undefined,
    }),
    /cacheable/,
  );
});

test("fails before requests when read-only auth is missing", async () => {
  let requests = 0;
  await assert.rejects(
    smokeApi(
      {
        baseUrl: "https://api.mons.link",
        readOnly: true,
        requireHistory: false,
        smokeProfile: SMOKE_PROFILE,
        smokeSol: WALLET,
      },
      {
        fetch: async () => {
          requests++;
          throw new Error("unexpected-request");
        },
        randomState: () => "abcdefghijklmnopqrstuvwx",
        log: () => undefined,
      },
    ),
    /existing auth token fixture/,
  );
  await assert.rejects(
    smokeApi(
      {
        baseUrl: "https://api.mons.link",
        readOnly: true,
        readOnlyAuthToken: AUTH_TOKEN,
        requireHistory: true,
        smokeProfile: SMOKE_PROFILE,
        smokeSol: WALLET,
      },
      {
        fetch: async () => {
          requests++;
          throw new Error("unexpected-request");
        },
        randomState: () => "abcdefghijklmnopqrstuvwx",
        log: () => undefined,
      },
    ),
    /authenticated historical match fixture/,
  );
  assert.equal(requests, 0);
});

test("requires the read-only token to own the smoke profile", async () => {
  let identityRequests = 0;
  await assert.rejects(
    smokeAuthenticatedAuthState(
      "https://api.mons.link",
      SMOKE_PROFILE,
      {
        fetch: async (input) => {
          const url = String(input);
          if (url.includes("identitytoolkit.googleapis.com")) {
            identityRequests++;
            throw new Error("unexpected-identity-request");
          }
          if (url.endsWith("/auth/methods")) {
            return json(
              {
                ok: true,
                profileId: "different-profile",
                linkedMethods: {
                  apple: false,
                  eth: false,
                  sol: false,
                  x: false,
                },
                appleLinked: false,
              },
              200,
            );
          }
          throw new Error(`Unexpected request: ${url}`);
        },
        randomState: () => "abcdefghijklmnopqrstuvwx",
        log: () => undefined,
      },
      AUTH_TOKEN,
    ),
    /Auth ownership smoke response was invalid/,
  );
  assert.equal(identityRequests, 0);
});

test("rejects a read-only token for a different login before requests", async () => {
  const otherToken = `header.${Buffer.from(
    JSON.stringify({ sub: "different-login" }),
  ).toString("base64url")}.signature`;
  let requests = 0;
  await assert.rejects(
    smokeAuthenticatedAuthState(
      "https://api.mons.link",
      SMOKE_PROFILE,
      {
        fetch: async () => {
          requests++;
          throw new Error("unexpected-request");
        },
        randomState: () => "unused",
        log: () => undefined,
      },
      otherToken,
    ),
    /token subject did not match/,
  );
  assert.equal(requests, 0);
});

test("accepts an empty authenticated navigation projection", async () => {
  await smokeAuthenticatedAuthState(
    "https://api.mons.link",
    SMOKE_PROFILE,
    {
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/auth/methods")) {
          return json(
            {
              ok: true,
              profileId: SMOKE_PROFILE.profileId,
              linkedMethods: {
                apple: false,
                eth: false,
                sol: false,
                x: false,
              },
              appleLinked: false,
            },
            200,
          );
        }
        if (
          (url.includes("/events/snapshot?") ||
            url.endsWith("/events/prizes")) &&
          init?.method === "OPTIONS"
        ) {
          return new Response(null, {
            status: 204,
            headers: {
              ...EVENT_READ_CORS_HEADERS,
              "Cache-Control": "no-store",
            },
          });
        }
        if (url.includes("/events/snapshot?")) {
          if (new Headers(init?.headers).get("If-None-Match")) {
            return new Response(null, {
              status: 304,
              headers: {
                ...EVENT_READ_CORS_HEADERS,
                ETag: 'W/"event-snapshot"',
                "X-D1-Bookmark": "bookmark",
                "Cache-Control": "no-store",
              },
            });
          }
          return json(
            {
              ok: true,
              eventId: "smoke-unused",
              revision: 0,
              event: null,
              prizeSelections: {},
            },
            200,
            {
              ...EVENT_READ_CORS_HEADERS,
              ETag: 'W/"event-snapshot"',
              "X-D1-Bookmark": "bookmark",
            },
          );
        }
        if (url.endsWith("/events/prizes")) {
          if (new Headers(init?.headers).get("If-None-Match")) {
            return new Response(null, {
              status: 304,
              headers: {
                ...EVENT_READ_CORS_HEADERS,
                ETag: 'W/"profile-prizes"',
                "X-D1-Bookmark": "bookmark",
                "Cache-Control": "no-store",
              },
            });
          }
          return json(
            {
              ok: true,
              profileId: SMOKE_PROFILE.profileId,
              revision: 0,
              prizes: {},
            },
            200,
            {
              ...EVENT_READ_CORS_HEADERS,
              ETag: 'W/"profile-prizes"',
              "X-D1-Bookmark": "bookmark",
            },
          );
        }
        if (url.endsWith("/leaderboards/read")) {
          return json({ ok: true, profiles: [PROFILE] }, 200);
        }
        if (url.endsWith("/profiles/lookup")) {
          return json({ ok: true, profile: PROFILE }, 200);
        }
        if (url.endsWith("/navigation/games/read")) {
          return json(
            { ok: true, items: [], nextCursor: null, hasMore: false },
            200,
          );
        }
        if (url.endsWith("/invites/role/read")) {
          return json(
            {
              ok: true,
              inviteId: SMOKE_PROFILE.invite.id,
              hostId: SMOKE_PROFILE.invite.actorUid,
              guestId: null,
              actorUid: SMOKE_PROFILE.invite.actorUid,
              role: SMOKE_PROFILE.invite.role,
            },
            200,
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      },
      randomState: () => "unused",
      log: () => undefined,
    },
    AUTH_TOKEN,
  );
});

test("deletes an anonymous smoke user after an incomplete signup response", async () => {
  let deleted = false;
  await assert.rejects(
    smokeAuthenticatedAuthState("https://api.mons.link", SMOKE_PROFILE, {
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("accounts:signUp")) {
          return json({ idToken: "firebase-id-token" }, 200);
        }
        if (url.includes("accounts:delete")) {
          deleted = true;
          return json({}, 200);
        }
        throw new Error(`Unexpected request: ${url}`);
      },
      randomState: () => "abcdefghijklmnopqrstuvwx",
      log: () => undefined,
    }),
    /incomplete/,
  );
  assert.equal(deleted, true);
});
