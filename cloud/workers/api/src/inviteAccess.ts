import {
  inviteMutationParticipants,
  type InviteDocument,
  type PresentationInviteView,
} from "@mons/shared/invite-records";
import type {
  ResolveInviteRoleRequest,
  ResolveInviteRoleResponse,
} from "@mons/shared/game-sessions";
import { AuthApiFailure } from "./authErrors.ts";
import { decodeCanonicalInviteParticipants } from "./canonicalInviteParticipants.ts";
import type { InviteAccessRepository } from "./gameplayContracts.ts";
import {
  getLoginProfileId,
  requireProfileOwnershipSnapshot,
  type ProfileOwnershipReader,
  type ProfileOwnershipSnapshot,
} from "./profileOwnership.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import type { RequestIdentity } from "./requestIdentity.ts";

type InviteActorResolution =
  | {
      actorUid: string;
      role: "host" | "guest";
      ownership: ProfileOwnershipSnapshot | null;
    }
  | {
      actorUid: null;
      role: "watch";
      ownership: ProfileOwnershipSnapshot;
    };

type ParticipantResolution = {
  actorUid: string;
  opponentUid: string;
  ownership: ProfileOwnershipSnapshot | null;
  role: "guest" | "host";
};

export async function resolveInviteActor(
  identity: RequestIdentity,
  hostUid: string,
  guestUid: string | null,
  repository: ProfileOwnershipReader,
): Promise<InviteActorResolution> {
  if (identity.uid === hostUid) {
    return { actorUid: hostUid, role: "host", ownership: null };
  }
  if (guestUid && identity.uid === guestUid) {
    return { actorUid: guestUid, role: "guest", ownership: null };
  }
  const ownership = await requireProfileOwnershipSnapshot(repository, {
    loginUids: guestUid
      ? [identity.uid, hostUid, guestUid]
      : [identity.uid, hostUid],
    profileIds: [],
  });
  const identityProfileId = getLoginProfileId(ownership, identity.uid);
  const hostProfileId = getLoginProfileId(ownership, hostUid);
  const guestProfileId = guestUid
    ? getLoginProfileId(ownership, guestUid)
    : null;
  if (identityProfileId) {
    if (hostProfileId === identityProfileId) {
      return { actorUid: hostUid, role: "host", ownership };
    }
    if (guestUid && guestProfileId === identityProfileId) {
      return { actorUid: guestUid, role: "guest", ownership };
    }
  }
  return { actorUid: null, role: "watch", ownership };
}

export async function resolveInviteRole(
  identity: RequestIdentity,
  request: ResolveInviteRoleRequest,
  repository: InviteAccessRepository,
): Promise<ResolveInviteRoleResponse> {
  const storedInvite = await repository.readInviteMetadata(request.inviteId);
  return resolveInviteRoleFromSnapshot(
    identity,
    request,
    storedInvite,
    repository,
  );
}

export async function resolveInviteRoleFromSnapshot(
  identity: RequestIdentity,
  request: ResolveInviteRoleRequest,
  storedInvite: InviteDocument | PresentationInviteView | null,
  repository: ProfileOwnershipReader,
): Promise<ResolveInviteRoleResponse> {
  const participants = decodeCanonicalInviteParticipants(storedInvite);
  if (participants.status === "missing") {
    throw new AuthApiFailure(404, "not-found", "invite-not-found");
  }
  if (participants.status === "invalid") {
    throw new AuthApiFailure(409, "failed-precondition", "invite-invalid");
  }
  const { hostId, guestId, passwordProtected } = participants;
  const { actorUid, role } = await resolveInviteActor(
    identity,
    hostId,
    guestId,
    repository,
  );
  if (passwordProtected && guestId === null && role === "watch") {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  return {
    ok: true,
    inviteId: request.inviteId,
    hostId,
    guestId,
    actorUid,
    role,
  };
}

export async function resolveInviteParticipant(
  identity: RequestIdentity,
  invite: InviteDocument,
  repository: ProfileOwnershipReader,
): Promise<ParticipantResolution> {
  const { hostId: hostUid, guestId: guestUid } =
    inviteMutationParticipants(invite);
  if (!isSafeRecordKey(hostUid) || !isSafeRecordKey(guestUid)) {
    throw new AuthApiFailure(409, "failed-precondition", "missing-opponent");
  }
  const actor = await resolveInviteActor(
    identity,
    hostUid,
    guestUid,
    repository,
  );
  if (actor.role === "watch") {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  return {
    actorUid: actor.actorUid,
    opponentUid: actor.role === "host" ? guestUid : hostUid,
    ownership: actor.ownership,
    role: actor.role,
  };
}
