import type {
  ApiTransport,
  ApiRequestValidator,
  ApiParameters,
} from "@mons/shared/api-contracts";
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
  verifySessionRequest,
  type SessionIdentity,
  type WorkerExecutionContext,
} from "./sessionAuth.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import {
  createInviteReadRepository,
  type InviteReadRepository,
} from "./inviteReadRepository.ts";
import { resolveInviteRoleFromSnapshot } from "./inviteAccess.ts";
import { readBoundedJson } from "./http.ts";
import type { InviteReactions } from "./inviteReactions.ts";
import {
  isPresentationMatchId,
  readMatchPresentationSnapshot,
  readPresentationInvite,
  requireCurrentPresentationMatch,
  requirePresentationPair,
  type MatchPresentationReadDependencies,
} from "./matchPresentationAccess.ts";
type MatchPresentationConflictResponse = Extract<
  ApiTransport<"POST /invites/:inviteId/matches/:matchId/presentation">,
  { kind: "json"; status: 409; body: { error: "presentation-conflict" } }
>["body"];

const PRESENTATION_ROUTE_PATTERN =
  /^\/invites\/([^/]+)\/matches\/([^/]+)\/presentation$/;

export type MatchPresentationRouteDependencies =
  MatchPresentationReadDependencies & {
    repository?: InviteReadRepository;
    room?: Pick<InviteReactions, "updatePresentation">;
    verifyIdentity?: (
      request: Request,
      env: Env,
      ctx: WorkerExecutionContext,
    ) => Promise<SessionIdentity>;
    logFailure?: () => void;
  };

export function isMatchPresentationPath(pathname: string): boolean {
  return PRESENTATION_ROUTE_PATTERN.test(pathname);
}

function readRoute(
  request: Request,
): ApiParameters<"GET /invites/:inviteId/matches/:matchId/presentation"> {
  const url = new URL(request.url);
  const parts = url.pathname.match(PRESENTATION_ROUTE_PATTERN);
  try {
    const inviteId = decodeURIComponent(parts?.[1] || "");
    const matchId = decodeURIComponent(parts?.[2] || "");
    if (
      url.search ||
      inviteId.trim() !== inviteId ||
      !isSafeRecordKey(inviteId) ||
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
    const repository =
      dependencies.repository || createInviteReadRepository(env);
    const identity =
      request.method === "POST" || request.headers.has("Authorization")
        ? await (dependencies.verifyIdentity || verifySessionRequest)(
            request,
            env,
            ctx,
          )
        : null;
    const invite = await readPresentationInvite(repository, inviteId);
    let actorUid: string | null = null;
    if (identity) {
      const role = await resolveInviteRoleFromSnapshot(
        identity,
        { inviteId },
        invite,
        repository,
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
      if (
        !(
          isUpdateMatchPresentationRequest satisfies ApiRequestValidator<"POST /invites/:inviteId/matches/:matchId/presentation">
        )(update)
      )
        throw new AuthApiFailure(
          400,
          "invalid-argument",
          "invalid-presentation",
        );
    }
    const room = dependencies.room || env.INVITE_REACTIONS.getByName(inviteId);
    const snapshot = await readMatchPresentationSnapshot(
      env,
      inviteId,
      matchId,
      invite,
      {
        ...dependencies,
        ...(request.method === "POST" && actorUid
          ? { requiredActorUid: actorUid }
          : {}),
      },
    );
    if (request.method === "GET")
      return authJsonResponse<
        "GET /invites/:inviteId/matches/:matchId/presentation",
        200
      >({ ok: true, presentation: snapshot }, 200, corsHeaders);
    if (
      !actorUid ||
      !(
        isUpdateMatchPresentationRequest satisfies ApiRequestValidator<"POST /invites/:inviteId/matches/:matchId/presentation">
      )(update)
    )
      throw new TypeError("invalid-presentation-update");
    const result = await room.updatePresentation(actorUid, matchId, update);
    return result.status === "conflict"
      ? authJsonResponse<
          "POST /invites/:inviteId/matches/:matchId/presentation",
          409
        >(
          {
            ok: false,
            error: "presentation-conflict",
            presentation: result.presentation,
          } satisfies MatchPresentationConflictResponse,
          409,
          corsHeaders,
        )
      : authJsonResponse<
          "POST /invites/:inviteId/matches/:matchId/presentation",
          200
        >({ ok: true, presentation: result.presentation }, 200, corsHeaders);
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
