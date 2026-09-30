// Generated from src/shared/x-redirect.ts. Run npm run generate:runtime.
export type XConsentSource = "signin" | "settings";
export interface XRedirectStartRequest {
  intentId: string;
  consentSource?: XConsentSource;
  returnUrl?: string;
}
export interface XRedirectStartResponse {
  ok: true;
  flowId: string;
  authUrl: string;
  expiresAtMs: number;
}
declare const X_REDIRECT_RESULT_PARAMS: Readonly<{
  flowId: "x_auth_flow";
  status: "x_auth_status";
  error: "x_auth_error";
  consentSource: "x_auth_consent";
}>;
declare const X_REDIRECT_CALLBACK_PARAM_KEYS: readonly [
  "x_auth_flow",
  "x_auth_status",
  "x_auth_error",
  "x_auth_consent",
];
declare const X_REDIRECT_STARTED_ERROR_CODE = "x-sign-in-redirect-started";
declare const normalizeClientXConsentSource: (value: unknown) => XConsentSource;
declare const normalizeServerXConsentSource: (value: unknown) => XConsentSource;
declare const isXRedirectStartResponse: (
  value: unknown,
) => value is XRedirectStartResponse;
export {
  X_REDIRECT_RESULT_PARAMS,
  X_REDIRECT_CALLBACK_PARAM_KEYS,
  X_REDIRECT_STARTED_ERROR_CODE,
  normalizeClientXConsentSource,
  normalizeServerXConsentSource,
  isXRedirectStartResponse,
};
