import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { handleHistoricalMatchRoute } from "../src/historicalMatchRoute.ts";
import { writeHistoricalMatchSnapshot } from "../src/historicalMatchesD1.ts";

const testEnv = env as Env & { TEST_D1_MIGRATIONS: D1Migration[] };

function match(color: "black" | "white") {
  return {
    version: 2,
    color,
    emojiId: color === "white" ? 1 : 2,
    aura: "",
    gameVariant: "Classic",
    fen: "fen",
    status: "surrendered",
    flatMovesString: "move",
    timer: "",
  };
}

function pair(matchId = "invite-1") {
  return {
    matchId,
    hostPlayerId: "host",
    guestPlayerId: "guest",
    hostMatch: match("white"),
    guestMatch: match("black"),
  };
}

function request(query = "inviteId=invite-1&matchId=invite-1", method = "GET") {
  return new Request(`https://api.mons.link/matches/history?${query}`, {
    method,
  });
}

describe("historical match public route", () => {
  beforeAll(async () => {
    await applyD1Migrations(
      testEnv.PROFILE_GAMES_DB,
      testEnv.TEST_D1_MIGRATIONS,
    );
  });

  beforeEach(async () => {
    await env.PROFILE_GAMES_DB.prepare(
      "DELETE FROM historical_match_pairs",
    ).run();
  });

  it("serves D1 without authentication or RTDB access", async () => {
    await writeHistoricalMatchSnapshot(env.PROFILE_GAMES_DB, {
      archivedAtMs: 1_000,
      finalizedAtMs: 1_000,
      inviteId: "invite-1",
      pair: pair(),
      source: "rating",
    });
    const response = await handleHistoricalMatchRoute(request(), env, {
      rateLimiter: { limit: async () => ({ success: false }) },
      rtdb: {
        getRtdbPath: async () => {
          throw new Error("must-not-read-rtdb");
        },
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toEqual({ ok: true, pair: pair() });
  });

  it("returns null on a D1 miss when fallback is disabled", async () => {
    const response = await handleHistoricalMatchRoute(request(), env, {
      fallbackEnabled: false,
      rtdb: {
        getRtdbPath: async () => {
          throw new Error("must-not-read-rtdb");
        },
      },
    });
    expect(await response.json()).toEqual({ ok: true, pair: null });
  });

  it("rate limits public RTDB fallback misses", async () => {
    let rtdbReads = 0;
    const keys: string[] = [];
    const response = await handleHistoricalMatchRoute(request(), env, {
      fallbackEnabled: true,
      rateLimiter: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      },
      rtdb: {
        getRtdbPath: async () => {
          rtdbReads++;
          return null;
        },
      },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(rtdbReads).toBe(0);
    expect(keys).toEqual(["historical-match-fallback:unknown"]);
  });

  it("shares the fallback limit across invite IDs for one caller", async () => {
    let fallbackCalls = 0;
    let rtdbReads = 0;
    const rateLimiter = {
      limit: async () => {
        fallbackCalls++;
        return { success: fallbackCalls <= 1 };
      },
    };
    const read = (inviteId: string) =>
      handleHistoricalMatchRoute(
        new Request(
          `https://api.mons.link/matches/history?inviteId=${inviteId}&matchId=${inviteId}`,
          { headers: { "CF-Connecting-IP": "192.0.2.1" } },
        ),
        env,
        {
          fallbackEnabled: true,
          rateLimiter,
          rtdb: {
            getRtdbPath: async () => {
              rtdbReads++;
              return null;
            },
          },
        },
      );
    expect((await read("invite-1")).status).toBe(200);
    expect((await read("invite-2")).status).toBe(429);
    expect(rtdbReads).toBe(1);
  });

  it("validates historical status before read-through archival", async () => {
    const values = new Map<string, unknown>([
      [
        "invites/invite-1",
        {
          hostId: "host",
          guestId: "guest",
          hostRematches: "1",
          guestRematches: "1",
        },
      ],
      ["players/host/matches/invite-1", match("white")],
      ["players/guest/matches/invite-1", match("black")],
    ]);
    const response = await handleHistoricalMatchRoute(request(), env, {
      fallbackEnabled: true,
      now: () => 2_000,
      rtdb: { getRtdbPath: async (path) => values.get(path) ?? null },
    });
    expect(await response.json()).toEqual({ ok: true, pair: pair() });
    const stored = await env.PROFILE_GAMES_DB.prepare(
      "SELECT source_kind FROM historical_match_pairs",
    ).first<{ source_kind: string }>();
    expect(stored?.source_kind).toBe("backfill");

    const active = await handleHistoricalMatchRoute(
      request("inviteId=invite-1&matchId=invite-11"),
      env,
      {
        fallbackEnabled: true,
        rtdb: { getRtdbPath: async (path) => values.get(path) ?? null },
      },
    );
    expect(await active.json()).toEqual({ ok: true, pair: null });
  });

  it("leaves pending transition snapshots to the Queue", async () => {
    const values = new Map<string, unknown>([
      [
        "invites/invite-1",
        {
          hostId: "host",
          guestId: "guest",
          hostRematches: "1",
          guestRematches: "1",
        },
      ],
      ["players/host/matches/invite-1", match("white")],
      ["players/guest/matches/invite-1", match("black")],
      [
        "profileGameProjectionOutbox/automatch/invite-1",
        {
          schemaVersion: 1,
          status: "pending",
          requestId: "request-1",
          reason: "manual-hostRematches-updated",
          sourceUpdatedAtMs: 1_000,
          lastQueuedAtMs: 1_000,
          historicalMatches: {
            "invite-1": {
              finalizedAtMs: 1_000,
              guestPlayerId: "guest",
              hostPlayerId: "host",
              source: "transition",
            },
          },
        },
      ],
    ]);
    const response = await handleHistoricalMatchRoute(request(), env, {
      fallbackEnabled: true,
      now: () => 2_000,
      rtdb: { getRtdbPath: async (path) => values.get(path) ?? null },
    });
    expect(await response.json()).toEqual({ ok: true, pair: null });
    const stored = await env.PROFILE_GAMES_DB.prepare(
      "SELECT COUNT(*) AS count FROM historical_match_pairs",
    ).first<{ count: number }>();
    expect(stored?.count).toBe(0);
  });

  it("rejects malformed requests and unsupported methods", async () => {
    expect(
      (await handleHistoricalMatchRoute(request("inviteId=a&matchId=b"), env))
        .status,
    ).toBe(400);
    expect(
      (await handleHistoricalMatchRoute(request("", "POST"), env)).status,
    ).toBe(405);
  });
});
