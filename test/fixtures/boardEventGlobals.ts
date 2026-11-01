declare global {
  var boardWagersHarness: typeof import("./boardWagersHarness.tsx").harness;
  var eventHarness: typeof import("./eventModalHarness.tsx").harness;
  var botStrengthWindowListeners: () => Record<string, number>;
  var pendingBoardUiWork: () => { timeouts: number; rafs: number };
}

export {};
