import type {
  ResolveInviteRoleRequest,
  ResolveInviteRoleResponse,
} from "@mons/shared/game-sessions";
import { AuthApiFailure } from "./authErrors.ts";
import type { InviteAccessRepository } from "./gameplayContracts.ts";
import {
  getLoginProfileId,
  requireProfileOwnershipSnapshot,
  type ProfileOwnershipReader,
  type ProfileOwnershipSnapshot,
} from "./profileOwnership.ts";
import { isCanonicalLoginUid, isSafeRecordKey } from "./recordKeys.ts";
import type { RequestIdentity } from "./requestIdentity.ts";

type InviteActorResolution = (
  | { actorUid: string; role: "host" | "guest" }
  | { actorUid: null; role: "watch" }
) & { ownership: ProfileOwnershipSnapshot | null };

type ParticipantResolution = {
  actorUid: string;
  opponentUid: string;
  ownership: ProfileOwnershipSnapshot | null;
  role: "guest" | "host";
};

function readStoredString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function resolveInviteActor(
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
  storedInvite: unknown,
  repository: ProfileOwnershipReader,
): Promise<ResolveInviteRoleResponse> {
  if (storedInvite === null || storedInvite === undefined) {
    throw new AuthApiFailure(404, "not-found", "invite-not-found");
  }
  if (typeof storedInvite !== "object" || Array.isArray(storedInvite)) {
    throw new AuthApiFailure(409, "failed-precondition", "invite-invalid");
  }
  const invite = storedInvite as Record<string, unknown>;
  const hostId = readStoredString(invite.hostId);
  const storedGuestId = invite.guestId;
  const guestId =
    storedGuestId === null || storedGuestId === undefined
      ? null
      : readStoredString(storedGuestId);
  const passwordProtected = Object.hasOwn(invite, "password");
  if (
    !isCanonicalLoginUid(hostId) ||
    (guestId !== null && (!isCanonicalLoginUid(guestId) || guestId === hostId))
  ) {
    throw new AuthApiFailure(409, "failed-precondition", "invite-invalid");
  }
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
  invite: Record<string, unknown>,
  repository: ProfileOwnershipReader,
): Promise<ParticipantResolution> {
  const hostUid = readStoredString(invite.hostId);
  const guestUid = readStoredString(invite.guestId);
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
