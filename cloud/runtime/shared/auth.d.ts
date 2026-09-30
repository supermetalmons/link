// Generated from src/shared/auth.ts. Run npm run generate:runtime.
import type { MiningSnapshot } from "./mining.js";
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
export type AuthVerificationResponse =
  | AuthProfileResponse
  | {
      ok: false;
    };
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
declare const AUTH_METHODS: readonly ["eth", "sol", "apple", "x"];
declare const AUTH_METHOD_FIELD_BY_TYPE: Readonly<{
  eth: "eth";
  sol: "sol";
  apple: "appleSub";
  x: "xUserId";
}>;
declare const AUTH_METHOD_LABELS: Readonly<{
  eth: "Ethereum";
  sol: "Solana";
  apple: "Apple";
  x: "X";
}>;
declare const AUTH_METHOD_REUSE_COOLDOWN_MS: 86400000;
declare const AUTH_COOLDOWN_REASONS: Readonly<{
  method: "method-reuse-cooldown";
  profileMethod: "profile-method-cooldown";
}>;
declare const normalizeAuthPresentation: (
  emoji: unknown,
  aura: unknown,
) => AuthPresentation;
declare const normalizeAuthMethod: (value: unknown) => AuthMethodKey | null;
declare const normalizeAuthCooldownReason: (
  value: unknown,
) => AuthCooldownReason | null;
declare const getAuthCooldownScope: (
  reason: AuthCooldownReason,
) => AuthCooldownScope;
declare const resolveAuthCooldownRetryAtMs: (
  docData: unknown,
  fallbackCooldownMs?: number,
) => number;
declare const isAuthIntentResponse: (
  value: unknown,
) => value is AuthIntentResponse;
declare const isLinkedAuthMethodsResponse: (
  value: unknown,
) => value is LinkedAuthMethodsResponse;
declare const isAuthProfileResponse: (
  value: unknown,
) => value is AuthProfileResponse;
declare const isAuthVerificationResponse: (
  value: unknown,
) => value is AuthVerificationResponse;
declare const isSolanaAuthVerificationRequest: (
  value: unknown,
) => value is SolanaAuthVerificationRequest;
declare const isEthereumAuthVerificationRequest: (
  value: unknown,
) => value is EthereumAuthVerificationRequest;
declare const isAppleAuthVerificationRequest: (
  value: unknown,
) => value is AppleAuthVerificationRequest;
declare const isXAuthCompletionRequest: (
  value: unknown,
) => value is XAuthCompletionRequest;
declare const isAuthMethodUnlinkRequest: (
  value: unknown,
) => value is AuthMethodUnlinkRequest;
declare const getLinkedAuthMethodsFromProfile: (
  value: unknown,
) => LinkedAuthMethods;
export {
  AUTH_METHODS,
  AUTH_METHOD_FIELD_BY_TYPE,
  AUTH_METHOD_LABELS,
  AUTH_METHOD_REUSE_COOLDOWN_MS,
  AUTH_COOLDOWN_REASONS,
  getLinkedAuthMethodsFromProfile,
  normalizeAuthPresentation,
  normalizeAuthMethod,
  normalizeAuthCooldownReason,
  getAuthCooldownScope,
  isAuthIntentResponse,
  isAppleAuthVerificationRequest,
  isAuthMethodUnlinkRequest,
  isAuthProfileResponse,
  isAuthVerificationResponse,
  isEthereumAuthVerificationRequest,
  isLinkedAuthMethodsResponse,
  isSolanaAuthVerificationRequest,
  isXAuthCompletionRequest,
  resolveAuthCooldownRetryAtMs,
};
