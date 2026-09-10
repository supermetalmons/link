import { normalizeHistoricalMatchRecord } from "@mons/shared/game-sessions";
import {
  isMatchPresentationSnapshot,
  type MatchPresentationSnapshot,
} from "@mons/shared/match-presentation";
import {
  getLatestApprovedRematchIndex,
  parseInviteMatchIndex,
  parseRematchIndices,
  rematchSeriesEnded,
} from "@mons/shared/rematches";
import { AuthApiFailure } from "./authErrors.ts";
import { isCanonicalFirebaseUid, isSafeFirebaseKey } from "./firebaseKeys.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";
import type {
  InviteReactions,
  MatchPresentationSeeds,
} from "./inviteReactions.ts";
import {
  readMatchPresentationControl,
  readRegisteredMatchPresentations,
} from "./matchPresentationRegistry.ts";

export type MatchPresentationReadDependencies = {
  readPresentationControl?: (
    db: D1Database,
  ) => Promise<{ phase: "legacy" | "capture" | "durable" }>;
  readRegisteredPresentations?: typeof readRegisteredMatchPresentations;
};

export type PresentationInvite = Record<string, unknown> & {
  hostId: string;
  guestId: string | null;
  hostRematches?: string;
  guestRematches?: string;
};

export function isPresentationMatchId(
  inviteId: string,
  matchId: string,
): boolean {
  return (
    matchId === matchId.trim() &&
    isSafeFirebaseKey(matchId) &&
    parseInviteMatchIndex(inviteId, matchId) !== null
  );
}

export async function readPresentationInvite(
  repository: GameplayRepository,
  inviteId: string,
): Promise<PresentationInvite> {
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
    (invite.guestId !== undefined &&
      invite.guestId !== null &&
      (!isCanonicalFirebaseUid(invite.guestId) ||
        invite.guestId === invite.hostId))
  ) {
    throw new AuthApiFailure(409, "failed-precondition", "invite-invalid");
  }
  return {
    ...invite,
    hostId: invite.hostId,
    guestId: typeof invite.guestId === "string" ? invite.guestId : null,
    hostRematches:
      typeof invite.hostRematches === "string"
        ? invite.hostRematches
        : undefined,
    guestRematches:
      typeof invite.guestRematches === "string"
        ? invite.guestRematches
        : undefined,
  };
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
  const field =
    actorUid === invite.hostId
      ? "hostRematches"
      : actorUid === invite.guestId
        ? "guestRematches"
        : null;
  if (!field)
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  const ownIndices = parseRematchIndices(invite[field]);
  const otherIndices = parseRematchIndices(
    invite[field === "hostRematches" ? "guestRematches" : "hostRematches"],
  );
  const approvedIndex = getLatestApprovedRematchIndex(invite);
  const latestIndex =
    !rematchSeriesEnded(invite) && ownIndices.length > otherIndices.length
      ? approvedIndex + 1
      : approvedIndex;
  if (matchId !== (latestIndex ? `${inviteId}${latestIndex}` : inviteId)) {
    throw new AuthApiFailure(409, "failed-precondition", "match-not-current");
  }
}

export async function readPresentationSeeds(
  repository: GameplayRepository,
  inviteId: string,
  matchId: string,
  invite: PresentationInvite,
): Promise<MatchPresentationSeeds> {
  requireRegisteredPresentationMatch(inviteId, matchId, invite);
  const actors = invite.guestId
    ? [invite.hostId, invite.guestId]
    : [invite.hostId];
  const entries = await Promise.all(
    actors.map(async (actorUid) => {
      const value = await repository.getRtdbPath(
        `players/${actorUid}/matches/${matchId}`,
      );
      if (value === null || value === undefined) return null;
      const match = normalizeHistoricalMatchRecord(value);
      if (!match)
        throw new AuthApiFailure(409, "failed-precondition", "match-invalid");
      return [actorUid, { emojiId: match.emojiId, aura: match.aura }] as const;
    }),
  );
  const seeds = Object.fromEntries(entries.filter((entry) => entry !== null));
  if (!Object.keys(seeds).length)
    throw new AuthApiFailure(404, "not-found", "match-not-found");
  return seeds;
}

function requireRegisteredPresentationMatch(
  inviteId: string,
  matchId: string,
  invite: PresentationInvite,
): number {
  const index = parseInviteMatchIndex(inviteId, matchId);
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
  return index;
}

export async function readMatchPresentationSnapshot(
  env: Env,
  repository: GameplayRepository,
  inviteId: string,
  matchId: string,
  invite: PresentationInvite,
  dependencies: MatchPresentationReadDependencies & {
    room: Partial<Pick<InviteReactions, "ensurePresentations">>;
    requiredActorUid?: string;
  },
): Promise<{ canonical: boolean; snapshot: MatchPresentationSnapshot }> {
  requireRegisteredPresentationMatch(inviteId, matchId, invite);
  const control = await (
    dependencies.readPresentationControl || readMatchPresentationControl
  )(env.PROFILE_GAMES_DB);
  if (control.phase !== "durable") {
    const seeds = await readPresentationSeeds(
      repository,
      inviteId,
      matchId,
      invite,
    );
    requirePresentationActor(Object.keys(seeds), dependencies.requiredActorUid);
    if (!dependencies.room.ensurePresentations)
      throw new TypeError("presentation-room-unavailable");
    return {
      canonical: false,
      snapshot: await dependencies.room.ensurePresentations(matchId, seeds),
    };
  }
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
  return {
    canonical: true,
    snapshot: { matchId, players },
  };
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
