// Generated from src/shared/api-errors.ts. Run npm run generate:runtime.
import type { AuthMethodKey } from "./auth.js";
type CooldownFields = {
  method: AuthMethodKey;
  retryAtMs: number;
  cooldownMs: number;
};
export type AuthCooldownDetails = CooldownFields &
  (
    | {
        reason: "method-reuse-cooldown";
        scope: "method";
      }
    | {
        reason: "profile-method-cooldown";
        scope: "profile-method";
        profileId: string | null;
      }
  );
export type TerminalWithdrawalDetails = {
  terminal: true;
};
export type ApiErrorDetails = AuthCooldownDetails | TerminalWithdrawalDetails;
export declare function isApiErrorDetails(
  value: unknown,
): value is ApiErrorDetails;
export declare function parseApiErrorDetails(
  code: string,
  value: unknown,
): ApiErrorDetails | undefined;
export {};
