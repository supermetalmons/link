import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  APPLICATION_ROOM_RPC_ARITY,
  readApplicationRpcAdmission,
} from "../src/applicationRoomRpc.ts";

test("every business room RPC has an explicit admission parameter and guarded entry", () => {
  const actual = new Map<string, number>();
  for (const [file, className] of [
    ["inviteReactions.ts", "InviteReactions"],
    ["eventUpdates.ts", "EventUpdates"],
  ]) {
    const source = ts.createSourceFile(
      file!,
      readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const declaration = source.statements.find(
      (node): node is ts.ClassDeclaration =>
        ts.isClassDeclaration(node) && node.name?.text === className,
    );
    assert.ok(declaration);
    for (const node of declaration.members) {
      if (
        !ts.isMethodDeclaration(node) ||
        node.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
        )
      )
        continue;
      const name = node.name.getText(source);
      assert.match(
        node.body?.getText(source) || "",
        /this\.withApplicationOperation\(/,
        name,
      );
      if (
        [
          "fetch",
          "alarm",
          "webSocketMessage",
          "webSocketClose",
          "webSocketError",
        ].includes(name)
      )
        continue;
      assert.equal(
        node.parameters.at(-1)?.name.getText(source),
        "parent",
        name,
      );
      actual.set(name, node.parameters.length - 1);
    }
  }
  assert.deepEqual(Object.fromEntries(actual), APPLICATION_ROOM_RPC_ARITY);
});

test("room admission metadata cannot coerce generations or turn a business RPC into a migration", () => {
  const context = {
    kind: "business",
    generation: 2,
    dataEpoch: 1,
    operationId: "operation",
  };
  assert.deepEqual(readApplicationRpcAdmission(context), context);
  for (const value of [
    undefined,
    { ...context, generation: "2" },
    { ...context, extra: true },
    { ...context, kind: "migration", migrationId: "migration" },
  ])
    assert.throws(() => readApplicationRpcAdmission(value));
});
