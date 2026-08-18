"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  DATABASE_DEPLOY_TARGETS,
  DEFAULT_BATCH_SIZE,
  FIRESTORE_DEPLOY_TARGETS,
  FULL_RELEASE_FUNCTION_BARRIERS,
  NON_FUNCTION_DEPLOY_TARGETS,
  buildDeploymentBatches,
  buildDeploymentFunctionNames,
  buildFirebaseCommandArgs,
  buildFunctionReconciliationCommandArgs,
  buildNonFunctionFirebaseCommandArgs,
  buildReleaseDeploymentBatches,
  parseArgs,
  readExportedFunctionNames,
  runDeployment,
} = require("../functions/scripts/deploy-safe");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const exportedFunctionNames = [
  "automatch",
  "dispatchTelegramDelivery",
  "updateRatings",
  "verifyEthAddress",
];
const expectedReleaseFunctionBarriers = [
  ["dispatchTelegramDelivery", "dispatchTelegramManualRecovery"],
  [
    "projectAutomatchTelegramMessages",
    "projectRatingTelegramUpdates",
    "projectEventTelegramOnCreated",
    "projectEventTelegramOnUpdated",
  ],
];
const eventDomainFunctionNames = [
  "createEvent",
  "joinEvent",
  "postponeEventStart",
  "removeEventParticipant",
  "disqualifyEventMatchWinners",
  "syncEventState",
  "processEventProgress",
  "processEventProgressFallback",
];

test("argument parsing supports full releases and positional maintenance", () => {
  assert.deepEqual(
    parseArgs([
      "verifyEthAddress",
      "automatch",
      "--project",
      "mons-link",
      "--batch-size=2",
      "--dry-run",
    ]),
    {
      batchSize: 2,
      dryRun: true,
      includeNonFunctions: false,
      project: "mons-link",
      functionNames: ["verifyEthAddress", "automatch"],
    },
  );
  assert.deepEqual(
    parseArgs([
      "--include-non-functions",
      "--project=mons-staging",
      "--batch-size",
      "7",
    ]),
    {
      batchSize: 7,
      dryRun: false,
      includeNonFunctions: true,
      project: "mons-staging",
      functionNames: [],
    },
  );
});

test("argument parsing rejects incomplete and conflicting options", async (t) => {
  const cases = [
    ["--batch-size", "0"],
    ["--batch-size", "1.5"],
    ["--batch-size"],
    ["--project"],
    ["--unknown"],
    ["--include-non-functions", "automatch"],
  ];
  for (const argv of cases) {
    await t.test(argv.join(" "), () => {
      assert.throws(() => parseArgs(argv));
    });
  }
});

test("the default selection contains every actual runtime export exactly once", () => {
  const runtimeExportNames = Object.keys(require("../functions/index")).sort();
  const discoveredExportNames = readExportedFunctionNames();
  const selectedFunctionNames = buildDeploymentFunctionNames(
    parseArgs([]),
    discoveredExportNames,
  );

  assert.deepEqual(discoveredExportNames, runtimeExportNames);
  assert.deepEqual(selectedFunctionNames, runtimeExportNames);
  assert.equal(
    new Set(selectedFunctionNames).size,
    selectedFunctionNames.length,
  );
});

test("future runtime exports are selected dynamically once", () => {
  const futureFunctionName = "futureFunction";
  const selectedFunctionNames = buildDeploymentFunctionNames(parseArgs([]), [
    ...exportedFunctionNames,
    futureFunctionName,
    futureFunctionName,
  ]);

  assert.equal(selectedFunctionNames.includes(futureFunctionName), true);
  assert.equal(
    selectedFunctionNames.filter((name) => name === futureFunctionName).length,
    1,
  );
});

test("positional maintenance selection is deduplicated and validated", () => {
  assert.deepEqual(
    buildDeploymentFunctionNames(
      parseArgs(["verifyEthAddress", "automatch", "verifyEthAddress"]),
      exportedFunctionNames,
    ),
    ["verifyEthAddress", "automatch"],
  );
  assert.throws(
    () =>
      buildDeploymentFunctionNames(
        parseArgs(["missingFunction"]),
        exportedFunctionNames,
      ),
    /Unknown function names: missingFunction/,
  );
  assert.throws(
    () => buildDeploymentFunctionNames(parseArgs([]), []),
    /No functions selected/,
  );
});

test("batching is flat and covers the selection exactly once", () => {
  const selectedFunctionNames = [...exportedFunctionNames].sort();
  const batches = buildDeploymentBatches(selectedFunctionNames, 2);

  assert.equal(batches.length, 2);
  assert.deepEqual(
    batches.flatMap((batch) => batch.functionNames),
    selectedFunctionNames,
  );
  for (const [index, batch] of batches.entries()) {
    assert.equal(batch.batchIndex, index);
    assert.equal(batch.batchCount, batches.length);
    assert.equal(Object.hasOwn(batch, "stageIndex"), false);
    assert.equal(Object.hasOwn(batch, "stageCount"), false);
  }
});

test("full releases preserve Telegram dependency barriers at every batch size", () => {
  const functionNames = readExportedFunctionNames();
  const prerequisiteFunctionNames = FULL_RELEASE_FUNCTION_BARRIERS.flat();
  const remainingFunctionNames = functionNames.filter(
    (functionName) => !prerequisiteFunctionNames.includes(functionName),
  );

  assert.deepEqual(
    FULL_RELEASE_FUNCTION_BARRIERS,
    expectedReleaseFunctionBarriers,
  );
  for (const prerequisiteFunctionName of prerequisiteFunctionNames) {
    assert.equal(
      functionNames.includes(prerequisiteFunctionName),
      true,
      prerequisiteFunctionName,
    );
  }

  for (const batchSize of [1, 2, DEFAULT_BATCH_SIZE, 100]) {
    const batches = buildReleaseDeploymentBatches(functionNames, batchSize);
    const flattenedFunctionNames = batches.flatMap(
      (batch) => batch.functionNames,
    );
    const batchIndexByFunctionName = new Map(
      batches.flatMap((batch, batchIndex) =>
        batch.functionNames.map((functionName) => [functionName, batchIndex]),
      ),
    );
    const deliveryBatchIndexes = FULL_RELEASE_FUNCTION_BARRIERS[0].map(
      (functionName) => batchIndexByFunctionName.get(functionName),
    );
    const projectorBatchIndexes = FULL_RELEASE_FUNCTION_BARRIERS[1].map(
      (functionName) => batchIndexByFunctionName.get(functionName),
    );
    const remainingBatchIndexes = remainingFunctionNames.map((functionName) =>
      batchIndexByFunctionName.get(functionName),
    );

    assert.deepEqual(
      [...flattenedFunctionNames].sort(),
      [...functionNames].sort(),
    );
    assert.equal(
      new Set(flattenedFunctionNames).size,
      flattenedFunctionNames.length,
    );
    assert.ok(
      Math.max(...deliveryBatchIndexes) < Math.min(...projectorBatchIndexes),
    );
    assert.ok(
      Math.max(...projectorBatchIndexes) < Math.min(...remainingBatchIndexes),
    );
    const batchIndex = (functionName) =>
      batchIndexByFunctionName.get(functionName);
    assert.ok(
      batchIndex("projectAutomatchTelegramMessages") < batchIndex("automatch"),
    );
    assert.ok(
      batchIndex("projectRatingTelegramUpdates") < batchIndex("updateRatings"),
    );
    for (const eventDomainFunctionName of eventDomainFunctionNames) {
      assert.ok(
        batchIndex("projectEventTelegramOnCreated") <
          batchIndex(eventDomainFunctionName),
      );
      assert.ok(
        batchIndex("projectEventTelegramOnUpdated") <
          batchIndex(eventDomainFunctionName),
      );
    }
    for (const [index, batch] of batches.entries()) {
      assert.equal(batch.batchIndex, index);
      assert.equal(batch.batchCount, batches.length);
      assert.ok(batch.functionNames.length <= batchSize);
      assert.equal(Object.hasOwn(batch, "stageIndex"), false);
      assert.equal(Object.hasOwn(batch, "stageCount"), false);
    }
  }
});

test("positional maintenance batches only the requested functions", () => {
  const calls = [];
  const result = runDeployment(
    ["verifyEthAddress", "automatch", "--batch-size", "100"],
    {
      exportedFunctionNames,
      log: () => {},
      spawn: (command, args) => {
        calls.push({ command, args });
        return { status: 0 };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.functionNames, ["verifyEthAddress", "automatch"]);
  assert.equal(result.batches.length, 1);
  assert.deepEqual(result.batches[0].functionNames, [
    "verifyEthAddress",
    "automatch",
  ]);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].args[2],
    "functions:verifyEthAddress,functions:automatch",
  );
});

test("Firebase command builders forward the project to exact targets", () => {
  assert.deepEqual(buildFirebaseCommandArgs(["automatch"], "mons-link"), [
    "deploy",
    "--only",
    "functions:automatch",
    "--project",
    "mons-link",
  ]);
  assert.deepEqual(buildFunctionReconciliationCommandArgs("mons-link"), [
    "deploy",
    "--only",
    "functions",
    "--force",
    "--project",
    "mons-link",
  ]);
  assert.deepEqual(
    buildNonFunctionFirebaseCommandArgs(
      ["firestore:rules", "firestore:indexes"],
      "mons-link",
    ),
    [
      "deploy",
      "--only",
      "firestore:rules,firestore:indexes",
      "--project",
      "mons-link",
    ],
  );
  assert.deepEqual(NON_FUNCTION_DEPLOY_TARGETS, [
    "database",
    "firestore:rules",
    "firestore:indexes",
  ]);
  assert.deepEqual(DATABASE_DEPLOY_TARGETS, ["database"]);
  assert.deepEqual(FIRESTORE_DEPLOY_TARGETS, [
    "firestore:rules",
    "firestore:indexes",
  ]);
});

test("dry-run previews the complete release without spawning Firebase", () => {
  const calls = [];
  const logs = [];
  const result = runDeployment(
    [
      "--include-non-functions",
      "--dry-run",
      "--project",
      "forwarded-project",
      "--batch-size",
      "2",
    ],
    {
      exportedFunctionNames,
      log: (message) => logs.push(message),
      spawn: (...args) => {
        calls.push(args);
        return { status: 0 };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 0);
  assert.equal(logs.length, 7);
  assert.equal(
    logs.filter((line) => line.includes("--project forwarded-project")).length,
    6,
  );
  assert.match(logs.at(0), /--only database --project forwarded-project$/);
  assert.match(
    logs.at(-2),
    /--only functions --force --project forwarded-project$/,
  );
  assert.match(
    logs.at(-1),
    /--only firestore:rules,firestore:indexes --project forwarded-project$/,
  );
});

test("full release forwards one project through every spawned deployment", () => {
  const calls = [];
  const result = runDeployment(
    [
      "--include-non-functions",
      "--project",
      "forwarded-project",
      "--batch-size=2",
    ],
    {
      cloudDir: "/cloud",
      exportedFunctionNames,
      log: () => {},
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 6);
  assert.deepEqual(
    calls
      .flatMap(({ args }) =>
        args[2].startsWith("functions:")
          ? args[2]
              .split(",")
              .map((target) => target.slice("functions:".length))
          : [],
      )
      .sort(),
    [...exportedFunctionNames].sort(),
  );
  for (const call of calls) {
    assert.equal(call.command, "firebase");
    assert.deepEqual(call.args.slice(-2), ["--project", "forwarded-project"]);
    assert.deepEqual(call.options, { cwd: "/cloud", stdio: "inherit" });
  }
  assert.equal(calls.at(0).args[2], DATABASE_DEPLOY_TARGETS.join(","));
  assert.deepEqual(calls.at(-2).args, [
    "deploy",
    "--only",
    "functions",
    "--force",
    "--project",
    "forwarded-project",
  ]);
  assert.equal(calls.at(-1).args[2], FIRESTORE_DEPLOY_TARGETS.join(","));
});

test("a failed function batch prevents Firestore deployment", () => {
  const calls = [];
  const statuses = [0, 0, 7, 0];
  const result = runDeployment(
    ["--include-non-functions", "--batch-size", "2"],
    {
      exportedFunctionNames,
      log: () => {},
      spawn: (command, args) => {
        calls.push({ command, args });
        return { status: statuses[calls.length - 1] };
      },
    },
  );

  assert.equal(result.exitCode, 7);
  assert.equal(calls.length, 3);
  assert.equal(
    calls.some(({ args }) => args[2] === FIRESTORE_DEPLOY_TARGETS.join(",")),
    false,
  );
});

test("a failed database rules deployment prevents function deployment", () => {
  const calls = [];
  const result = runDeployment(["--include-non-functions"], {
    exportedFunctionNames,
    log: () => {},
    spawn: (command, args) => {
      calls.push({ command, args });
      return { status: 6 };
    },
  });

  assert.equal(result.exitCode, 6);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[2], DATABASE_DEPLOY_TARGETS.join(","));
});

test("a failed function reconciliation prevents Firestore deployment", () => {
  const calls = [];
  const result = runDeployment(
    ["--include-non-functions", "--batch-size", "20"],
    {
      exportedFunctionNames,
      log: () => {},
      spawn: (command, args) => {
        calls.push({ command, args });
        return { status: args[2] === "functions" ? 8 : 0 };
      },
    },
  );

  assert.equal(result.exitCode, 8);
  assert.equal(calls.length, result.batches.length + 2);
  assert.equal(calls.at(-1).args[2], "functions");
  assert.equal(
    calls.some(({ args }) => args[2] === FIRESTORE_DEPLOY_TARGETS.join(",")),
    false,
  );
});

test("a failed non-function deployment is propagated", () => {
  const calls = [];
  const result = runDeployment(
    ["--include-non-functions", "--batch-size", "20"],
    {
      exportedFunctionNames,
      log: () => {},
      spawn: (command, args) => {
        calls.push({ command, args });
        return {
          status: args[2] === FIRESTORE_DEPLOY_TARGETS.join(",") ? 9 : 0,
        };
      },
    },
  );

  assert.equal(result.exitCode, 9);
  assert.equal(calls.length, result.batches.length + 3);
  assert.equal(calls.at(-1).args[2], FIRESTORE_DEPLOY_TARGETS.join(","));
});

test("package entry points expose one test-gated production release", () => {
  const rootPackageJson = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const functionsPackageJson = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, "cloud", "functions", "package.json"),
      "utf8",
    ),
  );

  assert.equal(
    rootPackageJson.scripts["prepare:firebase"],
    "npm --prefix cloud/functions ci && npm --prefix cloud/functions test",
  );
  assert.equal(
    rootPackageJson.scripts["deploy:firebase"],
    "npm run prepare:firebase && node cloud/functions/scripts/deploy-safe.js --include-non-functions",
  );
  assert.equal(
    rootPackageJson.scripts["deploy:allFunctionsBatched"],
    undefined,
  );
  assert.equal(rootPackageJson.scripts["deploy:telegramFunctions"], undefined);
  assert.equal(rootPackageJson.scripts["deploy:monsRulesFunctions"], undefined);
  assert.equal(
    functionsPackageJson.scripts.test,
    "node --experimental-strip-types --test ../tests/*.test.js",
  );
  assert.equal(
    functionsPackageJson.scripts.deploy,
    "npm test && npm run deploy:safe -- --include-non-functions",
  );
  assert.equal(
    functionsPackageJson.scripts["deploy:safe"],
    "node ./scripts/deploy-safe.js",
  );
});

test("operations documentation uses the release driver and required setup", () => {
  const readme = fs.readFileSync(
    path.join(repositoryRoot, "cloud", "README.md"),
    "utf8",
  );
  const deploymentGuide = fs.readFileSync(
    path.join(repositoryRoot, "scripts", "deploy-cloudflare.md"),
    "utf8",
  );
  const operationsDocumentation = `${readme}\n${deploymentGuide}`;

  assert.match(readme, /deploy:firebase -- --project mons-link/);
  assert.match(readme, /deploy:firebase -- --project mons-link --dry-run/);
  assert.match(readme, /deploy:safe -- verifyEthAddress --project mons-link/);
  assert.match(readme, /removes deployed Firebase-managed Functions/);
  assert.match(readme, /maintenance deployments do not prune/);
  assert.match(readme, /functions:secrets:set TELEGRAM_BOT_TOKEN/);
  assert.match(readme, /functions:secrets:set TELEGRAM_EXTRA_CHAT_ID/);
  assert.match(readme, /TELEGRAM_QUEUE_BRIDGE_SECRET/);
  assert.match(readme, /Telegram delivery migration guide/);
  assert.doesNotMatch(readme, /firebase deploy[^\n]*--only functions/);
  assert.match(deploymentGuide, /deploy:firebase -- --project mons-link/);
  assert.doesNotMatch(
    operationsDocumentation,
    /deploy:(?:allFunctionsBatched|telegramFunctions|monsRulesFunctions)/,
  );
});

test("default batch size remains quota-oriented", () => {
  assert.equal(DEFAULT_BATCH_SIZE, 10);
});
