#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_BATCH_SIZE = 10;
const functionsDir = path.resolve(__dirname, "..");
const cloudDir = path.resolve(__dirname, "..", "..");
const indexPath = path.join(functionsDir, "index.js");

const readExportedFunctionNames = () => {
  const source = fs.readFileSync(indexPath, "utf8");
  const matches = source.matchAll(/^exports\.(\w+)\s*=/gm);
  return Array.from(new Set(Array.from(matches, (match) => match[1]))).sort();
};

const parseArgs = (argv) => {
  const options = {
    batchSize: DEFAULT_BATCH_SIZE,
    dryRun: false,
    project: "",
    functionNames: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--batch-size") {
      options.batchSize = Number.parseInt(argv[index + 1] || "", 10);
      index += 1;
      continue;
    }
    if (arg.startsWith("--batch-size=")) {
      options.batchSize = Number.parseInt(
        arg.slice("--batch-size=".length),
        10,
      );
      continue;
    }
    if (arg === "--project") {
      options.project = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--project=")) {
      options.project = arg.slice("--project=".length);
      continue;
    }
    options.functionNames.push(arg);
  }

  if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
    throw new Error("batch size must be a positive integer");
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

const allFunctionNames = readExportedFunctionNames();
const options = parseArgs(process.argv.slice(2));
const selectedFunctionNames =
  options.functionNames.length > 0
    ? Array.from(new Set(options.functionNames))
    : allFunctionNames;

const unknownFunctionNames = selectedFunctionNames.filter(
  (name) => !allFunctionNames.includes(name),
);
if (unknownFunctionNames.length > 0) {
  console.error("Unknown function names:", unknownFunctionNames.join(", "));
  process.exit(1);
}

const batches = chunk(selectedFunctionNames, options.batchSize);
console.log(
  `Deploying ${selectedFunctionNames.length} functions in ${batches.length} batch(es) of up to ${options.batchSize}.`,
);

for (const [index, batch] of batches.entries()) {
  const onlyValue = batch.map((name) => `functions:${name}`).join(",");
  const commandArgs = ["deploy", "--only", onlyValue];
  if (options.project) {
    commandArgs.push("--project", options.project);
  }

  console.log(
    `\nBatch ${index + 1}/${batches.length}: firebase ${commandArgs.join(" ")}`,
  );

  if (options.dryRun) {
    continue;
  }

  const result = spawnSync("firebase", commandArgs, {
    cwd: cloudDir,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
