import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const knipExecutable = resolve(repositoryRoot, "node_modules/knip/bin/knip.js");

function fixture(t: test.TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), "mons-unused-code-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file: string, source: string) => {
    const path = resolve(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  };
  const json = (file: string, value: unknown) =>
    write(file, JSON.stringify(value));
  const manifest = {
    name: "mons-unused-code-fixture",
    private: true,
    type: "module",
    dependencies: { "@mons/shared": "file:cloud/runtime/shared" },
  };
  json("package.json", manifest);
  write(
    "knip.json",
    readFileSync(resolve(repositoryRoot, "knip.json"), "utf8"),
  );
  json("tsconfig.json", {
    compilerOptions: {
      target: "ES2024",
      module: "ESNext",
      moduleResolution: "Bundler",
      allowJs: true,
    },
    include: ["src/**/*", "test/**/*"],
  });
  json("cloud/runtime/package.json", {
    name: "mons-cloud-runtime",
    private: true,
    type: "commonjs",
    dependencies: { "@mons/shared": "file:shared" },
  });
  json("cloud/runtime/tsconfig.json", {
    compilerOptions: {
      module: "Node16",
      moduleResolution: "Node16",
      rootDir: "src",
      outDir: ".",
      paths: { "@mons/shared/*": ["./src/shared/*.ts"] },
    },
    include: ["src/**/*.ts"],
    exclude: ["node_modules"],
  });
  json("cloud/runtime/shared/package.json", {
    name: "@mons/shared",
    private: true,
    type: "commonjs",
    exports: { "./fixture": "./fixture.js" },
  });
  write(
    "cloud/runtime/shared/tsconfig.json",
    readFileSync(
      resolve(repositoryRoot, "cloud/runtime/shared/tsconfig.json"),
      "utf8",
    ),
  );
  json("cloud/admin/package.json", { private: true, type: "module" });
  json("cloud/workers/api/package.json", { private: true, type: "module" });
  mkdirSync(resolve(root, "node_modules/@mons"), { recursive: true });
  symlinkSync(
    resolve(root, "cloud/runtime/shared"),
    resolve(root, "node_modules/@mons/shared"),
    "dir",
  );
  write(
    "cloud/runtime/src/shared/fixture.ts",
    "export type SharedValue = { value: number };\nexport const makeSharedValue = (): SharedValue => ({ value: 1 });\n",
  );
  write(
    "cloud/runtime/shared/fixture.js",
    "exports.makeSharedValue = () => ({ value: 1 });\n",
  );
  write(
    "cloud/runtime/shared/fixture.d.ts",
    "export type SharedValue = { value: number };\nexport declare const makeSharedValue: () => SharedValue;\n",
  );
  write(
    "cloud/runtime/src/runtimeValue.ts",
    'import { makeSharedValue } from "@mons/shared/fixture";\nexport const runtimeValue = makeSharedValue().value + 1;\n',
  );
  write("cloud/runtime/runtimeValue.js", "exports.runtimeValue = 2;\n");
  write(
    "cloud/runtime/runtimeValue.d.ts",
    "export declare const runtimeValue = 2;\n",
  );
  write(
    "src/bootstrap.ts",
    `import { makeSharedValue, type SharedValue } from "@mons/shared/fixture";
import { runtimeValue } from "../cloud/runtime/runtimeValue.js";
import { usedValue } from "./used";
const value: SharedValue = makeSharedValue();
console.log(value.value + runtimeValue + usedValue);
new Worker(new URL("./game/automoveWorker.ts", import.meta.url));
void import("./game/particle-effects").then(({ externallyLoadedEffect }) => externallyLoadedEffect());
`,
  );
  write(
    "src/used.ts",
    `export const usedValue = 3;
/** @knipExternal Called from injected browser fixture source. */
export const injectedCommand = () => usedValue;
`,
  );
  write(
    "src/game/automoveWorker.ts",
    "export const workerCommand = () => 4;\n",
  );
  write(
    "src/game/particle-effects.ts",
    "export const externallyLoadedEffect = () => 5;\n",
  );
  write("cloud/admin/listAddresses.ts", "console.log('admin entry');\n");
  write(
    "cloud/workers/api/src/index.ts",
    `import { runtimeValue } from "../../../runtime/runtimeValue.js";
export class InviteReactions { fetch() { return new Response(String(runtimeValue)); } }
export class EventProgressWorkflow { run() { return runtimeValue; } }
export default { fetch() { return new Response(String(runtimeValue)); } };
`,
  );
  write(
    "test/fixtures/eventModalHarness.tsx",
    'import { browserValue } from "./browserHelper";\nexport const harness = { value: browserValue };\n',
  );
  write("test/fixtures/browserHelper.ts", "export const browserValue = 6;\n");
  write("src/testOnly.ts", "export const testOnly = 7;\n");
  write(
    "test/testOnly.test.mjs",
    'import { testOnly } from "../src/testOnly.ts";\nconsole.log(testOnly);\n',
  );
  write("scripts/operator/testOnly.ts", "export const testOnlyTool = 8;\n");
  write(
    "scripts/tooling.test.ts",
    'import { testOnlyTool } from "./operator/testOnly";\nconsole.log(testOnlyTool);\n',
  );
  return { root, write, json, manifest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function gateCommands(): string[][] {
  const manifest: unknown = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  );
  assert.ok(isRecord(manifest) && isRecord(manifest.scripts));
  const command = manifest.scripts["check:unused"];
  assert.ok(typeof command === "string");
  return command.split(/\s*&&\s*/).map((part) => {
    const [binary, ...args] = part.trim().split(/\s+/);
    assert.equal(binary, "knip");
    return args;
  });
}

function runKnip(root: string, args: string[]) {
  const child = spawnSync(
    process.execPath,
    [knipExecutable, ...args, "--reporter", "json"],
    { cwd: root, encoding: "utf8", timeout: 60_000 },
  );
  assert.ifError(child.error);
  assert.equal(child.signal, null, child.stderr);
  const report: unknown = JSON.parse(child.stdout);
  assert.ok(isRecord(report) && Array.isArray(report.issues), child.stdout);
  const rows: unknown[] = report.issues;
  const issues = rows.map((row) => {
    assert.ok(isRecord(row) && typeof row.file === "string", child.stdout);
    return row;
  });
  return { status: child.status, issues, output: child.stdout + child.stderr };
}

function names(
  issues: Record<string, unknown>[],
  file: string,
  category: string,
): string[] {
  const entries = issues.find((issue) => issue.file === file)?.[category];
  assert.ok(Array.isArray(entries), `Missing ${category} findings for ${file}`);
  const values: unknown[] = entries;
  return values.map((entry) => {
    assert.ok(isRecord(entry) && typeof entry.name === "string");
    return entry.name;
  });
}

test("unused-code configuration has no stale explicit repository entrypoints", () => {
  const config: unknown = JSON.parse(
    readFileSync(resolve(repositoryRoot, "knip.json"), "utf8"),
  );
  assert.ok(isRecord(config) && isRecord(config.workspaces));
  let explicitEntries = 0;
  for (const [workspace, settings] of Object.entries(config.workspaces)) {
    assert.ok(isRecord(settings) && Array.isArray(settings.entry));
    const entries: unknown[] = settings.entry;
    for (const entry of entries) {
      assert.ok(typeof entry === "string");
      if (entry.startsWith("!") || /[*?{[\]]/.test(entry)) continue;
      const file = entry.replace(/!$/, "");
      assert.ok(
        existsSync(resolve(repositoryRoot, workspace, file)),
        `Stale unused-code entrypoint: ${workspace}/${file}`,
      );
      explicitEntries += 1;
    }
  }
  assert.ok(explicitEntries > 0);
});

test("unused-code gate honors real entrypoints and generated source mappings while rejecting dead code", (t) => {
  const commands = gateCommands();
  assert.equal(commands.length, 2);
  const [standardCommand, productionCommand] = commands;
  assert.ok(standardCommand && productionCommand);
  const f = fixture(t);
  const clean = runKnip(f.root, standardCommand);
  assert.equal(clean.status, 0, clean.output);
  assert.deepEqual(clean.issues, []);

  const production = runKnip(f.root, productionCommand);
  assert.equal(production.status, 1, production.output);
  assert.deepEqual(
    production.issues.map((issue) => issue.file).sort(),
    ["scripts/operator/testOnly.ts", "src/testOnly.ts"],
    production.output,
  );

  f.write("src/orphan.ts", "export const orphan = true;\n");
  f.write(
    "src/used.ts",
    "export const usedValue = 3;\nexport const unusedValue = 8;\nexport type UnusedType = { value: number };\n",
  );
  f.write(
    "cloud/runtime/src/runtimeValue.ts",
    'import { makeSharedValue } from "@mons/shared/fixture";\nexport const runtimeValue = makeSharedValue().value + 1;\nexport const unusedRuntimeValue = 9;\n',
  );
  f.write(
    "src/game/particle-effects.ts",
    "export const externallyLoadedEffect = () => 5;\nexport const unusedEffect = () => 10;\n",
  );
  f.json("package.json", {
    ...f.manifest,
    dependencies: {
      ...f.manifest.dependencies,
      "unused-fixture-dependency": "1.0.0",
    },
  });
  const seeded = runKnip(f.root, standardCommand);
  assert.equal(seeded.status, 1, seeded.output);
  assert.equal(names(seeded.issues, "src/orphan.ts", "files").length, 1);
  assert.deepEqual(names(seeded.issues, "src/used.ts", "exports"), [
    "unusedValue",
  ]);
  assert.deepEqual(names(seeded.issues, "src/used.ts", "types"), [
    "UnusedType",
  ]);
  assert.deepEqual(
    names(seeded.issues, "cloud/runtime/src/runtimeValue.ts", "exports"),
    ["unusedRuntimeValue"],
  );
  assert.deepEqual(
    names(seeded.issues, "src/game/particle-effects.ts", "exports"),
    ["unusedEffect"],
  );
  assert.deepEqual(names(seeded.issues, "package.json", "dependencies"), [
    "unused-fixture-dependency",
  ]);
});
