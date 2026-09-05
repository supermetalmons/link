import {
  REACTION_MAX_MESSAGE_BYTES,
  REACTION_AUTH_PROTOCOL_PREFIX,
  REACTION_SOCKET_PROTOCOL,
  isInviteReactionForInvite,
  isReactionSocketToken,
} from "@mons/shared/reactions";
import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
  isAllowedAuthOrigin,
} from "./authHttp.ts";
import {
  verifyFirebaseRequest,
  type WorkerExecutionContext,
} from "./firebaseAuth.ts";
import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import { resolveInviteRole } from "./gameSessionMutations.ts";
import { readBoundedJson } from "./http.ts";
import type { InviteReactions } from "./inviteReactions.ts";
import type { RequestIdentity } from "./requestIdentity.ts";

const REACTION_ROUTE_PATTERN = /^\/invites\/([^/]+)\/reactions(\/socket)?$/;

function readSocketCredentials(request: Request): {
  token: string | null;
  subprotocol: boolean;
} {
  const protocolHeader = request.headers.get("Sec-WebSocket-Protocol");
  const authorization = request.headers.get("Authorization");
  const invalid = () =>
    new AuthApiFailure(400, "invalid-argument", "invalid-reaction-auth");
  let protocolToken: string | null = null;
  if (protocolHeader !== null) {
    if (
      protocolHeader.length >
      REACTION_MAX_MESSAGE_BYTES +
        REACTION_AUTH_PROTOCOL_PREFIX.length +
        REACTION_SOCKET_PROTOCOL.length +
        4
    )
      throw invalid();
    const protocols = protocolHeader
      .split(",")
      .map((protocol) => protocol.trim());
    const bearer = protocols.find((protocol) =>
      protocol.startsWith(REACTION_AUTH_PROTOCOL_PREFIX),
    );
    if (
      protocols.length !== 2 ||
      !protocols.includes(REACTION_SOCKET_PROTOCOL) ||
      !bearer
    )
      throw invalid();
    protocolToken = bearer.slice(REACTION_AUTH_PROTOCOL_PREFIX.length);
    if (!isReactionSocketToken(protocolToken)) throw invalid();
  }
  let headerToken: string | null = null;
  if (authorization !== null) {
    if (authorization.length > REACTION_MAX_MESSAGE_BYTES + 7) throw invalid();
    headerToken = authorization.match(/^Bearer (\S+)$/)?.[1] || null;
    if (!isReactionSocketToken(headerToken)) throw invalid();
  }
  if (protocolToken && headerToken && protocolToken !== headerToken)
    throw invalid();
  return {
    token: protocolToken || headerToken,
    subprotocol: protocolHeader !== null,
  };
}

async function reactionRateLimit(
  env: Env,
  key: string,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const outcome = await env.REACTION_RATE_LIMITER.limit({ key });
  return outcome.success
    ? null
    : authJsonResponse(
        { ok: false, error: "resource-exhausted", message: "rate-limited" },
        429,
        { ...corsHeaders, "Retry-After": "60" },
      );
}

export type InviteReactionRouteDependencies = {
  repository?: GameplayRepository;
  room?: Pick<InviteReactions, "fetch" | "publish">;
  verifyIdentity?: (
    request: Request,
    ctx: WorkerExecutionContext,
  ) => Promise<RequestIdentity>;
  logFailure?: () => void;
};

export function isInviteReactionPath(pathname: string): boolean {
  return REACTION_ROUTE_PATTERN.test(pathname);
}

function readRoute(request: Request): { inviteId: string; socket: boolean } {
  const url = new URL(request.url);
  const match = url.pathname.match(REACTION_ROUTE_PATTERN);
  let inviteId = "";
  try {
    inviteId = match ? decodeURIComponent(match[1]) : "";
  } catch {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-invite-id");
  }
  if (
    !isSafeFirebaseKey(inviteId) ||
    inviteId.trim() !== inviteId ||
    url.search
  ) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-invite-id");
  }
  return { inviteId, socket: Boolean(match?.[2]) };
}

async function requirePairedInvite(
  repository: GameplayRepository,
  inviteId: string,
): Promise<void> {
  const value = await repository.getRtdbPath(`invites/${inviteId}`);
  if (value === null || value === undefined) {
    throw new AuthApiFailure(404, "not-found", "invite-not-found");
  }
  const invite =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (
    !invite ||
    !isCanonicalFirebaseUid(invite.hostId) ||
    !isCanonicalFirebaseUid(invite.guestId) ||
    invite.hostId === invite.guestId
  ) {
    throw new AuthApiFailure(409, "failed-precondition", "invite-not-paired");
  }
}

export async function handleInviteReactionRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: InviteReactionRouteDependencies = {},
): Promise<Response> {
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = getAuthCorsHeaders(request);
    const route = readRoute(request);
    if (request.method === "OPTIONS") {
      return authPreflightResponse(corsHeaders);
    }
    if (request.method !== (route.socket ? "GET" : "POST")) {
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    }
    if (route.socket) {
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
    }
    const ip = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
    const repository = dependencies.repository || createGameplayRepository(env);
    if (route.socket) {
      const credentials = readSocketCredentials(request);
      let role: "host" | "guest" | "spectator" = "spectator";
      let rateKey = `reactions:connect:spectator:${ip}`;
      if (credentials.token) {
        const identity = await (
          dependencies.verifyIdentity || verifyFirebaseRequest
        )(
          new Request(request.url, {
            headers: { Authorization: `Bearer ${credentials.token}` },
          }),
          ctx,
        );
        const attemptsLimited = await reactionRateLimit(
          env,
          `reactions:connect:identity:${identity.uid}`,
          corsHeaders,
        );
        if (attemptsLimited) return attemptsLimited;
        const resolution = await resolveInviteRole(
          identity,
          { inviteId: route.inviteId },
          repository,
        );
        if (
          !resolution.guestId ||
          resolution.role === "watch" ||
          !resolution.actorUid
        ) {
          throw new AuthApiFailure(
            403,
            "permission-denied",
            "permission-denied",
          );
        }
        role = resolution.role;
        rateKey = `reactions:connect:participant:${resolution.actorUid}`;
      }
      const limited = await reactionRateLimit(env, rateKey, corsHeaders);
      if (limited) return limited;
      if (!credentials.token)
        await requirePairedInvite(repository, route.inviteId);
      const room =
        dependencies.room || env.INVITE_REACTIONS.getByName(route.inviteId);
      return await room.fetch(
        new Request("https://reactions.internal/socket", {
          headers: {
            Upgrade: "websocket",
            "X-Mons-Reaction-Role": role,
            "X-Mons-Reaction-IP": ip,
            ...(credentials.subprotocol
              ? { "Sec-WebSocket-Protocol": REACTION_SOCKET_PROTOCOL }
              : {}),
          },
        }),
      );
    }
    const limited = await reactionRateLimit(
      env,
      `reactions:publish:${ip}`,
      corsHeaders,
    );
    if (limited) return limited;
    const identity = await (
      dependencies.verifyIdentity || verifyFirebaseRequest
    )(request, ctx);
    let reaction: unknown;
    try {
      reaction = await readBoundedJson(request, REACTION_MAX_MESSAGE_BYTES);
    } catch {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-reaction");
    }
    if (!isInviteReactionForInvite(route.inviteId, reaction)) {
      throw new AuthApiFailure(400, "invalid-argument", "invalid-reaction");
    }
    const role = await resolveInviteRole(
      identity,
      { inviteId: route.inviteId },
      repository,
    );
    if (!role.guestId || role.role === "watch" || !role.actorUid) {
      throw new AuthApiFailure(403, "permission-denied", "permission-denied");
    }
    const room =
      dependencies.room || env.INVITE_REACTIONS.getByName(route.inviteId);
    const result = await room.publish(role.actorUid, reaction);
    if (result === "conflict") {
      throw new AuthApiFailure(409, "failed-precondition", "reaction-conflict");
    }
    if (result === "participant-limit") {
      throw new AuthApiFailure(
        503,
        "unavailable",
        "reaction-room-participants-full",
      );
    }
    return authJsonResponse({ ok: true }, 200, corsHeaders);
  } catch (error) {
    if (error instanceof AuthApiFailure) {
      return authErrorResponse(error, corsHeaders);
    }
    (
      dependencies.logFailure ||
      (() => console.error({ event: "invite_reaction_failure" }))
    )();
    return authErrorResponse(
      new AuthApiFailure(503, "unavailable", "reactions-unavailable"),
      corsHeaders,
    );
  }
}
