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

function callback(state, { pending = [], hash = false } = {}) {
  const data = new Map([["appleIntentByStateV1", JSON.stringify(pending)]]);
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  const params = new URLSearchParams({ state, id_token: "apple-token" });
  const window = {
    location: new URL(
      `https://mons.link/invite?event=summer${hash ? `#${params}` : `&${params}`}`,
    ),
    sessionStorage: storage,
    localStorage: storage,
    history: {
      replaceState: (_state, _title, url) => {
        window.location = new URL(url, "https://mons.link");
      },
    },
  };
  const exports = {};
  new Function("exports", "window", "document", "console", outputText)(
    exports,
    window,
    { title: "Mons" },
    { log: () => {} },
  );
  return { api: exports, window, data };
}

const compactState = (expiresAtMs = Date.now() + 60_000) =>
  `apple.v1.state-token.intent-id.${expiresAtMs.toString(36)}.settings.account`;

for (const hash of [false, true]) {
  test(`compact Apple callbacks restore without stored intent from ${hash ? "hash" : "query"}`, () => {
    const h = callback(compactState(), { hash });
    const result = h.api.consumeAppleRedirectResult();
    assert.deepEqual(result, {
      idToken: "apple-token",
      intentId: "intent-id",
      consentSource: "settings.account",
    });
    assert.equal(h.api.consumeAppleRedirectResult(), result);
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
  assert.equal(h.data.has("appleIntentByStateV1"), false);
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
