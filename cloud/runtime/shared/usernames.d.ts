export const USERNAME_MAX_LENGTH: 14;
export const USERNAME_LOOKUP_KEY_FIELD: "usernameLookupKey";
export const USERNAME_VALIDATION_MESSAGES: Readonly<{
  reserved: "This name is reserved.";
  tooLong: "Must be shorter than 15 characters.";
  alphanumeric: "Use only letters and numbers.";
}>;

export type UsernameEditRequest = {
  username: string;
};

export type UsernameEditResponse =
  { ok: true } | { ok: false; validationError?: string };

export function cleanUsername(value: unknown): string;
export function buildUsernameLookupKey(username: unknown): string;
export function isAlphanumericUsername(username: unknown): boolean;
export function isReservedExplicitUsername(username: unknown): boolean;
export function isUsernameEditRequest(
  value: unknown,
): value is UsernameEditRequest;
export function isUsernameEditResponse(
  value: unknown,
): value is UsernameEditResponse;
