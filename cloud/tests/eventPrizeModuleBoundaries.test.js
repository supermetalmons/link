"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const withdrawalPath = path.resolve(
  __dirname,
  "../runtime/eventPrizes/withdrawalOrchestrator.js",
);

test("keeps withdrawal orchestration independent of eager Solana SDK loading", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
        require(${JSON.stringify(withdrawalPath)});
        const loaded = Object.keys(require.cache).filter((modulePath) =>
          modulePath.includes("/node_modules/@metaplex-foundation/") ||
          modulePath.includes("/node_modules/@solana/web3.js/")
        );
        if (loaded.length > 0) throw new Error(loaded.join("\\n"));
      `,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
