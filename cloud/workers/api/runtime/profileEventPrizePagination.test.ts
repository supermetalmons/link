import { Buffer } from "node:buffer";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { D1Migration } from "cloudflare:test";
import {
  isProfileEventPrizesPageResponse,
  isProfileEventPrizesResponse,
  MAX_PROFILE_EVENT_PRIZES_CURSOR_LENGTH,
  profileEventPrizesPageEtag,
  type ProfileEventPrizesPageResponse,
} from "@mons/shared/event-prizes";
import { MAX_EVENT_READ_RESPONSE_BYTES } from "@mons/shared/events";
import { handleEventReadRoute } from "../src/eventReadRoute.ts";
import { readProfileEventPrizePage } from "../src/eventD1/reads.ts";
import type { ProfileOwnershipReader } from "../src/profileOwnership.ts";
import { applyEventTestMigrations } from "./eventTestMigrations.ts";

const testEnv = env as Env & { TEST_EVENT_D1_MIGRATIONS: D1Migration[] };
const profileId = "profile-one";
const epoch = testEnv.EVENT_DB_BOOKMARK_EPOCH;
const path = "/events/prizes?pagination=1";

function environmentWithEpoch(value: string): Env {
  return new Proxy(testEnv, {
    get(target, property) {
      return property === "EVENT_DB_BOOKMARK_EPOCH"
        ? value
        : Reflect.get(target, property);
    },
  });
}

function ownership(owner: string | null): ProfileOwnershipReader {
  return {
    async readProfileOwnershipSnapshot() {
      return {
        loginOwnerByUid: new Map([
          ["login-one", owner ? { profileId: owner, revision: 1 } : null],
        ]),
        canonicalProfileIdByProfileId: new Map(),
        loginUidsByProfileId: new Map(owner ? [[owner, ["login-one"]]] : []),
        profileById: new Map(
          owner
            ? [
                [
                  owner,
                  {
                    revision: 1,
                    profile: {
                      profileId: owner,
                      aura: "",
                      emoji: 1,
                      eth: "",
                      rating: 1500,
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
  };
}

function request(
  url = path,
  headers: Record<string, string> = {},
  owner: string | null = profileId,
  workerEnv: Env = testEnv,
) {
  return handleEventReadRoute(
    new Request(`https://api.mons.link${url}`, {
      headers: { Origin: "https://mons.link", ...headers },
    }),
    workerEnv,
    { waitUntil() {} },
    {
      repository: ownership(owner),
      verifyIdentity: async () => ({ uid: "login-one" }),
    },
  );
}

async function seed(
  ids: string[],
  extra: Record<string, unknown> = {},
  owner = profileId,
) {
  for (let offset = 0; offset < ids.length; offset += 40) {
    await testEnv.EVENT_DB.batch(
      ids.slice(offset, offset + 40).flatMap((eventId) => [
        testEnv.EVENT_DB.prepare(
          `INSERT INTO event_records (event_id, status, start_at_ms, updated_at_ms, record_json)
         VALUES (?, 'ended', 1, 1, '{}')`,
        ).bind(eventId),
        testEnv.EVENT_DB.prepare(
          `INSERT INTO profile_event_prizes (profile_id, event_id, assignment_json, updated_at_ms)
         VALUES (?, ?, ?, 1)`,
        ).bind(
          owner,
          eventId,
          JSON.stringify({
            eventId,
            profileId: owner,
            place: 1,
            prizeId: "future-prize",
            assignedAtMs: 1,
            ...extra,
          }),
        ),
      ]),
    );
  }
  await testEnv.EVENT_DB.prepare(
    "INSERT OR REPLACE INTO profile_event_prize_revisions (profile_id, revision, updated_at_ms) VALUES (?, 1, 1)",
  )
    .bind(owner)
    .run();
}

async function page(
  response: Response,
): Promise<ProfileEventPrizesPageResponse> {
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(isProfileEventPrizesPageResponse(body)).toBe(true);
  if (!isProfileEventPrizesPageResponse(body)) throw new Error("invalid-page");
  return body;
}

function continuation(cursor: string | null): string {
  expect(cursor).not.toBeNull();
  return `${path}&cursor=${encodeURIComponent(cursor || "")}`;
}

function cursorWith(
  cursor: string | null,
  patch: Record<string, unknown>,
): string {
  const decoded = JSON.parse(
    Buffer.from(cursor || "", "base64url").toString("utf8"),
  );
  return Buffer.from(JSON.stringify({ ...decoded, ...patch })).toString(
    "base64url",
  );
}

describe("profile prize pagination", () => {
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
      testEnv.EVENT_DB.prepare("DELETE FROM event_records"),
    ]);
  });

  it("keeps legacy shape and reads bounded pages", async () => {
    const ids = Array.from(
      { length: 102 },
      (_, index) => `event-${String(index).padStart(3, "0")}`,
    );
    await seed(ids, { futureMetadata: { edition: 2 } });
    const legacy = await request("/events/prizes");
    const legacyBody = await legacy.json();
    expect(isProfileEventPrizesResponse(legacyBody)).toBe(true);
    expect(isProfileEventPrizesPageResponse(legacyBody)).toBe(false);
    const firstResponse = await request();
    const first = await page(firstResponse);
    expect(Object.keys(first.prizes)).toEqual(ids.slice(0, 100));
    expect(isProfileEventPrizesResponse(first)).toBe(false);
    expect(first.prizes[ids[0]].futureMetadata).toEqual({ edition: 2 });
    expect(firstResponse.headers.get("ETag")).toBe(
      profileEventPrizesPageEtag(epoch, profileId, 1),
    );
    const secondResponse = await request(continuation(first.nextCursor), {
      "X-D1-Bookmark": firstResponse.headers.get("X-D1-Bookmark") || "",
      "If-None-Match": firstResponse.headers.get("ETag") || "",
    });
    const second = await page(secondResponse);
    expect(Object.keys(second.prizes)).toEqual(ids.slice(100));
    expect(second.nextCursor).toBeNull();
    expect(secondResponse.headers.get("ETag")).toBe(
      firstResponse.headers.get("ETag"),
    );
  });

  it("uses database ordering across Unicode page boundaries", async () => {
    const ids = [
      ...Array.from({ length: 99 }, (_, index) => `a-${index}`),
      "\uE000",
      "😀",
    ];
    await seed(ids);
    const first = await page(await request());
    expect(Object.keys(first.prizes).at(-1)).toBe("\uE000");
    const second = await page(await request(continuation(first.nextCursor)));
    expect(Object.keys(second.prizes)).toEqual(["😀"]);
    expect(second.nextCursor).toBeNull();
  });

  it("roundtrips cursors containing maximum-length escaped record keys", async () => {
    const escaped = "\\".repeat(768);
    await seed(
      [...Array.from({ length: 99 }, (_, index) => `A-${index}`), escaped, "z"],
      {},
      escaped,
    );
    const first = await page(await request(path, {}, escaped));
    expect(first.nextCursor!.length).toBeGreaterThan(4096);
    expect(first.nextCursor!.length).toBeLessThanOrEqual(
      MAX_PROFILE_EVENT_PRIZES_CURSOR_LENGTH,
    );
    const second = await page(
      await request(continuation(first.nextCursor), {}, escaped),
    );
    expect(Object.keys(second.prizes)).toEqual(["z"]);
    expect(second.nextCursor).toBeNull();
  });

  it("keeps byte-limited pages complete without skipping assignments", async () => {
    await seed(["event-a", "event-b", "event-c"], {
      futureMetadata: "é".repeat(160_000),
    });
    const received: string[] = [];
    let url = path;
    do {
      const response = await request(url);
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
        MAX_EVENT_READ_RESPONSE_BYTES,
      );
      const body = JSON.parse(text) as ProfileEventPrizesPageResponse;
      expect(isProfileEventPrizesPageResponse(body)).toBe(true);
      received.push(...Object.keys(body.prizes));
      url = body.nextCursor ? continuation(body.nextCursor) : "";
    } while (url);
    expect(received).toEqual(["event-a", "event-b", "event-c"]);
  });

  it("serves a complete page that fits only after removing its provisional cursor", async () => {
    const owner = "profile";
    await seed(["event-0"], { extra: "é".repeat(327_520) }, owner);
    await seed(["event-1"], { extra: "é" }, owner);
    const legacy = await request("/events/prizes", {}, owner);
    expect(legacy.status).toBe(200);
    const complete = {
      ...(await legacy.json<Record<string, unknown>>()),
      nextCursor: null,
    };
    expect(isProfileEventPrizesPageResponse(complete)).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(complete)).byteLength,
    ).toBeLessThanOrEqual(MAX_EVENT_READ_RESPONSE_BYTES);

    const response = await request(path, {}, owner);
    expect(await page(response)).toEqual(complete);
  });

  it("retains an error when one assignment exceeds the response budget", async () => {
    await seed(["event-a"], {
      futureMetadata: "x".repeat(MAX_EVENT_READ_RESPONSE_BYTES),
    });
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      message: "event-response-too-large",
    });
  });

  it("revalidates only the matching epoch-bound first page", async () => {
    await seed(["event-a"]);
    const first = await request();
    const headers = { "If-None-Match": first.headers.get("ETag") || "" };
    expect((await request(path, headers)).status).toBe(304);
    const nextEpoch = "00000000-0000-0000-0000-000000000001";
    const next = await request(
      path,
      headers,
      profileId,
      environmentWithEpoch(nextEpoch),
    );
    expect(next.status).toBe(200);
    expect(next.headers.get("ETag")).toBe(
      profileEventPrizesPageEtag(nextEpoch, profileId, 1),
    );
    const legacy = await request("/events/prizes");
    expect(
      (
        await request(path, {
          "If-None-Match": legacy.headers.get("ETag") || "",
        })
      ).status,
    ).toBe(200);
  });

  it.each([null, "profile-empty"])(
    "handles empty history and conditional reads for %s",
    async (owner) => {
      const first = await request(path, {}, owner);
      const body = await page(first);
      expect(body).toEqual({
        ok: true,
        profileId: owner,
        revision: 0,
        prizes: {},
        nextCursor: null,
      });
      expect(first.headers.get("X-D1-Bookmark")).toBeTruthy();
      expect(
        (
          await request(
            path,
            { "If-None-Match": first.headers.get("ETag") || "" },
            owner,
          )
        ).status,
      ).toBe(304);
    },
  );

  it("rejects continuations after revision, epoch or canonical ownership changes", async () => {
    await seed(Array.from({ length: 101 }, (_, index) => `event-${index}`));
    const first = await page(await request());
    const url = continuation(first.nextCursor);
    for (const [owner, workerEnv] of [
      ["profile-two", testEnv],
      [null, testEnv],
      [profileId, environmentWithEpoch("00000000-0000-0000-0000-000000000001")],
    ] as const) {
      const response = await request(url, {}, owner, workerEnv);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "aborted",
        message: "event-prizes-snapshot-changed",
      });
    }
    await testEnv.EVENT_DB.prepare(
      "DELETE FROM event_records WHERE event_id = 'event-0'",
    ).run();
    const changed = await request(url);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({
      message: "event-prizes-snapshot-changed",
    });
    expect((await page(await request())).revision).toBe(2);
  });

  it("rejects malformed and duplicate cursors before reading a page", async () => {
    await seed(Array.from({ length: 101 }, (_, index) => `event-${index}`));
    const first = await page(await request());
    for (const cursor of [
      "",
      "not_base64!",
      "a".repeat(MAX_PROFILE_EVENT_PRIZES_CURSOR_LENGTH + 1),
      cursorWith(first.nextCursor, { version: 2 }),
      cursorWith(first.nextCursor, { revision: -1 }),
      cursorWith(first.nextCursor, { afterEventId: "bad/key" }),
      cursorWith(first.nextCursor, { extra: true }),
    ]) {
      expect(
        (await request(`${path}&cursor=${encodeURIComponent(cursor)}`)).status,
      ).toBe(400);
    }
    expect(
      (
        await request(
          `${continuation(first.nextCursor)}&cursor=${first.nextCursor}`,
        )
      ).status,
    ).toBe(400);
  });

  it("skips assignment decoding for an unchanged stored revision and validates changed pages", async () => {
    await seed(["event-a"]);
    await testEnv.EVENT_DB.prepare(
      "UPDATE profile_event_prizes SET assignment_json = '{}' WHERE profile_id = ?",
    )
      .bind(profileId)
      .run();
    expect(
      (
        await request(path, {
          "If-None-Match": profileEventPrizesPageEtag(epoch, profileId, 1),
        })
      ).status,
    ).toBe(304);
    expect((await request()).status).toBe(503);
    await testEnv.EVENT_DB.prepare(
      "DELETE FROM profile_event_prize_revisions WHERE profile_id = ?",
    )
      .bind(profileId)
      .run();
    expect(
      (
        await request(path, {
          "If-None-Match": profileEventPrizesPageEtag(epoch, profileId, 0),
        })
      ).status,
    ).toBe(503);
  });

  it("reads page rows and revision in one bounded batch using the existing primary key", async () => {
    await seed(Array.from({ length: 105 }, (_, index) => `event-${index}`));
    const prepared: Array<{ sql: string; values: unknown[] }> = [];
    let batches = 0;
    const db = {
      prepare(sql: string) {
        const statement = testEnv.EVENT_DB.prepare(sql);
        return new Proxy(statement, {
          get(target, property) {
            if (property === "bind")
              return (...values: unknown[]) => {
                prepared.push({ sql, values });
                return target.bind(...values);
              };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      batch: async <T>(statements: D1PreparedStatement[]) => {
        batches++;
        return testEnv.EVENT_DB.batch<T>(statements);
      },
    };
    const results = await readProfileEventPrizePage(db, profileId);
    expect(batches).toBe(1);
    expect(prepared).toHaveLength(2);
    expect(results.entries).toHaveLength(101);
    expect(results.revision).toBe(1);
    const plan = await testEnv.EVENT_DB.prepare(
      `EXPLAIN QUERY PLAN ${prepared[1].sql}`,
    )
      .bind(...prepared[1].values)
      .all<{ detail: string }>();
    expect(
      plan.results.some((row) =>
        row.detail.includes("SEARCH profile_event_prizes USING PRIMARY KEY"),
      ),
    ).toBe(true);
    expect(plan.results.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(
      false,
    );
    expect(
      await readProfileEventPrizePage(testEnv.EVENT_DB, profileId, {
        expectedRevision: 2,
      }),
    ).toEqual({ revision: 1, entries: [] });
  });
});
