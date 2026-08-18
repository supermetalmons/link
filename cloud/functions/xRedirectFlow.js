const {
  normalizeServerXConsentSource: normalizeConsentSource,
} = require("@mons/shared/x-redirect");

const X_REDIRECT_FLOW_COLLECTION = "xAuthRedirectFlows";
const X_REDIRECT_FLOW_TTL_MS = 10 * 60 * 1000;
const toCleanString = (value) => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
};

module.exports = {
  X_REDIRECT_FLOW_COLLECTION,
  X_REDIRECT_FLOW_TTL_MS,
  toCleanString,
  normalizeConsentSource,
};
