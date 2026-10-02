import {
  COMPRESSED_PRIZES_EVENT_ID,
  LEGACY_CORE_PRIZES_EVENT_ID,
} from "@mons/shared/event-prizes";
import type { EventParticipantSnapshot } from "@mons/shared/events";
import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { EventNotUpcoming } from "../src/eventD1.ts";
import { createEventMutationRepository } from "../src/eventMutationRepository.ts";
import {
  createEventGameplayRepository,
  type EventGameplayRepository,
} from "../src/eventRepository.ts";
import { handleEventRoute } from "../src/eventRoute.ts";
import {
  commitCanonicalPlan,
  materializeCanonicalProfile,
} from "../src/profileCanonicalD1.ts";
import { processEventProfileGameProjection } from "../src/profileGameProjection.ts";
import { createEventProfileGameProjectionRuntime } from "../src/profileGameProjectionRepository.ts";
import {
  parseProfileGameProjectionTask,
  type EventProfileGameProjectionTask,
} from "../src/profileGameProjectionTasks.ts";
import { getProfileGameProjections } from "../src/profileGamesD1.ts";
import {
  parseTelegramProjectionTask,
  type EventTelegramProjectionTask,
} from "../src/telegramProjectionTasks.ts";
import { TELEGRAM_TEST_ENV } from "../test/testEnv.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { resetEventReceiptTestState } from "./eventTransitionTestFixture.ts";
import { resetMatchPresentationTestState } from "./matchPresentationTestFixture.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};
const creatorId = "leave-runtime-host";
const guestId = "leave-runtime-guest";
const guestLoginUid = `${guestId}-login`;

function participant(profileId: string): EventParticipantSnapshot {
  return {
    profileId,
    loginUid: `${profileId}-login`,
    username: profileId,
    displayName: profileId,
    emojiId: 1,
    aura: "",
    joinedAtMs: 1,
    state: "active",
    eliminatedRoundIndex: null,
    eliminatedByProfileId: null,
  };
}

async function insertProfileOwner(profileId: string) {
  const loginUid = `${profileId}-login`;
  await commitCanonicalPlan(testEnv.PROFILE_DB, {
    expectations: [
      { kind: "profile-absent", profileId },
      { kind: "login-owner-absent", loginUid },
    ],
    mutations: [
      {
        kind: "insert-active-profile",
        value: materializeCanonicalProfile({
          createdAtMs: 1,
          updatedAtMs: 1,
          profile: {
            id: profileId,
            nonce: 1,
            rating: 1500,
            totalManaPoints: 0,
            win: false,
            emoji: 1,
            username: profileId,
            eth: null,
            sol: null,
            completedProblemIds: [],
            isTutorialCompleted: true,
            mining: {
              lastRockDate: "",
              materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
            },
          },
        }),
      },
      {
        kind: "insert-login-owner",
        value: { loginUid, profileId, createdAtMs: 1, updatedAtMs: 1 },
      },
    ],
  });
}

function fixture(
  eventId: string,
  options: { startAtMs?: number; prizeId?: string } = {},
) {
  const profileTasks: EventProfileGameProjectionTask[] = [];
  const telegramTasks: EventTelegramProjectionTask[] = [];
  const background: Promise<unknown>[] = [];
  const environment: Env = {
    ...testEnv,
    AUTH_RATE_LIMITER: TELEGRAM_TEST_ENV.AUTH_RATE_LIMITER,
    EVENT_PROGRESS_WORKFLOW: TELEGRAM_TEST_ENV.EVENT_PROGRESS_WORKFLOW,
    EVENT_PROFILE_GAME_PROJECTION_QUEUE: {
      ...TELEGRAM_TEST_ENV.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
      send: async (body) => {
        const task = parseProfileGameProjectionTask(body);
        if (task?.kind === "event-profile-game-projection")
          profileTasks.push(task);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    },
    TELEGRAM_PROJECTION_QUEUE: {
      ...TELEGRAM_TEST_ENV.TELEGRAM_PROJECTION_QUEUE,
      send: async (body) => {
        const task = parseTelegramProjectionTask(body);
        if (task?.kind === "event-telegram-projection")
          telegramTasks.push(task);
        return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
      },
    },
  };
  const repository = createEventGameplayRepository(environment);
  const mutations = createEventMutationRepository(environment, {
    eventRepository: repository,
  });
  const startAtMs = options.startAtMs ?? Date.now() + 60_000;
  const prizeId =
    options.prizeId ??
    (eventId === LEGACY_CORE_PRIZES_EVENT_ID ? "1092" : null);
  const participants = {
    [creatorId]: participant(creatorId),
    [guestId]: participant(guestId),
  };
  return {
    repository,
    mutations,
    participants,
    profileTasks,
    telegramTasks,
    startAtMs,
    async seed() {
      await mutations.commitEventPlan([
        {
          kind: "event",
          eventId,
          value: {
            schemaVersion: 2,
            eventId,
            status: "scheduled",
            createdAtMs: 1,
            updatedAtMs: 1,
            startAtMs,
            createdByProfileId: creatorId,
            createdByLoginUid: `${creatorId}-login`,
            createdByUsername: creatorId,
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
        ...(prizeId
          ? [
              {
                kind: "prize-selection" as const,
                eventId,
                profileId: guestId,
                value: prizeId,
              },
            ]
          : []),
      ]);
    },
    async request(
      path: string,
      now: () => number,
      repositoryOverride?: EventGameplayRepository,
    ) {
      try {
        return await handleEventRoute(
          new Request(`https://api.mons.link${path}`, {
            method: "POST",
            headers: {
              Origin: "https://mons.link",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ eventId }),
          }),
          environment,
          { waitUntil: (work) => background.push(work) },
          {
            verifyIdentity: async () => ({ uid: guestLoginUid }),
            participation: { now },
            repository: repositoryOverride,
          },
        );
      } finally {
        await Promise.all(background.splice(0));
      }
    },
    async projectLatest() {
      const task = profileTasks.at(-1);
      expect(task).toBeDefined();
      expect(
        await processEventProfileGameProjection(
          task!,
          repository,
          createEventProfileGameProjectionRuntime(environment),
        ),
      ).toBe("projected");
    },
  };
}

describe("leave event D1 integration", () => {
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
    await insertProfileOwner(creatorId);
    await insertProfileOwner(guestId);
  });

  it("removes participation and its prize, refreshes projections, and allows rejoining", async () => {
    const eventId = LEGACY_CORE_PRIZES_EVENT_ID;
    const state = fixture(eventId);
    await state.seed();
    await state.projectLatest();
    expect(
      await state.repository.getNavigationGame(guestId, `event_${eventId}`),
    ).not.toBeNull();
    const beforeTelegram =
      await state.repository.readEventTelegramProjectionState(eventId);
    expect(beforeTelegram?.generation).toBe(1);
    const response = await state.request(
      "/events/participants/leave",
      () => state.startAtMs - 1000,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      eventId,
      removedProfileId: guestId,
    });
    const snapshot = await state.repository.readEventSnapshot(eventId);
    expect(snapshot.event?.status).toBe("scheduled");
    expect(snapshot.event?.participants).toEqual({
      [creatorId]: state.participants[creatorId],
    });
    expect(snapshot.prizeSelections).toEqual({});
    expect(
      await state.repository.readEventProfileGameProjectionOutbox(eventId),
    ).toMatchObject({
      status: "pending",
      cleanupOwnerProfileIds: { [creatorId]: true, [guestId]: true },
    });
    expect(state.profileTasks).toHaveLength(2);
    expect(state.telegramTasks).toHaveLength(2);
    expect(
      await state.repository.readEventTelegramProjectionOutbox(eventId),
    ).toMatchObject({
      status: "pending",
      requestId: state.telegramTasks.at(-1)?.requestId,
    });
    expect(
      (await state.repository.readEventTelegramProjectionState(eventId))
        ?.generation,
    ).toBe(2);

    await state.projectLatest();
    expect(
      await state.repository.getNavigationGame(guestId, `event_${eventId}`),
    ).toBeNull();
    expect(
      (
        await getProfileGameProjections(testEnv.PROFILE_GAMES_DB, creatorId, [
          `event_${eventId}`,
        ]).then((rows) => rows.get(`event_${eventId}`) ?? null)
      )?.data,
    ).toMatchObject({ participantCount: 1 });

    const repeated = await state.request(
      "/events/participants/leave",
      () => state.startAtMs - 900,
    );
    expect(repeated.status).toBe(409);
    expect(state.profileTasks).toHaveLength(2);

    const rejoined = await state.request(
      "/events/participants/join",
      () => state.startAtMs - 500,
    );
    expect(rejoined.status).toBe(200);
    expect(await rejoined.json()).toMatchObject({
      ok: true,
      eventId,
      participant: { profileId: guestId, loginUid: guestLoginUid },
    });
    expect(
      (await state.repository.readEventSnapshot(eventId)).prizeSelections,
    ).toEqual({});
    await state.projectLatest();
    for (const profileId of [creatorId, guestId]) {
      expect(
        (
          await getProfileGameProjections(testEnv.PROFILE_GAMES_DB, profileId, [
            `event_${eventId}`,
          ]).then((rows) => rows.get(`event_${eventId}`) ?? null)
        )?.data,
      ).toMatchObject({ participantCount: 2 });
    }
  });

  it.each(["at-deadline", "crosses-deadline"])(
    "starts the event with every participant when leaving %s",
    async (scenario) => {
      const eventId = `leave-runtime-${scenario}`;
      const state = fixture(eventId);
      await state.seed();
      let clockReads = 0;
      const response = await state.request("/events/participants/leave", () =>
        scenario === "crosses-deadline" && clockReads++ === 0
          ? state.startAtMs - 1
          : state.startAtMs,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: "failed-precondition",
      });
      const snapshot = await state.repository.readEventSnapshot(eventId);
      expect(snapshot.event?.status).toBe("active");
      expect(snapshot.event?.participants).toEqual(state.participants);
      expect(snapshot.prizeSelections).toEqual({});
      expect(snapshot.event?.rounds).toMatchObject({
        0: {
          matches: {
            "0_0": {
              status: "pending",
            },
          },
        },
      });
    },
  );

  it("rolls back participant, prize, and projection writes when SQL rejects the deadline", async () => {
    const eventId = COMPRESSED_PRIZES_EVENT_ID;
    const state = fixture(eventId, {
      startAtMs: Date.now() - 1000,
      prizeId: "1866",
    });
    await state.seed();
    const readStorage = () =>
      Promise.all([
        state.repository.readEventSnapshot(eventId),
        state.repository.readEventProfileGameProjectionOutbox(eventId),
        state.repository.readEventTelegramProjectionOutbox(eventId),
        state.repository.readEventTelegramProjectionState(eventId),
      ]);
    const before = await readStorage();
    for (const guardedId of [eventId, "missing-leave-runtime-event"]) {
      await expect(
        state.mutations.commitEventPlan(
          [
            {
              kind: "event-participant",
              eventId,
              profileId: guestId,
              value: null,
            },
            {
              kind: "prize-selection",
              eventId,
              profileId: guestId,
              value: null,
            },
          ],
          undefined,
          { upcomingEventId: guardedId },
        ),
      ).rejects.toBeInstanceOf(EventNotUpcoming);
      expect(await readStorage()).toEqual(before);
      expect(state.profileTasks).toHaveLength(1);
      expect(state.telegramTasks).toHaveLength(1);
    }
  });

  it("starts the unchanged roster when the deadline passes during projection preparation", async () => {
    const eventId = "leave-runtime-storage-deadline";
    const state = fixture(eventId, { startAtMs: Date.now() - 1000 });
    await state.seed();
    let nowMs = state.startAtMs - 1;
    let eventReads = 0;
    let guardFailures = 0;
    const repository: EventGameplayRepository = {
      ...state.repository,
      async readEvent(id, signal) {
        eventReads++;
        if (eventReads === 3) nowMs = state.startAtMs;
        return state.repository.readEvent(id, signal);
      },
      async commitEventPlan(plan, signal, options) {
        try {
          await state.repository.commitEventPlan(plan, signal, options);
        } catch (error) {
          if (error instanceof EventNotUpcoming) guardFailures++;
          throw error;
        }
      },
    };
    const response = await state.request(
      "/events/participants/leave",
      () => nowMs,
      repository,
    );
    expect(response.status).toBe(409);
    expect(guardFailures).toBe(1);
    expect(
      (await state.repository.readEventSnapshot(eventId)).event,
    ).toMatchObject({ status: "active", participants: state.participants });
    expect(state.profileTasks).toHaveLength(2);
    expect(state.telegramTasks).toHaveLength(2);
  });
});
