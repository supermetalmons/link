import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  GameplayApiError,
  RATING_API_TIMEOUT_MS,
  RATING_BUSY_RETRY_DELAY_MS,
  acceptWagerProposalViaApi,
  cancelAutomatchViaApi,
  cancelWagerProposalViaApi,
  claimMatchVictoryByTimerViaApi,
  createInviteViaApi,
  createEventViaApi,
  declineWagerProposalViaApi,
  disqualifyEventMatchWinnersViaApi,
  endRematchViaApi,
  ensureMatchViaApi,
  joinEventViaApi,
  joinInviteViaApi,
  removeEventParticipantViaApi,
  removeNavigationGameViaApi,
  readNavigationGamesViaApi,
  readHistoricalMatchPairViaApi,
  readInviteRoleViaApi,
  resolveWagerOutcomeViaApi,
  sendWagerProposalViaApi,
  startAutomatchViaApi,
  startMatchTimerViaApi,
  syncEventStateViaApi,
  toggleEventPrizeSelectionViaApi,
  updateRatingsViaApi,
  postponeEventStartViaApi,
  proposeRematchViaApi,
} = await import("../src/services/gameplayApi.ts");
const { createUserBoundAuthTokenProvider } =
  await import("../src/services/authApi.ts");
const {
  MAX_GAME_SESSION_RESPONSE_BYTES,
  MAX_GAME_SESSION_STATUS_BYTES,
  MAX_GAME_SESSION_TIMER_BYTES,
  isCreateInviteRequest,
  isCreateInviteResponse,
  isEndRematchRequest,
  isEndRematchResponse,
  isEnsureMatchRequest,
  isEnsureMatchResponse,
  isJoinInviteRequest,
  isJoinInviteResponse,
  isProposeRematchRequest,
  isProposeRematchResponse,
  isResolveInviteRoleRequest,
  isResolveInviteRoleResponse,
} = await import("@mons/shared/game-sessions");
const { MAX_MATCH_FEN_BYTES, MAX_MATCH_HISTORY_BYTES } =
  await import("@mons/shared/match-protocol");
const { isRatingUpdateRequest, isRatingUpdateResponse } =
  await import("@mons/shared/ratings");
const {
  isCancelAutomatchResponse,
  isRemoveNavigationGameRequest,
  isRemoveNavigationGameResponse,
  isReadNavigationGamesRequest,
  isReadNavigationGamesResponse,
  isStartAutomatchRequest,
  isStartAutomatchResponse,
} = await import("@mons/shared/navigation");
const {
  isClaimMatchVictoryByTimerRequest,
  isClaimMatchVictoryByTimerResponse,
  isStartMatchTimerRequest,
  isStartMatchTimerResponse,
} = await import("@mons/shared/timers");
const {
  isWagerOutcomeResolveResponse,
  isWagerProposalAcceptResponse,
  isWagerProposalSendRequest,
  isWagerProposalSendResponse,
} = await import("@mons/shared/wagers");
const {
  MAX_EVENT_PARTICIPANT_TEXT_BYTES,
  isCreateEventRequest,
  isCreateEventResponse,
  isDisqualifyEventMatchWinnersRequest,
  isDisqualifyEventMatchWinnersResponse,
  isEventParticipantSnapshot,
  isJoinEventRequest,
  isJoinEventResponse,
  isRemoveEventParticipantRequest,
  isRemoveEventParticipantResponse,
  isPostponeEventStartRequest,
  isPostponeEventStartResponse,
  isSyncEventStateRequest,
  isSyncEventStateResponse,
} = await import("@mons/shared/events");
const {
  LEGACY_CORE_PRIZES_EVENT_ID,
  isToggleEventPrizeSelectionRequest,
  isToggleEventPrizeSelectionResponse,
} = await import("@mons/shared/event-prizes");

const originalFetch = globalThis.fetch;

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("reads public historical matches without an auth token", async () => {
  const calls = [];
  const match = {
    version: 2,
    color: "white",
    emojiId: 1,
    aura: "",
    gameVariant: "Classic",
    fen: "fen",
    status: "surrendered",
    flatMovesString: "move",
    timer: "",
  };
  const pair = {
    matchId: "abcdefghijk",
    hostPlayerId: "host",
    guestPlayerId: "guest",
    hostMatch: match,
    guestMatch: { ...match, color: "black", emojiId: 2 },
  };
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse({ ok: true, pair });
  };
  assert.deepEqual(
    await readHistoricalMatchPairViaApi({
      inviteId: "abcdefghijk",
      matchId: "abcdefghijk",
    }),
    { ok: true, pair },
  );
  assert.equal(
    calls[0].input,
    "https://api.mons.link/matches/history?inviteId=abcdefghijk&matchId=abcdefghijk",
  );
  assert.equal(calls[0].init.method, "GET");
  assert.equal(new Headers(calls[0].init.headers).has("Authorization"), false);
});

test("sends exact authenticated event-control mutations", async () => {
  const calls = [];
  const event = { eventId: "event-1", status: "scheduled", startAtMs: 600_000 };
  const responses = [
    { ok: true, eventId: "event-1", event },
    {
      ok: true,
      eventId: "event-1",
      event: { ...event, startAtMs: 900_000 },
      postponeByMinutes: 5,
      startAtMs: 900_000,
    },
    {
      ok: true,
      eventId: "event-1",
      didChange: false,
      event,
      didDisqualify: true,
      matchKey: "0_0",
    },
    { ok: true, eventId: "event-1", didChange: false, event },
  ];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse(responses.shift());
  };
  const tokenProvider = async () => "firebase-token";
  assert.deepEqual(
    await createEventViaApi(
      { startsInMinutes: 5, announceOnTelegram: true },
      tokenProvider,
    ),
    { ok: true, eventId: "event-1", event },
  );
  assert.deepEqual(
    await postponeEventStartViaApi(
      { eventId: "event-1", postponeByMinutes: 5 },
      tokenProvider,
    ),
    {
      ok: true,
      eventId: "event-1",
      event: { ...event, startAtMs: 900_000 },
      postponeByMinutes: 5,
      startAtMs: 900_000,
    },
  );
  assert.equal(
    (
      await disqualifyEventMatchWinnersViaApi(
        { eventId: "event-1", matchKey: "0_0" },
        tokenProvider,
      )
    ).didDisqualify,
    true,
  );
  assert.deepEqual(
    await syncEventStateViaApi({ eventId: "event-1" }, tokenProvider),
    { ok: true, eventId: "event-1", didChange: false, event },
  );
  assert.deepEqual(
    calls.map((call) => call.input),
    [
      "https://api.mons.link/events/create",
      "https://api.mons.link/events/start/postpone",
      "https://api.mons.link/events/matches/winners/disqualify",
      "https://api.mons.link/events/state/sync",
    ],
  );
  assert.equal(
    calls.every(
      (call) =>
        new Headers(call.init.headers).get("Authorization") ===
        "Bearer firebase-token",
    ),
    true,
  );
  assert.equal(isCreateEventRequest({ startsInMinutes: 5 }), true);
  assert.equal(isCreateEventRequest({ startsInMinutes: 0 }), false);
  assert.equal(
    isCreateEventResponse({ ok: true, eventId: "event-1", event }),
    true,
  );
  assert.equal(
    isPostponeEventStartRequest({ eventId: "event-1", postponeByMinutes: 5 }),
    true,
  );
  assert.equal(
    isPostponeEventStartResponse({
      ok: true,
      eventId: "event-1",
      event,
      postponeByMinutes: 5,
      startAtMs: 900_000,
    }),
    true,
  );
  assert.equal(
    isDisqualifyEventMatchWinnersRequest({
      eventId: "event-1",
      matchKey: "0_0",
    }),
    true,
  );
  assert.equal(
    isDisqualifyEventMatchWinnersResponse({
      ok: true,
      eventId: "event-1",
      didChange: false,
      event,
      didDisqualify: true,
      matchKey: "0_0",
    }),
    true,
  );
  assert.equal(isSyncEventStateRequest({ eventId: "event-1" }), true);
  assert.equal(
    isSyncEventStateResponse({
      ok: true,
      eventId: "event-1",
      skipped: true,
      reason: "locked",
    }),
    true,
  );
});

test("sends the exact event prize selection mutation", async () => {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse({
      ok: true,
      eventId: LEGACY_CORE_PRIZES_EVENT_ID,
      selectedPrizeId: "1092",
    });
  };
  const request = {
    eventId: LEGACY_CORE_PRIZES_EVENT_ID,
    prizeId: "1092",
  };
  assert.deepEqual(
    await toggleEventPrizeSelectionViaApi(
      request,
      async () => "firebase-token",
    ),
    {
      ok: true,
      eventId: LEGACY_CORE_PRIZES_EVENT_ID,
      selectedPrizeId: "1092",
    },
  );
  assert.equal(
    calls[0].input,
    "https://api.mons.link/events/prize-selections/toggle",
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), request);
  assert.equal(
    new Headers(calls[0].init.headers).get("Authorization"),
    "Bearer firebase-token",
  );
  assert.equal(isToggleEventPrizeSelectionRequest(request), true);
  assert.equal(
    isToggleEventPrizeSelectionRequest({ ...request, prizeId: "invalid" }),
    false,
  );
  assert.equal(
    isToggleEventPrizeSelectionResponse({
      ok: true,
      eventId: LEGACY_CORE_PRIZES_EVENT_ID,
      selectedPrizeId: null,
    }),
    true,
  );
  assert.equal(
    isToggleEventPrizeSelectionResponse({
      ok: true,
      eventId: LEGACY_CORE_PRIZES_EVENT_ID,
      selectedPrizeId: "1682",
    }),
    false,
  );
});

test("reads the exact authenticated authoritative invite role", async () => {
  const calls = [];
  const response = {
    ok: true,
    inviteId: "abcdefghijk",
    hostId: "host-login",
    guestId: "guest-login",
    actorUid: "guest-login",
    role: "guest",
  };
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse(response);
  };

  assert.deepEqual(
    await readInviteRoleViaApi(
      { inviteId: "abcdefghijk" },
      async () => "firebase-token",
    ),
    response,
  );
  assert.equal(calls[0].input, "https://api.mons.link/invites/role/read");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    inviteId: "abcdefghijk",
  });
  assert.equal(
    new Headers(calls[0].init.headers).get("Authorization"),
    "Bearer firebase-token",
  );
  assert.equal(isResolveInviteRoleRequest({ inviteId: "abcdefghijk" }), true);
  assert.equal(
    isResolveInviteRoleRequest({ inviteId: "abcdefghijk", extra: true }),
    false,
  );
  assert.equal(isResolveInviteRoleResponse(response), true);
  assert.equal(
    isResolveInviteRoleResponse({ ...response, role: "watch" }),
    false,
  );
  assert.equal(
    isResolveInviteRoleResponse({
      ...response,
      role: "watch",
      actorUid: null,
    }),
    true,
  );
});

test("retries one transient authoritative invite role failure", async () => {
  let calls = 0;
  const response = {
    ok: true,
    inviteId: "abcdefghijk",
    hostId: "host-login",
    guestId: null,
    actorUid: "host-login",
    role: "host",
  };
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse(
          {
            ok: false,
            error: "unavailable",
            message: "profile-ownership-unavailable",
          },
          503,
        )
      : jsonResponse(response);
  };

  assert.deepEqual(
    await readInviteRoleViaApi(
      { inviteId: "abcdefghijk" },
      async () => "firebase-token",
    ),
    response,
  );
  assert.equal(calls, 2);
});

test("rejects an invite role response after authentication changes", async () => {
  const firstUser = {
    uid: "first-user",
    getIdToken: async () => "first-token",
  };
  const secondUser = {
    uid: "second-user",
    getIdToken: async () => "second-token",
  };
  let currentUser = firstUser;
  globalThis.fetch = async () => {
    currentUser = secondUser;
    return jsonResponse({
      ok: true,
      inviteId: "abcdefghijk",
      hostId: "host-login",
      guestId: null,
      actorUid: null,
      role: "watch",
    });
  };

  await assert.rejects(
    readInviteRoleViaApi(
      { inviteId: "abcdefghijk" },
      createUserBoundAuthTokenProvider(firstUser, () => currentUser),
    ),
    /authentication-changed/,
  );
});

test("sends exact structural game-session mutations with stable operation IDs", async () => {
  const calls = [];
  const operationIds = [1, 2, 3, 4, 5].map(
    (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  const match = {
    version: 2,
    color: "white",
    emojiId: 7,
    aura: "rainbow",
    gameVariant: "Classic",
    fen: "fen",
    status: "",
    flatMovesString: "",
    timer: "",
  };
  const responses = [
    {
      ok: true,
      inviteId: "abcdefghijk",
      hostId: "host",
      matchId: "abcdefghijk",
    },
    {
      ok: true,
      inviteId: "abcdefghijk",
      guestId: "guest",
      joined: true,
      matchId: "abcdefghijk",
    },
    {
      ok: true,
      inviteId: "abcdefghijk",
      actorUid: "host",
      matchId: "abcdefghijk1",
      rematches: "1",
      match,
    },
    {
      ok: true,
      inviteId: "abcdefghijk",
      actorUid: "host",
      rematches: "1x",
    },
    {
      ok: true,
      inviteId: "abcdefghijk",
      actorUid: "guest",
      matchId: "abcdefghijk1",
      created: true,
      match,
    },
  ];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse(responses.shift());
  };
  const tokenProvider = async () => "firebase-token";
  const presentation = { emojiId: 7, aura: "rainbow" };
  const createRequest = {
    operationId: operationIds[0],
    inviteId: "abcdefghijk",
    ...presentation,
  };
  const joinRequest = { ...createRequest, operationId: operationIds[1] };
  const proposeRequest = { ...createRequest, operationId: operationIds[2] };
  const endRequest = {
    operationId: operationIds[3],
    inviteId: "abcdefghijk",
  };
  const ensureRequest = {
    ...createRequest,
    operationId: operationIds[4],
    matchId: "abcdefghijk1",
  };
  assert.equal(
    (await createInviteViaApi(createRequest, tokenProvider)).hostId,
    "host",
  );
  assert.equal(
    (await joinInviteViaApi(joinRequest, tokenProvider)).joined,
    true,
  );
  assert.equal(
    (await proposeRematchViaApi(proposeRequest, tokenProvider)).matchId,
    "abcdefghijk1",
  );
  assert.equal(
    (await endRematchViaApi(endRequest, tokenProvider)).rematches,
    "1x",
  );
  assert.equal(
    (await ensureMatchViaApi(ensureRequest, tokenProvider)).created,
    true,
  );
  assert.deepEqual(
    calls.map(({ input }) => input),
    [
      "https://api.mons.link/invites/create",
      "https://api.mons.link/invites/join",
      "https://api.mons.link/rematches/propose",
      "https://api.mons.link/rematches/end",
      "https://api.mons.link/matches/ensure",
    ],
  );
  assert.deepEqual(
    calls.map(({ init }) => JSON.parse(init.body)),
    [createRequest, joinRequest, proposeRequest, endRequest, ensureRequest],
  );
  for (const [validator, value] of [
    [isCreateInviteRequest, createRequest],
    [isJoinInviteRequest, joinRequest],
    [isProposeRematchRequest, proposeRequest],
    [isEndRematchRequest, endRequest],
    [isEnsureMatchRequest, ensureRequest],
    [
      isCreateInviteResponse,
      {
        ok: true,
        inviteId: "abcdefghijk",
        hostId: "host",
        matchId: "abcdefghijk",
      },
    ],
    [
      isJoinInviteResponse,
      {
        ok: true,
        inviteId: "abcdefghijk",
        guestId: "guest",
        joined: true,
        matchId: "abcdefghijk",
      },
    ],
    [
      isProposeRematchResponse,
      {
        ok: true,
        inviteId: "abcdefghijk",
        actorUid: "host",
        matchId: "abcdefghijk1",
        rematches: "1",
        match,
      },
    ],
    [
      isEndRematchResponse,
      {
        ok: true,
        inviteId: "abcdefghijk",
        actorUid: "host",
        rematches: "x",
      },
    ],
    [
      isEnsureMatchResponse,
      {
        ok: true,
        inviteId: "abcdefghijk",
        actorUid: "guest",
        matchId: "abcdefghijk1",
        created: true,
        match,
      },
    ],
  ]) {
    assert.equal(validator(value), true);
  }
  assert.equal(isCreateInviteRequest({ ...createRequest, extra: true }), false);
  assert.equal(isCreateInviteRequest({ ...createRequest, aura: null }), false);
  assert.equal(isJoinInviteRequest({ ...joinRequest, aura: null }), false);
  assert.equal(
    isProposeRematchRequest({ ...proposeRequest, aura: null }),
    false,
  );
  assert.equal(isEnsureMatchRequest({ ...ensureRequest, aura: null }), false);
});

test("accepts the largest valid ensured match response", async () => {
  const match = {
    version: 2,
    color: "white",
    emojiId: 1,
    aura: "",
    gameVariant: "Classic",
    fen: "\u0000".repeat(MAX_MATCH_FEN_BYTES),
    status: "\u0000".repeat(MAX_GAME_SESSION_STATUS_BYTES),
    flatMovesString: "\u0000".repeat(MAX_MATCH_HISTORY_BYTES),
    timer: "\u0000".repeat(MAX_GAME_SESSION_TIMER_BYTES),
  };
  const response = {
    ok: true,
    inviteId: "abcdefghijk",
    actorUid: "host",
    matchId: "abcdefghijk1",
    created: true,
    match,
  };
  const responseBytes = new TextEncoder().encode(JSON.stringify(response));
  assert.ok(responseBytes.byteLength > 128 * 1024);
  assert.ok(responseBytes.byteLength < MAX_GAME_SESSION_RESPONSE_BYTES);
  assert.equal(
    isEnsureMatchResponse({
      ...response,
      match: {
        ...match,
        status: "s".repeat(MAX_GAME_SESSION_STATUS_BYTES + 1),
      },
    }),
    false,
  );
  globalThis.fetch = async () => jsonResponse(response);
  assert.equal(
    (
      await ensureMatchViaApi(
        {
          operationId: "00000000-0000-4000-8000-000000000005",
          inviteId: "abcdefghijk",
          matchId: "abcdefghijk1",
          emojiId: 1,
          aura: "",
        },
        async () => "firebase-token",
      )
    ).match.flatMovesString.length,
    MAX_MATCH_HISTORY_BYTES,
  );
});

test("retries busy and ambiguous failures with the same operation ID", async () => {
  const bodies = [];
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    bodies.push(JSON.parse(init.body));
    return calls === 1
      ? jsonResponse({ error: "aborted", message: "invite-busy" }, 409)
      : calls === 2
        ? jsonResponse(
            { error: "unavailable", message: "gameplay-service-unavailable" },
            503,
          )
        : jsonResponse({
            ok: true,
            inviteId: "abcdefghijk",
            hostId: "host",
            matchId: "abcdefghijk",
          });
  };
  const request = {
    operationId: "00000000-0000-4000-8000-000000000001",
    inviteId: "abcdefghijk",
    emojiId: 7,
    aura: "rainbow",
  };
  await createInviteViaApi(request, async () => "firebase-token");
  assert.equal(calls, 3);
  assert.deepEqual(bodies, [request, request, request]);
});

test("bounds structural retries to one request deadline", async (t) => {
  let calls = 0;
  let nowCalls = 0;
  t.mock.method(Date, "now", () => (nowCalls++ < 2 ? 0 : 30_000));
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(
      { error: "unavailable", message: "gameplay-service-unavailable" },
      503,
    );
  };
  await assert.rejects(
    createInviteViaApi(
      {
        operationId: "00000000-0000-4000-8000-000000000001",
        inviteId: "abcdefghijk",
        emojiId: 7,
        aura: "rainbow",
      },
      async () => "firebase-token",
    ),
    (error) =>
      error instanceof GameplayApiError &&
      error.message === "Gameplay request timed out.",
  );
  assert.equal(calls, 1);
});

test("stops a structural retry after the authenticated user changes", async () => {
  let fetches = 0;
  const firstUser = {
    uid: "first-user",
    getIdToken: async () => "first-token",
  };
  const secondUser = {
    uid: "second-user",
    getIdToken: async () => "second-token",
  };
  let currentUser = firstUser;
  const tokenProvider = createUserBoundAuthTokenProvider(
    firstUser,
    () => currentUser,
  );
  globalThis.fetch = async () => {
    fetches += 1;
    currentUser = secondUser;
    return jsonResponse({ error: "aborted", message: "invite-busy" }, 409);
  };
  await assert.rejects(
    createInviteViaApi(
      {
        operationId: "00000000-0000-4000-8000-000000000001",
        inviteId: "abcdefghijk",
        emojiId: 7,
        aura: "rainbow",
      },
      tokenProvider,
    ),
    /authentication-changed/,
  );
  assert.equal(fetches, 1);
});

test("does not send a structural mutation after authentication changes", async () => {
  let resolveToken;
  const token = new Promise((resolve) => {
    resolveToken = resolve;
  });
  const firstUser = {
    uid: "first-user",
    getIdToken: () => token,
  };
  const secondUser = {
    uid: "second-user",
    getIdToken: async () => "second-token",
  };
  let currentUser = firstUser;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return jsonResponse({
      ok: true,
      inviteId: "abcdefghijk",
      hostId: firstUser.uid,
      matchId: "abcdefghijk",
    });
  };
  const request = createInviteViaApi(
    {
      operationId: "00000000-0000-4000-8000-000000000001",
      inviteId: "abcdefghijk",
      emojiId: 7,
      aura: "rainbow",
    },
    createUserBoundAuthTokenProvider(firstUser, () => currentUser),
  );
  resolveToken("first-token");
  queueMicrotask(() => {
    currentUser = secondUser;
  });
  await assert.rejects(request, /authentication-changed/);
  assert.equal(fetches, 0);
});

test("does not return a structural mutation after authentication changes", async () => {
  let resolveResponse;
  const response = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const firstUser = {
    uid: "first-user",
    getIdToken: async () => "first-token",
  };
  const secondUser = {
    uid: "second-user",
    getIdToken: async () => "second-token",
  };
  let currentUser = firstUser;
  globalThis.fetch = async () => {
    requestStarted();
    return response;
  };
  const request = createInviteViaApi(
    {
      operationId: "00000000-0000-4000-8000-000000000001",
      inviteId: "abcdefghijk",
      emojiId: 7,
      aura: "rainbow",
    },
    createUserBoundAuthTokenProvider(firstUser, () => currentUser),
  );
  await started;
  currentUser = secondUser;
  resolveResponse(
    jsonResponse({
      ok: true,
      inviteId: "abcdefghijk",
      hostId: firstUser.uid,
      matchId: "abcdefghijk",
    }),
  );
  await assert.rejects(request, /authentication-changed/);
});

test("sends the exact rating mutation with strict contracts", async () => {
  const calls = [];
  const delays = [];
  let now = 1_000;
  const responses = [{ ok: true, skipped: true }, { ok: true }];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse(responses.shift());
  };
  const request = {
    playerId: "player",
    opponentId: "opponent",
    inviteId: "auto_aaaaaaaaaaa",
    matchId: "auto_aaaaaaaaaaa",
  };
  assert.deepEqual(
    await updateRatingsViaApi(request, async () => "firebase-token", {
      now: () => now,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
    }),
    { ok: true },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input, "https://api.mons.link/ratings/update");
  assert.deepEqual(JSON.parse(calls[0].init.body), request);
  assert.equal(
    new Headers(calls[0].init.headers).get("Authorization"),
    "Bearer firebase-token",
  );
  assert.equal(RATING_API_TIMEOUT_MS, 60_000);
  assert.equal(RATING_BUSY_RETRY_DELAY_MS, 31_000);
  assert.deepEqual(delays, [31_000]);
  assert.equal(isRatingUpdateRequest(request), true);
  assert.equal(isRatingUpdateRequest({ ...request, extra: true }), false);
  assert.equal(isRatingUpdateResponse({ ok: true }), true);
  assert.equal(isRatingUpdateResponse({ ok: true, skipped: true }), true);
  assert.equal(isRatingUpdateResponse({ ok: false }), true);
  assert.equal(isRatingUpdateResponse({ ok: true, skipped: false }), false);
  assert.equal(isRatingUpdateResponse({ ok: true, extra: true }), false);
});

test("does not retry a busy rating update after its auth identity changes", async () => {
  let fetches = 0;
  let tokens = 0;
  globalThis.fetch = async () => {
    fetches++;
    return jsonResponse({ ok: true, skipped: true });
  };
  const response = await updateRatingsViaApi(
    {
      playerId: "player",
      opponentId: "opponent",
      inviteId: "auto_aaaaaaaaaaa",
      matchId: "auto_aaaaaaaaaaa",
    },
    async () => {
      tokens++;
      return "firebase-token";
    },
    {
      shouldRetry: () => false,
      sleep: async () => undefined,
    },
  );
  assert.deepEqual(response, { ok: true, skipped: true });
  assert.equal(fetches, 1);
  assert.equal(tokens, 1);
});

test("retries one unavailable rating update within the same deadline", async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return fetches === 1
      ? jsonResponse(
          {
            ok: false,
            error: "unavailable",
            message: "gameplay-service-unavailable",
          },
          503,
        )
      : jsonResponse({ ok: true });
  };
  assert.deepEqual(
    await updateRatingsViaApi(
      {
        playerId: "player",
        opponentId: "opponent",
        inviteId: "auto_aaaaaaaaaaa",
        matchId: "auto_aaaaaaaaaaa",
      },
      async () => "firebase-token",
    ),
    { ok: true },
  );
  assert.equal(fetches, 2);
});

test("bounds a busy rating retry to one 60-second deadline", async () => {
  let fetches = 0;
  let now = 1_000;
  const delays = [];
  globalThis.fetch = async () => {
    fetches++;
    now += 40_000;
    return jsonResponse({ ok: true, skipped: true });
  };
  const response = await updateRatingsViaApi(
    {
      playerId: "player",
      opponentId: "opponent",
      inviteId: "auto_aaaaaaaaaaa",
      matchId: "auto_aaaaaaaaaaa",
    },
    async () => "firebase-token",
    {
      now: () => now,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
    },
  );
  assert.deepEqual(response, { ok: true, skipped: true });
  assert.equal(fetches, 1);
  assert.deepEqual(delays, [20_000]);
});

test("sends exact authenticated gameplay mutations and validates contracts", async () => {
  const calls = [];
  const responses = [
    {
      ok: true,
      inviteId: "auto_invite",
      mode: "pending",
      matchedImmediately: false,
    },
    { ok: true },
    {
      ok: true,
      skipped: false,
      deleted: true,
      reason: null,
      inviteId: "invite-1",
    },
    {
      ok: true,
      items: [
        {
          id: "invite-1",
          entityType: "game",
          inviteId: "invite-1",
          kind: "direct",
          status: "waiting",
          sortBucket: 30,
          listSortAtMs: 1_000,
          hostLoginId: "host",
          guestLoginId: null,
          opponentProfileId: null,
          opponentName: null,
          opponentEmoji: null,
          automatchStateHint: null,
          isPendingAutomatch: false,
        },
      ],
      nextCursor: {
        sortBucket: 30,
        listSortAtMs: 1_000,
        id: "invite-1",
      },
      hasMore: false,
    },
    {
      ok: true,
      eventId: "event-1",
      participant: {
        profileId: "profile-1",
        loginUid: "login-1",
        username: "player",
        displayName: "player",
        emojiId: 7,
        aura: "rainbow",
        joinedAtMs: 100,
        state: "active",
        eliminatedRoundIndex: null,
        eliminatedByProfileId: null,
      },
    },
    { ok: true, eventId: "event-1", removedProfileId: "profile-2" },
    { ok: true, timer: "4;1000", duration: 90000 },
    { ok: true },
    { ok: true },
    { ok: false, reason: "proposal-missing" },
    {
      ok: true,
      count: 3,
      agreed: {
        material: "dust",
        count: 3,
        total: 6,
        proposerId: "guest",
        accepterId: "host",
        acceptedAt: 100,
      },
    },
    { ok: true, count: 2 },
    {
      ok: true,
      mining: {
        lastRockDate: "2026-08-20",
        materials: { dust: 4, slime: 3, gum: 2, metal: 1, ice: 0 },
      },
    },
  ];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse(responses.shift());
  };

  assert.deepEqual(
    await startAutomatchViaApi(
      { emojiId: 7, aura: "rainbow" },
      async () => "firebase-token",
    ),
    {
      ok: true,
      inviteId: "auto_invite",
      mode: "pending",
      matchedImmediately: false,
    },
  );
  assert.deepEqual(await cancelAutomatchViaApi(async () => "firebase-token"), {
    ok: true,
  });
  assert.deepEqual(
    await removeNavigationGameViaApi(
      { inviteId: "invite-1" },
      async () => "firebase-token",
    ),
    {
      ok: true,
      skipped: false,
      deleted: true,
      reason: null,
      inviteId: "invite-1",
    },
  );
  const readRequest = { limit: 80, cursor: null };
  const readResponse = await readNavigationGamesViaApi(
    readRequest,
    async () => "firebase-token",
  );
  assert.equal(isReadNavigationGamesRequest(readRequest), true);
  assert.equal(isReadNavigationGamesResponse(readResponse), true);
  assert.equal(readResponse.items[0].id, "invite-1");
  const participant = {
    profileId: "profile-1",
    loginUid: "login-1",
    username: "player",
    displayName: "player",
    emojiId: 7,
    aura: "rainbow",
    joinedAtMs: 100,
    state: "active",
    eliminatedRoundIndex: null,
    eliminatedByProfileId: null,
  };
  assert.deepEqual(
    await joinEventViaApi({ eventId: "event-1" }, async () => "firebase-token"),
    { ok: true, eventId: "event-1", participant },
  );
  assert.deepEqual(
    await removeEventParticipantViaApi(
      { eventId: "event-1", participantProfileId: "profile-2" },
      async () => "firebase-token",
    ),
    { ok: true, eventId: "event-1", removedProfileId: "profile-2" },
  );
  assert.deepEqual(
    await startMatchTimerViaApi(
      {
        playerId: "player-1",
        opponentId: "player-2",
        matchId: "match-1",
        inviteId: "match-1",
      },
      async () => "firebase-token",
    ),
    { ok: true, timer: "4;1000", duration: 90000 },
  );
  assert.deepEqual(
    await claimMatchVictoryByTimerViaApi(
      {
        playerId: "player-1",
        opponentId: "player-2",
        matchId: "match-1",
        inviteId: "match-1",
      },
      async () => "firebase-token",
    ),
    { ok: true },
  );
  assert.deepEqual(
    await cancelWagerProposalViaApi(
      { inviteId: "invite-1", matchId: "match-1" },
      async () => "firebase-token",
    ),
    { ok: true },
  );
  assert.deepEqual(
    await declineWagerProposalViaApi(
      { inviteId: "invite-1", matchId: "match-1" },
      async () => "firebase-token",
    ),
    { ok: false, reason: "proposal-missing" },
  );
  assert.deepEqual(
    await sendWagerProposalViaApi(
      {
        inviteId: "invite-1",
        matchId: "match-1",
        material: "dust",
        count: 4,
      },
      async () => "firebase-token",
    ),
    {
      ok: true,
      count: 3,
      agreed: {
        material: "dust",
        count: 3,
        total: 6,
        proposerId: "guest",
        accepterId: "host",
        acceptedAt: 100,
      },
    },
  );
  assert.deepEqual(
    await acceptWagerProposalViaApi(
      { inviteId: "invite-1", matchId: "match-1" },
      async () => "firebase-token",
    ),
    { ok: true, count: 2 },
  );
  assert.deepEqual(
    await resolveWagerOutcomeViaApi(
      { inviteId: "invite-1", matchId: "match-1" },
      async () => "firebase-token",
    ),
    {
      ok: true,
      mining: {
        lastRockDate: "2026-08-20",
        materials: { dust: 4, slime: 3, gum: 2, metal: 1, ice: 0 },
      },
    },
  );
  assert.deepEqual(
    calls.map((call) => call.input),
    [
      "https://api.mons.link/automatch/start",
      "https://api.mons.link/automatch/cancel",
      "https://api.mons.link/navigation/games/remove",
      "https://api.mons.link/navigation/games/read",
      "https://api.mons.link/events/participants/join",
      "https://api.mons.link/events/participants/remove",
      "https://api.mons.link/matches/timer/start",
      "https://api.mons.link/matches/timer/claim",
      "https://api.mons.link/wagers/proposals/cancel",
      "https://api.mons.link/wagers/proposals/decline",
      "https://api.mons.link/wagers/proposals/send",
      "https://api.mons.link/wagers/proposals/accept",
      "https://api.mons.link/wagers/outcomes/resolve",
    ],
  );
  assert.deepEqual(
    calls.map((call) => JSON.parse(call.init.body)),
    [
      { emojiId: 7, aura: "rainbow" },
      {},
      { inviteId: "invite-1" },
      { limit: 80, cursor: null },
      { eventId: "event-1" },
      { eventId: "event-1", participantProfileId: "profile-2" },
      {
        playerId: "player-1",
        opponentId: "player-2",
        matchId: "match-1",
        inviteId: "match-1",
      },
      {
        playerId: "player-1",
        opponentId: "player-2",
        matchId: "match-1",
        inviteId: "match-1",
      },
      { inviteId: "invite-1", matchId: "match-1" },
      { inviteId: "invite-1", matchId: "match-1" },
      {
        inviteId: "invite-1",
        matchId: "match-1",
        material: "dust",
        count: 4,
      },
      { inviteId: "invite-1", matchId: "match-1" },
      { inviteId: "invite-1", matchId: "match-1" },
    ],
  );
  for (const call of calls) {
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.cache, "no-store");
    assert.ok(call.init.signal instanceof AbortSignal);
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("Accept"), "application/json");
    assert.equal(headers.get("Authorization"), "Bearer firebase-token");
    assert.equal(headers.get("Content-Type"), "application/json");
  }

  assert.equal(isCancelAutomatchResponse({ ok: false }), true);
  assert.equal(isCancelAutomatchResponse({ ok: true, extra: true }), false);
  assert.equal(
    isStartAutomatchRequest({
      emojiId: 7,
      aura: "rainbow",
    }),
    true,
  );
  assert.equal(
    isStartAutomatchRequest({
      emojiId: 0,
      aura: "",
    }),
    false,
  );
  assert.equal(
    isStartAutomatchRequest({
      emojiId: 7,
      aura: "",
      extra: true,
    }),
    false,
  );
  assert.equal(
    isStartAutomatchRequest({
      emojiId: 7,
      aura: null,
    }),
    false,
  );
  assert.equal(
    isStartAutomatchResponse({
      ok: true,
      inviteId: "auto_invite",
      mode: "matched",
      matchedImmediately: true,
    }),
    true,
  );
  assert.equal(
    isStartAutomatchResponse({
      ok: true,
      inviteId: "auto_invite",
      mode: "pending",
      matchedImmediately: true,
    }),
    false,
  );
  assert.equal(isStartAutomatchResponse({ ok: false, inviteId: null }), false);
  assert.equal(
    isStartAutomatchResponse({
      ok: true,
      inviteId: " ",
      mode: "pending",
      matchedImmediately: false,
    }),
    false,
  );
  assert.equal(isRemoveNavigationGameRequest({ inviteId: "invite-1" }), true);
  assert.equal(isRemoveNavigationGameRequest({ inviteId: "" }), false);
  assert.equal(
    isRemoveNavigationGameResponse({
      ok: true,
      skipped: true,
      reason: "invite-active",
      inviteId: "invite-1",
    }),
    true,
  );
  assert.equal(
    isRemoveNavigationGameResponse({
      ok: true,
      skipped: false,
      deleted: false,
      reason: null,
      inviteId: "invite-1",
    }),
    false,
  );
  assert.equal(isJoinEventRequest({ eventId: "event-1" }), true);
  assert.equal(isJoinEventRequest({ eventId: "event-1", extra: true }), false);
  assert.equal(
    isRemoveEventParticipantRequest({
      eventId: "event-1",
      participantProfileId: "profile-2",
    }),
    true,
  );
  assert.equal(
    isRemoveEventParticipantRequest({
      eventId: "event-1",
      participantProfileId: "bad/profile",
    }),
    false,
  );
  assert.equal(isEventParticipantSnapshot(participant), true);
  for (const field of ["username", "displayName", "aura"]) {
    assert.equal(
      isEventParticipantSnapshot({
        ...participant,
        [field]: "x".repeat(MAX_EVENT_PARTICIPANT_TEXT_BYTES + 1),
      }),
      false,
    );
  }
  assert.equal(
    isEventParticipantSnapshot({ ...participant, emojiId: Infinity }),
    false,
  );
  assert.equal(
    isEventParticipantSnapshot({ ...participant, emojiId: -1 }),
    false,
  );
  assert.equal(
    isJoinEventResponse({ ok: true, eventId: "event-1", participant }),
    true,
  );
  assert.equal(
    isRemoveEventParticipantResponse({
      ok: true,
      eventId: "event-1",
      removedProfileId: "profile-2",
    }),
    true,
  );
  assert.equal(
    isStartMatchTimerRequest({
      playerId: "player-1",
      opponentId: "player-2",
      matchId: "match-1",
      inviteId: "match-1",
    }),
    true,
  );
  assert.equal(
    isStartMatchTimerRequest({
      playerId: "player-1",
      opponentId: "player-1",
      matchId: "match-1",
      inviteId: "match-1",
    }),
    false,
  );
  assert.equal(
    isStartMatchTimerRequest({
      playerId: "unsafe/player",
      opponentId: "player-2",
      matchId: "match-1",
      inviteId: "match-1",
    }),
    false,
  );
  assert.equal(
    isStartMatchTimerRequest({
      playerId: "player-1",
      opponentId: "player-2",
      matchId: "match-1",
      inviteId: "match-1",
      extra: true,
    }),
    false,
  );
  assert.equal(
    isStartMatchTimerResponse({
      ok: true,
      timer: "4;1000",
      duration: 90000,
    }),
    true,
  );
  assert.equal(
    isStartMatchTimerResponse({
      ok: true,
      timer: "bad-timer",
      duration: 90000,
    }),
    false,
  );
  assert.equal(
    isClaimMatchVictoryByTimerRequest({
      playerId: "player-1",
      opponentId: "player-2",
      matchId: "match-1",
      inviteId: "match-1",
    }),
    true,
  );
  assert.equal(
    isClaimMatchVictoryByTimerRequest({
      playerId: "player-1",
      opponentId: "player-1",
      matchId: "match-1",
      inviteId: "match-1",
    }),
    false,
  );
  assert.equal(
    isClaimMatchVictoryByTimerRequest({
      playerId: "unsafe/player",
      opponentId: "player-2",
      matchId: "match-1",
      inviteId: "match-1",
    }),
    false,
  );
  assert.equal(
    isClaimMatchVictoryByTimerRequest({
      playerId: "player-1",
      opponentId: "player-2",
      matchId: "match-1",
      inviteId: "match-1",
      extra: true,
    }),
    false,
  );
  assert.equal(isClaimMatchVictoryByTimerResponse({ ok: true }), true);
  assert.equal(
    isClaimMatchVictoryByTimerResponse({ ok: true, extra: true }),
    false,
  );
  assert.equal(
    isStartMatchTimerResponse({
      ok: true,
      timer: "4;1000;extra",
      duration: 90000,
    }),
    false,
  );
  assert.equal(
    isStartMatchTimerResponse({
      ok: true,
      timer: "4;1000",
      duration: 1000,
    }),
    false,
  );
  assert.equal(
    isWagerProposalSendRequest({
      inviteId: "invite",
      matchId: "match",
      material: "dust",
      count: 1.4,
    }),
    true,
  );
  assert.equal(
    isWagerProposalSendRequest({
      inviteId: "invite",
      matchId: "match",
      material: "unknown",
      count: 1,
    }),
    false,
  );
  assert.equal(
    isWagerProposalSendResponse({ ok: true, count: 1, debug: {} }),
    false,
  );
  assert.equal(
    isWagerProposalAcceptResponse({ ok: false, reason: "proposal-missing" }),
    true,
  );
  assert.equal(isWagerOutcomeResolveResponse({ ok: true, mining: null }), true);
});

test("refreshes the Firebase token once after a 401", async () => {
  const refreshes = [];
  const tokens = [];
  globalThis.fetch = async (_input, init) => {
    tokens.push(new Headers(init.headers).get("Authorization"));
    if (tokens.length === 1) {
      return jsonResponse(
        {
          ok: false,
          error: "unauthenticated",
          message: "authentication-required",
        },
        401,
      );
    }
    return jsonResponse({ ok: true });
  };
  assert.deepEqual(
    await cancelAutomatchViaApi(async (forceRefresh) => {
      refreshes.push(forceRefresh);
      return forceRefresh ? "fresh-token" : "stale-token";
    }),
    { ok: true },
  );
  assert.deepEqual(refreshes, [false, true]);
  assert.deepEqual(tokens, ["Bearer stale-token", "Bearer fresh-token"]);
});

test("does not retry mutation or expose transport details after other failures", async () => {
  let fetches = 0;
  let tokenCalls = 0;
  globalThis.fetch = async () => {
    fetches++;
    return jsonResponse(
      {
        ok: false,
        error: "unavailable",
        message: "gameplay-service-unavailable",
      },
      503,
    );
  };
  await assert.rejects(
    cancelAutomatchViaApi(async () => {
      tokenCalls++;
      return "token";
    }),
    (error) =>
      error instanceof GameplayApiError &&
      error.code === "unavailable" &&
      error.message === "gameplay-service-unavailable",
  );
  assert.equal(fetches, 1);
  assert.equal(tokenCalls, 1);

  globalThis.fetch = async () => {
    fetches++;
    throw new Error("private-network-detail");
  };
  await assert.rejects(
    cancelAutomatchViaApi(async () => "token"),
    (error) =>
      error instanceof GameplayApiError &&
      error.message === "Gameplay service is unavailable." &&
      !error.message.includes("private"),
  );
  assert.equal(fetches, 2);
});

test("rejects malformed and oversized gameplay responses", async () => {
  const responses = [
    jsonResponse({ ok: "yes" }),
    jsonResponse({ ok: true, skipped: false }),
    jsonResponse({ ok: true, timer: "invalid", duration: 90000 }),
    jsonResponse({ ok: true, extra: true }),
    jsonResponse({ ok: true, debug: {} }),
    jsonResponse({ ok: true, count: 1, debug: {} }),
    jsonResponse({ ok: true, count: 1, agreed: { material: "dust" } }),
    jsonResponse({ ok: true, mining: null, debug: {} }),
    new Response("{}", {
      headers: { "Content-Length": String(64 * 1024 + 1) },
    }),
    new Response("{"),
  ];
  globalThis.fetch = async () => responses.shift();
  await assert.rejects(
    startAutomatchViaApi({ emojiId: 1, aura: "" }, async () => "token"),
    GameplayApiError,
  );
  await assert.rejects(
    removeNavigationGameViaApi({ inviteId: "invite" }, async () => "token"),
    GameplayApiError,
  );
  await assert.rejects(
    startMatchTimerViaApi(
      {
        playerId: "player",
        opponentId: "opponent",
        matchId: "match",
        inviteId: "match",
      },
      async () => "token",
    ),
    GameplayApiError,
  );
  await assert.rejects(
    claimMatchVictoryByTimerViaApi(
      {
        playerId: "player",
        opponentId: "opponent",
        matchId: "match",
        inviteId: "match",
      },
      async () => "token",
    ),
    GameplayApiError,
  );
  await assert.rejects(
    cancelWagerProposalViaApi(
      { inviteId: "invite", matchId: "match" },
      async () => "token",
    ),
    GameplayApiError,
  );
  await assert.rejects(
    acceptWagerProposalViaApi(
      { inviteId: "invite", matchId: "match" },
      async () => "token",
    ),
    GameplayApiError,
  );
  await assert.rejects(
    sendWagerProposalViaApi(
      {
        inviteId: "invite",
        matchId: "match",
        material: "dust",
        count: 1,
      },
      async () => "token",
    ),
    GameplayApiError,
  );
  await assert.rejects(
    resolveWagerOutcomeViaApi(
      { inviteId: "invite", matchId: "match" },
      async () => "token",
    ),
    GameplayApiError,
  );
  for (let index = 0; index < 2; index++) {
    await assert.rejects(
      removeNavigationGameViaApi({ inviteId: "invite" }, async () => "token"),
      GameplayApiError,
    );
  }
});

test("applies one deadline to token acquisition and response reading", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tokenRequest = cancelAutomatchViaApi(
    () => new Promise(() => undefined),
  );
  const tokenRejection = assert.rejects(
    tokenRequest,
    (error) =>
      error instanceof GameplayApiError &&
      error.message === "Gameplay request timed out.",
  );
  t.mock.timers.runAll();
  await tokenRejection;

  let signal;
  let bodyStarted;
  const started = new Promise((resolve) => {
    bodyStarted = resolve;
  });
  globalThis.fetch = async (_input, init) => {
    signal = init.signal;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          bodyStarted();
        },
      }),
    );
  };
  const bodyRequest = cancelAutomatchViaApi(async () => "token");
  await started;
  const bodyRejection = assert.rejects(
    bodyRequest,
    (error) =>
      error instanceof GameplayApiError &&
      error.message === "Gameplay request timed out.",
  );
  assert.equal(signal.aborted, false);
  t.mock.timers.runAll();
  await bodyRejection;
  assert.equal(signal.aborted, true);
});
