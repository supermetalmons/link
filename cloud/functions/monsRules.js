let monsRulesPromise = null;

const loadMonsRules = () => {
  if (!monsRulesPromise) {
    monsRulesPromise = import("mons-rules");
  }
  return monsRulesPromise;
};

const movesFromFlatString = (value) => {
  const flatMovesString = typeof value === "string" ? value : "";
  return flatMovesString === "" ? [] : flatMovesString.split("-");
};

module.exports = {
  loadMonsRules,
  movesFromFlatString,
};
