import {
  PRESENTATION_MAX_REQUEST_BYTES,
  isUpdateMatchPresentationRequest,
} from "@mons/shared/match-presentation";
import { AuthApiFailure, authErrorResponse } from "./authErrors.ts";
import {
  authJsonResponse,
  authPreflightResponse,
  getAuthCorsHeaders,
} from "./authHttp.ts";
import {
  verifyFirebaseRequest,
  type WorkerExecutionContext,
} from "./firebaseAuth.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import {
  createGameplayRepository,
  type GameplayRepository,
} from "./gameplayRepository.ts";
import { resolveInviteRole } from "./gameSessionMutations.ts";
import { readBoundedJson } from "./http.ts";
import type { InviteReactions } from "./inviteReactions.ts";
import {
  isPresentationMatchId,
  readPresentationInvite,
  readPresentationSeeds,
  requireCurrentPresentationMatch,
  requirePresentationPair,
} from "./matchPresentationAccess.ts";
import type { RequestIdentity } from "./requestIdentity.ts";

const PRESENTATION_ROUTE_PATTERN =
  /^\/invites\/([^/]+)\/matches\/([^/]+)\/presentation$/;

export type MatchPresentationRouteDependencies = {
  repository?: GameplayRepository;
  room?: Pick<InviteReactions, "ensurePresentations" | "updatePresentation">;
  verifyIdentity?: (
    request: Request,
    ctx: WorkerExecutionContext,
  ) => Promise<RequestIdentity>;
  logFailure?: () => void;
};

export function isMatchPresentationPath(pathname: string): boolean {
  return PRESENTATION_ROUTE_PATTERN.test(pathname);
}

function readRoute(request: Request): { inviteId: string; matchId: string } {
  const url = new URL(request.url);
  const parts = url.pathname.match(PRESENTATION_ROUTE_PATTERN);
  try {
    const inviteId = decodeURIComponent(parts?.[1] || "");
    const matchId = decodeURIComponent(parts?.[2] || "");
    if (
      url.search ||
      inviteId.trim() !== inviteId ||
      !isSafeFirebaseKey(inviteId) ||
      !isPresentationMatchId(inviteId, matchId)
    )
      throw new Error();
    return { inviteId, matchId };
  } catch {
    throw new AuthApiFailure(
      400,
      "invalid-argument",
      "invalid-presentation-path",
    );
  }
}

export async function handleMatchPresentationRoute(
  request: Request,
  env: Env,
  ctx: WorkerExecutionContext,
  dependencies: MatchPresentationRouteDependencies = {},
): Promise<Response> {
  let corsHeaders: Record<string, string> = { Vary: "Origin" };
  try {
    corsHeaders = getAuthCorsHeaders(request);
    const { inviteId, matchId } = readRoute(request);
    if (request.method === "OPTIONS") return authPreflightResponse(corsHeaders);
    if (request.method !== "GET" && request.method !== "POST")
      throw new AuthApiFailure(405, "method-not-allowed", "method-not-allowed");
    const ip = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
    const limited = await env.REACTION_RATE_LIMITER.limit({
      key: `presentation:${request.method.toLowerCase()}:ip:${ip}`,
    });
    if (!limited.success)
      return authJsonResponse(
        { ok: false, error: "resource-exhausted", message: "rate-limited" },
        429,
        { ...corsHeaders, "Retry-After": "60" },
      );
    const repository = dependencies.repository || createGameplayRepository(env);
    const identity =
      request.method === "POST" || request.headers.has("Authorization")
        ? await (dependencies.verifyIdentity || verifyFirebaseRequest)(
            request,
            ctx,
          )
        : null;
    const invite = await readPresentationInvite(repository, inviteId);
    let actorUid: string | null = null;
    if (identity) {
      const role = await resolveInviteRole(
        identity,
        { inviteId },
        {
          ...repository,
          getRtdbPath: async (path) =>
            path === `invites/${inviteId}`
              ? invite
              : repository.getRtdbPath(path),
        },
      );
      actorUid = role.actorUid;
    }
    if (request.method === "POST") {
      if (!actorUid)
        throw new AuthApiFailure(403, "permission-denied", "permission-denied");
      const actorLimit = await env.REACTION_RATE_LIMITER.limit({
        key: `presentation:post:actor:${actorUid}`,
      });
      if (!actorLimit.success)
        return authJsonResponse(
          { ok: false, error: "resource-exhausted", message: "rate-limited" },
          429,
          { ...corsHeaders, "Retry-After": "60" },
        );
      requireCurrentPresentationMatch(inviteId, matchId, invite, actorUid);
    } else if (!invite.guestId && actorUid !== invite.hostId) {
      requirePresentationPair(invite);
    }
    let update: unknown;
    if (request.method === "POST") {
      try {
        update = await readBoundedJson(request, PRESENTATION_MAX_REQUEST_BYTES);
      } catch {
        throw new AuthApiFailure(
          400,
          "invalid-argument",
          "invalid-presentation",
        );
      }
      if (!isUpdateMatchPresentationRequest(update))
        throw new AuthApiFailure(
          400,
          "invalid-argument",
          "invalid-presentation",
        );
    }
    const seeds = await readPresentationSeeds(
      repository,
      inviteId,
      matchId,
      invite,
    );
    if (
      request.method === "POST" &&
      (!actorUid || !Object.hasOwn(seeds, actorUid))
    )
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "actor-match-not-found",
      );
    const room = dependencies.room || env.INVITE_REACTIONS.getByName(inviteId);
    const snapshot = await room.ensurePresentations(matchId, seeds);
    if (request.method === "GET")
      return authJsonResponse(
        { ok: true, presentation: snapshot },
        200,
        corsHeaders,
      );
    if (!actorUid || !isUpdateMatchPresentationRequest(update))
      throw new TypeError("invalid-presentation-update");
    const result = await room.updatePresentation(actorUid, matchId, update);
    return result.status === "conflict"
      ? authJsonResponse(
          {
            ok: false,
            error: "presentation-conflict",
            presentation: result.presentation,
          },
          409,
          corsHeaders,
        )
      : authJsonResponse(
          { ok: true, presentation: result.presentation },
          200,
          corsHeaders,
        );
  } catch (error) {
    if (error instanceof AuthApiFailure)
      return authErrorResponse(error, corsHeaders);
    (
      dependencies.logFailure ||
      (() => console.error({ event: "match_presentation_failure" }))
    )();
    return authErrorResponse(
      new AuthApiFailure(503, "unavailable", "presentation-unavailable"),
      corsHeaders,
    );
  }
}
