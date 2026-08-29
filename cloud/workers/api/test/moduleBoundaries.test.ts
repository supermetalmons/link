import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import test from "node:test";
import typescript from "typescript";
import * as entrypoint from "../src/workerHandler.ts";
import { extractIdFromJsonUri } from "../src/helius.ts";
import { handleRequest } from "../src/router.ts";

test("the Worker entrypoint remains a thin exact compatibility facade", () => {
  assert.deepEqual(Object.keys(entrypoint).sort(), [
    "default",
    "extractIdFromJsonUri",
    "handleFetch",
    "handleRequest",
    "handleScheduled",
  ]);
  assert.strictEqual(entrypoint.handleRequest, handleRequest);
  assert.strictEqual(entrypoint.extractIdFromJsonUri, extractIdFromJsonUri);
  assert.equal(typeof entrypoint.default.queue, "function");
  assert.equal(typeof entrypoint.default.scheduled, "function");
});

test("canonical D1 modules have no direct Firestore runtime dependency", () => {
  for (const filename of [
    "authIdentityCanonical.ts",
    "gameplayCanonicalRepository.ts",
    "profileCanonicalD1.ts",
  ]) {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src", filename),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /(?:authFirestore|firestoreRest|createGoogleAccessToken|firestore\.googleapis\.com)/,
      filename,
    );
  }
});

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const runtimeExtensions = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

function isTypeOnlyImport(
  declaration: import("typescript").ImportDeclaration,
): boolean {
  const clause = declaration.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  return (
    !clause.name &&
    clause.namedBindings !== undefined &&
    typescript.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function isTypeOnlyExport(
  declaration: import("typescript").ExportDeclaration,
): boolean {
  return (
    declaration.isTypeOnly ||
    (declaration.exportClause !== undefined &&
      typescript.isNamedExports(declaration.exportClause) &&
      declaration.exportClause.elements.length > 0 &&
      declaration.exportClause.elements.every((element) => element.isTypeOnly))
  );
}

function runtimeSpecifiers(path: string): string[] {
  const source = typescript.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    typescript.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  for (const statement of source.statements) {
    if (
      typescript.isImportDeclaration(statement) &&
      typescript.isStringLiteral(statement.moduleSpecifier) &&
      !isTypeOnlyImport(statement)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
    if (
      typescript.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      typescript.isStringLiteral(statement.moduleSpecifier) &&
      !isTypeOnlyExport(statement)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  function visit(node: import("typescript").Node): void {
    if (
      typescript.isCallExpression(node) &&
      (node.expression.kind === typescript.SyntaxKind.ImportKeyword ||
        (typescript.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      typescript.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    typescript.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}

function resolveRuntimeImport(
  importer: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const unresolved = resolve(dirname(importer), specifier);
  const importedExtension = extname(unresolved);
  const base = runtimeExtensions.includes(importedExtension)
    ? unresolved.slice(0, -importedExtension.length)
    : unresolved;
  const candidates = [
    unresolved,
    ...runtimeExtensions.map((extension) => `${base}${extension}`),
    ...runtimeExtensions.map((extension) =>
      resolve(unresolved, `index${extension}`),
    ),
  ];
  return (
    candidates.find(
      (candidate) =>
        candidate.startsWith(repositoryRoot) &&
        existsSync(candidate) &&
        statSync(candidate).isFile(),
    ) || null
  );
}

function reachableRuntimeFiles(entry: string): string[] {
  const pending = [entry];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    for (const specifier of runtimeSpecifiers(path)) {
      const dependency = resolveRuntimeImport(path, specifier);
      if (dependency && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return Array.from(visited).sort();
}

test("the final Worker runtime has no Firestore profile transport or retired bindings", () => {
  const forbidden =
    /(?:authFirestore|firestoreRest|firestore\.googleapis\.com|FIRESTORE_SERVICE_ACCOUNT_|RATING_SERVICE_ACCOUNT_|USERNAME_SERVICE_ACCOUNT_|PROFILE_STORAGE_MODE|PROFILE_READ_MODE|PROFILE_ACTIVATION_LOGIN_UID|PROFILE_PROJECTION_QUEUE)/;
  const violations = reachableRuntimeFiles(
    resolve(import.meta.dirname, "../src/index.ts"),
  )
    .filter((path) => forbidden.test(readFileSync(path, "utf8")))
    .map((path) => relative(repositoryRoot, path));
  assert.deepEqual(violations, []);
});
