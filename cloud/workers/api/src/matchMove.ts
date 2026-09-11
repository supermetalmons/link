import {
  isMoveHistoryPrefix,
  isSubmitMoveRequest,
  isSubmitMoveResponse,
  type SubmitMoveRequest,
  type SubmitMoveResponse,
} from "@mons/shared/game-sessions";
import {
  inviteMatchesPlayers,
  parseInviteMatchIndex,
  parseRematchIndices,
} from "@mons/shared/rematches";
import {
  MATCH_TIMER_CLAIM_ROOT,
  MATCH_TIMER_TERMINAL,
  parseStrictMatchTimer,
} from "@mons/shared/timers";
import { AuthApiFailure } from "./authErrors.ts";
import { isCanonicalLoginUid } from "./recordKeys.ts";
import {
  StateRepositoryFailure,
  StateRepositoryPermissionDenied,
  type StateRepository,
} from "./stateRepositoryTypes.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";
import { decideMatchStateMove } from "./matchStateLogic.ts";
import {
  getLoginProfileId,
  requireProfileOwnershipSnapshot,
} from "./profileOwnership.ts";
import type { RequestIdentity } from "./requestIdentity.ts";

type MoveRepository = Pick<
  GameplayRepository,
  "getStatePath" | "readInviteMetadata" | "readProfileOwnershipSnapshot"
>;

export type SubmitMoveDependencies = {
  submitCanonical?: (request: SubmitMoveRequest) => Promise<SubmitMoveResponse>;
  createMatchClient?: (
    scope: Pick<SubmitMoveRequest, "playerId" | "matchId">,
  ) => Pick<StateRepository, "transactPath">;
  assertMutationAllowed?: () => Promise<void>;
  signal?: AbortSignal;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function hasCommittedTimerClaim(
  request: SubmitMoveRequest,
  invite: Record<string, unknown>,
  repository: MoveRepository,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const claim = toRecord(
      await repository.getStatePath(
        `${MATCH_TIMER_CLAIM_ROOT}/${request.matchId}`,
        undefined,
        AbortSignal.any([signal, AbortSignal.timeout(1200)]),
      ),
    );
    const timer = parseStrictMatchTimer(claim?.timer);
    return (
      claim?.status === "claimed" &&
      claim.inviteId === request.inviteId &&
      isCanonicalLoginUid(claim.playerId) &&
      isCanonicalLoginUid(claim.opponentId) &&
      inviteMatchesPlayers(invite, claim.playerId, claim.opponentId) &&
      typeof claim.turnNumber === "number" &&
      Number.isSafeInteger(claim.turnNumber) &&
      claim.turnNumber >= 0 &&
      (claim.timer === MATCH_TIMER_TERMINAL ||
        timer?.turnNumber === claim.turnNumber) &&
      typeof claim.claimedAtMs === "number" &&
      Number.isSafeInteger(claim.claimedAtMs) &&
      claim.claimedAtMs >= 0 &&
      claim.expiresAtMs == null
    );
  } catch {
    return false;
  }
}

export async function enforceMatchMoveRateLimit(
  rateLimiter: RateLimit,
  uid: string,
): Promise<void> {
  let outcome: RateLimitOutcome;
  try {
    outcome = await rateLimiter.limit({ key: `match-move:${uid}` });
  } catch {
    throw new AuthApiFailure(503, "unavailable", "rate-limit-unavailable");
  }
  if (!outcome.success) {
    throw new AuthApiFailure(
      429,
      "resource-exhausted",
      "Too many move attempts.",
    );
  }
}

export async function submitMove(
  identity: RequestIdentity,
  request: SubmitMoveRequest,
  repository: MoveRepository,
  dependencies: SubmitMoveDependencies,
): Promise<SubmitMoveResponse> {
  if (!isSubmitMoveRequest(request)) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  const timeout = AbortSignal.timeout(20_000);
  const signal = dependencies.signal
    ? AbortSignal.any([dependencies.signal, timeout])
    : timeout;
  signal.throwIfAborted();
  const inviteValue = await repository.readInviteMetadata(
    request.inviteId,
    signal,
  );
  if (inviteValue === null || inviteValue === undefined) {
    throw new AuthApiFailure(404, "not-found", "invite-not-found");
  }
  const invite = toRecord(inviteValue);
  if (
    !invite ||
    !isCanonicalLoginUid(invite.hostId) ||
    (invite.guestId !== null &&
      invite.guestId !== undefined &&
      (!isCanonicalLoginUid(invite.guestId) ||
        invite.guestId === invite.hostId))
  ) {
    throw new AuthApiFailure(409, "failed-precondition", "invite-invalid");
  }
  if (
    request.playerId !== invite.hostId &&
    request.playerId !== invite.guestId
  ) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  if (identity.uid !== request.playerId) {
    const ownership = await requireProfileOwnershipSnapshot(repository, {
      loginUids: [identity.uid, request.playerId],
      profileIds: [],
    });
    const profileId = getLoginProfileId(ownership, identity.uid);
    if (
      !profileId ||
      profileId !== getLoginProfileId(ownership, request.playerId)
    ) {
      throw new AuthApiFailure(403, "permission-denied", "permission-denied");
    }
  }
  const index = parseInviteMatchIndex(request.inviteId, request.matchId);
  if (
    index === null ||
    (index !== 0 &&
      ![
        ...parseRematchIndices(invite.hostRematches),
        ...parseRematchIndices(invite.guestRematches),
      ].includes(index))
  ) {
    throw new AuthApiFailure(404, "not-found", "match-not-found");
  }
  signal.throwIfAborted();
  await dependencies.assertMutationAllowed?.();
  if (dependencies.submitCanonical) {
    return dependencies.submitCanonical(request);
  }
  if (!dependencies.createMatchClient) {
    throw new AuthApiFailure(
      503,
      "unavailable",
      "match-state-canonical-operation-required",
    );
  }
  const client = dependencies.createMatchClient({
    playerId: request.playerId,
    matchId: request.matchId,
  });
  try {
    const result = await client.transactPath(
      `players/${request.playerId}/matches/${request.matchId}`,
      (current) => {
        const decision = decideMatchStateMove(current, request);
        return decision.outcome === "applied"
          ? { decision: "applied", value: decision.value }
          : { commit: false, decision: decision.outcome };
      },
      signal,
      async () => {
        signal.throwIfAborted();
        await dependencies.assertMutationAllowed?.();
      },
    );
    const match = toRecord(result.value);
    if (!result.committed && result.decision === "superseded") {
      const response = {
        ok: true,
        inviteId: request.inviteId,
        matchId: request.matchId,
        actorUid: request.playerId,
        outcome: "superseded",
        fen: match?.fen,
        flatMovesString: match?.flatMovesString,
      };
      if (
        !request.previousStates ||
        !isSubmitMoveResponse(response) ||
        response.outcome !== "superseded" ||
        response.flatMovesString === request.flatMovesString ||
        !isMoveHistoryPrefix(request.flatMovesString, response.flatMovesString)
      )
        throw new StateRepositoryFailure();
      return response;
    }
    if (
      (result.committed
        ? result.decision !== "applied"
        : result.decision !== "already-applied") ||
      match?.fen !== request.fen ||
      match.flatMovesString !== request.flatMovesString
    ) {
      throw new StateRepositoryFailure();
    }
    return {
      ok: true,
      inviteId: request.inviteId,
      matchId: request.matchId,
      actorUid: request.playerId,
      outcome: result.committed ? "applied" : "already-applied",
    };
  } catch (error) {
    if (error instanceof StateRepositoryPermissionDenied) {
      const finished = await hasCommittedTimerClaim(
        request,
        invite,
        repository,
        signal,
      );
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        finished ? "match-move-finished" : "match-move-blocked",
      );
    }
    throw error;
  }
}
