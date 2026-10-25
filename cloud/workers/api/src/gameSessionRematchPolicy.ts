import {
  inviteHistoricalParticipants,
  inviteRematchState,
  type InviteDocument,
} from "@mons/shared/invite-records";
import type {
  EndRematchResponse,
  GameSessionMatch,
  ProposeRematchRequest,
  ProposeRematchResponse,
} from "@mons/shared/game-sessions";
import type { GameSeed } from "@mons/shared/game-variants";
import { buildFreshMatchRecord } from "@mons/shared/match-protocol";
import {
  getLatestApprovedRematchIndex,
  getLatestRematchIndex,
  parseRematchIndices,
  rematchSeriesEnded,
} from "@mons/shared/rematches";
import { AuthApiFailure } from "./authErrors.ts";
import type { GameSessionChange } from "./gameSessionContracts.ts";
import type { HistoricalMatchDescriptor } from "./historicalMatches.ts";

type RematchRole = "host" | "guest";

type RematchActor = Readonly<{
  actorUid: string;
  role: RematchRole;
}>;

export type RematchProposalInspection = Readonly<{
  index: number;
  matchId: string;
}>;

type RematchResponse = ProposeRematchResponse | EndRematchResponse;

type RematchHistoryDraft = Pick<
  HistoricalMatchDescriptor,
  "guestPlayerId" | "hostPlayerId" | "matchId"
> & {
  source: "transition";
};

export type RematchPlan<Response extends RematchResponse> = {
  response: Response;
  changes?: GameSessionChange[];
  projectReason?: string;
  history?: RematchHistoryDraft;
};

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function failedPrecondition(message: string): AuthApiFailure {
  return new AuthApiFailure(409, "failed-precondition", message);
}

export function nextRematchIndex(
  invite: InviteDocument,
  role: "guest" | "host",
): number | null {
  if (rematchSeriesEnded(inviteRematchState(invite))) {
    return null;
  }
  const hostIndices = parseRematchIndices(
    inviteRematchState(invite).hostRematches,
  );
  const guestIndices = parseRematchIndices(
    inviteRematchState(invite).guestRematches,
  );
  const own = role === "host" ? hostIndices : guestIndices;
  const other = role === "host" ? guestIndices : hostIndices;
  const common = hostIndices.filter((index) => guestIndices.includes(index));
  const latestCommon = common.at(-1) || 0;
  if (latestCommon === 0) {
    if (own.length === 0 && other.length === 0) {
      return 1;
    }
    return own.length < other.length && own.length === 0 ? 1 : null;
  }
  if (own.length > other.length) {
    return null;
  }
  const nextIndex = latestCommon + 1;
  return Number.isSafeInteger(nextIndex) ? nextIndex : null;
}

function rematchColor(
  invite: InviteDocument,
  role: "guest" | "host",
  index: number,
): "black" | "white" {
  const hostColor = inviteRematchState(invite).hostColor;
  const guestColor = hostColor === "white" ? "black" : "white";
  if (index % 2 === 0) {
    return role === "host" ? hostColor : guestColor;
  }
  return role === "host" ? guestColor : hostColor;
}

function rematchHistoryDraft(
  invite: InviteDocument,
  matchId: string,
): RematchHistoryDraft {
  return {
    guestPlayerId: inviteHistoricalParticipants(invite).guestId,
    hostPlayerId: inviteHistoricalParticipants(invite).hostId,
    matchId,
    source: "transition",
  };
}

export function inspectRematchProposal({
  invite,
  inviteId,
  role,
}: {
  invite: InviteDocument;
  inviteId: string;
  role: RematchRole;
}): RematchProposalInspection {
  const index = nextRematchIndex(invite, role);
  if (!index) {
    throw failedPrecondition("rematch-unavailable");
  }
  return { index, matchId: `${inviteId}${index}` };
}

export function finalizeRematchProposal(
  {
    invite,
    request,
    actor,
    inspection: { index, matchId },
    storedMatch,
    storedOpponent,
  }: {
    invite: InviteDocument;
    request: Pick<ProposeRematchRequest, "inviteId" | "emojiId" | "aura">;
    actor: RematchActor;
    inspection: RematchProposalInspection;
    storedMatch: unknown;
    storedOpponent: unknown;
  },
  {
    normalizeMatch,
    buildDeterministicGameSeed,
  }: {
    normalizeMatch: (value: unknown) => GameSessionMatch | null;
    buildDeterministicGameSeed: (seedValue: string) => GameSeed;
  },
): RematchPlan<ProposeRematchResponse> {
  const existingMatch = normalizeMatch(storedMatch);
  const color = rematchColor(invite, actor.role, index);
  if (
    (storedMatch !== null && storedMatch !== undefined && !existingMatch) ||
    (existingMatch && existingMatch.color !== color)
  ) {
    throw failedPrecondition("rematch-match-invalid");
  }
  const opponentMatch = normalizeMatch(storedOpponent);
  const seed = opponentMatch
    ? {
        gameVariant: opponentMatch.gameVariant,
        fen: opponentMatch.fen,
      }
    : buildDeterministicGameSeed(`rematch:${matchId}`);
  const match: GameSessionMatch = existingMatch || {
    ...buildFreshMatchRecord({
      color,
      emojiId: request.emojiId,
      aura: request.aura,
      seed,
    }),
    color,
  };
  const field = actor.role === "host" ? "hostRematches" : "guestRematches";
  const opponentField =
    actor.role === "host" ? "guestRematches" : "hostRematches";
  const firstProposal = !parseRematchIndices(
    inviteRematchState(invite)[opponentField],
  ).includes(index);
  const current = normalizeString(inviteRematchState(invite)[field]);
  const rematches = current ? `${current};${index}` : String(index);
  return {
    response: {
      ok: true,
      inviteId: request.inviteId,
      actorUid: actor.actorUid,
      matchId,
      rematches,
      match,
    },
    projectReason: `manual-${field}-updated`,
    ...(firstProposal
      ? {
          history: rematchHistoryDraft(
            invite,
            index === 1 ? request.inviteId : `${request.inviteId}${index - 1}`,
          ),
        }
      : {}),
    changes: [
      {
        kind: "invite-rematches",
        inviteId: request.inviteId,
        role: actor.role,
        value: rematches,
      },
      ...(existingMatch
        ? []
        : [
            {
              kind: "match-create" as const,
              playerId: actor.actorUid,
              matchId,
              value: match,
            },
          ]),
    ],
  };
}

export function planRematchEnd({
  invite,
  inviteId,
  actor,
}: {
  invite: InviteDocument;
  inviteId: string;
  actor: RematchActor;
}): RematchPlan<EndRematchResponse> {
  const field = actor.role === "host" ? "hostRematches" : "guestRematches";
  const current = normalizeString(inviteRematchState(invite)[field]);
  if (rematchSeriesEnded(inviteRematchState(invite))) {
    return {
      response: {
        ok: true,
        inviteId,
        actorUid: actor.actorUid,
        rematches: current.endsWith("x") ? current : `${current}x`,
      },
    };
  }
  const rematches = `${current}x`;
  const latestApprovedIndex = getLatestApprovedRematchIndex(
    inviteRematchState(invite),
  );
  const latestProposedIndex = getLatestRematchIndex(inviteRematchState(invite));
  const matchId =
    latestApprovedIndex === 0 ? inviteId : `${inviteId}${latestApprovedIndex}`;
  return {
    response: {
      ok: true,
      inviteId,
      actorUid: actor.actorUid,
      rematches,
    },
    projectReason: `manual-${field}-ended`,
    ...(latestApprovedIndex === latestProposedIndex
      ? { history: rematchHistoryDraft(invite, matchId) }
      : {}),
    changes: [
      {
        kind: "invite-rematches",
        inviteId,
        role: actor.role,
        value: rematches,
      },
    ],
  };
}
