const USERNAME_MAX_LENGTH = 14;
const USERNAME_LOOKUP_KEY_FIELD = "usernameLookupKey";
const USERNAME_ALLOWED_RE = /^[a-zA-Z0-9]+$/;
const USERNAME_VALIDATION_MESSAGES = Object.freeze({
  reserved: "This name is reserved.",
  tooLong: "Must be shorter than 15 characters.",
  alphanumeric: "Use only letters and numbers.",
});

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

const buildUsernameLookupKey = (username) =>
  cleanUsername(username).toLowerCase();

const isAlphanumericUsername = (username) =>
  typeof username === "string" && USERNAME_ALLOWED_RE.test(username);

const isReservedExplicitUsername = (username) =>
  buildUsernameLookupKey(username) === "anon";

const isSafeFirestoreDocIdSegment = (value) => {
  const cleaned = cleanUsername(value);
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return false;
  }
  return !cleaned.includes("/");
};

const getUsernameIndexDocIds = (username) => {
  const cleaned = cleanUsername(username);
  if (!cleaned) {
    return [];
  }
  const canonical = buildUsernameLookupKey(cleaned);
  if (!isSafeFirestoreDocIdSegment(canonical)) {
    return [];
  }
  if (canonical === cleaned) {
    return [canonical];
  }
  if (!isSafeFirestoreDocIdSegment(cleaned)) {
    return [canonical];
  }
  return [canonical, cleaned];
};

const isUsernameEditRequest = (value) =>
  isRecord(value) &&
  hasExactKeys(value, ["username"]) &&
  typeof value.username === "string";

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

module.exports = {
  USERNAME_MAX_LENGTH,
  USERNAME_LOOKUP_KEY_FIELD,
  USERNAME_VALIDATION_MESSAGES,
  cleanUsername,
  buildUsernameLookupKey,
  isAlphanumericUsername,
  isReservedExplicitUsername,
  isSafeFirestoreDocIdSegment,
  getUsernameIndexDocIds,
  isUsernameEditRequest,
  isUsernameEditResponse,
};
