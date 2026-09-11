"use strict";

const X_REDIRECT_RESULT_PARAMS = Object.freeze({
  flowId: "x_auth_flow",
  status: "x_auth_status",
  error: "x_auth_error",
  consentSource: "x_auth_consent",
});
const X_REDIRECT_CALLBACK_PARAM_KEYS = Object.freeze([
  X_REDIRECT_RESULT_PARAMS.flowId,
  X_REDIRECT_RESULT_PARAMS.status,
  X_REDIRECT_RESULT_PARAMS.error,
  X_REDIRECT_RESULT_PARAMS.consentSource,
]);
const X_REDIRECT_STARTED_ERROR_CODE = "x-sign-in-redirect-started";
const X_REDIRECT_START_RESPONSE_KEYS = Object.freeze([
  "ok",
  "flowId",
  "authUrl",
  "expiresAtMs",
]);

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cleanString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : "";

const normalizeClientXConsentSource = (value) =>
  value === "settings" ? "settings" : "signin";

const normalizeServerXConsentSource = (value) => {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "settings" ? "settings" : "signin";
};

const isXRedirectStartResponse = (value) => {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === X_REDIRECT_START_RESPONSE_KEYS.length &&
    keys.every((key) => X_REDIRECT_START_RESPONSE_KEYS.includes(key)) &&
    value.ok === true &&
    cleanString(value.flowId) !== "" &&
    cleanString(value.authUrl) !== "" &&
    Number.isSafeInteger(value.expiresAtMs) &&
    value.expiresAtMs > 0
  );
};

module.exports = {
  X_REDIRECT_RESULT_PARAMS,
  X_REDIRECT_CALLBACK_PARAM_KEYS,
  X_REDIRECT_STARTED_ERROR_CODE,
  normalizeClientXConsentSource,
  normalizeServerXConsentSource,
  isXRedirectStartResponse,
};
