#!/usr/bin/env node
const fs = require("fs");
const { createProfileD1Reader } = require("./_d1");

const USAGE =
  "Usage: node cloud/admin/listAddresses.js (--out-eth <new-file> | --out-sol <new-file>) [--out-eth <new-file>] [--out-sol <new-file>]";

function parseArgs(argv) {
  const options = { outEth: null, outSol: null };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--out-eth" && argument !== "--out-sol") {
      throw new TypeError(USAGE);
    }
    if (seen.has(argument)) {
      throw new TypeError(USAGE);
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new TypeError(USAGE);
    }
    seen.add(argument);
    if (argument === "--out-eth") {
      options.outEth = value;
    } else {
      options.outSol = value;
    }
  }
  if (
    (!options.outEth && !options.outSol) ||
    (options.outEth && options.outEth === options.outSol)
  ) {
    throw new TypeError(USAGE);
  }
  return options;
}

function writeProtectedFile(path, values) {
  fs.writeFileSync(path, `${values.join("\n")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function listUniqueAddresses({
  outEth,
  outSol,
  reader,
  log = console.log,
  writeFile = writeProtectedFile,
} = {}) {
  if (!outEth && !outSol) {
    throw new TypeError(USAGE);
  }
  const rows = await (reader || createProfileD1Reader()).listAddresses();
  const ethSet = new Set();
  const solSet = new Set();
  for (const row of rows) {
    if (row.method === "eth" && typeof row.value === "string") {
      ethSet.add(row.value.trim().toLowerCase());
    }
    if (row.method === "sol" && typeof row.value === "string") {
      solSet.add(row.value.trim());
    }
  }
  const ethList = Array.from(ethSet).filter(Boolean).sort();
  const solList = Array.from(solSet).filter(Boolean).sort();
  if (outEth) {
    writeFile(outEth, ethList);
    log(`ETH addresses exported: ${ethList.length}`);
  }
  if (outSol) {
    writeFile(outSol, solList);
    log(`SOL addresses exported: ${solList.length}`);
  }
}

async function main() {
  await listUniqueAddresses(parseArgs(process.argv.slice(2)));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  USAGE,
  listUniqueAddresses,
  main,
  parseArgs,
  writeProtectedFile,
};
