// Generated from src/shared/data-contract.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.APPLICATION_RELEASE_PATH =
  exports.APPLICATION_DATA_SOCKET_PROTOCOL =
  exports.APPLICATION_DATA_STATUS_HEADER =
  exports.APPLICATION_DATA_HEADER =
  exports.APPLICATION_DATA_EPOCH =
    void 0;
exports.isApplicationReleaseStatus = isApplicationReleaseStatus;
exports.hasApplicationDataEpoch = hasApplicationDataEpoch;
exports.hasApplicationSocketEpoch = hasApplicationSocketEpoch;
exports.applicationDataHeaders = applicationDataHeaders;
exports.APPLICATION_DATA_EPOCH = 1;
exports.APPLICATION_DATA_HEADER = "X-Mons-Data-Epoch";
exports.APPLICATION_DATA_STATUS_HEADER = "X-Mons-Data-Status";
exports.APPLICATION_DATA_SOCKET_PROTOCOL = "mons-data-v1";
exports.APPLICATION_RELEASE_PATH = "/release";
function isApplicationReleaseStatus(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  if (
    !("state" in value) ||
    !("dataEpoch" in value) ||
    !("generation" in value) ||
    value.dataEpoch !== exports.APPLICATION_DATA_EPOCH ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1
  )
    return false;
  if (value.state === "active") return Object.keys(value).length === 3;
  return (
    value.state === "maintenance" &&
    Object.keys(value).length === 4 &&
    "retryAfterSeconds" in value &&
    typeof value.retryAfterSeconds === "number" &&
    Number.isSafeInteger(value.retryAfterSeconds) &&
    value.retryAfterSeconds > 0 &&
    value.retryAfterSeconds <= 60
  );
}
function hasApplicationDataEpoch(headers) {
  return (
    headers.get(exports.APPLICATION_DATA_HEADER) ===
    String(exports.APPLICATION_DATA_EPOCH)
  );
}
function hasApplicationSocketEpoch(headers) {
  return (headers.get("Sec-WebSocket-Protocol") || "")
    .split(",")
    .some(
      (protocol) =>
        protocol.trim() === exports.APPLICATION_DATA_SOCKET_PROTOCOL,
    );
}
function applicationDataHeaders(headers) {
  const result = new Headers(headers);
  result.set(
    exports.APPLICATION_DATA_HEADER,
    String(exports.APPLICATION_DATA_EPOCH),
  );
  return result;
}
