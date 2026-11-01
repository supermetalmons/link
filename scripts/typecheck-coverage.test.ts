import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  checkedProjects,
  inspectTypecheckCoverage,
} from "./typecheck-coverage.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), "strict-coverage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "test"));
  mkdirSync(resolve(root, "cloud/tests"), { recursive: true });
  const config = {
    compilerOptions: {
      target: "ES2024",
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
      noCheck: false,
      types: [],
      strict: true,
      allowJs: true,
      checkJs: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
    },
    include: [
      "test/**/*",
      "cloud/tests/**/*.js",
      "vite.config.mts",
      "eslint.config.mjs",
    ],
  };
  const writeConfig = () =>
    writeFileSync(resolve(root, "tsconfig.json"), JSON.stringify(config));
  writeFileSync(
    resolve(root, "package.json"),
    JSON.stringify({
      scripts: {
        "check:all": "npm run check",
        check: "npm run types",
        types: "tsc --noEmit",
      },
    }),
  );
  for (const file of [
    "test/example.test.mjs",
    "cloud/tests/example.test.js",
    "vite.config.mts",
    "eslint.config.mjs",
  ])
    writeFileSync(resolve(root, file), "export const value = 1;\n");
  writeConfig();
  return { root, config, writeConfig };
}

test("full gate reaches strict compiler programs covering tests and configuration", (t) => {
  const f = fixture(t);
  assert.deepEqual(checkedProjects(f.root), [resolve(f.root, "tsconfig.json")]);
  const result = inspectTypecheckCoverage(f.root);
  assert.equal(result.requiredFiles.length, 4);
  assert.deepEqual(result.missingFiles, []);
  assert.deepEqual(result.unsafe, []);
});

test("unlisted files and JavaScript without semantic checks remain uncovered", (t) => {
  const f = fixture(t);
  f.config.include = ["test/**/*", "vite.config.mts"];
  f.writeConfig();
  assert.deepEqual(inspectTypecheckCoverage(f.root).missingFiles, [
    "cloud/tests/example.test.js",
    "eslint.config.mjs",
  ]);
  f.config.include = [
    "test/**/*",
    "cloud/tests/**/*.js",
    "vite.config.mts",
    "eslint.config.mjs",
  ];
  f.config.compilerOptions.checkJs = false;
  f.writeConfig();
  assert.deepEqual(inspectTypecheckCoverage(f.root).missingFiles, [
    "cloud/tests/example.test.js",
    "eslint.config.mjs",
    "test/example.test.mjs",
  ]);
});

test("weakening strict or indexed/optional checks cannot satisfy coverage", (t) => {
  const f = fixture(t);
  f.config.compilerOptions.noUncheckedIndexedAccess = false;
  f.writeConfig();
  assert.equal(inspectTypecheckCoverage(f.root).missingFiles.length, 4);
  f.config.compilerOptions.noUncheckedIndexedAccess = true;
  f.config.compilerOptions.exactOptionalPropertyTypes = false;
  f.writeConfig();
  assert.equal(inspectTypecheckCoverage(f.root).missingFiles.length, 4);
  f.config.compilerOptions.exactOptionalPropertyTypes = true;
  f.config.compilerOptions.noCheck = true;
  f.writeConfig();
  assert.equal(inspectTypecheckCoverage(f.root).missingFiles.length, 4);
});

test("actual suppression directives and explicit any are rejected, quoted compiler fixtures are allowed", (t) => {
  const f = fixture(t),
    path = resolve(f.root, "test/example.test.mjs");
  writeFileSync(
    path,
    "// @ts-nocheck\n/** @type {any} */\nexport const value = 1;\n",
  );
  assert.deepEqual(inspectTypecheckCoverage(f.root).unsafe, [
    {
      file: "test/example.test.mjs",
      issues: ["typecheck-suppression", "explicit-any"],
    },
  ]);
  writeFileSync(
    path,
    'export const quoted = "// @ts-ignore\\ninvalid fixture";\nexport const templated = `// @ts-expect-error\\n${1}`;\n',
  );
  assert.deepEqual(inspectTypecheckCoverage(f.root).unsafe, []);
});

test("authored declarations receive semantic diagnostics even when dependency checking is skipped", (t) => {
  const f = fixture(t);
  mkdirSync(resolve(f.root, "types"));
  writeFileSync(
    resolve(f.root, "types/config.d.ts"),
    "export type Config = MissingType;\n",
  );
  f.config.include.push("types/**/*.ts");
  f.writeConfig();
  const result = inspectTypecheckCoverage(f.root);
  assert.deepEqual(result.missingFiles, []);
  assert.ok(
    result.declarationErrors.some(
      (error) => error.file === "types/config.d.ts" && error.code === 2304,
    ),
  );
});
