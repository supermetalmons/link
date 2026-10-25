import {
  type EventMatchesDocument,
  eventState,
  eventParticipantState,
  eventMatchState,
  eventRoundAt,
  eventRoundMatches,
  eventMatchAt,
  eventPlacementMatches,
  eventMatchEntries,
  eventParticipantAt,
  eventParticipantEntries,
  eventParticipantJoinedOrder,
  eventPrizeAssignments,
  createEventParticipantsDocument,
  copyEventParticipant,
  copyEventParticipants,
  readEventDocument,
} from "./documents.js";
import type { EventRuntimeStore, EventCommitPlan } from "../eventCommands.js";
import type { WithdrawalDocument } from "../eventPrizes/records.js";
import type { EventPrizeAssignmentRecord } from "../eventReads.js";
import type { EventOwnershipSnapshot } from "./ownership.js";
import type {
  EventData,
  EventParticipant,
  EventParticipants,
  EventMatch,
  EventRounds,
  EventPlacement,
  MatchResolution,
  BuildGameSeed,
  MatchReadinessInput,
} from "./model.js";
import type {
  FixedBracketInput,
  ThirdPlaceReadinessOptions,
  EventStartTransitionDependencies,
} from "./startTransitionCore.js";
import { eventField } from "../eventCommands.js";

import { resolveMatchWinner as defaultResolveMatchWinner } from "../matchOutcome.js";
import { buildEventPrizeAssignments } from "../eventPrizeAwards.js";
import { getEventPrizeDefinitions } from "@mons/shared/event-prizes";
import {
  filterProjectableEventPrizeAssignments,
  isCompletedEventPrizeWithdrawal,
  isMatchingProfileEventPrizeAssignment,
} from "../eventPrizeProjectionState.js";
import { buildRandomGameSeed as defaultBuildRandomGameSeed } from "../gameVariants.js";
import {
  applyMatchResolution,
  assignWinnerToNextRound,
  buildSeedToProfileId,
  buildFixedBracketState as buildFixedBracketStateCore,
  buildScheduledEventDueUpdatesCore,
  createEmptyEventMatch,
  getSortedMatchKeys,
  getSortedRoundIndexes,
  hasThirdPlaceMatchField,
  isMatchResolved,
  isMatchSlotBlocked,
  isMatchWinnerDisqualified,
  recomputeRoundStatuses,
  reconcileBracketMatchReadiness as reconcileBracketMatchReadinessCore,
  reconcileThirdPlaceMatchReadiness as reconcileThirdPlaceMatchReadinessCore,
  setMatchSlotBlocked,
  setMatchSlotParticipant,
} from "./startTransitionCore.js";
import {
  canonicalizeEventPrizeSelections,
  profileOwnershipUnavailable,
  resolveOwnedProfileReferences,
  resolvePrizeProjectionOwnerId,
} from "./ownership.js";
export type EventMatchPairRequest = {
  inviteId: string;
  matchId: string;
  playerId: string;
  opponentId: string;
};
export type EventBracketDependencies = {
  state?: Pick<EventRuntimeStore, "transactProfileEventPrize">;
  readMatchPair?(input: EventMatchPairRequest): Promise<[unknown, unknown]>;
  readMatchPairs?(
    input: EventMatchPairRequest[],
  ): Promise<Array<[unknown, unknown]>>;
  buildRandomGameSeed?: BuildGameSeed;
  resolveMatchWinner?(
    match: unknown,
    opponentMatch: unknown,
  ): Promise<{ winner: "player" | "opponent" | null; reason?: string }>;
  readEventPrizeWithdrawals?(
    eventId: string,
  ): Promise<Record<string, WithdrawalDocument>>;
};
export type EventPrizePlacementsInput = {
  event: EventData | null;
  rounds: EventRounds;
  participantsById: EventParticipants;
  thirdPlaceMatch?: EventMatch | null;
};
type PrizeProjectionInput = {
  event: EventData;
  eventId: string;
  assignments: Record<string, EventPrizeAssignmentRecord>;
  ownershipSnapshot: EventOwnershipSnapshot | null;
};

const createEventBracketRuntime = (
  dependencies: EventBracketDependencies = {},
) => {
  const state = dependencies.state;
  const resolveMatchWinner =
    dependencies.resolveMatchWinner || defaultResolveMatchWinner;
  const buildRandomGameSeed =
    dependencies.buildRandomGameSeed || defaultBuildRandomGameSeed;
  const readEventPrizeWithdrawals =
    dependencies.readEventPrizeWithdrawals ||
    (async () => {
      throw new Error("readEventPrizeWithdrawals dependency is required");
    });
  const EVENT_MATCH_RESOLVE_CONCURRENCY = 4;

  const normalizeString = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : "";
  const normalizeStringOrNull = (value: unknown) =>
    normalizeString(value) || null;
  const canonicalizePrizePlacementsAndSelections = (
    placements: EventPlacement[],
    value: Record<string, string> | null | undefined,
    participantsById: EventParticipants,
    ownershipSnapshot: EventOwnershipSnapshot | null,
  ) => {
    const selections =
      value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const placementEntries = Array.isArray(placements) ? placements : [];
    const placementProfileIds = placementEntries.map((placement) =>
      normalizeString(placement?.profileId),
    );
    if (placementEntries.length === 0) {
      return { placements: [], selections: {} };
    }
    if (!ownershipSnapshot) throw profileOwnershipUnavailable();
    const placementReferences = placementProfileIds.map((profileId) => {
      const participant =
        eventParticipantAt(participantsById, profileId) ||
        eventParticipantEntries(participantsById)
          .map(([, value]) => value)
          .find(
            (candidate) =>
              candidate &&
              typeof candidate === "object" &&
              normalizeString(eventParticipantState(candidate).profileId) ===
                profileId,
          );
      return {
        profileId,
        loginUid: normalizeString(
          participant && eventParticipantState(participant).loginUid,
        ),
      };
    });
    const canonicalPlacementProfileIds = resolveOwnedProfileReferences(
      ownershipSnapshot,
      placementReferences,
    );
    const canonicalPlacements = placementEntries.map((placement, index) => ({
      ...placement,
      profileId: canonicalPlacementProfileIds[index],
    }));
    const placementProfileIdSet = new Set(placementProfileIds);
    const participantEntries = eventParticipantEntries(participantsById);
    const participantProfileIds = ([profileId, participant]: [
      string,
      EventParticipant,
    ]) =>
      [
        normalizeString(profileId),
        normalizeString(
          participant && eventParticipantState(participant).profileId,
        ),
      ].filter(Boolean);
    const isPlacementParticipant = ([profileId, participant]: [
      string,
      EventParticipant,
    ]) =>
      placementProfileIdSet.has(normalizeString(profileId)) ||
      placementProfileIdSet.has(
        normalizeString(
          participant && eventParticipantState(participant).profileId,
        ),
      );
    const placementParticipantEntries = participantEntries.filter(
      isPlacementParticipant,
    );
    const placementParticipantProfileIds = new Set(
      placementParticipantEntries.flatMap(participantProfileIds),
    );
    const unplacedParticipantProfileIds = new Set(
      participantEntries
        .filter((entry) => !isPlacementParticipant(entry))
        .flatMap((entry) =>
          participantProfileIds(entry).filter(
            (candidateProfileId) =>
              !placementParticipantProfileIds.has(candidateProfileId),
          ),
        ),
    );
    const placementSelections = Object.fromEntries(
      Object.entries(selections).filter(
        ([profileId]) =>
          !unplacedParticipantProfileIds.has(normalizeString(profileId)),
      ),
    );
    const canonicalSelections = canonicalizeEventPrizeSelections(
      readEventDocument({
        participants: createEventParticipantsDocument(
          Object.fromEntries(placementParticipantEntries),
        ),
      })!,
      placementSelections,
      ownershipSnapshot,
    ).selectionsByProfileId;
    return {
      placements: canonicalPlacements,
      selections: canonicalSelections,
    };
  };

  const reconcileBracketMatchReadiness = (
    input: Omit<MatchReadinessInput, "buildRandomGameSeed">,
  ) =>
    reconcileBracketMatchReadinessCore({
      ...input,
      buildRandomGameSeed,
    });

  const reconcileThirdPlaceMatchReadiness = (
    input: Omit<
      MatchReadinessInput,
      "buildRandomGameSeed" | "ownershipSnapshot"
    > &
      ThirdPlaceReadinessOptions,
  ) =>
    reconcileThirdPlaceMatchReadinessCore({
      ...input,
      buildRandomGameSeed,
    });

  const rebuildParticipantStatesFromRounds = ({
    participantsById,
    rounds,
    winnerProfileId,
    eventEnded,
  }: {
    participantsById: EventParticipants;
    rounds: EventRounds;
    winnerProfileId: unknown;
    eventEnded: boolean;
  }) => {
    const eliminationsByProfileId: Record<
      string,
      { eliminatedRoundIndex: number; eliminatedByProfileId: string | null }
    > = {};
    const sortedRoundIndexes = getSortedRoundIndexes(rounds);
    for (const roundIndex of sortedRoundIndexes) {
      const round = eventRoundAt(rounds, String(roundIndex));
      if (
        !round ||
        !eventRoundMatches(round) ||
        typeof eventRoundMatches(round) !== "object"
      ) {
        continue;
      }
      const matchKeys = getSortedMatchKeys(eventRoundMatches(round));
      for (const matchKey of matchKeys) {
        const match = eventMatchAt(eventRoundMatches(round), matchKey);
        if (!match || typeof match !== "object") {
          continue;
        }

        if (!isMatchResolved(match)) {
          continue;
        }
        const loserProfileId = normalizeString(
          match && eventMatchState(match).loserProfileId,
        );
        if (!loserProfileId || eliminationsByProfileId[loserProfileId]) {
          continue;
        }
        eliminationsByProfileId[loserProfileId] = {
          eliminatedRoundIndex: roundIndex,
          eliminatedByProfileId:
            normalizeString(match && eventMatchState(match).winnerProfileId) ||
            null,
        };
      }
    }

    const normalizedWinnerProfileId = normalizeStringOrNull(winnerProfileId);
    const replacements = new Map<string, EventParticipant>();
    let didChange = false;
    for (const [profileId, participant] of eventParticipantEntries(
      participantsById,
    )) {
      const elimination = eliminationsByProfileId[profileId] || null;
      let state: "active" | "winner" | "eliminated" = "active";
      let eliminatedRoundIndex = null;
      let eliminatedByProfileId = null;

      if (
        eventEnded &&
        normalizedWinnerProfileId &&
        profileId === normalizedWinnerProfileId
      ) {
        state = "winner";
      } else if (elimination) {
        state = "eliminated";
        eliminatedRoundIndex = elimination.eliminatedRoundIndex;
        eliminatedByProfileId = elimination.eliminatedByProfileId;
      }

      const participantState = eventParticipantState(participant);
      const normalizedCurrentEliminatedRoundIndex =
        typeof participantState.eliminatedRoundIndex === "number"
          ? Math.floor(participantState.eliminatedRoundIndex)
          : null;
      const normalizedCurrentEliminatedByProfileId = normalizeStringOrNull(
        eventParticipantState(participant).eliminatedByProfileId,
      );
      if (
        eventParticipantState(participant).state !== state ||
        normalizedCurrentEliminatedRoundIndex !== eliminatedRoundIndex ||
        normalizedCurrentEliminatedByProfileId !== eliminatedByProfileId
      ) {
        didChange = true;
      }

      replacements.set(
        profileId,
        copyEventParticipant(participant, {
          state,
          eliminatedRoundIndex,
          eliminatedByProfileId,
        }),
      );
    }

    return {
      didChange,
      participantsById: copyEventParticipants(participantsById, replacements),
    };
  };

  const getEventPrizeDisqualifiedIdentityKeys = ({
    rounds,
    thirdPlaceMatch,
  }: {
    rounds: EventRounds;
    thirdPlaceMatch: EventMatch | null | undefined;
  }) => {
    const identityKeys = new Set<string>();
    const addMatchIdentities = (match: EventMatch | null | undefined) => {
      if (!match || eventMatchState(match).winnerDisqualified !== true) {
        return;
      }
      for (const value of [
        eventMatchState(match).hostProfileId,
        eventMatchState(match).hostLoginUid,
        eventMatchState(match).guestProfileId,
        eventMatchState(match).guestLoginUid,
      ]) {
        const identityKey = normalizeString(value);
        if (identityKey) {
          identityKeys.add(identityKey);
        }
      }
    };

    for (const roundIndex of getSortedRoundIndexes(rounds)) {
      const matches = eventRoundMatches(
        eventRoundAt(rounds, String(roundIndex)),
      );
      for (const matchKey of getSortedMatchKeys(matches)) {
        addMatchIdentities(eventMatchAt(matches, matchKey));
      }
    }
    addMatchIdentities(thirdPlaceMatch);
    return identityKeys;
  };

  const isEventPrizeParticipantDisqualified = (
    participant: EventParticipant | null | undefined,
    identityKeys: Set<string>,
  ) => {
    if (!participant) {
      return false;
    }
    const profileId = normalizeString(
      eventParticipantState(participant).profileId,
    );
    const loginUid = normalizeString(
      eventParticipantState(participant).loginUid,
    );
    return (
      (profileId && identityKeys.has(profileId)) ||
      (loginUid && identityKeys.has(loginUid))
    );
  };

  const getResolvedMatchProfileId = (
    match: EventMatch | null | undefined,
    result: "winner" | "loser",
  ) => {
    const directProfileId = normalizeString(
      result === "winner"
        ? eventMatchState(match).winnerProfileId
        : eventMatchState(match).loserProfileId,
    );
    if (directProfileId) {
      return directProfileId;
    }
    const status = normalizeString(eventMatchState(match).status);
    const winnerSide =
      status === "host" ? "host" : status === "guest" ? "guest" : null;
    if (!winnerSide) {
      return "";
    }
    const side =
      result === "winner"
        ? winnerSide
        : winnerSide === "host"
          ? "guest"
          : "host";
    return normalizeString(
      eventMatchState(match)[
        side === "guest" ? "guestProfileId" : "hostProfileId"
      ],
    );
  };

  const getEventPrizePlacements = ({
    event,
    rounds,
    participantsById,
    thirdPlaceMatch,
  }: EventPrizePlacementsInput): EventPlacement[] => {
    const sortedRoundIndexes = getSortedRoundIndexes(rounds);
    const finalRoundIndex = sortedRoundIndexes[sortedRoundIndexes.length - 1];
    const finalRound = eventRoundAt(rounds, String(finalRoundIndex));
    const finalMatches = eventPlacementMatches(finalRound);
    const finalMatchEntry = finalMatches[getSortedMatchKeys(finalMatches)[0]];
    if (!finalMatchEntry?.present) return [];
    const finalMatch = finalMatchEntry.match;

    const disqualifiedIdentityKeys = getEventPrizeDisqualifiedIdentityKeys({
      rounds,
      thirdPlaceMatch,
    });
    const winnerProfileId =
      normalizeString(eventState(event).winnerProfileId) ||
      getResolvedMatchProfileId(finalMatch, "winner");
    const winner = eventParticipantAt(participantsById, winnerProfileId);
    if (
      !winner ||
      isEventPrizeParticipantDisqualified(winner, disqualifiedIdentityKeys)
    ) {
      return [];
    }

    const placements: EventPlacement[] = [
      { place: 1, profileId: winnerProfileId },
    ];
    const reservedProfileIds = new Set([winnerProfileId]);
    const placementCandidates: string[] = [];
    const pushCandidate = (profileId: unknown) => {
      const normalizedProfileId = normalizeString(profileId);
      const participant = eventParticipantAt(
        participantsById,
        normalizedProfileId,
      );
      if (
        !normalizedProfileId ||
        !participant ||
        reservedProfileIds.has(normalizedProfileId) ||
        isEventPrizeParticipantDisqualified(
          participant,
          disqualifiedIdentityKeys,
        )
      ) {
        return;
      }
      reservedProfileIds.add(normalizedProfileId);
      placementCandidates.push(normalizedProfileId);
    };

    pushCandidate(getResolvedMatchProfileId(finalMatch, "loser"));
    if (Object.keys(participantsById).length >= 3 && thirdPlaceMatch) {
      pushCandidate(getResolvedMatchProfileId(thirdPlaceMatch, "winner"));
    }

    eventParticipantEntries(participantsById)
      .map(([, value]) => value)
      .filter(
        (participant) =>
          !isEventPrizeParticipantDisqualified(
            participant,
            disqualifiedIdentityKeys,
          ),
      )
      .sort((left, right) => {
        const leftRound = Number.isFinite(
          eventParticipantState(left).eliminatedRoundIndex,
        )
          ? Math.floor(
              eventParticipantState(left).eliminatedRoundIndex as number,
            )
          : -1;
        const rightRound = Number.isFinite(
          eventParticipantState(right).eliminatedRoundIndex,
        )
          ? Math.floor(
              eventParticipantState(right).eliminatedRoundIndex as number,
            )
          : -1;
        if (leftRound !== rightRound) {
          return rightRound - leftRound;
        }
        const joinedDifference =
          eventParticipantJoinedOrder(left, 0) -
          eventParticipantJoinedOrder(right, 0);
        if (joinedDifference !== 0) {
          return joinedDifference;
        }
        return normalizeString(
          eventParticipantState(left).profileId,
        ).localeCompare(
          normalizeString(eventParticipantState(right).profileId),
        );
      })
      .forEach((participant) =>
        pushCandidate(eventParticipantState(participant).profileId),
      );

    if (placementCandidates[0]) {
      placements.push({ place: 2, profileId: placementCandidates[0] });
    }
    if (placementCandidates[1] && Object.keys(participantsById).length >= 3) {
      placements.push({ place: 3, profileId: placementCandidates[1] });
    }
    return placements;
  };

  const hasCompleteEventPrizeAssignments = (
    assignments: Record<string, EventPrizeAssignmentRecord>,
    placementCount: number,
    eventId: string,
  ) => {
    const expectedCount = Math.min(
      getEventPrizeDefinitions(eventId).length,
      placementCount,
    );
    if (expectedCount <= 0) {
      return false;
    }
    for (let place = 1; place <= expectedCount; place += 1) {
      if (!assignments[String(place)]) {
        return false;
      }
    }
    return Object.keys(assignments).length === expectedCount;
  };

  const getProjectableEventPrizeAssignments = async ({
    event,
    eventId,
    assignments,
    ownershipSnapshot,
  }: PrizeProjectionInput) => {
    const projectableAssignments = filterProjectableEventPrizeAssignments({
      eventId,
      assignments,
      withdrawals: await readEventPrizeWithdrawals(eventId),
    });
    const canonicalAssignments: Record<string, EventPrizeAssignmentRecord> = {};
    const canonicalProfileIds = new Set<string>();
    for (const [place, assignment] of Object.entries(projectableAssignments)) {
      if (!ownershipSnapshot) throw profileOwnershipUnavailable();
      const sourceProfileId = normalizeString(assignment?.profileId);
      const canonicalProfileId = normalizeString(
        resolvePrizeProjectionOwnerId({
          event,
          profileId: sourceProfileId,
          snapshot: ownershipSnapshot,
        }),
      );
      if (!canonicalProfileId) {
        continue;
      }
      if (canonicalProfileIds.has(canonicalProfileId)) {
        throw new Error("profile-event-prize-conflict");
      }
      canonicalProfileIds.add(canonicalProfileId);
      canonicalAssignments[place] =
        canonicalProfileId === sourceProfileId
          ? assignment
          : { ...assignment, profileId: canonicalProfileId };
    }
    return canonicalAssignments;
  };

  const assignmentsMatch = (
    current: EventPrizeAssignmentRecord | null | undefined,
    assignment: EventPrizeAssignmentRecord | null | undefined,
  ) =>
    current?.eventId === assignment?.eventId &&
    current?.profileId === assignment?.profileId &&
    Number(current?.place) === Number(assignment?.place) &&
    current?.prizeId === assignment?.prizeId &&
    Number(current?.assignedAtMs) === Number(assignment?.assignedAtMs);

  const addEventPrizeAssignmentUpdates = async ({
    updates,
    eventId,
    assignments,
    includeEventAssignments,
  }: {
    updates: EventCommitPlan;
    eventId: string;
    assignments: Record<string, EventPrizeAssignmentRecord>;
    includeEventAssignments: boolean;
  }) => {
    if (includeEventAssignments) {
      updates.push(eventField(eventId, "prizeAssignments", assignments));
    }
  };

  const reconcileProfileEventPrizeAssignments = async ({
    event,
    eventId,
    assignments,
    ownershipSnapshot,
  }: PrizeProjectionInput) => {
    const projectableAssignments = await getProjectableEventPrizeAssignments({
      event,
      eventId,
      assignments,
      ownershipSnapshot,
    });
    const transactions = await Promise.all(
      Object.values(projectableAssignments).map(async (assignment) => {
        return state!.transactProfileEventPrize(
          assignment.profileId,
          eventId,
          (current) => {
            if (current === null || current === undefined) {
              return { value: assignment };
            }
            if (assignmentsMatch(current, assignment)) {
              return { commit: false };
            }
            throw new Error("profile-event-prize-conflict");
          },
        );
      }),
    );
    return {
      didChange: transactions.some((transaction) => transaction.committed),
    };
  };

  const removeCompletedEventPrizeProjections = async ({
    event,
    eventId,
    assignments,
    ownershipSnapshot,
  }: PrizeProjectionInput) => {
    const withdrawals = await readEventPrizeWithdrawals(eventId);
    await Promise.all(
      Object.values(assignments || {}).map(async (assignment) => {
        if (
          !isCompletedEventPrizeWithdrawal(
            withdrawals[assignment.prizeId],
            eventId,
            assignment.prizeId,
          )
        ) {
          return;
        }
        if (!ownershipSnapshot) throw profileOwnershipUnavailable();
        const canonicalProfileId = normalizeString(
          resolvePrizeProjectionOwnerId({
            event,
            profileId: normalizeString(assignment.profileId),
            snapshot: ownershipSnapshot,
          }),
        );
        const profileIds = Array.from(
          new Set(
            [normalizeString(assignment.profileId), canonicalProfileId].filter(
              Boolean,
            ),
          ),
        );
        await Promise.all(
          profileIds.map((profileId) =>
            state!.transactProfileEventPrize(
              profileId,
              eventId,
              (currentAssignment) =>
                isMatchingProfileEventPrizeAssignment(
                  currentAssignment,
                  eventId,
                  assignment.prizeId,
                )
                  ? { value: null }
                  : { commit: false },
            ),
          ),
        );
      }),
    );
  };

  const resolveEventPrizeAssignments = async ({
    eventId,
    event,
    rounds,
    participantsById,
    thirdPlaceMatch,
    assignedAtMs,
    ownershipSnapshot,
    prizeSelections,
  }: EventPrizePlacementsInput & {
    eventId: string;
    assignedAtMs: number;
    ownershipSnapshot: EventOwnershipSnapshot | null;
    prizeSelections?: Record<string, string> | null;
  }) => {
    const placements = getEventPrizePlacements({
      event,
      rounds,
      participantsById,
      thirdPlaceMatch,
    });
    const storedAssignments = eventPrizeAssignments(event, eventId);
    if (
      hasCompleteEventPrizeAssignments(
        storedAssignments,
        placements.length,
        eventId,
      )
    ) {
      return { assignments: storedAssignments, didCreate: false };
    }
    const canonical = canonicalizePrizePlacementsAndSelections(
      placements,
      prizeSelections,
      participantsById,
      ownershipSnapshot,
    );
    return {
      assignments: buildEventPrizeAssignments({
        eventId,
        placements: canonical.placements,
        selections: canonical.selections,
        assignedAtMs,
      }),
      didCreate: true,
    };
  };

  const getRoundMatchRead = (matchRecord: EventMatch | null) => {
    if (!matchRecord || typeof matchRecord !== "object") return null;
    if (
      ["bye", "host", "guest"].includes(
        normalizeString(eventMatchState(matchRecord).status),
      )
    ) {
      return null;
    }
    const playerId = normalizeString(eventMatchState(matchRecord).hostLoginUid);
    const opponentId = normalizeString(
      eventMatchState(matchRecord).guestLoginUid,
    );
    const inviteId = normalizeString(eventMatchState(matchRecord).inviteId);
    return playerId && opponentId && inviteId
      ? { inviteId, matchId: inviteId, playerId, opponentId }
      : null;
  };

  const resolveRoundMatchState = async (
    matchRecord: EventMatch | null,
    matchPair?: [unknown, unknown],
  ): Promise<MatchResolution | null> => {
    if (!matchRecord || typeof matchRecord !== "object") {
      return null;
    }

    const existingStatus = normalizeString(eventMatchState(matchRecord).status);
    if (existingStatus === "bye") {
      const winnerProfileId = normalizeString(
        eventMatchState(matchRecord).winnerProfileId,
      );
      if (!winnerProfileId) {
        return null;
      }
      return {
        status: "bye",
        winnerProfileId,
        loserProfileId: null,
      };
    }

    if (existingStatus === "host" || existingStatus === "guest") {
      const winnerProfileId =
        normalizeString(eventMatchState(matchRecord).winnerProfileId) ||
        (existingStatus === "host"
          ? normalizeString(eventMatchState(matchRecord).hostProfileId)
          : normalizeString(eventMatchState(matchRecord).guestProfileId));
      const loserProfileId =
        normalizeString(eventMatchState(matchRecord).loserProfileId) ||
        (existingStatus === "host"
          ? normalizeString(eventMatchState(matchRecord).guestProfileId)
          : normalizeString(eventMatchState(matchRecord).hostProfileId));
      if (!winnerProfileId) {
        return null;
      }
      return {
        status: existingStatus,
        winnerProfileId,
        loserProfileId: loserProfileId || null,
      };
    }

    const input = getRoundMatchRead(matchRecord);
    if (!input) {
      return null;
    }

    const [hostMatch, guestMatch] =
      matchPair || (await dependencies.readMatchPair!(input));
    const outcome = await resolveMatchWinner(hostMatch, guestMatch);
    if (outcome.winner === "player") {
      return {
        status: "host",
        winnerProfileId: normalizeString(
          eventMatchState(matchRecord).hostProfileId,
        ),
        loserProfileId: normalizeStringOrNull(
          eventMatchState(matchRecord).guestProfileId,
        ),
      };
    }
    if (outcome.winner === "opponent") {
      return {
        status: "guest",
        winnerProfileId: normalizeString(
          eventMatchState(matchRecord).guestProfileId,
        ),
        loserProfileId: normalizeStringOrNull(
          eventMatchState(matchRecord).hostProfileId,
        ),
      };
    }
    return null;
  };

  const resolveRoundMatchesWithConcurrency = async (
    matchesByKey: EventMatchesDocument,
  ) => {
    const entries = eventMatchEntries(matchesByKey);
    if (entries.length <= 0) {
      return [];
    }

    const reads = entries.flatMap(([, matchRecord], index) => {
      const input = getRoundMatchRead(matchRecord);
      return input ? [{ index, input }] : [];
    });
    const pairsByIndex = new Map<number, [unknown, unknown]>();
    if (reads.length) {
      const pairs = await dependencies.readMatchPairs!(
        reads.map(({ input }) => input),
      );
      if (
        !Array.isArray(pairs) ||
        pairs.length !== reads.length ||
        reads.some(
          (_, index) =>
            !Array.isArray(pairs[index]) || pairs[index].length !== 2,
        )
      ) {
        throw new Error("event-match-batch-invalid");
      }
      reads.forEach(({ index }, offset) =>
        pairsByIndex.set(index, pairs[offset]),
      );
    }

    const results = new Array<{
      matchKey: string;
      matchRecord: EventMatch | null;
      resolved: MatchResolution | null;
    }>(entries.length);
    const concurrency = Math.max(
      1,
      Math.min(EVENT_MATCH_RESOLVE_CONCURRENCY, entries.length),
    );
    let nextIndex = 0;

    const worker = async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= entries.length) {
          return;
        }
        const [matchKey, matchRecord] = entries[index];
        const resolved = await resolveRoundMatchState(
          matchRecord,
          pairsByIndex.get(index),
        );
        results[index] = {
          matchKey,
          matchRecord,
          resolved,
        };
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
  };

  return {
    addEventPrizeAssignmentUpdates,
    applyMatchResolution,
    assignWinnerToNextRound,
    buildFixedBracketState: (
      input: Omit<FixedBracketInput, "buildRandomGameSeed">,
    ) => buildFixedBracketStateCore({ ...input, buildRandomGameSeed }),
    buildScheduledEventDueUpdates: (
      input: { eventId: string; event: EventData; nowMs: number } & Omit<
        EventStartTransitionDependencies,
        "buildRandomGameSeed"
      >,
    ) =>
      buildScheduledEventDueUpdatesCore({
        ...input,
        buildRandomGameSeed,
      }),
    buildSeedToProfileId,
    createEmptyEventMatch,
    getEventPrizePlacements,
    getSortedMatchKeys,
    getSortedRoundIndexes,
    hasThirdPlaceMatchField,
    isMatchResolved,
    isMatchSlotBlocked,
    isMatchWinnerDisqualified,
    rebuildParticipantStatesFromRounds,
    recomputeRoundStatuses,
    reconcileBracketMatchReadiness,
    reconcileProfileEventPrizeAssignments,
    reconcileThirdPlaceMatchReadiness,
    removeCompletedEventPrizeProjections,
    resolveEventPrizeAssignments,
    resolveRoundMatchState,
    resolveRoundMatchesWithConcurrency,
    setMatchSlotBlocked,
    setMatchSlotParticipant,
  };
};

const defaultRuntime = createEventBracketRuntime();

export type EventBracketRuntime = ReturnType<typeof createEventBracketRuntime>;
export const {
  addEventPrizeAssignmentUpdates,
  buildFixedBracketState,
  buildScheduledEventDueUpdates,
  getEventPrizePlacements,
  rebuildParticipantStatesFromRounds,
  reconcileBracketMatchReadiness,
  reconcileProfileEventPrizeAssignments,
  reconcileThirdPlaceMatchReadiness,
  removeCompletedEventPrizeProjections,
  resolveEventPrizeAssignments,
  resolveRoundMatchState,
  resolveRoundMatchesWithConcurrency,
} = defaultRuntime;
export {
  createEventBracketRuntime,
  applyMatchResolution,
  assignWinnerToNextRound,
  buildSeedToProfileId,
  createEmptyEventMatch,
  getSortedMatchKeys,
  getSortedRoundIndexes,
  hasThirdPlaceMatchField,
  isMatchResolved,
  isMatchSlotBlocked,
  isMatchWinnerDisqualified,
  recomputeRoundStatuses,
  setMatchSlotBlocked,
  setMatchSlotParticipant,
};
