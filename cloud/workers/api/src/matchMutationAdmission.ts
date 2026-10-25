import { inviteRematchState } from "@mons/shared/invite-records";
import { registeredInviteMatchIndex } from "./inviteMatchPolicy.ts";
import { AuthApiFailure } from "./authErrors.ts";
import { decodeCanonicalInviteParticipants } from "./canonicalInviteParticipants.ts";
import type { InviteAccessRepository } from "./gameplayContracts.ts";
import {
  authorizeMatchPlayer,
  createMatchAdmissionSignal,
  type MatchAdmissionDependencies,
} from "./matchAdmission.ts";
import type { RequestIdentity } from "./requestIdentity.ts";

export type MatchMutationRepository = InviteAccessRepository;

export type MatchMutationAdmissionDependencies = MatchAdmissionDependencies;

type MatchMutationTarget = {
  inviteId: string;
  matchId: string;
  playerId: string;
};

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
  const participants = decodeCanonicalInviteParticipants(inviteValue);
  if (participants.status === "missing") {
    throw new AuthApiFailure(404, "not-found", "invite-not-found");
  }
  if (participants.status === "invalid") {
    throw new AuthApiFailure(409, "failed-precondition", "invite-invalid");
  }
  const { source, hostId, guestId } = participants;
  const invite = inviteRematchState(source);
  if (request.playerId !== hostId && request.playerId !== guestId) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  await authorizeMatchPlayer(identity, request.playerId, repository);
  if (
    registeredInviteMatchIndex(request.inviteId, request.matchId, invite) ===
    null
  ) {
    throw new AuthApiFailure(404, "not-found", "match-not-found");
  }
  signal.throwIfAborted();
  await dependencies.assertMutationAllowed?.();
}
