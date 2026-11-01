import { PROFILE_STICKER_CATALOG } from "@mons/shared/appearance";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repository = fileURLToPath(new URL("../", import.meta.url));
const sourcePath = path.join(
  repository,
  "test/fixtures/shinyCardEditTypeProbe.ts",
);
const config = ts.getParsedCommandLineOfConfigFile(
  path.join(repository, "tsconfig.json"),
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

const prelude = `
import type {
  ShinyCardChange,
  ShinyCardEdit,
  ShinyCardUndoEntry,
  ProfileScopedUndoHistory,
  UndoIntent,
} from "../../src/ui/shinyCardModels";
import type { ShinyCardSession } from "../../src/ui/shinyCardSession";
import { MonType } from "../../src/utils/namedMons";
declare function acceptChange(change: ShinyCardChange): void;
declare function acceptEdit(edit: ShinyCardEdit): void;
declare function acceptUndo(entry: ShinyCardUndoEntry): void;
declare const session: ShinyCardSession;
declare const history: ProfileScopedUndoHistory;
declare const emit: ConstructorParameters<typeof ShinyCardSession>[0]["onUpdateContent"];
declare const uncertainKind: "bg" | "profileCounter";
declare const uncertainValue: number | string;
declare let mutableChange: ShinyCardChange;
declare let mutableEdit: ShinyCardEdit;
declare let undoIntent: UndoIntent<number>;
`;

/** @type {readonly (keyof typeof PROFILE_STICKER_CATALOG)[]} */
const stickerSlots = [
  "big-mon-top-right",
  "bottom-left",
  "bottom-right",
  "mana",
  "middle-left",
  "middle-right",
  "mini-logo",
  "type-logo",
];

/** @type {Array<[contentType: string, value: string]>} */
const validChanges = [
  ['"profileCounter"', '"gp"'],
  ['"emojiAndAura"', '{ emojiId: 0, aura: "none" }'],
  ['"emojiAndAura"', '{ emojiId: 1009, aura: "rainbow" }'],
  ['"bg"', "100"],
  ['"subtitle"', "0"],
  ...["DEMON", "ANGEL", "DRAINER", "SPIRIT", "MYSTIC"].map(
    /** @returns {[contentType: string, value: string]} */
    (type) => [`MonType.${type}`, "1"],
  ),
  ...stickerSlots.flatMap(
    /** @returns {Array<[contentType: string, value: string]>} */
    (slot) => [
      [JSON.stringify(slot), JSON.stringify(PROFILE_STICKER_CATALOG[slot][0])],
      [JSON.stringify(slot), "undefined"],
    ],
  ),
];

const validSource =
  prelude +
  validChanges
    .map(([contentType, value]) => {
      const change = `{ contentType: ${contentType}, value: ${value} }`;
      const record = `{ contentType: ${contentType}, value: ${value}, undo: { kind: "record", value: ${value} } }`;
      const skip = `{ contentType: ${contentType}, value: ${value}, undo: { kind: "skip" } }`;
      return [
        `acceptChange(${change});`,
        `acceptEdit(${record});`,
        `acceptEdit(${skip});`,
        `acceptUndo(${change});`,
        `history.enqueue("owner", "owner", ${change});`,
        `emit(${record});`,
        `session.applyPresentationChange(${change});`,
      ].join("\n");
    })
    .join("\n");

/** @param {string} text */
function diagnostics(text) {
  const host = ts.createCompilerHost(compilerOptions);
  const readFile = host.readFile;
  const fileExists = host.fileExists;
  host.readFile = (file) =>
    path.resolve(file) === sourcePath ? text : readFile(file);
  host.fileExists = (file) =>
    path.resolve(file) === sourcePath || fileExists(file);
  const program = ts.createProgram(
    [sourcePath, path.join(repository, "src/vite-env.d.ts")],
    compilerOptions,
    host,
  );
  return ts.getPreEmitDiagnostics(program);
}

/** @param {readonly import("typescript").Diagnostic[]} items */
const formatDiagnostics = (items) =>
  items.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  );

test("card edit contracts accept every supported field, restore value, and undo mode", () => {
  assert.deepEqual(formatDiagnostics(diagnostics(validSource)), []);
});

test("card edit contracts reject mismatched payloads, undo values, and uncorrelated fields", () => {
  /** @type {Array<[label: string, expression: string]>} */
  const invalid = [
    [
      "unknown field",
      'acceptEdit({ contentType: "unknown", value: 1, undo: { kind: "skip" } });',
    ],
    [
      "string background",
      'acceptEdit({ contentType: "bg", value: "7", undo: { kind: "skip" } });',
    ],
    [
      "object subtitle",
      'acceptEdit({ contentType: "subtitle", value: {}, undo: { kind: "skip" } });',
    ],
    [
      "number counter",
      'acceptEdit({ contentType: "profileCounter", value: 7, undo: { kind: "skip" } });',
    ],
    [
      "string monster",
      'acceptEdit({ contentType: MonType.DRAINER, value: "1", undo: { kind: "skip" } });',
    ],
    [
      "number sticker",
      'acceptEdit({ contentType: "mana", value: 1, undo: { kind: "skip" } });',
    ],
    [
      "missing emoji aura",
      'acceptEdit({ contentType: "emojiAndAura", value: { emojiId: 1 }, undo: { kind: "skip" } });',
    ],
    [
      "invalid emoji id",
      'acceptEdit({ contentType: "emojiAndAura", value: { emojiId: false, aura: "none" }, undo: { kind: "skip" } });',
    ],
    [
      "invalid emoji aura",
      'acceptEdit({ contentType: "emojiAndAura", value: { emojiId: 1, aura: 2 }, undo: { kind: "skip" } });',
    ],
    [
      "wrong recorded background",
      'acceptEdit({ contentType: "bg", value: 1, undo: { kind: "record", value: "7" } });',
    ],
    [
      "wrong recorded sticker",
      'acceptEdit({ contentType: "mana", value: "blue-mana", undo: { kind: "record", value: 2 } });',
    ],
    [
      "wrong recorded emoji",
      'acceptEdit({ contentType: "emojiAndAura", value: { emojiId: 1, aura: "none" }, undo: { kind: "record", value: "1" } });',
    ],
    [
      "missing recorded value",
      'acceptEdit({ contentType: "mana", value: "blue-mana", undo: { kind: "record" } });',
    ],
    ["missing undo mode", 'acceptEdit({ contentType: "bg", value: 1 });'],
    [
      "null history sentinel",
      'acceptEdit({ contentType: "mana", value: "blue-mana", undo: null });',
    ],
    [
      "uncorrelated edit",
      'acceptEdit({ contentType: uncertainKind, value: uncertainValue, undo: { kind: "skip" } });',
    ],
    [
      "uncorrelated restore",
      "acceptUndo({ contentType: uncertainKind, value: uncertainValue });",
    ],
    ["invalid restore", 'acceptUndo({ contentType: "bg", value: "7" });'],
    [
      "invalid history entry",
      'history.enqueue("owner", "owner", { contentType: "mana", value: 2 });',
    ],
    ["old history tuple", 'acceptUndo(["bg", 7]);'],
    [
      "invalid session callback",
      'emit({ contentType: "subtitle", value: "7", undo: { kind: "skip" } });',
    ],
    [
      "invalid presentation",
      'session.applyPresentationChange({ contentType: "bg", value: "7" });',
    ],
    [
      "change discriminator mutation",
      'mutableChange.contentType = "profileCounter";',
    ],
    ["change payload mutation", "mutableChange.value = 123;"],
    [
      "edit discriminator mutation",
      'mutableEdit.contentType = "profileCounter";',
    ],
    ["edit payload mutation", "mutableEdit.value = 123;"],
    [
      "edit undo mutation",
      'mutableEdit.undo = { kind: "record", value: 123 };',
    ],
    ["undo mode mutation", 'undoIntent.kind = "record";'],
    [
      "recorded payload mutation",
      'if (mutableEdit.undo.kind === "record") mutableEdit.undo.value = 123;',
    ],
  ];
  const lines = validSource.split("\n");
  /** @type {Map<number, string>} */
  const expectedLines = new Map();
  for (const [label, expression] of invalid) {
    expectedLines.set(lines.length, label);
    lines.push(expression);
  }
  const errors = diagnostics(lines.join("\n"));
  /** @type {Set<number>} */
  const reportedLines = new Set();
  /** @type {import("typescript").Diagnostic[]} */
  const unrelated = [];
  for (const diagnostic of errors) {
    if (
      diagnostic.file?.fileName === sourcePath &&
      diagnostic.start !== undefined
    ) {
      const { line } = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start,
      );
      if (expectedLines.has(line)) {
        reportedLines.add(line);
        continue;
      }
    }
    unrelated.push(diagnostic);
  }
  assert.deepEqual(formatDiagnostics(unrelated), []);
  for (const [line, label] of expectedLines) {
    assert.ok(reportedLines.has(line), `Compiler accepted ${label}`);
  }
});
