// Generated from src/telegram/desiredStateCore.ts. Run npm run generate:runtime.
"use strict";
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (
          !desc ||
          ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)
        ) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __setModuleDefault =
  (this && this.__setModuleDefault) ||
  (Object.create
    ? function (o, v) {
        Object.defineProperty(o, "default", { enumerable: true, value: v });
      }
    : function (o, v) {
        o["default"] = v;
      });
var __importStar =
  (this && this.__importStar) ||
  (function () {
    var ownKeys = function (o) {
      ownKeys =
        Object.getOwnPropertyNames ||
        function (o) {
          var ar = [];
          for (var k in o)
            if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
          return ar;
        };
      return ownKeys(o);
    };
    return function (mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null)
        for (var k = ownKeys(mod), i = 0; i < k.length; i++)
          if (k[i] !== "default") __createBinding(result, mod, k[i]);
      __setModuleDefault(result, mod);
      return result;
    };
  })();
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateTelegramMessageKey =
  exports.resolveTelegramDestination =
  exports.buildTelegramSendDesired =
  exports.buildTelegramEditDesired =
  exports.buildTelegramDeleteDesired =
  exports.TELEGRAM_SCHEMA_VERSION =
  exports.TELEGRAM_MESSAGE_ROOT =
  exports.TELEGRAM_DESTINATIONS =
    void 0;
const crypto = __importStar(require("node:crypto"));
const TELEGRAM_MESSAGE_ROOT = "telegramMessages";
exports.TELEGRAM_MESSAGE_ROOT = TELEGRAM_MESSAGE_ROOT;
const TELEGRAM_SCHEMA_VERSION = 2;
exports.TELEGRAM_SCHEMA_VERSION = TELEGRAM_SCHEMA_VERSION;
const TELEGRAM_DESTINATIONS = Object.freeze({
  community: "community",
  events: "events",
});
exports.TELEGRAM_DESTINATIONS = TELEGRAM_DESTINATIONS;
const INVALID_RECORD_KEY_PATTERN = /[.#$/[\]\u0000-\u001f\u007f]/;
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
    INVALID_RECORD_KEY_PATTERN.test(normalized)
  ) {
    throw new TypeError("messageKey is not a safe record key");
  }
  return normalized;
};
exports.validateTelegramMessageKey = validateTelegramMessageKey;
const normalizeDestination = (destination) => {
  const normalized = normalizeString(destination);
  if (normalized !== "community" && normalized !== "events") {
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
exports.buildTelegramSendDesired = buildTelegramSendDesired;
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
exports.buildTelegramEditDesired = buildTelegramEditDesired;
const buildTelegramDeleteDesired = ({ destination, sourceRevision }) =>
  finalizeDesired({
    schemaVersion: TELEGRAM_SCHEMA_VERSION,
    operation: "delete",
    destination: normalizeDestination(destination),
    sourceRevision: normalizeSourceRevision(sourceRevision),
  });
exports.buildTelegramDeleteDesired = buildTelegramDeleteDesired;
const resolveTelegramDestination = (destination, environment = process.env) => {
  if (
    destination === TELEGRAM_DESTINATIONS.community ||
    destination === TELEGRAM_DESTINATIONS.events
  ) {
    return normalizeString(environment.TELEGRAM_EXTRA_CHAT_ID);
  }
  return "";
};
exports.resolveTelegramDestination = resolveTelegramDestination;
