import type { MiningSnapshot } from "./mining";

export type AuthMethodKey = "eth" | "sol" | "apple" | "x";
export type AuthCooldownReason =
  "method-reuse-cooldown" | "profile-method-cooldown";
export type AuthCooldownScope = "method" | "profile-method";
export type AuthMethodField = "eth" | "sol" | "appleSub" | "xUserId";

export interface AuthIntentRequest {
  method: AuthMethodKey;
}

export interface AuthIntentResponse {
  ok: true;
  intentId: string;
  nonce: string;
  state: string;
  expiresAtMs: number;
}

export interface LinkedAuthMethods {
  apple: boolean;
  eth: boolean;
  sol: boolean;
  x: boolean;
}

export interface LinkedAuthMethodsResponse {
  ok: true;
  profileId: string | null;
  linkedMethods: LinkedAuthMethods;
  appleLinked: boolean;
}

export interface AuthProfileResponse {
  ok: true;
  uid: string;
  profileId: string;
  username: string | null;
  eth?: string | null;
  sol?: string | null;
  linkedMethods: LinkedAuthMethods;
  appleLinked: boolean;
  emoji: number;
  aura?: string | null;
  rating?: number | null;
  nonce?: number | null;
  totalManaPoints?: number | null;
  cardBackgroundId?: number | null;
  cardStickers?: string | null;
  cardSubtitleId?: number | null;
  profileCounter?: string | null;
  profileMons?: string | null;
  completedProblems?: string[] | null;
  tutorialCompleted?: boolean | null;
  mining?: MiningSnapshot;
  opId: string;
}

export type AuthVerificationResponse = AuthProfileResponse | { ok: false };

export interface SolanaAuthVerificationRequest {
  intentId: string;
  address: string;
  signature: string;
  emoji: number;
  aura: string | null;
}

export interface EthereumAuthVerificationRequest {
  intentId: string;
  message: string;
  signature: string;
  emoji: number;
  aura: string | null;
}

export interface AppleAuthVerificationRequest {
  intentId: string;
  idToken: string;
  consentSource: "signin" | "settings";
  emoji: number;
  aura: string | null;
}

export interface XAuthCompletionRequest {
  flowId: string;
  emoji: number;
  aura: string | null;
}

export interface AuthMethodUnlinkRequest {
  method: AuthMethodKey;
  opId: string;
}

export interface AuthPresentation {
  emoji: number;
  aura: string | null;
}

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
export function normalizeAuthPresentation(
  emoji: unknown,
  aura: unknown,
): AuthPresentation;
export function normalizeAuthCooldownReason(
  value: unknown,
): AuthCooldownReason | null;
export function getAuthCooldownScope(
  reason: AuthCooldownReason,
): AuthCooldownScope;
export function getLinkedAuthMethodsFromProfile(
  value: unknown,
): LinkedAuthMethods;
export function isAuthIntentResponse(
  value: unknown,
): value is AuthIntentResponse;
export function isLinkedAuthMethodsResponse(
  value: unknown,
): value is LinkedAuthMethodsResponse;
export function isAuthProfileResponse(
  value: unknown,
): value is AuthProfileResponse;
export function isAuthVerificationResponse(
  value: unknown,
): value is AuthVerificationResponse;
export function isSolanaAuthVerificationRequest(
  value: unknown,
): value is SolanaAuthVerificationRequest;
export function isEthereumAuthVerificationRequest(
  value: unknown,
): value is EthereumAuthVerificationRequest;
export function isAppleAuthVerificationRequest(
  value: unknown,
): value is AppleAuthVerificationRequest;
export function isXAuthCompletionRequest(
  value: unknown,
): value is XAuthCompletionRequest;
export function isAuthMethodUnlinkRequest(
  value: unknown,
): value is AuthMethodUnlinkRequest;
export function resolveAuthCooldownRetryAtMs(
  docData: unknown,
  fallbackCooldownMs?: number,
): number;
