"use strict";

const crypto = require("node:crypto");
const {
  buildParticipantRenderKey,
  getParticipantRecords,
  renderParticipantLine,
  resolveParticipantToken,
} = require("./eventParticipants");
const {
  SUNDAY_MONS_REMINDER_LEAD_MS,
  buildSundayMonsReminder,
  getSundayMonsReminderLeadMs,
} = require("./sundayMonsReminder");
const {
  buildTelegramEditUpdates,
  buildTelegramSendUpdates,
} = require("./desiredStateCore");
const { getEventPrizePlacements } = require("../events/bracket");
const {
  THIRD_PLACE_MATCH_KEY,
  resolveEventTelegramAnnouncements,
} = require("@mons/shared/events");

const EVENT_TELEGRAM_PROJECTION_ROOT = "eventTelegramProjections";
const EVENT_TELEGRAM_PROJECTION_LOCK_ROOT = "eventTelegramProjectionLocks";
const EVENT_TELEGRAM_PROJECTION_GUARD_FIELD = "eventTelegramProjectionGuard";
const EVENT_TELEGRAM_DELIVERY_VERSION = 2;
const EVENT_URL_ROOT = "https://mons.link/event";
const EVENT_STATUS_SCHEDULED = "scheduled";
const EVENT_STATUS_ENDED = "ended";
const EVENT_STATUS_DISMISSED = "dismissed";
const SUNDAY_MONS_UPCOMING_HEADING = "sunday mons soon";
const LEGACY_SUNDAY_MONS_UPCOMING_HEADING = "join sunday mons";
const DEFAULT_UPCOMING_HEADING = "upcoming event";

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

const loadEndedMatchResults = async (eventData, { readRatingUpdate } = {}) => {
  if (typeof readRatingUpdate !== "function") {
    throw new TypeError("event Telegram score loading requires rating reads");
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
      readRatingUpdate(`${inviteId}__${inviteId}`),
    ),
  );
  for (let index = 0; index < scoreRequests.length; index += 1) {
    const { entry, inviteId, hostLoginUid, guestLoginUid } =
      scoreRequests[index];
    const result = snapshots[index] || {};
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
  const announcements = resolveEventTelegramAnnouncements(eventData);
  const active = !isTerminalStatus(status);
  const upcomingEnabled = announcements.invite && active;
  const includeDateLine = Boolean(
    upcomingEnabled &&
    status === EVENT_STATUS_SCHEDULED &&
    startAtMs &&
    shouldIncludeUtcDateLine(startAtMs, nowMs),
  );
  return JSON.stringify({
    deliveryVersion: EVENT_TELEGRAM_DELIVERY_VERSION,
    telegramAnnouncements: announcements,
    status,
    startAtMs: startAtMs || null,
    upcoming:
      upcomingEnabled && status === EVENT_STATUS_SCHEDULED && startAtMs
        ? {
            ptEtUtcLine: formatPtEtUtcLine(startAtMs),
            includeDateLine,
            dateLine: includeDateLine ? formatUtcDateLine(startAtMs) : "",
            participantRenderKey: buildParticipantRenderKey(eventData),
          }
        : null,
    startedMatchKey:
      announcements.matches && active
        ? buildStartedThreadMatchKey(eventData)
        : "",
  });
};

const renderUpcomingMessage = (
  eventId,
  eventData,
  nowMs = Date.now(),
  heading = eventData?.isSundayMons === true
    ? SUNDAY_MONS_UPCOMING_HEADING
    : DEFAULT_UPCOMING_HEADING,
) => {
  const status = normalizeString(eventData && eventData.status);
  const startAtMs = normalizePositiveNumberOrNull(
    eventData && eventData.startAtMs,
  );
  if (status !== EVENT_STATUS_SCHEDULED || !startAtMs) {
    return null;
  }
  const lines = [
    heading,
    "",
    `${EVENT_URL_ROOT}/${eventId}`,
    "",
    formatPtEtUtcLine(startAtMs),
  ];
  if (shouldIncludeUtcDateLine(startAtMs, nowMs)) {
    lines.push("", formatUtcDateLine(startAtMs));
  }
  const participantLine = renderParticipantLine(eventData);
  if (participantLine) {
    lines.push("", participantLine);
  }
  return lines.join("\n");
};

const renderStartedMessage = (
  eventId,
  matchLines,
  heading = "event started",
) => {
  const lines = [heading, "", `${EVENT_URL_ROOT}/${eventId}`];
  if (Array.isArray(matchLines) && matchLines.length > 0) {
    lines.push("", ...matchLines);
  }
  return lines.join("\n");
};

const renderEndedMessage = (
  eventId,
  matchLines,
  placementLines,
  heading = "event complete",
) => {
  const lines = [heading, "", `${EVENT_URL_ROOT}/${eventId}`];
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
    reminderText: normalizeText(value.reminderText),
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
    text:
      lines.length > 0
        ? renderStartedMessage(
            eventId,
            lines,
            eventData?.isSundayMons === true
              ? "sunday mons starting now!"
              : "event started",
          )
        : null,
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
    return matchup;
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
    text: renderEndedMessage(
      eventId,
      matchLines,
      placementLines,
      eventData?.isSundayMons === true ? "good games" : "event complete",
    ),
    matchLines,
    placementLines,
  };
};

const hashProjection = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const parseUpcomingHeading = (text) => {
  const heading = normalizeText(text).split("\n", 1)[0];
  return heading === SUNDAY_MONS_UPCOMING_HEADING ||
    heading === LEGACY_SUNDAY_MONS_UPCOMING_HEADING ||
    heading === DEFAULT_UPCOMING_HEADING
    ? heading
    : "";
};

const parseEventMessage = (eventId, channel, raw) => {
  const value = raw && typeof raw === "object" ? raw : {};
  const matchesTarget = (record) =>
    record &&
    record.instanceKey === `event:${eventId}:${channel}:v2` &&
    record.destination === "community";
  const hasAppliedMessage = Boolean(
    matchesTarget(value.applied) &&
    Number.isSafeInteger(value.applied.messageId) &&
    value.applied.messageId > 0,
  );
  const desiredText =
    matchesTarget(value.desired) &&
    (value.desired.operation === "send" || value.desired.operation === "edit")
      ? normalizeText(value.desired.text)
      : "";
  const confirmedDesiredText =
    hasAppliedMessage &&
    desiredText &&
    ((normalizeString(value.applied.contentHash) &&
      value.applied.contentHash === value.desired.contentHash) ||
      (normalizeString(value.applied.revision) &&
        value.applied.revision === value.desired.revision))
      ? desiredText
      : "";
  return {
    hasAppliedMessage,
    desiredText,
    confirmedDesiredText,
    identity: hasAppliedMessage
      ? {
          destination: value.applied.destination,
          instanceKey: value.applied.instanceKey,
          chatId: normalizeString(value.applied.chatId),
          messageId: value.applied.messageId,
        }
      : null,
  };
};

const buildDesiredOperation = ({
  channel,
  eventId,
  previousText,
  desiredText,
  active,
  allowSend = true,
  hasAppliedMessage = false,
}) => {
  if (desiredText) {
    const edit = Boolean(previousText || hasAppliedMessage || !allowSend);
    return {
      operation: edit ? "edit" : "send",
      channel,
      messageKey: `event:${eventId}:${channel}`,
      instanceKey: `event:${eventId}:${channel}:v2`,
      text: desiredText,
      ifMissing: edit ? (allowSend ? "send" : "skip") : null,
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
  upcomingMessage,
  reminderMessage,
  nowMs = Date.now(),
}) => {
  const normalizedEventId = normalizeString(eventId);
  if (!normalizedEventId || !isV2TelegramEvent(eventData)) {
    return { action: "skip", reason: "not-v2" };
  }
  const state = parseProjectionState(rawState);
  const status = normalizeString(eventData.status) || EVENT_STATUS_SCHEDULED;
  const announcements = resolveEventTelegramAnnouncements(eventData);
  const active = !isTerminalStatus(status);
  const upcoming = parseEventMessage(
    normalizedEventId,
    "upcoming",
    upcomingMessage,
  );
  const reminder = parseEventMessage(
    normalizedEventId,
    "reminder",
    reminderMessage,
  );
  const upcomingEnabled = announcements.invite || upcoming.hasAppliedMessage;
  const previousUpcomingText =
    upcoming.confirmedDesiredText ||
    state.upcomingText ||
    (upcoming.hasAppliedMessage || status !== EVENT_STATUS_SCHEDULED
      ? upcoming.desiredText
      : "");
  const upcomingHeading = upcoming.hasAppliedMessage
    ? parseUpcomingHeading(upcoming.confirmedDesiredText) ||
      parseUpcomingHeading(state.upcomingText) ||
      parseUpcomingHeading(upcoming.desiredText) ||
      LEGACY_SUNDAY_MONS_UPCOMING_HEADING
    : undefined;
  const previousReminderText =
    reminder.confirmedDesiredText ||
    state.reminderText ||
    (reminder.hasAppliedMessage ? reminder.desiredText : "");
  const reminderText =
    reminder.hasAppliedMessage && status === EVENT_STATUS_SCHEDULED
      ? buildSundayMonsReminder({
          eventId: normalizedEventId,
          eventData,
          leadMs:
            getSundayMonsReminderLeadMs(
              normalizedEventId,
              reminder.confirmedDesiredText,
            ) ||
            getSundayMonsReminderLeadMs(
              normalizedEventId,
              state.reminderText,
            ) ||
            getSundayMonsReminderLeadMs(
              normalizedEventId,
              reminder.desiredText,
            ) ||
            SUNDAY_MONS_REMINDER_LEAD_MS,
        }).text
      : null;
  const matchesActive = announcements.matches && active;
  const endedAnnouncementArmed =
    state.endedAnnouncementArmed || (announcements.results && active);
  const shouldRenderEnded =
    announcements.results &&
    status === EVENT_STATUS_ENDED &&
    state.endedAnnouncementArmed;
  const upcomingText =
    active && upcomingEnabled
      ? renderUpcomingMessage(
          normalizedEventId,
          eventData,
          nowMs,
          upcomingHeading,
        )
      : null;
  const startedState = matchesActive
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
  const nextUpcomingText = upcomingText || previousUpcomingText;
  const nextReminderText = reminderText || previousReminderText;
  const nextStartedText = startedState.text || state.startedText;
  const nextEndedText = endedState.text || state.endedText;
  const signature = hashProjection({
    source: buildEventSignature(eventData, nowMs),
    upcomingEnabled,
    upcomingText: nextUpcomingText,
    reminderIdentity: reminder.identity,
    reminderText: nextReminderText,
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
      previousText: previousUpcomingText,
      desiredText: upcomingText,
      active: Boolean(upcomingText),
      allowSend: announcements.invite,
      hasAppliedMessage: upcoming.hasAppliedMessage,
    }),
    buildDesiredOperation({
      channel: "reminder",
      eventId: normalizedEventId,
      previousText: reminder.hasAppliedMessage ? previousReminderText : "",
      desiredText: reminderText,
      active: Boolean(reminderText),
      allowSend: false,
      hasAppliedMessage: reminder.hasAppliedMessage,
    }),
    buildDesiredOperation({
      channel: "started",
      eventId: normalizedEventId,
      previousText: state.startedText,
      desiredText: matchesActive ? startedState.text : null,
      active: Boolean(matchesActive && startedState.text),
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
      reminderText: nextReminderText,
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

const splitEventTelegramProjectionUpdates = ({ eventId, updates }) => {
  const statePath = `${EVENT_TELEGRAM_PROJECTION_ROOT}/${eventId}`;
  const desiredUpdates = {};
  const stateUpdates = {};
  for (const [path, value] of Object.entries(updates)) {
    if (path === statePath) {
      stateUpdates[path] = value;
    } else {
      desiredUpdates[path] = value;
    }
  }
  if (Object.keys(stateUpdates).length !== 1) {
    throw new TypeError("event Telegram projection state update is required");
  }
  return { desiredUpdates, stateUpdates };
};

const buildEventTelegramDispatches = ({ eventId, desiredUpdates }) => {
  const messagePathPrefix = "telegramMessages/";
  const desiredPathSuffix = "/desired";
  return Object.entries(desiredUpdates).map(([path, desired]) => {
    const messageKey =
      path.startsWith(messagePathPrefix) && path.endsWith(desiredPathSuffix)
        ? path.slice(messagePathPrefix.length, -desiredPathSuffix.length)
        : "";
    const revision = normalizeString(desired && desired.revision);
    if (!messageKey || !revision) {
      throw new TypeError("invalid event Telegram desired update");
    }
    return {
      messageKey,
      revision,
      generation: `event:${eventId}:${revision}`,
    };
  });
};

module.exports = {
  EVENT_TELEGRAM_DELIVERY_VERSION,
  EVENT_TELEGRAM_PROJECTION_GUARD_FIELD,
  EVENT_TELEGRAM_PROJECTION_LOCK_ROOT,
  EVENT_TELEGRAM_PROJECTION_ROOT,
  addEventTelegramProjectionGuard,
  buildEndedState,
  buildEventSignature,
  buildEventTelegramDispatches,
  buildEventTelegramProjection,
  buildEventTelegramProjectionUpdates,
  buildStartedState,
  formatPtEtUtcLine,
  isV2TelegramEvent,
  loadEndedMatchResults,
  parseProjectionState,
  renderEndedMessage,
  renderStartedMessage,
  renderUpcomingMessage,
  splitEventTelegramProjectionUpdates,
};
