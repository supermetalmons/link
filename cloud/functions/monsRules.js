let monsRulesPromise = null;
const { movesFromFlatString } = require("@mons/shared/match-protocol");

const loadMonsRules = () => {
  if (!monsRulesPromise) {
    monsRulesPromise = import("mons-rules");
  }
  return monsRulesPromise;
};

module.exports = {
  loadMonsRules,
  movesFromFlatString,
};
