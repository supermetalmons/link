import {
  MATCH_SYNC_MAX_MESSAGE_BYTES,
  MATCH_SYNC_SOCKET_PROTOCOL,
  isReadMatchSyncResponse,
  type ReadMatchSyncResponse,
} from "@mons/shared/match-sync";
import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
  isAllowedAuthOrigin,
} from "./authHttp.ts";
import { cancelResponseBody } from "./boundedStreams.ts";
import {
  verifySessionRequest,
  type SessionIdentity,
  type WorkerExecutionContext,
} from "./sessionAuth.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import { resolveInviteRoleFromSnapshot } from "./gameSessionMutations.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import { normalizeInviteMetadata } from "./inviteMetadata.ts";
import { readInviteSocketToken } from "./inviteSocketAuth.ts";
import { socketSessionHeaders } from "./socketSession.ts";
import {
  isRegisteredSyncMatch,
  type MatchSyncReadResult,
} from "./matchSync.ts";

const MATCH_SYNC_ROUTE_PATTERN =
  /^\/invites\/([^/]+)\/matches\/([^/]+)\/(snapshot|socket)$/;

export type MatchSyncRouteDependencies = {
  repository?: GameplayRepository;
  room?: {
    readMatches(
      inviteId: string,
      matchId: string,
    ): Promise<MatchSyncReadResult>;
    fetch(request: Request): Promise<Response>;
  };
  verifyIdentity?: (
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext,
  ) => Promise<SessionIdentity>;
  logFailure?: () => void;
};

export function isMatchSyncPath(pathname: string): boolean {
  return MATCH_SYNC_ROUTE_PATTERN.test(pathname);
}

function readRoute(request: Request) {
  const url = new URL(request.url);
  const match = MATCH_SYNC_ROUTE_PATTERN.exec(url.pathname);
  let inviteId = "";
  let matchId = "";
  try {
    inviteId = match ? decodeURIComponent(match[1]) : "";
    matchId = match ? decodeURIComponent(match[2]) : "";
  } catch {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-match-id");
  }
  if (
    !isSafeRecordKey(inviteId) ||
    !isSafeRecordKey(matchId) ||
    inviteId !== inviteId.trim() ||
    matchId !== matchId.trim() ||
    url.search
  ) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-match-id");
  }
  return { inviteId, matchId, socket: match?.[3] === "socket" };
}

export async function handleMatchSyncRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: MatchSyncRouteDependencies = {},
): Promise<Response> {
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = {
      ...getAuthCorsHeaders(request),
      "Access-Control-Expose-Headers": "Retry-After",
    };
    const { inviteId, matchId, socket } = readRoute(request);
    if (request.method === "OPTIONS") return authPreflightResponse(corsHeaders);
    if (request.method !== "GET") {
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    }
    let identityRequest: Request | null = request.headers.has("Authorization")
      ? request
      : null;
    if (socket) {
      if (!isAllowedAuthOrigin(request.headers.get("Origin") || "")) {
        throw new AuthApiFailure(
          403,
          "permission-denied",
          "origin-not-allowed",
        );
      }
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return authJsonResponse(
          { ok: false, error: "websocket-upgrade-required" },
          426,
          corsHeaders,
        );
      }
      const token = readInviteSocketToken(
        request,
        MATCH_SYNC_SOCKET_PROTOCOL,
        "invalid-match-auth",
      );
      identityRequest = token
        ? new Request(request.url, {
            headers: { Authorization: `Bearer ${token}` },
          })
        : null;
    }
    const identity = identityRequest
      ? await (dependencies.verifyIdentity || verifySessionRequest)(
          identityRequest,
          env,
          ctx,
        )
      : null;
    const ip = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
    const limiter = socket
      ? env.REACTION_RATE_LIMITER
      : env.MATCH_SYNC_RATE_LIMITER;
    const limited = await limiter.limit({
      key: `match-${socket ? "connect" : "read"}:${identity ? `identity:${identity.uid}` : `spectator:${ip}`}`,
    });
    if (!limited.success) {
      return authJsonResponse(
        { ok: false, error: "resource-exhausted", message: "rate-limited" },
        429,
        { ...corsHeaders, "Retry-After": "60" },
      );
    }
    const repository = dependencies.repository || createGameplayRepository(env);
    const existence = normalizeInviteMetadata(
      inviteId,
      await repository.readInviteMetadata(inviteId),
    );
    if (existence.status === "missing") {
      throw new AuthApiFailure(404, "not-found", "invite-not-found");
    }
    if (existence.status !== "ok") {
      throw new AuthApiFailure(409, "failed-precondition", "invite-invalid");
    }
    if (!isRegisteredSyncMatch(existence, matchId)) {
      throw new AuthApiFailure(404, "not-found", "match-not-found");
    }
    const room = dependencies.room || env.INVITE_REACTIONS.getByName(inviteId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = await room.readMatches(inviteId, matchId);
      if (read.status === "missing") {
        throw new AuthApiFailure(404, "not-found", "match-not-found");
      }
      if (read.status !== "ok") {
        throw new AuthApiFailure(409, "failed-precondition", "match-invalid");
      }
      const metadata = read.metadata;
      if (!identity && !metadata.snapshot.guestId) {
        throw new AuthApiFailure(403, "permission-denied", "permission-denied");
      }
      const role = identity
        ? await resolveInviteRoleFromSnapshot(
            identity,
            { inviteId },
            {
              ...metadata.snapshot,
              ...(metadata.passwordProtected ? { password: true } : {}),
            },
            repository,
          )
        : { role: "watch" as const, actorUid: null };
      const body: ReadMatchSyncResponse = { ok: true, snapshot: read.snapshot };
      if (
        !isReadMatchSyncResponse(body) ||
        body.snapshot.inviteId !== inviteId ||
        body.snapshot.matchId !== matchId ||
        body.snapshot.hostPlayerId !== metadata.snapshot.hostId ||
        body.snapshot.guestPlayerId !== metadata.snapshot.guestId ||
        new TextEncoder().encode(JSON.stringify(body)).byteLength >
          MATCH_SYNC_MAX_MESSAGE_BYTES
      ) {
        throw new AuthApiFailure(503, "unavailable", "match-sync-unavailable");
      }
      if (!socket) return authJsonResponse(body, 200, corsHeaders);
      const response = await room.fetch(
        new Request("https://reactions.internal/matches/socket", {
          headers: {
            Upgrade: "websocket",
            "Sec-WebSocket-Protocol": MATCH_SYNC_SOCKET_PROTOCOL,
            "X-Mons-Match-Invite": encodeURIComponent(inviteId),
            "X-Mons-Match-Match": encodeURIComponent(matchId),
            "X-Mons-Match-Role":
              role.role === "watch" ? "spectator" : role.role,
            "X-Mons-Match-IP": ip,
            "X-Mons-Match-Revision": String(read.snapshot.revision),
            "X-Mons-Match-Protected": metadata.passwordProtected ? "1" : "0",
            "X-Mons-Match-Authenticated": identity ? "1" : "0",
            ...socketSessionHeaders(identity),
            ...(role.actorUid
              ? { "X-Mons-Match-Actor": encodeURIComponent(role.actorUid) }
              : {}),
          },
        }),
      );
      if (response.status !== 409) return response;
      await cancelResponseBody(response);
    }
    throw new AuthApiFailure(503, "unavailable", "match-sync-unavailable");
  } catch (error) {
    if (error instanceof AuthApiFailure)
      return authErrorResponse(error, corsHeaders);
    (
      dependencies.logFailure ||
      (() => console.error({ event: "match_sync_failure" }))
    )();
    return authErrorResponse(
      new AuthApiFailure(503, "unavailable", "match-sync-unavailable"),
      corsHeaders,
    );
  }
}
