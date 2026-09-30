// Generated from src/shared/login-match-discovery.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchDiscoverySortKey = matchDiscoverySortKey;
exports.resolveMatchDiscoveryInvite = resolveMatchDiscoveryInvite;
const ids_js_1 = require("./ids.js");
const rematches_js_1 = require("./rematches.js");
function matchDiscoverySortKey(matchId) {
  if (typeof matchId !== "string" || !(0, ids_js_1.isSafeRecordKey)(matchId)) {
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
  for (const candidate of (0, rematches_js_1.createInviteCandidatesFromMatchId)(
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
