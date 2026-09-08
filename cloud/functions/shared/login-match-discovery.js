"use strict";

const { isSafeFirebaseKey } = require("./ids");
const { createInviteCandidatesFromMatchId } = require("./rematches");

function matchDiscoverySortKey(matchId) {
  if (typeof matchId !== "string" || !isSafeFirebaseKey(matchId)) {
    throw new TypeError("invalid-discovery-match-id");
  }
  let key = "";
  for (let index = 0; index < matchId.length; index++) {
    key += matchId.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return key;
}

async function resolveMatchDiscoveryInvite(matchId, hasInvite) {
  matchDiscoverySortKey(matchId);
  const normalizedMatchId = matchId.trim();
  if (await hasInvite(normalizedMatchId)) {
    return { inviteId: normalizedMatchId, resolution: "resolved" };
  }
  const existing = [];
  for (const candidate of createInviteCandidatesFromMatchId(
    normalizedMatchId,
  )) {
    if (await hasInvite(candidate)) existing.push(candidate);
  }
  if (existing.length > 1) {
    return { inviteId: null, resolution: "ambiguous" };
  }
  return existing.length === 1
    ? { inviteId: existing[0], resolution: "resolved" }
    : { inviteId: null, resolution: "missing" };
}

module.exports = { matchDiscoverySortKey, resolveMatchDiscoveryInvite };
