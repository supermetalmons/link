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
  createEventViaApi,
  declineWagerProposalViaApi,
  disqualifyEventMatchWinnersViaApi,
  joinEventViaApi,
  removeEventParticipantViaApi,
  removeNavigationGameViaApi,
  resolveWagerOutcomeViaApi,
  sendWagerProposalViaApi,
  startAutomatchViaApi,
  startMatchTimerViaApi,
  syncEventStateViaApi,
  updateRatingsViaApi,
  postponeEventStartViaApi,
} = await import("../src/services/gameplayApi.ts");
const { isRatingUpdateRequest, isRatingUpdateResponse } =
  await import("@mons/shared/ratings");
const {
  isCancelAutomatchResponse,
  isRemoveNavigationGameRequest,
  isRemoveNavigationGameResponse,
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

const originalFetch = globalThis.fetch;

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test.afterEach(() => {
  globalThis.fetch = originalFetch;
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
