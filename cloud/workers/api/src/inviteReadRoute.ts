import {
  INVITE_METADATA_SOCKET_PROTOCOL,
  type InviteMetadataSnapshot,
  type ReadInviteMetadataResponse,
} from "@mons/shared/invite-metadata";
import {
  INVITE_WAGERS_SOCKET_PROTOCOL,
  type ReadInviteWagersResponse,
} from "@mons/shared/invite-wagers";
import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
  isAllowedAuthOrigin,
} from "./authHttp.ts";
import { cancelResponseBody } from "./boundedStreams.ts";
import { resolveInviteRoleFromSnapshot } from "./gameSessionMutations.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import type { InviteReactions } from "./inviteReactions.ts";
import { readInviteSocketToken } from "./inviteSocketAuth.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import {
  verifySessionRequest,
  type SessionIdentity,
  type WorkerExecutionContext,
} from "./sessionAuth.ts";
import { socketSessionHeaders } from "./socketSession.ts";

type InviteReadChannel = "metadata" | "wagers";

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
};

export type InviteReadRouteDependencies = {
  repository?: GameplayRepository;
  verifyIdentity?: (
    request: Request,
    env: Env,
    ctx: WorkerExecutionContext,
  ) => Promise<SessionIdentity>;
  logFailure?: () => void;
};

type InviteReadAccess = {
  inviteId: string;
  identity: SessionIdentity | null;
  repository: GameplayRepository;
};

type InviteReadRole = {
  role: "host" | "guest" | "watch";
  actorUid: string | null;
};

type PreparedInviteRead = {
  body: ReadInviteMetadataResponse | ReadInviteWagersResponse;
  revision: number;
  passwordProtected: boolean;
  role: InviteReadRole;
};

type InviteReadRouteOptions<Room extends Pick<InviteReactions, "fetch">> = {
  channel: InviteReadChannel;
  dependencies: InviteReadRouteDependencies;
  getRoom: (inviteId: string) => Room;
  prepare: (
    room: Room,
    access: InviteReadAccess,
  ) => Promise<PreparedInviteRead>;
};

export function isInviteReadPath(
  pathname: string,
  channel: InviteReadChannel,
): boolean {
  return channels[channel].pattern.test(pathname);
}

function readRoute(request: Request, channel: InviteReadChannel) {
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
  { inviteId, identity, repository }: InviteReadAccess,
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
  Room extends Pick<InviteReactions, "fetch">,
>(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  { channel, dependencies, getRoom, prepare }: InviteReadRouteOptions<Room>,
): Promise<Response> {
  const { protocol, headerPrefix } = channels[channel];
  const unavailable = `invite-${channel}-unavailable`;
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = {
      ...getAuthCorsHeaders(request),
      "Access-Control-Expose-Headers": "Retry-After",
    };
    const { inviteId, socket } = readRoute(request, channel);
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
        `invalid-${channel}-auth`,
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
      key: `${channel}:${socket ? "connect" : "read"}:${identity ? `identity:${identity.uid}` : `spectator:${ip}`}`,
    });
    if (!limited.success) {
      return authJsonResponse(
        { ok: false, error: "resource-exhausted", message: "rate-limited" },
        429,
        { ...corsHeaders, "Retry-After": "60" },
      );
    }
    const repository = dependencies.repository || createGameplayRepository(env);
    const invite = await repository.readInviteMetadata(inviteId);
    if (invite === null || invite === undefined) {
      throw new AuthApiFailure(404, "not-found", "invite-not-found");
    }
    const room = getRoom(inviteId);
    for (let attempt = 0; attempt < 2; attempt++) {
      const prepared = await prepare(room, { inviteId, identity, repository });
      if (!socket) return authJsonResponse(prepared.body, 200, corsHeaders);
      const { role, actorUid } = prepared.role;
      const response = await room.fetch(
        new Request(`https://reactions.internal/${channel}/socket`, {
          headers: {
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
      (() => console.error({ event: `invite_${channel}_failure` }))
    )();
    return authErrorResponse(
      new AuthApiFailure(503, "unavailable", unavailable),
      corsHeaders,
    );
  }
}
