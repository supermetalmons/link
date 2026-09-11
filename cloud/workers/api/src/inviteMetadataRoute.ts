import {
  INVITE_METADATA_MAX_MESSAGE_BYTES,
  INVITE_METADATA_SOCKET_PROTOCOL,
  isReadInviteMetadataResponse,
  type ReadInviteMetadataResponse,
} from "@mons/shared/invite-metadata";
import { GAME_SESSION_OPERATION_ID_PATTERN } from "@mons/shared/game-sessions";
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
import type { InviteReactions } from "./inviteReactions.ts";
import { socketSessionHeaders } from "./socketSession.ts";
import { readInviteSocketToken } from "./inviteSocketAuth.ts";

const METADATA_ROUTE_PATTERN = /^\/invites\/([^/]+)\/metadata(\/socket)?$/;

export type InviteMetadataRouteDependencies = {
  repository?: GameplayRepository;
  room?: Pick<InviteReactions, "readMetadata" | "fetch">;
  verifyIdentity?: (
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext,
  ) => Promise<SessionIdentity>;
  logFailure?: () => void;
};

export function isInviteMetadataPath(pathname: string): boolean {
  return METADATA_ROUTE_PATTERN.test(pathname);
}

function readRoute(request: Request): { inviteId: string; socket: boolean } {
  const url = new URL(request.url);
  const match = METADATA_ROUTE_PATTERN.exec(url.pathname);
  let inviteId = "";
  try {
    inviteId = match ? decodeURIComponent(match[1]) : "";
  } catch {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-invite-id");
  }
  if (
    !isSafeRecordKey(inviteId) ||
    inviteId.trim() !== inviteId ||
    url.search
  ) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-invite-id");
  }
  return { inviteId, socket: Boolean(match?.[2]) };
}

export async function handleInviteMetadataRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: InviteMetadataRouteDependencies = {},
): Promise<Response> {
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = {
      ...getAuthCorsHeaders(request),
      "Access-Control-Expose-Headers": "Retry-After",
    };
    const { inviteId, socket } = readRoute(request);
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
        INVITE_METADATA_SOCKET_PROTOCOL,
        "invalid-metadata-auth",
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
    const limited = await env.REACTION_RATE_LIMITER.limit({
      key: `metadata:${socket ? "connect" : "read"}:${identity ? `identity:${identity.uid}` : `spectator:${ip}`}`,
    });
    if (!limited.success) {
      return authJsonResponse(
        { ok: false, error: "resource-exhausted", message: "rate-limited" },
        429,
        { ...corsHeaders, "Retry-After": "60" },
      );
    }
    const repository = dependencies.repository || createGameplayRepository(env);
    const invite = await repository.getStatePath(`invites/${inviteId}`, {
      shallow: true,
    });
    if (invite === null || invite === undefined) {
      throw new AuthApiFailure(404, "not-found", "invite-not-found");
    }
    const room = dependencies.room || env.INVITE_REACTIONS.getByName(inviteId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = await room.readMetadata(inviteId);
      if (read.status === "missing") {
        throw new AuthApiFailure(404, "not-found", "invite-not-found");
      }
      if (read.status !== "ok") {
        throw new AuthApiFailure(409, "failed-precondition", "invite-invalid");
      }
      const source = {
        ...read.snapshot,
        ...(read.passwordProtected ? { password: true } : {}),
      };
      if (!identity && !read.snapshot.guestId) {
        throw new AuthApiFailure(403, "permission-denied", "permission-denied");
      }
      const role = identity
        ? await resolveInviteRoleFromSnapshot(
            identity,
            { inviteId },
            source,
            repository,
          )
        : { role: "watch" as const, actorUid: null };
      const operationId = identity
        ? read.automatchOperationIds[identity.uid]
        : null;
      const body: ReadInviteMetadataResponse = {
        ok: true,
        snapshot: read.snapshot,
        viewer: {
          role: role.role,
          actorUid: role.actorUid,
          automatchOperationId:
            typeof operationId === "string" &&
            GAME_SESSION_OPERATION_ID_PATTERN.test(operationId)
              ? operationId
              : null,
        },
      };
      if (
        !isReadInviteMetadataResponse(body) ||
        new TextEncoder().encode(JSON.stringify(body)).byteLength >
          INVITE_METADATA_MAX_MESSAGE_BYTES
      ) {
        throw new AuthApiFailure(
          503,
          "unavailable",
          "invite-metadata-unavailable",
        );
      }
      if (!socket) return authJsonResponse(body, 200, corsHeaders);
      const response = await room.fetch(
        new Request("https://reactions.internal/metadata/socket", {
          headers: {
            Upgrade: "websocket",
            "Sec-WebSocket-Protocol": INVITE_METADATA_SOCKET_PROTOCOL,
            "X-Mons-Metadata-Invite": encodeURIComponent(inviteId),
            "X-Mons-Metadata-Role":
              role.role === "watch" ? "spectator" : role.role,
            "X-Mons-Metadata-IP": ip,
            "X-Mons-Metadata-Revision": String(read.snapshot.revision),
            "X-Mons-Metadata-Protected": read.passwordProtected ? "1" : "0",
            "X-Mons-Metadata-Authenticated": identity ? "1" : "0",
            ...socketSessionHeaders(identity),
            ...(role.actorUid
              ? { "X-Mons-Metadata-Actor": encodeURIComponent(role.actorUid) }
              : {}),
          },
        }),
      );
      if (response.status !== 409) return response;
      await cancelResponseBody(response);
    }
    throw new AuthApiFailure(503, "unavailable", "invite-metadata-unavailable");
  } catch (error) {
    if (error instanceof AuthApiFailure)
      return authErrorResponse(error, corsHeaders);
    (
      dependencies.logFailure ||
      (() => console.error({ event: "invite_metadata_failure" }))
    )();
    return authErrorResponse(
      new AuthApiFailure(503, "unavailable", "invite-metadata-unavailable"),
      corsHeaders,
    );
  }
}
