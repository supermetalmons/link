export type UsernameEditRequest = {
  username: string;
};

export type UsernameEditResponse =
  { ok: true } | { ok: false; validationError?: string };

const USERNAME_MAX_LENGTH = 14;
const USERNAME_ALLOWED_RE = /^[a-zA-Z0-9]+$/;
const USERNAME_VALIDATION_MESSAGES: Readonly<{
  reserved: "This name is reserved.";
  tooLong: "Must be shorter than 15 characters.";
  alphanumeric: "Use only letters and numbers.";
}> = Object.freeze({
  reserved: "This name is reserved.",
  tooLong: "Must be shorter than 15 characters.",
  alphanumeric: "Use only letters and numbers.",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: object,
  expectedKeys: readonly string[],
): boolean => {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
  );
};

const cleanUsername = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const buildUsernameLookupKey = (username: unknown): string =>
  cleanUsername(username).toLowerCase();

const isAlphanumericUsername = (username: unknown): boolean =>
  typeof username === "string" && USERNAME_ALLOWED_RE.test(username);

const isReservedExplicitUsername = (username: unknown): boolean =>
  buildUsernameLookupKey(username) === "anon";

const isUsernameEditRequest = (value: unknown): value is UsernameEditRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["username"]) &&
  typeof value.username === "string";

const isUsernameEditResponse = (
  value: unknown,
): value is UsernameEditResponse => {
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

export {
  USERNAME_MAX_LENGTH,
  USERNAME_VALIDATION_MESSAGES,
  cleanUsername,
  buildUsernameLookupKey,
  isAlphanumericUsername,
  isReservedExplicitUsername,
  isUsernameEditRequest,
  isUsernameEditResponse,
};
