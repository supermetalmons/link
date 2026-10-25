import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const queueBindings = new Set([
  "AUTH_RECOVERY_QUEUE",
  "PROFILE_GAME_PROJECTION_QUEUE",
  "EVENT_PROFILE_GAME_PROJECTION_QUEUE",
  "TELEGRAM_PROJECTION_QUEUE",
  "TELEGRAM_DELIVERY_QUEUE",
  "WAGER_SETTLEMENT_QUEUE",
]);
function source(file: string) {
  return ts.createSourceFile(
    file,
    readFileSync(resolve(root, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}
function visit(node: ts.Node, check: (node: ts.Node) => void): void {
  check(node);
  node.forEachChild((child) => visit(child, check));
}

test("all Queue producer binding access goes through the strict keyed capability", () => {
  const directory = "cloud/workers/api/src";
  const violations: string[] = [];
  for (const file of readdirSync(resolve(root, directory), {
    recursive: true,
    encoding: "utf8",
  })) {
    if (!file.endsWith(".ts")) continue;
    const parsed = source(`${directory}/${file}`);
    visit(parsed, (node) => {
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isElementAccessExpression(node) &&
            ts.isStringLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : undefined;
      if (key && queueBindings.has(key)) {
        violations.push(
          `${file}:${parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
        );
      }
    });
  }
  assert.deepEqual(violations, []);
  const producer = source(`${directory}/queueProducers.ts`);
  const messages = producer.statements.find(
    (node): node is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) && node.name.text === "QueueMessages",
  );
  assert.ok(messages && ts.isTypeLiteralNode(messages.type));
  assert.deepEqual(
    messages.type.members
      .map((member) => member.name?.getText(producer))
      .sort(),
    [...queueBindings].sort(),
  );
  const config = ts.parseConfigFileTextToJson(
    "wrangler.jsonc",
    readFileSync(resolve(root, "cloud/workers/api/wrangler.jsonc"), "utf8"),
  );
  assert.equal(config.error, undefined);
  const bindings = config.config as {
    queues: { producers: { binding: string }[] };
  };
  assert.deepEqual(
    bindings.queues.producers.map(({ binding }) => binding).sort(),
    [...queueBindings].sort(),
  );
});

const publicContracts: Record<string, readonly string[]> = {
  "cloud/runtime/src/eventProgressRecords.ts": [
    "EventProgressDocument",
    "RetainedEventProgressParams",
    "EventProgressDeadLetter",
  ],
  "cloud/workers/api/src/eventProgressCodec.ts": [
    "EventProgressWorkflowParams",
    "EventProgressPlan",
    "RetainedEventProgressPlan",
  ],
  "cloud/workers/api/src/eventStoreContracts.ts": [
    "EventStore",
    "EventProgressOutboxWriter",
  ],
  "cloud/workers/api/src/eventOutboxReadRepository.ts": ["EventOutboxReads"],
  "cloud/workers/api/src/eventProgressRecoveryD1.ts": [
    "EventProgressRecoverySnapshot",
    "EventProgressRecoveryStore",
  ],
  "cloud/workers/api/src/queueProducers.ts": ["QueueMessages"],
};

test("named public progress and Queue contracts do not regain broad payload types", () => {
  for (const [file, names] of Object.entries(publicContracts)) {
    const parsed = source(file);
    const declarations = parsed.statements.filter(
      (node): node is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(node) && names.includes(node.name.text),
    );
    assert.deepEqual(
      declarations.map((node) => node.name.text).sort(),
      [...names].sort(),
      file,
    );
    for (const declaration of declarations) {
      visit(declaration.type, (node) => {
        assert.ok(
          ![
            ts.SyntaxKind.AnyKeyword,
            ts.SyntaxKind.UnknownKeyword,
            ts.SyntaxKind.ObjectKeyword,
          ].includes(node.kind),
          `${file}:${declaration.name.text} contains ${node.getText(parsed)}`,
        );
        assert.equal(
          ts.isIndexSignatureDeclaration(node),
          false,
          `${file}:${declaration.name.text} has an open index signature`,
        );
      });
    }
  }
});

test("progress domain command values stay distinct from private raw persistence commands", () => {
  const parsed = source("cloud/runtime/src/eventCommands.ts");
  const declaration = parsed.statements.find(
    (node): node is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) && node.name.text === "EventMutation",
  );
  assert.ok(declaration && ts.isUnionTypeNode(declaration.type));
  const members = declaration.type.types.filter(
    (node): node is ts.TypeLiteralNode =>
      ts.isTypeLiteralNode(node) &&
      node.members.some(
        (member) =>
          ts.isPropertySignature(member) &&
          member.name.getText(parsed) === "kind" &&
          member.type &&
          ts.isLiteralTypeNode(member.type) &&
          ts.isStringLiteral(member.type.literal) &&
          ["progress-outbox", "progress-dead"].includes(
            member.type.literal.text,
          ),
      ),
  );
  assert.equal(members.length, 2);
  for (const member of members) {
    visit(member, (node) => {
      assert.ok(
        ![
          ts.SyntaxKind.AnyKeyword,
          ts.SyntaxKind.UnknownKeyword,
          ts.SyntaxKind.ObjectKeyword,
        ].includes(node.kind),
      );
      if (ts.isTypeReferenceNode(node))
        assert.ok(
          !["Record", "EventJsonRecord"].includes(
            node.typeName.getText(parsed),
          ),
        );
    });
  }
});

const boundaryDirectories = [
  "cloud/runtime/src",
  "cloud/workers/api/src",
  "src/connection",
  "src/services",
  "src/session",
];
const boundaryFiles = [
  "src/ui/shinyCardModels.ts",
  "src/utils/ensResolver.ts",
  "src/utils/playerMetadata.ts",
  "src/utils/playerMetadataCache.ts",
  "src/utils/storage.ts",
];
function productionBoundaryFiles(): string[] {
  return [
    ...boundaryFiles,
    ...boundaryDirectories.flatMap((directory) =>
      readdirSync(resolve(root, directory), {
        recursive: true,
        encoding: "utf8",
      })
        .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
        .map((file) => `${directory}/${file}`),
    ),
  ];
}
function isRawJsonParse(node: ts.Node): boolean {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    node = node.expression;
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "JSON" &&
    node.expression.name.text === "parse"
  );
}

function hasUnsafeBoundaryType(node: ts.Node): boolean {
  const directAssertion =
    (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
    isRawJsonParse(node.expression) &&
    node.type.kind !== ts.SyntaxKind.UnknownKeyword;
  const directAnnotation =
    ts.isVariableDeclaration(node) &&
    node.type &&
    node.initializer &&
    isRawJsonParse(node.initializer) &&
    node.type.kind !== ts.SyntaxKind.UnknownKeyword;
  return (
    node.kind === ts.SyntaxKind.AnyKeyword ||
    directAssertion ||
    Boolean(directAnnotation)
  );
}

test("boundary guards recognize raw parse assertions without rejecting legitimate unknown inputs", () => {
  for (const [text, rejected] of [
    ["const value = JSON.parse(raw) as unknown;", false],
    ["const value: unknown = (JSON.parse(raw));", false],
    ["const signal = AbortSignal.any([]);", false],
    ["const value = (JSON.parse(raw)) as Domain;", true],
    ["const value: Domain = (JSON.parse(raw));", true],
    ["const value = JSON.parse(raw) as unknown as Domain;", true],
    ["type Result = Promise<any>;", true],
  ] as const) {
    const parsed = ts.createSourceFile(
      "boundary.ts",
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    let found = false;
    visit(parsed, (node) => {
      found ||= hasUnsafeBoundaryType(node);
    });
    assert.equal(found, rejected, text);
  }
});

test("production data boundaries avoid explicit any and direct raw-JSON domain assertions", () => {
  const violations: string[] = [];
  for (const file of productionBoundaryFiles()) {
    const parsed = source(file);
    visit(parsed, (node) => {
      if (hasUnsafeBoundaryType(node))
        violations.push(
          `${file}:${parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.getText(parsed)}`,
        );
    });
  }
  assert.deepEqual(violations, []);
});

test("retained progress construction stays at explicit persistence compatibility boundaries", () => {
  const allowedImports = new Set([
    "cloud/workers/api/src/eventCompatibilityCodec.ts",
    "cloud/workers/api/src/eventProgressRecoveryD1.ts",
    "cloud/workers/api/src/eventD1/reads.ts",
    "cloud/workers/api/src/eventD1/transactions.ts",
  ]);
  const actualImports: string[] = [];
  for (const file of productionBoundaryFiles()) {
    const parsed = source(file);
    for (const node of parsed.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
        continue;
      if (
        !node.moduleSpecifier ||
        !ts.isStringLiteral(node.moduleSpecifier) ||
        !node.moduleSpecifier.text.endsWith("/eventProgressRecords.js")
      )
        continue;
      if (ts.isExportDeclaration(node)) {
        assert.equal(
          node.isTypeOnly ||
            Boolean(
              node.exportClause &&
              ts.isNamedExports(node.exportClause) &&
              node.exportClause.elements.every((element) => element.isTypeOnly),
            ),
          true,
          `${file} re-exports the retained progress constructor`,
        );
        continue;
      }
      const clause = node.importClause;
      if (!clause || clause.isTypeOnly) continue;
      const bindings = clause.namedBindings;
      assert.ok(
        bindings && ts.isNamedImports(bindings),
        `${file} imports the retained progress module as a value namespace`,
      );
      const values = bindings.elements.filter((element) => !element.isTypeOnly);
      if (values.length === 0) continue;
      assert.ok(
        values.every(
          (element) =>
            (element.propertyName || element.name).text ===
            "retainEventProgressRecord",
        ),
      );
      assert.ok(allowedImports.has(file), file);
      actualImports.push(file);
    }
  }
  assert.deepEqual(actualImports.sort(), [...allowedImports].sort());
});
