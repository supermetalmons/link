import * as crypto from "node:crypto";
type DesiredInputEvidence = {
  destination?: unknown;
  instanceKey?: unknown;
  text?: unknown;
  parseMode?: unknown;
  silent?: unknown;
  sourceRevision?: unknown;
  ifMissing?: unknown;
};
export type TelegramSendDesiredInput = {
  destination: string;
  instanceKey: string;
  text: string;
  sourceRevision: string | number;
  parseMode?: "HTML" | null | "";
  silent?: boolean;
};
export type TelegramEditDesiredInput = TelegramSendDesiredInput & {
  ifMissing?: "send" | "skip";
};
export type TelegramDeleteDesiredInput = {
  destination: string;
  sourceRevision: string | number;
};
export type TelegramDesiredInput =
  | TelegramSendDesiredInput
  | TelegramEditDesiredInput
  | TelegramDeleteDesiredInput;

type DesiredIdentity = {
  schemaVersion: 2;
  destination: "community" | "events";
  revision: string;
  sourceRevision: string;
};
type TextDesired = DesiredIdentity & {
  contentHash: string;
  instanceKey: string;
  text: string;
  parseMode?: "HTML";
  silent: boolean;
  disableWebPagePreview: true;
};
export type TelegramSendDesired = TextDesired & { operation: "send" };
export type TelegramEditDesired = TextDesired & {
  operation: "edit";
  ifMissing: "send" | "skip";
};
export type TelegramDeleteDesired = DesiredIdentity & { operation: "delete" };
export type TelegramDesired =
  TelegramSendDesired | TelegramEditDesired | TelegramDeleteDesired;

const TELEGRAM_MESSAGE_ROOT = "telegramMessages";
const TELEGRAM_SCHEMA_VERSION = 2;
const TELEGRAM_DESTINATIONS = Object.freeze({
  community: "community",
  events: "events",
});
const INVALID_RECORD_KEY_PATTERN = /[.#$/[\]\u0000-\u001f\u007f]/;

const normalizeString = (value: unknown): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const hashValue = (value: unknown): string =>
  crypto.createHash("sha256").update(String(value)).digest("hex");

const buildContentHash = ({
  destination,
  text,
  parseMode,
  silent,
  disableWebPagePreview,
}: {
  destination: unknown;
  text: unknown;
  parseMode: unknown;
  silent: unknown;
  disableWebPagePreview: unknown;
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

const validateTelegramMessageKey: (messageKey: unknown) => string = (
  messageKey,
) => {
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

const normalizeDestination = (
  destination: unknown,
): TelegramDesired["destination"] => {
  const normalized = normalizeString(destination);
  if (normalized !== "community" && normalized !== "events") {
    throw new TypeError("destination must be community or events");
  }
  return normalized;
};

const normalizeInstanceKey = (instanceKey: unknown) => {
  const normalized = normalizeString(instanceKey);
  if (!normalized || normalized.length > 512) {
    throw new TypeError("instanceKey must be a non-empty string");
  }
  return normalized;
};

const normalizeSourceRevision = (sourceRevision: unknown) => {
  const normalized =
    typeof sourceRevision === "number" && Number.isFinite(sourceRevision)
      ? String(sourceRevision)
      : normalizeString(sourceRevision);
  if (!normalized || normalized.length > 512) {
    throw new TypeError("sourceRevision must be a non-empty string or number");
  }
  return normalized;
};

const normalizeText = (text: unknown) => {
  if (typeof text !== "string" || text.length === 0) {
    throw new TypeError("text must be a non-empty string");
  }
  return text;
};

const normalizeParseMode = (parseMode: unknown) => {
  if (parseMode === undefined || parseMode === null || parseMode === "") {
    return null;
  }
  if (parseMode !== "HTML") {
    throw new TypeError("parseMode must be HTML or null");
  }
  return parseMode;
};

const finalizeDesired = <
  T extends Omit<DesiredIdentity, "revision"> & {
    operation: TelegramDesired["operation"];
  },
>(
  desired: T,
): T & { revision: string } => ({
  ...desired,
  revision: hashValue(JSON.stringify(desired)),
});

const buildTelegramSendDesired: (
  input: TelegramSendDesiredInput,
) => TelegramSendDesired = ({
  destination,
  instanceKey,
  text,
  parseMode = null,
  silent = false,
  sourceRevision,
}: DesiredInputEvidence) => {
  const normalizedText = normalizeText(text);
  const normalizedParseMode = normalizeParseMode(parseMode);
  const normalizedDestination = normalizeDestination(destination);
  const desired: Omit<TelegramSendDesired, "revision"> = {
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

const buildTelegramEditDesired: (
  input: TelegramEditDesiredInput,
) => TelegramEditDesired = ({
  destination,
  instanceKey,
  text,
  parseMode = null,
  silent = false,
  ifMissing = "skip",
  sourceRevision,
}: DesiredInputEvidence) => {
  const normalizedText = normalizeText(text);
  const normalizedParseMode = normalizeParseMode(parseMode);
  if (ifMissing !== "send" && ifMissing !== "skip") {
    throw new TypeError("ifMissing must be send or skip");
  }
  const normalizedDestination = normalizeDestination(destination);
  const desired: Omit<TelegramEditDesired, "revision"> = {
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

const buildTelegramDeleteDesired: (
  input: TelegramDeleteDesiredInput,
) => TelegramDeleteDesired = ({
  destination,
  sourceRevision,
}: DesiredInputEvidence) =>
  finalizeDesired({
    schemaVersion: TELEGRAM_SCHEMA_VERSION,
    operation: "delete",
    destination: normalizeDestination(destination),
    sourceRevision: normalizeSourceRevision(sourceRevision),
  });

const resolveTelegramDestination = (
  destination: unknown,
  environment: Record<string, string | undefined> = process.env,
): string => {
  if (
    destination === TELEGRAM_DESTINATIONS.community ||
    destination === TELEGRAM_DESTINATIONS.events
  ) {
    return normalizeString(environment.TELEGRAM_EXTRA_CHAT_ID);
  }
  return "";
};

export {
  TELEGRAM_DESTINATIONS,
  TELEGRAM_MESSAGE_ROOT,
  TELEGRAM_SCHEMA_VERSION,
  buildTelegramDeleteDesired,
  buildTelegramEditDesired,
  buildTelegramSendDesired,
  resolveTelegramDestination,
  validateTelegramMessageKey,
};
