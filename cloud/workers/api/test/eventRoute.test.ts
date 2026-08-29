import assert from "node:assert/strict";
import test from "node:test";
import type { EventLockManager } from "../../../functions/events/lockManagerCore.js";
import { LEGACY_CORE_PRIZES_EVENT_ID } from "@mons/shared/event-prizes";
import { AuthApiFailure } from "../src/authErrors.ts";
import { handleEventRoute } from "../src/eventRoute.ts";
import { EVENT_CONTROL_TIMEOUT_MS } from "../src/eventOperations.ts";
import { EVENT_OPERATION_TIMEOUT_MS } from "../src/eventParticipation.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";
import { TELEGRAM_TEST_ENV, withProfileControl } from "./testEnv.ts";

const identity = {
  uid: "creator-login",
  idToken: "firebase-token",
  profileId: "creator-profile",
};

const participant = {
  profileId: "creator-profile",
  loginUid: "creator-login",
  username: "creator",
  displayName: "creator",
  emojiId: 7,
  aura: "rainbow",
  joinedAtMs: 1,
  state: "active",
  eliminatedRoundIndex: null,
  eliminatedByProfileId: null,
};

const lockHandle = {
  eventId: "event-1",
  path: "eventLocks/event-1",
  lockId: "lock-1",
  ownerUid: identity.uid,
  lockRoot: "eventLocks",
};

const lockManager: EventLockManager = {
  acquireEventLock: async () => lockHandle,
  acquireEventLockWithRetry: async () => lockHandle,
  getEventLockGuard: () => ({
    lockRoot: "eventLocks",
    eventId: "event-1",
    lockId: "lock-1",
    ownerUid: identity.uid,
  }),
  isEventLockStillOwned: async () => true,
  refreshEventLock: async () => true,
  releaseEventLock: async () => true,
  startEventLockHeartbeat: () => () => undefined,
};

function createRepository(): GameplayRepository {
  return {
    applyWagerTransferOnce: async () => "applied",
    deleteNavigationGame: async () => "deleted",
    findProfileId: async () => identity.profileId,
    getGameplayProfile: async () => ({
      profileId: identity.profileId,
      username: "creator",
      eth: "",
      sol: "",
      rating: 1500,
      emoji: 7,
      aura: "rainbow",
    }),
    getNavigationGame: async () => null,
    getMiningMaterials: async () => ({
      dust: 0,
      slime: 0,
      gum: 0,
      metal: 0,
      ice: 0,
    }),
    getMiningSnapshot: async () => null,
    getRtdbPath: async (path) =>
      path === "events/event-1"
        ? {
            eventId: "event-1",
            status: "scheduled",
            startAtMs: 10_000,
            createdByLoginUid: identity.uid,
            createdByProfileId: identity.profileId,
            participants: { [identity.profileId]: participant },
          }
        : null,
    patchRtdbRoot: async () => undefined,
    transactRtdbPath: async () => ({ committed: false, value: null }),
  };
}

const ctx = { waitUntil: () => undefined };

test("serves authenticated event CORS preflight", async () => {
  const response = await handleEventRoute(
    new Request("https://api.mons.link/events/participants/join", {
      method: "OPTIONS",
      headers: { Origin: "https://mons.link" },
    }),
    TELEGRAM_TEST_ENV,
    ctx,
  );
  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://mons.link",
  );
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("authenticates before parsing event request bodies", async () => {
  const response = await handleEventRoute(
    new Request("https://api.mons.link/events/participants/join", {
      method: "POST",
      headers: {
        Origin: "https://mons.link",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
    TELEGRAM_TEST_ENV,
    ctx,
    {
      verifyIdentity: async () => {
        throw new AuthApiFailure(
          401,
          "unauthenticated",
          "authentication-required",
        );
      },
    },
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "unauthenticated",
    message: "authentication-required",
  });
});

test("freezes every authenticated event mutation before parsing", async () => {
  const frozenEnv = withProfileControl(
    TELEGRAM_TEST_ENV as unknown as Env,
    "frozen",
  );
  for (const path of [
    "/events/create",
    "/events/matches/winners/disqualify",
    "/events/participants/join",
    "/events/participants/remove",
    "/events/prize-selections/toggle",
    "/events/start/postpone",
    "/events/state/sync",
  ]) {
    const request = new Request(`https://api.mons.link${path}`, {
      method: "POST",
      headers: {
        Origin: "https://mons.link",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const response = await handleEventRoute(request, frozenEnv, ctx, {
      verifyIdentity: async () => identity,
    });
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get("Retry-After"), "60", path);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "unavailable",
      message: "profile-writes-disabled",
    });
    assert.equal(request.bodyUsed, false, path);
  }
});

test("rejects wrong methods and strict-body violations", async () => {
  const wrongMethod = await handleEventRoute(
    new Request("https://api.mons.link/events/participants/join"),
    TELEGRAM_TEST_ENV,
    ctx,
  );
  assert.equal(wrongMethod.status, 405);

  const invalidBody = await handleEventRoute(
    new Request("https://api.mons.link/events/participants/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: "event-1", extra: true }),
    }),
    TELEGRAM_TEST_ENV,
    ctx,
    { verifyIdentity: async () => identity },
  );
  assert.equal(invalidBody.status, 400);
});

test("keeps participation and event-control deadlines separate", async () => {
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(
    AbortSignal,
    "timeout",
  );
  const timeouts: number[] = [];
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value(milliseconds: number) {
      timeouts.push(milliseconds);
      return new AbortController().signal;
    },
  });
  try {
    for (const pathname of [
      "/events/participants/join",
      "/events/prize-selections/toggle",
      "/events/create",
    ]) {
      const response = await handleEventRoute(
        new Request(`https://api.mons.link${pathname}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
        TELEGRAM_TEST_ENV,
        ctx,
        { verifyIdentity: async () => identity },
      );
      assert.equal(response.status, 400);
    }
  } finally {
    if (timeoutDescriptor) {
      Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor);
    }
  }
  assert.deepEqual(timeouts, [
    EVENT_OPERATION_TIMEOUT_MS,
    EVENT_OPERATION_TIMEOUT_MS,
    EVENT_CONTROL_TIMEOUT_MS,
  ]);
  assert.equal(EVENT_OPERATION_TIMEOUT_MS, 25_000);
  assert.equal(EVENT_CONTROL_TIMEOUT_MS, 30_000);
});

test("returns strict join and removal responses", async () => {
  const background: Promise<unknown>[] = [];
  const routeCtx = {
    waitUntil(promise: Promise<unknown>) {
      background.push(promise);
    },
  };
  const dependencies = {
    verifyIdentity: async () => identity,
    repository: createRepository(),
    participation: {
      lockManager,
      now: () => 100,
      buildDueUpdates: async () => ({ didChange: false, updates: {} }),
    },
  };
  const join = await handleEventRoute(
    new Request("https://api.mons.link/events/participants/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: "event-1" }),
    }),
    TELEGRAM_TEST_ENV,
    routeCtx,
    dependencies,
  );
  assert.equal(join.status, 200);
  assert.deepEqual(await join.json(), {
    ok: true,
    eventId: "event-1",
    participant: { ...participant, joinedAtMs: 1 },
  });

  const removal = await handleEventRoute(
    new Request("https://api.mons.link/events/participants/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: "event-1",
        participantProfileId: "target-profile",
      }),
    }),
    TELEGRAM_TEST_ENV,
    routeCtx,
    {
      ...dependencies,
      repository: {
        ...createRepository(),
        getRtdbPath: async () => ({
          eventId: "event-1",
          status: "scheduled",
          startAtMs: 10_000,
          createdByLoginUid: identity.uid,
          createdByProfileId: identity.profileId,
          participants: {
            [identity.profileId]: participant,
            "target-profile": {
              ...participant,
              profileId: "target-profile",
              loginUid: "target-login",
            },
          },
        }),
      },
    },
  );
  assert.equal(removal.status, 200);
  assert.deepEqual(await removal.json(), {
    ok: true,
    eventId: "event-1",
    removedProfileId: "target-profile",
  });
  assert.equal(background.length, 6);
  await Promise.all(background);
});

test("returns a strict event prize selection response", async () => {
  const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
  const repository = createRepository();
  repository.getRtdbPath = async (path) =>
    path === `events/${eventId}`
      ? {
          eventId,
          status: "active",
          participants: { [identity.profileId]: participant },
        }
      : null;
  repository.transactRtdbPath = async (_path, updater) => {
    const decision = updater(null);
    assert.ok(decision && typeof decision === "object" && "value" in decision);
    return { committed: true, value: decision.value };
  };
  const response = await handleEventRoute(
    new Request("https://api.mons.link/events/prize-selections/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId, prizeId: "1092" }),
    }),
    TELEGRAM_TEST_ENV,
    ctx,
    {
      verifyIdentity: async () => identity,
      repository,
      participation: { lockManager },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    eventId,
    selectedPrizeId: "1092",
  });
});

test("rejects malformed event prize selections after authentication", async () => {
  for (const body of [
    {},
    { eventId: LEGACY_CORE_PRIZES_EVENT_ID, prizeId: "invalid" },
    {
      eventId: LEGACY_CORE_PRIZES_EVENT_ID,
      prizeId: "1092",
      extra: true,
    },
  ]) {
    const response = await handleEventRoute(
      new Request("https://api.mons.link/events/prize-selections/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      TELEGRAM_TEST_ENV,
      ctx,
      { verifyIdentity: async () => identity },
    );
    assert.equal(response.status, 400);
  }
});

test("registers the complete mutation before it settles", async () => {
  let finishPatch: () => void = () => undefined;
  const patchGate = new Promise<void>((resolve) => {
    finishPatch = resolve;
  });
  let registeredPromise: Promise<unknown> | undefined;
  let markRegistered: () => void = () => undefined;
  const registered = new Promise<void>((resolve) => {
    markRegistered = resolve;
  });
  const repository = createRepository();
  repository.patchRtdbRoot = () => patchGate;
  const responsePromise = handleEventRoute(
    new Request("https://api.mons.link/events/participants/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: "event-1" }),
    }),
    TELEGRAM_TEST_ENV,
    {
      waitUntil(promise) {
        registeredPromise = promise;
        markRegistered();
      },
    },
    {
      verifyIdentity: async () => identity,
      repository,
      participation: {
        lockManager,
        now: () => 100,
        buildDueUpdates: async () => ({ didChange: false, updates: {} }),
      },
    },
  );
  await registered;
  assert.ok(registeredPromise);
  finishPatch();
  assert.equal((await responsePromise).status, 200);
  await registeredPromise;
});
