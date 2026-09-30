type MonsRules = typeof import("mons-rules", {
  with: { "resolution-mode": "import" },
});
let monsRulesPromise: Promise<MonsRules> | null = null;
export { movesFromFlatString } from "@mons/shared/match-protocol";

export const loadMonsRules = (): Promise<MonsRules> => {
  if (!monsRulesPromise) {
    monsRulesPromise = import("mons-rules");
  }
  return monsRulesPromise;
};
