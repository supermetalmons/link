import {
  isSurrenderMatchRequest,
  type SurrenderMatchRequest,
  type SurrenderMatchResponse,
} from "@mons/shared/game-sessions";
import {
  parseInviteMatchIndex,
  parseRematchIndices,
} from "@mons/shared/rematches";
import { AuthApiFailure } from "./authErrors.ts";
import { isCanonicalFirebaseUid } from "./firebaseKeys.ts";
import {
  FirebaseRtdbFailure,
  FirebaseRtdbPermissionDenied,
  type FirebaseRtdbClient,
} from "./firebaseRtdb.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";
import {
  getLoginProfileId,
  requireProfileOwnershipSnapshot,
} from "./profileOwnership.ts";
import type { RequestIdentity } from "./requestIdentity.ts";

type SurrenderRepository = Pick<
  GameplayRepository,
  "getRtdbPath" | "readProfileOwnershipSnapshot"
>;

export type SurrenderMatchDependencies = {
  surrenderCanonical?: (
    request: SurrenderMatchRequest,
  ) => Promise<SurrenderMatchResponse>;
  createMatchClient?: (
    scope: Pick<SurrenderMatchRequest, "playerId" | "matchId">,
  ) => Pick<FirebaseRtdbClient, "transactPath">;
  assertMutationAllowed?: () => Promise<void>;
  signal?: AbortSignal;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function surrenderMatch(
  identity: RequestIdentity,
  request: SurrenderMatchRequest,
  repository: SurrenderRepository,
  dependencies: SurrenderMatchDependencies,
): Promise<SurrenderMatchResponse> {
  if (!isSurrenderMatchRequest(request)) {
    throw new AuthApiFailure(400, "invalid-argument", "invalid-request");
  }
  const timeout = AbortSignal.timeout(20_000);
  const signal = dependencies.signal
    ? AbortSignal.any([dependencies.signal, timeout])
    : timeout;
  signal.throwIfAborted();
  const inviteValue = await repository.getRtdbPath(
    `invites/${request.inviteId}`,
    undefined,
    signal,
  );
  if (inviteValue === null || inviteValue === undefined) {
    throw new AuthApiFailure(404, "not-found", "invite-not-found");
  }
  const invite = toRecord(inviteValue);
  if (
    !invite ||
    !isCanonicalFirebaseUid(invite.hostId) ||
    (invite.guestId !== null &&
      invite.guestId !== undefined &&
      (!isCanonicalFirebaseUid(invite.guestId) ||
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
  if (dependencies.surrenderCanonical) {
    return dependencies.surrenderCanonical(request);
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
        const match = toRecord(current);
        if (!match) {
          throw new AuthApiFailure(404, "not-found", "match-not-found");
        }
        return match.status === "surrendered"
          ? { commit: false, decision: "already-surrendered" }
          : {
              decision: "surrendered",
              value: { ...match, status: "surrendered" },
            };
      },
      signal,
      async () => {
        signal.throwIfAborted();
        await dependencies.assertMutationAllowed?.();
      },
    );
    if (
      (!result.committed && result.decision !== "already-surrendered") ||
      toRecord(result.value)?.status !== "surrendered"
    ) {
      throw new FirebaseRtdbFailure();
    }
  } catch (error) {
    if (error instanceof FirebaseRtdbPermissionDenied) {
      throw new AuthApiFailure(
        409,
        "failed-precondition",
        "match-surrender-blocked",
      );
    }
    throw error;
  }
  return {
    ok: true,
    inviteId: request.inviteId,
    matchId: request.matchId,
    actorUid: request.playerId,
  };
}
