import assert from "node:assert/strict";
import test from "node:test";
import {
  captureEventBookmarkProbe,
  runMigrationReadSmokes,
  type EventBookmarkProbe,
  type ReadSmokeDatabases,
} from "./smokes.ts";
import { scopeEventBookmark } from "../../cloud/workers/api/src/eventBookmarks.ts";
import type { SqlQuery } from "./workflows.ts";

type JsonRecord = Record<string, unknown>;
const NOW = 1_800_000_000_000;
const ORIGIN = "https://mons.link";
const uuid = (number: number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const source: ReadSmokeDatabases = {
  gameplayDatabaseId: uuid(1),
  eventDatabaseId: uuid(2),
  profileDatabaseId: uuid(3),
};
const destination: ReadSmokeDatabases = {
  gameplayDatabaseId: uuid(4),
  eventDatabaseId: uuid(5),
  profileDatabaseId: uuid(6),
};

function fixture() {
  const match = {
    version: 2,
    color: "white",
    emojiId: 1,
    aura: "",
    gameVariant: "Classic",
    fen: "fen",
    status: "surrendered",
    flatMovesString: "move",
    timer: "",
  };
  const pair = {
    matchId: "match-1",
    hostPlayerId: "old-host",
    guestPlayerId: "old-guest",
    hostMatch: match,
    guestMatch: { ...match, color: "black", emojiId: 2 },
  };
  const history = {
    invite_id: "invite-1",
    match_id: "match-1",
    revision: 1,
    snapshot_json: JSON.stringify(pair),
  };
  const profile = {
    profile_id: "public-existing-profile",
    state: "active",
    revision: 3,
    payload_json: JSON.stringify({
      id: "public-existing-profile",
      nonce: 1,
      rating: 1500,
      totalManaPoints: 0,
      win: true,
      emoji: 1,
      username: null,
      eth: null,
      sol: null,
      mining: {
        lastRockDate: null,
        materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
      },
    }),
  };
  const events = new Map<string, JsonRecord>([
    [
      "current-event",
      {
        event_id: "current-event",
        status: "scheduled",
        revision: 2,
        record_json: JSON.stringify({
          eventId: "current-event",
          status: "scheduled",
          participants: {},
        }),
        selections_json: "[]",
      },
    ],
    [
      "ended-event",
      {
        event_id: "ended-event",
        status: "ended",
        revision: 5,
        record_json: JSON.stringify({
          eventId: "ended-event",
          status: "ended",
          prizeAssignments: {
            1: {
              eventId: "ended-event",
              profileId: "public-existing-profile",
              prizeId: "prize-1",
              place: 1,
              assignedAtMs: 1,
            },
          },
        }),
        selections_json: JSON.stringify([
          { profile_id: "public-existing-profile", prize_id: "prize-1" },
        ]),
      },
    ],
  ]);
  const queries: Array<{ databaseId: string; sql: string; params: unknown[] }> =
    [];
  const http: Array<{
    path: string;
    method: string;
    headers: Headers;
    body: unknown;
  }> = [];
  const state = {
    destinationHistory: structuredClone(history),
    destinationProfile: structuredClone(profile),
    destinationEvents: structuredClone(events),
    sessionId: "",
    refreshSecret: "",
    revokeSecret: "",
    token: "",
    responseStatus: 200,
    failPath: "",
    leakPrizeProfile: false,
    wrongEventResponse: false,
    advanceCurrentOnce: false,
    shortInitialToken: false,
    failCleanup: false,
    missingBookmark: false,
    eventBookmark: "destination-bookmark",
    returnConditional304: false,
    logs: [] as unknown[],
  };

  const query: SqlQuery = async (databaseId, sql, params = []) => {
    queries.push({ databaseId, sql, params: structuredClone(params) });
    assert.match(
      sql.trim(),
      /^SELECT /i,
      "migration read probes must not write SQL",
    );
    if (sql.includes("FROM historical_match_pairs"))
      return [
        structuredClone(
          databaseId === source.gameplayDatabaseId
            ? history
            : state.destinationHistory,
        ),
      ];
    if (sql.includes("FROM profile_records"))
      return [
        structuredClone(
          databaseId === source.profileDatabaseId
            ? profile
            : state.destinationProfile,
        ),
      ];
    if (sql.includes("SELECT event_id FROM"))
      return [
        {
          event_id: sql.includes("status = 'ended'")
            ? "ended-event"
            : "current-event",
        },
      ];
    assert(sql.includes("event_prize_selections"));
    const rows =
      databaseId === source.eventDatabaseId ? events : state.destinationEvents;
    const row = rows.get(String(params[0]));
    return row ? [structuredClone(row)] : [];
  };

  function sessionResponse(short = false): Response {
    state.token = `header.${Buffer.from(JSON.stringify({ sub: "A".repeat(28), sid: state.sessionId })).toString("base64url")}.signature`;
    return Response.json({
      ok: true,
      uid: "A".repeat(28),
      sessionId: state.sessionId,
      accessToken: state.token,
      accessExpiresAtMs: NOW + (short ? 1 : 300_000),
    });
  }

  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.mons.link");
    const path = url.pathname;
    const method = init.method || "GET";
    const headers = new Headers(init.headers);
    const body = init.body
      ? (JSON.parse(String(init.body)) as JsonRecord)
      : null;
    http.push({ path, method, headers, body });
    assert.equal(init.redirect, "error");
    if (path === "/auth/session/anonymous") {
      assert.equal(method, "POST");
      state.sessionId = String(body!.sessionId);
      state.refreshSecret = String(body!.refreshSecret);
      state.revokeSecret = String(body!.revokeSecret);
      return sessionResponse(state.shortInitialToken);
    }
    if (path === "/auth/session/refresh") {
      assert.equal(
        headers.get("Authorization"),
        `Bearer mrs1.${state.sessionId}.${state.refreshSecret}`,
      );
      return sessionResponse();
    }
    if (path === "/auth/session/logout") {
      assert.equal(method, "POST");
      assert.equal(
        headers.get("Authorization"),
        `Bearer mrv1.${state.sessionId}.${state.revokeSecret}`,
        "only the probe-owned session can be revoked",
      );
      return new Response(null, { status: state.failCleanup ? 503 : 204 });
    }
    if (path === state.failPath)
      return Response.json(
        { privateError: "must-not-log" },
        { status: state.responseStatus },
      );
    const responseHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": path === "/matches/history" ? "*" : ORIGIN,
    };
    if (path !== "/matches/history")
      assert.equal(headers.get("Authorization"), `Bearer ${state.token}`);
    if (path.startsWith("/events/")) {
      responseHeaders.ETag = 'W/"revision"';
      if (!state.missingBookmark)
        responseHeaders["X-D1-Bookmark"] = state.eventBookmark;
    }
    if (path === "/matches/history") {
      assert.equal(headers.has("Authorization"), false);
      assert.equal(url.searchParams.get("inviteId"), history.invite_id);
      assert.equal(url.searchParams.get("matchId"), history.match_id);
      return Response.json({ ok: true, pair }, { headers: responseHeaders });
    }
    if (path === "/events/snapshot") {
      if (headers.has("If-None-Match") && state.returnConditional304)
        return new Response(null, { status: 304, headers: responseHeaders });
      const id = url.searchParams.get("eventId")!;
      const row = state.destinationEvents.get(id)!;
      if (id === "current-event" && state.advanceCurrentOnce) {
        state.advanceCurrentOnce = false;
        row.revision = Number(row.revision) + 1;
        const event = JSON.parse(String(row.record_json));
        event.participants.newParticipant = {
          profileId: "legitimate-live-change",
        };
        row.record_json = JSON.stringify(event);
      }
      return Response.json(
        {
          ok: true,
          eventId: id,
          revision: state.wrongEventResponse ? 999 : row.revision,
          event: JSON.parse(String(row.record_json)),
          prizeSelections: Object.fromEntries(
            (JSON.parse(String(row.selections_json)) as JsonRecord[]).map(
              (selection) => [selection.profile_id, selection.prize_id],
            ),
          ),
        },
        { headers: responseHeaders },
      );
    }
    if (path === "/profiles/lookup") {
      assert.equal(method, "POST");
      assert.deepEqual(body, { kind: "profile", id: profile.profile_id });
      return Response.json(
        {
          ok: true,
          profile: JSON.parse(state.destinationProfile.payload_json),
        },
        { headers: responseHeaders },
      );
    }
    assert.equal(path, "/events/prizes");
    return Response.json(
      {
        ok: true,
        profileId: state.leakPrizeProfile ? "another-users-profile" : null,
        revision: 0,
        prizes: {},
      },
      { headers: responseHeaders },
    );
  };
  const run = (oldEventBookmark?: EventBookmarkProbe) =>
    runMigrationReadSmokes({
      source,
      destination,
      query,
      fetcher,
      now: () => NOW,
      ...(oldEventBookmark ? { oldEventBookmark } : {}),
      log: (counts) => state.logs.push(counts),
    });
  return { state, query, fetcher, queries, http, run };
}

test("reads public history/events/profile with an owned anonymous session and logs only counts", async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.history, 1);
  assert.equal(result.currentEvents, 1);
  assert.equal(result.endedEvents, 1);
  assert.equal(result.publicProfiles, 1);
  assert.equal(result.anonymousPrizeIsolation, true);
  assert.equal(result.userPrizeOwnershipChecked, false);
  assert.equal(result.sessionRevoked, true);
  assert.equal(
    f.http.filter((call) => call.path === "/auth/session/logout").length,
    1,
  );
  assert.equal(f.http.filter((call) => call.method === "POST").length, 3);
  assert.equal(f.state.logs.length, 1);
  assert.equal(JSON.stringify(f.state.logs).includes(f.state.token), false);
  assert.equal(JSON.stringify(result).includes(f.state.refreshSecret), false);
  assert.equal(
    JSON.stringify(result).includes("public-existing-profile"),
    false,
  );
  assert.deepEqual(Object.keys(f.state.logs[0] as JsonRecord).sort(), [
    "anonymousPrizeIsolation",
    "currentEvents",
    "endedEvents",
    "history",
    "publicProfiles",
    "sessionRevoked",
    "userPrizeOwnershipChecked",
  ]);
});

test("HTTP validation failures still revoke only the session created by the probe", async () => {
  const f = fixture();
  f.state.wrongEventResponse = true;
  await assert.rejects(f.run(), /http-database-snapshot-mismatch/);
  assert.equal(
    f.http.filter((call) => call.path === "/auth/session/logout").length,
    1,
  );
  assert.equal(f.state.logs.length, 0);
});

test("mismatched immutable history blocks before creating an anonymous session", async () => {
  const f = fixture();
  f.state.destinationHistory.snapshot_json = JSON.stringify({ changed: true });
  await assert.rejects(f.run(), /historical-copy-mismatch/);
  assert.equal(f.http.length, 0);
});

test("a concurrent legitimate event revision is reread without writes or artificial waits", async () => {
  const f = fixture();
  f.state.advanceCurrentOnce = true;
  const result = await f.run();
  assert.equal(result.evidence.currentEvent.liveRevisionAdvanced, true);
  assert.equal(
    f.http.filter((call) => call.path === "/events/snapshot").length,
    3,
  );
  assert(f.queries.every((call) => /^SELECT /i.test(call.sql.trim())));
});

test("the anonymous prize endpoint must not return another user's profile", async () => {
  const f = fixture();
  f.state.leakPrizeProfile = true;
  await assert.rejects(f.run(), /anonymous-prize-isolation-failed/);
  assert.equal(f.http.at(-1)!.path, "/auth/session/logout");
});

test("refreshing the probe's own token preserves its session and cleanup capability", async () => {
  const f = fixture();
  f.state.shortInitialToken = true;
  await f.run();
  assert.equal(
    f.http.filter((call) => call.path === "/auth/session/refresh").length,
    1,
  );
  assert.equal(
    f.http.filter((call) => call.path === "/auth/session/anonymous").length,
    1,
  );
  assert.equal(f.http.at(-1)!.path, "/auth/session/logout");
});

test("missing D1 bookmark headers fail the read probe and still clean up", async () => {
  const f = fixture();
  f.state.missingBookmark = true;
  await assert.rejects(f.run(), /event-version-headers-missing/);
  assert.equal(f.http.at(-1)!.path, "/auth/session/logout");
});

test("cleanup failure prevents a successful result and count log", async () => {
  const f = fixture();
  f.state.failCleanup = true;
  await assert.rejects(f.run(), /logout returned 503/);
  assert.equal(f.state.logs.length, 0);
});

test("untrusted origins and same-source destination IDs fail before credentials exist", async () => {
  const f = fixture();
  await assert.rejects(
    runMigrationReadSmokes({
      source,
      destination,
      query: f.query,
      fetcher: f.fetcher,
      baseUrl: "https://foreign.invalid",
    }),
    /untrusted-api-origin/,
  );
  await assert.rejects(
    runMigrationReadSmokes({
      source,
      destination: source,
      query: f.query,
      fetcher: f.fetcher,
    }),
    /invalid-database-identities/,
  );
  assert.equal(f.http.length, 0);
  assert.equal(f.queries.length, 0);
});

for (const conditional304 of [false, true]) {
  test(`an actual captured old bookmark recovers to the destination scope with HTTP ${conditional304 ? 304 : 200}`, async () => {
    const f = fixture();
    f.state.eventBookmark = "old-native-bookmark";
    const probe = await captureEventBookmarkProbe({
      query: f.query,
      eventDatabaseId: source.eventDatabaseId,
      fetcher: f.fetcher,
    });
    assert.deepEqual(probe, {
      eventId: "current-event",
      bookmark: "old-native-bookmark",
      etag: 'W/"revision"',
    });
    assert.equal(f.http.at(-1)!.path, "/auth/session/logout");
    f.state.eventBookmark = scopeEventBookmark(
      "new-native-bookmark",
      destination.eventDatabaseId,
    );
    f.state.returnConditional304 = conditional304;
    const result = await f.run(probe);
    assert.equal(result.oldEventBookmarkRecovered, true);
    const replay = f.http.find((call) => call.headers.has("If-None-Match"));
    assert.equal(replay!.headers.get("X-D1-Bookmark"), probe.bookmark);
    assert.equal(replay!.headers.get("If-None-Match"), probe.etag);
    assert.equal(
      f.http.filter((call) => call.path === "/auth/session/logout").length,
      2,
    );
    assert.equal(JSON.stringify(probe).includes(f.state.token), false);
  });
}

test("old bookmark verification rejects a response still scoped to the source database", async () => {
  const f = fixture();
  f.state.eventBookmark = scopeEventBookmark(
    "native-from-source",
    source.eventDatabaseId,
  );
  await assert.rejects(
    f.run({
      eventId: "current-event",
      bookmark: "old-native-bookmark",
      etag: 'W/"revision"',
    }),
    /old-event-bookmark-not-recovered/,
  );
  assert.equal(f.http.at(-1)!.path, "/auth/session/logout");
  assert.equal(f.state.logs.length, 0);
});
