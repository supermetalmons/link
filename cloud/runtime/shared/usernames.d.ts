// Generated from src/shared/usernames.ts. Run npm run generate:runtime.
export type UsernameEditRequest = {
  username: string;
};
export type UsernameEditResponse =
  | {
      ok: true;
    }
  | {
      ok: false;
      validationError?: string;
    };
declare const USERNAME_MAX_LENGTH = 14;
declare const USERNAME_LOOKUP_KEY_FIELD = "usernameLookupKey";
declare const USERNAME_VALIDATION_MESSAGES: Readonly<{
  reserved: "This name is reserved.";
  tooLong: "Must be shorter than 15 characters.";
  alphanumeric: "Use only letters and numbers.";
}>;
declare const cleanUsername: (value: unknown) => string;
declare const buildUsernameLookupKey: (username: unknown) => string;
declare const isAlphanumericUsername: (username: unknown) => boolean;
declare const isReservedExplicitUsername: (username: unknown) => boolean;
declare const isUsernameEditRequest: (
  value: unknown,
) => value is UsernameEditRequest;
declare const isUsernameEditResponse: (
  value: unknown,
) => value is UsernameEditResponse;
export {
  USERNAME_MAX_LENGTH,
  USERNAME_LOOKUP_KEY_FIELD,
  USERNAME_VALIDATION_MESSAGES,
  cleanUsername,
  buildUsernameLookupKey,
  isAlphanumericUsername,
  isReservedExplicitUsername,
  isUsernameEditRequest,
  isUsernameEditResponse,
};
