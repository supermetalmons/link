// Generated from src/telegram/recordCodec.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readTelegramDesired = readTelegramDesired;
exports.readTelegramRetryProof = readTelegramRetryProof;
exports.readTelegramCleanup = readTelegramCleanup;
exports.readTelegramDelivery = readTelegramDelivery;
exports.readTelegramMessageDocument = readTelegramMessageDocument;
exports.readTelegramControlDocument = readTelegramControlDocument;
exports.requireTelegramMessageDocument = requireTelegramMessageDocument;
exports.requireTelegramTransaction = requireTelegramTransaction;
exports.requireTelegramOrphanedDelete = requireTelegramOrphanedDelete;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const integer = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const positive = (value) => integer(value) && value > 0;
const keys = (value, allowed) =>
  Object.keys(value).every((key) => allowed.includes(key));
const optional = (value, key, validate) =>
  !Object.hasOwn(value, key) || validate(value[key]);
const destination = (value) => value === "community" || value === "events";
const recordValues = (value, validate) =>
  object(value) &&
  Object.entries(value).every(([key, entry]) => text(key) && validate(entry));
function readTelegramDesired(value) {
  if (
    !object(value) ||
    value.schemaVersion !== 2 ||
    !destination(value.destination) ||
    !text(value.revision) ||
    !text(value.sourceRevision)
  )
    return null;
  if (
    !optional(
      value,
      "eventTelegramProjectionGuard",
      (entry) =>
        object(entry) &&
        keys(entry, [
          "eventId",
          "generation",
          "lockId",
          "lockRoot",
          "ownerUid",
          "messageKey",
        ]) &&
        ["eventId", "lockId", "lockRoot", "ownerUid", "messageKey"].every(
          (key) => text(entry[key]),
        ) &&
        optional(entry, "generation", integer),
    )
  )
    return null;
  const identity = [
    "schemaVersion",
    "destination",
    "revision",
    "sourceRevision",
    "operation",
    "eventTelegramProjectionGuard",
  ];
  if (value.operation === "delete") return keys(value, identity) ? value : null;
  if (
    (value.operation !== "send" && value.operation !== "edit") ||
    !text(value.instanceKey) ||
    !text(value.contentHash) ||
    typeof value.text !== "string" ||
    value.text.length === 0 ||
    typeof value.silent !== "boolean" ||
    value.disableWebPagePreview !== true ||
    !optional(value, "parseMode", (entry) => entry === "HTML")
  )
    return null;
  if (
    value.operation === "edit" &&
    value.ifMissing !== "send" &&
    value.ifMissing !== "skip"
  )
    return null;
  return keys(value, [
    ...identity,
    "instanceKey",
    "contentHash",
    "text",
    "silent",
    "disableWebPagePreview",
    "parseMode",
    ...(value.operation === "edit" ? ["ifMissing"] : []),
  ])
    ? value
    : null;
}
function readTelegramSendEvidence(value) {
  if (
    !object(value) ||
    !keys(value, [
      "attemptId",
      "revision",
      "destination",
      "chatId",
      "instanceKey",
      "contentHash",
      "startedAtMs",
      "apiGateOwner",
      "abandonedAtMs",
    ]) ||
    ![
      "attemptId",
      "revision",
      "chatId",
      "instanceKey",
      "contentHash",
      "apiGateOwner",
    ].every((key) => text(value[key])) ||
    !destination(value.destination) ||
    !positive(value.startedAtMs) ||
    !optional(value, "abandonedAtMs", positive)
  )
    return null;
  return value;
}
function readTelegramApplied(value) {
  if (
    !object(value) ||
    !keys(value, [
      "destination",
      "chatId",
      "messageId",
      "instanceKey",
      "revision",
      "contentHash",
      "appliedAtMs",
      "recoveredAtMs",
    ]) ||
    !destination(value.destination) ||
    !["chatId", "instanceKey", "revision"].every((key) => text(value[key])) ||
    !positive(value.messageId) ||
    !positive(value.appliedAtMs) ||
    !optional(value, "contentHash", text) ||
    !optional(value, "recoveredAtMs", positive)
  )
    return null;
  return value;
}
const retryKeys = [
  "retryStartedAtMs",
  "retryDeadlineAtMs",
  "retryAtMs",
  "retrySequence",
];
function retryState(value, required) {
  if (
    !retryKeys.every((key) =>
      required
        ? key === "retrySequence"
          ? integer(value[key])
          : positive(value[key])
        : optional(value, key, key === "retrySequence" ? integer : positive),
    )
  )
    return false;
  return (
    value.retryStartedAtMs === undefined ||
    value.retryDeadlineAtMs === undefined ||
    value.retryDeadlineAtMs >= value.retryStartedAtMs
  );
}
function readTelegramRetryProof(value) {
  if (
    !object(value) ||
    !keys(value, [
      ...retryKeys,
      "owner",
      "retryNotBeforeMs",
      "revision",
      "safeRejectedAttemptId",
      "pendingDeleteId",
      "retryProofLeaseOwner",
      "proofTaskKind",
    ]) ||
    !text(value.owner) ||
    !text(value.revision) ||
    !positive(value.retryNotBeforeMs) ||
    !retryState(value, true) ||
    !["safeRejectedAttemptId", "pendingDeleteId", "retryProofLeaseOwner"].every(
      (key) => optional(value, key, text),
    ) ||
    !optional(
      value,
      "proofTaskKind",
      (entry) => entry === "desired" || entry === "pending-delete",
    )
  )
    return null;
  return value;
}
const metadataKeys = [
  "attempts",
  "startedAtMs",
  "deliveredAtMs",
  "deadLetterAtMs",
  "uncertainAtMs",
  "uncertainReason",
  "safeRejectionAtMs",
  "safeRejectionRecoveredAtMs",
  "retryWindowRecoveredAtMs",
  "lastRejectedAttemptId",
  "lastError",
  "apiGateOwner",
  "apiGateGeneration",
  "apiGateStartedAtMs",
  "apiGateSettleOwner",
  "pendingDeleteApiGateSettleOwner",
  "apiGateReleaseOwner",
  "apiGateProofRequired",
  "lastRecoveryRequestId",
  "pendingDelete",
  "pendingDeleteQueue",
  "orphanedDeletes",
  "appliedStateUnknown",
  "abandonedSend",
];
const timestampKeys = [
  "startedAtMs",
  "deliveredAtMs",
  "deadLetterAtMs",
  "uncertainAtMs",
  "safeRejectionAtMs",
  "safeRejectionRecoveredAtMs",
  "retryWindowRecoveredAtMs",
  "apiGateStartedAtMs",
  "leaseExpiresAtMs",
];
const textKeys = [
  "uncertainReason",
  "lastRejectedAttemptId",
  "apiGateOwner",
  "apiGateGeneration",
  "apiGateSettleOwner",
  "pendingDeleteApiGateSettleOwner",
  "apiGateReleaseOwner",
  "lastRecoveryRequestId",
  "leaseOwner",
];
const cleanupKeys = [
  ...metadataKeys,
  ...retryKeys,
  "status",
  "leaseOwner",
  "leaseExpiresAtMs",
  "pendingDeleteId",
  "chatId",
  "messageId",
  "instanceKey",
];
function errorState(value) {
  return (
    object(value) &&
    keys(value, ["code", "atMs", "description", "httpStatus"]) &&
    text(value.code) &&
    positive(value.atMs) &&
    optional(value, "description", text) &&
    optional(value, "httpStatus", positive)
  );
}
function metadata(value) {
  return (
    optional(value, "attempts", integer) &&
    timestampKeys.every((key) => optional(value, key, positive)) &&
    textKeys.every((key) => optional(value, key, text)) &&
    optional(value, "lastError", errorState) &&
    optional(
      value,
      "apiGateProofRequired",
      (entry) => readTelegramRetryProof(entry) !== null,
    ) &&
    optional(
      value,
      "abandonedSend",
      (entry) => readTelegramSendEvidence(entry) !== null,
    ) &&
    optional(
      value,
      "pendingDelete",
      (entry) => readTelegramCleanup(entry) !== null,
    ) &&
    optional(value, "pendingDeleteQueue", (entry) =>
      recordValues(entry, (pending) => readTelegramCleanup(pending) !== null),
    ) &&
    optional(value, "orphanedDeletes", (entry) =>
      recordValues(entry, orphanedDelete),
    ) &&
    optional(
      value,
      "appliedStateUnknown",
      (entry) =>
        object(entry) &&
        keys(entry, ["revision", "operation", "apiGateOwner", "markedAtMs"]) &&
        text(entry.revision) &&
        (entry.operation === "edit" || entry.operation === "delete") &&
        text(entry.apiGateOwner) &&
        positive(entry.markedAtMs),
    )
  );
}
function lifecycle(value) {
  if (!retryState(value, value.status === "retryable")) return false;
  if (value.status === "processing")
    return text(value.leaseOwner) && positive(value.leaseExpiresAtMs);
  return value.leaseOwner === undefined && value.leaseExpiresAtMs === undefined;
}
function cleanupIdentity(value) {
  return (
    text(value.pendingDeleteId) &&
    text(value.chatId) &&
    positive(value.messageId) &&
    typeof value.instanceKey === "string"
  );
}
function orphanedDelete(value) {
  return (
    object(value) &&
    keys(value, [
      ...cleanupKeys.filter((key) => key !== "status"),
      "terminalAtMs",
    ]) &&
    value.status === undefined &&
    cleanupIdentity(value) &&
    positive(value.terminalAtMs) &&
    errorState(value.lastError) &&
    metadata(value) &&
    retryState(value, false)
  );
}
function readTelegramCleanup(value) {
  if (
    !object(value) ||
    !keys(value, cleanupKeys) ||
    !["pending", "processing", "retryable"].includes(String(value.status)) ||
    !cleanupIdentity(value) ||
    !metadata(value) ||
    !lifecycle(value)
  )
    return null;
  return value;
}
function readTelegramDelivery(value) {
  if (
    !object(value) ||
    !keys(value, [
      ...metadataKeys,
      ...retryKeys,
      "status",
      "revision",
      "leaseOwner",
      "leaseExpiresAtMs",
      "sendInFlight",
    ]) ||
    ![
      "pending",
      "processing",
      "retryable",
      "delivered",
      "terminal",
      "uncertain",
    ].includes(String(value.status)) ||
    !text(value.revision) ||
    !metadata(value) ||
    !lifecycle(value) ||
    !optional(
      value,
      "sendInFlight",
      (entry) => readTelegramSendEvidence(entry) !== null,
    )
  )
    return null;
  if (
    value.sendInFlight !== undefined &&
    value.status !== "processing" &&
    value.status !== "uncertain"
  )
    return null;
  if (value.status === "delivered" && !positive(value.deliveredAtMs))
    return null;
  return value;
}
function manualRecovery(value) {
  if (!object(value) || !text(value.requestId)) return false;
  if (value.action === "confirm-send-applied")
    return (
      keys(value, ["requestId", "action", "messageId"]) &&
      positive(value.messageId)
    );
  return (
    keys(value, ["requestId", "action"]) &&
    (value.action === "confirm-send-absent" || value.action === "abandon")
  );
}
function recoveryResult(value) {
  if (
    !object(value) ||
    !keys(value, [
      "requestId",
      "action",
      "processedAtMs",
      "status",
      "messageId",
      "code",
    ]) ||
    !text(value.requestId) ||
    !["confirm-send-applied", "confirm-send-absent", "abandon"].includes(
      String(value.action),
    ) ||
    !positive(value.processedAtMs)
  )
    return false;
  return value.status === "accepted"
    ? value.code === undefined && optional(value, "messageId", positive)
    : value.status === "rejected" &&
        value.messageId === undefined &&
        [
          "recovery-not-uncertain",
          "invalid-manual-recovery",
          "missing-send-in-flight",
        ].includes(String(value.code));
}
function projectionGuard(value) {
  return (
    object(value) &&
    keys(value, [
      "schemaVersion",
      "lifecycle",
      "sourceGeneration",
      "sourceRevision",
      "resultDigests",
    ]) &&
    value.schemaVersion === 1 &&
    ["pending", "matched", "canceled"].includes(String(value.lifecycle)) &&
    integer(value.sourceGeneration) &&
    text(value.sourceRevision) &&
    recordValues(value.resultDigests, text)
  );
}
function readTelegramMessageDocument(value) {
  if (
    !object(value) ||
    !keys(value, [
      "schemaVersion",
      "desired",
      "delivery",
      "applied",
      "manualRecovery",
      "manualRecoveryResult",
      "automatchProjection",
    ]) ||
    value.schemaVersion !== 1 ||
    !optional(
      value,
      "desired",
      (entry) => readTelegramDesired(entry) !== null,
    ) ||
    !optional(
      value,
      "delivery",
      (entry) => readTelegramDelivery(entry) !== null,
    ) ||
    !optional(
      value,
      "applied",
      (entry) => readTelegramApplied(entry) !== null,
    ) ||
    !optional(value, "manualRecovery", manualRecovery) ||
    !optional(value, "manualRecoveryResult", recoveryResult) ||
    !optional(value, "automatchProjection", projectionGuard)
  )
    return null;
  return value;
}
function apiGate(value) {
  return (
    object(value) &&
    keys(value, [
      "owner",
      "messageKey",
      "revision",
      "operation",
      "acquiredAtMs",
      "taskGeneration",
      "attemptId",
      "pendingDeleteId",
    ]) &&
    ["owner", "messageKey", "revision"].every((key) => text(value[key])) &&
    ["send", "edit", "delete", "pending-delete"].includes(
      String(value.operation),
    ) &&
    positive(value.acquiredAtMs) &&
    ["taskGeneration", "attemptId", "pendingDeleteId"].every((key) =>
      optional(value, key, text),
    )
  );
}
function readTelegramControlDocument(value) {
  if (
    !object(value) ||
    !keys(value, ["schemaVersion", "retryNotBeforeMs", "apiGate"]) ||
    value.schemaVersion !== 1 ||
    !optional(value, "retryNotBeforeMs", integer) ||
    !optional(value, "apiGate", apiGate)
  )
    return null;
  return value;
}
function requireTelegramMessageDocument(value) {
  const parsed = readTelegramMessageDocument(value);
  if (!parsed) throw new TypeError("invalid-telegram-message-document");
  return parsed;
}
function requireTelegramTransaction(value) {
  if (!object(value) || typeof value.decision !== "string")
    throw new TypeError("invalid-telegram-transaction");
  if (value.commit === false)
    return { commit: false, decision: value.decision };
  return {
    value: requireTelegramMessageDocument(value.value),
    decision: value.decision,
  };
}
function requireTelegramOrphanedDelete(value) {
  if (!orphanedDelete(value))
    throw new TypeError("invalid-telegram-orphaned-delete");
  return value;
}
