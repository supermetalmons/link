import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import { applyStrictMatchStateTestMigrations } from "./strictMatchStateTestFixture.ts";
import {
  applyEventTestMigrations,
  transitionEventStorageMode,
} from "./eventTestMigrations.ts";
import { handleEventReadRoute } from "../src/eventReadRoute.ts";
import { AuthApiFailure } from "../src/authErrors.ts";
import {
  eventBookmarkConstraint,
  MAX_EVENT_BOOKMARK_LENGTH,
  scopeEventBookmark,
} from "../src/eventBookmarks.ts";
import { handleEventRoute } from "../src/eventRoute.ts";
import {
  acquireEventWriteAdmission,
  assertEventWritesAllowed,
  patchEventOwnedPaths,
  releaseEventWriteAdmission,
} from "../src/eventD1.ts";
import type { GameplayRepository } from "../src/gameplayRepository.ts";

const testEnv = env as Env & {
  TEST_EVENT_D1_MIGRATIONS: D1Migration[];
  TEST_D1_MIGRATIONS: D1Migration[];
};
const eventId = "NN3eRzoZo80";
const profileId = "profile-one";

function observedEventDatabase(
  constraints: Array<string | undefined>,
): D1Database {
  return new Proxy(testEnv.EVENT_DB, {
    get(target, property) {
      if (property === "withSession") {
        return (constraint?: string) => {
          constraints.push(constraint);
          return target.withSession(constraint);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function snapshotDependencies() {
  return {
    repository: {
      getStatePath: async () => null,
      readProfileOwnershipSnapshot: async () => {
        throw new Error("unused");
      },
    },
    verifyIdentity: async () => ({ uid: "login-one" }),
  };
}

function prizeDependencies(canonicalProfileId: string | null = profileId) {
  return {
    ...snapshotDependencies(),
    repository: {
      getStatePath: async () => null,
      async readProfileOwnershipSnapshot() {
        return {
          loginOwnerByUid: new Map([
            [
              "login-one",
              canonicalProfileId
                ? { profileId: canonicalProfileId, revision: 1 }
                : null,
            ],
          ]),
          canonicalProfileIdByProfileId: new Map(),
          loginUidsByProfileId: new Map(
            canonicalProfileId ? [[canonicalProfileId, ["login-one"]]] : [],
          ),
          profileById: new Map(
            canonicalProfileId
              ? [
                  [
                    canonicalProfileId,
                    {
                      revision: 1,
                      profile: {
                        profileId: canonicalProfileId,
                        aura: "",
                        emoji: 1,
                        eth: "",
                        rating: 1_500,
                        sol: "",
                        username: "ivan",
                      },
                    },
                  ],
                ]
              : [],
          ),
        };
      },
    },
  };
}

function readRoute(
  path: string,
  headers: Record<string, string> = {},
  dependencies: Parameters<
    typeof handleEventReadRoute
  >[3] = snapshotDependencies(),
) {
  return handleEventReadRoute(
    new Request(`https://api.mons.link${path}`, {
      headers: { Origin: "https://mons.link", ...headers },
    }),
    testEnv,
    { waitUntil() {} },
    dependencies,
  );
}

async function updateEventState(updates: Record<string, unknown>) {
  const admission = await acquireEventWriteAdmission(testEnv.EVENT_DB);
  try {
    await patchEventOwnedPaths(testEnv.EVENT_DB, updates, { admission });
  } finally {
    await releaseEventWriteAdmission(testEnv.EVENT_DB, admission);
  }
}

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
    await applyStrictMatchStateTestMigrations(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
    );
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
          getStatePath: async () => null,
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
          getStatePath: async () => null,
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

  it.each([`/events/snapshot?eventId=${eventId}`, "/events/prizes"])(
    "only accepts the exact resource ETag for %s",
    async (path) => {
      const dependencies = prizeDependencies();
      const initial = await readRoute(path, {}, dependencies);
      expect(initial.status).toBe(200);
      const valueEtag = initial.headers.get("ETag")!;
      const body = await initial.text();
      const invalidEtags = [
        "*",
        valueEtag.slice(2),
        `${valueEtag}, ${valueEtag}`,
        valueEtag.replace(/-1"$/, '-01"'),
        valueEtag.replace(/-1"$/, '-1.0"'),
        valueEtag.replace(/-1"$/, '-9007199254740992"'),
        valueEtag.replace(/-1"$/, '--1"'),
        valueEtag
          .replace("event-snapshot", "profile-event-prizes")
          .replace("profile-one", "other-profile")
          .replace(eventId, "other-event"),
      ];
      for (const conditional of invalidEtags) {
        const response = await readRoute(
          path,
          { "If-None-Match": conditional },
          dependencies,
        );
        expect(response.status, conditional).toBe(200);
        expect(response.headers.get("ETag")).toBe(valueEtag);
        expect(await response.text()).toBe(body);
      }
      const unchanged = await readRoute(
        path,
        { "If-None-Match": ` ${valueEtag} ` },
        dependencies,
      );
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get("ETag")).toBe(valueEtag);
      expect(unchanged.headers.get("X-D1-Bookmark")).toBeTruthy();
      expect(await unchanged.text()).toBe("");
    },
  );

  it("returns updated snapshots after event and selection mutations", async () => {
    const path = `/events/snapshot?eventId=${eventId}`;
    let previous = await readRoute(path);
    expect(previous.status).toBe(200);
    for (const [updates, expected] of [
      [
        { [`events/${eventId}/startAtMs`]: 2_000 },
        { event: { startAtMs: 2_000 }, revision: 2 },
      ],
      [
        { [`eventPrizeSelections/${eventId}/${profileId}`]: null },
        { prizeSelections: {}, revision: 3 },
      ],
    ] as const) {
      await updateEventState(updates);
      const response = await readRoute(path, {
        "If-None-Match": previous.headers.get("ETag")!,
        "X-D1-Bookmark": previous.headers.get("X-D1-Bookmark")!,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("ETag")).not.toBe(
        previous.headers.get("ETag"),
      );
      expect(await response.json()).toMatchObject(expected);
      previous = response;
    }
  });

  it("returns updated prizes after assignment changes and deletion", async () => {
    const dependencies = prizeDependencies();
    let previous = await readRoute("/events/prizes", {}, dependencies);
    expect(previous.status).toBe(200);
    for (const [updates, expected] of [
      [
        {
          [`profileEventPrizes/${profileId}/${eventId}`]: {
            eventId,
            profileId,
            place: 1,
            prizeId: "1092",
            assignedAtMs: 3_000,
            futureMetadata: { edition: 2 },
          },
        },
        { prizes: { [eventId]: { assignedAtMs: 3_000 } }, revision: 2 },
      ],
      [
        { [`profileEventPrizes/${profileId}/${eventId}`]: null },
        { prizes: {}, revision: 3 },
      ],
    ] as const) {
      await updateEventState(updates);
      const response = await readRoute(
        "/events/prizes",
        {
          "If-None-Match": previous.headers.get("ETag")!,
          "X-D1-Bookmark": previous.headers.get("X-D1-Bookmark")!,
        },
        dependencies,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("ETag")).not.toBe(
        previous.headers.get("ETag"),
      );
      expect(await response.json()).toMatchObject(expected);
      previous = response;
    }
  });

  it.each([
    ["/events/snapshot?eventId=absent-event", snapshotDependencies()],
    ["/events/prizes", prizeDependencies("profile-without-prizes")],
    ["/events/prizes", prizeDependencies(null)],
  ])(
    "preserves revision-zero conditional reads for %s",
    async (path, dependencies) => {
      const initial = await readRoute(path, {}, dependencies);
      expect(initial.status).toBe(200);
      expect(await initial.json()).toMatchObject({ revision: 0 });
      const response = await readRoute(
        path,
        {
          "If-None-Match": initial.headers.get("ETag")!,
          "X-D1-Bookmark": initial.headers.get("X-D1-Bookmark")!,
        },
        dependencies,
      );
      expect(response.status).toBe(304);
      expect(response.headers.get("ETag")).toBe(initial.headers.get("ETag"));
      expect(response.headers.get("X-D1-Bookmark")).toBeTruthy();
      expect(await response.text()).toBe("");
    },
  );

  it("resolves ownership before evaluating a prize ETag", async () => {
    const initial = await readRoute("/events/prizes", {}, prizeDependencies());
    expect(initial.status).toBe(200);
    const response = await readRoute(
      "/events/prizes",
      { "If-None-Match": initial.headers.get("ETag")! },
      prizeDependencies("new-profile-owner"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      profileId: "new-profile-owner",
      revision: 0,
      prizes: {},
    });
  });

  it.each([`/events/snapshot?eventId=${eventId}`, "/events/prizes"])(
    "authenticates matching conditional requests for %s",
    async (path) => {
      const initial = await readRoute(path, {}, prizeDependencies());
      expect(initial.status).toBe(200);
      const response = await readRoute(
        path,
        { "If-None-Match": initial.headers.get("ETag")! },
        {
          ...prizeDependencies(),
          verifyIdentity: async () => {
            throw new AuthApiFailure(401, "unauthenticated", "unauthenticated");
          },
        },
      );
      expect(response.status).toBe(401);
    },
  );

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
          getStatePath: async () => null,
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

  it("replaces old or malformed bookmark scopes on primary without changing the body or ETag", async () => {
    const constraints: Array<string | undefined> = [];
    const configured = {
      ...testEnv,
      EVENT_DB: observedEventDatabase(constraints),
    };
    const url = `https://api.mons.link/events/snapshot?eventId=${eventId}`;
    const baseline = await handleEventReadRoute(
      new Request(url, { headers: { Origin: "https://mons.link" } }),
      configured,
      { waitUntil() {} },
      snapshotDependencies(),
    );
    expect(baseline.status).toBe(200);
    const baselineBody = await baseline.text();
    const etag = baseline.headers.get("ETag")!;
    const epoch: string = testEnv.EVENT_DB_BOOKMARK_EPOCH;
    const prefix = `mons-d1-v1:${epoch}:`;
    const foreignEpoch =
      epoch === "00000000-0000-4000-8000-000000000001"
        ? "00000000-0000-4000-8000-000000000002"
        : "00000000-0000-4000-8000-000000000001";
    const headers = [
      "old-native-bookmark",
      scopeEventBookmark("native-from-old-database", foreignEpoch),
      "mons-d1-v1:invalid:bookmark",
      `${prefix}native with whitespace`,
      `${prefix}${"x".repeat(MAX_EVENT_BOOKMARK_LENGTH)}`,
      "",
    ];
    for (const bookmark of headers) {
      const response = await handleEventReadRoute(
        new Request(url, {
          headers: { Origin: "https://mons.link", "X-D1-Bookmark": bookmark },
        }),
        configured,
        { waitUntil() {} },
        snapshotDependencies(),
      );
      expect(response.status).toBe(200);
      expect(constraints.at(-1)).toBe("first-primary");
      expect(response.headers.get("ETag")).toBe(etag);
      expect(response.headers.get("X-D1-Bookmark")?.startsWith(prefix)).toBe(
        true,
      );
      expect(await response.text()).toBe(baselineBody);
      const conditional = await handleEventReadRoute(
        new Request(url, {
          headers: {
            Origin: "https://mons.link",
            "X-D1-Bookmark": bookmark,
            "If-None-Match": etag,
          },
        }),
        configured,
        { waitUntil() {} },
        snapshotDependencies(),
      );
      expect(conditional.status).toBe(304);
      expect(constraints.at(-1)).toBe("first-primary");
      expect(conditional.headers.get("ETag")).toBe(etag);
      expect(conditional.headers.get("X-D1-Bookmark")?.startsWith(prefix)).toBe(
        true,
      );
      expect(await conditional.text()).toBe("");
    }
  });

  it("continues a matching scoped bookmark as the exact native D1 constraint", async () => {
    const constraints: Array<string | undefined> = [];
    const configured = {
      ...testEnv,
      EVENT_DB: observedEventDatabase(constraints),
    };
    const url = `https://api.mons.link/events/snapshot?eventId=${eventId}`;
    const first = await handleEventReadRoute(
      new Request(url, { headers: { Origin: "https://mons.link" } }),
      configured,
      { waitUntil() {} },
      snapshotDependencies(),
    );
    const bookmark = first.headers.get("X-D1-Bookmark")!;
    const native = eventBookmarkConstraint(
      bookmark,
      testEnv.EVENT_DB_BOOKMARK_EPOCH,
    );
    expect(native).not.toBe("first-primary");
    const second = await handleEventReadRoute(
      new Request(url, {
        headers: {
          Origin: "https://mons.link",
          "X-D1-Bookmark": bookmark,
          "If-None-Match": first.headers.get("ETag")!,
        },
      }),
      configured,
      { waitUntil() {} },
      snapshotDependencies(),
    );
    expect(second.status).toBe(304);
    expect(constraints.at(-1)).toBe(native);
    expect(
      second.headers
        .get("X-D1-Bookmark")
        ?.startsWith(`mons-d1-v1:${testEnv.EVENT_DB_BOOKMARK_EPOCH}:`),
    ).toBe(true);
  });

  it("fails closed for missing or invalid bookmark epochs without changing authentication errors", async () => {
    for (const epoch of [undefined, "", "invalid"]) {
      const constraints: Array<string | undefined> = [];
      const configured = new Proxy(
        { ...testEnv, EVENT_DB: observedEventDatabase(constraints) },
        {
          get(target, property) {
            return property === "EVENT_DB_BOOKMARK_EPOCH"
              ? epoch
              : Reflect.get(target, property);
          },
        },
      );
      const request = new Request(
        `https://api.mons.link/events/snapshot?eventId=${eventId}`,
        { headers: { Origin: "https://mons.link" } },
      );
      const response = await handleEventReadRoute(
        request,
        configured,
        { waitUntil() {} },
        snapshotDependencies(),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        ok: false,
        error: "unavailable",
        message: "event-read-unavailable",
      });
      expect(constraints).toEqual([]);
      const unauthorized = await handleEventReadRoute(
        request,
        configured,
        { waitUntil() {} },
        {
          ...snapshotDependencies(),
          verifyIdentity: async () => {
            throw new AuthApiFailure(401, "unauthenticated", "unauthenticated");
          },
        },
      );
      expect(unauthorized.status).toBe(401);
      expect(constraints).toEqual([]);
    }
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
          getStatePath: async () => {
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
      "getStatePath" | "readProfileOwnershipSnapshot"
    > = {
      getStatePath: async () => null,
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
      "getStatePath" | "readProfileOwnershipSnapshot"
    > = {
      getStatePath: async () => null,
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
