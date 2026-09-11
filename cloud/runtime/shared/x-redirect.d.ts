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

export const X_REDIRECT_RESULT_PARAMS: Readonly<{
  flowId: "x_auth_flow";
  status: "x_auth_status";
  error: "x_auth_error";
  consentSource: "x_auth_consent";
}>;
export const X_REDIRECT_CALLBACK_PARAM_KEYS: readonly [
  "x_auth_flow",
  "x_auth_status",
  "x_auth_error",
  "x_auth_consent",
];
export const X_REDIRECT_STARTED_ERROR_CODE: "x-sign-in-redirect-started";
export function normalizeClientXConsentSource(value: unknown): XConsentSource;
export function normalizeServerXConsentSource(value: unknown): XConsentSource;
export function isXRedirectStartResponse(
  value: unknown,
): value is XRedirectStartResponse;
