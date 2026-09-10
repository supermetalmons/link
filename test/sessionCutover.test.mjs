import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile(
  "authentication.ts",
  readFileSync(
    new URL("../src/connection/authentication.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const hook = source.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "useAuthStatus",
);
const effects = hook.body.statements
  .filter(
    (node) =>
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(source) === "useEffect",
  )
  .map((node) => node.expression.arguments[0]);

for (const provider of ["Apple", "X"]) {
  const effect = effects.find((node) =>
    node.getText(source).includes(`complete${provider}RedirectSignInIfNeeded`),
  );
  assert.ok(effect);
  const { outputText } = ts.transpileModule(
    `const run = ${effect.getText(source)};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  );

  test(`${provider} callback from before cutoff is discarded even after a new guest finishes creation`, async () => {
    let cleared = 0;
    let consumed = 0;
    const dependencies = {
      sessionAuth: {
        authStateReady: async () => {},
        currentUser: { sessionId: "new-session" },
        restoredSessionId: null,
      },
      [`clear${provider}SignInTransientState`]: () => {
        cleared++;
      },
      [`consume${provider}RedirectResult`]: () => {
        consumed++;
        return null;
      },
      console,
    };
    const run = new Function(
      ...Object.keys(dependencies),
      `${outputText}\nreturn run;`,
    )(...Object.values(dependencies));
    const cleanup = run();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleared, 1);
    assert.equal(consumed, 0);
    cleanup();
  });

  test(`${provider} redirect restoration accepts the persisted current session`, async () => {
    let cleared = 0;
    let consumed = 0;
    const dependencies = {
      sessionAuth: {
        authStateReady: async () => {},
        currentUser: { sessionId: "existing-session" },
        restoredSessionId: "existing-session",
      },
      [`clear${provider}SignInTransientState`]: () => {
        cleared++;
      },
      [`consume${provider}RedirectResult`]: () => {
        consumed++;
        return null;
      },
      console,
    };
    const run = new Function(
      ...Object.keys(dependencies),
      `${outputText}\nreturn run;`,
    )(...Object.values(dependencies));
    const cleanup = run();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleared, 0);
    assert.equal(consumed, 1);
    cleanup();
  });
}
