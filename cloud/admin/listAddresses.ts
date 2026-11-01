#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProfileD1Reader, type ProfileD1Reader } from "./_d1.ts";

export const USAGE =
  "Usage: node --experimental-strip-types cloud/admin/listAddresses.ts (--out-eth <new-file> | --out-sol <new-file>) [--out-eth <new-file>] [--out-sol <new-file>]";
type AddressOptions = { outEth: string | null; outSol: string | null };

export function parseArgs(argv: readonly string[]): AddressOptions {
  const options: AddressOptions = { outEth: null, outSol: null };
  const seen = new Set<string>();
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

export function writeProtectedFile(
  path: string,
  values: readonly string[],
): void {
  writeFileSync(path, `${values.join("\n")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export async function listUniqueAddresses({
  outEth,
  outSol,
  reader,
  log = console.log,
  writeFile = writeProtectedFile,
}: {
  outEth?: string | null;
  outSol?: string | null;
  reader?: Pick<ProfileD1Reader, "listAddresses">;
  log?: (message: string) => void;
  writeFile?: (path: string, values: string[]) => void;
} = {}): Promise<void> {
  if (!outEth && !outSol) {
    throw new TypeError(USAGE);
  }
  const rows = await (reader || createProfileD1Reader()).listAddresses();
  const ethSet = new Set<string>();
  const solSet = new Set<string>();
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

export async function main(): Promise<void> {
  await listUniqueAddresses(parseArgs(process.argv.slice(2)));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
