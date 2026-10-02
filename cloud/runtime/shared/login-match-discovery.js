// Generated from src/shared/login-match-discovery.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.matchDiscoverySortKey = matchDiscoverySortKey;
const ids_js_1 = require("./ids.js");
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
