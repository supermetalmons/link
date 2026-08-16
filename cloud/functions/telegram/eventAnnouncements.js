"use strict";

const crypto = require("node:crypto");
const admin = require("../firebaseAdmin");
const {
  onValueCreated,
  onValueUpdated,
} = require("firebase-functions/v2/database");
const { getTelegramEmojiTag } = require("../telegramDisplay");
const { customTelegramEmojis } = require("../telegramEmojiData");
const {
  buildTelegramEditUpdates,
  buildTelegramSendUpdates,
} = require("./desiredState");
const { createEventLockManager } = require("../eventLocks");
const { getEventPrizePlacements } = require("../events/bracket");
const { THIRD_PLACE_MATCH_KEY } = require("@mons/shared/events");

const EVENT_TELEGRAM_PROJECTION_ROOT = "eventTelegramProjections";
const EVENT_TELEGRAM_PROJECTION_LOCK_ROOT = "eventTelegramProjectionLocks";
const EVENT_TELEGRAM_PROJECTION_GUARD_FIELD = "eventTelegramProjectionGuard";
const EVENT_TELEGRAM_DELIVERY_VERSION = 2;
const EVENT_TELEGRAM_PROJECTION_OWNER_UID = "event-telegram-projector";
const EVENT_TELEGRAM_PROJECTION_WRITER_APP = "event-telegram-projection-writer";
const EVENT_TELEGRAM_TRIGGER_OPTIONS = {
  maxInstances: 5,
  concurrency: 20,
  memory: "256MiB",
  cpu: 1,
  retry: true,
};
const EVENT_URL_ROOT = "https://mons.link/event";
const EVENT_STATUS_SCHEDULED = "scheduled";
const EVENT_STATUS_ENDED = "ended";
const EVENT_STATUS_DISMISSED = "dismissed";

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const normalizeText = (value) =>
  typeof value === "string" && value !== "" ? value : "";

const normalizeNumberOrNull = (value) => {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.floor(numeric);
};

const normalizePositiveNumberOrNull = (value) => {
  const numeric = normalizeNumberOrNull(value);
  if (numeric === null || numeric <= 0) {
    return null;
  }
  return numeric;
};

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const toUtcDayKey = (timestampMs) => {
  const date = new Date(timestampMs);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
};

const shouldIncludeUtcDateLine = (startAtMs, nowMs = Date.now()) =>
  toUtcDayKey(startAtMs) !== toUtcDayKey(nowMs);

const formatUtcDateLine = (startAtMs) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(startAtMs));

const formatTimeInZone = (startAtMs, timeZone) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const parts = formatter.formatToParts(new Date(startAtMs));
  let hour = "";
  let minute = "";
  let dayPeriod = "";
  for (const part of parts) {
    if (part.type === "hour") {
      hour = part.value;
    } else if (part.type === "minute") {
      minute = part.value;
    } else if (part.type === "dayPeriod") {
      dayPeriod = part.value.toUpperCase();
    }
  }
  if (!hour || !dayPeriod) {
    return formatter.format(new Date(startAtMs)).toUpperCase();
  }
  if (!minute || minute === "00") {
    return `${hour} ${dayPeriod}`;
  }
  return `${hour}:${minute} ${dayPeriod}`;
};

const formatPtEtUtcLine = (startAtMs) => {
  const pt = formatTimeInZone(startAtMs, "America/Los_Angeles");
  const et = formatTimeInZone(startAtMs, "America/New_York");
  const utc = formatTimeInZone(startAtMs, "UTC");
  return `${pt} PT / ${et} ET / ${utc} UTC`;
};

const getParticipantRecords = (eventData) => {
  const participants =
    eventData &&
    eventData.participants &&
    typeof eventData.participants === "object"
      ? eventData.participants
      : {};
  return Object.entries(participants)
    .filter(
      ([profileId, participant]) =>
        typeof profileId === "string" &&
        profileId.trim() !== "" &&
        participant &&
        typeof participant === "object",
    )
    .map(([profileId, participant]) => ({ profileId, participant }))
    .sort((left, right) => {
      const leftJoined = normalizePositiveNumberOrNull(
        left.participant.joinedAtMs,
      );
      const rightJoined = normalizePositiveNumberOrNull(
        right.participant.joinedAtMs,
      );
      const leftJoinedValue = leftJoined === null ? 0 : leftJoined;
      const rightJoinedValue = rightJoined === null ? 0 : rightJoined;
      if (leftJoinedValue !== rightJoinedValue) {
        return leftJoinedValue - rightJoinedValue;
      }
      return left.profileId.localeCompare(right.profileId);
    });
};

const buildParticipantRenderKey = (eventData) =>
  getParticipantRecords(eventData)
    .map(({ profileId, participant }) => {
      const emojiId = normalizePositiveNumberOrNull(participant.emojiId);
      const joinedAtMs = normalizePositiveNumberOrNull(participant.joinedAtMs);
      const username = normalizeString(participant.username);
      const displayName = normalizeString(participant.displayName);
      return [
        profileId,
        username,
        displayName,
        emojiId === null ? "" : String(emojiId),
        joinedAtMs === null ? "" : String(joinedAtMs),
      ].join("|");
    })
    .join(";");

const resolveParticipantName = (participant, fallbackDisplayName = "") => {
  const username = normalizeString(participant && participant.username);
  if (username) {
    return username;
  }
  const displayName = normalizeString(participant && participant.displayName);
  if (displayName) {
    return displayName;
  }
  return normalizeString(fallbackDisplayName) || "anon";
};

const resolveParticipantToken = (participant, fallbackDisplayName = "") => {
  const emoji = normalizePositiveNumberOrNull(
    participant && participant.emojiId,
  );
  const customEmojiId =
    emoji === null ? "" : normalizeString(customTelegramEmojis[emoji]);
  const emojiTag = customEmojiId ? getTelegramEmojiTag(customEmojiId) : "";
  const name = escapeHtml(
    resolveParticipantName(participant, fallbackDisplayName),
  );
  return emojiTag ? `${emojiTag} ${name}` : name;
};

const getParticipantsByProfileId = (eventData) => {
  const participantsByProfileId = new Map();
  for (const { profileId, participant } of getParticipantRecords(eventData)) {
    participantsByProfileId.set(profileId, participant);
  }
  return participantsByProfileId;
};

const toMatchIndex = (matchKey) => {
  const parts = normalizeString(matchKey).split("_");
  if (parts.length !== 2) {
    return Number.MAX_SAFE_INTEGER;
  }
  const index = normalizeNumberOrNull(parts[1]);
  return index === null || index < 0 ? Number.MAX_SAFE_INTEGER : index;
};

const collectActiveMatchEntries = (eventData) => {
  const rounds =
    eventData && eventData.rounds && typeof eventData.rounds === "object"
      ? eventData.rounds
      : {};
  const entries = [];
  for (const roundKey of Object.keys(rounds)) {
    const round = rounds[roundKey];
    if (!round || typeof round !== "object") {
      continue;
    }
    const roundIndex =
      normalizeNumberOrNull(round.roundIndex) ??
      normalizeNumberOrNull(roundKey) ??
      Number.MAX_SAFE_INTEGER;
    const matches =
      round.matches && typeof round.matches === "object" ? round.matches : {};
    const sortedMatchKeys = Object.keys(matches).sort(
      (left, right) => toMatchIndex(left) - toMatchIndex(right),
    );
    for (const matchKey of sortedMatchKeys) {
      const match = matches[matchKey];
      if (!match || typeof match !== "object") {
        continue;
      }
      if (!normalizeString(match.inviteId)) {
        continue;
      }
      entries.push({
        key: `round:${roundIndex}:${matchKey}`,
        match,
        sortRank: roundIndex,
        sortIndex: toMatchIndex(matchKey),
      });
    }
  }
  const thirdPlaceMatch =
    eventData &&
    eventData.thirdPlaceMatch &&
    typeof eventData.thirdPlaceMatch === "object"
      ? eventData.thirdPlaceMatch
      : null;
  if (thirdPlaceMatch && normalizeString(thirdPlaceMatch.inviteId)) {
    entries.push({
      key: THIRD_PLACE_MATCH_KEY,
      match: thirdPlaceMatch,
      sortRank: Number.MAX_SAFE_INTEGER - 1,
      sortIndex: 0,
    });
  }
  return entries.sort((left, right) => {
    if (left.sortRank !== right.sortRank) {
      return left.sortRank - right.sortRank;
    }
    if (left.sortIndex !== right.sortIndex) {
      return left.sortIndex - right.sortIndex;
    }
    return left.key.localeCompare(right.key);
  });
};

const loadEndedMatchResults = async (eventData, { firestore } = {}) => {
  if (!firestore || typeof firestore.collection !== "function") {
    throw new TypeError("event Telegram score loading requires Firestore");
  }
  const resultsByKey = {};
  const scoreRequests = [];
  for (const entry of collectActiveMatchEntries(eventData)) {
    if (entry.match.winnerDisqualified === true) {
      resultsByKey[entry.key] = { status: "disqualified" };
      continue;
    }
    const inviteId = normalizeString(entry.match.inviteId);
    const hostLoginUid = normalizeString(entry.match.hostLoginUid);
    const guestLoginUid = normalizeString(entry.match.guestLoginUid);
    if (!inviteId || !hostLoginUid || !guestLoginUid) {
      resultsByKey[entry.key] = { status: "unavailable" };
      continue;
    }
    scoreRequests.push({ entry, inviteId, hostLoginUid, guestLoginUid });
  }
  if (scoreRequests.length === 0) {
    return resultsByKey;
  }
  const snapshots = await Promise.all(
    scoreRequests.map(({ inviteId }) =>
      firestore
        .collection("ratingUpdates")
        .doc(`${inviteId}__${inviteId}`)
        .get(),
    ),
  );
  for (let index = 0; index < scoreRequests.length; index += 1) {
    const { entry, inviteId, hostLoginUid, guestLoginUid } =
      scoreRequests[index];
    const snapshot = snapshots[index];
    const result = snapshot.exists ? snapshot.data() || {} : {};
    if (
      result.status !== "done" ||
      normalizeString(result.inviteId) !== inviteId ||
      normalizeString(result.matchId) !== inviteId ||
      !Number.isFinite(result.playerManaPoints) ||
      !Number.isFinite(result.opponentManaPoints)
    ) {
      resultsByKey[entry.key] = { status: "unavailable" };
      continue;
    }
    const playerId = normalizeString(result.playerId);
    const opponentId = normalizeString(result.opponentId);
    const playerIsHost =
      playerId === hostLoginUid && opponentId === guestLoginUid;
    const playerIsGuest =
      playerId === guestLoginUid && opponentId === hostLoginUid;
    if (!playerIsHost && !playerIsGuest) {
      resultsByKey[entry.key] = { status: "unavailable" };
      continue;
    }
    resultsByKey[entry.key] = {
      status: "scored",
      hostScore: playerIsHost
        ? result.playerManaPoints
        : result.opponentManaPoints,
      guestScore: playerIsHost
        ? result.opponentManaPoints
        : result.playerManaPoints,
    };
  }
  return resultsByKey;
};

const buildStartedThreadMatchKey = (eventData) =>
  collectActiveMatchEntries(eventData)
    .map((entry) => entry.key)
    .join(";");

const isV2TelegramEvent = (eventData) =>
  Boolean(
    eventData &&
    typeof eventData === "object" &&
    eventData.telegramDeliveryVersion === EVENT_TELEGRAM_DELIVERY_VERSION,
  );

const isTerminalStatus = (status) =>
  status === EVENT_STATUS_ENDED || status === EVENT_STATUS_DISMISSED;

const buildEventSignature = (eventData, nowMs = Date.now()) => {
  if (!isV2TelegramEvent(eventData)) {
    return "skip";
  }
  const status = normalizeString(eventData.status) || EVENT_STATUS_SCHEDULED;
  const startAtMs = normalizePositiveNumberOrNull(eventData.startAtMs);
  const active =
    eventData.announceOnTelegram === true && !isTerminalStatus(status);
  const includeDateLine = Boolean(
    active &&
    status === EVENT_STATUS_SCHEDULED &&
    startAtMs &&
    shouldIncludeUtcDateLine(startAtMs, nowMs),
  );
  return JSON.stringify({
    deliveryVersion: EVENT_TELEGRAM_DELIVERY_VERSION,
    announceOnTelegram: eventData.announceOnTelegram === true,
    status,
    startAtMs: startAtMs || null,
    upcoming:
      active && status === EVENT_STATUS_SCHEDULED && startAtMs
        ? {
            ptEtUtcLine: formatPtEtUtcLine(startAtMs),
            includeDateLine,
            dateLine: includeDateLine ? formatUtcDateLine(startAtMs) : "",
            participantRenderKey: buildParticipantRenderKey(eventData),
          }
        : null,
    startedMatchKey: active ? buildStartedThreadMatchKey(eventData) : "",
  });
};

const renderUpcomingMessage = (eventId, eventData, nowMs = Date.now()) => {
  const status = normalizeString(eventData && eventData.status);
  const startAtMs = normalizePositiveNumberOrNull(
    eventData && eventData.startAtMs,
  );
  if (status !== EVENT_STATUS_SCHEDULED || !startAtMs) {
    return null;
  }
  const lines = [
    "join sunday mons",
    "",
    `${EVENT_URL_ROOT}/${eventId}`,
    "",
    formatPtEtUtcLine(startAtMs),
  ];
  if (shouldIncludeUtcDateLine(startAtMs, nowMs)) {
    lines.push("", formatUtcDateLine(startAtMs));
  }
  const participants = getParticipantRecords(eventData);
  if (participants.length >= 2) {
    const participantLine = participants
      .map(({ participant }) => resolveParticipantToken(participant))
      .join(" ");
    if (participantLine) {
      lines.push("", participantLine);
    }
  }
  return lines.join("\n");
};

const renderStartedMessage = (eventId, matchLines) => {
  const lines = ["event started", "", `${EVENT_URL_ROOT}/${eventId}`];
  if (Array.isArray(matchLines) && matchLines.length > 0) {
    lines.push("", ...matchLines);
  }
  return lines.join("\n");
};

const renderEndedMessage = (eventId, matchLines, placementLines) => {
  const lines = ["event ended", "", `${EVENT_URL_ROOT}/${eventId}`];
  if (Array.isArray(matchLines) && matchLines.length > 0) {
    lines.push("", ...matchLines);
  }
  if (Array.isArray(placementLines) && placementLines.length > 0) {
    lines.push("", ...placementLines);
  }
  return lines.join("\n");
};

const parseProjectionState = (raw) => {
  const value = raw && typeof raw === "object" ? raw : {};
  const startedMatchKeys = Array.isArray(value.startedMatchKeys)
    ? value.startedMatchKeys.filter(
        (key) => typeof key === "string" && key.trim() !== "",
      )
    : [];
  const startedMatchLinesByKey =
    value.startedMatchLinesByKey &&
    typeof value.startedMatchLinesByKey === "object"
      ? value.startedMatchLinesByKey
      : {};
  return {
    upcomingText: normalizeText(value.upcomingText),
    startedText: normalizeText(value.startedText),
    endedText: normalizeText(value.endedText),
    endedAnnouncementArmed: value.endedAnnouncementArmed === true,
    startedMatchKeys,
    startedMatchLinesByKey,
    lastProjectedSignature: normalizeString(value.lastProjectedSignature),
  };
};

const buildStartedState = (eventId, eventData, rawState = {}) => {
  const state = parseProjectionState(rawState);
  const participantsByProfileId = getParticipantsByProfileId(eventData);
  const activeMatchEntries = collectActiveMatchEntries(eventData);
  const nextOrder = [];
  const nextOrderSet = new Set();
  for (const key of state.startedMatchKeys) {
    if (!nextOrderSet.has(key)) {
      nextOrderSet.add(key);
      nextOrder.push(key);
    }
  }
  const nextLinesByKey = {};
  for (const [key, value] of Object.entries(state.startedMatchLinesByKey)) {
    if (nextOrderSet.has(key) && typeof value === "string" && value !== "") {
      nextLinesByKey[key] = value;
    }
  }
  let appendedCount = 0;
  for (const entry of activeMatchEntries) {
    const hostProfileId = normalizeString(entry.match.hostProfileId);
    const guestProfileId = normalizeString(entry.match.guestProfileId);
    const hostParticipant = participantsByProfileId.get(hostProfileId) || null;
    const guestParticipant =
      participantsByProfileId.get(guestProfileId) || null;
    const line = `${resolveParticipantToken(hostParticipant, entry.match.hostDisplayName)} vs. ${resolveParticipantToken(guestParticipant, entry.match.guestDisplayName)}`;
    if (nextOrderSet.has(entry.key)) {
      if (!nextLinesByKey[entry.key]) {
        nextLinesByKey[entry.key] = line;
      }
      continue;
    }
    nextOrder.push(entry.key);
    nextOrderSet.add(entry.key);
    nextLinesByKey[entry.key] = line;
    appendedCount += 1;
  }
  const lines = nextOrder
    .map((key) => nextLinesByKey[key])
    .filter((line) => typeof line === "string" && line !== "");
  return {
    text: lines.length > 0 ? renderStartedMessage(eventId, lines) : null,
    startedMatchKeys: nextOrder,
    startedMatchLinesByKey: nextLinesByKey,
    appendedCount,
  };
};

const buildEndedState = (eventId, eventData, resultsByKey = {}) => {
  const participantsByProfileId = getParticipantsByProfileId(eventData);
  const matchLines = collectActiveMatchEntries(eventData).map((entry) => {
    const hostProfileId = normalizeString(entry.match.hostProfileId);
    const guestProfileId = normalizeString(entry.match.guestProfileId);
    const hostParticipant = participantsByProfileId.get(hostProfileId) || null;
    const guestParticipant =
      participantsByProfileId.get(guestProfileId) || null;
    const matchup = `${resolveParticipantToken(hostParticipant, entry.match.hostDisplayName)} vs. ${resolveParticipantToken(guestParticipant, entry.match.guestDisplayName)}`;
    const result = resultsByKey[entry.key];
    if (
      entry.match.winnerDisqualified === true ||
      result?.status === "disqualified"
    ) {
      return `${matchup} (DQ)`;
    }
    if (
      result?.status === "scored" &&
      Number.isFinite(result.hostScore) &&
      Number.isFinite(result.guestScore)
    ) {
      return `${matchup} (${result.hostScore} - ${result.guestScore})`;
    }
    return `${matchup} (score unavailable)`;
  });
  const participantsById = Object.fromEntries(
    getParticipantRecords(eventData).map(({ profileId, participant }) => [
      profileId,
      participant,
    ]),
  );
  const placements = getEventPrizePlacements({
    event: eventData,
    rounds:
      eventData && eventData.rounds && typeof eventData.rounds === "object"
        ? eventData.rounds
        : {},
    participantsById,
    thirdPlaceMatch:
      eventData &&
      eventData.thirdPlaceMatch &&
      typeof eventData.thirdPlaceMatch === "object"
        ? eventData.thirdPlaceMatch
        : null,
  });
  const placementLines = placements.map(({ place, profileId }) => {
    const participant = participantsByProfileId.get(profileId) || null;
    return `${place}. ${resolveParticipantToken(participant)}`;
  });
  return {
    text: renderEndedMessage(eventId, matchLines, placementLines),
    matchLines,
    placementLines,
  };
};

const hashProjection = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const buildDesiredOperation = ({
  channel,
  eventId,
  previousText,
  desiredText,
  active,
}) => {
  if (desiredText) {
    return {
      operation: previousText ? "edit" : "send",
      channel,
      messageKey: `event:${eventId}:${channel}`,
      instanceKey: `event:${eventId}:${channel}:v2`,
      text: desiredText,
      ifMissing: previousText ? "send" : null,
    };
  }
  if (!active && previousText) {
    return {
      operation: "edit",
      channel,
      messageKey: `event:${eventId}:${channel}`,
      instanceKey: `event:${eventId}:${channel}:v2`,
      text: previousText,
      ifMissing: "skip",
    };
  }
  return null;
};

const buildEventTelegramProjection = ({
  eventId,
  eventData,
  endedMatchResults = {},
  state: rawState,
  nowMs = Date.now(),
}) => {
  const normalizedEventId = normalizeString(eventId);
  if (!normalizedEventId || !isV2TelegramEvent(eventData)) {
    return { action: "skip", reason: "not-v2" };
  }
  const state = parseProjectionState(rawState);
  const status = normalizeString(eventData.status) || EVENT_STATUS_SCHEDULED;
  const enabled = eventData.announceOnTelegram === true;
  const active = enabled && !isTerminalStatus(status);
  const endedAnnouncementArmed = state.endedAnnouncementArmed || active;
  const shouldRenderEnded =
    enabled && status === EVENT_STATUS_ENDED && state.endedAnnouncementArmed;
  const upcomingText = active
    ? renderUpcomingMessage(normalizedEventId, eventData, nowMs)
    : null;
  const startedState = active
    ? buildStartedState(normalizedEventId, eventData, state)
    : {
        text: state.startedText || null,
        startedMatchKeys: state.startedMatchKeys,
        startedMatchLinesByKey: state.startedMatchLinesByKey,
        appendedCount: 0,
      };
  const endedState = shouldRenderEnded
    ? state.endedText
      ? { text: state.endedText }
      : buildEndedState(normalizedEventId, eventData, endedMatchResults)
    : { text: state.endedText || null };
  const nextUpcomingText = upcomingText || state.upcomingText;
  const nextStartedText = startedState.text || state.startedText;
  const nextEndedText = endedState.text || state.endedText;
  const signature = hashProjection({
    source: buildEventSignature(eventData, nowMs),
    upcomingText: nextUpcomingText,
    startedText: nextStartedText,
    endedText: nextEndedText,
    endedAnnouncementArmed,
    startedMatchKeys: startedState.startedMatchKeys,
    startedMatchLinesByKey: startedState.startedMatchLinesByKey,
  });
  if (state.lastProjectedSignature === signature) {
    return { action: "unchanged", signature };
  }
  const operations = [
    buildDesiredOperation({
      channel: "upcoming",
      eventId: normalizedEventId,
      previousText: state.upcomingText,
      desiredText: upcomingText,
      active: Boolean(upcomingText),
    }),
    buildDesiredOperation({
      channel: "started",
      eventId: normalizedEventId,
      previousText: state.startedText,
      desiredText: active ? startedState.text : null,
      active: Boolean(active && startedState.text),
    }),
    buildDesiredOperation({
      channel: "ended",
      eventId: normalizedEventId,
      previousText: state.endedText,
      desiredText: shouldRenderEnded ? endedState.text : null,
      active: Boolean(shouldRenderEnded && endedState.text),
    }),
  ].filter(Boolean);
  for (const operation of operations) {
    operation.sourceRevision = `event:${normalizedEventId}:${operation.channel}:${signature}`;
  }
  return {
    action: "project",
    signature,
    operations,
    state: {
      schemaVersion: EVENT_TELEGRAM_DELIVERY_VERSION,
      upcomingText: nextUpcomingText,
      startedText: nextStartedText,
      endedText: nextEndedText,
      endedAnnouncementArmed,
      startedMatchKeys: startedState.startedMatchKeys,
      startedMatchLinesByKey: startedState.startedMatchLinesByKey,
      lastProjectedSignature: signature,
      updatedAtMs: Math.floor(nowMs),
    },
  };
};

const buildEventTelegramProjectionUpdates = ({ eventId, projection }) => {
  const normalizedEventId = normalizeString(eventId);
  if (
    !normalizedEventId ||
    !projection ||
    projection.action !== "project" ||
    !projection.state
  ) {
    return {};
  }
  const updates = {
    [`${EVENT_TELEGRAM_PROJECTION_ROOT}/${normalizedEventId}`]:
      projection.state,
  };
  for (const operation of projection.operations) {
    const common = {
      messageKey: operation.messageKey,
      destination: "community",
      instanceKey: operation.instanceKey,
      text: operation.text,
      parseMode: "HTML",
      silent: false,
      sourceRevision: operation.sourceRevision,
    };
    const desiredUpdates =
      operation.operation === "send"
        ? buildTelegramSendUpdates(common)
        : buildTelegramEditUpdates({
            ...common,
            ifMissing: operation.ifMissing,
          });
    Object.assign(updates, desiredUpdates);
  }
  return updates;
};

const addEventTelegramProjectionGuard = ({ updates, guard }) => {
  if (!guard) {
    return updates;
  }
  if (
    guard.lockRoot !== EVENT_TELEGRAM_PROJECTION_LOCK_ROOT ||
    !normalizeString(guard.eventId) ||
    !normalizeString(guard.lockId) ||
    !normalizeString(guard.ownerUid)
  ) {
    throw new TypeError("invalid event Telegram projection lock guard");
  }
  const guardedUpdates = {};
  for (const [path, value] of Object.entries(updates)) {
    const messagePathPrefix = "telegramMessages/";
    const desiredPathSuffix = "/desired";
    const messageKey =
      path.startsWith(messagePathPrefix) && path.endsWith(desiredPathSuffix)
        ? path.slice(messagePathPrefix.length, -desiredPathSuffix.length)
        : "";
    guardedUpdates[path] = {
      ...value,
      [EVENT_TELEGRAM_PROJECTION_GUARD_FIELD]: {
        ...guard,
        ...(messageKey ? { messageKey } : {}),
      },
    };
  }
  return guardedUpdates;
};

const createProjectionLockError = (eventId, code) => {
  const error = new Error(`${code}:${eventId}`);
  error.code = code;
  return error;
};

const isPermissionDeniedError = (error) => {
  const code = normalizeString(error && error.code).toLowerCase();
  const message = normalizeString(error && error.message).toLowerCase();
  return (
    code.includes("permission-denied") ||
    code.includes("permission_denied") ||
    message.includes("permission denied")
  );
};

const getEventTelegramProjectionCommitDatabase = () =>
  admin.databaseWithAuthOverride(EVENT_TELEGRAM_PROJECTION_WRITER_APP, {
    uid: EVENT_TELEGRAM_PROJECTION_OWNER_UID,
    token: {
      eventTelegramProjectionWriter: true,
    },
  });

const createEventTelegramProjector = (dependencies = {}) => {
  const getDatabase = dependencies.database
    ? () => dependencies.database
    : dependencies.getDatabase || admin.database;
  const lockManager =
    dependencies.lockManager ||
    createEventLockManager({
      getDatabase,
      lockRoot: EVENT_TELEGRAM_PROJECTION_LOCK_ROOT,
    });
  const getCommitDatabase = dependencies.commitDatabase
    ? () => dependencies.commitDatabase
    : dependencies.getCommitDatabase ||
      getEventTelegramProjectionCommitDatabase;
  const getFirestore = dependencies.firestore
    ? () => dependencies.firestore
    : dependencies.getFirestore || admin.firestore;
  const resolveEndedMatchResults =
    dependencies.loadEndedMatchResults || loadEndedMatchResults;
  const ownerUid = dependencies.ownerUid || EVENT_TELEGRAM_PROJECTION_OWNER_UID;

  return async (eventId, nowMs = Date.now()) => {
    const normalizedEventId = normalizeString(eventId);
    if (!normalizedEventId) {
      return { action: "skip", reason: "invalid-event-id" };
    }
    let lockHandle = null;
    let stopLockHeartbeat = () => {};
    try {
      lockHandle = await lockManager.acquireEventLock(
        normalizedEventId,
        ownerUid,
      );
      if (!lockHandle) {
        throw createProjectionLockError(
          normalizedEventId,
          "event-telegram-lock-busy",
        );
      }
      stopLockHeartbeat = lockManager.startEventLockHeartbeat(lockHandle);
      const database = getDatabase();
      const eventSnapshot = await database
        .ref(`events/${normalizedEventId}`)
        .once("value");
      const eventData = eventSnapshot.val();
      if (!isV2TelegramEvent(eventData)) {
        return { action: "skip", reason: "not-v2" };
      }
      const stateSnapshot = await database
        .ref(`${EVENT_TELEGRAM_PROJECTION_ROOT}/${normalizedEventId}`)
        .once("value");
      const rawState = stateSnapshot.val();
      const status = normalizeString(eventData.status);
      const endedMatchResults =
        eventData.announceOnTelegram === true &&
        status === EVENT_STATUS_ENDED &&
        rawState?.endedAnnouncementArmed === true &&
        !normalizeText(rawState?.endedText)
          ? await resolveEndedMatchResults(eventData, {
              firestore: getFirestore(),
            })
          : {};
      const projection = buildEventTelegramProjection({
        eventId: normalizedEventId,
        eventData,
        endedMatchResults,
        state: rawState,
        nowMs,
      });
      if (projection.action !== "project") {
        return projection;
      }
      const guard = lockManager.getEventLockGuard(lockHandle);
      const updates = addEventTelegramProjectionGuard({
        updates: buildEventTelegramProjectionUpdates({
          eventId: normalizedEventId,
          projection,
        }),
        guard,
      });
      const lockRefreshed = await lockManager.refreshEventLock(lockHandle);
      if (!lockRefreshed) {
        throw createProjectionLockError(
          normalizedEventId,
          "event-telegram-lock-lost",
        );
      }
      try {
        await getCommitDatabase().ref().update(updates);
      } catch (error) {
        if (isPermissionDeniedError(error)) {
          throw createProjectionLockError(
            normalizedEventId,
            "event-telegram-lock-lost",
          );
        }
        throw error;
      }
      return projection;
    } finally {
      stopLockHeartbeat();
      await lockManager.releaseEventLock(lockHandle);
    }
  };
};

const projectEventTelegram = createEventTelegramProjector();

const runEventTelegramProjection = async (eventId, trigger) => {
  try {
    await projectEventTelegram(eventId);
  } catch (error) {
    console.error("event:telegram:projection-error", {
      eventId,
      trigger,
      code: error && error.code ? String(error.code) : "error",
      error: error && error.message ? error.message : String(error),
    });
    throw error;
  }
};

const onEventTelegramCreated = onValueCreated(
  {
    ...EVENT_TELEGRAM_TRIGGER_OPTIONS,
    ref: "/events/{eventId}",
  },
  async (event) => {
    const eventId = normalizeString(event.params.eventId);
    const eventData = event.data.val();
    if (!eventId || !isV2TelegramEvent(eventData)) {
      return;
    }
    await runEventTelegramProjection(eventId, "created");
  },
);

const onEventTelegramUpdated = onValueUpdated(
  {
    ...EVENT_TELEGRAM_TRIGGER_OPTIONS,
    ref: "/events/{eventId}",
  },
  async (event) => {
    const eventId = normalizeString(event.params.eventId);
    const eventData = event.data.after.val();
    if (!eventId || !isV2TelegramEvent(eventData)) {
      return;
    }
    await runEventTelegramProjection(eventId, "updated");
  },
);

module.exports = {
  EVENT_TELEGRAM_PROJECTION_GUARD_FIELD,
  EVENT_TELEGRAM_PROJECTION_LOCK_ROOT,
  addEventTelegramProjectionGuard,
  buildEndedState,
  buildEventSignature,
  buildEventTelegramProjection,
  buildEventTelegramProjectionUpdates,
  buildStartedState,
  createEventTelegramProjector,
  formatPtEtUtcLine,
  loadEndedMatchResults,
  onEventTelegramCreated,
  onEventTelegramUpdated,
  parseProjectionState,
  projectEventTelegram,
  renderEndedMessage,
  renderStartedMessage,
  renderUpcomingMessage,
};
