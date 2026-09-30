import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const runtimeDirectory = resolve(import.meta.dirname, "../cloud/runtime");
const sourcePath = resolve(runtimeDirectory, "src/eventCommands.ts");
const sourceText = readFileSync(sourcePath, "utf8");
const source = ts.createSourceFile(
  sourcePath,
  sourceText,
  ts.ScriptTarget.Latest,
  true,
);
const config = ts.getParsedCommandLineOfConfigFile(
  resolve(runtimeDirectory, "tsconfig.json"),
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      );
    },
  },
);
assert.ok(config);
assert.deepEqual(config.errors, []);
const compilerOptions = config.options;

function registrySource(
  update: (
    properties: readonly ts.ObjectLiteralElementLike[],
  ) => readonly ts.ObjectLiteralElementLike[],
): string {
  const declaration = source.statements
    .flatMap((statement) =>
      ts.isVariableStatement(statement)
        ? [...statement.declarationList.declarations]
        : [],
    )
    .find(
      ({ name }) =>
        ts.isIdentifier(name) && name.text === "EFFECT_KIND_REGISTRY",
    );
  assert.ok(
    declaration?.initializer &&
      ts.isSatisfiesExpression(declaration.initializer),
  );
  const registry = declaration.initializer.expression;
  assert.ok(ts.isObjectLiteralExpression(registry));
  const updated = ts.factory.updateObjectLiteralExpression(
    registry,
    update(registry.properties),
  );
  return (
    sourceText.slice(0, registry.getStart(source)) +
    ts.createPrinter().printNode(ts.EmitHint.Unspecified, updated, source) +
    sourceText.slice(registry.end)
  );
}

function diagnostics(text: string): readonly ts.Diagnostic[] {
  const host = ts.createCompilerHost(compilerOptions);
  const readFile = host.readFile;
  host.readFile = (file) =>
    resolve(file) === sourcePath ? text : readFile(file);
  const program = ts.createProgram([sourcePath], compilerOptions, host);
  return ts.getPreEmitDiagnostics(program);
}

test("the authored event effect registry satisfies its declared effect union", () => {
  assert.deepEqual(diagnostics(sourceText), []);
});

test("the compiler rejects an omitted event effect kind", () => {
  const changed = registrySource((properties) => {
    const remaining = properties.filter(
      (property) =>
        !(
          ts.isPropertyAssignment(property) &&
          ts.isStringLiteral(property.name) &&
          property.name.text === "match-timer-claim"
        ),
    );
    assert.equal(remaining.length, properties.length - 1);
    return remaining;
  });
  assert.ok(
    diagnostics(changed).some(
      (diagnostic) =>
        diagnostic.file?.fileName === sourcePath &&
        /match-timer-claim.*missing/.test(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        ),
    ),
  );
});

test("the compiler rejects an extra event effect kind", () => {
  const changed = registrySource((properties) => [
    ...properties,
    ts.factory.createPropertyAssignment(
      ts.factory.createStringLiteral("unsupported-effect"),
      ts.factory.createTrue(),
    ),
  ]);
  assert.ok(
    diagnostics(changed).some(
      (diagnostic) =>
        diagnostic.file?.fileName === sourcePath &&
        /unsupported-effect/.test(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        ),
    ),
  );
});
