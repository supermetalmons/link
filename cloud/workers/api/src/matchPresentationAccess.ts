import {
  presentationInviteView,
  type PresentationInviteView,
} from "@mons/shared/invite-records";
import {
  isMatchPresentationSnapshot,
  type MatchPresentationSnapshot,
} from "@mons/shared/match-presentation";
import {
  parseInviteMatchIndex,
  selectInviteMatch,
} from "@mons/shared/rematches";
import { AuthApiFailure } from "./authErrors.ts";
import { decodeCanonicalInviteParticipants } from "./canonicalInviteParticipants.ts";
import type { InviteReadRepository } from "./inviteReadRepository.ts";
import { registeredInviteMatchIndex } from "./inviteMatchPolicy.ts";
import {
  readMatchPresentationControl,
  readRegisteredMatchPresentations,
} from "./matchPresentationRegistry.ts";
import { isSafeRecordKey } from "./recordKeys.ts";

export type MatchPresentationReadDependencies = {
  readPresentationControl?: (
    db: D1Database,
  ) => Promise<{ phase: "legacy" | "capture" | "durable" }>;
  readRegisteredPresentations?: typeof readRegisteredMatchPresentations;
};

export type PresentationInvite = PresentationInviteView;

export function isPresentationMatchId(
  inviteId: string,
  matchId: string,
): boolean {
  return (
    matchId === matchId.trim() &&
    isSafeRecordKey(matchId) &&
    parseInviteMatchIndex(inviteId, matchId) !== null
  );
}

export async function readPresentationInvite(
  repository: Pick<InviteReadRepository, "readInviteMetadata">,
  inviteId: string,
): Promise<PresentationInvite> {
  const value = await repository.readInviteMetadata(inviteId);
  const participants = decodeCanonicalInviteParticipants(value);
  if (participants.status === "missing") {
    throw new AuthApiFailure(404, "not-found", "invite-not-found");
  }
  if (participants.status === "invalid") {
    throw new AuthApiFailure(409, "failed-precondition", "invite-invalid");
  }
  return presentationInviteView(participants);
}

export function requirePresentationPair(invite: PresentationInvite): void {
  if (!invite.guestId)
    throw new AuthApiFailure(409, "failed-precondition", "invite-not-paired");
}

export function requireCurrentPresentationMatch(
  inviteId: string,
  matchId: string,
  invite: PresentationInvite,
  actorUid: string,
): void {
  if (actorUid !== invite.hostId && actorUid !== invite.guestId)
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  if (matchId !== selectInviteMatch(inviteId, invite, actorUid).matchId) {
    throw new AuthApiFailure(409, "failed-precondition", "match-not-current");
  }
}

function requireRegisteredPresentationMatch(
  inviteId: string,
  matchId: string,
  invite: PresentationInvite,
): number {
  const index = registeredInviteMatchIndex(inviteId, matchId, invite);
  if (index === null) {
    throw new AuthApiFailure(404, "not-found", "match-not-found");
  }
  return index;
}

export async function readMatchPresentationSnapshot(
  env: Env,
  inviteId: string,
  matchId: string,
  invite: PresentationInvite,
  dependencies: MatchPresentationReadDependencies & {
    requiredActorUid?: string;
  },
): Promise<MatchPresentationSnapshot> {
  requireRegisteredPresentationMatch(inviteId, matchId, invite);
  const control = await (
    dependencies.readPresentationControl || readMatchPresentationControl
  )(env.PROFILE_GAMES_DB);
  if (control.phase !== "durable")
    throw new Error("match-presentation-authority-not-active");
  const current = await (
    dependencies.readRegisteredPresentations || readRegisteredMatchPresentations
  )(env, inviteId, matchId);
  if (!isMatchPresentationSnapshot(current) || current.matchId !== matchId)
    throw new Error("presentation-unavailable");
  const players = Object.fromEntries(
    Object.entries(current.players).filter(
      ([actorUid]) => actorUid === invite.hostId || actorUid === invite.guestId,
    ),
  );
  if (!Object.keys(players).length)
    throw new AuthApiFailure(404, "not-found", "match-not-found");
  requirePresentationActor(Object.keys(players), dependencies.requiredActorUid);
  return { matchId, players };
}

function requirePresentationActor(
  actorUids: string[],
  requiredActorUid?: string,
): void {
  if (requiredActorUid && !actorUids.includes(requiredActorUid))
    throw new AuthApiFailure(
      409,
      "failed-precondition",
      "actor-match-not-found",
    );
}
