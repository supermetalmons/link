import type { ApiParameters, ApiResponse } from "@mons/shared/api-contracts";
import type { InviteDocument } from "@mons/shared/invite-records";
import {
  INVITE_METADATA_SOCKET_PROTOCOL,
  type InviteMetadataSnapshot,
} from "@mons/shared/invite-metadata";
import { INVITE_WAGERS_SOCKET_PROTOCOL } from "@mons/shared/invite-wagers";
import { MATCH_SYNC_SOCKET_PROTOCOL } from "@mons/shared/match-sync";
import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
  isAllowedAuthOrigin,
} from "./authHttp.ts";
import { cancelResponseBody } from "./boundedStreams.ts";
import { summarizeError } from "./errorSummary.ts";
import { resolveInviteRoleFromSnapshot } from "./inviteAccess.ts";
import { createInviteReadRepository } from "./inviteReadRepository.ts";
import type { InviteAccessRepository } from "./gameplayContracts.ts";
import type { ProfileOwnershipReader } from "./profileOwnership.ts";
import type { InviteReactions } from "./inviteReactions.ts";
import { readInviteSocketToken } from "./inviteSocketAuth.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import {
  verifySessionRequest,
  type SessionIdentity,
  type WorkerExecutionContext,
} from "./sessionAuth.ts";
import { socketSessionHeaders } from "./socketSession.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
type InviteReadChannel = "metadata" | "wagers" | "matches";
type InviteReadEndpoint<Channel extends InviteReadChannel> = {
  metadata: "GET /invites/:inviteId/metadata";
  wagers: "GET /invites/:inviteId/wagers";
  matches: "GET /invites/:inviteId/matches/:matchId/snapshot";
}[Channel];
type InviteReadTarget = { inviteId: string; socket: boolean };

const channels = {
  metadata: {
    pattern: /^\/invites\/([^/]+)\/metadata(\/socket)?$/,
    protocol: INVITE_METADATA_SOCKET_PROTOCOL,
    headerPrefix: "X-Mons-Metadata",
  },
  wagers: {
    pattern: /^\/invites\/([^/]+)\/wagers(\/socket)?$/,
    protocol: INVITE_WAGERS_SOCKET_PROTOCOL,
    headerPrefix: "X-Mons-Wagers",
  },
  matches: {
    protocol: MATCH_SYNC_SOCKET_PROTOCOL,
    headerPrefix: "X-Mons-Match",
  },
};

export type InviteReadRouteDependencies = {
  repository?: InviteAccessRepository;
  verifyIdentity?: (
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext,
  ) => Promise<SessionIdentity>;
  logFailure?: () => void;
};

type InviteReadAccess = {
  inviteId: string;
  identity: RequestIdentity | null;
  repository: InviteAccessRepository;
};

type InviteRoleAccess = Omit<InviteReadAccess, "repository"> & {
  repository: ProfileOwnershipReader;
};

type InviteReadRole = {
  role: "host" | "guest" | "watch";
  actorUid: string | null;
};

type PreparedInviteRead<Channel extends InviteReadChannel> = {
  body: ApiResponse<InviteReadEndpoint<Channel>>;
  revision: number;
  passwordProtected: boolean;
  role: InviteReadRole;
  socketHeaders?: Record<string, string>;
};

type InviteReadRouteOptions<
  Channel extends InviteReadChannel,
  Room extends Pick<InviteReactions, "fetch">,
  Target extends InviteReadTarget,
> = {
  channel: Channel;
  dependencies: InviteReadRouteDependencies;
  readRoute: (request: Request) => Target;
  validateInvite?: (invite: InviteDocument, target: Target) => void;
  getRoom: (inviteId: string) => Room;
  prepare: (
    room: Room,
    access: InviteReadAccess & Target,
  ) => Promise<PreparedInviteRead<NoInfer<Channel>>>;
};

export function isInviteReadPath(
  pathname: string,
  channel: Exclude<InviteReadChannel, "matches">,
): boolean {
  return channels[channel].pattern.test(pathname);
}

export function readInviteRoute(
  request: Request,
  channel: Exclude<InviteReadChannel, "matches">,
): ApiParameters<InviteReadEndpoint<"metadata" | "wagers">> & {
  socket: boolean;
} {
  const url = new URL(request.url);
  const match = channels[channel].pattern.exec(url.pathname);
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

export async function resolveInviteReadRole(
  { inviteId, identity, repository }: InviteRoleAccess,
  snapshot: InviteMetadataSnapshot,
  passwordProtected: boolean,
): Promise<InviteReadRole> {
  if (!identity && !snapshot.guestId) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  return identity
    ? resolveInviteRoleFromSnapshot(
        identity,
        { inviteId },
        { ...snapshot, ...(passwordProtected ? { password: true } : {}) },
        repository,
      )
    : { role: "watch", actorUid: null };
}

export async function handleInviteReadRoute<
  const Channel extends InviteReadChannel,
  Room extends Pick<InviteReactions, "fetch">,
  Target extends InviteReadTarget,
>(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  {
    channel,
    dependencies,
    readRoute,
    validateInvite,
    getRoom,
    prepare,
  }: InviteReadRouteOptions<Channel, Room, Target>,
): Promise<Response> {
  const { protocol, headerPrefix } = channels[channel];
  const unavailable =
    channel === "matches"
      ? "match-sync-unavailable"
      : `invite-${channel}-unavailable`;
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = {
      ...getAuthCorsHeaders(request),
      "Access-Control-Expose-Headers": "Retry-After",
    };
    const target = readRoute(request);
    const { inviteId, socket } = target;
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
        protocol,
        `invalid-${channel === "matches" ? "match" : channel}-auth`,
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
    const limiter =
      channel === "matches" && !socket
        ? env.MATCH_SYNC_RATE_LIMITER
        : env.REACTION_RATE_LIMITER;
    const rateLimitPrefix = channel === "matches" ? "match-" : `${channel}:`;
    const limited = await limiter.limit({
      key: `${rateLimitPrefix}${socket ? "connect" : "read"}:${identity ? `identity:${identity.uid}` : `spectator:${ip}`}`,
    });
    if (!limited.success) {
      return authJsonResponse(
        { ok: false, error: "resource-exhausted", message: "rate-limited" },
        429,
        { ...corsHeaders, "Retry-After": "60" },
      );
    }
    const repository =
      dependencies.repository || createInviteReadRepository(env);
    const invite = await repository.readInviteMetadata(inviteId);
    if (invite === null || invite === undefined) {
      throw new AuthApiFailure(404, "not-found", "invite-not-found");
    }
    validateInvite?.(invite, target);
    const room = getRoom(inviteId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const prepared = await prepare(room, { ...target, identity, repository });
      if (!socket)
        return authJsonResponse<InviteReadEndpoint<InviteReadChannel>, 200>(
          prepared.body,
          200,
          corsHeaders,
        );
      const { role, actorUid } = prepared.role;
      const response = await room.fetch(
        new Request(`https://reactions.internal/${channel}/socket`, {
          headers: {
            ...prepared.socketHeaders,
            Upgrade: "websocket",
            "Sec-WebSocket-Protocol": protocol,
            [`${headerPrefix}-Invite`]: encodeURIComponent(inviteId),
            [`${headerPrefix}-Role`]: role === "watch" ? "spectator" : role,
            [`${headerPrefix}-IP`]: ip,
            [`${headerPrefix}-Revision`]: String(prepared.revision),
            [`${headerPrefix}-Protected`]: prepared.passwordProtected
              ? "1"
              : "0",
            [`${headerPrefix}-Authenticated`]: identity ? "1" : "0",
            ...socketSessionHeaders(identity),
            ...(actorUid
              ? { [`${headerPrefix}-Actor`]: encodeURIComponent(actorUid) }
              : {}),
          },
        }),
      );
      if (response.status !== 409) return response;
      await cancelResponseBody(response);
    }
    throw new AuthApiFailure(503, "unavailable", unavailable);
  } catch (error) {
    if (error instanceof AuthApiFailure)
      return authErrorResponse(error, corsHeaders);
    (
      dependencies.logFailure ||
      (() =>
        console.error({
          event:
            channel === "matches"
              ? "match_sync_failure"
              : `invite_${channel}_failure`,
          error: summarizeError(error),
        }))
    )();
    return authErrorResponse(
      new AuthApiFailure(503, "unavailable", unavailable),
      corsHeaders,
    );
  }
}
