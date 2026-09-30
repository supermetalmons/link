// Generated from src/monsRules.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadMonsRules = exports.movesFromFlatString = void 0;
let monsRulesPromise = null;
var match_protocol_1 = require("@mons/shared/match-protocol");
Object.defineProperty(exports, "movesFromFlatString", {
  enumerable: true,
  get: function () {
    return match_protocol_1.movesFromFlatString;
  },
});
const loadMonsRules = () => {
  if (!monsRulesPromise) {
    monsRulesPromise = import("mons-rules");
  }
  return monsRulesPromise;
};
exports.loadMonsRules = loadMonsRules;
