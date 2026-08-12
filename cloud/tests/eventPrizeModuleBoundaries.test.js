"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const withdrawalPath = path.resolve(
  __dirname,
  "../functions/eventPrizeWithdrawal.js",
);

test("preserves the event-prize withdrawal facade", () => {
  const withdrawal = require(withdrawalPath);

  assert.deepEqual(Object.keys(withdrawal).sort(), [
    "acquireWithdrawalClaim",
    "buildCompressedTransferBuilder",
    "buildSubmittedTransaction",
    "deserializePersistedSubmittedTransaction",
    "discardDefinitiveSubmittedTransaction",
    "handleWithdrawEventPrize",
    "inspectSubmittedWithdrawal",
    "isDefinitiveSubmittedTransactionFailure",
    "loadPrizeAssetState",
    "loadSolanaDependencies",
    "persistSubmittedTransaction",
    "reconcileCompletedWithdrawalProjections",
    "reconcileSubmittedAssetState",
    "recoverSubmittedWithdrawal",
    "sendAndConfirmSubmittedTransaction",
    "validateCompressedPrizeAsset",
    "validatePrizeAssignment",
    "waitForSubmittedTransactionStatus",
    "withdrawEventPrize",
  ]);
});

test("keeps Solana SDK loading behind the facade's lazy adapter", () => {
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
