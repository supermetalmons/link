// Generated from src/shared/usernames.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isUsernameEditResponse =
  exports.isUsernameEditRequest =
  exports.isReservedExplicitUsername =
  exports.isAlphanumericUsername =
  exports.buildUsernameLookupKey =
  exports.cleanUsername =
  exports.USERNAME_VALIDATION_MESSAGES =
  exports.USERNAME_LOOKUP_KEY_FIELD =
  exports.USERNAME_MAX_LENGTH =
    void 0;
const USERNAME_MAX_LENGTH = 14;
exports.USERNAME_MAX_LENGTH = USERNAME_MAX_LENGTH;
const USERNAME_LOOKUP_KEY_FIELD = "usernameLookupKey";
exports.USERNAME_LOOKUP_KEY_FIELD = USERNAME_LOOKUP_KEY_FIELD;
const USERNAME_ALLOWED_RE = /^[a-zA-Z0-9]+$/;
const USERNAME_VALIDATION_MESSAGES = Object.freeze({
  reserved: "This name is reserved.",
  tooLong: "Must be shorter than 15 characters.",
  alphanumeric: "Use only letters and numbers.",
});
exports.USERNAME_VALIDATION_MESSAGES = USERNAME_VALIDATION_MESSAGES;
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value, expectedKeys) => {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
  );
};
const cleanUsername = (value) =>
  typeof value === "string" ? value.trim() : "";
exports.cleanUsername = cleanUsername;
const buildUsernameLookupKey = (username) =>
  cleanUsername(username).toLowerCase();
exports.buildUsernameLookupKey = buildUsernameLookupKey;
const isAlphanumericUsername = (username) =>
  typeof username === "string" && USERNAME_ALLOWED_RE.test(username);
exports.isAlphanumericUsername = isAlphanumericUsername;
const isReservedExplicitUsername = (username) =>
  buildUsernameLookupKey(username) === "anon";
exports.isReservedExplicitUsername = isReservedExplicitUsername;
const isUsernameEditRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["username"]) &&
  typeof value.username === "string";
exports.isUsernameEditRequest = isUsernameEditRequest;
const isUsernameEditResponse = (value) => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    return hasExactKeys(value, ["ok"]);
  }
  return (
    value.ok === false &&
    (hasExactKeys(value, ["ok"]) ||
      (hasExactKeys(value, ["ok", "validationError"]) &&
        typeof value.validationError === "string" &&
        value.validationError !== ""))
  );
};
exports.isUsernameEditResponse = isUsernameEditResponse;
