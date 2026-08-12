import type {
  EventMatch,
  EventParticipant,
  EventRecord,
  EventRound,
} from "../../connection/connectionModels";
import { emojis } from "../../content/emojis";
import {
  MAX_EVENT_PARTICIPANTS,
  buildEventMatchKey,
  buildEventSeedOrder,
  getEventBracketSize,
} from "@mons/shared/events";
import { shuffle } from "@mons/shared/ids";

export const DEV_STUB_MIN_PLAYERS = 2;
export const DEV_STUB_MAX_PLAYERS = MAX_EVENT_PARTICIPANTS;
export const DEV_STUB_DEFAULT_PLAYERS = 8;
export const DEV_STUB_NAME_LENGTH = 9;
export const DEV_STUB_NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz";

export const clampDevStubPlayerCount = (value: number): number => {
  if (!Number.isFinite(value)) {
    return DEV_STUB_MIN_PLAYERS;
  }
  return Math.min(
    DEV_STUB_MAX_PLAYERS,
    Math.max(DEV_STUB_MIN_PLAYERS, Math.round(value)),
  );
};

export const createRandomStubName = (): string => {
  let name = "";
  for (let index = 0; index < DEV_STUB_NAME_LENGTH; index += 1) {
    const letterIndex = Math.floor(
      Math.random() * DEV_STUB_NAME_ALPHABET.length,
    );
    name += DEV_STUB_NAME_ALPHABET[letterIndex];
  }
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
};

export const createStubParticipants = (
  playerCount: number,
  nowMs: number,
): EventParticipant[] => {
  const displayNames = new Set<string>();
  while (displayNames.size < playerCount) {
    displayNames.add(createRandomStubName());
  }

  return shuffle(
    Array.from(displayNames, (displayName, index) => {
      const profileId = `dev_stub_profile_${index + 1}`;
      const [emojiIdString] = emojis.getRandomEmojiUrl(true);
      const emojiId = Number(emojiIdString);
      return {
        profileId,
        loginUid: `dev_stub_login_${index + 1}`,
        username: displayName.toLowerCase(),
        displayName,
        emojiId: Number.isFinite(emojiId) ? emojiId : 1,
        aura: "",
        joinedAtMs: nowMs - (playerCount - index) * 3000,
        state: "active",
        eliminatedRoundIndex: null,
        eliminatedByProfileId: null,
      } satisfies EventParticipant;
    }),
  );
};

export const createStubEventRecord = ({
  source,
  playerCount,
  fallbackEventId,
}: {
  source: EventRecord | null;
  playerCount: number;
  fallbackEventId?: string | null;
}): EventRecord => {
  const normalizedPlayerCount = clampDevStubPlayerCount(playerCount);
  const bracketSize = getEventBracketSize(normalizedPlayerCount);
  const roundCount = Math.max(1, Math.round(Math.log2(bracketSize)));
  const nowMs = Date.now();
  const participants = createStubParticipants(normalizedPlayerCount, nowMs);
  const participantsById: Record<string, EventParticipant> = {};
  for (const participant of participants) {
    participantsById[participant.profileId] = participant;
  }
  const sourceCreator = participants[0] ?? null;
  const sourceEventId = source?.eventId?.trim();

  if (source?.status === "scheduled") {
    const scheduledStartAtMs =
      typeof source.startAtMs === "number" && source.startAtMs > nowMs
        ? source.startAtMs
        : nowMs + 15 * 60_000;
    return {
      schemaVersion: source?.schemaVersion ?? 1,
      eventId: sourceEventId || fallbackEventId?.trim() || "dev_stub_event",
      status: "scheduled",
      createdAtMs: source?.createdAtMs ?? nowMs - 60_000,
      updatedAtMs: nowMs,
      startAtMs: scheduledStartAtMs,
      startedAtMs: null,
      endedAtMs: null,
      createdByProfileId:
        source?.createdByProfileId ?? sourceCreator?.profileId ?? "dev_stub",
      createdByLoginUid:
        source?.createdByLoginUid ?? sourceCreator?.loginUid ?? "dev_stub",
      createdByUsername:
        source?.createdByUsername ?? sourceCreator?.username ?? "dev_stub",
      winnerProfileId: null,
      winnerDisplayName: null,
      currentRoundIndex: null,
      bracketSize,
      roundCount: 0,
      participants: participantsById,
      rounds: {},
    };
  }

  const seedOrder = buildEventSeedOrder(bracketSize);
  const seedToSlotIndex = new Map<number, number>();
  seedOrder.forEach((seed, slotIndex) => {
    seedToSlotIndex.set(seed, slotIndex);
  });

  let roundEntrants: Array<EventParticipant | null> = Array.from(
    { length: bracketSize },
    () => null,
  );
  for (let seed = 1; seed <= normalizedPlayerCount; seed += 1) {
    const slotIndex = seedToSlotIndex.get(seed);
    const participant = participants[seed - 1];
    if (slotIndex === undefined || !participant) {
      continue;
    }
    roundEntrants[slotIndex] = participant;
  }

  const eliminationsByProfileId: Record<
    string,
    { eliminatedRoundIndex: number; eliminatedByProfileId: string | null }
  > = {};
  const rounds: Record<string, EventRound> = {};

  for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
    const matchCount = Math.max(1, Math.floor(roundEntrants.length / 2));
    const nextRoundEntrants: Array<EventParticipant | null> = Array.from(
      { length: matchCount },
      () => null,
    );
    const matches: Record<string, EventMatch> = {};

    for (let matchIndex = 0; matchIndex < matchCount; matchIndex += 1) {
      const host = roundEntrants[matchIndex * 2] ?? null;
      const guest = roundEntrants[matchIndex * 2 + 1] ?? null;
      const matchKey = buildEventMatchKey(roundIndex, matchIndex);
      let status: EventMatch["status"] = "upcoming";
      let winner: EventParticipant | null = null;
      let loser: EventParticipant | null = null;

      if (host && guest) {
        const hostWon = Math.random() >= 0.5;
        winner = hostWon ? host : guest;
        loser = hostWon ? guest : host;
        status = hostWon ? "host" : "guest";
      } else if (host || guest) {
        winner = host ?? guest;
        status = "bye";
      }

      nextRoundEntrants[matchIndex] = winner;
      if (winner && loser) {
        eliminationsByProfileId[loser.profileId] = {
          eliminatedRoundIndex: roundIndex,
          eliminatedByProfileId: winner.profileId,
        };
      }

      const resolvedAtMs =
        winner !== null
          ? nowMs - (roundCount - roundIndex) * 60_000 - matchIndex * 250
          : null;

      matches[matchKey] = {
        matchKey,
        inviteId: null,
        status,
        resolvedAtMs,
        winnerDisqualified: false,
        winnerProfileId: winner?.profileId ?? null,
        loserProfileId: loser?.profileId ?? null,
        hostSlotBlocked: false,
        hostProfileId: host?.profileId ?? null,
        hostLoginUid: host?.loginUid ?? null,
        hostDisplayName: host?.displayName ?? null,
        hostEmojiId: host?.emojiId ?? null,
        hostAura: host?.aura ?? null,
        guestSlotBlocked: false,
        guestProfileId: guest?.profileId ?? null,
        guestLoginUid: guest?.loginUid ?? null,
        guestDisplayName: guest?.displayName ?? null,
        guestEmojiId: guest?.emojiId ?? null,
        guestAura: guest?.aura ?? null,
      };
    }

    rounds[String(roundIndex)] = {
      roundIndex,
      status: "completed",
      createdAtMs: nowMs - (roundCount - roundIndex + 1) * 60_000,
      completedAtMs: nowMs - (roundCount - roundIndex) * 60_000,
      matches,
    };
    roundEntrants = nextRoundEntrants;
  }

  const winner = roundEntrants[0] ?? participants[0] ?? null;
  for (const participant of participants) {
    const elimination = eliminationsByProfileId[participant.profileId];
    if (winner && participant.profileId === winner.profileId) {
      participantsById[participant.profileId] = {
        ...participant,
        state: "winner",
        eliminatedRoundIndex: null,
        eliminatedByProfileId: null,
      };
      continue;
    }
    participantsById[participant.profileId] = {
      ...participant,
      state: "eliminated",
      eliminatedRoundIndex:
        elimination?.eliminatedRoundIndex ?? Math.max(0, roundCount - 1),
      eliminatedByProfileId:
        elimination?.eliminatedByProfileId ?? winner?.profileId ?? null,
    };
  }

  return {
    schemaVersion: source?.schemaVersion ?? 1,
    eventId: sourceEventId || fallbackEventId?.trim() || "dev_stub_event",
    status: "ended",
    createdAtMs: source?.createdAtMs ?? nowMs - (roundCount + 3) * 60_000,
    updatedAtMs: nowMs,
    startAtMs: source?.startAtMs ?? nowMs - (roundCount + 2) * 60_000,
    startedAtMs: source?.startedAtMs ?? nowMs - (roundCount + 2) * 60_000,
    endedAtMs: nowMs - 10_000,
    createdByProfileId:
      source?.createdByProfileId ??
      sourceCreator?.profileId ??
      winner?.profileId ??
      "dev_stub",
    createdByLoginUid:
      source?.createdByLoginUid ??
      sourceCreator?.loginUid ??
      winner?.loginUid ??
      "dev_stub",
    createdByUsername:
      source?.createdByUsername ??
      sourceCreator?.username ??
      winner?.username ??
      "dev_stub",
    winnerProfileId: winner?.profileId ?? null,
    winnerDisplayName: winner?.displayName ?? null,
    currentRoundIndex: Math.max(0, roundCount - 1),
    bracketSize,
    roundCount,
    participants: participantsById,
    rounds,
  };
};
