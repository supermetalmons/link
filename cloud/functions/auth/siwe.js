const { HttpsError } = require("firebase-functions/v2/https");
const { toCleanString } = require("./policy");

const getAllowedSiweDomains = () => {
  const configured = toCleanString(process.env.SIWE_ALLOWED_DOMAINS);
  if (configured) {
    return configured
      .split(",")
      .map((domain) => domain.trim().toLowerCase())
      .filter((domain) => domain !== "");
  }
  return ["mons.link", "www.mons.link", "localhost", "127.0.0.1"];
};

const validateSiweDomainAndUri = (fieldsData) => {
  const allowedDomains = new Set(getAllowedSiweDomains());
  const domain = toCleanString(fieldsData && fieldsData.domain).toLowerCase();
  const uriRaw = toCleanString(fieldsData && fieldsData.uri);
  let uriHost = "";
  if (uriRaw) {
    try {
      uriHost = toCleanString(new URL(uriRaw).host).toLowerCase();
    } catch {}
  }
  if (!domain || !allowedDomains.has(domain)) {
    const bareDomain = domain.includes(":") ? domain.split(":")[0] : domain;
    if (!bareDomain || !allowedDomains.has(bareDomain)) {
      throw new HttpsError("permission-denied", "siwe-domain-not-allowed");
    }
  }
  if (uriHost) {
    if (allowedDomains.has(uriHost)) {
      return;
    }
    const bareHost = uriHost.includes(":") ? uriHost.split(":")[0] : uriHost;
    if (!allowedDomains.has(bareHost)) {
      throw new HttpsError("permission-denied", "siwe-uri-not-allowed");
    }
  }
};

module.exports = {
  getAllowedSiweDomains,
  validateSiweDomainAndUri,
};
