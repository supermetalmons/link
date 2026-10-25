import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  clearNavigationGamesRuntimeCacheScope,
  readNavigationGamesCacheSnapshot,
  resolveNavigationGamesCacheScope,
} from "../src/services/navigationGamesCache.ts";

function declarations(file, names) {
  const source = ts.createSourceFile(
    file,
    readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const selected = names.map((name) => {
    const variable = source.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => statement.declarationList.declarations)
      .find((declaration) => declaration.name.getText(source) === name);
    assert.ok(variable, name);
    return `const ${variable.getText(source)};`;
  });
  const compiled = ts.transpileModule(selected.join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(`${compiled}\nreturn { ${names.join(", ")} };`)();
}

test("navigation persistence keeps future and exact-TTL rows, legacy item decoding, and existing invalid-row cleanup", (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map();
  const mutations = [];
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        mutations.push(["set", key, value]);
        values.set(key, value);
      },
      removeItem: (key) => {
        mutations.push(["remove", key]);
        values.delete(key);
      },
    },
  });
  const now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const scope = resolveNavigationGamesCacheScope("persistence-boundary");
  const key = `navigationGamesTopCache:v3:${scope.scopeKey}`;
  const ttl = 365 * 24 * 60 * 60 * 1000;
  const game = {
    id: "game",
    entityType: "game",
    inviteId: "invite",
    kind: "direct",
    status: "waiting",
    opponentEmoji: "7",
    opponentName: " First ",
  };
  try {
    for (const updatedAtMs of [now + 1_000, now - ttl]) {
      const raw = JSON.stringify({
        version: 3,
        updatedAtMs,
        topGames: [
          game,
          { ...game, opponentName: "second" },
          { ...game, id: "optimistic", isOptimistic: true },
          null,
        ],
      });
      values.set(key, raw);
      const result = readNavigationGamesCacheSnapshot(scope);
      assert.equal(result.topGames.length, 1);
      assert.equal(result.topGames[0].opponentName, " First ");
      assert.equal(result.topGames[0].opponentEmoji, 7);
      assert.equal(values.get(key), raw);
      assert.deepEqual(mutations, []);
    }
    for (const raw of [
      JSON.stringify({
        version: 3,
        updatedAtMs: now - ttl - 1,
        topGames: [game],
      }),
      JSON.stringify({ version: 2, updatedAtMs: now, topGames: [game] }),
      "null",
      "broken JSON",
    ]) {
      mutations.length = 0;
      values.set(key, raw);
      assert.deepEqual(readNavigationGamesCacheSnapshot(scope), {
        topGames: [],
        pagedGames: [],
      });
      assert.deepEqual(mutations, [["remove", key]]);
      assert.equal(values.has(key), false);
    }
  } finally {
    clearNavigationGamesRuntimeCacheScope(scope.scopeKey);
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});

test("logout readers retain legacy timestamp coercion, field spelling, and their distinct cleanup defaults", () => {
  const api = declarations("src/session/logoutOrchestrator.ts", [
    "parseLogoutSignal",
    "parseSignInSignal",
    "parsePendingLogoutWipeMarker",
  ]);
  for (const value of [
    undefined,
    null,
    false,
    0,
    "",
    "broken JSON",
    "null",
    "true",
    "[]",
    "{}",
  ])
    for (const parse of Object.values(api)) assert.equal(parse(value), null);
  assert.deepEqual(
    api.parseLogoutSignal(
      JSON.stringify({
        id: " id ",
        generation: " generation ",
        cleanupMode: "unsupported",
      }),
    ),
    { id: " id ", generation: " generation ", cleanupMode: undefined },
  );
  assert.deepEqual(
    api.parseSignInSignal(
      JSON.stringify({
        id: "id",
        tabId: "tab",
        profileId: " profile ",
        loginId: " login ",
        generation: "generation",
        extra: true,
      }),
    ),
    {
      id: "id",
      tabId: "tab",
      profileId: " profile ",
      loginId: " login ",
      generation: "generation",
    },
  );
  for (const [createdAtMs, expected] of [
    ["12.9", 12],
    [null, 0],
    [false, 0],
    [-1.2, -2],
  ]) {
    assert.deepEqual(
      api.parsePendingLogoutWipeMarker(
        JSON.stringify({
          id: "id",
          generation: "generation",
          createdAtMs,
          cleanupMode: "unsupported",
        }),
      ),
      {
        id: "id",
        generation: "generation",
        createdAtMs: expected,
        cleanupMode: "fast",
      },
    );
  }
  assert.equal(
    api.parsePendingLogoutWipeMarker(
      JSON.stringify({
        id: "id",
        generation: "generation",
        createdAtMs: "invalid",
      }),
    ),
    null,
  );
});

test("Apple pending-intent parsing preserves numeric-string times, age boundaries and the whole-read fallback", (t) => {
  const api = declarations("src/connection/appleConnection.ts", [
    "APPLE_PENDING_INTENTS_STORAGE_KEY",
    "APPLE_PENDING_INTENT_MAX_AGE_MS",
    "parsePendingAppleIntentRecordsFromStorage",
  ]);
  const now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const age = 15 * 60 * 1000;
  const record = {
    state: " state ",
    intentId: " intent ",
    createdAtMs: String(now - age),
    expiresAtMs: String(now + 1000.9),
  };
  const raw = JSON.stringify([
    record,
    { ...record, state: "expired", expiresAtMs: now },
    { ...record, state: "old", createdAtMs: now - age - 1 },
    null,
    { state: "invalid" },
  ]);
  let reads = 0;
  const storage = {
    getItem(key) {
      reads++;
      assert.equal(key, "appleIntentByStateV1");
      return raw;
    },
  };
  assert.deepEqual(api.parsePendingAppleIntentRecordsFromStorage(storage), [
    {
      state: " state ",
      intentId: " intent ",
      consentSource: "signin",
      createdAtMs: now - age,
      expiresAtMs: now + 1000,
    },
  ]);
  assert.equal(reads, 1);
  for (const value of ["null", "{}", "broken JSON"])
    assert.deepEqual(
      api.parsePendingAppleIntentRecordsFromStorage({ getItem: () => value }),
      [],
    );
  assert.deepEqual(
    api.parsePendingAppleIntentRecordsFromStorage({
      getItem() {
        throw new Error("blocked");
      },
    }),
    [],
  );
});
