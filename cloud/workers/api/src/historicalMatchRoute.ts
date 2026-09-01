import {
  isReadHistoricalMatchRequest,
  type ReadHistoricalMatchResponse,
} from "@mons/shared/game-sessions";
import { readHistoricalMatchSnapshot } from "./historicalMatchesD1.ts";

export const HISTORICAL_MATCH_PATH = "/matches/history";

type HistoricalMatchRouteDependencies = {
  db?: D1Database;
};

function publicHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: publicHeaders(),
  });
}

function errorResponse(
  status: number,
  error: string,
  message: string,
): Response {
  return json({ ok: false, error, message }, status);
}

export async function readHistoricalMatch(
  env: Env,
  inviteId: string,
  matchId: string,
  dependencies: HistoricalMatchRouteDependencies = {},
): Promise<ReadHistoricalMatchResponse> {
  const db = dependencies.db || env.PROFILE_GAMES_DB;
  const stored = await readHistoricalMatchSnapshot(db, inviteId, matchId);
  return { ok: true, pair: stored?.pair ?? null };
}

export async function handleHistoricalMatchRoute(
  request: Request,
  env: Env,
  dependencies: HistoricalMatchRouteDependencies = {},
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: publicHeaders() });
  }
  if (request.method !== "GET") {
    const response = errorResponse(
      405,
      "method-not-allowed",
      "method-not-allowed",
    );
    response.headers.set("Allow", "GET, OPTIONS");
    return response;
  }
  const url = new URL(request.url);
  const input = {
    inviteId: url.searchParams.get("inviteId") || "",
    matchId: url.searchParams.get("matchId") || "",
  };
  if (url.searchParams.size !== 2 || !isReadHistoricalMatchRequest(input)) {
    return errorResponse(400, "invalid-argument", "invalid-request");
  }
  try {
    return json(
      await readHistoricalMatch(
        env,
        input.inviteId,
        input.matchId,
        dependencies,
      ),
      200,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "historical_match_read_failed",
        code: error instanceof Error ? error.message : "unknown",
      }),
    );
    return errorResponse(503, "unavailable", "historical-match-unavailable");
  }
}
