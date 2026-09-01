import {
  isReadHistoricalMatchRequest,
  type ReadHistoricalMatchResponse,
} from "@mons/shared/game-sessions";
import {
  buildHistoricalMatchPair,
  isHistoricalMatchId,
} from "./historicalMatches.ts";
import {
  readHistoricalMatchSnapshot,
  writeHistoricalMatchSnapshot,
} from "./historicalMatchesD1.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import {
  getAutomatchProfileGameProjectionOutboxPath,
  salvageHistoricalMatchDescriptors,
} from "./profileGameProjectionOutbox.ts";

export const HISTORICAL_MATCH_PATH = "/matches/history";

type HistoricalMatchRouteDependencies = {
  db?: D1Database;
  fallbackEnabled?: boolean;
  now?: () => number;
  rateLimitKey?: string;
  rateLimiter?: RateLimit;
  rtdb?: Pick<GameplayRepository, "getRtdbPath">;
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

function historicalMatchFallbackEnabled(value: unknown): boolean {
  return value === "true";
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
  if (stored) return { ok: true, pair: stored.pair };
  const fallbackEnabled =
    dependencies.fallbackEnabled ??
    historicalMatchFallbackEnabled(env.HISTORICAL_MATCH_RTDB_FALLBACK_ENABLED);
  if (!fallbackEnabled) {
    return { ok: true, pair: null };
  }
  const rateLimit = await (
    dependencies.rateLimiter || env.HISTORICAL_MATCH_RATE_LIMITER
  ).limit({
    key: `historical-match-fallback:${dependencies.rateLimitKey || "unknown"}`,
  });
  if (!rateLimit.success) {
    throw new HistoricalMatchRateLimit();
  }
  const rtdb = dependencies.rtdb || createGameplayRepository(env);
  const invite = await rtdb.getRtdbPath(`invites/${inviteId}`);
  if (!isHistoricalMatchId(inviteId, matchId, invite)) {
    return { ok: true, pair: null };
  }
  const record =
    invite && typeof invite === "object" && !Array.isArray(invite)
      ? (invite as Record<string, unknown>)
      : null;
  const hostPlayerId = record?.hostId;
  const guestPlayerId = record?.guestId;
  const [hostMatch, guestMatch] = await Promise.all([
    typeof hostPlayerId === "string"
      ? rtdb.getRtdbPath(`players/${hostPlayerId}/matches/${matchId}`)
      : Promise.resolve(null),
    typeof guestPlayerId === "string"
      ? rtdb.getRtdbPath(`players/${guestPlayerId}/matches/${matchId}`)
      : Promise.resolve(null),
  ]);
  const pair = buildHistoricalMatchPair({
    matchId,
    hostPlayerId,
    guestPlayerId,
    hostMatch,
    guestMatch,
  });
  if (!pair) return { ok: true, pair: null };
  const pendingTransition = salvageHistoricalMatchDescriptors(
    await rtdb.getRtdbPath(
      getAutomatchProfileGameProjectionOutboxPath(inviteId),
    ),
  ).some(
    (descriptor) =>
      descriptor.matchId === matchId && descriptor.source === "transition",
  );
  if (pendingTransition) return { ok: true, pair: null };
  const nowMs = (dependencies.now || Date.now)();
  const archived = await writeHistoricalMatchSnapshot(db, {
    archivedAtMs: nowMs,
    finalizedAtMs: nowMs,
    inviteId,
    pair,
    source: "backfill",
  });
  return { ok: true, pair: archived.pair };
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
      await readHistoricalMatch(env, input.inviteId, input.matchId, {
        ...dependencies,
        rateLimitKey:
          dependencies.rateLimitKey ||
          request.headers.get("CF-Connecting-IP")?.trim() ||
          "unknown",
      }),
      200,
    );
  } catch (error) {
    if (error instanceof HistoricalMatchRateLimit) {
      const response = errorResponse(
        429,
        "resource-exhausted",
        "historical-match-rate-limited",
      );
      response.headers.set("Retry-After", "60");
      return response;
    }
    console.error(
      JSON.stringify({
        event: "historical_match_read_failed",
        code: error instanceof Error ? error.message : "unknown",
      }),
    );
    return errorResponse(503, "unavailable", "historical-match-unavailable");
  }
}

class HistoricalMatchRateLimit extends Error {
  constructor() {
    super("historical-match-rate-limited");
  }
}
