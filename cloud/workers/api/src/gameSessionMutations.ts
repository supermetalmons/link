import {
  isCreateInviteResponse,
  isEndRematchResponse,
  isEnsureMatchResponse,
  isJoinInviteResponse,
  isProposeRematchResponse,
  normalizeHistoricalMatchRecord,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type EndRematchRequest,
  type EndRematchResponse,
  type EnsureMatchRequest,
  type EnsureMatchResponse,
  type GameSessionMatch,
  type JoinInviteRequest,
  type JoinInviteResponse,
  type ProposeRematchRequest,
  type ProposeRematchResponse,
} from "@mons/shared/game-sessions";
import { isEventOwnedInvite } from "@mons/shared/events";
import { createGameVariantHelpers } from "@mons/shared/game-variants";
import { isAutoInviteId, pickHostColor } from "@mons/shared/ids";
import {
  CONTROLLER_VERSION,
  buildFreshMatchRecord,
} from "@mons/shared/match-protocol";
import {
  getLatestApprovedRematchIndex,
  getLatestRematchIndex,
  parseInviteMatchIndex,
  parseRematchIndices,
  rematchSeriesEnded,
} from "@mons/shared/rematches";
import * as monsRules from "mons-rules";
import {
  TELEGRAM_AUTOMATCH_VERSION,
  buildAutomatchTelegramProjectionChanges,
  buildMatchedAutomatchTelegramChanges,
} from "../../../runtime/telegram/automatchSource.js";
import { getDisplayNameFromAddress } from "../../../runtime/telegramDisplay.js";
import { AuthApiFailure } from "./authErrors.ts";
import type { RequestIdentity } from "./requestIdentity.ts";
import {
  STATE_SERVER_TIMESTAMP,
  stateIncrement,
} from "./stateCompatibility.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import type { GameplayProfile } from "./gameplayRepository.ts";
import type { GameSessionRepository } from "./gameplayContracts.ts";
import { resolveInviteParticipant } from "./inviteAccess.ts";
import type { GameSessionChange } from "./gameSessionContracts.ts";
import {
  runGameSessionMutation,
  type GameSessionMutationRunnerDependencies,
} from "./gameSessionMutationRunner.ts";
import {
  getLoginProfileId,
  getOwnershipProfile,
  loginsShareProfile,
  requireProfileOwnershipSnapshot,
  type ProfileOwnershipSnapshot,
} from "./profileOwnership.ts";

const END_REMATCH_LEASE_RETRY_TIMEOUT_MS = 5_000;
const gameVariantHelpers = createGameVariantHelpers(monsRules);

type GameSessionMutationDependencies = GameSessionMutationRunnerDependencies & {
  random?: () => number;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readStoredString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function failedPrecondition(message: string): AuthApiFailure {
  return new AuthApiFailure(409, "failed-precondition", message);
}

function secureRandom(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] / 0x1_0000_0000;
}

function normalizeMatch(value: unknown): GameSessionMatch | null {
  const match = normalizeHistoricalMatchRecord(value);
  return match?.fen ? match : null;
}

function buildMirroredMatch(
  source: GameSessionMatch,
  emojiId: number,
  aura: string,
): GameSessionMatch {
  const color = source.color === "white" ? "black" : "white";
  return {
    ...buildFreshMatchRecord({
      color,
      emojiId,
      aura,
      seed: {
        gameVariant: source.gameVariant,
        fen: source.fen,
      },
    }),
    color,
    status: source.status,
    flatMovesString: source.flatMovesString,
    timer: source.timer,
  };
}

function ensureMutableInvite(invite: Record<string, unknown>): void {
  if (isEventOwnedInvite(invite)) {
    throw failedPrecondition("event-owned-invite");
  }
}

export async function createManualInvite(
  identity: RequestIdentity,
  request: CreateInviteRequest,
  repository: GameSessionRepository,
  dependencies: GameSessionMutationDependencies,
): Promise<CreateInviteResponse> {
  return runGameSessionMutation(
    "invite-create",
    identity.uid,
    request,
    repository,
    isCreateInviteResponse,
    async () => {
      if (await repository.readInviteMetadata(request.inviteId)) {
        throw failedPrecondition("invite-already-exists");
      }
      const random = dependencies.random || secureRandom;
      const hostColor = pickHostColor(random);
      const match = buildFreshMatchRecord({
        color: hostColor,
        emojiId: request.emojiId,
        aura: request.aura,
        seed: gameVariantHelpers.buildRandomGameSeed(random),
      });
      const response: CreateInviteResponse = {
        ok: true,
        inviteId: request.inviteId,
        hostId: identity.uid,
        matchId: request.inviteId,
      };
      return {
        response,
        projectReason: "manual-invite-created",
        changes: [
          {
            kind: "invite-merge",
            inviteId: request.inviteId,
            value: {
              version: CONTROLLER_VERSION,
              hostId: identity.uid,
              hostColor,
              guestId: null,
            },
          },
          {
            kind: "match-create",
            playerId: identity.uid,
            matchId: request.inviteId,
            value: match,
          },
        ],
      };
    },
    dependencies,
  );
}

function emptyGameplayProfile(request: JoinInviteRequest): GameplayProfile {
  return {
    aura: request.aura,
    emoji: request.emojiId,
    eth: "",
    profileId: "",
    rating: 0,
    sol: "",
    username: "",
  };
}

function joiningProfile(
  identity: RequestIdentity,
  request: JoinInviteRequest,
  ownership: ProfileOwnershipSnapshot,
): GameplayProfile {
  const profileId = getLoginProfileId(ownership, identity.uid);
  return (
    (profileId && getOwnershipProfile(ownership, profileId)?.profile) ||
    emptyGameplayProfile(request)
  );
}

function automatchJoinChanges(
  inviteId: string,
  operationId: string,
  automatch: Record<string, unknown>,
  profile: GameplayProfile,
): GameSessionChange[] {
  if (automatch.telegramDeliveryVersion !== TELEGRAM_AUTOMATCH_VERSION) {
    return [{ kind: "automatch-entry", inviteId, value: null }];
  }
  const existingName = getDisplayNameFromAddress(
    automatch.username,
    automatch.ethAddress,
    automatch.solAddress,
    automatch.rating,
    automatch.emojiId,
  );
  const joiningName = getDisplayNameFromAddress(
    profile.username,
    profile.eth,
    profile.sol,
    profile.rating,
    profile.emoji,
  );
  return [
    { kind: "automatch-entry", inviteId, value: null },
    ...buildMatchedAutomatchTelegramChanges({
      inviteId,
      matchedText: `${existingName} vs. ${joiningName} https://mons.link/${inviteId}`,
      timestamp: STATE_SERVER_TIMESTAMP,
      generation: stateIncrement(1),
    }),
    ...buildAutomatchTelegramProjectionChanges({
      inviteId,
      requestId: operationId,
      timestamp: STATE_SERVER_TIMESTAMP,
    }),
  ];
}

export async function joinInvite(
  identity: RequestIdentity,
  request: JoinInviteRequest,
  repository: GameSessionRepository,
  dependencies: GameSessionMutationDependencies,
): Promise<JoinInviteResponse> {
  return runGameSessionMutation(
    "invite-join",
    identity.uid,
    request,
    repository,
    isJoinInviteResponse,
    async () => {
      const invite = toRecord(
        await repository.readInviteMetadata(request.inviteId),
      );
      if (!invite) {
        throw new AuthApiFailure(404, "not-found", "invite-not-found");
      }
      ensureMutableInvite(invite);
      const hostUid = readStoredString(invite.hostId);
      if (!isSafeRecordKey(hostUid)) {
        throw failedPrecondition("invite-invalid");
      }
      const currentGuestUid = readStoredString(invite.guestId);
      if (currentGuestUid && !isSafeRecordKey(currentGuestUid)) {
        throw failedPrecondition("invite-invalid");
      }
      let ownership: ProfileOwnershipSnapshot | null = null;
      const readOwnership = async () => {
        ownership ||= await requireProfileOwnershipSnapshot(repository, {
          loginUids: [
            identity.uid,
            hostUid,
            ...(currentGuestUid ? [currentGuestUid] : []),
          ],
          profileIds: [],
        });
        return ownership;
      };
      let joinedExisting =
        currentGuestUid !== "" && currentGuestUid === identity.uid;
      if (currentGuestUid && !joinedExisting) {
        joinedExisting = loginsShareProfile(
          await readOwnership(),
          identity.uid,
          currentGuestUid,
        );
      }
      if (currentGuestUid && !joinedExisting) {
        return {
          response: {
            ok: true,
            inviteId: request.inviteId,
            guestId: currentGuestUid,
            joined: false,
            matchId: null,
          },
        };
      }
      const joiningHost =
        !currentGuestUid &&
        (identity.uid === hostUid ||
          loginsShareProfile(await readOwnership(), identity.uid, hostUid));
      if (joiningHost) {
        return {
          response: {
            ok: true,
            inviteId: request.inviteId,
            guestId: null,
            joined: false,
            matchId: null,
          },
        };
      }
      let pendingAutomatch: Record<string, unknown> | null = null;
      if (isAutoInviteId(request.inviteId) && !currentGuestUid) {
        pendingAutomatch = toRecord(
          await repository.readAutomatchEntry(request.inviteId),
        );
        if (readStoredString(pendingAutomatch?.uid) !== hostUid) {
          throw failedPrecondition("automatch-not-pending");
        }
      }
      const guestUid = currentGuestUid || identity.uid;
      const existingMatch = normalizeMatch(
        await repository.readMatchRecord({
          playerId: guestUid,
          matchId: request.inviteId,
        }),
      );
      if (joinedExisting && existingMatch) {
        return {
          response: {
            ok: true,
            inviteId: request.inviteId,
            guestId: guestUid,
            joined: true,
            matchId: request.inviteId,
          },
        };
      }
      const hostMatch = normalizeMatch(
        await repository.readMatchRecord({
          playerId: hostUid,
          matchId: request.inviteId,
        }),
      );
      if (!hostMatch) {
        throw failedPrecondition("host-match-not-found");
      }
      const match = buildMirroredMatch(
        hostMatch,
        request.emojiId,
        request.aura,
      );
      const changes: GameSessionChange[] = [
        {
          kind: "invite-fields",
          inviteId: request.inviteId,
          value: { guestId: guestUid },
        },
        {
          kind: "match-create",
          playerId: guestUid,
          matchId: request.inviteId,
          value: match,
        },
      ];
      if (isAutoInviteId(request.inviteId)) {
        const automatch =
          pendingAutomatch ||
          toRecord(await repository.readAutomatchEntry(request.inviteId)) ||
          {};
        const profile = joiningProfile(
          identity,
          request,
          await readOwnership(),
        );
        changes.push(
          ...automatchJoinChanges(
            request.inviteId,
            request.operationId,
            automatch,
            profile,
          ),
          {
            kind: "invite-fields",
            inviteId: request.inviteId,
            value: {
              automatchStateHint: "matched",
              automatchCanceledAt: null,
            },
          },
        );
      }
      return {
        response: {
          ok: true,
          inviteId: request.inviteId,
          guestId: guestUid,
          joined: true,
          matchId: request.inviteId,
        },
        projectReason: "manual-invite-joined",
        changes,
      };
    },
    dependencies,
  );
}

export function nextRematchIndex(
  invite: Record<string, unknown>,
  role: "guest" | "host",
): number | null {
  if (rematchSeriesEnded(invite)) {
    return null;
  }
  const hostIndices = parseRematchIndices(invite.hostRematches);
  const guestIndices = parseRematchIndices(invite.guestRematches);
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
  invite: Record<string, unknown>,
  role: "guest" | "host",
  index: number,
): "black" | "white" {
  const hostColor = invite.hostColor === "black" ? "black" : "white";
  const guestColor = hostColor === "white" ? "black" : "white";
  if (index % 2 === 0) {
    return role === "host" ? hostColor : guestColor;
  }
  return role === "host" ? guestColor : hostColor;
}

export async function proposeRematch(
  identity: RequestIdentity,
  request: ProposeRematchRequest,
  repository: GameSessionRepository,
  dependencies: GameSessionMutationDependencies,
): Promise<ProposeRematchResponse> {
  return runGameSessionMutation(
    "rematch-propose",
    identity.uid,
    request,
    repository,
    isProposeRematchResponse,
    async () => {
      const invite = toRecord(
        await repository.readInviteMetadata(request.inviteId),
      );
      if (!invite) {
        throw new AuthApiFailure(404, "not-found", "invite-not-found");
      }
      ensureMutableInvite(invite);
      const participant = await resolveInviteParticipant(
        identity,
        invite,
        repository,
      );
      const ownership =
        participant.ownership ||
        (await requireProfileOwnershipSnapshot(repository, {
          loginUids: [participant.actorUid, participant.opponentUid],
          profileIds: [],
        }));
      if (
        loginsShareProfile(
          ownership,
          participant.actorUid,
          participant.opponentUid,
        )
      ) {
        throw failedPrecondition("rematch-unavailable");
      }
      const index = nextRematchIndex(invite, participant.role);
      if (!index) {
        throw failedPrecondition("rematch-unavailable");
      }
      const matchId = `${request.inviteId}${index}`;
      const [storedMatch, storedOpponent] = await Promise.all([
        repository.readMatchRecord({ playerId: participant.actorUid, matchId }),
        repository.readMatchRecord({
          playerId: participant.opponentUid,
          matchId: matchId,
        }),
      ]);
      const existingMatch = normalizeMatch(storedMatch);
      const color = rematchColor(invite, participant.role, index);
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
        : gameVariantHelpers.buildDeterministicGameSeed(`rematch:${matchId}`);
      const match: GameSessionMatch = existingMatch || {
        ...buildFreshMatchRecord({
          color,
          emojiId: request.emojiId,
          aura: request.aura,
          seed,
        }),
        color,
      };
      const field =
        participant.role === "host" ? "hostRematches" : "guestRematches";
      const opponentField =
        participant.role === "host" ? "guestRematches" : "hostRematches";
      const firstProposal = !parseRematchIndices(
        invite[opponentField],
      ).includes(index);
      const current = normalizeString(invite[field]);
      const rematches = current ? `${current};${index}` : String(index);
      return {
        response: {
          ok: true,
          inviteId: request.inviteId,
          actorUid: participant.actorUid,
          matchId,
          rematches,
          match,
        },
        projectReason: `manual-${field}-updated`,
        ...(firstProposal
          ? {
              historicalMatches: [
                {
                  finalizedAtMs: (dependencies.now || Date.now)(),
                  guestPlayerId: String(invite.guestId),
                  hostPlayerId: String(invite.hostId),
                  matchId:
                    index === 1
                      ? request.inviteId
                      : `${request.inviteId}${index - 1}`,
                  source: "transition" as const,
                },
              ],
            }
          : {}),
        changes: [
          {
            kind: "invite-rematches",
            inviteId: request.inviteId,
            role: participant.role,
            value: rematches,
          },
          ...(existingMatch
            ? []
            : [
                {
                  kind: "match-create" as const,
                  playerId: participant.actorUid,
                  matchId,
                  value: match,
                },
              ]),
        ],
      };
    },
    dependencies,
  );
}

export async function endRematchSeries(
  identity: RequestIdentity,
  request: EndRematchRequest,
  repository: GameSessionRepository,
  dependencies: GameSessionMutationDependencies,
): Promise<EndRematchResponse> {
  return runGameSessionMutation(
    "rematch-end",
    identity.uid,
    request,
    repository,
    isEndRematchResponse,
    async () => {
      const invite = toRecord(
        await repository.readInviteMetadata(request.inviteId),
      );
      if (!invite) {
        throw new AuthApiFailure(404, "not-found", "invite-not-found");
      }
      ensureMutableInvite(invite);
      const participant = await resolveInviteParticipant(
        identity,
        invite,
        repository,
      );
      const field =
        participant.role === "host" ? "hostRematches" : "guestRematches";
      const current = normalizeString(invite[field]);
      if (rematchSeriesEnded(invite)) {
        return {
          response: {
            ok: true,
            inviteId: request.inviteId,
            actorUid: participant.actorUid,
            rematches: current.endsWith("x") ? current : `${current}x`,
          },
        };
      }
      const rematches = `${current}x`;
      const latestApprovedIndex = getLatestApprovedRematchIndex(invite);
      const latestProposedIndex = getLatestRematchIndex(invite);
      const matchId =
        latestApprovedIndex === 0
          ? request.inviteId
          : `${request.inviteId}${latestApprovedIndex}`;
      return {
        response: {
          ok: true,
          inviteId: request.inviteId,
          actorUid: participant.actorUid,
          rematches,
        },
        projectReason: `manual-${field}-ended`,
        ...(latestApprovedIndex === latestProposedIndex
          ? {
              historicalMatches: [
                {
                  finalizedAtMs: (dependencies.now || Date.now)(),
                  guestPlayerId: String(invite.guestId),
                  hostPlayerId: String(invite.hostId),
                  matchId,
                  source: "transition" as const,
                },
              ],
            }
          : {}),
        changes: [
          {
            kind: "invite-rematches",
            inviteId: request.inviteId,
            role: participant.role,
            value: rematches,
          },
        ],
      };
    },
    dependencies,
    { acquireRetryTimeoutMs: END_REMATCH_LEASE_RETRY_TIMEOUT_MS },
  );
}

export async function ensureParticipantMatch(
  identity: RequestIdentity,
  request: EnsureMatchRequest,
  repository: GameSessionRepository,
  dependencies: GameSessionMutationDependencies,
): Promise<EnsureMatchResponse> {
  return runGameSessionMutation(
    "match-ensure",
    identity.uid,
    request,
    repository,
    isEnsureMatchResponse,
    async () => {
      const invite = toRecord(
        await repository.readInviteMetadata(request.inviteId),
      );
      if (!invite) {
        throw new AuthApiFailure(404, "not-found", "invite-not-found");
      }
      ensureMutableInvite(invite);
      const index = parseInviteMatchIndex(request.inviteId, request.matchId);
      if (index === null || index > getLatestRematchIndex(invite)) {
        throw failedPrecondition("match-not-current");
      }
      const participant = await resolveInviteParticipant(
        identity,
        invite,
        repository,
      );
      const existing = normalizeMatch(
        await repository.readMatchRecord({
          playerId: participant.actorUid,
          matchId: request.matchId,
        }),
      );
      if (existing) {
        return {
          response: {
            ok: true,
            inviteId: request.inviteId,
            actorUid: participant.actorUid,
            matchId: request.matchId,
            created: false,
            match: existing,
          },
        };
      }
      const opponent = normalizeMatch(
        await repository.readMatchRecord({
          playerId: participant.opponentUid,
          matchId: request.matchId,
        }),
      );
      if (!opponent) {
        throw failedPrecondition("opponent-match-not-found");
      }
      const match = buildMirroredMatch(opponent, request.emojiId, request.aura);
      return {
        response: {
          ok: true,
          inviteId: request.inviteId,
          actorUid: participant.actorUid,
          matchId: request.matchId,
          created: true,
          match,
        },
        projectReason: "manual-match-created",
        changes: [
          {
            kind: "match-create",
            playerId: participant.actorUid,
            matchId: request.matchId,
            value: match,
          },
        ],
      };
    },
    dependencies,
  );
}

export {
  acquireGameSessionMutationLease,
  enforceGameSessionMutationRateLimit,
  GameSessionMutationLeaseReleaseFailure,
  refreshGameSessionMutationLease,
  releaseGameSessionMutationLease,
  sweepGameSessionMutationReceipts,
  withGameSessionMutationLease,
  GAME_SESSION_MUTATION_RECEIPT_EXPIRATION_ROOT,
  GAME_SESSION_MUTATION_RECEIPT_RETENTION_MS,
  GAME_SESSION_MUTATION_RECEIPT_ROOT,
  GAME_SESSION_MUTATION_RECEIPT_SWEEP_LIMIT,
} from "./gameSessionMutationRunner.ts";
export type { GameSessionMutationDependencies };
