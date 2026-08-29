import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

type ControlState = "firestore" | "importing" | "frozen" | "active";
type Operation = "status" | "begin-import" | "freeze" | "resume";
type Control = { importedAtMs: number | null; state: ControlState };
type Dependencies = {
  log(message: string): void;
  readControl(): Control;
  updateState(expected: ControlState, next: ControlState): void;
};

const DATABASE = "mons-link-profiles";
const CONFIG = "cloud/workers/api/wrangler.jsonc";
const RELEASE_ENV = "cloud/workers/api/release.env";

function parseArgs(argv: string[]): Operation {
  if (argv.length !== 1) {
    throw new TypeError(
      "choose exactly one profile canonical control operation",
    );
  }
  const value = argv[0]?.replace(/^--/, "") as Operation;
  if (
    value !== "status" &&
    value !== "begin-import" &&
    value !== "freeze" &&
    value !== "resume"
  ) {
    throw new TypeError(
      "choose exactly one profile canonical control operation",
    );
  }
  return value;
}

function transition(operation: Exclude<Operation, "status">): {
  expected: readonly ControlState[];
  next: ControlState;
} {
  if (operation === "begin-import")
    return { expected: ["firestore"], next: "importing" };
  if (operation === "freeze") return { expected: ["active"], next: "frozen" };
  return { expected: ["frozen"], next: "active" };
}

function manageProfileCanonical(
  operation: Operation,
  dependencies: Dependencies,
): void {
  let control = dependencies.readControl();
  if (operation !== "status") {
    const change = transition(operation);
    if (control.state !== change.next) {
      if (!change.expected.includes(control.state)) {
        throw new Error("profile canonical control transition rejected");
      }
      dependencies.updateState(control.state, change.next);
      control = dependencies.readControl();
      if (control.state !== change.next) {
        throw new Error("profile canonical control transition failed");
      }
    }
  }
  dependencies.log(
    JSON.stringify({
      operation,
      state: control.state,
      imported: control.importedAtMs !== null,
    }),
  );
}

function runWrangler(command: string): Array<Record<string, unknown>> {
  const result = spawnSync(
    resolve("node_modules/.bin/wrangler"),
    [
      "d1",
      "execute",
      DATABASE,
      "--remote",
      "--config",
      CONFIG,
      "--env-file",
      RELEASE_ENV,
      "--command",
      command,
      "--json",
    ],
    {
      cwd: resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    },
  );
  if (result.status !== 0) throw new Error("wrangler command failed");
  const parsed = JSON.parse(String(result.stdout)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("invalid D1 JSON response");
  const entry = parsed.find(
    (value) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Array.isArray((value as { results?: unknown }).results),
  ) as { results?: unknown[] } | undefined;
  return (entry?.results || []).filter(
    (value): value is Record<string, unknown> =>
      !!value && typeof value === "object" && !Array.isArray(value),
  );
}

function readRemoteControl(): Control {
  const row = runWrangler(
    "SELECT state, imported_at_ms FROM profile_canonical_control WHERE singleton = 1",
  )[0];
  const state = row?.state;
  const importedAtMs = row?.imported_at_ms;
  if (
    (state !== "firestore" &&
      state !== "importing" &&
      state !== "active" &&
      state !== "frozen") ||
    ((state === "firestore" || state === "importing") &&
      importedAtMs !== null) ||
    ((state === "active" || state === "frozen") &&
      (!Number.isSafeInteger(importedAtMs) || (importedAtMs as number) < 0))
  ) {
    throw new Error("invalid profile canonical control");
  }
  return { state, importedAtMs: importedAtMs as number | null };
}

function updateRemoteState(expected: ControlState, next: ControlState): void {
  runWrangler(
    `UPDATE profile_canonical_control SET state = '${next}' WHERE singleton = 1 AND state = '${expected}'`,
  );
}

function execute(argv = process.argv.slice(2)): void {
  manageProfileCanonical(parseArgs(argv), {
    log: console.log,
    readControl: readRemoteControl,
    updateState: updateRemoteState,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    execute();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "management failed");
    process.exitCode = 1;
  }
}

export {
  execute,
  manageProfileCanonical,
  parseArgs,
  transition,
  type Control,
  type ControlState,
  type Dependencies,
  type Operation,
};
