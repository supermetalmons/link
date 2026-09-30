// Generated from src/monsRules.ts. Run npm run generate:runtime.
type MonsRules = typeof import("mons-rules", {
  with: { "resolution-mode": "import" },
});
export { movesFromFlatString } from "@mons/shared/match-protocol";
export declare const loadMonsRules: () => Promise<MonsRules>;
