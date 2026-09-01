import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("serves D1 without authentication", async () => {
    await writeHistoricalMatchSnapshot(env.PROFILE_GAMES_DB, {
      archivedAtMs: 1_000,
      finalizedAtMs: 1_000,
      inviteId: "invite-1",
      pair: pair(),
      source: "rating",
    });
    const response = await handleHistoricalMatchRoute(request(), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.json()).toEqual({ ok: true, pair: pair() });
  });

  it("returns null on a D1 miss", async () => {
    const response = await handleHistoricalMatchRoute(request(), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, pair: null });
  });

  it("returns 503 when D1 is unavailable", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handleHistoricalMatchRoute(request(), env, {
        db: {
          prepare() {
            throw new Error("d1-unavailable");
          },
        } as unknown as D1Database,
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        ok: false,
        error: "unavailable",
        message: "historical-match-unavailable",
      });
      expect(errorLog).toHaveBeenCalledWith(
        JSON.stringify({
          event: "historical_match_read_failed",
          code: "d1-unavailable",
        }),
      );
    } finally {
      errorLog.mockRestore();
    }
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
