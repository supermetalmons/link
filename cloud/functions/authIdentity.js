const {
  consumeAuthIntent,
  linkVerifiedMethod,
  peekAuthOpReplay,
  syncProfileClaimForUid,
  unlinkMethodForUid,
} = require("./auth/identityService");
const { normalizeMethodValue } = require("./auth/policy");
const { verifyAppleIdToken } = require("./auth/appleToken");
const { validateSiweDomainAndUri } = require("./auth/siwe");

module.exports = {
  consumeAuthIntent,
  normalizeMethodValue,
  linkVerifiedMethod,
  peekAuthOpReplay,
  unlinkMethodForUid,
  syncProfileClaimForUid,
  verifyAppleIdToken,
  validateSiweDomainAndUri,
};
