import { registerTypeScriptTestHooks } from "../support/typescriptHooks.mjs";

registerTypeScriptTestHooks();

const { createRematchViewing } =
  await import("../../src/game/rematchViewing.ts");

/**
 * @param {Partial<Parameters<typeof createRematchViewing>[0]> & {
 *   selection?: import("../../src/game/rematchViewing.ts").ViewedRematch | null
 * }} [options]
 */
export function createRematchViewingHarness({
  selection = null,
  ...dependencies
} = {}) {
  const viewer = createRematchViewing({
    loadMatchPair: async () => null,
    buildHistoricalGame: () => null,
    countRecordedMoves: () => 0,
    createSessionGuard: () => () => true,
    setTimeout: () => 0,
    clearTimeout: () => {},
    wait: async () => {},
    ...dependencies,
  });
  if (selection) {
    viewer.commitSelection(
      viewer.beginSelection(() => true),
      selection,
    );
  }
  return viewer;
}
