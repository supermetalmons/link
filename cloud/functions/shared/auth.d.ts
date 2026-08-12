export type AuthMethodKey = "eth" | "sol" | "apple" | "x";
export type AuthCooldownReason =
  "method-reuse-cooldown" | "profile-method-cooldown";
export type AuthCooldownScope = "method" | "profile-method";
export type AuthMethodField = "eth" | "sol" | "appleSub" | "xUserId";

export const AUTH_METHODS: readonly ["eth", "sol", "apple", "x"];
export const AUTH_METHOD_FIELD_BY_TYPE: Readonly<{
  eth: "eth";
  sol: "sol";
  apple: "appleSub";
  x: "xUserId";
}>;
export const AUTH_METHOD_LABELS: Readonly<{
  eth: "Ethereum";
  sol: "Solana";
  apple: "Apple";
  x: "X";
}>;
export const AUTH_METHOD_REUSE_COOLDOWN_MS: 86400000;
export const AUTH_COOLDOWN_REASONS: Readonly<{
  method: "method-reuse-cooldown";
  profileMethod: "profile-method-cooldown";
}>;

export function normalizeAuthMethod(value: unknown): AuthMethodKey | null;
export function normalizeAuthCooldownReason(
  value: unknown,
): AuthCooldownReason | null;
export function getAuthCooldownScope(
  reason: AuthCooldownReason,
): AuthCooldownScope;
export function resolveAuthCooldownRetryAtMs(
  docData: unknown,
  fallbackCooldownMs?: number,
): number;
