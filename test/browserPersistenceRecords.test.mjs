import { required } from "./fixtures/canonicalData.mjs";
import { applicationStorageKey } from "../src/session/applicationDataStorage.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import {
  clearNavigationGamesRuntimeCacheScope,
  readNavigationGamesCacheSnapshot,
  resolveNavigationGamesCacheScope,
} from "../src/services/navigationGamesCache.ts";

/**
 * @typedef {{parseLogoutSignal(value: unknown): {id: string; generation: string; cleanupMode?: "fast" | "thorough"} | null;
 * parseSignInSignal(value: unknown): {id: string; tabId: string; profileId: string; loginId: string; generation: string} | null;
 * parsePendingLogoutWipeMarker(value: unknown): {id: string; generation: string; createdAtMs: number; cleanupMode: "fast" | "thorough"} | null}} LogoutParsers
 * @typedef {{APPLE_PENDING_INTENTS_STORAGE_KEY: string; APPLE_PENDING_INTENT_MAX_AGE_MS: number;
 * parsePendingAppleIntentRecordsFromStorage(store: Pick<Storage, "getItem">): Array<{state: string; intentId: string; consentSource: string; createdAtMs: number; expiresAtMs: number}>}} AppleParsers
 */
/** @overload @param {"src/session/logoutOrchestrator.ts"} file @param {Array<keyof LogoutParsers>} names @returns {LogoutParsers} */
/** @overload @param {"src/connection/appleConnection.ts"} file @param {Array<keyof AppleParsers>} names @returns {AppleParsers} */
/** @param {string} file @param {string[]} names @returns {LogoutParsers | AppleParsers} */
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
  const load =
    /** @type {(key: typeof applicationStorageKey) => LogoutParsers | AppleParsers} */ (
      new Function(
        "applicationStorageKey",
        `${compiled}\nreturn { ${names.join(", ")} };`,
      )
    );
  return load(applicationStorageKey);
}

test("navigation persistence keeps canonical rows at TTL boundaries and rejects legacy item shapes", (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  /** @type {Map<string, string>} */
  const values = new Map();
  /** @type {Array<["set", string, string] | ["remove", string]>} */
  const mutations = [];
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (/** @type {string} */ key) => values.get(key) ?? null,
      setItem: (/** @type {string} */ key, /** @type {string} */ value) => {
        mutations.push(["set", key, value]);
        values.set(key, value);
      },
      removeItem: (/** @type {string} */ key) => {
        mutations.push(["remove", key]);
        values.delete(key);
      },
    },
  });
  const now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const scope = resolveNavigationGamesCacheScope("persistence-boundary");
  const key = applicationStorageKey(
    `navigationGamesTopCache:${required(scope).scopeKey}`,
  );
  const ttl = 365 * 24 * 60 * 60 * 1000;
  const game = {
    id: "game",
    entityType: "game",
    inviteId: "invite",
    kind: "direct",
    status: "waiting",
    opponentEmoji: 7,
    opponentName: " First ",
    sortBucket: 30,
    listSortAtMs: 1,
    hostLoginId: null,
    guestLoginId: null,
    opponentProfileId: null,
    automatchStateHint: null,
    isPendingAutomatch: false,
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
          { ...game, id: "old-shape", opponentEmoji: "7" },
          null,
        ],
      });
      values.set(key, raw);
      const result = readNavigationGamesCacheSnapshot(scope);
      assert.equal(result.topGames.length, 1);
      const retained = required(result.topGames[0]);
      assert.ok(retained.entityType === "game");
      assert.equal(retained.opponentName, " First ");
      assert.equal(retained.opponentEmoji, 7);
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
    clearNavigationGamesRuntimeCacheScope(required(scope).scopeKey);
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
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
    { id: " id ", generation: " generation " },
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

test("Apple pending-intent parsing accepts exact timestamps and rejects numeric strings and missing fields", (t) => {
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
    consentSource: "signin",
    createdAtMs: now - age,
    expiresAtMs: now + 1000,
  };
  const raw = JSON.stringify([
    record,
    { ...record, state: "numeric-string", createdAtMs: String(now - age) },
    { ...record, state: "extra", extra: true },
    { ...record, state: "expired", expiresAtMs: now },
    { ...record, state: "old", createdAtMs: now - age - 1 },
    null,
    { state: "invalid" },
  ]);
  let reads = 0;
  const storage = {
    getItem(/** @type {string} */ key) {
      reads++;
      assert.equal(key, applicationStorageKey("appleIntentByStateV1"));
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
