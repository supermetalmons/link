import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { handleEventRoute } from "../src/eventRoute.ts";
import { createEventStateRepository } from "../src/eventRepository.ts";
import { readEventSnapshot } from "../src/eventD1.ts";
import {
  commitCanonicalPlan,
  materializeCanonicalProfile,
} from "../src/profileCanonicalD1.ts";
import { TELEGRAM_TEST_ENV } from "../test/testEnv.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import { resetEventReceiptTestState } from "./eventTransitionTestFixture.ts";
import { resetMatchPresentationTestState } from "./matchPresentationTestFixture.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};

beforeAll(async () => {
  await applyStrictMatchStateTestMigrations(
    testEnv.PROFILE_GAMES_DB,
    testEnv.TEST_D1_MIGRATIONS,
  );
  await applyEventTestMigrations(
    testEnv.EVENT_DB,
    testEnv.TEST_EVENT_D1_MIGRATIONS,
  );
  await applyRetiredProfileMigrations(
    testEnv.PROFILE_DB,
    testEnv.TEST_PROFILE_D1_MIGRATIONS,
    "a".repeat(64),
  );
  await resetEventReceiptTestState(
    testEnv.PROFILE_GAMES_DB,
    testEnv.TEST_D1_MIGRATIONS,
  );
  await resetMatchPresentationTestState(
    testEnv.PROFILE_GAMES_DB,
    testEnv.TEST_D1_MIGRATIONS,
    "durable",
  );
  await testEnv.PROFILE_GAMES_DB.prepare(
    `UPDATE invite_source_control SET backend = 'd1', state = 'active',
     epoch = 1, freeze_generation = 1, verified_at_ms = 1,
     activated_at_ms = 2 WHERE singleton = 1`,
  ).run();
});

it("returns a freshly committed HTTP snapshot while room notifications are still pending", async () => {
  const eventId = "notification-route-event";
  const participants = Object.fromEntries(
    ["host", "guest"].map((name) => {
      const profileId = `notification-${name}`;
      return [
        profileId,
        {
          profileId,
          loginUid: `${profileId}-login`,
          username: name,
          displayName: name,
          emojiId: 1,
          aura: "",
          joinedAtMs: 1,
          state: "active",
          eliminatedRoundIndex: null,
          eliminatedByProfileId: null,
        },
      ];
    }),
  );
  for (const participant of Object.values(participants)) {
    const value = materializeCanonicalProfile({
      profile: {
        id: participant.profileId,
        nonce: 1,
        rating: 1500,
        totalManaPoints: 0,
        win: true,
        emoji: 1,
        username: participant.username,
        eth: null,
        sol: null,
        completedProblemIds: [],
        isTutorialCompleted: true,
        mining: {
          lastRockDate: "",
          materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
        },
      },
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await commitCanonicalPlan(testEnv.PROFILE_DB, {
      expectations: [
        { kind: "profile-absent", profileId: participant.profileId },
        { kind: "login-owner-absent", loginUid: participant.loginUid },
      ],
      mutations: [
        { kind: "insert-active-profile", value },
        {
          kind: "insert-login-owner",
          value: {
            loginUid: participant.loginUid,
            profileId: participant.profileId,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        },
      ],
    });
  }
  await createEventStateRepository(testEnv).commitEventPlan([
    {
      kind: "event",
      eventId,
      value: {
        schemaVersion: 2,
        eventId,
        status: "scheduled",
        createdAtMs: 1,
        updatedAtMs: 1,
        startAtMs: 1000,
        createdByProfileId: "notification-host",
        createdByLoginUid: "notification-host-login",
        createdByUsername: "host",
        participants,
        rounds: {},
        isSundayMons: false,
        telegramAnnouncements: {
          invite: false,
          matches: false,
          results: false,
        },
      },
    },
  ]);
  const allowNotifications = Promise.withResolvers<void>();
  const notified = Promise.withResolvers<void>();
  const background: Promise<void>[] = [];
  const pending = new Set<Promise<void>>();
  const routeEnv: Env = {
    ...testEnv,
    AUTH_RATE_LIMITER: TELEGRAM_TEST_ENV.AUTH_RATE_LIMITER,
    EVENT_PROFILE_GAME_PROJECTION_QUEUE:
      TELEGRAM_TEST_ENV.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
    TELEGRAM_PROJECTION_QUEUE: TELEGRAM_TEST_ENV.TELEGRAM_PROJECTION_QUEUE,
    EVENT_PROGRESS_WORKFLOW: TELEGRAM_TEST_ENV.EVENT_PROGRESS_WORKFLOW,
    INVITE_REACTIONS: new Proxy(testEnv.INVITE_REACTIONS, {
      get(target, property) {
        if (property === "getByName")
          return (name: string) =>
            new Proxy(target.getByName(name), {
              get(room, method) {
                if (
                  [
                    "notifyMetadataChanged",
                    "notifyWagersChanged",
                    "notifyMatchesChanged",
                  ].includes(String(method))
                )
                  return () => {
                    notified.resolve();
                    return allowNotifications.promise;
                  };
                const value = Reflect.get(room, method);
                return typeof value === "function"
                  ? (...args: unknown[]) => Reflect.apply(value, room, args)
                  : value;
              },
            });
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
  try {
    const responsePromise = handleEventRoute(
      new Request("https://api.mons.link/events/state/sync?eventSnapshot=v1", {
        method: "POST",
        headers: {
          Origin: "https://mons.link",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ eventId }),
      }),
      routeEnv,
      {
        waitUntil(work) {
          background.push(work);
          pending.add(work);
          void work.then(
            () => pending.delete(work),
            () => pending.delete(work),
          );
        },
      },
      {
        verifyIdentity: async () => ({ uid: "notification-host-login" }),
        control: { now: () => 2000, random: () => 0.5 },
      },
    );
    const response = await responsePromise;
    expect(response.status).toBe(200);
    await notified.promise;
    expect(pending.size).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({
      ok: true,
      event: { status: "active" },
      eventSnapshot: { snapshot: { event: { status: "active" } } },
    });
    expect(
      (await readEventSnapshot(testEnv.EVENT_DB, eventId)).event?.status,
    ).toBe("active");
  } finally {
    allowNotifications.resolve();
    await Promise.allSettled(background);
  }
});
