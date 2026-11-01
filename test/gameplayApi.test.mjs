import { required, canonicalEvent } from "./fixtures/canonicalData.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { automatchBootstrap } from "./automatchBootstrapFixture.mjs";

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
  leaveEventViaApi,
  joinInviteViaApi,
  readEventSnapshotViaApi,
  removeEventParticipantViaApi,
  removeNavigationGameViaApi,
  readNavigationGamesViaApi,
  readHistoricalMatchPairViaApi,
  readMatchSnapshotViaApi,
  readInviteRoleViaApi,
  readProfileEventPrizesViaApi,
  readWagerFrozenViaApi,
  resolveWagerOutcomeViaApi,
  sendWagerProposalViaApi,
  startAutomatchViaApi,
  startMatchTimerViaApi,
  surrenderMatchViaApi,
  submitMoveViaApi,
  syncEventStateViaApi,
  toggleEventPrizeSelectionViaApi,
  updateRatingsViaApi,
  postponeEventStartViaApi,
  proposeRematchViaApi,
} = await import("../src/services/gameplayApi.ts");
const { createUserBoundAuthTokenProvider } =
  await import("../src/services/authApi.ts");
const { createPollingAuthTokenProvider } =
  await import("../src/connection/pollingAuthTokenProvider.ts");
const {
  MAX_GAME_SESSION_RESPONSE_BYTES,
  MAX_GAME_SESSION_STATUS_BYTES,
  isSubmitMoveRequest,
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
  isSurrenderMatchRequest,
  isSurrenderMatchResponse,
} = await import("@mons/shared/game-sessions");
const { MAX_MATCH_FEN_BYTES, MAX_MATCH_HISTORY_BYTES } =
  await import("@mons/shared/match-protocol");
const { isRatingUpdateRequest, isRatingUpdateResponse } =
  await import("@mons/shared/ratings");
const {
  AUTOMATCH_API_MAX_RESPONSE_BYTES,
  isCancelAutomatchResponse,
  isRemoveNavigationGameRequest,
  isRemoveNavigationGameResponse,
  isReadNavigationGamesRequest,
  isReadNavigationGamesResponse,
  isStartAutomatchRequest,
  isStartAutomatchResponse,
  parseStartAutomatchApiResponse,
} = await import("@mons/shared/navigation");
const {
  isClaimMatchVictoryByTimerRequest,
  isClaimMatchVictoryByTimerResponse,
  isStartMatchTimerRequest,
  isStartMatchTimerResponse,
} = await import("@mons/shared/timers");
const {
  WAGER_STORAGE_VERSION_HEADER,
  WAGER_STORAGE_VERSION,
  isWagerFrozenReadRequest,
  isWagerFrozenReadResponse,
  isWagerOutcomeResolveResponse,
  isWagerProposalAcceptResponse,
  isWagerProposalSendRequest,
  isWagerProposalSendResponse,
} = await import("@mons/shared/wagers");
const {
  MAX_EVENT_PARTICIPANT_TEXT_BYTES,
  MAX_EVENT_READ_RESPONSE_BYTES,
  isCreateEventRequest,
  isCreateEventResponse,
  isDisqualifyEventMatchWinnersRequest,
  isDisqualifyEventMatchWinnersResponse,
  isEventParticipantSnapshot,
  isEventSnapshotResponse,
  isJoinEventRequest,
  isJoinEventResponse,
  isLeaveEventRequest,
  isLeaveEventResponse,
  isRemoveEventParticipantRequest,
  isRemoveEventParticipantResponse,
  isPostponeEventStartRequest,
  isPostponeEventStartResponse,
  isSyncEventStateRequest,
  isSyncEventStateResponse,
  resolveEventTelegramAnnouncements,
} = await import("@mons/shared/events");
const {
  LEGACY_CORE_PRIZES_EVENT_ID,
  isEventPrizeAssignmentRecord,
  isEventPrizeAssignmentWireRecord,
  isProfileEventPrizesResponse,
  isToggleEventPrizeSelectionRequest,
  isToggleEventPrizeSelectionResponse,
} = await import("@mons/shared/event-prizes");

const originalFetch = globalThis.fetch;
const AUTOMATCH_OPERATION_ID = "00000000-0000-4000-8000-000000000001";

/**
 * @template Input, Output
 * @param {(input: Input, token: import("../src/services/authApi.ts").AuthTokenProvider) => Promise<Output>} mutate
 * @param {NoInfer<Input>} request
 * @param {NoInfer<Output>} base
 */
function mutationCase(mutate, request, base) {
  return {
    request,
    base,
    run: (
      /** @type {import("../src/services/authApi.ts").AuthTokenProvider} */ token,
    ) => mutate(request, token),
  };
}
/** @param {unknown} body */
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

const frozenResponse = (overrides = {}) => ({
  ok: true,
  playerUid: "actor",
  revision: 2,
  frozen: { dust: 3, slime: 2, gum: 1, metal: 0, ice: 0 },
  ...overrides,
});

test("validates exact frozen-balance requests and authoritative snapshots", () => {
  assert.equal(isWagerFrozenReadRequest({ playerUid: "actor" }), true);
  for (const value of [
    null,
    {},
    { playerUid: "actor", profileId: "other" },
    { playerUid: " actor " },
    { playerUid: "actors/other" },
    { playerUid: "x".repeat(769) },
  ])
    assert.equal(isWagerFrozenReadRequest(value), false);
  assert.equal(isWagerFrozenReadResponse(frozenResponse()), true);
  assert.equal(
    isWagerFrozenReadResponse(frozenResponse({ revision: 0 })),
    true,
  );
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    assert.equal(
      isWagerFrozenReadResponse(frozenResponse({ revision })),
      false,
    );
  }
  for (const frozen of [
    null,
    {},
    { ...frozenResponse().frozen, dust: -1 },
    { ...frozenResponse().frozen, dust: 1.5 },
    { ...frozenResponse().frozen, dust: Number.MAX_SAFE_INTEGER + 1 },
    { ...frozenResponse().frozen, dust: "1" },
    { ...frozenResponse().frozen, extra: 0 },
  ])
    assert.equal(isWagerFrozenReadResponse(frozenResponse({ frozen })), false);
  assert.equal(
    isWagerFrozenReadResponse({ ...frozenResponse(), operations: {} }),
    false,
  );
});

test("reads the actor balance through authenticated POST without a wager write header", async () => {
  /** @type {{ value?: ({ url: RequestInfo | URL; init: RequestInit | undefined; }) }} */
  const call = {};
  globalThis.fetch = async (url, init) => {
    call.value = { url, init };
    return jsonResponse(frozenResponse());
  };
  assert.deepEqual(
    await readWagerFrozenViaApi({ playerUid: "actor" }, async () => "token"),
    frozenResponse(),
  );
  assert.equal(
    required(call.value).url,
    "https://api.mons.link/wagers/frozen/read",
  );
  assert.equal(required(required(call.value).init).method, "POST");
  assert.equal(required(required(call.value).init).cache, "no-store");
  assert.deepEqual(
    JSON.parse(String(required(required(call.value).init).body)),
    {
      playerUid: "actor",
    },
  );
  const headers = new Headers(required(required(call.value).init).headers);
  assert.equal(headers.get("Authorization"), "Bearer token");
  assert.equal(headers.get(WAGER_STORAGE_VERSION_HEADER), null);
});

test("rejects wrong-actor, malformed, oversized, and unavailable frozen snapshots", async () => {
  const responses = [
    jsonResponse(frozenResponse({ playerUid: "other" })),
    jsonResponse(frozenResponse({ frozen: null })),
    jsonResponse({ ok: false, error: "unavailable" }, 503),
    new Response(" ".repeat(4097)),
  ];
  for (const response of responses) {
    globalThis.fetch = async () => response;
    await assert.rejects(
      readWagerFrozenViaApi({ playerUid: "actor" }, async () => "token"),
      (error) =>
        error instanceof GameplayApiError && error.code === "unavailable",
    );
  }
});

test("frozen read cancellation interrupts pending authentication and prevents transport", async () => {
  const controller = new AbortController();

  /** @type {PromiseWithResolvers<string>} */
  const { promise: token, resolve: resolveToken } = Promise.withResolvers();
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return jsonResponse(frozenResponse());
  };
  const request = readWagerFrozenViaApi({ playerUid: "actor" }, () => token, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(
    request,
    (error) => error instanceof GameplayApiError && error.code === "aborted",
  );
  required(resolveToken)("token");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 0);
});

test("frozen token refresh remains bound to the original login", async () => {
  const user = { uid: "login", getIdToken: async () => "token" };
  let currentUser = user;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    currentUser = { uid: "new-login", getIdToken: async () => "other-token" };
    return jsonResponse({ error: "unauthenticated" }, 401);
  };
  await assert.rejects(
    readWagerFrozenViaApi(
      { playerUid: "actor" },
      createUserBoundAuthTokenProvider(user, () => currentUser),
    ),
    (error) =>
      error instanceof GameplayApiError && error.code === "unauthenticated",
  );
  assert.equal(fetches, 1);
});

const matchSnapshotRequest = { playerId: "actor", matchId: "abcdefghijk" };
const matchSnapshotResponse = (overrides = {}) => ({
  ok: true,
  ...matchSnapshotRequest,
  match: {
    schemaVersion: 1,
    version: 1,
    color: "white",
    emojiId: 1,
    aura: "none",
    gameVariant: "Classic",
    fen: "fen",
    status: "active",
    flatMovesString: "move",
    timer: { state: "idle" },
  },
  ...overrides,
});

test("reads public match snapshots and explicit absence without authentication or caching", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const caller = new AbortController();
  /** @type {({ input: string; init: RequestInit | undefined; })[]} */
  const calls = [];
  for (const payload of [
    matchSnapshotResponse(),
    matchSnapshotResponse({ match: null }),
  ]) {
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse(payload);
    };
    assert.deepEqual(
      await readMatchSnapshotViaApi(matchSnapshotRequest, {
        signal: caller.signal,
      }),
      payload,
    );
  }
  assert.equal(calls.length, 2);
  for (const { input, init } of calls) {
    assert.equal(
      input,
      "https://api.mons.link/matches/snapshot?playerId=actor&matchId=abcdefghijk",
    );
    assert.equal(required(init).method, "GET");
    assert.equal(required(init).cache, "no-store");
    assert.equal(
      new Headers(required(init).headers).has("Authorization"),
      false,
    );
    assert.equal(required(init).body, undefined);
  }
  caller.abort();
  t.mock.timers.runAll();
  for (const { init } of calls)
    assert.equal(required(required(init).signal).aborted, false);
});

test("rejects invalid match snapshot requests before transport", async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return jsonResponse(matchSnapshotResponse());
  };
  for (const request of [
    { ...matchSnapshotRequest, playerId: " actor " },
    { ...matchSnapshotRequest, playerId: "a/b" },
    { ...matchSnapshotRequest, matchId: "" },
    { ...matchSnapshotRequest, inviteId: "extra" },
  ]) {
    await assert.rejects(
      readMatchSnapshotViaApi(request),
      (error) =>
        error instanceof GameplayApiError && error.code === "invalid-argument",
    );
  }
  for (const timeoutMs of [0, -1, NaN, Infinity]) {
    await assert.rejects(
      readMatchSnapshotViaApi(matchSnapshotRequest, { timeoutMs }),
      (error) =>
        error instanceof GameplayApiError && error.code === "invalid-argument",
    );
  }
  assert.equal(fetches, 0);
});

test("match snapshot failures never become absence or trigger retries", async () => {
  const invalidResponses = [
    jsonResponse(matchSnapshotResponse({ playerId: "other" })),
    jsonResponse(matchSnapshotResponse({ matchId: "other" })),
    jsonResponse(matchSnapshotResponse({ match: {} })),
    jsonResponse({ ...matchSnapshotResponse(), extra: true }),
    jsonResponse({ ok: true, ...matchSnapshotRequest }),
    jsonResponse({ error: "unavailable" }, 503),
    new Response("{malformed"),
    new Response("x".repeat(MAX_GAME_SESSION_RESPONSE_BYTES + 1)),
    new Response("{}", {
      headers: {
        "Content-Length": String(MAX_GAME_SESSION_RESPONSE_BYTES + 1),
      },
    }),
  ];
  let fetches = 0;
  for (const response of invalidResponses) {
    globalThis.fetch = async () => {
      fetches += 1;
      return response;
    };
    await assert.rejects(
      readMatchSnapshotViaApi(matchSnapshotRequest),
      (error) =>
        error instanceof GameplayApiError && error.code === "unavailable",
    );
  }
  assert.equal(fetches, invalidResponses.length);
  globalThis.fetch = async () => {
    fetches += 1;
    return jsonResponse({ error: "unauthenticated" }, 401);
  };
  await assert.rejects(
    readMatchSnapshotViaApi(matchSnapshotRequest),
    (error) =>
      error instanceof GameplayApiError && error.code === "unauthenticated",
  );
  assert.equal(fetches, invalidResponses.length + 1);
  globalThis.fetch = async () => {
    throw new TypeError("network unavailable");
  };
  await assert.rejects(
    readMatchSnapshotViaApi(matchSnapshotRequest),
    (error) =>
      error instanceof GameplayApiError && error.code === "unavailable",
  );
});

test("match snapshot cancellation aborts transport even when fetch ignores cancellation", async () => {
  const caller = new AbortController();
  /** @type {{ value?: (AbortSignal | null | undefined) }} */
  const signal = {};
  /** @type {{ value?: ((value: Response | PromiseLike<Response>) => void) }} */
  const resolveFetch = {};
  let canceled = false;
  globalThis.fetch = (_input, init) => {
    signal.value = required(init).signal;
    return new Promise((resolve) => (resolveFetch.value = resolve));
  };
  const request = readMatchSnapshotViaApi(matchSnapshotRequest, {
    signal: caller.signal,
  });
  caller.abort();
  await assert.rejects(
    request,
    (error) => error instanceof GameplayApiError && error.code === "aborted",
  );
  assert.equal(required(signal.value).aborted, true);
  required(resolveFetch.value)(
    new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(canceled, true);
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return assert.fail("unexpected aborted fetch");
  };
  await assert.rejects(
    readMatchSnapshotViaApi(matchSnapshotRequest, { signal: caller.signal }),
    (error) => error instanceof GameplayApiError && error.code === "aborted",
  );
  assert.equal(fetches, 0);
});

test("match snapshot deadline aborts fetch without relying on fetch rejection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  /** @type {{ value?: (AbortSignal | null | undefined) }} */
  const signal = {};
  let fetches = 0;
  globalThis.fetch = (_input, init) => {
    fetches += 1;
    signal.value = required(init).signal;
    return new Promise(() => {});
  };
  const request = readMatchSnapshotViaApi(matchSnapshotRequest, {
    timeoutMs: 1200,
  });
  const rejected = assert.rejects(
    request,
    (error) =>
      error instanceof GameplayApiError &&
      error.code === "unavailable" &&
      error.message === "Gameplay request timed out.",
  );
  t.mock.timers.tick(1199);
  assert.equal(required(signal.value).aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(required(signal.value).aborted, true);
  assert.equal(fetches, 1);
});

test("match snapshot deadline and caller cancellation cover stalled response bodies", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const callerCanceled of [false, true]) {
    const caller = new AbortController();
    /** @type {{ value?: (AbortSignal | null | undefined) }} */
    const signal = {};
    let canceled = false;
    globalThis.fetch = async (_input, init) => {
      signal.value = required(init).signal;
      return new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
      );
    };
    const request = readMatchSnapshotViaApi(matchSnapshotRequest, {
      signal: caller.signal,
    });
    const rejected = assert.rejects(
      request,
      (error) =>
        error instanceof GameplayApiError &&
        error.code === (callerCanceled ? "aborted" : "unavailable"),
    );
    await new Promise((resolve) => setImmediate(resolve));
    if (callerCanceled) {
      caller.abort();
    } else {
      t.mock.timers.tick(29_999);
      assert.equal(required(signal.value).aborted, false);
      t.mock.timers.tick(1);
    }
    await rejected;
    assert.equal(required(signal.value).aborted, true);
    assert.equal(canceled, true);
  }
});

test("reads public historical matches without an auth token", async () => {
  /** @type {({ input: string; init: RequestInit | undefined; })[]} */
  const calls = [];
  const match = {
    schemaVersion: 1,
    version: 2,
    color: "white",
    emojiId: 1,
    aura: "none",
    gameVariant: "Classic",
    fen: "fen",
    status: "surrendered",
    flatMovesString: "move",
    timer: { state: "idle" },
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
    required(calls[0]).input,
    "https://api.mons.link/matches/history?inviteId=abcdefghijk&matchId=abcdefghijk",
  );
  assert.equal(required(required(calls[0]).init).method, "GET");
  assert.equal(
    new Headers(required(required(calls[0]).init).headers).has("Authorization"),
    false,
  );
});

test("sends exact authenticated event-control mutations", async () => {
  /** @type {({ input: string; init: RequestInit | undefined; })[]} */
  const calls = [];
  const event = canonicalEvent({ eventId: "event-1", startAtMs: 600_000 });
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
  const tokenProvider = async () => "session-token";
  assert.deepEqual(
    await Reflect.apply(createEventViaApi, undefined, [
      { startsInMinutes: 5, announceOnTelegram: true },
      tokenProvider,
    ]),
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
      "https://api.mons.link/events/create?eventSnapshot=v1",
      "https://api.mons.link/events/start/postpone?eventSnapshot=v1",
      "https://api.mons.link/events/matches/winners/disqualify?eventSnapshot=v1",
      "https://api.mons.link/events/state/sync?eventSnapshot=v1",
    ],
  );
  assert.equal(
    calls.every(
      (call) =>
        new Headers(required(call.init).headers).get("Authorization") ===
        "Bearer session-token",
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

test("event controls accept complete snapshot seeds without an additional request", async () => {
  const event = canonicalEvent({ eventId: "event-1", startAtMs: 600_000 });
  const eventSnapshot = {
    snapshot: {
      ok: true,
      eventId: "event-1",
      revision: 2,
      event,
      prizeSelections: {},
    },
    etag: 'W/"event-snapshot-event-1-2"',
    bookmark: "mons-d1-v1:446cba4b-31c0-4c5e-8daa-af7d235fbe0f:revision-2",
  };
  const cases = [
    mutationCase(
      createEventViaApi,
      { startsInMinutes: 5 },
      { ok: true, eventId: "event-1", event },
    ),
    mutationCase(
      postponeEventStartViaApi,
      { eventId: "event-1", postponeByMinutes: 5 },
      {
        ok: true,
        eventId: "event-1",
        event,
        postponeByMinutes: 5,
        startAtMs: 600_000,
      },
    ),
    mutationCase(
      disqualifyEventMatchWinnersViaApi,
      { eventId: "event-1", matchKey: "0_0" },
      {
        ok: true,
        eventId: "event-1",
        event,
        didChange: true,
        didDisqualify: true,
        matchKey: "0_0",
      },
    ),
    mutationCase(
      syncEventStateViaApi,
      { eventId: "event-1" },
      { ok: true, eventId: "event-1", event, didChange: true },
    ),
  ];
  for (const { run, request, base } of cases) {
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      calls += 1;
      assert.equal(
        new URL(String(input)).searchParams.get("eventSnapshot"),
        "v1",
      );
      assert.equal(required(init).method, "POST");
      assert.deepEqual(JSON.parse(String(required(init).body)), request);
      return jsonResponse({ ...base, eventSnapshot });
    };
    assert.deepEqual(await run(async () => "token"), {
      ...base,
      eventSnapshot,
    });
    assert.equal(calls, 1);
  }
});

test("invalid optional event seeds preserve mutation success without replaying POST", async () => {
  const event = canonicalEvent({ eventId: "event-1" });
  const base = {
    ok: true,
    eventId: "event-1",
    event,
    postponeByMinutes: 5,
    startAtMs: 600_000,
  };
  const wrongEventSeed = {
    snapshot: {
      ok: true,
      eventId: "other",
      revision: 2,
      event: { ...event, eventId: "other" },
      prizeSelections: {},
    },
    etag: 'W/"event-snapshot-other-2"',
    bookmark: "mons-d1-v1:446cba4b-31c0-4c5e-8daa-af7d235fbe0f:revision-2",
  };
  for (const eventSnapshot of [undefined, null, {}, wrongEventSeed]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse({
        ...base,
        ...(eventSnapshot === undefined ? {} : { eventSnapshot }),
      });
    };
    assert.deepEqual(
      await postponeEventStartViaApi(
        { eventId: "event-1", postponeByMinutes: 5 },
        async () => "token",
      ),
      base,
    );
    assert.equal(calls, 1);
  }
  globalThis.fetch = async () => jsonResponse({ ...base, unexpected: true });
  await assert.rejects(
    postponeEventStartViaApi(
      { eventId: "event-1", postponeByMinutes: 5 },
      async () => "token",
    ),
    GameplayApiError,
  );
});

test("sends granular Telegram announcements with either event schedule", async () => {
  const telegramAnnouncements = { invite: false, matches: true, results: true };
  const event = canonicalEvent({ eventId: "event-1", telegramAnnouncements });
  /** @type {({ input: string; init: RequestInit | undefined; })[]} */
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse({ ok: true, eventId: "event-1", event });
  };
  for (const schedule of /** @type {const} */ ([
    { startsInMinutes: 5 },
    {
      scheduledDate: "2026-09-06",
      scheduledTime: "18:30",
      scheduledTimezone: "local",
      localTimezoneIana: "Europe/Istanbul",
    },
  ])) {
    const request = { ...schedule, telegramAnnouncements };
    assert.equal(isCreateEventRequest(request), true);
    const response = await createEventViaApi(
      request,
      async () => "session-token",
    );
    assert.deepEqual(
      response.event.telegramAnnouncements,
      telegramAnnouncements,
    );
    assert.deepEqual(
      JSON.parse(String(required(required(calls.at(-1)).init).body)),
      request,
    );
  }
});

test("sends explicit Sunday Mons flags with either event schedule", async () => {
  /** @type {({ input: string; init: RequestInit | undefined; })[]} */
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const request = JSON.parse(String(required(init).body));
    calls.push({ input: String(input), init });
    return jsonResponse({
      ok: true,
      eventId: "event-1",
      event: canonicalEvent({
        eventId: "event-1",
        isSundayMons: request.isSundayMons === true,
      }),
    });
  };
  for (const schedule of /** @type {const} */ ([
    { startsInMinutes: 5 },
    {
      scheduledDate: "2026-09-07",
      scheduledTime: "18:30",
      scheduledTimezone: "ET",
    },
  ])) {
    for (const options of [
      {},
      { isSundayMons: false },
      { isSundayMons: true },
    ]) {
      const request = { ...schedule, ...options };
      assert.equal(isCreateEventRequest(request), true);
      const response = await createEventViaApi(
        request,
        async () => "session-token",
      );
      assert.equal(response.event.isSundayMons, options.isSundayMons === true);
      assert.deepEqual(
        JSON.parse(String(required(required(calls.at(-1)).init).body)),
        request,
      );
    }
    for (const isSundayMons of [
      undefined,
      null,
      "true",
      "false",
      0,
      1,
      [],
      {},
    ]) {
      assert.equal(isCreateEventRequest({ ...schedule, isSundayMons }), false);
    }
  }
});

test("validates required Sunday Mons response flags on complete canonical events", () => {
  for (const options of [{}, { isSundayMons: false }, { isSundayMons: true }]) {
    assert.equal(
      isCreateEventResponse({
        ok: true,
        eventId: "event-1",
        event: canonicalEvent({ eventId: "event-1", ...options }),
      }),
      true,
    );
  }
  for (const isSundayMons of [undefined, null, "true", 0, [], {}]) {
    assert.equal(
      isCreateEventResponse({
        ok: true,
        eventId: "event-1",
        event: { ...canonicalEvent({ eventId: "event-1" }), isSundayMons },
      }),
      false,
    );
  }
});

test("validates current Telegram preferences and rejects retired request flags", () => {
  const allOff = { invite: false, matches: false, results: false };
  const allOn = { invite: true, matches: true, results: true };
  const delayedInvite = { invite: false, matches: true, results: true };
  assert.deepEqual(resolveEventTelegramAnnouncements({}), allOff);
  assert.deepEqual(
    Reflect.apply(resolveEventTelegramAnnouncements, undefined, [
      { announceOnTelegram: false },
    ]),
    allOff,
  );
  assert.deepEqual(
    Reflect.apply(resolveEventTelegramAnnouncements, undefined, [
      { announceOnTelegram: true },
    ]),
    allOff,
  );
  assert.deepEqual(
    Reflect.apply(resolveEventTelegramAnnouncements, undefined, [
      {
        announceOnTelegram: true,
        telegramAnnouncements: allOff,
      },
    ]),
    allOff,
  );
  assert.deepEqual(
    Reflect.apply(resolveEventTelegramAnnouncements, undefined, [
      {
        announceOnTelegram: false,
        telegramAnnouncements: delayedInvite,
      },
    ]),
    delayedInvite,
  );
  for (const schedule of /** @type {const} */ ([
    { startsInMinutes: 5 },
    {
      scheduledDate: "2026-09-06",
      scheduledTime: "18:30",
      scheduledTimezone: "ET",
    },
  ])) {
    assert.equal(isCreateEventRequest(schedule), true);
    for (const telegramAnnouncements of [allOff, allOn, delayedInvite]) {
      assert.equal(
        isCreateEventRequest({ ...schedule, telegramAnnouncements }),
        true,
      );
    }
    for (const announceOnTelegram of [undefined, false, true]) {
      assert.equal(
        isCreateEventRequest({ ...schedule, announceOnTelegram }),
        false,
      );
      assert.equal(
        isCreateEventRequest({
          ...schedule,
          announceOnTelegram,
          telegramAnnouncements: allOn,
        }),
        false,
      );
    }
    for (const telegramAnnouncements of [
      null,
      false,
      [],
      {},
      { invite: false, matches: true },
      { ...delayedInvite, invite: "false" },
      { ...delayedInvite, matches: 1 },
      { ...delayedInvite, results: null },
      { ...delayedInvite, other: true },
    ]) {
      assert.equal(
        isCreateEventRequest({ ...schedule, telegramAnnouncements }),
        false,
      );
    }
    assert.equal(
      isCreateEventRequest({ ...schedule, announceOnTelegram: "true" }),
      false,
    );
    assert.equal(
      isCreateEventRequest({
        ...schedule,
        telegramAnnouncements: allOn,
        extra: true,
      }),
      false,
    );
  }
});

test("reads conditional event snapshots and profile prizes with transport metadata", async () => {
  /** @type {({ input: string; init: RequestInit | undefined; })[]} */
  const calls = [];
  const event = canonicalEvent({ eventId: LEGACY_CORE_PRIZES_EVENT_ID });
  const snapshot = {
    ok: true,
    eventId: LEGACY_CORE_PRIZES_EVENT_ID,
    revision: 3,
    event,
    prizeSelections: { "profile-1": "1092" },
  };
  const profilePrizes = {
    ok: true,
    profileId: "profile-1",
    revision: 0,
    prizes: {},
  };
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    if (calls.length === 1) {
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ETag: 'W/"event-3"',
          "X-D1-Bookmark": "bookmark-3",
        },
      });
    }
    return new Response(JSON.stringify(profilePrizes), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ETag: 'W/"prizes-4"',
        "X-D1-Bookmark": "bookmark-4",
      },
    });
  };
  const tokenProvider = Object.assign(async () => "session-token", {
    assertCurrentUser: () => undefined,
  });

  assert.deepEqual(
    await readEventSnapshotViaApi(
      ` ${LEGACY_CORE_PRIZES_EVENT_ID} `,
      tokenProvider,
      {
        etag: 'W/"event-2"',
        bookmark: "bookmark-2",
      },
    ),
    {
      kind: "modified",
      value: snapshot,
      etag: 'W/"event-3"',
      bookmark: "bookmark-3",
    },
  );
  assert.deepEqual(
    await readProfileEventPrizesViaApi(" profile-1 ", tokenProvider),
    {
      kind: "modified",
      value: profilePrizes,
      etag: 'W/"prizes-4"',
      bookmark: "bookmark-4",
    },
  );
  assert.equal(
    required(calls[0]).input,
    `https://api.mons.link/events/snapshot?eventId=${LEGACY_CORE_PRIZES_EVENT_ID}`,
  );
  assert.equal(
    required(calls[1]).input,
    "https://api.mons.link/events/prizes?pagination=1",
  );
  const headers = new Headers(required(required(calls[0]).init).headers);
  assert.equal(headers.get("Authorization"), "Bearer session-token");
  assert.equal(headers.get("If-None-Match"), 'W/"event-2"');
  assert.equal(headers.get("X-D1-Bookmark"), "bookmark-2");
  assert.equal(required(required(calls[0]).init).method, "GET");
  assert.equal(required(required(calls[0]).init).cache, "no-store");
});

test("rejects conditional responses for a different resource", async () => {
  const headers = {
    ETag: 'W/"event-1"',
    "X-D1-Bookmark": "bookmark-1",
  };
  const responses = [
    {
      ok: true,
      eventId: "event-2",
      revision: 0,
      event: null,
      prizeSelections: {},
    },
    {
      ok: true,
      profileId: "profile-2",
      revision: 0,
      prizes: {},
    },
  ];
  globalThis.fetch = async () =>
    new Response(JSON.stringify(responses.shift()), { status: 200, headers });

  await assert.rejects(
    readEventSnapshotViaApi("event-1", async () => "token"),
    (error) =>
      error instanceof GameplayApiError && error.code === "unavailable",
  );
  await assert.rejects(
    readProfileEventPrizesViaApi("profile-1", async () => "token"),
    (error) =>
      error instanceof GameplayApiError && error.code === "unavailable",
  );
});

test("rejects an unsolicited not-modified response without a cached validator", async () => {
  /** @type {{ value?: (Headers) }} */
  const requestHeaders = {};
  globalThis.fetch = async (_input, init) => {
    requestHeaders.value = new Headers(init?.headers);
    return new Response(null, {
      status: 304,
      headers: {
        ETag: 'W/"event-1"',
        "X-D1-Bookmark": "bookmark-1",
      },
    });
  };

  await assert.rejects(
    readEventSnapshotViaApi("event-1", async () => "token"),
    (error) =>
      error instanceof GameplayApiError && error.code === "unavailable",
  );
  assert.equal(required(requestHeaders.value).has("If-None-Match"), false);
});

test("refreshes authentication once for conditional reads and fences the caller", async () => {
  /** @type {boolean[]} */
  const forceRefreshValues = [];
  const snapshot = {
    ok: true,
    eventId: "event-1",
    revision: 0,
    event: null,
    prizeSelections: {},
  };
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse(
        {
          ok: false,
          error: "unauthenticated",
          message: "authentication-required",
        },
        401,
      );
    }
    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ETag: 'W/"event-1"',
        "X-D1-Bookmark": "bookmark-1",
      },
    });
  };
  let current = true;
  const tokenProvider = Object.assign(
    async (/** @type {boolean} */ forceRefresh) => {
      forceRefreshValues.push(forceRefresh);
      return "token";
    },
    {
      assertCurrentUser: () => {
        if (!current) throw new Error("authentication-changed");
      },
    },
  );
  assert.equal(
    (await readEventSnapshotViaApi("event-1", tokenProvider)).kind,
    "modified",
  );
  assert.deepEqual(forceRefreshValues, [false, true]);

  current = false;
  await assert.rejects(
    readEventSnapshotViaApi("event-1", tokenProvider),
    (error) =>
      error instanceof GameplayApiError && error.code === "unavailable",
  );
});

test("aborts a conditional read without AbortSignal.any", async (t) => {
  const abortSignalAny = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  Object.defineProperty(AbortSignal, "any", {
    configurable: true,
    value: undefined,
  });
  t.after(() => {
    if (abortSignalAny) {
      Object.defineProperty(AbortSignal, "any", abortSignalAny);
    } else {
      Reflect.deleteProperty(AbortSignal, "any");
    }
  });
  const controller = new AbortController();
  let fetchCalls = 0;

  let boundProviderCalls = 0;
  /** @type {PromiseWithResolvers<void>} */
  const { promise: authentication, resolve: resolveAuthentication } =
    Promise.withResolvers();
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("unexpected-fetch");
  };
  const tokenProvider = createPollingAuthTokenProvider({
    ensureAuthenticated: () => authentication,
    getUserBoundProvider: () => {
      boundProviderCalls += 1;
      return Object.assign(async () => "token", {
        assertCurrentUser: () => undefined,
      });
    },
    isSessionCurrent: () => true,
    signal: controller.signal,
  });
  const request = readEventSnapshotViaApi("event-1", tokenProvider, {
    signal: controller.signal,
  });

  controller.abort();

  await assert.rejects(
    request,
    (error) =>
      error instanceof GameplayApiError &&
      error.code === "aborted" &&
      error.message === "request-aborted",
  );
  required(resolveAuthentication)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(boundProviderCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("applies the conditional-read deadline to token acquisition", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("unexpected-fetch");
  };
  const request = readProfileEventPrizesViaApi(
    "profile-1",
    () => new Promise(() => undefined),
  );
  const rejection = assert.rejects(
    request,
    (error) =>
      error instanceof GameplayApiError &&
      error.code === "unavailable" &&
      error.message === "Gameplay request timed out.",
  );

  t.mock.timers.runAll();

  await rejection;
  assert.equal(fetchCalls, 0);
});

test("applies the conditional-read deadline to response reading", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  /** @type {{ value?: (AbortSignal | null | undefined) }} */
  const requestSignal = {};

  /** @type {PromiseWithResolvers<void>} */
  const { promise: started, resolve: bodyStarted } = Promise.withResolvers();
  globalThis.fetch = async (_input, init) => {
    requestSignal.value = required(init).signal;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          bodyStarted();
        },
      }),
      {
        headers: {
          ETag: 'W/"event-1"',
          "X-D1-Bookmark": "bookmark-1",
        },
      },
    );
  };
  const request = readEventSnapshotViaApi("event-1", async () => "token");
  await started;
  const rejection = assert.rejects(
    request,
    (error) =>
      error instanceof GameplayApiError &&
      error.code === "unavailable" &&
      error.message === "Gameplay request timed out.",
  );
  assert.equal(required(requestSignal.value).aborted, false);

  t.mock.timers.runAll();

  await rejection;
  assert.equal(required(requestSignal.value).aborted, true);
});

test("bounds conditional event responses and validates exact read contracts", async () => {
  const assignment = {
    eventId: LEGACY_CORE_PRIZES_EVENT_ID,
    profileId: "profile-1",
    place: 1,
    prizeId: "1092",
    assignedAtMs: 10,
  };
  assert.equal(isEventPrizeAssignmentRecord(assignment), true);
  const futureAssignment = {
    ...assignment,
    eventId: "future-event",
    prizeId: "future-prize",
  };
  assert.equal(isEventPrizeAssignmentWireRecord(futureAssignment), true);
  assert.equal(
    isProfileEventPrizesResponse({
      ok: true,
      profileId: "profile-1",
      revision: 2,
      prizes: {
        [LEGACY_CORE_PRIZES_EVENT_ID]: assignment,
        "future-event": futureAssignment,
      },
    }),
    true,
  );
  assert.equal(
    isProfileEventPrizesResponse({
      ok: true,
      profileId: null,
      revision: 1,
      prizes: {},
    }),
    false,
  );
  assert.equal(
    isEventSnapshotResponse({
      ok: true,
      eventId: "missing-event",
      revision: 0,
      event: null,
      prizeSelections: {},
    }),
    true,
  );
  assert.equal(
    isEventSnapshotResponse({
      ok: true,
      eventId: "missing-event",
      revision: 0,
      event: null,
      prizeSelections: {},
      extra: true,
    }),
    false,
  );
  assert.equal(
    isEventSnapshotResponse({
      ok: true,
      eventId: "future-event",
      revision: 1,
      event: canonicalEvent({ eventId: "future-event" }),
      prizeSelections: { "profile-1": "future-prize" },
    }),
    true,
  );

  globalThis.fetch = async () =>
    new Response("{}", {
      status: 200,
      headers: {
        "Content-Length": String(MAX_EVENT_READ_RESPONSE_BYTES + 1),
        ETag: 'W/"event-1"',
        "X-D1-Bookmark": "bookmark-1",
      },
    });
  await assert.rejects(
    readEventSnapshotViaApi("event-1", async () => "token"),
    (error) =>
      error instanceof GameplayApiError && error.code === "unavailable",
  );
});

test("sends the exact event prize selection mutation", async () => {
  /** @type {({ input: string; init: RequestInit | undefined; })[]} */
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse({
      ok: true,
      eventId: LEGACY_CORE_PRIZES_EVENT_ID,
      selectedPrizeId: "1092",
    });
  };
  /** @type {Parameters<typeof toggleEventPrizeSelectionViaApi>[0]} */
  const request = {
    eventId: LEGACY_CORE_PRIZES_EVENT_ID,
    prizeId: "1092",
  };
  assert.deepEqual(
    await toggleEventPrizeSelectionViaApi(request, async () => "session-token"),
    {
      ok: true,
      eventId: LEGACY_CORE_PRIZES_EVENT_ID,
      selectedPrizeId: "1092",
    },
  );
  assert.equal(
    required(calls[0]).input,
    "https://api.mons.link/events/prize-selections/toggle",
  );
  assert.deepEqual(
    JSON.parse(String(required(required(calls[0]).init).body)),
    request,
  );
  assert.equal(
    new Headers(required(required(calls[0]).init).headers).get("Authorization"),
    "Bearer session-token",
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
  /** @type {({ input: string; init: RequestInit | undefined; })[]} */
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
      async () => "session-token",
    ),
    response,
  );
  assert.equal(
    required(calls[0]).input,
    "https://api.mons.link/invites/role/read",
  );
  assert.deepEqual(JSON.parse(String(required(required(calls[0]).init).body)), {
    inviteId: "abcdefghijk",
  });
  assert.equal(
    new Headers(required(required(calls[0]).init).headers).get("Authorization"),
    "Bearer session-token",
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
      async () => "session-token",
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
  /** @type {({ input: string; init: RequestInit | undefined; })[]} */
  const calls = [];
  const operationIds = [1, 2, 3, 4, 5].map(
    (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  const match = {
    schemaVersion: 1,
    version: 2,
    color: "white",
    emojiId: 7,
    aura: "rainbow",
    gameVariant: "Classic",
    fen: "fen",
    status: "active",
    flatMovesString: "",
    timer: { state: "idle" },
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
      rematches: { state: "open", indices: [1] },
      match,
    },
    {
      ok: true,
      inviteId: "abcdefghijk",
      actorUid: "host",
      rematches: { state: "ended", indices: [1] },
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
  const tokenProvider = async () => "session-token";
  /** @type {import("@mons/shared/game-sessions").GameSessionPresentation} */
  const presentation = { emojiId: 7, aura: "rainbow" };
  const createRequest = {
    operationId: required(operationIds[0]),
    inviteId: "abcdefghijk",
    ...presentation,
  };
  const joinRequest = {
    ...createRequest,
    operationId: required(operationIds[1]),
  };
  const proposeRequest = {
    ...createRequest,
    operationId: required(operationIds[2]),
  };
  const endRequest = {
    operationId: required(operationIds[3]),
    inviteId: "abcdefghijk",
  };
  const ensureRequest = {
    ...createRequest,
    operationId: required(operationIds[4]),
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
  assert.deepEqual(
    (await endRematchViaApi(endRequest, tokenProvider)).rematches,
    { state: "ended", indices: [1] },
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
    calls.map(({ init }) => JSON.parse(String(required(init).body))),
    [createRequest, joinRequest, proposeRequest, endRequest, ensureRequest],
  );
  for (const [
    validator,
    value,
  ] of /** @type {[(value: unknown) => boolean, unknown][]} */ ([
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
        rematches: { state: "open", indices: [1] },
        match,
      },
    ],
    [
      isEndRematchResponse,
      {
        ok: true,
        inviteId: "abcdefghijk",
        actorUid: "host",
        rematches: { state: "ended", indices: [] },
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
  ])) {
    assert.equal(required(validator)(value), true);
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

const submitMoveRequest = {
  inviteId: "abcdefghijk",
  matchId: "abcdefghijk1",
  playerId: "original-player",
  previousFlatMovesString: "first",
  flatMovesString: "first-second",
  fen: "next-fen",
  gameVariant: "Classic",
};
const submitMoveResponse = {
  ok: true,
  inviteId: submitMoveRequest.inviteId,
  matchId: submitMoveRequest.matchId,
  actorUid: submitMoveRequest.playerId,
  outcome: "applied",
};

test("submits authenticated move fields and accepts applied and replay acknowledgements", async () => {
  /** @type {({ input: string; init: RequestInit | undefined; })[]} */
  const calls = [];
  for (const outcome of ["applied", "already-applied"]) {
    const response = { ...submitMoveResponse, outcome };
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return jsonResponse(response);
    };
    assert.deepEqual(
      await submitMoveViaApi(submitMoveRequest, async () => "session-token"),
      response,
    );
  }
  for (const { input, init } of calls) {
    assert.equal(input, "https://api.mons.link/matches/move");
    assert.equal(required(init).method, "POST");
    const headers = new Headers(required(init).headers);
    assert.equal(headers.get("Authorization"), "Bearer session-token");
    assert.equal(required(init).cache, "no-store");
    assert.deepEqual(
      JSON.parse(String(required(init).body)),
      submitMoveRequest,
    );
    assert.equal(headers.get(WAGER_STORAGE_VERSION_HEADER), null);
  }
});

test("invalid move requests and deadlines fail before authentication or transport", async () => {
  let authenticated = false;
  const token = async () => {
    authenticated = true;
    return "token";
  };
  for (const request of [
    { ...submitMoveRequest, status: "surrendered" },
    { ...submitMoveRequest, timer: { state: "idle" } },
    { ...submitMoveRequest, playerId: "" },
    { ...submitMoveRequest, fen: "" },
    { ...submitMoveRequest, flatMovesString: "first" },
    { ...submitMoveRequest, flatMovesString: "unrelated-second" },
  ]) {
    await assert.rejects(
      submitMoveViaApi(request, token),
      (error) =>
        error instanceof GameplayApiError && error.code === "invalid-argument",
    );
  }
  for (const timeoutMs of [0, -1, NaN, Infinity]) {
    await assert.rejects(
      submitMoveViaApi(submitMoveRequest, token, { timeoutMs }),
      (error) =>
        error instanceof GameplayApiError && error.code === "invalid-argument",
    );
  }
  assert.equal(authenticated, false);
});

test("move authentication refresh retains a snapshot of the original append", async () => {
  const body = { ...submitMoveRequest };
  /** @type {unknown[]} */
  const calls = [];
  /** @type {(boolean)[]} */
  const refreshes = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(required(init).body)));
    body.fen = "mutated";
    body.playerId = "changed";
    return calls.length === 1
      ? jsonResponse({ error: "unauthenticated" }, 401)
      : jsonResponse(submitMoveResponse);
  };
  assert.deepEqual(
    await submitMoveViaApi(body, async (refresh) => {
      refreshes.push(refresh);
      return "token";
    }),
    submitMoveResponse,
  );
  assert.deepEqual(refreshes, [false, true]);
  assert.deepEqual(calls, [submitMoveRequest, submitMoveRequest]);
});

test("move checkpoints are copied before pending authentication can mutate the caller's array", async () => {
  const request = {
    ...submitMoveRequest,
    previousStates: [{ moveCount: 1, fen: "base-fen" }],
  };

  /** @type {PromiseWithResolvers<string>} */
  const { promise: token, resolve: resolveToken } = Promise.withResolvers();
  /** @type {unknown[]} */
  const calls = [];
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(required(init).body)));
    return jsonResponse(submitMoveResponse);
  };
  const submitted = submitMoveViaApi(request, () => token);
  required(request.previousStates[0]).fen = "changed-checkpoint";
  request.previousStates.push({ moveCount: 2, fen: "extra" });
  required(resolveToken)("token");
  await submitted;
  assert.ok(isSubmitMoveRequest(calls[0]));
  assert.deepEqual(calls[0].previousStates, [
    { moveCount: 1, fen: "base-fen" },
  ]);
});

test("superseded acknowledgements require checkpoint opt-in and a strict complete history extension", async () => {
  const request = {
    ...submitMoveRequest,
    previousStates: [{ moveCount: 1, fen: "base-fen" }],
  };
  const superseded = {
    ...submitMoveResponse,
    outcome: "superseded",
    fen: "newer-fen",
    flatMovesString: "first-second-third",
  };
  globalThis.fetch = async () => jsonResponse(superseded);
  assert.deepEqual(
    await submitMoveViaApi(request, async () => "token"),
    superseded,
  );
  await assert.rejects(
    submitMoveViaApi(submitMoveRequest, async () => "token"),
    (error) =>
      error instanceof GameplayApiError && error.code === "unavailable",
  );
  for (const history of [
    "first-second",
    "first",
    "first-secondish",
    "unrelated-third",
  ]) {
    globalThis.fetch = async () =>
      jsonResponse({ ...superseded, flatMovesString: history });
    await assert.rejects(
      submitMoveViaApi(request, async () => "token"),
      (error) =>
        error instanceof GameplayApiError && error.code === "unavailable",
    );
  }
});

test("move acknowledgements must match the captured actor and target", async () => {
  for (const response of [
    { ...submitMoveResponse, inviteId: "another-invite" },
    { ...submitMoveResponse, matchId: "abcdefghijk2" },
    { ...submitMoveResponse, actorUid: "another-player" },
    { ...submitMoveResponse, outcome: "unknown" },
    { ok: true },
  ]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return jsonResponse(response);
    };
    await assert.rejects(
      submitMoveViaApi(submitMoveRequest, async () => "token"),
      (error) =>
        error instanceof GameplayApiError && error.code === "unavailable",
    );
    assert.equal(calls, 1);
  }
});

test("move transport preserves conflicts and leaves transient retries to the connection", async () => {
  for (const [
    code,
    message,
    status,
  ] of /** @type {[string, string, number][]} */ ([
    ["aborted", "move-chain-conflict", 409],
    ["failed-precondition", "match-move-blocked", 409],
    ["unavailable", "storage-unavailable", 503],
  ])) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return jsonResponse({ error: code, message }, status);
    };
    await assert.rejects(
      submitMoveViaApi(submitMoveRequest, async () => "token"),
      (error) =>
        error instanceof GameplayApiError &&
        error.code === code &&
        error.message === message,
    );
    assert.equal(calls, 1);
  }
});

test("move transport is bound to the original auth user across token, refresh, and response", async () => {
  for (const phase of ["token", "refresh", "response"]) {
    /** @type {Parameters<typeof createUserBoundAuthTokenProvider>[0] | null} */
    let currentUser;
    const originalUser = {
      uid: "login-alias",
      getIdToken: async () => {
        if (phase === "token")
          currentUser = {
            uid: "login-alias",
            getIdToken: async () =>
              assert.fail("replacement token must not be requested"),
          };
        return "token";
      },
    };
    currentUser = originalUser;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      currentUser = null;
      return phase === "refresh"
        ? jsonResponse({ error: "unauthenticated" }, 401)
        : jsonResponse(submitMoveResponse);
    };
    await assert.rejects(
      submitMoveViaApi(
        submitMoveRequest,
        createUserBoundAuthTokenProvider(originalUser, () => currentUser),
      ),
      /authentication-changed/,
    );
    assert.equal(calls, phase === "token" ? 0 : 1);
  }
});

test("move deadlines cover authentication and a pending response, and abort local transport", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  /** @type {{ value?: (AbortSignal | null | undefined) }} */
  const signal = {};
  globalThis.fetch = (_input, init) => {
    calls++;
    signal.value = required(init).signal;
    return new Promise(() => {});
  };
  for (const provider of [() => new Promise(() => {}), async () => "token"]) {
    const sent = submitMoveViaApi(submitMoveRequest, provider, {
      timeoutMs: 800,
    });
    const rejected = assert.rejects(sent, /Gameplay request timed out/);
    await Promise.resolve();
    t.mock.timers.tick(800);
    await rejected;
  }
  assert.equal(calls, 1);
  assert.equal(required(signal.value).aborted, true);
});

test("move cancellation prevents transport during pending authentication", async () => {
  const controller = new AbortController();

  /** @type {PromiseWithResolvers<string>} */
  const { promise: token, resolve: resolveToken } = Promise.withResolvers();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse(submitMoveResponse);
  };
  const sent = submitMoveViaApi(submitMoveRequest, () => token, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(
    sent,
    (error) => error instanceof GameplayApiError && error.code === "aborted",
  );
  required(resolveToken)("token");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 0);
});

const surrenderRequest = {
  inviteId: "abcdefghijk",
  matchId: "abcdefghijk1",
  playerId: "original-player",
};
const surrenderResponse = {
  ok: true,
  inviteId: surrenderRequest.inviteId,
  matchId: surrenderRequest.matchId,
  actorUid: surrenderRequest.playerId,
};

test("sends only surrender identity through authenticated API requests and accepts duplicate success", async () => {
  /** @type {({ input: string; init: RequestInit | undefined; })[]} */
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return jsonResponse(surrenderResponse);
  };
  assert.equal(isSurrenderMatchRequest(surrenderRequest), true);
  assert.equal(isSurrenderMatchResponse(surrenderResponse), true);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(
      await surrenderMatchViaApi(surrenderRequest, async () => "session-token"),
      surrenderResponse,
    );
  }
  for (const { input, init } of calls) {
    assert.equal(input, "https://api.mons.link/matches/surrender");
    assert.equal(required(init).method, "POST");
    const headers = new Headers(required(init).headers);
    assert.equal(headers.get("Authorization"), "Bearer session-token");
    assert.equal(required(init).cache, "no-store");
    assert.deepEqual(JSON.parse(String(required(init).body)), surrenderRequest);
    assert.equal(headers.get(WAGER_STORAGE_VERSION_HEADER), null);
  }
  for (const request of [
    { ...surrenderRequest, playerId: "" },
    { ...surrenderRequest, playerId: " original-player" },
    { ...surrenderRequest, status: "surrendered" },
    { ...surrenderRequest, fen: "client-fen" },
  ]) {
    assert.equal(isSurrenderMatchRequest(request), false);
    await assert.rejects(
      surrenderMatchViaApi(request, async () => "session-token"),
      (error) =>
        error instanceof GameplayApiError && error.code === "invalid-argument",
    );
  }
  assert.equal(calls.length, 2);
});

test("surrender refreshes authentication once while retaining the original target", async () => {
  /** @type {(boolean)[]} */
  const tokens = [];
  /** @type {unknown[]} */
  const requests = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(required(init).body)));
    return requests.length === 1
      ? jsonResponse({ error: "unauthenticated" }, 401)
      : jsonResponse(surrenderResponse);
  };
  assert.deepEqual(
    await surrenderMatchViaApi(surrenderRequest, async (forceRefresh) => {
      tokens.push(forceRefresh);
      return "session-token";
    }),
    surrenderResponse,
  );
  assert.deepEqual(tokens, [false, true]);
  assert.deepEqual(requests, [surrenderRequest, surrenderRequest]);
});

test("surrender rejects malformed or mismatched success without retrying", async () => {
  for (const response of [
    { ...surrenderResponse, inviteId: "another-invite" },
    { ...surrenderResponse, matchId: "abcdefghijk2" },
    { ...surrenderResponse, actorUid: "another-player" },
    { ...surrenderResponse, actorUid: "" },
    { ok: true },
  ]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse(response);
    };
    await assert.rejects(
      surrenderMatchViaApi(surrenderRequest, async () => "session-token"),
      (error) =>
        error instanceof GameplayApiError && error.code === "unavailable",
    );
    assert.equal(calls, 1);
  }
});

test("surrender preserves backend failures and does not retry an uncertain submission", async () => {
  for (const failure of [
    () => {
      throw new Error("network-lost");
    },
    () => jsonResponse({ error: "unavailable" }, 503),
    () =>
      jsonResponse(
        { error: "failed-precondition", message: "match-ended" },
        409,
      ),
  ]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return failure();
    };
    await assert.rejects(
      surrenderMatchViaApi(surrenderRequest, async () => "session-token"),
      GameplayApiError,
    );
    assert.equal(calls, 1);
  }
});

test("surrender remains bound to the original user before transport, on token refresh, and after response", async () => {
  for (const phase of ["token", "refresh", "response"]) {
    /** @type {Parameters<typeof createUserBoundAuthTokenProvider>[0] | null} */
    let currentUser;
    const originalUser = {
      uid: "login-alias",
      getIdToken: async () => {
        if (phase === "token")
          currentUser = {
            uid: "login-alias",
            getIdToken: async () =>
              assert.fail("replacement token must not be requested"),
          };
        return "session-token";
      },
    };
    currentUser = originalUser;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      currentUser = null;
      return phase === "refresh"
        ? jsonResponse({ error: "unauthenticated" }, 401)
        : jsonResponse(surrenderResponse);
    };
    await assert.rejects(
      surrenderMatchViaApi(
        surrenderRequest,
        createUserBoundAuthTokenProvider(originalUser, () => currentUser),
      ),
      /authentication-changed/,
    );
    assert.equal(calls, phase === "token" ? 0 : 1);
  }
});

test("surrender applies the existing deadline to authentication and a pending response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  /** @type {{ value?: (AbortSignal | null | undefined) }} */
  const requestSignal = {};
  globalThis.fetch = (_input, init) => {
    calls += 1;
    requestSignal.value = required(init).signal;
    return new Promise(() => {});
  };
  for (const tokenProvider of [
    () => new Promise(() => {}),
    async () => "session-token",
  ]) {
    const request = surrenderMatchViaApi(surrenderRequest, tokenProvider);
    const rejected = assert.rejects(request, /Gameplay request timed out/);
    await Promise.resolve();
    t.mock.timers.tick(30_000);
    await rejected;
  }
  assert.equal(calls, 1);
  assert.equal(required(requestSignal.value).aborted, true);
});

test("accepts the largest valid ensured match response", async () => {
  const match = {
    schemaVersion: 1,
    version: 2,
    color: "white",
    emojiId: 1,
    aura: "none",
    gameVariant: "Classic",
    fen: "\u0000".repeat(MAX_MATCH_FEN_BYTES),
    status: "active",
    flatMovesString: "\u0000".repeat(MAX_MATCH_HISTORY_BYTES),
    timer: {
      state: "running",
      turnNumber: Number.MAX_SAFE_INTEGER,
      deadlineAtMs: Number.MAX_SAFE_INTEGER,
    },
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
          aura: "none",
        },
        async () => "session-token",
      )
    ).match.flatMovesString.length,
    MAX_MATCH_HISTORY_BYTES,
  );
});

test("retries busy and ambiguous failures with the same operation ID", async () => {
  /** @type {unknown[]} */
  const bodies = [];
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    bodies.push(JSON.parse(String(required(init).body)));
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
  /** @type {import("@mons/shared/game-sessions").CreateInviteRequest} */
  const request = {
    operationId: "00000000-0000-4000-8000-000000000001",
    inviteId: "abcdefghijk",
    emojiId: 7,
    aura: "rainbow",
  };
  await createInviteViaApi(request, async () => "session-token");
  assert.equal(calls, 3);
  assert.deepEqual(bodies, [request, request, request]);
});

test("end transport leaves busy and unavailable retries to the durable delivery", async () => {
  for (const [
    status,
    error,
    message,
  ] of /** @type {[number, string, string][]} */ ([
    [409, "aborted", "invite-busy"],
    [503, "unavailable", "gameplay-service-unavailable"],
  ])) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return jsonResponse({ error, message }, status);
    };
    await assert.rejects(
      endRematchViaApi(
        {
          inviteId: "abcdefghijk",
          operationId: "00000000-0000-4000-8000-000000000001",
        },
        async () => "token",
      ),
      (value) => value instanceof GameplayApiError && value.message === message,
    );
    assert.equal(calls, 1);
  }
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
      async () => "session-token",
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
  /** @type {PromiseWithResolvers<string>} */
  const { promise: token, resolve: resolveToken } = Promise.withResolvers();
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
  required(resolveToken)("first-token");
  queueMicrotask(() => {
    currentUser = secondUser;
  });
  await assert.rejects(request, /authentication-changed/);
  assert.equal(fetches, 0);
});

test("does not return a structural mutation after authentication changes", async () => {
  /** @type {PromiseWithResolvers<Response>} */
  const { promise: response, resolve: resolveResponse } =
    Promise.withResolvers();

  /** @type {PromiseWithResolvers<void>} */
  const { promise: started, resolve: requestStarted } = Promise.withResolvers();
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
  required(resolveResponse)(
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
  /** @type {({ input: string; init: RequestInit | undefined; })[]} */
  const calls = [];
  /** @type {(number)[]} */
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
    await updateRatingsViaApi(request, async () => "session-token", {
      now: () => now,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
    }),
    { ok: true },
  );
  assert.equal(calls.length, 2);
  assert.equal(
    required(calls[0]).input,
    "https://api.mons.link/ratings/update",
  );
  assert.deepEqual(
    JSON.parse(String(required(required(calls[0]).init).body)),
    request,
  );
  assert.equal(
    new Headers(required(required(calls[0]).init).headers).get("Authorization"),
    "Bearer session-token",
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
      return "session-token";
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
      async () => "session-token",
    ),
    { ok: true },
  );
  assert.equal(fetches, 2);
});

test("bounds a busy rating retry to one 60-second deadline", async () => {
  let fetches = 0;
  let now = 1_000;
  /** @type {(number)[]} */
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
    async () => "session-token",
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

test("leaves events with an authenticated self-only request and matching response", async () => {
  /** @type {({ input: URL | RequestInfo; init: RequestInit | undefined; })[]} */
  const calls = [];
  const response = {
    ok: true,
    eventId: "event-1",
    removedProfileId: "profile-1",
  };
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    return jsonResponse(response);
  };
  assert.deepEqual(
    await leaveEventViaApi({ eventId: "event-1" }, async () => "session-token"),
    response,
  );
  assert.equal(
    required(calls[0]).input,
    "https://api.mons.link/events/participants/leave",
  );
  assert.equal(required(required(calls[0]).init).method, "POST");
  assert.equal(
    new Headers(required(required(calls[0]).init).headers).get("Authorization"),
    "Bearer session-token",
  );
  assert.deepEqual(JSON.parse(String(required(required(calls[0]).init).body)), {
    eventId: "event-1",
  });

  for (const invalidResponse of [
    { ...response, eventId: "different-event" },
    { ...response, removedProfileId: "" },
    { ok: true, eventId: "event-1" },
  ]) {
    globalThis.fetch = async () => jsonResponse(invalidResponse);
    await assert.rejects(
      leaveEventViaApi({ eventId: "event-1" }, async () => "session-token"),
      (error) =>
        error instanceof GameplayApiError && error.code === "unavailable",
    );
  }
});

test("sends exact authenticated gameplay mutations and validates contracts", async () => {
  /** @type {({ input: string; init: RequestInit | undefined; })[]} */
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
    {
      ok: true,
      timer: { state: "running", turnNumber: 4, deadlineAtMs: 1000 },
      duration: 90000,
    },
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
      {
        emojiId: 7,
        aura: "rainbow",
      },
      async () => "session-token",
      AUTOMATCH_OPERATION_ID,
    ),
    {
      ok: true,
      inviteId: "auto_invite",
      mode: "pending",
      matchedImmediately: false,
    },
  );
  assert.deepEqual(await cancelAutomatchViaApi(async () => "session-token"), {
    ok: true,
  });
  assert.deepEqual(
    await removeNavigationGameViaApi(
      { inviteId: "invite-1" },
      async () => "session-token",
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
    async () => "session-token",
  );
  assert.equal(isReadNavigationGamesRequest(readRequest), true);
  assert.equal(isReadNavigationGamesResponse(readResponse), true);
  assert.equal(required(readResponse.items[0]).id, "invite-1");
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
    await joinEventViaApi({ eventId: "event-1" }, async () => "session-token"),
    { ok: true, eventId: "event-1", participant },
  );
  assert.deepEqual(
    await removeEventParticipantViaApi(
      { eventId: "event-1", participantProfileId: "profile-2" },
      async () => "session-token",
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
      async () => "session-token",
    ),
    {
      ok: true,
      timer: { state: "running", turnNumber: 4, deadlineAtMs: 1000 },
      duration: 90000,
    },
  );
  assert.deepEqual(
    await claimMatchVictoryByTimerViaApi(
      {
        playerId: "player-1",
        opponentId: "player-2",
        matchId: "match-1",
        inviteId: "match-1",
      },
      async () => "session-token",
    ),
    { ok: true },
  );
  assert.deepEqual(
    await cancelWagerProposalViaApi(
      { inviteId: "invite-1", matchId: "match-1" },
      async () => "session-token",
    ),
    { ok: true },
  );
  assert.deepEqual(
    await declineWagerProposalViaApi(
      { inviteId: "invite-1", matchId: "match-1" },
      async () => "session-token",
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
      async () => "session-token",
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
      async () => "session-token",
    ),
    { ok: true, count: 2 },
  );
  assert.deepEqual(
    await resolveWagerOutcomeViaApi(
      { inviteId: "invite-1", matchId: "match-1" },
      async () => "session-token",
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
      `https://api.mons.link/automatch/start?operationId=${AUTOMATCH_OPERATION_ID}&bootstrap=1`,
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
    calls.map((call) => JSON.parse(String(required(call.init).body))),
    [
      {
        emojiId: 7,
        aura: "rainbow",
      },
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
    assert.equal(required(call.init).method, "POST");
    assert.equal(required(call.init).cache, "no-store");
    assert.ok(required(call.init).signal instanceof AbortSignal);
    const headers = new Headers(required(call.init).headers);
    assert.equal(headers.get("Accept"), "application/json");
    assert.equal(headers.get("Authorization"), "Bearer session-token");
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.equal(
      headers.get(WAGER_STORAGE_VERSION_HEADER),
      String(call.input).includes("/wagers/") ? WAGER_STORAGE_VERSION : null,
    );
  }
  await assert.rejects(
    startAutomatchViaApi(
      { emojiId: 7, aura: "rainbow" },
      async () => "session-token",
      "invalid",
    ),
    (error) =>
      error instanceof GameplayApiError && error.code === "invalid-argument",
  );

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
      aura: "none",
    }),
    true,
  );
  assert.equal(
    isStartAutomatchRequest({
      emojiId: Number.MAX_SAFE_INTEGER + 1,
      aura: "none",
    }),
    false,
  );
  assert.equal(
    isStartAutomatchRequest({
      emojiId: 7,
      aura: "none",
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
  assert.equal(isLeaveEventRequest({ eventId: "event-1" }), true);
  for (const request of [
    {},
    { eventId: "" },
    { eventId: "bad/event" },
    { eventId: "event-1", participantProfileId: "profile-2" },
    { eventId: "event-1", extra: true },
  ]) {
    assert.equal(isLeaveEventRequest(request), false);
  }
  const leaveResponse = {
    ok: true,
    eventId: "event-1",
    removedProfileId: "profile-1",
  };
  assert.equal(isLeaveEventResponse(leaveResponse), true);
  for (const response of [
    { ...leaveResponse, ok: false },
    { ...leaveResponse, eventId: "bad/event" },
    { ...leaveResponse, removedProfileId: "" },
    { ...leaveResponse, removedProfileId: "bad/profile" },
    { ok: true, eventId: "event-1" },
  ]) {
    assert.equal(isLeaveEventResponse(response), false);
  }
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
      timer: { state: "running", turnNumber: 4, deadlineAtMs: 1000 },
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
      timer: { state: "running", turnNumber: 4, deadlineAtMs: 1000 },
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
    false,
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

test("refreshes the session token once after a 401", async () => {
  /** @type {(boolean)[]} */
  const refreshes = [];
  /** @type {(string | null)[]} */
  const tokens = [];
  globalThis.fetch = async (_input, init) => {
    tokens.push(new Headers(required(init).headers).get("Authorization"));
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
  globalThis.fetch = async () => required(responses.shift());
  await assert.rejects(
    startAutomatchViaApi(
      { emojiId: 1, aura: "none" },
      async () => "token",
      AUTOMATCH_OPERATION_ID,
    ),
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

test("automatch opts into a fresh bootstrap while keeping legacy receipts exact", async () => {
  const bootstrap = automatchBootstrap();
  const legacy = {
    ok: true,
    inviteId: bootstrap.metadata.inviteId,
    mode: "matched",
    matchedImmediately: true,
  };
  const enriched = { ...legacy, bootstrap };
  assert.equal(isStartAutomatchResponse(legacy), true);
  assert.equal(isStartAutomatchResponse(enriched), false);
  for (const payload of [legacy, enriched]) {
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(String(url)).searchParams.get("bootstrap"), "1");
      assert.equal(
        new URL(String(url)).searchParams.get("operationId"),
        AUTOMATCH_OPERATION_ID,
      );
      assert.deepEqual(JSON.parse(String(required(init).body)), {
        emojiId: 1,
        aura: "none",
      });
      return jsonResponse(payload);
    };
    assert.deepEqual(
      await startAutomatchViaApi(
        { emojiId: 1, aura: "none" },
        async () => "token",
        AUTOMATCH_OPERATION_ID,
      ),
      payload,
    );
  }
});

test("invalid optional automatch bootstraps preserve successful mutations", async () => {
  const bootstrap = automatchBootstrap();
  const legacy = {
    ok: true,
    inviteId: bootstrap.metadata.inviteId,
    mode: "matched",
    matchedImmediately: true,
  };
  const invalid = [
    null,
    {},
    { ...bootstrap, metadata: { ...bootstrap.metadata, inviteId: "other" } },
    { ...bootstrap, match: { ...bootstrap.match, guestMatch: null } },
    {
      ...bootstrap,
      viewer: { ...bootstrap.viewer, role: "watch", actorUid: null },
    },
    {
      ...bootstrap,
      viewer: {
        ...bootstrap.viewer,
        automatchOperationId: "00000000-0000-4000-8000-000000000002",
      },
    },
  ];
  for (const value of invalid) {
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return jsonResponse({ ...legacy, bootstrap: value });
    };
    assert.deepEqual(
      await startAutomatchViaApi(
        { emojiId: 1, aura: "none" },
        async () => "token",
        AUTOMATCH_OPERATION_ID,
      ),
      legacy,
    );
    assert.equal(requests, 1);
  }
  assert.equal(
    parseStartAutomatchApiResponse({ ...legacy, unexpected: true }),
    null,
  );
  const pending = { ...legacy, mode: "pending", matchedImmediately: false };
  assert.deepEqual(
    parseStartAutomatchApiResponse({ ...pending, bootstrap }),
    pending,
  );
});

test("only automatch uses the larger bootstrap response budget", async () => {
  const bootstrap = automatchBootstrap();
  const legacy = {
    ok: true,
    inviteId: bootstrap.metadata.inviteId,
    mode: "matched",
    matchedImmediately: true,
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ...legacy, bootstrap }), {
      headers: {
        "Content-Length": String(MAX_GAME_SESSION_RESPONSE_BYTES + 1),
      },
    });
  assert.deepEqual(
    await startAutomatchViaApi(
      { emojiId: 1, aura: "none" },
      async () => "token",
      AUTOMATCH_OPERATION_ID,
    ),
    { ...legacy, bootstrap },
  );
  globalThis.fetch = async () =>
    new Response("{}", {
      headers: {
        "Content-Length": String(AUTOMATCH_API_MAX_RESPONSE_BYTES + 1),
      },
    });
  await assert.rejects(
    startAutomatchViaApi(
      { emojiId: 1, aura: "none" },
      async () => "token",
      AUTOMATCH_OPERATION_ID,
    ),
    GameplayApiError,
  );
  globalThis.fetch = async () =>
    new Response('{"ok":true}', {
      headers: {
        "Content-Length": String(MAX_GAME_SESSION_RESPONSE_BYTES + 1),
      },
    });
  await assert.rejects(
    cancelAutomatchViaApi(async () => "token"),
    GameplayApiError,
  );
});

test("gameplay mutation authentication initializes before checking the bound user", async () => {
  /** @type {(string)[]} */
  const sequence = [];
  const tokenProvider = createPollingAuthTokenProvider({
    ensureAuthenticated: async () => {
      sequence.push("authenticate");
    },
    getUserBoundProvider: () =>
      Object.assign(
        async () => {
          sequence.push("token");
          return "token";
        },
        { assertCurrentUser: () => sequence.push("guard") },
      ),
    isSessionCurrent: () => true,
  });
  globalThis.fetch = async () => {
    sequence.push("fetch");
    return jsonResponse({ ok: true });
  };
  assert.deepEqual(await cancelAutomatchViaApi(tokenProvider), { ok: true });
  assert.deepEqual(sequence, [
    "authenticate",
    "token",
    "guard",
    "fetch",
    "guard",
  ]);
});

test("gameplay mutations retain their streamed limit for a nonfinite declared length", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Length": "Infinity" },
    });
  assert.deepEqual(await cancelAutomatchViaApi(async () => "token"), {
    ok: true,
  });
  globalThis.fetch = async () =>
    new Response(" ".repeat(MAX_GAME_SESSION_RESPONSE_BYTES + 1), {
      headers: { "Content-Length": "Infinity" },
    });
  await assert.rejects(
    cancelAutomatchViaApi(async () => "token"),
    {
      name: "GameplayApiError",
      code: "unavailable",
      message: "Gameplay service is unavailable.",
    },
  );
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

  /** @type {{ value?: (AbortSignal | null | undefined) }} */
  const signal = {};

  /** @type {PromiseWithResolvers<void>} */
  const { promise: started, resolve: bodyStarted } = Promise.withResolvers();
  globalThis.fetch = async (_input, init) => {
    signal.value = required(init).signal;
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
  assert.equal(required(signal.value).aborted, false);
  t.mock.timers.runAll();
  await bodyRejection;
  assert.equal(required(signal.value).aborted, true);
});
