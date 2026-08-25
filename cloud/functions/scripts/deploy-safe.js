#!/usr/bin/env node

"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_BATCH_SIZE = 10;
const functionsDir = path.resolve(__dirname, "..");
const cloudDir = path.resolve(__dirname, "..", "..");
const indexPath = path.join(functionsDir, "index.js");

const DATABASE_DEPLOY_TARGETS = Object.freeze(["database"]);
const FIRESTORE_DEPLOY_TARGETS = Object.freeze([
  "firestore:rules",
  "firestore:indexes",
]);
const NON_FUNCTION_DEPLOY_TARGETS = Object.freeze([
  ...DATABASE_DEPLOY_TARGETS,
  ...FIRESTORE_DEPLOY_TARGETS,
]);
const FULL_RELEASE_FUNCTION_BARRIERS = Object.freeze([
  Object.freeze([
    "projectRatingTelegramUpdates",
    "projectEventTelegramOnCreated",
    "projectEventTelegramOnUpdated",
  ]),
]);

const uniqueSorted = (items) => Array.from(new Set(items)).sort();

const readExportedFunctionNames = (
  sourcePath = indexPath,
  loadModule = require,
) => {
  const exported = loadModule(sourcePath);
  if (!exported || typeof exported !== "object") {
    throw new Error("Functions entry point must export an object");
  }
  const invalidExportNames = Object.entries(exported)
    .filter(([, value]) => typeof value !== "function")
    .map(([name]) => name);
  if (invalidExportNames.length > 0) {
    throw new Error(
      `Non-function exports found: ${invalidExportNames.join(", ")}`,
    );
  }
  return uniqueSorted(Object.keys(exported));
};

const readRequiredValue = (argv, index, flag) => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
};

const readEqualsValue = (arg, flag) => {
  const value = arg.slice(`${flag}=`.length);
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
};

const parseBatchSize = (value) => {
  if (!/^\d+$/.test(value)) {
    throw new Error("batch size must be a positive integer");
  }
  const batchSize = Number(value);
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error("batch size must be a positive integer");
  }
  return batchSize;
};

const parseArgs = (argv) => {
  const options = {
    batchSize: DEFAULT_BATCH_SIZE,
    dryRun: false,
    includeNonFunctions: false,
    project: "",
    functionNames: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--include-non-functions") {
      options.includeNonFunctions = true;
      continue;
    }
    if (arg === "--batch-size") {
      options.batchSize = parseBatchSize(
        readRequiredValue(argv, index, "--batch-size"),
      );
      index += 1;
      continue;
    }
    if (arg.startsWith("--batch-size=")) {
      options.batchSize = parseBatchSize(readEqualsValue(arg, "--batch-size"));
      continue;
    }
    if (arg === "--project") {
      options.project = readRequiredValue(argv, index, "--project");
      index += 1;
      continue;
    }
    if (arg.startsWith("--project=")) {
      options.project = readEqualsValue(arg, "--project");
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    options.functionNames.push(arg);
  }

  if (options.includeNonFunctions && options.functionNames.length > 0) {
    throw new Error(
      "--include-non-functions cannot be combined with explicit function names",
    );
  }

  return options;
};

const chunk = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const buildDeploymentFunctionNames = (options, exportedFunctionNames) => {
  const allFunctionNames = uniqueSorted(exportedFunctionNames);
  const selectedFunctionNames =
    options.functionNames.length > 0
      ? Array.from(new Set(options.functionNames))
      : allFunctionNames;

  const exportedFunctionNameSet = new Set(allFunctionNames);
  const unknownFunctionNames = selectedFunctionNames.filter(
    (name) => !exportedFunctionNameSet.has(name),
  );
  if (unknownFunctionNames.length > 0) {
    throw new Error(
      `Unknown function names: ${unknownFunctionNames.join(", ")}`,
    );
  }
  if (selectedFunctionNames.length === 0) {
    throw new Error("No functions selected for deployment");
  }

  return selectedFunctionNames;
};

const indexDeploymentBatches = (batches) =>
  batches.map((batchFunctionNames, batchIndex) => ({
    batchIndex,
    batchCount: batches.length,
    functionNames: batchFunctionNames,
  }));

const buildDeploymentBatches = (functionNames, batchSize) =>
  indexDeploymentBatches(chunk(functionNames, batchSize));

const buildReleaseDeploymentBatches = (functionNames, batchSize) => {
  const remainingFunctionNames = new Set(functionNames);
  const functionGroups = FULL_RELEASE_FUNCTION_BARRIERS.map((barrier) =>
    barrier.filter((functionName) =>
      remainingFunctionNames.delete(functionName),
    ),
  );
  functionGroups.push(
    functionNames.filter((functionName) =>
      remainingFunctionNames.delete(functionName),
    ),
  );
  const batches = functionGroups
    .filter((functionGroup) => functionGroup.length > 0)
    .flatMap((functionGroup) => chunk(functionGroup, batchSize));
  return indexDeploymentBatches(batches);
};

const buildFirebaseCommandArgs = (functionNames, project) => {
  const onlyValue = functionNames.map((name) => `functions:${name}`).join(",");
  const commandArgs = ["deploy", "--only", onlyValue];
  if (project) {
    commandArgs.push("--project", project);
  }
  return commandArgs;
};

const buildFunctionReconciliationCommandArgs = (project) => {
  const commandArgs = ["deploy", "--only", "functions", "--force"];
  if (project) {
    commandArgs.push("--project", project);
  }
  return commandArgs;
};

const buildNonFunctionFirebaseCommandArgs = (targets, project) => {
  const commandArgs = ["deploy", "--only", targets.join(",")];
  if (project) {
    commandArgs.push("--project", project);
  }
  return commandArgs;
};

const getSpawnExitCode = (result) =>
  result && Number.isInteger(result.status) && result.status > 0
    ? result.status
    : 1;

const runDeployment = (argv, dependencies = {}) => {
  const options = parseArgs(argv);
  const exportedFunctionNames = dependencies.exportedFunctionNames
    ? uniqueSorted(dependencies.exportedFunctionNames)
    : readExportedFunctionNames();
  const spawn = dependencies.spawn || spawnSync;
  const log = dependencies.log || console.log;
  const workingDirectory = dependencies.cloudDir || cloudDir;
  const functionNames = buildDeploymentFunctionNames(
    options,
    exportedFunctionNames,
  );
  const batches =
    options.functionNames.length > 0
      ? buildDeploymentBatches(functionNames, options.batchSize)
      : buildReleaseDeploymentBatches(functionNames, options.batchSize);

  if (options.includeNonFunctions) {
    const commandArgs = buildNonFunctionFirebaseCommandArgs(
      DATABASE_DEPLOY_TARGETS,
      options.project,
    );
    log(`Database rules: firebase ${commandArgs.join(" ")}`);
    if (!options.dryRun) {
      const result = spawn("firebase", commandArgs, {
        cwd: workingDirectory,
        stdio: "inherit",
      });
      if (!result || result.status !== 0) {
        return {
          exitCode: getSpawnExitCode(result),
          options,
          functionNames,
          batches,
        };
      }
    }
  }

  log(
    `Deploying ${functionNames.length} functions in ${batches.length} batch(es).`,
  );

  for (const batch of batches) {
    const commandArgs = buildFirebaseCommandArgs(
      batch.functionNames,
      options.project,
    );
    log(
      `Function batch ${batch.batchIndex + 1}/${batch.batchCount}: firebase ${commandArgs.join(" ")}`,
    );
    if (options.dryRun) {
      continue;
    }
    const result = spawn("firebase", commandArgs, {
      cwd: workingDirectory,
      stdio: "inherit",
    });
    if (!result || result.status !== 0) {
      return {
        exitCode: getSpawnExitCode(result),
        options,
        functionNames,
        batches,
      };
    }
  }

  if (options.functionNames.length === 0) {
    const commandArgs = buildFunctionReconciliationCommandArgs(options.project);
    log(`Function reconciliation: firebase ${commandArgs.join(" ")}`);
    if (!options.dryRun) {
      const result = spawn("firebase", commandArgs, {
        cwd: workingDirectory,
        stdio: "inherit",
      });
      if (!result || result.status !== 0) {
        return {
          exitCode: getSpawnExitCode(result),
          options,
          functionNames,
          batches,
        };
      }
    }
  }

  if (options.includeNonFunctions) {
    const commandArgs = buildNonFunctionFirebaseCommandArgs(
      FIRESTORE_DEPLOY_TARGETS,
      options.project,
    );
    log(`Firestore rules and indexes: firebase ${commandArgs.join(" ")}`);
    if (!options.dryRun) {
      const result = spawn("firebase", commandArgs, {
        cwd: workingDirectory,
        stdio: "inherit",
      });
      if (!result || result.status !== 0) {
        return {
          exitCode: getSpawnExitCode(result),
          options,
          functionNames,
          batches,
        };
      }
    }
  }

  return { exitCode: 0, options, functionNames, batches };
};

const main = (argv = process.argv.slice(2), dependencies = {}) => {
  const error = dependencies.error || console.error;
  try {
    return runDeployment(argv, dependencies).exitCode;
  } catch (caughtError) {
    error(caughtError instanceof Error ? caughtError.message : caughtError);
    return 1;
  }
};

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
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
  chunk,
  main,
  parseArgs,
  readExportedFunctionNames,
  runDeployment,
};
