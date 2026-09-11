import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  runInDurableObject,
  type D1Migration,
} from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Game } from "mons-rules";
import { createEmptyMaterials } from "@mons/shared/mining";
import type { CompletePlayerProfile } from "@mons/shared/profiles";
import {
  normalizeMatchSnapshot,
  type ReadMatchSnapshotResponse,
} from "@mons/shared/game-sessions";
import {
  MATCH_TIMER_TERMINAL,
  parseStrictMatchTimer,
} from "@mons/shared/timers";
import {
  createGameplayRepository,
  createRatingRepository,
} from "../src/gameplayRepository.ts";
import { createEventGameplayRepository } from "../src/eventRepository.ts";
import { handleGameplayRoute } from "../src/gameplayRoute.ts";
import { handleMatchSnapshotRoute } from "../src/matchSnapshotRoute.ts";
import { readMatchStateRoute } from "../src/matchStateD1.ts";
import { getMatchStateRpc, unwrapMatchStateRpc } from "../src/matchStateRpc.ts";
import { resolveMatchTimerGame } from "../src/matchTimer.ts";
import { readEventSnapshot } from "../src/eventD1.ts";
import {
  commitCanonicalPlan,
  materializeCanonicalProfile,
} from "../src/profileCanonicalD1.ts";
import { handleProfileGameProjectionMessage } from "../src/profileGameProjection.ts";
import { readHistoricalMatch } from "../src/historicalMatchRoute.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { resetEventReceiptTestState } from "./eventTransitionTestFixture.ts";
import { resetMatchPresentationTestState } from "./matchPresentationTestFixture.ts";
import { TELEGRAM_TEST_ENV } from "../test/testEnv.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
};
const db = env.PROFILE_GAMES_DB;
const rooms = new Set<string>();
const forbidden = new Set([
  "FIREBASE_RTDB_URL",
  "GAMEPLAY_SERVICE_ACCOUNT_EMAIL",
  "GAMEPLAY_SERVICE_ACCOUNT_PRIVATE_KEY",
]);

function runtime() {
  const credentialReads: string[] = [];
  const workerEnv = new Proxy(
    {
      ...env,
      AUTH_RATE_LIMITER: TELEGRAM_TEST_ENV.AUTH_RATE_LIMITER,
      MOVE_RATE_LIMITER: TELEGRAM_TEST_ENV.MOVE_RATE_LIMITER,
      PROFILE_GAME_PROJECTION_QUEUE:
        TELEGRAM_TEST_ENV.PROFILE_GAME_PROJECTION_QUEUE,
      TELEGRAM_PROJECTION_QUEUE: TELEGRAM_TEST_ENV.TELEGRAM_PROJECTION_QUEUE,
      TELEGRAM_DELIVERY_QUEUE: TELEGRAM_TEST_ENV.TELEGRAM_DELIVERY_QUEUE,
      WAGER_SETTLEMENT_QUEUE: TELEGRAM_TEST_ENV.WAGER_SETTLEMENT_QUEUE,
    },
    {
      get(target, property, receiver) {
        if (typeof property === "string" && forbidden.has(property)) {
          credentialReads.push(property);
          throw new Error(`retired-firebase-credential:${property}`);
        }
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("unexpected-outbound-fetch"));
  const post = async (uid: string, path: string, body: unknown) => {
    const background: Promise<unknown>[] = [];
    const response = await handleGameplayRoute(
      new Request(`https://api.mons.link${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://mons.link",
        },
        body: JSON.stringify(body),
      }),
      workerEnv,
      {
        waitUntil: (promise) => {
          background.push(promise);
        },
      },
      {
        verifyIdentity: async () => ({ uid }),
      },
    );
    await Promise.all(background);
    const value = await response.json<Record<string, unknown>>();
    expect(response.status, JSON.stringify(value)).toBe(200);
    expect(value.ok).toBe(true);
    return value;
  };
  return { workerEnv, post, network, credentialReads };
}

function mutation(inviteId: string) {
  return { inviteId, operationId: crypto.randomUUID(), emojiId: 1, aura: "" };
}

async function insertProfile(loginUid: string) {
  const profile: CompletePlayerProfile = {
    id: `profile-${loginUid}`,
    nonce: 1,
    rating: 1500,
    totalManaPoints: 0,
    win: false,
    emoji: 1,
    username: null,
    eth: null,
    sol: null,
    feb2026UniqueOpponentsCount: 0,
    mining: { lastRockDate: "2026-09-11", materials: createEmptyMaterials() },
  };
  await commitCanonicalPlan(env.PROFILE_DB, {
    expectations: [
      { kind: "profile-absent", profileId: profile.id },
      { kind: "login-owner-absent", loginUid },
    ],
    mutations: [
      {
        kind: "insert-active-profile",
        value: materializeCanonicalProfile({
          profile,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        }),
      },
      {
        kind: "insert-login-owner",
        value: {
          loginUid,
          profileId: profile.id,
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
        },
      },
    ],
  });
}

async function series(post: ReturnType<typeof runtime>["post"]) {
  const inviteId = crypto.randomUUID().replaceAll("-", "").slice(0, 11);
  const host = `host-${inviteId}`;
  const guest = `guest-${inviteId}`;
  rooms.add(inviteId);
  const creation = mutation(inviteId);
  const created = await post(host, "/invites/create", creation);
  expect(created).toEqual({
    ok: true,
    inviteId,
    matchId: inviteId,
    hostId: host,
  });
  expect(await post(host, "/invites/create", creation)).toEqual(created);
  expect(await post(guest, "/invites/join", mutation(inviteId))).toMatchObject({
    ok: true,
    joined: true,
    inviteId,
    matchId: inviteId,
    guestId: guest,
  });
  return { inviteId, host, guest };
}

async function snapshot(workerEnv: Env, playerId: string, matchId: string) {
  const response = await handleMatchSnapshotRoute(
    new Request(
      `https://api.mons.link/matches/snapshot?${new URLSearchParams({ playerId, matchId })}`,
    ),
    workerEnv,
  );
  expect(response.status).toBe(200);
  return (await response.json<ReadMatchSnapshotResponse>()).match;
}

beforeAll(async () => {
  await applyD1Migrations(db, testEnv.TEST_D1_MIGRATIONS);
  await applyRetiredProfileMigrations(
    env.PROFILE_DB,
    testEnv.TEST_PROFILE_D1_MIGRATIONS,
    "a".repeat(64),
  );
  await applyEventTestMigrations(
    env.EVENT_DB,
    testEnv.TEST_EVENT_D1_MIGRATIONS,
  );
  await resetMatchPresentationTestState(
    db,
    testEnv.TEST_D1_MIGRATIONS,
    "durable",
  );
  await resetEventReceiptTestState(db, testEnv.TEST_D1_MIGRATIONS);
  await db.batch([
    db.prepare(
      "UPDATE automatch_runtime_control SET backend = 'd1', state = 'active' WHERE singleton = 1",
    ),
    db.prepare(
      "UPDATE invite_source_control SET backend = 'd1', state = 'active', epoch = 1, freeze_generation = 0, verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1",
    ),
    db.prepare(
      "UPDATE login_match_discovery_control SET capture_enforced = 1, capture_version_id = '11111111-1111-4111-8111-111111111111', capture_started_at_ms = 1 WHERE singleton = 1",
    ),
    db
      .prepare(
        `UPDATE match_state_control SET backend = 'durable', epoch = 2,
      candidate_version_id = 'candidate', import_id = 'import',
      source_digest = ?, verified_digest = ?, fence_digest = ?,
      source_record_count = 0, source_claim_count = 0, source_bundle_count = 0,
      verified_at_ms = 1, activated_at_ms = 1 WHERE singleton = 1`,
      )
      .bind("a".repeat(64), "a".repeat(64), "b".repeat(64)),
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const inviteId of rooms) {
    await runInDurableObject(
      env.INVITE_REACTIONS.getByName(inviteId),
      (_instance, state) => state.storage.deleteAlarm(),
    );
  }
  rooms.clear();
});

describe("gameplay with canonical Durable Object storage", () => {
  it("rates an automatch and archives its exact pair through the default profile projection", async () => {
    const { workerEnv, post, network, credentialReads } = runtime();
    const id = crypto.randomUUID().slice(0, 8);
    const host = `rated-host-${id}`;
    const guest = `rated-guest-${id}`;
    await Promise.all([insertProfile(host), insertProfile(guest)]);
    const created = await post(
      host,
      `/automatch/start?operationId=${crypto.randomUUID()}`,
      { emojiId: 1, aura: "" },
    );
    const inviteId = String(created.inviteId);
    expect(inviteId).toMatch(/^auto_/);
    rooms.add(inviteId);
    const joined = await post(
      guest,
      `/automatch/start?operationId=${crypto.randomUUID()}`,
      { emojiId: 2, aura: "" },
    );
    expect(joined.inviteId).toBe(inviteId);
    await post(guest, "/matches/surrender", {
      inviteId,
      matchId: inviteId,
      playerId: guest,
    });
    const repository = createEventGameplayRepository(workerEnv);
    const finished = await repository.readMatchPair!({
      inviteId,
      matchId: inviteId,
      playerId: host,
      opponentId: guest,
    });
    expect(await snapshot(workerEnv, host, inviteId)).toMatchObject({
      aura: "",
      fen: expect.any(String),
    });
    await post(host, "/ratings/update", {
      inviteId,
      matchId: inviteId,
      playerId: host,
      opponentId: guest,
    });
    const operationId = `${inviteId}__${inviteId}`;
    const rating = createRatingRepository(workerEnv, repository);
    expect(await rating.readRatingUpdate(operationId)).toMatchObject({
      status: "done",
      historicalMatchPair: {
        hostMatch: normalizeMatchSnapshot(finished.playerMatch),
        guestMatch: normalizeMatchSnapshot(finished.opponentMatch),
      },
    });
    let acknowledgements = 0;
    const retries: QueueRetryOptions[] = [];
    await handleProfileGameProjectionMessage(
      {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        attempts: 1,
        body: { kind: "rating-profile-game-projection", operationId },
        ack: () => {
          acknowledgements++;
        },
        retry: (options) => {
          retries.push(options || {});
        },
      },
      workerEnv,
    );
    expect(retries).toEqual([]);
    expect(acknowledgements).toBe(1);
    const archived = await readHistoricalMatch(workerEnv, inviteId, inviteId);
    expect(archived).toMatchObject({
      ok: true,
      pair: {
        matchId: inviteId,
        hostPlayerId: host,
        guestPlayerId: guest,
        hostMatch: normalizeMatchSnapshot(finished.playerMatch),
        guestMatch: normalizeMatchSnapshot(finished.opponentMatch),
      },
    });
    expect(
      (await post(host, "/navigation/games/read", { limit: 10, cursor: null }))
        .items,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ inviteId })]));
    await post(host, "/matches/move", {
      inviteId,
      matchId: inviteId,
      playerId: host,
      previousFlatMovesString: "",
      flatMovesString: "l0,0;l0,1",
      fen: "later-gameplay-source",
    });
    expect(await snapshot(workerEnv, host, inviteId)).toMatchObject({
      fen: "later-gameplay-source",
    });
    expect(await readHistoricalMatch(workerEnv, inviteId, inviteId)).toEqual(
      archived,
    );
    expect(credentialReads).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });

  it("runs manual create, join, move, surrender and rematch through default HTTP repositories", async () => {
    const { workerEnv, post, network, credentialReads } = runtime();
    const { inviteId, host, guest } = await series(post);
    const gameplay = createGameplayRepository(workerEnv);
    const events = createEventGameplayRepository(workerEnv);
    const rating = createRatingRepository(workerEnv, events);
    const pairRequest = {
      inviteId,
      matchId: inviteId,
      playerId: host,
      opponentId: guest,
    };
    const initial = await gameplay.readMatchPair!(pairRequest);
    expect(await events.readMatchPair!(pairRequest)).toEqual(initial);
    expect(await rating.readMatchPair!(pairRequest)).toEqual(initial);
    expect(await snapshot(workerEnv, host, inviteId)).toEqual(
      normalizeMatchSnapshot(initial.playerMatch),
    );
    expect(await readMatchStateRoute(db, host, inviteId)).toEqual({
      actorUid: host,
      matchId: inviteId,
      inviteId,
      epoch: 2,
      kind: "durable",
    });
    const move = {
      inviteId,
      matchId: inviteId,
      playerId: host,
      previousFlatMovesString: "",
      flatMovesString: "l0,0;l0,1",
      fen: "advanced-fen",
    };
    expect(await post(host, "/matches/move", move)).toMatchObject({
      outcome: "applied",
    });
    expect(await post(host, "/matches/move", move)).toMatchObject({
      outcome: "already-applied",
    });
    expect(
      await post(guest, "/matches/surrender", {
        inviteId,
        matchId: inviteId,
        playerId: guest,
      }),
    ).toMatchObject({ actorUid: guest });
    const finished = await events.readMatchPair!(pairRequest);
    expect(finished.playerMatch).toMatchObject({
      fen: move.fen,
      flatMovesString: move.flatMovesString,
    });
    expect(finished.opponentMatch).toMatchObject({ status: "surrendered" });
    expect(finished.revision).toBeGreaterThan(initial.revision);
    const proposed = await post(host, "/rematches/propose", mutation(inviteId));
    expect(proposed.matchId).toBe(`${inviteId}1`);
    await post(guest, "/matches/ensure", {
      ...mutation(inviteId),
      matchId: proposed.matchId,
    });
    expect(
      await snapshot(workerEnv, guest, String(proposed.matchId)),
    ).toMatchObject({ status: "", flatMovesString: "" });
    expect(await snapshot(workerEnv, host, inviteId)).toMatchObject({
      fen: move.fen,
    });
    await post(host, "/rematches/end", {
      inviteId,
      operationId: crypto.randomUUID(),
    });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM match_state_write_admissions")
        .first("count"),
    ).toBe(0);
    expect(credentialReads).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });

  it("keeps timer deadlines and completes a timeout through the default route", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const { workerEnv, post, network, credentialReads } = runtime();
    const { inviteId, host, guest } = await series(post);
    const repository = createEventGameplayRepository(workerEnv);
    const initial = await repository.readMatchPair!({
      inviteId,
      matchId: inviteId,
      playerId: host,
      opponentId: guest,
    });
    const hostMatch = normalizeMatchSnapshot(initial.playerMatch)!;
    const guestMatch = normalizeMatchSnapshot(initial.opponentMatch)!;
    const state = resolveMatchTimerGame(hostMatch, guestMatch);
    const playerId = state.activeColor === hostMatch.color ? guest : host;
    const opponentId = playerId === host ? guest : host;
    const request = { inviteId, matchId: inviteId, playerId, opponentId };
    const started = await post(playerId, "/matches/timer/start", request);
    const timer = parseStrictMatchTimer(started.timer)!;
    expect(timer.targetTimestamp).toBeGreaterThan(now);
    clock.mockReturnValue(now + 1_000);
    expect((await post(playerId, "/matches/timer/start", request)).timer).toBe(
      started.timer,
    );
    clock.mockReturnValue(timer.targetTimestamp + 1);
    expect(await post(playerId, "/matches/timer/claim", request)).toEqual({
      ok: true,
    });
    expect(await snapshot(workerEnv, playerId, inviteId)).toMatchObject({
      timer: MATCH_TIMER_TERMINAL,
    });
    const pair = await repository.readMatchPair!(request);
    expect(pair.claim).toMatchObject({
      status: "claimed",
      playerId,
      opponentId,
      timer: started.timer,
    });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM match_timer_starts WHERE match_id = ?",
        )
        .bind(inviteId)
        .first("count"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM match_state_write_admissions")
        .first("count"),
    ).toBe(0);
    expect(credentialReads).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });

  it("materializes event matches and retained timer effects through the default event adapter", async () => {
    const { workerEnv, network, credentialReads } = runtime();
    const eventId = crypto.randomUUID().replaceAll("-", "").slice(0, 11);
    const inviteId = crypto.randomUUID().replaceAll("-", "").slice(0, 11);
    const host = `event-host-${eventId}`;
    const guest = `event-guest-${eventId}`;
    rooms.add(inviteId);
    const repository = createEventGameplayRepository(workerEnv);
    await repository.patchStateRoot({
      [`events/${eventId}`]: {
        schemaVersion: 2,
        eventId,
        status: "scheduled",
        createdAtMs: 100,
        updatedAtMs: 100,
        startAtMs: 1_000,
        createdByProfileId: "profile-one",
        createdByLoginUid: host,
        createdByUsername: "ivan",
        participants: {},
        rounds: {},
      },
    });
    const fen = new Game().toFen();
    await repository.patchStateRoot({
      [`events/${eventId}/status`]: "active",
      [`events/${eventId}/updatedAtMs`]: 200,
      [`invites/${inviteId}`]: {
        eventId,
        eventOwned: true,
        hostId: host,
        guestId: guest,
      },
      [`players/${host}/matches/${inviteId}`]: {
        fen,
        flatMovesString: "",
        color: "white",
        emojiId: 1,
        aura: "",
      },
      [`players/${guest}/matches/${inviteId}`]: {
        fen,
        flatMovesString: "",
        color: "black",
        emojiId: 2,
        aura: "",
      },
    });
    expect(await readEventSnapshot(env.EVENT_DB, eventId)).toMatchObject({
      event: { status: "active" },
      revision: 2,
    });
    const original = await repository.readMatchPair!({
      inviteId,
      matchId: inviteId,
      playerId: host,
      opponentId: guest,
    });
    expect(original.playerMatch).toMatchObject({ color: "white", fen });
    expect(original.opponentMatch).toMatchObject({ color: "black", fen });
    await repository.patchStateRoot({
      [`events/${eventId}/updatedAtMs`]: 300,
      [`players/${host}/matches/${inviteId}/timer`]: MATCH_TIMER_TERMINAL,
    });
    const finished = unwrapMatchStateRpc(
      await getMatchStateRpc(workerEnv, inviteId).readCanonicalMatchPair({
        inviteId,
        matchId: inviteId,
        playerId: host,
        opponentId: guest,
        epoch: 2,
      }),
    );
    expect(finished.playerMatch).toMatchObject({ timer: MATCH_TIMER_TERMINAL });
    expect(finished.claim).toBeNull();
    expect(finished.revision).toBeGreaterThan(original.revision);
    expect(await readMatchStateRoute(db, guest, inviteId)).toMatchObject({
      kind: "durable",
      inviteId,
      epoch: 2,
    });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM match_state_write_admissions")
        .first("count"),
    ).toBe(0);
    expect(credentialReads).toEqual([]);
    expect(network).not.toHaveBeenCalled();
  });
});
