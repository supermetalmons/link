"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const functionsDirectory = path.resolve(__dirname, "../functions");
const sharedDirectory = path.join(functionsDirectory, "shared");

const expectedSharedExports = {
  "./auth": "./auth.js",
  "./event-prizes": "./event-prizes.js",
  "./events": "./events.js",
  "./game-sessions": "./game-sessions.js",
  "./game-variants": "./game-variants.js",
  "./ids": "./ids.js",
  "./match-protocol": "./match-protocol.js",
  "./mining": "./mining.js",
  "./navigation": "./navigation.js",
  "./nfts": "./nfts.js",
  "./profiles": "./profiles.js",
  "./ratings": "./ratings.js",
  "./rematches": "./rematches.js",
  "./solana": "./solana.js",
  "./timers": "./timers.js",
  "./usernames": "./usernames.js",
  "./wagers": "./wagers.js",
  "./x-redirect": "./x-redirect.js",
};

test("preserves the @mons/shared subpath export map and declarations", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(sharedDirectory, "package.json"), "utf8"),
  );

  assert.equal(packageJson.name, "@mons/shared");
  assert.deepEqual(packageJson.exports, expectedSharedExports);

  for (const target of Object.values(expectedSharedExports)) {
    const implementationPath = path.join(sharedDirectory, target);
    const declarationPath = implementationPath.replace(/\.js$/, ".d.ts");
    assert.equal(fs.existsSync(implementationPath), true, implementationPath);
    assert.equal(fs.existsSync(declarationPath), true, declarationPath);
  }
});

test("keeps standard-specific Solana SDKs out of portable module loading", () => {
  const script = `
    require(${JSON.stringify(path.join(functionsDirectory, "eventPrizes/solana.js"))});
    const forbidden = [
      "/node_modules/@metaplex-foundation/mpl-core/",
      "/node_modules/@metaplex-foundation/mpl-bubblegum/",
    ];
    const loaded = Object.keys(require.cache).filter((modulePath) =>
      forbidden.some((fragment) => modulePath.includes(fragment))
    );
    if (loaded.length > 0) {
      throw new Error(loaded.join("\\n"));
    }
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
