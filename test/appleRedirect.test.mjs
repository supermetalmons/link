import { applicationStorageKey } from "../src/session/applicationDataStorage.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/connection/appleConnection.ts", import.meta.url),
  "utf8",
).replace("import.meta.env.VITE_APPLE_CLIENT_ID", '"link.mons"');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
});

/**
 * @param {string} state
 * @param {{ pending?: unknown[], hash?: boolean }} [options]
 */
function callback(state, { pending = [], hash = false } = {}) {
  const data = new Map([
    [applicationStorageKey("appleIntentByStateV1"), JSON.stringify(pending)],
  ]);
  const storage = {
    getItem: (/** @type {string} */ key) => data.get(key) ?? null,
    setItem: (/** @type {string} */ key, /** @type {string} */ value) =>
      data.set(key, value),
    removeItem: (/** @type {string} */ key) => data.delete(key),
  };
  const params = new URLSearchParams({ state, id_token: "apple-token" });
  const window = {
    location: new URL(
      `https://mons.link/invite?event=summer${hash ? `#${params}` : `&${params}`}`,
    ),
    sessionStorage: storage,
    localStorage: storage,
    history: {
      replaceState: (
        /** @type {unknown} */ _state,
        /** @type {string} */ _title,
        /** @type {string | URL} */ url,
      ) => {
        window.location = new URL(url, "https://mons.link");
      },
    },
  };
  const exports = {};
  new Function(
    "exports",
    "require",
    "window",
    "document",
    "console",
    outputText,
  )(
    exports,
    (/** @type {string} */ name) => {
      assert.equal(name, "../session/applicationDataStorage.ts");
      return { applicationStorageKey };
    },
    window,
    { title: "Mons" },
    { log: () => {} },
  );
  return {
    api: /** @type {typeof import("../src/connection/appleConnection.ts")} */ (
      exports
    ),
    window,
    data,
  };
}

const compactState = (expiresAtMs = Date.now() + 60_000) =>
  `apple.v1.state-token.intent-id.${expiresAtMs.toString(36)}.settings.account`;

for (const hash of [false, true]) {
  test(`old Apple envelopes cannot restore without a current intent from ${hash ? "hash" : "query"}`, () => {
    const h = callback(compactState(), { hash });
    assert.throws(() => h.api.consumeAppleRedirectResult(), /session expired/);
    assert.equal(h.api.consumeAppleRedirectResult(), null);
    assert.equal(
      h.window.location.href,
      "https://mons.link/invite?event=summer",
    );
  });
}

test("Apple callbacks retain pending intent recovery and consume its stored record", () => {
  const h = callback("pending-state", {
    pending: [
      {
        state: "pending-state",
        intentId: "pending-intent",
        consentSource: "signin",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
      },
    ],
  });
  assert.deepEqual(h.api.consumeAppleRedirectResult(), {
    idToken: "apple-token",
    intentId: "pending-intent",
    consentSource: "signin",
  });
  assert.equal(
    h.data.has(applicationStorageKey("appleIntentByStateV1")),
    false,
  );
});

test("expired, malformed and retired JSON Apple envelopes cannot restore without a pending intent", () => {
  const retiredEnvelope = Buffer.from(
    JSON.stringify({
      state: "old-state",
      intentId: "old-intent",
      consentSource: "signin",
      expiresAtMs: Date.now() + 60_000,
    }),
  ).toString("base64url");
  for (const state of [
    compactState(Date.now() - 1),
    "apple.v1.%E0%A4%A.intent-id.zzz.signin",
    "apple.v1.incomplete",
    `apple.v1.${retiredEnvelope}`,
  ]) {
    const h = callback(state);
    assert.throws(() => h.api.consumeAppleRedirectResult(), /session expired/);
    assert.equal(h.window.location.search, "?event=summer");
  }
});
