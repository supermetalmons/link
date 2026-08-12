"use strict";

const crypto = require("crypto");
const admin = require("../firebaseAdmin");

const TELEGRAM_MESSAGE_ROOT = "telegramMessages";
const TELEGRAM_SCHEMA_VERSION = 2;
const TELEGRAM_DESTINATIONS = Object.freeze({
  community: "community",
  events: "events",
});
const FIREBASE_FORBIDDEN_KEY_PATTERN = /[.#$\/\[\]\u0000-\u001f\u007f]/;

const normalizeString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const hashValue = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

const buildContentHash = ({
  destination,
  text,
  parseMode,
  silent,
  disableWebPagePreview,
}) =>
  hashValue(
    JSON.stringify({
      destination,
      text,
      parseMode: parseMode || null,
      silent: silent === true,
      disableWebPagePreview: disableWebPagePreview !== false,
    }),
  );

const validateTelegramMessageKey = (messageKey) => {
  const normalized = normalizeString(messageKey);
  if (!normalized || normalized !== messageKey) {
    throw new TypeError("messageKey must be a non-empty trimmed string");
  }
  if (
    Buffer.byteLength(normalized, "utf8") > 512 ||
    FIREBASE_FORBIDDEN_KEY_PATTERN.test(normalized)
  ) {
    throw new TypeError("messageKey is not a safe Firebase key");
  }
  return normalized;
};

const normalizeDestination = (destination) => {
  const normalized = normalizeString(destination);
  if (!Object.hasOwn(TELEGRAM_DESTINATIONS, normalized)) {
    throw new TypeError("destination must be community or events");
  }
  return normalized;
};

const normalizeInstanceKey = (instanceKey) => {
  const normalized = normalizeString(instanceKey);
  if (!normalized || normalized.length > 512) {
    throw new TypeError("instanceKey must be a non-empty string");
  }
  return normalized;
};

const normalizeSourceRevision = (sourceRevision) => {
  const normalized =
    typeof sourceRevision === "number" && Number.isFinite(sourceRevision)
      ? String(sourceRevision)
      : normalizeString(sourceRevision);
  if (!normalized || normalized.length > 512) {
    throw new TypeError("sourceRevision must be a non-empty string or number");
  }
  return normalized;
};

const normalizeText = (text) => {
  if (typeof text !== "string" || text.length === 0) {
    throw new TypeError("text must be a non-empty string");
  }
  return text;
};

const normalizeParseMode = (parseMode) => {
  if (parseMode === undefined || parseMode === null || parseMode === "") {
    return null;
  }
  if (parseMode !== "HTML") {
    throw new TypeError("parseMode must be HTML or null");
  }
  return parseMode;
};

const finalizeDesired = (desired) => ({
  ...desired,
  revision: hashValue(JSON.stringify(desired)),
});

const buildTelegramSendDesired = ({
  destination,
  instanceKey,
  text,
  parseMode = null,
  silent = false,
  sourceRevision,
}) => {
  const normalizedText = normalizeText(text);
  const normalizedParseMode = normalizeParseMode(parseMode);
  const normalizedDestination = normalizeDestination(destination);
  const desired = {
    schemaVersion: TELEGRAM_SCHEMA_VERSION,
    operation: "send",
    destination: normalizedDestination,
    instanceKey: normalizeInstanceKey(instanceKey),
    text: normalizedText,
    silent: silent === true,
    disableWebPagePreview: true,
    sourceRevision: normalizeSourceRevision(sourceRevision),
    contentHash: buildContentHash({
      destination: normalizedDestination,
      text: normalizedText,
      parseMode: normalizedParseMode,
      silent,
      disableWebPagePreview: true,
    }),
  };
  if (normalizedParseMode) {
    desired.parseMode = normalizedParseMode;
  }
  return finalizeDesired(desired);
};

const buildTelegramEditDesired = ({
  destination,
  instanceKey,
  text,
  parseMode = null,
  silent = false,
  ifMissing = "skip",
  sourceRevision,
}) => {
  const normalizedText = normalizeText(text);
  const normalizedParseMode = normalizeParseMode(parseMode);
  if (ifMissing !== "send" && ifMissing !== "skip") {
    throw new TypeError("ifMissing must be send or skip");
  }
  const normalizedDestination = normalizeDestination(destination);
  const desired = {
    schemaVersion: TELEGRAM_SCHEMA_VERSION,
    operation: "edit",
    destination: normalizedDestination,
    instanceKey: normalizeInstanceKey(instanceKey),
    text: normalizedText,
    silent: silent === true,
    disableWebPagePreview: true,
    ifMissing,
    sourceRevision: normalizeSourceRevision(sourceRevision),
    contentHash: buildContentHash({
      destination: normalizedDestination,
      text: normalizedText,
      parseMode: normalizedParseMode,
      silent,
      disableWebPagePreview: true,
    }),
  };
  if (normalizedParseMode) {
    desired.parseMode = normalizedParseMode;
  }
  return finalizeDesired(desired);
};

const buildTelegramDeleteDesired = ({ destination, sourceRevision }) =>
  finalizeDesired({
    schemaVersion: TELEGRAM_SCHEMA_VERSION,
    operation: "delete",
    destination: normalizeDestination(destination),
    sourceRevision: normalizeSourceRevision(sourceRevision),
  });

const buildDesiredUpdates = (messageKey, desired) => ({
  [`${TELEGRAM_MESSAGE_ROOT}/${validateTelegramMessageKey(messageKey)}/desired`]:
    desired,
});

const buildTelegramSendUpdates = ({ messageKey, ...desiredInput }) =>
  buildDesiredUpdates(messageKey, buildTelegramSendDesired(desiredInput));

const buildTelegramEditUpdates = ({ messageKey, ...desiredInput }) =>
  buildDesiredUpdates(messageKey, buildTelegramEditDesired(desiredInput));

const buildTelegramDeleteUpdates = ({ messageKey, ...desiredInput }) =>
  buildDesiredUpdates(messageKey, buildTelegramDeleteDesired(desiredInput));

const persistDesiredUpdates = async (messageKey, updates, database) => {
  await database.ref().update(updates);
  const desired = Object.values(updates)[0];
  return {
    messageKey: validateTelegramMessageKey(messageKey),
    revision: desired.revision,
    desired,
  };
};

const queueTelegramSend = (input, dependencies = {}) =>
  persistDesiredUpdates(
    input.messageKey,
    buildTelegramSendUpdates(input),
    dependencies.database || admin.database(),
  );

const queueTelegramEdit = (input, dependencies = {}) =>
  persistDesiredUpdates(
    input.messageKey,
    buildTelegramEditUpdates(input),
    dependencies.database || admin.database(),
  );

const queueTelegramDelete = (input, dependencies = {}) =>
  persistDesiredUpdates(
    input.messageKey,
    buildTelegramDeleteUpdates(input),
    dependencies.database || admin.database(),
  );

const resolveTelegramDestination = (destination, environment = process.env) => {
  if (destination === TELEGRAM_DESTINATIONS.community) {
    return normalizeString(environment.TELEGRAM_EXTRA_CHAT_ID);
  }
  if (destination === TELEGRAM_DESTINATIONS.events) {
    return normalizeString(environment.TELEGRAM_EXTRA_CHAT_ID);
  }
  return "";
};

module.exports = {
  TELEGRAM_DESTINATIONS,
  TELEGRAM_MESSAGE_ROOT,
  TELEGRAM_SCHEMA_VERSION,
  buildTelegramDeleteDesired,
  buildTelegramDeleteUpdates,
  buildTelegramEditDesired,
  buildTelegramEditUpdates,
  buildTelegramSendDesired,
  buildTelegramSendUpdates,
  queueTelegramDelete,
  queueTelegramEdit,
  queueTelegramSend,
  resolveTelegramDestination,
  validateTelegramMessageKey,
};
