// Generated from src/monsRules.ts. Run npm run generate:runtime.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadMonsRules = void 0;
let monsRulesPromise = null;
const loadMonsRules = () => {
  if (!monsRulesPromise) {
    monsRulesPromise = import("mons-rules");
  }
  return monsRulesPromise;
};
exports.loadMonsRules = loadMonsRules;
