import type {
  ApiJsonBody,
  ApiJsonStatus,
  ApiQuery,
  ApiResponse,
} from "@mons/shared/api-contracts";
import {
  isReadMatchSnapshotRequest,
  normalizeMatchSnapshot,
} from "@mons/shared/game-sessions";
import { readMatchStateRecord } from "./matchStateRouting.ts";
type ReadMatchSnapshotRequest = ApiQuery<"GET /matches/snapshot">;
type ReadMatchSnapshotResponse = ApiResponse<"GET /matches/snapshot">;

type MatchSnapshotRouteDependencies = {
  readMatch?: (
    env: Env,
    request: ReadMatchSnapshotRequest,
    options: { signal: AbortSignal },
  ) => Promise<unknown>;
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

function json<Status extends ApiJsonStatus<"GET /matches/snapshot">>(
  body: ApiJsonBody<"GET /matches/snapshot", NoInfer<Status>>,
  status: Status,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: publicHeaders(),
  });
}

function errorResponse(
  status: Exclude<ApiJsonStatus<"GET /matches/snapshot">, 200>,
  error: string,
  message: string,
): Response {
  return json({ ok: false, error, message }, status);
}

export async function handleMatchSnapshotRoute(
  request: Request,
  env: Env,
  dependencies: MatchSnapshotRouteDependencies = {},
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
    playerId: url.searchParams.get("playerId") || "",
    matchId: url.searchParams.get("matchId") || "",
  };
  if (url.searchParams.size !== 2 || !isReadMatchSnapshotRequest(input)) {
    return errorResponse(400, "invalid-argument", "invalid-request");
  }
  try {
    const raw = await (dependencies.readMatch || readMatchStateRecord)(
      env,
      input,
      { signal: request.signal },
    );
    const match = raw === null ? null : normalizeMatchSnapshot(raw);
    if (raw !== null && match === null) {
      throw new Error("invalid-match-snapshot");
    }
    const response: ReadMatchSnapshotResponse = { ok: true, ...input, match };
    return json(response, 200);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "match_snapshot_read_failed",
        code: error instanceof Error ? error.message : "unknown",
      }),
    );
    return errorResponse(503, "unavailable", "match-snapshot-unavailable");
  }
}
