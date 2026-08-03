const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onValueWritten } = require("firebase-functions/v2/database");
const { onTaskDispatched } = require("firebase-functions/v2/tasks");
const admin = require("./firebaseAdmin");
const {
  getProfileByLoginId,
  getDisplayNameFromAddress,
  batchReadWithRetry,
} = require("./utils");
const { resolveMatchWinner } = require("./matchOutcome");
const { enqueueEventProgressTask } = require("./eventProgressTasks");
const {
  EVENT_PRIZE_IDS,
  PRIZES_EVENT_ID,
  buildEventPrizeAssignments,
  normalizeEventPrizeAssignments,
} = require("./eventPrizeAwards");
const {
  filterProjectableEventPrizeAssignments,
  getCompletedEventPrizeProjectionCleanupRequest,
  isCompletedEventPrizeWithdrawal,
  isMatchingProfileEventPrizeAssignment,
} = require("./eventPrizeWithdrawalState");
const { buildRandomGameSeed } = require("./gameVariants");
const {
  buildAutoInviteId,
  INVITE_ID_RANDOM_LENGTH,
  pickHostColor,
  randomAlphanumeric,
  shuffle,
} = require("@mons/shared/ids");
const {
  CONTROLLER_VERSION,
  buildFreshMatchRecord,
} = require("@mons/shared/match-protocol");
const {
  EVENT_POSTPONE_OPTIONS_MINUTES,
  EVENT_SCHEMA_VERSION,
  MAX_EVENT_PARTICIPANTS,
  MAX_STARTS_IN_DAYS,
  MAX_STARTS_IN_MINUTES,
  MIN_STARTS_IN_MINUTES,
  SCHEDULED_TIMEZONE_LOCAL,
  THIRD_PLACE_MATCH_KEY,
  buildEventMatchKey: getMatchKey,
  buildEventSeedOrder: buildSeedOrder,
  getEventBracketSize: getBracketSize,
  getFirstRoundByeSeeds,
  isMonsLinkAdmin,
  parseEventMatchKey: parseMatchKey,
} = require("@mons/shared/events");

const EVENT_LOCK_TTL_MS = 30 * 1000;
const EVENT_LOCK_REFRESH_INTERVAL_MS = 10 * 1000;
const EVENT_MATCH_RESOLVE_CONCURRENCY = 4;
const EVENT_SYNC_THROTTLE_WINDOW_MS = 500;
const MIN_START_AHEAD_MS = MIN_STARTS_IN_MINUTES * 60 * 1000;
const MAX_START_AHEAD_MS = MAX_STARTS_IN_MINUTES * 60 * 1000;
const SCHEDULED_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SCHEDULED_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const PRESET_EVENT_TIMEZONE_BY_KEY = {
  ET: "America/New_York",
  PT: "America/Los_Angeles",
  CT: "America/Chicago",
};
const ZONED_WALL_TIME_SEARCH_WINDOW_MS = 18 * 60 * 60 * 1000;
const ZONED_WALL_TIME_SEARCH_STEP_MS = 60 * 1000;
const EVENT_PROGRESS_WORKER_UID = "event-progress-worker";

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";
const normalizeStringOrNull = (value) => normalizeString(value) || null;
const normalizeUsername = (value) => normalizeString(value).toLowerCase();
const getNowMs = () => Date.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toFiniteInteger = (value, fallback = 0) => {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.floor(numeric);
};

const zonedDateTimeFormatterByTimezone = new Map();

const getZonedDateTimeFormatter = (timeZone) => {
  const normalizedTimeZone = normalizeString(timeZone);
  if (!normalizedTimeZone) {
    throw new Error("timeZone is required");
  }
  if (zonedDateTimeFormatterByTimezone.has(normalizedTimeZone)) {
    return zonedDateTimeFormatterByTimezone.get(normalizedTimeZone);
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizedTimeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  zonedDateTimeFormatterByTimezone.set(normalizedTimeZone, formatter);
  return formatter;
};

const getZonedDateTimeParts = (timestampMs, timeZone) => {
  const formatter = getZonedDateTimeFormatter(timeZone);
  const parts = formatter.formatToParts(new Date(timestampMs));
  let year = NaN;
  let month = NaN;
  let day = NaN;
  let hour = NaN;
  let minute = NaN;
  for (const part of parts) {
    if (part.type === "year") {
      year = toFiniteInteger(part.value, NaN);
    } else if (part.type === "month") {
      month = toFiniteInteger(part.value, NaN);
    } else if (part.type === "day") {
      day = toFiniteInteger(part.value, NaN);
    } else if (part.type === "hour") {
      hour = toFiniteInteger(part.value, NaN);
    } else if (part.type === "minute") {
      minute = toFiniteInteger(part.value, NaN);
    }
  }
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return null;
  }
  return {
    year,
    month,
    day,
    hour,
    minute,
  };
};

const parseScheduledDateParts = (value) => {
  const normalizedValue = normalizeString(value);
  const match = normalizedValue.match(SCHEDULED_DATE_PATTERN);
  if (!match) {
    return null;
  }
  const year = toFiniteInteger(match[1], NaN);
  const month = toFiniteInteger(match[2], NaN);
  const day = toFiniteInteger(match[3], NaN);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const candidate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }
  return {
    year,
    month,
    day,
  };
};

const parseScheduledTimeParts = (value) => {
  const normalizedValue = normalizeString(value);
  const match = normalizedValue.match(SCHEDULED_TIME_PATTERN);
  if (!match) {
    return null;
  }
  const hour = toFiniteInteger(match[1], NaN);
  const minute = toFiniteInteger(match[2], NaN);
  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  return {
    hour,
    minute,
  };
};

const isValidIanaTimezone = (value) => {
  const normalizedValue = normalizeString(value);
  if (!normalizedValue) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalizedValue }).format(
      new Date(0),
    );
    return true;
  } catch {
    return false;
  }
};

const hasDateTimeScheduleRequest = (data) => {
  if (!data || typeof data !== "object") {
    return false;
  }
  return (
    normalizeString(data.scheduledDate) !== "" ||
    normalizeString(data.scheduledTime) !== "" ||
    normalizeString(data.scheduledTimezone) !== ""
  );
};

const resolveRequestedScheduleTimezone = (data) => {
  const scheduledTimezoneRaw = normalizeString(data && data.scheduledTimezone);
  if (!scheduledTimezoneRaw) {
    throw new HttpsError(
      "invalid-argument",
      "scheduledTimezone is required for date/time scheduling.",
    );
  }
  if (scheduledTimezoneRaw.toLowerCase() === SCHEDULED_TIMEZONE_LOCAL) {
    const localTimezoneIana = normalizeString(data && data.localTimezoneIana);
    if (!localTimezoneIana) {
      throw new HttpsError(
        "invalid-argument",
        "localTimezoneIana is required when scheduledTimezone is local.",
      );
    }
    if (!isValidIanaTimezone(localTimezoneIana)) {
      throw new HttpsError(
        "invalid-argument",
        "localTimezoneIana must be a valid IANA timezone.",
      );
    }
    return localTimezoneIana;
  }
  const timezoneKey = scheduledTimezoneRaw.toUpperCase();
  const resolvedTimezone = PRESET_EVENT_TIMEZONE_BY_KEY[timezoneKey];
  if (!resolvedTimezone) {
    throw new HttpsError(
      "invalid-argument",
      "scheduledTimezone must be one of: local, ET, PT, CT.",
    );
  }
  return resolvedTimezone;
};

const resolveScheduledDateTimeStartAtMs = (data, nowMs = getNowMs()) => {
  const scheduledDate = normalizeString(data && data.scheduledDate);
  if (!scheduledDate) {
    throw new HttpsError(
      "invalid-argument",
      "scheduledDate is required for date/time scheduling.",
    );
  }
  const scheduledTime = normalizeString(data && data.scheduledTime);
  if (!scheduledTime) {
    throw new HttpsError(
      "invalid-argument",
      "scheduledTime is required for date/time scheduling.",
    );
  }

  const dateParts = parseScheduledDateParts(scheduledDate);
  if (!dateParts) {
    throw new HttpsError(
      "invalid-argument",
      "scheduledDate must be in YYYY-MM-DD format.",
    );
  }
  const timeParts = parseScheduledTimeParts(scheduledTime);
  if (!timeParts) {
    throw new HttpsError(
      "invalid-argument",
      "scheduledTime must be in HH:mm 24-hour format.",
    );
  }

  const timeZone = resolveRequestedScheduleTimezone(data);
  const targetUtcApproxMs = Date.UTC(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    timeParts.hour,
    timeParts.minute,
    0,
    0,
  );
  const candidateStartMs = targetUtcApproxMs - ZONED_WALL_TIME_SEARCH_WINDOW_MS;
  const candidateEndMs = targetUtcApproxMs + ZONED_WALL_TIME_SEARCH_WINDOW_MS;
  const matchingInstants = [];

  for (
    let candidateMs = candidateStartMs;
    candidateMs <= candidateEndMs;
    candidateMs += ZONED_WALL_TIME_SEARCH_STEP_MS
  ) {
    const parts = getZonedDateTimeParts(candidateMs, timeZone);
    if (!parts) {
      continue;
    }
    if (
      parts.year === dateParts.year &&
      parts.month === dateParts.month &&
      parts.day === dateParts.day &&
      parts.hour === timeParts.hour &&
      parts.minute === timeParts.minute
    ) {
      matchingInstants.push(candidateMs);
    }
  }

  if (matchingInstants.length <= 0) {
    throw new HttpsError(
      "invalid-argument",
      "Selected date/time does not exist in the selected timezone.",
    );
  }

  const normalizedNowMs = toFiniteInteger(nowMs, NaN);
  if (Number.isFinite(normalizedNowMs)) {
    const nextFutureInstantMs = matchingInstants.find(
      (candidateMs) => candidateMs > normalizedNowMs,
    );
    if (typeof nextFutureInstantMs === "number") {
      return nextFutureInstantMs;
    }
  }

  return matchingInstants[0];
};

const assertScheduledStartWindow = (startAtMs, nowMs) => {
  const deltaMs = toFiniteInteger(startAtMs, 0) - toFiniteInteger(nowMs, 0);
  if (deltaMs < MIN_START_AHEAD_MS) {
    throw new HttpsError(
      "invalid-argument",
      `Event must start at least ${MIN_STARTS_IN_MINUTES} minute from now.`,
    );
  }
  if (deltaMs > MAX_START_AHEAD_MS) {
    throw new HttpsError(
      "invalid-argument",
      `Event must start within ${MAX_STARTS_IN_DAYS} days from now.`,
    );
  }
};

const cloneValue = (value) => JSON.parse(JSON.stringify(value));

const buildEventDisplayName = (profile) => {
  return getDisplayNameFromAddress(
    profile.username ?? "",
    profile.eth ?? "",
    profile.sol ?? "",
    0,
    profile.emoji ?? "",
    false,
  );
};

const generateEventId = () => randomAlphanumeric(INVITE_ID_RANDOM_LENGTH);
const generateEventInviteId = () => buildAutoInviteId();

const getParticipantIds = (event) => {
  const participants =
    event && event.participants && typeof event.participants === "object"
      ? event.participants
      : {};
  return Object.keys(participants).filter(
    (profileId) =>
      participants[profileId] && typeof participants[profileId] === "object",
  );
};

const resolveRequesterParticipation = (event, auth) => {
  const participants =
    event && event.participants && typeof event.participants === "object"
      ? event.participants
      : {};
  const requesterUid = normalizeString(auth && auth.uid);
  const claimedProfileId = normalizeString(
    auth && auth.token ? auth.token.profileId : "",
  );
  if (
    claimedProfileId &&
    participants[claimedProfileId] &&
    typeof participants[claimedProfileId] === "object"
  ) {
    return {
      isParticipant: true,
      profileId: claimedProfileId,
    };
  }
  for (const [profileId, participant] of Object.entries(participants)) {
    if (!participant || typeof participant !== "object") {
      continue;
    }
    if (
      claimedProfileId &&
      normalizeString(participant.profileId) === claimedProfileId
    ) {
      return {
        isParticipant: true,
        profileId,
      };
    }
    if (normalizeString(participant.loginUid) === requesterUid) {
      return {
        isParticipant: true,
        profileId,
      };
    }
  }
  if (normalizeString(event && event.createdByLoginUid) === requesterUid) {
    return {
      isParticipant: true,
      profileId: normalizeString(event && event.createdByProfileId) || null,
    };
  }
  return {
    isParticipant: false,
    profileId: null,
  };
};

const buildParticipantSnapshot = (profile, loginUid, joinedAtMs) => {
  const username = normalizeString(profile.username);
  const profileId = normalizeString(profile.profileId);
  return {
    profileId,
    loginUid,
    username,
    displayName: buildEventDisplayName(profile),
    emojiId:
      typeof profile.emoji === "number"
        ? Math.floor(profile.emoji)
        : Number(profile.emoji) || 0,
    aura: normalizeString(profile.aura),
    joinedAtMs,
    state: "active",
    eliminatedRoundIndex: null,
    eliminatedByProfileId: null,
  };
};

const ensurePilotEventCreator = async (uid) => {
  const profile = await getProfileByLoginId(uid);
  const username = normalizeUsername(profile.username);
  const profileId = normalizeString(profile.profileId);
  if (!profileId) {
    throw new HttpsError(
      "failed-precondition",
      "Event creation requires a signed-in profile.",
    );
  }
  if (!isMonsLinkAdmin(username)) {
    throw new HttpsError(
      "permission-denied",
      "Only approved pilot users can create pilot events.",
    );
  }
  return profile;
};

const ensureNonAnonProfile = async (uid) => {
  const profile = await getProfileByLoginId(uid);
  const profileId = normalizeString(profile.profileId);
  if (!profileId) {
    throw new HttpsError(
      "failed-precondition",
      "Please sign in to join this event.",
    );
  }
  return profile;
};

const createMatchRecord = (color, emojiId, aura, gameSeed) =>
  buildFreshMatchRecord({
    color,
    emojiId: typeof emojiId === "number" ? Math.floor(emojiId) : 0,
    aura: normalizeString(aura) || null,
    seed: gameSeed,
  });

const getMatchIndexFromKey = (matchKey) =>
  parseMatchKey(matchKey)?.matchIndex ?? 0;
const getSortedMatchKeys = (matchesByKey) =>
  Object.keys(matchesByKey || {}).sort(
    (left, right) => getMatchIndexFromKey(left) - getMatchIndexFromKey(right),
  );
const getSortedRoundIndexes = (roundsByKey) => {
  return Array.from(
    new Set(
      Object.keys(roundsByKey || {})
        .map((roundKey) => toFiniteInteger(roundKey, NaN))
        .filter(
          (roundIndex) =>
            Number.isFinite(roundIndex) && Math.floor(roundIndex) >= 0,
        )
        .map((roundIndex) => Math.floor(roundIndex)),
    ),
  ).sort((left, right) => left - right);
};
const isResolvedMatchStatus = (status) =>
  status === "host" || status === "guest" || status === "bye";
const isMatchResolved = (match) => {
  if (isMatchWinnerDisqualified(match)) {
    return true;
  }
  const status = normalizeString(match && match.status);
  if (status === "bye") {
    return true;
  }
  return (
    (status === "host" || status === "guest") &&
    normalizeString(match && match.winnerProfileId) !== ""
  );
};
const isMatchWinnerDisqualified = (match) =>
  !!(match && match.winnerDisqualified === true);
const isMatchSlotBlocked = (match, slot) => {
  if (!match) {
    return false;
  }
  return slot === "guest"
    ? match.guestSlotBlocked === true
    : match.hostSlotBlocked === true;
};

const buildSeedToProfileId = ({
  participantIds,
  participantsById,
  bracketSize,
  seedOrder,
}) => {
  const participantCount = participantIds.length;
  const adminParticipantIds = [];
  const nonAdminParticipantIds = [];

  for (const profileId of participantIds) {
    const participant = participantsById[profileId];
    const username = normalizeUsername(participant && participant.username);
    if (isMonsLinkAdmin(username)) {
      adminParticipantIds.push(profileId);
    } else {
      nonAdminParticipantIds.push(profileId);
    }
  }

  const shuffledAdminParticipantIds = shuffle(adminParticipantIds);
  const shuffledNonAdminParticipantIds = shuffle(nonAdminParticipantIds);
  const byeSeeds = shuffle(
    getFirstRoundByeSeeds(participantCount, bracketSize, seedOrder),
  );
  const seedToProfileId = new Map();

  while (byeSeeds.length > 0 && shuffledAdminParticipantIds.length > 0) {
    const byeSeed = byeSeeds.pop();
    const profileId = shuffledAdminParticipantIds.pop();
    if (!byeSeed || !profileId) {
      break;
    }
    seedToProfileId.set(byeSeed, profileId);
  }

  const remainingProfileIds = shuffle([
    ...shuffledAdminParticipantIds,
    ...shuffledNonAdminParticipantIds,
  ]);
  let remainingIndex = 0;
  for (let seed = 1; seed <= participantCount; seed += 1) {
    if (seedToProfileId.has(seed)) {
      continue;
    }
    const profileId = remainingProfileIds[remainingIndex];
    remainingIndex += 1;
    if (!profileId) {
      break;
    }
    seedToProfileId.set(seed, profileId);
  }

  return seedToProfileId;
};

const createEmptyEventMatch = (matchKey) => ({
  matchKey,
  inviteId: null,
  status: "upcoming",
  resolvedAtMs: null,
  winnerDisqualified: false,
  winnerProfileId: null,
  loserProfileId: null,
  hostSlotBlocked: false,
  hostProfileId: null,
  hostLoginUid: null,
  hostDisplayName: null,
  hostEmojiId: null,
  hostAura: null,
  guestSlotBlocked: false,
  guestProfileId: null,
  guestLoginUid: null,
  guestDisplayName: null,
  guestEmojiId: null,
  guestAura: null,
});

const hasThirdPlaceMatchField = (event) =>
  !!(
    event &&
    typeof event === "object" &&
    (event.supportsThirdPlaceMatch === true ||
      (event.thirdPlaceMatch && typeof event.thirdPlaceMatch === "object"))
  );

const setMatchSlotBlocked = (match, slot, blocked) => {
  const field = slot === "guest" ? "guestSlotBlocked" : "hostSlotBlocked";
  const nextValue = blocked === true;
  if (match[field] === nextValue) {
    return false;
  }
  match[field] = nextValue;
  return true;
};

const setMatchSlotParticipant = (match, slot, participant) => {
  const prefix = slot === "guest" ? "guest" : "host";
  const nextProfileId = participant ? participant.profileId : null;
  const nextLoginUid = participant ? participant.loginUid : null;
  const nextDisplayName = participant ? participant.displayName : null;
  const nextEmojiId = participant ? participant.emojiId : null;
  const nextAura = participant ? participant.aura || null : null;
  let didChange = false;

  if (match[`${prefix}ProfileId`] !== nextProfileId) {
    match[`${prefix}ProfileId`] = nextProfileId;
    didChange = true;
  }
  if (match[`${prefix}LoginUid`] !== nextLoginUid) {
    match[`${prefix}LoginUid`] = nextLoginUid;
    didChange = true;
  }
  if (match[`${prefix}DisplayName`] !== nextDisplayName) {
    match[`${prefix}DisplayName`] = nextDisplayName;
    didChange = true;
  }
  if (match[`${prefix}EmojiId`] !== nextEmojiId) {
    match[`${prefix}EmojiId`] = nextEmojiId;
    didChange = true;
  }
  if (match[`${prefix}Aura`] !== nextAura) {
    match[`${prefix}Aura`] = nextAura;
    didChange = true;
  }
  if (participant && setMatchSlotBlocked(match, slot, false)) {
    didChange = true;
  }

  return didChange;
};

const applyMatchResolution = (match, resolved, nowMs) => {
  if (!match || !resolved) {
    return false;
  }
  let didChange = false;

  if (match.status !== resolved.status) {
    match.status = resolved.status;
    didChange = true;
  }
  if (
    normalizeStringOrNull(match.winnerProfileId) !== resolved.winnerProfileId
  ) {
    match.winnerProfileId = resolved.winnerProfileId;
    didChange = true;
  }
  if (normalizeStringOrNull(match.loserProfileId) !== resolved.loserProfileId) {
    match.loserProfileId = resolved.loserProfileId;
    didChange = true;
  }
  if (typeof match.resolvedAtMs !== "number") {
    match.resolvedAtMs = nowMs;
    didChange = true;
  }

  return didChange;
};

const assignWinnerToNextRound = ({
  rounds,
  roundIndex,
  matchIndex,
  winnerProfileId,
  participantsById,
  winnerDisqualified = false,
}) => {
  const nextRound = rounds[String(roundIndex + 1)];
  if (
    !nextRound ||
    !nextRound.matches ||
    typeof nextRound.matches !== "object"
  ) {
    return false;
  }

  const nextMatchIndex = Math.floor(matchIndex / 2);
  const nextMatchKey = getMatchKey(roundIndex + 1, nextMatchIndex);
  const nextMatch = nextRound.matches[nextMatchKey];
  if (!nextMatch) {
    return false;
  }

  const slot = matchIndex % 2 === 0 ? "host" : "guest";
  if (winnerDisqualified) {
    const didClearParticipant = setMatchSlotParticipant(nextMatch, slot, null);
    const didSetBlocked = setMatchSlotBlocked(nextMatch, slot, true);
    return didClearParticipant || didSetBlocked;
  }

  const normalizedWinnerProfileId = normalizeString(winnerProfileId);
  if (!normalizedWinnerProfileId) {
    const didClearParticipant = setMatchSlotParticipant(nextMatch, slot, null);
    const didClearBlocked = setMatchSlotBlocked(nextMatch, slot, false);
    return didClearParticipant || didClearBlocked;
  }

  const didSetParticipant = setMatchSlotParticipant(
    nextMatch,
    slot,
    participantsById[normalizedWinnerProfileId] || null,
  );
  const didClearBlocked = setMatchSlotBlocked(nextMatch, slot, false);
  return didSetParticipant || didClearBlocked;
};

const createInviteForMatch = async ({
  eventId,
  roundIndex,
  matchKey,
  match,
  inviteUpdates,
}) => {
  if (isMatchSlotBlocked(match, "host") || isMatchSlotBlocked(match, "guest")) {
    return false;
  }
  const hostLoginUid = normalizeString(match.hostLoginUid);
  const guestLoginUid = normalizeString(match.guestLoginUid);
  if (!hostLoginUid || !guestLoginUid || normalizeString(match.inviteId)) {
    return false;
  }

  const inviteId = generateEventInviteId();
  const hostColor = pickHostColor();
  const guestColor = hostColor === "white" ? "black" : "white";
  const gameSeed = await buildRandomGameSeed();

  match.inviteId = inviteId;
  match.status = "pending";

  inviteUpdates[`invites/${inviteId}`] = {
    version: CONTROLLER_VERSION,
    hostId: hostLoginUid,
    hostColor,
    guestId: guestLoginUid,
    eventId,
    eventRoundIndex: roundIndex,
    eventMatchKey: matchKey,
    eventOwned: true,
  };
  inviteUpdates[`players/${hostLoginUid}/matches/${inviteId}`] =
    createMatchRecord(hostColor, match.hostEmojiId, match.hostAura, gameSeed);
  inviteUpdates[`players/${guestLoginUid}/matches/${inviteId}`] =
    createMatchRecord(
      guestColor,
      match.guestEmojiId,
      match.guestAura,
      gameSeed,
    );

  return true;
};

const reconcileThirdPlaceMatchReadiness = async ({
  eventId,
  rounds,
  nowMs,
  participantsById,
  inviteUpdates,
  thirdPlaceMatch,
  allowInviteCreation = true,
}) => {
  if (!thirdPlaceMatch || typeof thirdPlaceMatch !== "object") {
    return {
      didChange: false,
      thirdPlaceMatch: null,
    };
  }

  const sortedRoundIndexes = getSortedRoundIndexes(rounds);
  if (sortedRoundIndexes.length < 2) {
    return {
      didChange: false,
      thirdPlaceMatch,
    };
  }

  const semifinalRoundIndex = sortedRoundIndexes[sortedRoundIndexes.length - 2];
  const semifinalRound = rounds[String(semifinalRoundIndex)];
  if (
    !semifinalRound ||
    !semifinalRound.matches ||
    typeof semifinalRound.matches !== "object"
  ) {
    return {
      didChange: false,
      thirdPlaceMatch,
    };
  }

  const semifinalMatchKeys = getSortedMatchKeys(semifinalRound.matches);
  const semifinalHostMatch = semifinalRound.matches[semifinalMatchKeys[0]];
  const semifinalGuestMatch = semifinalRound.matches[semifinalMatchKeys[1]];

  let didChange = false;

  const resolveThirdPlaceSlotState = (semifinalMatch) => {
    if (!semifinalMatch || typeof semifinalMatch !== "object") {
      return {
        participant: null,
        blocked: false,
      };
    }

    if (isMatchWinnerDisqualified(semifinalMatch)) {
      return {
        participant: null,
        blocked: true,
      };
    }

    if (!isMatchResolved(semifinalMatch)) {
      return {
        participant: null,
        blocked: false,
      };
    }

    const loserProfileId = normalizeString(semifinalMatch.loserProfileId);
    if (!loserProfileId) {
      return {
        participant: null,
        blocked: true,
      };
    }
    return {
      participant: participantsById[loserProfileId] || null,
      blocked: false,
    };
  };

  const hostSlotState = resolveThirdPlaceSlotState(semifinalHostMatch);
  const hostSlotParticipantChanged = setMatchSlotParticipant(
    thirdPlaceMatch,
    "host",
    hostSlotState.participant,
  );
  const hostSlotBlockedChanged = setMatchSlotBlocked(
    thirdPlaceMatch,
    "host",
    hostSlotState.blocked,
  );
  if (hostSlotParticipantChanged || hostSlotBlockedChanged) {
    didChange = true;
  }

  const guestSlotState = resolveThirdPlaceSlotState(semifinalGuestMatch);
  const guestSlotParticipantChanged = setMatchSlotParticipant(
    thirdPlaceMatch,
    "guest",
    guestSlotState.participant,
  );
  const guestSlotBlockedChanged = setMatchSlotBlocked(
    thirdPlaceMatch,
    "guest",
    guestSlotState.blocked,
  );
  if (guestSlotParticipantChanged || guestSlotBlockedChanged) {
    didChange = true;
  }

  const status = normalizeString(thirdPlaceMatch.status);
  const hostProfileId = normalizeString(thirdPlaceMatch.hostProfileId);
  const guestProfileId = normalizeString(thirdPlaceMatch.guestProfileId);
  const hostSlotBlocked = isMatchSlotBlocked(thirdPlaceMatch, "host");
  const guestSlotBlocked = isMatchSlotBlocked(thirdPlaceMatch, "guest");
  const winnerDisqualified = isMatchWinnerDisqualified(thirdPlaceMatch);

  if (winnerDisqualified && !isResolvedMatchStatus(status)) {
    if (
      applyMatchResolution(
        thirdPlaceMatch,
        {
          status: "bye",
          winnerProfileId: null,
          loserProfileId: null,
        },
        nowMs,
      )
    ) {
      didChange = true;
    }
    return {
      didChange,
      thirdPlaceMatch,
    };
  }

  if (isMatchResolved(thirdPlaceMatch)) {
    return {
      didChange,
      thirdPlaceMatch,
    };
  }

  if (hostProfileId && guestProfileId) {
    if (!allowInviteCreation) {
      return {
        didChange,
        thirdPlaceMatch,
      };
    }
    if (
      await createInviteForMatch({
        eventId,
        roundIndex: null,
        matchKey: thirdPlaceMatch.matchKey || THIRD_PLACE_MATCH_KEY,
        match: thirdPlaceMatch,
        inviteUpdates,
      })
    ) {
      didChange = true;
    }
    return {
      didChange,
      thirdPlaceMatch,
    };
  }

  const hasSingleParticipant = !!hostProfileId !== !!guestProfileId;
  if (hasSingleParticipant && (hostSlotBlocked || guestSlotBlocked)) {
    if (
      applyMatchResolution(
        thirdPlaceMatch,
        {
          status: "bye",
          winnerProfileId: hostProfileId || guestProfileId,
          loserProfileId: null,
        },
        nowMs,
      )
    ) {
      didChange = true;
    }
    return {
      didChange,
      thirdPlaceMatch,
    };
  }

  if (
    !hostProfileId &&
    !guestProfileId &&
    hostSlotBlocked &&
    guestSlotBlocked
  ) {
    if (
      applyMatchResolution(
        thirdPlaceMatch,
        {
          status: "bye",
          winnerProfileId: null,
          loserProfileId: null,
        },
        nowMs,
      )
    ) {
      didChange = true;
    }
    return {
      didChange,
      thirdPlaceMatch,
    };
  }

  if (status !== "upcoming") {
    thirdPlaceMatch.status = "upcoming";
    didChange = true;
  }

  return {
    didChange,
    thirdPlaceMatch,
  };
};

const reconcileBracketMatchReadiness = async ({
  eventId,
  rounds,
  nowMs,
  participantsById,
  inviteUpdates,
}) => {
  const sortedRoundIndexes = getSortedRoundIndexes(rounds);
  if (sortedRoundIndexes.length <= 0) {
    return false;
  }

  let didChange = false;
  let passChanged = true;
  let passCount = 0;

  while (passChanged && passCount < 32) {
    passChanged = false;
    passCount += 1;

    for (const roundIndex of sortedRoundIndexes) {
      const round = rounds[String(roundIndex)];
      if (!round || !round.matches || typeof round.matches !== "object") {
        continue;
      }
      const matchKeys = getSortedMatchKeys(round.matches);

      for (const matchKey of matchKeys) {
        const match = round.matches[matchKey];
        if (!match || typeof match !== "object") {
          continue;
        }

        const status = normalizeString(match.status);
        const hostProfileId = normalizeString(match.hostProfileId);
        const guestProfileId = normalizeString(match.guestProfileId);
        const winnerDisqualified = isMatchWinnerDisqualified(match);
        const hostSlotBlocked = isMatchSlotBlocked(match, "host");
        const guestSlotBlocked = isMatchSlotBlocked(match, "guest");
        const matchIndex = getMatchIndexFromKey(matchKey);

        if (winnerDisqualified && !isResolvedMatchStatus(status)) {
          if (
            assignWinnerToNextRound({
              rounds,
              roundIndex,
              matchIndex,
              winnerProfileId: null,
              participantsById,
              winnerDisqualified: true,
            })
          ) {
            didChange = true;
            passChanged = true;
          }
          continue;
        }

        if (isResolvedMatchStatus(status)) {
          const resolvedWinnerProfileId = normalizeString(
            match.winnerProfileId,
          );
          const shouldBlockDownstream =
            winnerDisqualified || resolvedWinnerProfileId === "";
          if (
            assignWinnerToNextRound({
              rounds,
              roundIndex,
              matchIndex,
              winnerProfileId: resolvedWinnerProfileId,
              participantsById,
              winnerDisqualified: shouldBlockDownstream,
            })
          ) {
            didChange = true;
            passChanged = true;
          }
          continue;
        }

        if (hostProfileId && guestProfileId) {
          if (
            await createInviteForMatch({
              eventId,
              roundIndex,
              matchKey,
              match,
              inviteUpdates,
            })
          ) {
            didChange = true;
            passChanged = true;
          }
          continue;
        }

        const hasSingleParticipant = !!hostProfileId !== !!guestProfileId;
        if (
          hasSingleParticipant &&
          (roundIndex === 0 || hostSlotBlocked || guestSlotBlocked)
        ) {
          const winnerProfileId = hostProfileId || guestProfileId;
          if (
            applyMatchResolution(
              match,
              {
                status: "bye",
                winnerProfileId,
                loserProfileId: null,
              },
              nowMs,
            )
          ) {
            didChange = true;
            passChanged = true;
          }
          if (
            assignWinnerToNextRound({
              rounds,
              roundIndex,
              matchIndex,
              winnerProfileId,
              participantsById,
              winnerDisqualified,
            })
          ) {
            didChange = true;
            passChanged = true;
          }
          continue;
        }

        if (
          !hostProfileId &&
          !guestProfileId &&
          hostSlotBlocked &&
          guestSlotBlocked
        ) {
          if (
            applyMatchResolution(
              match,
              {
                status: "bye",
                winnerProfileId: null,
                loserProfileId: null,
              },
              nowMs,
            )
          ) {
            didChange = true;
            passChanged = true;
          }
          if (
            assignWinnerToNextRound({
              rounds,
              roundIndex,
              matchIndex,
              winnerProfileId: null,
              participantsById,
              winnerDisqualified: true,
            })
          ) {
            didChange = true;
            passChanged = true;
          }
          continue;
        }

        if (status !== "upcoming") {
          match.status = "upcoming";
          didChange = true;
          passChanged = true;
        }
      }
    }
  }

  return didChange;
};

const recomputeRoundStatuses = ({ rounds, nowMs }) => {
  const sortedRoundIndexes = getSortedRoundIndexes(rounds);
  const finalRoundIndex =
    sortedRoundIndexes.length > 0
      ? sortedRoundIndexes[sortedRoundIndexes.length - 1]
      : null;
  let earliestUnresolvedRoundIndex = null;
  let finalRoundWinnerProfileId = null;
  let didChange = false;

  for (const roundIndex of sortedRoundIndexes) {
    const round = rounds[String(roundIndex)];
    if (!round || !round.matches || typeof round.matches !== "object") {
      continue;
    }

    const matchKeys = getSortedMatchKeys(round.matches);
    const roundWinnerProfileIds = new Set();
    let allResolved = matchKeys.length > 0;
    let hasStarted = false;

    for (const matchKey of matchKeys) {
      const match = round.matches[matchKey];
      if (!match || typeof match !== "object") {
        allResolved = false;
        continue;
      }

      const status = normalizeString(match.status);
      const hostProfileId = normalizeString(match.hostProfileId);
      const guestProfileId = normalizeString(match.guestProfileId);
      if (
        status !== "upcoming" ||
        hostProfileId ||
        guestProfileId ||
        isMatchSlotBlocked(match, "host") ||
        isMatchSlotBlocked(match, "guest")
      ) {
        hasStarted = true;
      }

      if (!isMatchResolved(match)) {
        allResolved = false;
        continue;
      }
      const winnerProfileId = normalizeString(match.winnerProfileId);
      if (winnerProfileId && !isMatchWinnerDisqualified(match)) {
        roundWinnerProfileIds.add(winnerProfileId);
      }
    }

    const nextStatus = allResolved
      ? "completed"
      : hasStarted
        ? "active"
        : "upcoming";
    if (round.status !== nextStatus) {
      round.status = nextStatus;
      didChange = true;
    }

    if (nextStatus === "completed") {
      if (typeof round.completedAtMs !== "number") {
        round.completedAtMs = nowMs;
        didChange = true;
      }
    } else if (round.completedAtMs !== null) {
      round.completedAtMs = null;
      didChange = true;
    }

    if (!allResolved && earliestUnresolvedRoundIndex === null) {
      earliestUnresolvedRoundIndex = roundIndex;
    }

    if (
      finalRoundIndex !== null &&
      roundIndex === finalRoundIndex &&
      allResolved
    ) {
      const winners = Array.from(roundWinnerProfileIds);
      if (winners.length === 1) {
        finalRoundWinnerProfileId = winners[0];
      }
    }
  }

  return {
    didChange,
    finalRoundIndex,
    earliestUnresolvedRoundIndex,
    finalRoundWinnerProfileId,
  };
};

const rebuildParticipantStatesFromRounds = ({
  participantsById,
  rounds,
  winnerProfileId,
  eventEnded,
}) => {
  const eliminationsByProfileId = {};
  const sortedRoundIndexes = getSortedRoundIndexes(rounds);
  for (const roundIndex of sortedRoundIndexes) {
    const round = rounds[String(roundIndex)];
    if (!round || !round.matches || typeof round.matches !== "object") {
      continue;
    }
    const matchKeys = getSortedMatchKeys(round.matches);
    for (const matchKey of matchKeys) {
      const match = round.matches[matchKey];
      if (!match || typeof match !== "object") {
        continue;
      }

      if (!isMatchResolved(match)) {
        continue;
      }
      const loserProfileId = normalizeString(match && match.loserProfileId);
      if (!loserProfileId || eliminationsByProfileId[loserProfileId]) {
        continue;
      }
      eliminationsByProfileId[loserProfileId] = {
        eliminatedRoundIndex: roundIndex,
        eliminatedByProfileId:
          normalizeString(match && match.winnerProfileId) || null,
      };
    }
  }

  const normalizedWinnerProfileId = normalizeStringOrNull(winnerProfileId);
  const nextParticipants = {};
  let didChange = false;
  for (const [profileId, participant] of Object.entries(
    participantsById || {},
  )) {
    if (!participant || typeof participant !== "object") {
      nextParticipants[profileId] = participant;
      continue;
    }

    const elimination = eliminationsByProfileId[profileId] || null;
    let state = "active";
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

    const normalizedCurrentEliminatedRoundIndex =
      typeof participant.eliminatedRoundIndex === "number"
        ? Math.floor(participant.eliminatedRoundIndex)
        : null;
    const normalizedCurrentEliminatedByProfileId = normalizeStringOrNull(
      participant.eliminatedByProfileId,
    );
    if (
      participant.state !== state ||
      normalizedCurrentEliminatedRoundIndex !== eliminatedRoundIndex ||
      normalizedCurrentEliminatedByProfileId !== eliminatedByProfileId
    ) {
      didChange = true;
    }

    nextParticipants[profileId] = {
      ...participant,
      state,
      eliminatedRoundIndex,
      eliminatedByProfileId,
    };
  }

  return {
    didChange,
    participantsById: nextParticipants,
  };
};

const getEventPrizeDisqualifiedIdentityKeys = ({ rounds, thirdPlaceMatch }) => {
  const identityKeys = new Set();
  const addMatchIdentities = (match) => {
    if (!match || match.winnerDisqualified !== true) {
      return;
    }
    for (const value of [
      match.hostProfileId,
      match.hostLoginUid,
      match.guestProfileId,
      match.guestLoginUid,
    ]) {
      const identityKey = normalizeString(value);
      if (identityKey) {
        identityKeys.add(identityKey);
      }
    }
  };

  for (const roundIndex of getSortedRoundIndexes(rounds)) {
    const matches = rounds[String(roundIndex)]?.matches;
    for (const matchKey of getSortedMatchKeys(matches)) {
      addMatchIdentities(matches[matchKey]);
    }
  }
  addMatchIdentities(thirdPlaceMatch);
  return identityKeys;
};

const isEventPrizeParticipantDisqualified = (participant, identityKeys) => {
  if (!participant) {
    return false;
  }
  const profileId = normalizeString(participant.profileId);
  const loginUid = normalizeString(participant.loginUid);
  return (
    (profileId && identityKeys.has(profileId)) ||
    (loginUid && identityKeys.has(loginUid))
  );
};

const getResolvedMatchProfileId = (match, result) => {
  const directProfileId = normalizeString(
    result === "winner" ? match?.winnerProfileId : match?.loserProfileId,
  );
  if (directProfileId) {
    return directProfileId;
  }
  const status = normalizeString(match?.status);
  const winnerSide =
    status === "host" ? "host" : status === "guest" ? "guest" : null;
  if (!winnerSide) {
    return "";
  }
  const side =
    result === "winner" ? winnerSide : winnerSide === "host" ? "guest" : "host";
  return normalizeString(match?.[`${side}ProfileId`]);
};

const getEventPrizePlacements = ({
  event,
  rounds,
  participantsById,
  thirdPlaceMatch,
}) => {
  const sortedRoundIndexes = getSortedRoundIndexes(rounds);
  const finalRoundIndex = sortedRoundIndexes[sortedRoundIndexes.length - 1];
  const finalRound = rounds[String(finalRoundIndex)];
  const finalMatchKey = getSortedMatchKeys(finalRound?.matches)[0];
  const finalMatch = finalRound?.matches?.[finalMatchKey];
  if (!finalMatch) {
    return [];
  }

  const disqualifiedIdentityKeys = getEventPrizeDisqualifiedIdentityKeys({
    rounds,
    thirdPlaceMatch,
  });
  const winnerProfileId =
    normalizeString(event?.winnerProfileId) ||
    getResolvedMatchProfileId(finalMatch, "winner");
  const winner = participantsById[winnerProfileId];
  if (
    !winner ||
    isEventPrizeParticipantDisqualified(winner, disqualifiedIdentityKeys)
  ) {
    return [];
  }

  const placements = [{ place: 1, profileId: winnerProfileId }];
  const reservedProfileIds = new Set([winnerProfileId]);
  const placementCandidates = [];
  const pushCandidate = (profileId) => {
    const normalizedProfileId = normalizeString(profileId);
    const participant = participantsById[normalizedProfileId];
    if (
      !normalizedProfileId ||
      !participant ||
      reservedProfileIds.has(normalizedProfileId) ||
      isEventPrizeParticipantDisqualified(participant, disqualifiedIdentityKeys)
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

  Object.values(participantsById)
    .filter(
      (participant) =>
        !isEventPrizeParticipantDisqualified(
          participant,
          disqualifiedIdentityKeys,
        ),
    )
    .sort((left, right) => {
      const leftRound = Number.isFinite(left.eliminatedRoundIndex)
        ? Math.floor(left.eliminatedRoundIndex)
        : -1;
      const rightRound = Number.isFinite(right.eliminatedRoundIndex)
        ? Math.floor(right.eliminatedRoundIndex)
        : -1;
      if (leftRound !== rightRound) {
        return rightRound - leftRound;
      }
      const joinedDifference =
        toFiniteInteger(left.joinedAtMs, 0) -
        toFiniteInteger(right.joinedAtMs, 0);
      if (joinedDifference !== 0) {
        return joinedDifference;
      }
      return normalizeString(left.profileId).localeCompare(
        normalizeString(right.profileId),
      );
    })
    .forEach((participant) => pushCandidate(participant.profileId));

  if (placementCandidates[0]) {
    placements.push({ place: 2, profileId: placementCandidates[0] });
  }
  if (placementCandidates[1] && Object.keys(participantsById).length >= 3) {
    placements.push({ place: 3, profileId: placementCandidates[1] });
  }
  return placements;
};

const hasCompleteEventPrizeAssignments = (assignments, placementCount) => {
  const expectedCount = Math.min(EVENT_PRIZE_IDS.length, placementCount);
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
  eventId,
  assignments,
}) => {
  const withdrawalsSnapshot = await admin
    .database()
    .ref(`eventPrizeWithdrawals/${eventId}`)
    .once("value");
  return filterProjectableEventPrizeAssignments({
    eventId,
    assignments,
    withdrawals: withdrawalsSnapshot.val() || {},
  });
};

const addEventPrizeAssignmentUpdates = async ({
  updates,
  eventId,
  assignments,
  includeEventAssignments,
}) => {
  if (includeEventAssignments) {
    updates[`events/${eventId}/prizeAssignments`] = assignments;
  }
  const projectableAssignments = await getProjectableEventPrizeAssignments({
    eventId,
    assignments,
  });
  for (const assignment of Object.values(projectableAssignments)) {
    updates[`profileEventPrizes/${assignment.profileId}/${eventId}`] =
      assignment;
  }
};

const getMissingEventPrizeProjectionUpdates = async ({
  eventId,
  assignments,
}) => {
  const updates = {};
  const projectableAssignments = await getProjectableEventPrizeAssignments({
    eventId,
    assignments,
  });
  await Promise.all(
    Object.values(projectableAssignments).map(async (assignment) => {
      const snapshot = await admin
        .database()
        .ref(`profileEventPrizes/${assignment.profileId}/${eventId}`)
        .once("value");
      const current = snapshot.val();
      if (
        !current ||
        current.eventId !== assignment.eventId ||
        current.profileId !== assignment.profileId ||
        Number(current.place) !== assignment.place ||
        current.prizeId !== assignment.prizeId ||
        Number(current.assignedAtMs) !== assignment.assignedAtMs
      ) {
        updates[`profileEventPrizes/${assignment.profileId}/${eventId}`] =
          assignment;
      }
    }),
  );
  return updates;
};

const removeCompletedEventPrizeProjections = async ({
  eventId,
  assignments,
}) => {
  const withdrawalsSnapshot = await admin
    .database()
    .ref(`eventPrizeWithdrawals/${eventId}`)
    .once("value");
  const withdrawals = withdrawalsSnapshot.val() || {};
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
      await admin
        .database()
        .ref(`profileEventPrizes/${assignment.profileId}/${eventId}`)
        .transaction(
          (currentAssignment) =>
            isMatchingProfileEventPrizeAssignment(
              currentAssignment,
              eventId,
              assignment.prizeId,
            )
              ? null
              : undefined,
          undefined,
          false,
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
}) => {
  const placements = getEventPrizePlacements({
    event,
    rounds,
    participantsById,
    thirdPlaceMatch,
  });
  const storedAssignments = normalizeEventPrizeAssignments(
    event?.prizeAssignments,
    eventId,
  );
  if (hasCompleteEventPrizeAssignments(storedAssignments, placements.length)) {
    return { assignments: storedAssignments, didCreate: false };
  }
  const selectionsSnapshot = await admin
    .database()
    .ref(`eventPrizeSelections/${eventId}`)
    .once("value");
  return {
    assignments: buildEventPrizeAssignments({
      eventId,
      placements,
      selections: selectionsSnapshot.val() || {},
      assignedAtMs,
    }),
    didCreate: true,
  };
};

const buildFixedBracketState = async ({
  eventId,
  participantIds,
  participantsById,
  nowMs,
  enableThirdPlace = false,
}) => {
  const bracketSize = getBracketSize(participantIds.length);
  const roundCount = Math.max(1, Math.round(Math.log2(bracketSize)));
  const seedOrder = buildSeedOrder(bracketSize);
  const inviteUpdates = {};
  const rounds = {};
  let thirdPlaceMatch = null;
  const seedToProfileId = buildSeedToProfileId({
    participantIds,
    participantsById,
    bracketSize,
    seedOrder,
  });

  for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
    const round = {
      roundIndex,
      status: roundIndex === 0 ? "active" : "upcoming",
      createdAtMs: nowMs,
      completedAtMs: null,
      matches: {},
    };
    const matchCount = bracketSize / Math.pow(2, roundIndex + 1);

    for (let matchIndex = 0; matchIndex < matchCount; matchIndex += 1) {
      const matchKey = getMatchKey(roundIndex, matchIndex);
      const match = createEmptyEventMatch(matchKey);

      if (roundIndex === 0) {
        const hostSeed = seedOrder[matchIndex * 2];
        const guestSeed = seedOrder[matchIndex * 2 + 1];
        const hostProfileId = seedToProfileId.get(hostSeed) || null;
        const guestProfileId = seedToProfileId.get(guestSeed) || null;

        setMatchSlotParticipant(
          match,
          "host",
          participantsById[hostProfileId] || null,
        );
        setMatchSlotParticipant(
          match,
          "guest",
          participantsById[guestProfileId] || null,
        );

        if (hostProfileId && guestProfileId) {
          await createInviteForMatch({
            eventId,
            roundIndex,
            matchKey,
            match,
            inviteUpdates,
          });
        } else if (hostProfileId || guestProfileId) {
          applyMatchResolution(
            match,
            {
              status: "bye",
              winnerProfileId: hostProfileId || guestProfileId,
              loserProfileId: null,
            },
            nowMs,
          );
        }
      }

      round.matches[matchKey] = match;
    }

    rounds[String(roundIndex)] = round;
  }

  await reconcileBracketMatchReadiness({
    eventId,
    rounds,
    nowMs,
    participantsById,
    inviteUpdates,
  });

  if (enableThirdPlace && participantIds.length >= 4 && roundCount >= 2) {
    thirdPlaceMatch = createEmptyEventMatch(THIRD_PLACE_MATCH_KEY);
    await reconcileThirdPlaceMatchReadiness({
      eventId,
      rounds,
      nowMs,
      participantsById,
      inviteUpdates,
      thirdPlaceMatch,
    });
  }

  const { earliestUnresolvedRoundIndex } = recomputeRoundStatuses({
    rounds,
    nowMs,
  });

  return {
    bracketSize,
    roundCount,
    currentRoundIndex:
      earliestUnresolvedRoundIndex === null ? 0 : earliestUnresolvedRoundIndex,
    rounds,
    thirdPlaceMatch,
    inviteUpdates,
  };
};

const buildScheduledEventDueUpdates = async ({ eventId, event, nowMs }) => {
  if (!event || event.status !== "scheduled") {
    return { didChange: false, updates: {} };
  }
  if (typeof event.startAtMs !== "number" || nowMs < event.startAtMs) {
    return { didChange: false, updates: {} };
  }

  const participantIds = getParticipantIds(event);
  if (participantIds.length >= 2) {
    const participantsById = event.participants || {};
    const supportsThirdPlaceMatch = hasThirdPlaceMatchField(event);
    const bracket = await buildFixedBracketState({
      eventId,
      participantIds,
      participantsById,
      nowMs,
      enableThirdPlace: supportsThirdPlaceMatch,
    });

    event.status = "active";
    event.startedAtMs = nowMs;
    event.updatedAtMs = nowMs;
    event.currentRoundIndex = bracket.currentRoundIndex;
    event.bracketSize = bracket.bracketSize;
    event.roundCount = bracket.roundCount;
    if (supportsThirdPlaceMatch) {
      event.thirdPlaceMatch = bracket.thirdPlaceMatch;
    }

    return {
      didChange: true,
      updates: {
        ...bracket.inviteUpdates,
        [`events/${eventId}/status`]: event.status,
        [`events/${eventId}/startedAtMs`]: event.startedAtMs,
        [`events/${eventId}/updatedAtMs`]: event.updatedAtMs,
        [`events/${eventId}/currentRoundIndex`]: event.currentRoundIndex,
        [`events/${eventId}/bracketSize`]: event.bracketSize,
        [`events/${eventId}/roundCount`]: event.roundCount,
        [`events/${eventId}/rounds`]: bracket.rounds,
        ...(supportsThirdPlaceMatch
          ? {
              [`events/${eventId}/thirdPlaceMatch`]: bracket.thirdPlaceMatch,
            }
          : {}),
      },
    };
  }

  event.status = "dismissed";
  event.endedAtMs = nowMs;
  event.updatedAtMs = nowMs;
  event.winnerProfileId = null;
  event.winnerDisplayName = null;
  return {
    didChange: true,
    updates: {
      [`events/${eventId}/status`]: event.status,
      [`events/${eventId}/endedAtMs`]: event.endedAtMs,
      [`events/${eventId}/updatedAtMs`]: event.updatedAtMs,
      [`events/${eventId}/winnerProfileId`]: null,
      [`events/${eventId}/winnerDisplayName`]: null,
    },
  };
};

const resolveRoundMatchState = async (matchRecord) => {
  if (!matchRecord || typeof matchRecord !== "object") {
    return null;
  }

  const existingStatus = normalizeString(matchRecord.status);
  if (existingStatus === "bye") {
    const winnerProfileId = normalizeString(matchRecord.winnerProfileId);
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
      normalizeString(matchRecord.winnerProfileId) ||
      (existingStatus === "host"
        ? normalizeString(matchRecord.hostProfileId)
        : normalizeString(matchRecord.guestProfileId));
    const loserProfileId =
      normalizeString(matchRecord.loserProfileId) ||
      (existingStatus === "host"
        ? normalizeString(matchRecord.guestProfileId)
        : normalizeString(matchRecord.hostProfileId));
    if (!winnerProfileId) {
      return null;
    }
    return {
      status: existingStatus,
      winnerProfileId,
      loserProfileId: loserProfileId || null,
    };
  }

  const hostLoginUid = normalizeString(matchRecord.hostLoginUid);
  const guestLoginUid = normalizeString(matchRecord.guestLoginUid);
  const inviteId = normalizeString(matchRecord.inviteId);
  if (!hostLoginUid || !guestLoginUid || !inviteId) {
    return null;
  }

  const [hostSnapshot, guestSnapshot] = await batchReadWithRetry([
    admin.database().ref(`players/${hostLoginUid}/matches/${inviteId}`),
    admin.database().ref(`players/${guestLoginUid}/matches/${inviteId}`),
  ]);
  const hostMatch = hostSnapshot.val();
  const guestMatch = guestSnapshot.val();
  const outcome = await resolveMatchWinner(hostMatch, guestMatch);
  if (outcome.winner === "player") {
    return {
      status: "host",
      winnerProfileId: normalizeString(matchRecord.hostProfileId),
      loserProfileId: normalizeStringOrNull(matchRecord.guestProfileId),
    };
  }
  if (outcome.winner === "opponent") {
    return {
      status: "guest",
      winnerProfileId: normalizeString(matchRecord.guestProfileId),
      loserProfileId: normalizeStringOrNull(matchRecord.hostProfileId),
    };
  }
  return null;
};

const resolveRoundMatchesWithConcurrency = async (matchesByKey) => {
  const entries = Object.entries(matchesByKey || {});
  if (entries.length <= 0) {
    return [];
  }

  const results = new Array(entries.length);
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
      const resolved = await resolveRoundMatchState(matchRecord);
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

const createBaseEventRecord = ({
  eventId,
  creatorProfile,
  creatorUid,
  startAtMs,
  createdAtMs,
  announceOnTelegram,
}) => {
  const creatorParticipant = buildParticipantSnapshot(
    creatorProfile,
    creatorUid,
    createdAtMs,
  );
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId,
    status: "scheduled",
    createdAtMs,
    updatedAtMs: createdAtMs,
    startAtMs,
    announceOnTelegram: announceOnTelegram === true,
    startedAtMs: null,
    endedAtMs: null,
    createdByProfileId: creatorParticipant.profileId,
    createdByLoginUid: creatorUid,
    createdByUsername: creatorParticipant.username,
    winnerProfileId: null,
    winnerDisplayName: null,
    currentRoundIndex: null,
    bracketSize: 0,
    roundCount: 0,
    supportsThirdPlaceMatch: true,
    thirdPlaceMatch: null,
    participants: {
      [creatorParticipant.profileId]: creatorParticipant,
    },
    rounds: {},
  };
};

const acquireEventLock = async (eventId, ownerUid) => {
  const lockRef = admin.database().ref(`eventLocks/${eventId}`);
  const lockId = randomAlphanumeric(16);
  const result = await lockRef.transaction((current) => {
    const nowMs = getNowMs();
    if (
      current &&
      typeof current.expiresAtMs === "number" &&
      current.expiresAtMs > nowMs
    ) {
      return;
    }
    return {
      lockId,
      ownerUid,
      expiresAtMs: nowMs + EVENT_LOCK_TTL_MS,
      acquiredAtMs: nowMs,
      refreshedAtMs: nowMs,
    };
  });
  if (!result.committed) {
    return null;
  }
  return {
    ref: lockRef,
    lockId,
    ownerUid,
  };
};

const acquireEventLockWithRetry = async (eventId, ownerUid, options = {}) => {
  const attempts = Math.max(1, toFiniteInteger(options.attempts, 1));
  const delayMs = Math.max(25, toFiniteInteger(options.delayMs, 100));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const lockHandle = await acquireEventLock(eventId, ownerUid);
    if (lockHandle) {
      return lockHandle;
    }
    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }

  return null;
};

const isEventLockStillOwned = async (lockHandle) => {
  if (!lockHandle) {
    return false;
  }
  const snapshot = await lockHandle.ref.once("value");
  const current = snapshot.val();
  const nowMs = getNowMs();
  return !!(
    current &&
    current.ownerUid === lockHandle.ownerUid &&
    current.lockId === lockHandle.lockId &&
    typeof current.expiresAtMs === "number" &&
    current.expiresAtMs > nowMs
  );
};

const startEventLockHeartbeat = (lockHandle) => {
  if (!lockHandle) {
    return () => {};
  }
  let isDisposed = false;
  const heartbeatInterval = setInterval(() => {
    if (isDisposed) {
      return;
    }
    const refreshedAtMs = getNowMs();
    void lockHandle.ref
      .transaction((current) => {
        if (
          !current ||
          current.ownerUid !== lockHandle.ownerUid ||
          current.lockId !== lockHandle.lockId
        ) {
          return;
        }
        return {
          ...current,
          expiresAtMs: refreshedAtMs + EVENT_LOCK_TTL_MS,
          refreshedAtMs,
        };
      })
      .catch((error) => {
        console.error(
          "event:lock:heartbeat:error",
          error && error.message ? error.message : error,
        );
      });
  }, EVENT_LOCK_REFRESH_INTERVAL_MS);

  if (typeof heartbeatInterval.unref === "function") {
    heartbeatInterval.unref();
  }

  return () => {
    isDisposed = true;
    clearInterval(heartbeatInterval);
  };
};

const releaseEventLock = async (lockHandle) => {
  if (!lockHandle) {
    return;
  }
  try {
    const snapshot = await lockHandle.ref.once("value");
    const current = snapshot.val();
    if (
      current &&
      current.ownerUid === lockHandle.ownerUid &&
      current.lockId === lockHandle.lockId
    ) {
      await lockHandle.ref.remove();
    }
  } catch (error) {
    console.error(
      "event:lock:release:error",
      error && error.message ? error.message : error,
    );
  }
};

const tryAcquireEventSyncThrottle = async (eventId, ownerUid) => {
  const throttleRef = admin.database().ref(`eventSyncThrottles/${eventId}`);
  const nowMs = getNowMs();
  const token = randomAlphanumeric(10);
  const result = await throttleRef.transaction((current) => {
    const lastStartedAtMs =
      current && typeof current.startedAtMs === "number"
        ? Math.floor(current.startedAtMs)
        : 0;
    if (
      lastStartedAtMs > 0 &&
      nowMs - lastStartedAtMs < EVENT_SYNC_THROTTLE_WINDOW_MS
    ) {
      return;
    }
    return {
      startedAtMs: nowMs,
      ownerUid,
      token,
    };
  });
  if (!result.committed) {
    return null;
  }
  return {
    startedAtMs: nowMs,
    ownerUid,
    token,
  };
};

const logSyncEventStateResult = (payload) => {
  try {
    console.log("event:sync:result", payload);
  } catch (error) {
    console.error(
      "event:sync:result:log:error",
      error && error.message ? error.message : error,
    );
  }
};

const createSyncLog = ({ eventId, requesterUid, mode }) => ({
  mode,
  eventId,
  requesterUid: requesterUid || null,
  requesterProfileId: null,
  skipped: false,
  reason: null,
  didChange: false,
  durationMs: 0,
});

const clearEventProgressFallbackSignal = async (eventId, signalId) => {
  const normalizedEventId = normalizeString(eventId);
  const normalizedSignalId = normalizeString(signalId);
  if (!normalizedEventId || !normalizedSignalId) {
    return;
  }
  try {
    await admin
      .database()
      .ref(`eventProgressFallback/${normalizedEventId}/${normalizedSignalId}`)
      .remove();
  } catch (error) {
    console.error("event:progress:fallback:clear:error", {
      eventId: normalizedEventId,
      signalId: normalizedSignalId,
      error: error && error.message ? error.message : error,
    });
  }
};

exports.createEvent = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated.",
    );
  }

  const creatorProfile = await ensurePilotEventCreator(request.auth.uid);
  const createdAtMs = getNowMs();
  const requestData =
    request.data && typeof request.data === "object" ? request.data : {};
  const announceOnTelegram = requestData.announceOnTelegram === true;
  let startAtMs = 0;

  if (hasDateTimeScheduleRequest(requestData)) {
    startAtMs = resolveScheduledDateTimeStartAtMs(requestData, createdAtMs);
    assertScheduledStartWindow(startAtMs, createdAtMs);
  } else {
    const rawStartsInMinutes = toFiniteInteger(requestData.startsInMinutes, 0);
    if (rawStartsInMinutes < MIN_STARTS_IN_MINUTES) {
      throw new HttpsError(
        "invalid-argument",
        `Event must start at least ${MIN_STARTS_IN_MINUTES} minute from now.`,
      );
    }
    const startsInMinutes = Math.min(MAX_STARTS_IN_MINUTES, rawStartsInMinutes);
    startAtMs = createdAtMs + startsInMinutes * 60 * 1000;
  }

  const eventId = generateEventId();
  const event = createBaseEventRecord({
    eventId,
    creatorProfile,
    creatorUid: request.auth.uid,
    startAtMs,
    createdAtMs,
    announceOnTelegram,
  });

  try {
    await enqueueEventProgressTask({
      eventId,
      sourceKey: `start:${eventId}`,
      reason: "scheduled-start",
      scheduleTimeMs: startAtMs,
    });
  } catch (error) {
    console.error("event:progress:enqueue:error", {
      eventId,
      sourceKey: `start:${eventId}`,
      reason: "scheduled-start",
      error: error && error.message ? error.message : error,
    });
    throw new HttpsError(
      "unavailable",
      "Could not schedule event start. Please try again.",
    );
  }

  await admin.database().ref(`events/${eventId}`).set(event);

  return {
    ok: true,
    eventId,
    event,
  };
});

exports.joinEvent = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated.",
    );
  }

  const eventId = normalizeString(request.data && request.data.eventId);
  if (!eventId) {
    throw new HttpsError("invalid-argument", "eventId is required.");
  }

  const profile = await ensureNonAnonProfile(request.auth.uid);
  const profileId = normalizeString(profile.profileId);
  const lockHandle = await acquireEventLockWithRetry(
    eventId,
    request.auth.uid,
    {
      attempts: 40,
      delayMs: 100,
    },
  );
  if (!lockHandle) {
    throw new HttpsError(
      "unavailable",
      "Event is busy. Please try joining again.",
    );
  }
  const stopLockHeartbeat = startEventLockHeartbeat(lockHandle);

  try {
    const eventRef = admin.database().ref(`events/${eventId}`);
    const eventSnapshot = await eventRef.once("value");
    if (!eventSnapshot.exists()) {
      throw new HttpsError("not-found", "Event not found.");
    }

    const event = cloneValue(eventSnapshot.val() || {});
    const nowMs = getNowMs();
    if (event.status !== "scheduled") {
      throw new HttpsError(
        "failed-precondition",
        "This event has already started.",
      );
    }
    if (typeof event.startAtMs === "number" && nowMs >= event.startAtMs) {
      const dueTransition = await buildScheduledEventDueUpdates({
        eventId,
        event,
        nowMs,
      });
      if (dueTransition.didChange) {
        await admin.database().ref().update(dueTransition.updates);
      }
      throw new HttpsError(
        "failed-precondition",
        "This event is no longer accepting participants.",
      );
    }

    const existingParticipant =
      event.participants && event.participants[profileId]
        ? event.participants[profileId]
        : null;
    const currentParticipantCount = getParticipantIds(event).length;
    if (
      !existingParticipant &&
      currentParticipantCount >= MAX_EVENT_PARTICIPANTS
    ) {
      throw new HttpsError(
        "failed-precondition",
        `This event is full (${MAX_EVENT_PARTICIPANTS} players max).`,
      );
    }

    const participant = buildParticipantSnapshot(
      profile,
      request.auth.uid,
      existingParticipant && typeof existingParticipant.joinedAtMs === "number"
        ? existingParticipant.joinedAtMs
        : nowMs,
    );
    const nextParticipants =
      event.participants && typeof event.participants === "object"
        ? event.participants
        : {};
    nextParticipants[profileId] = participant;
    event.participants = nextParticipants;
    event.updatedAtMs = nowMs;
    const updates = {
      [`events/${eventId}/participants/${profileId}`]: participant,
      [`events/${eventId}/updatedAtMs`]: nowMs,
    };
    const settleNowMs = getNowMs();
    const dueTransition = await buildScheduledEventDueUpdates({
      eventId,
      event,
      nowMs: settleNowMs,
    });
    if (dueTransition.didChange) {
      Object.assign(updates, dueTransition.updates);
    }
    const lockOwned = await isEventLockStillOwned(lockHandle);
    if (!lockOwned) {
      throw new HttpsError(
        "unavailable",
        "Event is busy. Please try joining again.",
      );
    }
    await admin.database().ref().update(updates);

    return {
      ok: true,
      eventId,
      participant,
    };
  } finally {
    stopLockHeartbeat();
    await releaseEventLock(lockHandle);
  }
});

exports.postponeEventStart = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated.",
    );
  }

  const eventId = normalizeString(request.data && request.data.eventId);
  if (!eventId) {
    throw new HttpsError("invalid-argument", "eventId is required.");
  }
  const postponeByMinutes = toFiniteInteger(
    request.data && request.data.postponeByMinutes,
    0,
  );
  if (!EVENT_POSTPONE_OPTIONS_MINUTES.includes(postponeByMinutes)) {
    throw new HttpsError(
      "invalid-argument",
      "postponeByMinutes must be one of: 5, 10, 15.",
    );
  }

  const profile = await ensureNonAnonProfile(request.auth.uid);
  const profileId = normalizeString(profile.profileId);
  const lockHandle = await acquireEventLockWithRetry(
    eventId,
    request.auth.uid,
    {
      attempts: 40,
      delayMs: 100,
    },
  );
  if (!lockHandle) {
    throw new HttpsError(
      "unavailable",
      "Event is busy. Please try postponing again.",
    );
  }
  const stopLockHeartbeat = startEventLockHeartbeat(lockHandle);

  try {
    const eventSnapshot = await admin
      .database()
      .ref(`events/${eventId}`)
      .once("value");
    if (!eventSnapshot.exists()) {
      throw new HttpsError("not-found", "Event not found.");
    }
    const event = cloneValue(eventSnapshot.val() || {});
    const creatorLoginUid = normalizeString(event.createdByLoginUid);
    const creatorProfileId = normalizeString(event.createdByProfileId);
    if (
      request.auth.uid !== creatorLoginUid &&
      profileId !== creatorProfileId
    ) {
      throw new HttpsError(
        "permission-denied",
        "Only the event creator can postpone this event.",
      );
    }
    if (normalizeString(event.status) !== "scheduled") {
      throw new HttpsError(
        "failed-precondition",
        "Only scheduled events can be postponed.",
      );
    }

    const nowMs = getNowMs();
    if (
      typeof event.startAtMs !== "number" ||
      !Number.isFinite(event.startAtMs)
    ) {
      throw new HttpsError(
        "failed-precondition",
        "This event cannot be postponed right now.",
      );
    }
    if (nowMs >= event.startAtMs) {
      const dueTransition = await buildScheduledEventDueUpdates({
        eventId,
        event,
        nowMs,
      });
      if (dueTransition.didChange) {
        await admin.database().ref().update(dueTransition.updates);
      }
      throw new HttpsError(
        "failed-precondition",
        "This event can no longer be postponed.",
      );
    }

    const nextStartAtMs =
      Math.floor(event.startAtMs) + postponeByMinutes * 60 * 1000;
    assertScheduledStartWindow(nextStartAtMs, nowMs);
    const sourceKey = `start:${eventId}:${nextStartAtMs}`;
    try {
      await enqueueEventProgressTask({
        eventId,
        sourceKey,
        reason: "scheduled-start-postpone",
        scheduleTimeMs: nextStartAtMs,
      });
    } catch (error) {
      console.error("event:progress:enqueue:error", {
        eventId,
        sourceKey,
        reason: "scheduled-start-postpone",
        error: error && error.message ? error.message : error,
      });
      throw new HttpsError(
        "unavailable",
        "Could not schedule postponed event start. Please try again.",
      );
    }

    const lockOwned = await isEventLockStillOwned(lockHandle);
    if (!lockOwned) {
      throw new HttpsError(
        "unavailable",
        "Event is busy. Please try postponing again.",
      );
    }

    event.startAtMs = nextStartAtMs;
    event.updatedAtMs = nowMs;
    await admin
      .database()
      .ref()
      .update({
        [`events/${eventId}/startAtMs`]: nextStartAtMs,
        [`events/${eventId}/updatedAtMs`]: nowMs,
      });

    return {
      ok: true,
      eventId,
      event,
      postponeByMinutes,
      startAtMs: nextStartAtMs,
    };
  } finally {
    stopLockHeartbeat();
    await releaseEventLock(lockHandle);
  }
});

exports.removeEventParticipant = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated.",
    );
  }

  const eventId = normalizeString(request.data && request.data.eventId);
  if (!eventId) {
    throw new HttpsError("invalid-argument", "eventId is required.");
  }
  const participantProfileId = normalizeString(
    request.data && request.data.participantProfileId,
  );
  if (!participantProfileId) {
    throw new HttpsError(
      "invalid-argument",
      "participantProfileId is required.",
    );
  }

  const profile = await ensureNonAnonProfile(request.auth.uid);
  const profileId = normalizeString(profile.profileId);
  const lockHandle = await acquireEventLockWithRetry(
    eventId,
    request.auth.uid,
    {
      attempts: 40,
      delayMs: 100,
    },
  );
  if (!lockHandle) {
    throw new HttpsError(
      "unavailable",
      "Event is busy. Please try removing again.",
    );
  }
  const stopLockHeartbeat = startEventLockHeartbeat(lockHandle);

  try {
    const eventSnapshot = await admin
      .database()
      .ref(`events/${eventId}`)
      .once("value");
    if (!eventSnapshot.exists()) {
      throw new HttpsError("not-found", "Event not found.");
    }
    const event = cloneValue(eventSnapshot.val() || {});
    const creatorLoginUid = normalizeString(event.createdByLoginUid);
    const creatorProfileId = normalizeString(event.createdByProfileId);
    if (
      request.auth.uid !== creatorLoginUid &&
      profileId !== creatorProfileId
    ) {
      throw new HttpsError(
        "permission-denied",
        "Only the event creator can remove participants.",
      );
    }
    if (normalizeString(event.status) !== "scheduled") {
      throw new HttpsError(
        "failed-precondition",
        "Only scheduled events can remove participants.",
      );
    }

    const nowMs = getNowMs();
    if (
      typeof event.startAtMs !== "number" ||
      !Number.isFinite(event.startAtMs)
    ) {
      throw new HttpsError(
        "failed-precondition",
        "This event cannot be updated right now.",
      );
    }
    if (nowMs >= event.startAtMs) {
      const dueTransition = await buildScheduledEventDueUpdates({
        eventId,
        event,
        nowMs,
      });
      if (dueTransition.didChange) {
        await admin.database().ref().update(dueTransition.updates);
      }
      throw new HttpsError(
        "failed-precondition",
        "This event can no longer remove participants.",
      );
    }

    const nextParticipants =
      event.participants && typeof event.participants === "object"
        ? event.participants
        : {};
    const targetParticipant =
      nextParticipants[participantProfileId] &&
      typeof nextParticipants[participantProfileId] === "object"
        ? nextParticipants[participantProfileId]
        : null;
    if (!targetParticipant) {
      throw new HttpsError(
        "failed-precondition",
        "Selected participant was not found.",
      );
    }
    if (
      participantProfileId === creatorProfileId ||
      normalizeString(targetParticipant.loginUid) === creatorLoginUid
    ) {
      throw new HttpsError(
        "failed-precondition",
        "Event creator cannot be removed.",
      );
    }

    const lockOwned = await isEventLockStillOwned(lockHandle);
    if (!lockOwned) {
      throw new HttpsError(
        "unavailable",
        "Event is busy. Please try removing again.",
      );
    }

    const commitNowMs = getNowMs();
    if (commitNowMs >= event.startAtMs) {
      const dueTransition = await buildScheduledEventDueUpdates({
        eventId,
        event,
        nowMs: commitNowMs,
      });
      if (dueTransition.didChange) {
        await admin.database().ref().update(dueTransition.updates);
      }
      throw new HttpsError(
        "failed-precondition",
        "This event can no longer remove participants.",
      );
    }

    delete nextParticipants[participantProfileId];
    event.participants = nextParticipants;
    event.updatedAtMs = commitNowMs;

    await admin
      .database()
      .ref()
      .update({
        [`events/${eventId}/participants/${participantProfileId}`]: null,
        [`eventPrizeSelections/${eventId}/${participantProfileId}`]: null,
        [`events/${eventId}/updatedAtMs`]: commitNowMs,
      });

    return {
      ok: true,
      eventId,
      event,
      removedProfileId: participantProfileId,
    };
  } finally {
    stopLockHeartbeat();
    await releaseEventLock(lockHandle);
  }
});

exports.disqualifyEventMatchWinners = onCall(async (request) => {
  const startedAtMs = getNowMs();
  const eventId = normalizeString(request.data && request.data.eventId);
  const matchKeyInput = normalizeString(request.data && request.data.matchKey);
  const syncLog = createSyncLog({
    eventId: eventId || null,
    requesterUid: request && request.auth ? request.auth.uid : null,
    mode: "callable-disqualify",
  });
  syncLog.targetMatchKey = matchKeyInput || null;
  let lockHandle = null;
  let stopLockHeartbeat = () => {};

  try {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "The function must be called while authenticated.",
      );
    }
    await ensurePilotEventCreator(request.auth.uid);

    if (!eventId) {
      throw new HttpsError("invalid-argument", "eventId is required.");
    }
    const isThirdPlaceTarget = matchKeyInput === THIRD_PLACE_MATCH_KEY;
    const parsedMatchKey = isThirdPlaceTarget
      ? null
      : parseMatchKey(matchKeyInput);
    if (!isThirdPlaceTarget && !parsedMatchKey) {
      throw new HttpsError("invalid-argument", "matchKey is invalid.");
    }

    lockHandle = await acquireEventLockWithRetry(eventId, request.auth.uid, {
      attempts: 40,
      delayMs: 100,
    });
    if (!lockHandle) {
      throw new HttpsError(
        "unavailable",
        "Event is busy. Please try disqualifying again.",
      );
    }
    stopLockHeartbeat = startEventLockHeartbeat(lockHandle);

    let didDisqualify = false;
    let resolvedMatchKey = matchKeyInput;
    try {
      const eventSnapshot = await admin
        .database()
        .ref(`events/${eventId}`)
        .once("value");
      if (!eventSnapshot.exists()) {
        throw new HttpsError("not-found", "Event not found.");
      }
      const event = cloneValue(eventSnapshot.val() || {});
      if (normalizeString(event.status) !== "active") {
        throw new HttpsError(
          "failed-precondition",
          "Only active events can be updated.",
        );
      }

      let targetMatch = null;
      let targetMatchUpdatePath = "";
      if (isThirdPlaceTarget) {
        const thirdPlaceMatchCandidate = event.thirdPlaceMatch;
        if (
          thirdPlaceMatchCandidate &&
          typeof thirdPlaceMatchCandidate === "object"
        ) {
          targetMatch = thirdPlaceMatchCandidate;
          resolvedMatchKey = THIRD_PLACE_MATCH_KEY;
          targetMatchUpdatePath = `events/${eventId}/thirdPlaceMatch/winnerDisqualified`;
        }
      } else {
        const round =
          event.rounds && typeof event.rounds === "object"
            ? event.rounds[String(parsedMatchKey.roundIndex)]
            : null;
        if (!round || !round.matches || typeof round.matches !== "object") {
          throw new HttpsError(
            "failed-precondition",
            "Selected match not found.",
          );
        }

        targetMatch = round.matches[resolvedMatchKey];
        if (!targetMatch || typeof targetMatch !== "object") {
          const fallbackEntry =
            Object.entries(round.matches).find(([candidateMatchKey]) => {
              const parsedCandidate = parseMatchKey(candidateMatchKey);
              return parsedCandidate?.matchIndex === parsedMatchKey.matchIndex;
            }) || null;
          if (fallbackEntry) {
            [resolvedMatchKey, targetMatch] = fallbackEntry;
          }
        }
        targetMatchUpdatePath = `events/${eventId}/rounds/${parsedMatchKey.roundIndex}/matches/${resolvedMatchKey}/winnerDisqualified`;
      }

      if (!targetMatch || typeof targetMatch !== "object") {
        throw new HttpsError(
          "failed-precondition",
          "Selected match not found.",
        );
      }

      if (
        normalizeString(targetMatch.status) !== "pending" ||
        !normalizeString(targetMatch.inviteId)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Only active matches can be disqualified.",
        );
      }
      if (
        !normalizeString(targetMatch.hostProfileId) ||
        !normalizeString(targetMatch.guestProfileId)
      ) {
        throw new HttpsError(
          "failed-precondition",
          "Selected match must have two participants.",
        );
      }

      didDisqualify = !isMatchWinnerDisqualified(targetMatch);
      if (didDisqualify) {
        const lockOwned = await isEventLockStillOwned(lockHandle);
        if (!lockOwned) {
          throw new HttpsError(
            "unavailable",
            "Event is busy. Please try disqualifying again.",
          );
        }
        await admin
          .database()
          .ref()
          .update({
            [targetMatchUpdatePath]: true,
            [`events/${eventId}/updatedAtMs`]: getNowMs(),
          });
      }
    } finally {
      stopLockHeartbeat();
      stopLockHeartbeat = () => {};
      await releaseEventLock(lockHandle);
      lockHandle = null;
    }

    let syncResult = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      syncLog.skipped = false;
      syncLog.reason = null;
      syncResult = await runEventSyncState({
        eventId,
        requesterUid: request.auth.uid,
        auth: request.auth,
        enforceParticipantGate: false,
        enforceThrottle: false,
        syncLog,
      });
      if (!(
        syncResult &&
        syncResult.skipped &&
        syncResult.reason === "locked"
      )) {
        break;
      }
      await sleep(80);
    }

    return {
      ...syncResult,
      didDisqualify,
      matchKey: resolvedMatchKey,
    };
  } finally {
    stopLockHeartbeat();
    if (lockHandle) {
      await releaseEventLock(lockHandle);
    }
    syncLog.durationMs = getNowMs() - startedAtMs;
    logSyncEventStateResult(syncLog);
  }
});

const buildSkippedSyncResponse = ({ eventId, reason, event }) => ({
  ok: true,
  eventId,
  skipped: true,
  reason,
  ...(event !== undefined ? { event } : {}),
});

const runEventSyncState = async ({
  eventId,
  requesterUid,
  auth,
  enforceParticipantGate,
  enforceThrottle,
  syncLog,
}) => {
  let lockHandle = null;
  let stopLockHeartbeat = () => {};

  try {
    const eventSnapshot = await admin
      .database()
      .ref(`events/${eventId}`)
      .once("value");
    if (!eventSnapshot.exists()) {
      throw new HttpsError("not-found", "Event not found.");
    }
    const initialEvent = cloneValue(eventSnapshot.val() || {});

    if (enforceParticipantGate) {
      const requesterParticipation = resolveRequesterParticipation(
        initialEvent,
        auth,
      );
      syncLog.requesterProfileId = requesterParticipation.profileId;
      if (!requesterParticipation.isParticipant) {
        syncLog.skipped = true;
        syncLog.reason = "not-participant";
        return buildSkippedSyncResponse({
          eventId,
          reason: "not-participant",
        });
      }
    }

    if (enforceThrottle) {
      const syncThrottle = await tryAcquireEventSyncThrottle(
        eventId,
        requesterUid,
      );
      if (!syncThrottle) {
        syncLog.skipped = true;
        syncLog.reason = "rate-limited";
        return buildSkippedSyncResponse({
          eventId,
          reason: "rate-limited",
        });
      }
    }

    lockHandle = await acquireEventLockWithRetry(eventId, requesterUid, {
      attempts: 10,
      delayMs: 100,
    });
    if (!lockHandle) {
      syncLog.skipped = true;
      syncLog.reason = "locked";
      return buildSkippedSyncResponse({
        eventId,
        reason: "locked",
      });
    }
    stopLockHeartbeat = startEventLockHeartbeat(lockHandle);

    const lockedEventSnapshot = await admin
      .database()
      .ref(`events/${eventId}`)
      .once("value");
    if (!lockedEventSnapshot.exists()) {
      throw new HttpsError("not-found", "Event not found.");
    }
    const event = cloneValue(lockedEventSnapshot.val() || {});
    if (enforceParticipantGate) {
      const lockedRequesterParticipation = resolveRequesterParticipation(
        event,
        auth,
      );
      syncLog.requesterProfileId = lockedRequesterParticipation.profileId;
      if (!lockedRequesterParticipation.isParticipant) {
        syncLog.skipped = true;
        syncLog.reason = "not-participant";
        return buildSkippedSyncResponse({
          eventId,
          reason: "not-participant",
        });
      }
    }
    const nowMs = getNowMs();
    const updates = {};
    let didChange = false;
    let eventPrizeAssignmentsForProjectionCleanup = null;

    if (event.status === "scheduled") {
      const dueTransition = await buildScheduledEventDueUpdates({
        eventId,
        event,
        nowMs,
      });
      Object.assign(updates, dueTransition.updates);
      didChange = dueTransition.didChange;
    } else if (event.status === "active") {
      const normalizedOriginalCurrentRoundIndex = toFiniteInteger(
        event.currentRoundIndex,
        NaN,
      );
      const originalCurrentRoundIndex = Number.isFinite(
        normalizedOriginalCurrentRoundIndex,
      )
        ? normalizedOriginalCurrentRoundIndex
        : null;
      const originalStatus = normalizeString(event.status) || "active";
      const originalEndedAtMs =
        typeof event.endedAtMs === "number"
          ? Math.floor(event.endedAtMs)
          : null;
      const originalWinnerProfileId = normalizeStringOrNull(
        event.winnerProfileId,
      );
      const originalWinnerDisplayName = normalizeStringOrNull(
        event.winnerDisplayName,
      );
      const rounds = cloneValue(
        event.rounds && typeof event.rounds === "object" ? event.rounds : {},
      );
      let participants = cloneValue(
        event.participants && typeof event.participants === "object"
          ? event.participants
          : {},
      );
      const supportsThirdPlaceMatch = hasThirdPlaceMatchField(event);
      let thirdPlaceMatch =
        supportsThirdPlaceMatch &&
        event.thirdPlaceMatch &&
        typeof event.thirdPlaceMatch === "object"
          ? cloneValue(event.thirdPlaceMatch)
          : null;
      const inviteUpdates = {};
      let roundsChanged = false;
      let participantsChanged = false;
      let thirdPlaceMatchChanged = false;
      const sortedRoundIndexes = getSortedRoundIndexes(rounds);
      for (const roundIndex of sortedRoundIndexes) {
        const round = rounds[String(roundIndex)];
        if (!round || !round.matches || typeof round.matches !== "object") {
          continue;
        }
        const resolvedEntries = await resolveRoundMatchesWithConcurrency(
          round.matches,
        );
        for (const entry of resolvedEntries) {
          const { matchRecord, resolved } = entry;
          if (!resolved) {
            continue;
          }
          if (applyMatchResolution(matchRecord, resolved, nowMs)) {
            roundsChanged = true;
          }
        }
      }

      if (thirdPlaceMatch) {
        const resolvedThirdPlace =
          await resolveRoundMatchState(thirdPlaceMatch);
        if (
          resolvedThirdPlace &&
          applyMatchResolution(thirdPlaceMatch, resolvedThirdPlace, nowMs)
        ) {
          thirdPlaceMatchChanged = true;
        }
      }

      if (
        await reconcileBracketMatchReadiness({
          eventId,
          rounds,
          nowMs,
          participantsById: participants,
          inviteUpdates,
        })
      ) {
        roundsChanged = true;
      }

      if (supportsThirdPlaceMatch) {
        const thirdPlaceResult = await reconcileThirdPlaceMatchReadiness({
          eventId,
          rounds,
          nowMs,
          participantsById: participants,
          inviteUpdates,
          thirdPlaceMatch,
        });
        thirdPlaceMatch = thirdPlaceResult.thirdPlaceMatch;
        if (thirdPlaceResult.didChange) {
          thirdPlaceMatchChanged = true;
        }
      }

      const {
        didChange: roundStatusChanged,
        finalRoundIndex,
        earliestUnresolvedRoundIndex,
        finalRoundWinnerProfileId,
      } = recomputeRoundStatuses({
        rounds,
        nowMs,
      });
      if (roundStatusChanged) {
        roundsChanged = true;
      }

      const finalRoundCompleted =
        finalRoundIndex !== null && earliestUnresolvedRoundIndex === null;
      const thirdPlaceResolved =
        !supportsThirdPlaceMatch ||
        !thirdPlaceMatch ||
        isMatchResolved(thirdPlaceMatch);
      const eventShouldEnd = finalRoundCompleted && thirdPlaceResolved;
      const winnerProfileId =
        normalizeString(finalRoundWinnerProfileId) || null;
      const nextCurrentRoundIndex =
        earliestUnresolvedRoundIndex !== null
          ? earliestUnresolvedRoundIndex
          : finalRoundIndex;
      event.currentRoundIndex = nextCurrentRoundIndex;

      const participantStateResult = rebuildParticipantStatesFromRounds({
        participantsById: participants,
        rounds,
        winnerProfileId,
        eventEnded: eventShouldEnd,
      });
      if (participantStateResult.didChange) {
        participants = participantStateResult.participantsById;
        participantsChanged = true;
      }

      if (eventShouldEnd) {
        const winnerParticipant =
          (winnerProfileId && participants[winnerProfileId]) || null;
        event.status = "ended";
        if (typeof event.endedAtMs !== "number") {
          event.endedAtMs = nowMs;
        }
        event.winnerProfileId = winnerProfileId;
        event.winnerDisplayName = winnerParticipant
          ? winnerParticipant.displayName
          : null;
        if (eventId === PRIZES_EVENT_ID) {
          if (typeof event.prizeSelectionsLockedAtMs !== "number") {
            const lockOwned = await isEventLockStillOwned(lockHandle);
            if (!lockOwned) {
              throw new HttpsError(
                "aborted",
                "Event lock expired while assigning prizes.",
              );
            }
            event.prizeSelectionsLockedAtMs = nowMs;
            await admin
              .database()
              .ref(`events/${eventId}/prizeSelectionsLockedAtMs`)
              .set(nowMs);
          }
          const prizeAssignmentResult = await resolveEventPrizeAssignments({
            eventId,
            event,
            rounds,
            participantsById: participants,
            thirdPlaceMatch,
            assignedAtMs: event.endedAtMs,
          });
          if (Object.keys(prizeAssignmentResult.assignments).length > 0) {
            eventPrizeAssignmentsForProjectionCleanup =
              prizeAssignmentResult.assignments;
            event.prizeAssignments = prizeAssignmentResult.assignments;
            await addEventPrizeAssignmentUpdates({
              updates,
              eventId,
              assignments: prizeAssignmentResult.assignments,
              includeEventAssignments: true,
            });
          }
        }
      } else {
        event.status = "active";
        event.endedAtMs = null;
        event.winnerProfileId = null;
        event.winnerDisplayName = null;
      }

      let eventChanged = false;
      const normalizedCurrentRoundIndex =
        typeof event.currentRoundIndex === "number"
          ? Math.floor(event.currentRoundIndex)
          : null;
      if (normalizedCurrentRoundIndex !== originalCurrentRoundIndex) {
        updates[`events/${eventId}/currentRoundIndex`] =
          normalizedCurrentRoundIndex;
        eventChanged = true;
      }

      const normalizedStatus = normalizeString(event.status) || "active";
      if (normalizedStatus !== originalStatus) {
        updates[`events/${eventId}/status`] = normalizedStatus;
        eventChanged = true;
      }

      const normalizedEndedAtMs =
        typeof event.endedAtMs === "number"
          ? Math.floor(event.endedAtMs)
          : null;
      if (normalizedEndedAtMs !== originalEndedAtMs) {
        updates[`events/${eventId}/endedAtMs`] = normalizedEndedAtMs;
        eventChanged = true;
      }

      const normalizedWinnerProfileId = normalizeStringOrNull(
        event.winnerProfileId,
      );
      if (normalizedWinnerProfileId !== originalWinnerProfileId) {
        updates[`events/${eventId}/winnerProfileId`] =
          normalizedWinnerProfileId;
        eventChanged = true;
      }

      const normalizedWinnerDisplayName = normalizeStringOrNull(
        event.winnerDisplayName,
      );
      if (normalizedWinnerDisplayName !== originalWinnerDisplayName) {
        updates[`events/${eventId}/winnerDisplayName`] =
          normalizedWinnerDisplayName;
        eventChanged = true;
      }
      if (supportsThirdPlaceMatch && thirdPlaceMatchChanged) {
        updates[`events/${eventId}/thirdPlaceMatch`] = thirdPlaceMatch;
        eventChanged = true;
      }

      if (roundsChanged) {
        updates[`events/${eventId}/rounds`] = rounds;
      }
      if (participantsChanged) {
        updates[`events/${eventId}/participants`] = participants;
      }
      if (Object.keys(inviteUpdates).length > 0) {
        Object.assign(updates, inviteUpdates);
      }
      if (
        roundsChanged ||
        participantsChanged ||
        Object.keys(inviteUpdates).length > 0 ||
        eventChanged
      ) {
        updates[`events/${eventId}/updatedAtMs`] = nowMs;
        didChange = true;
      }
    } else if (event.status === "ended") {
      const rounds = cloneValue(
        event.rounds && typeof event.rounds === "object" ? event.rounds : {},
      );
      const supportsThirdPlaceMatch = hasThirdPlaceMatchField(event);
      let thirdPlaceMatch =
        supportsThirdPlaceMatch &&
        event.thirdPlaceMatch &&
        typeof event.thirdPlaceMatch === "object"
          ? cloneValue(event.thirdPlaceMatch)
          : null;
      let roundsChanged = false;
      let thirdPlaceMatchChanged = false;
      let prizeStateChanged = false;
      const sortedRoundIndexes = getSortedRoundIndexes(rounds);
      for (const roundIndex of sortedRoundIndexes) {
        const round = rounds[String(roundIndex)];
        if (!round || !round.matches || typeof round.matches !== "object") {
          continue;
        }
        const resolvedEntries = await resolveRoundMatchesWithConcurrency(
          round.matches,
        );
        for (const entry of resolvedEntries) {
          const { matchRecord, resolved } = entry;
          if (!resolved) {
            continue;
          }
          if (applyMatchResolution(matchRecord, resolved, nowMs)) {
            roundsChanged = true;
          }
        }
      }

      if (thirdPlaceMatch) {
        const resolvedThirdPlace =
          await resolveRoundMatchState(thirdPlaceMatch);
        if (
          resolvedThirdPlace &&
          applyMatchResolution(thirdPlaceMatch, resolvedThirdPlace, nowMs)
        ) {
          thirdPlaceMatchChanged = true;
        }
      }

      if (supportsThirdPlaceMatch) {
        const thirdPlaceResult = await reconcileThirdPlaceMatchReadiness({
          eventId,
          rounds,
          nowMs,
          participantsById:
            event.participants && typeof event.participants === "object"
              ? event.participants
              : {},
          inviteUpdates: {},
          thirdPlaceMatch,
          allowInviteCreation: false,
        });
        thirdPlaceMatch = thirdPlaceResult.thirdPlaceMatch;
        if (thirdPlaceResult.didChange) {
          thirdPlaceMatchChanged = true;
        }
      }

      if (eventId === PRIZES_EVENT_ID) {
        if (typeof event.prizeSelectionsLockedAtMs !== "number") {
          updates[`events/${eventId}/prizeSelectionsLockedAtMs`] =
            typeof event.endedAtMs === "number" ? event.endedAtMs : nowMs;
          prizeStateChanged = true;
        }
        const prizeAssignmentResult = await resolveEventPrizeAssignments({
          eventId,
          event,
          rounds,
          participantsById:
            event.participants && typeof event.participants === "object"
              ? event.participants
              : {},
          thirdPlaceMatch,
          assignedAtMs:
            typeof event.endedAtMs === "number" ? event.endedAtMs : nowMs,
        });
        if (Object.keys(prizeAssignmentResult.assignments).length > 0) {
          eventPrizeAssignmentsForProjectionCleanup =
            prizeAssignmentResult.assignments;
          if (prizeAssignmentResult.didCreate) {
            await addEventPrizeAssignmentUpdates({
              updates,
              eventId,
              assignments: prizeAssignmentResult.assignments,
              includeEventAssignments: true,
            });
            prizeStateChanged = true;
          } else {
            const projectionUpdates =
              await getMissingEventPrizeProjectionUpdates({
                eventId,
                assignments: prizeAssignmentResult.assignments,
              });
            if (Object.keys(projectionUpdates).length > 0) {
              Object.assign(updates, projectionUpdates);
              prizeStateChanged = true;
            }
          }
        }
      }

      if (roundsChanged || thirdPlaceMatchChanged) {
        updates[`events/${eventId}/rounds`] = rounds;
        if (supportsThirdPlaceMatch) {
          updates[`events/${eventId}/thirdPlaceMatch`] = thirdPlaceMatch;
        }
      }
      if (roundsChanged || thirdPlaceMatchChanged || prizeStateChanged) {
        updates[`events/${eventId}/updatedAtMs`] = nowMs;
        didChange = true;
      }
    }

    if (didChange) {
      const lockOwned = await isEventLockStillOwned(lockHandle);
      if (!lockOwned) {
        const latestSnapshot = await admin
          .database()
          .ref(`events/${eventId}`)
          .once("value");
        syncLog.skipped = true;
        syncLog.reason = "locked";
        return buildSkippedSyncResponse({
          eventId,
          reason: "locked",
          event: latestSnapshot.val(),
        });
      }
      await admin.database().ref().update(updates);
    }
    const projectionCleanupRequest =
      getCompletedEventPrizeProjectionCleanupRequest({
        eventId,
        eventStatus: event.status,
        assignments: eventPrizeAssignmentsForProjectionCleanup,
      });
    if (projectionCleanupRequest) {
      await removeCompletedEventPrizeProjections(projectionCleanupRequest);
    }

    const refreshedSnapshot = await admin
      .database()
      .ref(`events/${eventId}`)
      .once("value");
    syncLog.didChange = didChange;
    return {
      ok: true,
      eventId,
      didChange,
      event: refreshedSnapshot.val(),
    };
  } catch (error) {
    if (!syncLog.reason) {
      syncLog.reason =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "error";
    }
    throw error;
  } finally {
    if (lockHandle) {
      stopLockHeartbeat();
      await releaseEventLock(lockHandle);
    }
  }
};

exports.syncEventState = onCall(
  {
    maxInstances: 20,
    concurrency: 20,
    memory: "512MiB",
    timeoutSeconds: 30,
  },
  async (request) => {
    const startedAtMs = getNowMs();
    const eventId = normalizeString(request.data && request.data.eventId);
    const syncLog = createSyncLog({
      eventId: eventId || null,
      requesterUid: request && request.auth ? request.auth.uid : null,
      mode: "callable",
    });
    try {
      if (!request.auth) {
        throw new HttpsError(
          "unauthenticated",
          "The function must be called while authenticated.",
        );
      }
      if (!eventId) {
        throw new HttpsError("invalid-argument", "eventId is required.");
      }
      return await runEventSyncState({
        eventId,
        requesterUid: request.auth.uid,
        auth: request.auth,
        enforceParticipantGate: true,
        enforceThrottle: true,
        syncLog,
      });
    } finally {
      syncLog.durationMs = getNowMs() - startedAtMs;
      logSyncEventStateResult(syncLog);
    }
  },
);

exports.processEventProgress = onTaskDispatched(
  {
    maxInstances: 20,
    concurrency: 20,
    memory: "512MiB",
    timeoutSeconds: 30,
    retryConfig: {
      maxAttempts: 12,
      minBackoffSeconds: 1,
      maxBackoffSeconds: 30,
      maxDoublings: 5,
    },
  },
  async (request) => {
    const payload = request && request.data ? request.data : {};
    const eventId = normalizeString(payload.eventId);
    const sourceKey = normalizeString(payload.sourceKey);
    const reason = normalizeString(payload.reason) || "progress";
    if (!eventId) {
      console.error("event:progress:task:invalid-payload", {
        sourceKey,
        reason,
      });
      return;
    }

    const startedAtMs = getNowMs();
    const syncLog = createSyncLog({
      eventId,
      requesterUid: EVENT_PROGRESS_WORKER_UID,
      mode: "worker",
    });
    syncLog.sourceKey = sourceKey || null;
    syncLog.triggerReason = reason;
    syncLog.taskId = request && request.id ? request.id : null;

    try {
      const result = await runEventSyncState({
        eventId,
        requesterUid: EVENT_PROGRESS_WORKER_UID,
        auth: null,
        enforceParticipantGate: false,
        enforceThrottle: false,
        syncLog,
      });
      if (result && result.skipped && result.reason === "locked") {
        const lockedError = new Error("locked");
        lockedError.code = "locked";
        throw lockedError;
      }
    } catch (error) {
      const errorCode =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "error";
      syncLog.reason = syncLog.reason || errorCode;
      if (errorCode === "not-found") {
        syncLog.skipped = true;
        return;
      }
      throw error;
    } finally {
      syncLog.durationMs = getNowMs() - startedAtMs;
      logSyncEventStateResult(syncLog);
    }
  },
);

exports.processEventProgressFallback = onValueWritten(
  {
    ref: "/eventProgressFallback/{eventId}/{signalId}",
    maxInstances: 20,
    concurrency: 20,
    memory: "512MiB",
    timeoutSeconds: 30,
    retry: true,
  },
  async (event) => {
    const eventId = normalizeString(event.params.eventId);
    const signalId = normalizeString(event.params.signalId);
    if (!eventId || !signalId || !event.data.after.exists()) {
      return;
    }

    const signalRef = admin
      .database()
      .ref(`eventProgressFallback/${eventId}/${signalId}`);
    const liveSignalSnapshot = await signalRef.once("value");
    if (!liveSignalSnapshot.exists()) {
      return;
    }
    const payload =
      liveSignalSnapshot.val() && typeof liveSignalSnapshot.val() === "object"
        ? liveSignalSnapshot.val()
        : {};
    const sourceKey = normalizeString(payload.sourceKey) || signalId;
    const reason = normalizeString(payload.reason) || "fallback";

    const startedAtMs = getNowMs();
    const syncLog = createSyncLog({
      eventId,
      requesterUid: `${EVENT_PROGRESS_WORKER_UID}-fallback`,
      mode: "worker-fallback",
    });
    syncLog.sourceKey = sourceKey;
    syncLog.triggerReason = reason;
    syncLog.signalId = signalId;

    try {
      const result = await runEventSyncState({
        eventId,
        requesterUid: `${EVENT_PROGRESS_WORKER_UID}-fallback`,
        auth: null,
        enforceParticipantGate: false,
        enforceThrottle: false,
        syncLog,
      });
      if (result && result.skipped && result.reason === "locked") {
        const lockedError = new Error("locked");
        lockedError.code = "locked";
        throw lockedError;
      }
      await clearEventProgressFallbackSignal(eventId, signalId);
    } catch (error) {
      const errorCode =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "error";
      syncLog.reason = syncLog.reason || errorCode;
      if (errorCode === "not-found") {
        syncLog.skipped = true;
        await clearEventProgressFallbackSignal(eventId, signalId);
        return;
      }
      throw error;
    } finally {
      syncLog.durationMs = getNowMs() - startedAtMs;
      logSyncEventStateResult(syncLog);
    }
  },
);
