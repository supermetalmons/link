const {
  beginAuthIntent,
  consumeAuthIntent,
  getLinkedMethodsForUid,
  linkVerifiedMethod,
  peekAuthOpReplay,
  syncProfileClaimForUid,
  unlinkMethodForUid,
} = require("./auth/identityService");
const { normalizeMethodValue } = require("./auth/policy");
const { verifyAppleIdToken } = require("./auth/appleToken");
const { validateSiweDomainAndUri } = require("./auth/siwe");

module.exports = {
  beginAuthIntent,
  consumeAuthIntent,
  normalizeMethodValue,
  linkVerifiedMethod,
  peekAuthOpReplay,
  unlinkMethodForUid,
  getLinkedMethodsForUid,
  syncProfileClaimForUid,
  verifyAppleIdToken,
  validateSiweDomainAndUri,
};
