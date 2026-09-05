import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import {
  applyEventTestMigrations,
  transitionEventStorageMode,
} from "./eventTestMigrations.ts";
import { handleEventReadRoute } from "../src/eventReadRoute.ts";
import { handleEventRoute } from "../src/eventRoute.ts";
import {
  acquireEventWriteAdmission,
  assertEventWritesAllowed,
  patchEventOwnedPaths,
  releaseEventWriteAdmission,
} from "../src/eventD1.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";

const testEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };
const eventId = "NN3eRzoZo80";
const profileId = "profile-one";

function eventRecord() {
  return {
    schemaVersion: 2,
    eventId,
    status: "scheduled",
    createdAtMs: 100,
    updatedAtMs: 100,
    startAtMs: 1_000,
    createdByProfileId: profileId,
    createdByLoginUid: "login-one",
    createdByUsername: "ivan",
    participants: {},
    rounds: {},
  };
}

describe("event read route", () => {
  beforeAll(async () => {
    await applyEventTestMigrations(
      testEnv.EVENT_DB,
      testEnv.TEST_EVENT_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    await testEnv.EVENT_DB.batch([
      testEnv.EVENT_DB.prepare("DELETE FROM profile_event_prizes"),
      testEnv.EVENT_DB.prepare("DELETE FROM profile_event_prize_revisions"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_prize_selections"),
      testEnv.EVENT_DB.prepare("DELETE FROM event_records"),
    ]);
    const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
    try {
      await patchEventOwnedPaths(
        testEnv.EVENT_DB,
        {
          [`events/${eventId}`]: eventRecord(),
          [`eventPrizeSelections/${eventId}/${profileId}`]: "1092",
          [`profileEventPrizes/${profileId}/${eventId}`]: {
            eventId,
            profileId,
            place: 1,
            prizeId: "1092",
            assignedAtMs: 2_000,
            futureMetadata: { edition: 2 },
          },
        },
        { admission },
      );
    } finally {
      await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
    }
  });

  it("serves D1 snapshots with conditional headers", async () => {
    const request = new Request(
      `https://api.mons.link/events/snapshot?eventId=${eventId}`,
      { headers: { Origin: "https://mons.link" } },
    );
    const response = await handleEventReadRoute(
      request,
      testEnv,
      {
        waitUntil() {},
      },
      {
        repository: {
          getRtdbPath: async () => null,
          readProfileOwnershipSnapshot: async () => {
            throw new Error("unused");
          },
        },
        verifyIdentity: async () => ({ uid: "login-one" }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBeTruthy();
    expect(response.headers.get("X-D1-Bookmark")).toBeTruthy();
    expect(await response.json()).toMatchObject({
      ok: true,
      eventId,
      revision: 1,
      prizeSelections: { [profileId]: "1092" },
    });

    const conditional = await handleEventReadRoute(
      new Request(request.url, {
        headers: {
          Origin: "https://mons.link",
          "If-None-Match": response.headers.get("ETag") || "",
          "X-D1-Bookmark": response.headers.get("X-D1-Bookmark") || "",
        },
      }),
      testEnv,
      { waitUntil() {} },
      {
        repository: {
          getRtdbPath: async () => null,
          readProfileOwnershipSnapshot: async () => {
            throw new Error("unused");
          },
        },
        verifyIdentity: async () => ({ uid: "login-one" }),
      },
    );
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
  });

  it("serves conditional-read CORS preflight without authentication", async () => {
    const response = await handleEventReadRoute(
      new Request(`https://api.mons.link/events/snapshot?eventId=${eventId}`, {
        method: "OPTIONS",
        headers: { Origin: "https://mons.link" },
      }),
      testEnv,
      { waitUntil() {} },
      {
        repository: {
          getRtdbPath: async () => null,
          readProfileOwnershipSnapshot: async () => {
            throw new Error("unused");
          },
        },
        verifyIdentity: async () => {
          throw new Error("authentication should not run");
        },
      },
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
      "If-None-Match",
    );
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain(
      "X-D1-Bookmark",
    );
  });

  it("rejects oversized event IDs before storage reads", async () => {
    const response = await handleEventReadRoute(
      new Request(
        `https://api.mons.link/events/snapshot?eventId=${"a".repeat(769)}`,
        { headers: { Origin: "https://mons.link" } },
      ),
      testEnv,
      { waitUntil() {} },
      {
        repository: {
          getRtdbPath: async () => {
            throw new Error("storage should not run");
          },
          readProfileOwnershipSnapshot: async () => {
            throw new Error("unused");
          },
        },
        verifyIdentity: async () => ({ uid: "login-one" }),
      },
    );
    expect(response.status).toBe(400);
  });

  it("serves only the caller's canonical profile prizes", async () => {
    const repository: Pick<
      GameplayRepository,
      "getRtdbPath" | "readProfileOwnershipSnapshot"
    > = {
      getRtdbPath: async () => null,
      async readProfileOwnershipSnapshot() {
        return {
          loginOwnerByUid: new Map([["login-one", { profileId, revision: 1 }]]),
          canonicalProfileIdByProfileId: new Map(),
          loginUidsByProfileId: new Map([[profileId, ["login-one"]]]),
          profileById: new Map([
            [
              profileId,
              {
                revision: 1,
                profile: {
                  profileId,
                  aura: "",
                  emoji: 1,
                  eth: "",
                  rating: 1_500,
                  sol: "",
                  username: "ivan",
                },
              },
            ],
          ]),
        };
      },
    };
    const response = await handleEventReadRoute(
      new Request("https://api.mons.link/events/prizes", {
        headers: { Origin: "https://mons.link" },
      }),
      testEnv,
      { waitUntil() {} },
      {
        repository,
        verifyIdentity: async () => ({ uid: "login-one" }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      profileId,
      revision: 1,
      prizes: {
        [eventId]: {
          eventId,
          profileId,
          place: 1,
          prizeId: "1092",
          assignedAtMs: 2_000,
          futureMetadata: { edition: 2 },
        },
      },
    });
  });

  it("includes a D1 bookmark for callers without a canonical profile", async () => {
    const repository: Pick<
      GameplayRepository,
      "getRtdbPath" | "readProfileOwnershipSnapshot"
    > = {
      getRtdbPath: async () => null,
      async readProfileOwnershipSnapshot() {
        return {
          loginOwnerByUid: new Map([["anonymous-login", null]]),
          canonicalProfileIdByProfileId: new Map(),
          loginUidsByProfileId: new Map(),
          profileById: new Map(),
        };
      },
    };
    const dependencies = {
      repository,
      verifyIdentity: async () => ({ uid: "anonymous-login" }),
    };
    const response = await handleEventReadRoute(
      new Request("https://api.mons.link/events/prizes", {
        headers: { Origin: "https://mons.link" },
      }),
      testEnv,
      { waitUntil() {} },
      dependencies,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      profileId: null,
      revision: 0,
      prizes: {},
    });
    const etag = response.headers.get("ETag");
    const bookmark = response.headers.get("X-D1-Bookmark");
    expect(etag).toBeTruthy();
    expect(bookmark).toBeTruthy();
    const conditional = await handleEventReadRoute(
      new Request("https://api.mons.link/events/prizes", {
        headers: {
          Origin: "https://mons.link",
          "If-None-Match": etag || "",
          "X-D1-Bookmark": bookmark || "",
        },
      }),
      testEnv,
      { waitUntil() {} },
      dependencies,
    );
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("ETag")).toBe(etag);
    expect(conditional.headers.get("X-D1-Bookmark")).toBeTruthy();
    expect(await conditional.text()).toBe("");
  });

  it("rejects event mutations while D1 event storage is frozen", async () => {
    await transitionEventStorageMode(testEnv.EVENT_DB, {
      expected: { storageMode: "d1" },
      next: { storageMode: "frozen" },
      nowMs: 4,
    });
    try {
      const response = await handleEventRoute(
        new Request("https://api.mons.link/events/create", {
          method: "POST",
          headers: { Origin: "https://mons.link" },
          body: "{}",
        }),
        testEnv,
        { waitUntil() {} },
        {
          assertEventWrites: () => assertEventWritesAllowed(testEnv.EVENT_DB),
          verifyIdentity: async () => ({ uid: "login-one" }),
        },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("60");
      expect(await response.json()).toEqual({
        ok: false,
        error: "unavailable",
        message: "event-writes-disabled",
      });
    } finally {
      await transitionEventStorageMode(testEnv.EVENT_DB, {
        expected: { storageMode: "frozen" },
        next: { storageMode: "d1" },
        nowMs: 5,
      });
    }
  });
});
