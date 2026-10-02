import type { CompletePlayerProfile } from "@mons/shared/profiles";
import type { D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeEventUpdates } from "../src/eventCompatibilityCodec.ts";
import { createEventGameplayRepository } from "../src/eventRepository.ts";
import {
  commitCanonicalPlan,
  materializeCanonicalProfile,
} from "../src/profileCanonicalD1.ts";
import {
  EVENT_PROFILE_GAME_PROJECTION_QUEUE_NAME,
  type EventProfileGameProjectionTask,
} from "../src/profileGameProjectionTasks.ts";
import { getProfileGameProjections } from "../src/profileGamesD1.ts";
import worker from "../src/workerHandler.ts";
import { TELEGRAM_TEST_ENV } from "../test/testEnv.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";
import { applyRetiredProfileMigrations } from "./profileTestMigrations.ts";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";

const testEnv = env as Env & {
  TEST_D1_MIGRATIONS: D1Migration[];
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_PROFILE_D1_MIGRATIONS: D1Migration[];
};

async function insertProfileOwner(profileId: string, loginUid: string) {
  const profile: CompletePlayerProfile = {
    id: profileId,
    completedProblemIds: [],
    emoji: 2,
    eth: null,
    isTutorialCompleted: true,
    mining: {
      lastRockDate: "2026-09-13",
      materials: { dust: 0, gum: 0, ice: 0, metal: 0, slime: 0 },
    },
    nonce: 1,
    rating: 1500,
    sol: null,
    totalManaPoints: 0,
    username: profileId,
    win: false,
  };
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
          profile,
        }),
      },
      {
        kind: "insert-login-owner",
        value: { createdAtMs: 1, updatedAtMs: 1, profileId, loginUid },
      },
    ],
  });
}

describe("dedicated event preview queue D1 integration", () => {
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
      "d".repeat(64),
    );
    await testEnv.PROFILE_GAMES_DB.prepare(
      "UPDATE automatch_runtime_control SET backend = 'd1', state = 'active', epoch = epoch + 1 WHERE singleton = 1",
    ).run();
  });

  it("updates the creator's preview to two people while archive work remains deferred", async () => {
    const eventId = "queue-isolated-event";
    const creatorId = "queue-event-creator";
    const guestId = "queue-event-guest";
    const nowMs = Date.now();
    await insertProfileOwner(creatorId, "queue-creator-login");
    await insertProfileOwner(guestId, "queue-guest-login");
    const archiveOutbox = {
      schemaVersion: 1,
      status: "pending",
      requestId: "deferred-archive-request",
      sourceUpdatedAtMs: nowMs,
      lastQueuedAtMs: nowMs,
      reason: "rematch-series-ended",
      archiveRetry: {
        requestId: "deferred-archive-request",
        notBeforeMs: nowMs + 300_000,
      },
      historicalMatches: {
        "unfinished-match": {
          finalizedAtMs: nowMs,
          hostPlayerId: "archive-host",
          guestPlayerId: "archive-guest",
          source: "transition",
          retryNotBeforeMs: nowMs + 300_000,
        },
      },
    };
    const archiveJson = JSON.stringify(archiveOutbox);
    await testEnv.PROFILE_GAMES_DB.prepare(
      "INSERT INTO game_session_projection_outbox (record_key, payload_json, revision, updated_at_ms) VALUES (?, ?, 1, ?)",
    )
      .bind("deferred-archive-invite", archiveJson, nowMs)
      .run();
    const environment: Env = {
      ...testEnv,
      PROFILE_GAME_PROJECTION_QUEUE: {
        ...TELEGRAM_TEST_ENV.PROFILE_GAME_PROJECTION_QUEUE,
        send: async () => {
          throw new Error("shared-archive-queue-unavailable");
        },
        sendBatch: async () => {
          throw new Error("shared-archive-queue-unavailable");
        },
      },
      EVENT_PROFILE_GAME_PROJECTION_QUEUE: {
        ...TELEGRAM_TEST_ENV.EVENT_PROFILE_GAME_PROJECTION_QUEUE,
        send: async () => {
          throw new Error("dedicated-consumer-must-not-forward-again");
        },
      },
    };
    const repository = createEventGameplayRepository(environment);
    const participants: Record<string, unknown> = {};
    for (const [index, profileId, loginUid] of [
      [0, creatorId, "queue-creator-login"],
      [1, guestId, "queue-guest-login"],
    ] as const) {
      participants[profileId] = {
        profileId,
        loginUid,
        displayName: profileId,
        joinedAtMs: nowMs + index,
        emojiId: index + 1,
      };
      const requestId = `event-request-${index}`;
      await repository.commitEventPlan(
        decodeEventUpdates({
          [`events/${eventId}`]: {
            schemaVersion: 2,
            eventId,
            status: "scheduled",
            createdAtMs: nowMs,
            updatedAtMs: nowMs + index,
            startAtMs: nowMs + 3_600_000,
            createdByProfileId: creatorId,
            createdByLoginUid: "queue-creator-login",
            createdByUsername: creatorId,
            participants,
            rounds: {},
          },
          [`profileGameProjectionOutbox/event/${eventId}`]: {
            schemaVersion: 1,
            status: "pending",
            requestId,
            lastQueuedAtMs: nowMs + index,
            cleanupOwnerProfileIds: {},
          },
        }),
      );
      const task: EventProfileGameProjectionTask = {
        kind: "event-profile-game-projection",
        eventId,
        requestId,
      };
      let acknowledgements = 0;
      const retries: QueueRetryOptions[] = [];
      await worker.queue(
        {
          queue: EVENT_PROFILE_GAME_PROJECTION_QUEUE_NAME,
          messages: [
            {
              id: requestId,
              body: task,
              timestamp: new Date(nowMs),
              attempts: 1,
              ack: () => acknowledgements++,
              retry: (options) => retries.push(options || {}),
            },
          ],
          metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
          ackAll: () => undefined,
          retryAll: () => undefined,
        },
        environment,
      );
      expect(retries).toEqual([]);
      expect(acknowledgements).toBe(1);
      const preview = await getProfileGameProjections(
        testEnv.PROFILE_GAMES_DB,
        creatorId,
        [`event_${eventId}`],
      ).then((rows) => rows.get(`event_${eventId}`) ?? null);
      expect(preview?.data.participantCount).toBe(index + 1);
      expect(preview?.data.participantPreview).toHaveLength(index + 1);
      expect(
        await repository.readEventProfileGameProjectionOutbox(eventId),
      ).toBeNull();
    }
    expect(
      await testEnv.PROFILE_GAMES_DB.prepare(
        "SELECT payload_json FROM game_session_projection_outbox WHERE record_key = ?",
      )
        .bind("deferred-archive-invite")
        .first("payload_json"),
    ).toBe(archiveJson);
  });
});
