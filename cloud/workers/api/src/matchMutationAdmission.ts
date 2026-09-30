import {
  parseInviteMatchIndex,
  parseRematchIndices,
} from "@mons/shared/rematches";
import { AuthApiFailure } from "./authErrors.ts";
import type { InviteAccessRepository } from "./gameplayContracts.ts";
import {
  authorizeMatchPlayer,
  createMatchAdmissionSignal,
  type MatchAdmissionDependencies,
} from "./matchAdmission.ts";
import { isCanonicalLoginUid } from "./recordKeys.ts";
import type { RequestIdentity } from "./requestIdentity.ts";

export type MatchMutationRepository = InviteAccessRepository;

export type MatchMutationAdmissionDependencies = MatchAdmissionDependencies;

type MatchMutationTarget = {
  inviteId: string;
  matchId: string;
  playerId: string;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function authorizeMatchMutation(
  identity: RequestIdentity,
  request: MatchMutationTarget,
  repository: MatchMutationRepository,
  dependencies: MatchMutationAdmissionDependencies,
): Promise<void> {
  const signal = createMatchAdmissionSignal(dependencies.signal);
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
  await authorizeMatchPlayer(identity, request.playerId, repository);
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
}
