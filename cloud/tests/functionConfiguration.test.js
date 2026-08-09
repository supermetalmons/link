"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { withdrawEventPrize } = require("../functions/eventPrizeWithdrawal");
const { buildHeliusRpcUrl } = require("../functions/heliusRpc");

const getSecretKeys = (callable) =>
  (callable.__endpoint.secretEnvironmentVariables || [])
    .map((secret) => secret.key)
    .sort();

const runModuleLoadingCheck = (source) => {
  const result = spawnSync(process.execPath, ["-e", source], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
};

test("binds the event-prize withdrawal secrets", () => {
  assert.deepEqual(getSecretKeys(withdrawEventPrize), [
    "EVENT_PRIZE_ADMIN_PRIVATE_KEY",
    "HELIUS_RPC_API_KEY",
  ]);
});

test("does not export the retired NFT lookup callable", () => {
  const functionExports = require("../functions");
  assert.equal(Object.hasOwn(functionExports, "getNfts"), false);
});

test("builds the Helius RPC URL from a normalized secret value", () => {
  assert.equal(
    buildHeliusRpcUrl(" key/+value "),
    "https://mainnet.helius-rpc.com/?api-key=key%2F%2Bvalue",
  );
  assert.equal(buildHeliusRpcUrl(""), "");
});

test("does not load Solana transfer dependencies with the Functions entry point", () => {
  const indexPath = path.resolve(__dirname, "../functions/index.js");
  runModuleLoadingCheck(`
    require(${JSON.stringify(indexPath)});
    const loaded = Object.keys(require.cache).filter((modulePath) =>
      modulePath.includes("/node_modules/@metaplex-foundation/") ||
      modulePath.includes("/node_modules/@solana/web3.js/")
    );
    if (loaded.length > 0) {
      throw new Error(loaded.join("\\n"));
    }
  `);
});

test("shared Solana loading excludes standard-specific SDKs", () => {
  const withdrawalPath = path.resolve(
    __dirname,
    "../functions/eventPrizeWithdrawal.js",
  );
  runModuleLoadingCheck(`
    const { loadSolanaDependencies } = require(${JSON.stringify(withdrawalPath)});
    loadSolanaDependencies();
    const loaded = Object.keys(require.cache).filter((modulePath) =>
      modulePath.includes("/node_modules/@metaplex-foundation/mpl-core/") ||
      modulePath.includes("/node_modules/@metaplex-foundation/mpl-bubblegum/")
    );
    if (loaded.length > 0) {
      throw new Error(loaded.join("\\n"));
    }
  `);
});

test("Core Solana loading excludes Bubblegum", () => {
  const withdrawalPath = path.resolve(
    __dirname,
    "../functions/eventPrizeWithdrawal.js",
  );
  runModuleLoadingCheck(`
    const { loadSolanaDependencies } = require(${JSON.stringify(withdrawalPath)});
    loadSolanaDependencies("core");
    const loaded = Object.keys(require.cache);
    const hasCore = loaded.some((modulePath) =>
      modulePath.includes("/node_modules/@metaplex-foundation/mpl-core/")
    );
    const hasBubblegum = loaded.some((modulePath) =>
      modulePath.includes("/node_modules/@metaplex-foundation/mpl-bubblegum/")
    );
    if (!hasCore || hasBubblegum) {
      throw new Error(JSON.stringify({ hasCore, hasBubblegum }));
    }
  `);
});

test("compressed Solana loading excludes Core", () => {
  const withdrawalPath = path.resolve(
    __dirname,
    "../functions/eventPrizeWithdrawal.js",
  );
  runModuleLoadingCheck(`
    const { loadSolanaDependencies } = require(${JSON.stringify(withdrawalPath)});
    loadSolanaDependencies("compressed");
    const loaded = Object.keys(require.cache);
    const hasCore = loaded.some((modulePath) =>
      modulePath.includes("/node_modules/@metaplex-foundation/mpl-core/")
    );
    const hasBubblegum = loaded.some((modulePath) =>
      modulePath.includes("/node_modules/@metaplex-foundation/mpl-bubblegum/")
    );
    if (hasCore || !hasBubblegum) {
      throw new Error(JSON.stringify({ hasCore, hasBubblegum }));
    }
  `);
});
