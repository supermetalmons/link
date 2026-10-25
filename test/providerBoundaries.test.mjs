import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadModule(name, dependencies, extra = "") {
  const source = readFileSync(
    new URL(`../src/connection/${name}.ts`, import.meta.url),
    "utf8",
  ).replaceAll("import.meta.env", "({})");
  const { outputText } = ts.transpileModule(`${source}\n${extra}`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });
  const exports = {};
  new Function("exports", ...Object.keys(dependencies), outputText)(
    exports,
    ...Object.values(dependencies),
  );
  return exports;
}

test("Ethereum discovery validates unknown capabilities and retains provider identity and receiver", async () => {
  const window = {};
  const api = loadModule(
    "injectedEthereumProviders",
    { window },
    "export const read = readAnnouncedWallet;",
  );
  for (const value of [
    undefined,
    null,
    false,
    7,
    "wallet",
    {},
    { request: 1 },
  ]) {
    window.ethereum = value;
    assert.equal(api.getLegacyInjectedProvider(), null);
  }
  for (const provider of [{}, [], function provider() {}]) {
    const result = { arbitrary: "provider response" };
    provider.request = function (args) {
      assert.equal(this, provider);
      assert.deepEqual(args, { method: "eth_accounts", params: [] });
      return Promise.resolve(result);
    };
    window.ethereum = provider;
    assert.equal(api.getLegacyInjectedProvider(), provider);
    assert.equal(
      await api
        .getLegacyInjectedProvider()
        .request({ method: "eth_accounts", params: [] }),
      result,
    );
    const info = Object.assign([], {
      name: "",
      rdns: "wallet.test",
      uuid: "id",
      icon: "data:image/png;base64,",
    });
    const detail = Object.assign([], { provider, info });
    const announced = api.read({ detail });
    assert.equal(announced.provider, provider);
    assert.deepEqual(announced.info, {
      name: "wallet.test",
      rdns: "wallet.test",
      uuid: "id",
      icon: "data:image/png;base64,",
    });
  }
  assert.equal(
    api.read({
      detail: { provider: { request() {} }, info: { name: "Wallet" } },
    }),
    null,
  );
});

function solana(signature) {
  const calls = [];
  const wallet = {
    connected: false,
    publicKey: { toString: () => "address" },
    async connect() {
      calls.push(["connect", this === wallet]);
    },
    async signMessage(message) {
      calls.push(["sign", this === wallet, new TextDecoder().decode(message)]);
      return signature;
    },
  };
  const connection = {
    async beginAuthIntent(method) {
      calls.push(["intent", this === connection, method]);
      return { nonce: "nonce", intentId: "intent" };
    },
  };
  const window = { solana: wallet };
  const api = loadModule("solanaConnection", {
    window,
    require: (name) => {
      assert.equal(name, "./connection");
      return { connection };
    },
    console: { error() {} },
  });
  return { api, calls, wallet, window };
}

test("Solana signatures preserve byte conversion, signing receiver, message, and cached wallet", async () => {
  for (const signature of [
    new Uint8Array([0, 255, 1, 0]),
    { signature: new Uint8Array([0, 255, 1, 0]) },
    { signature: [256, -1, 1.9, NaN] },
    { signature: Uint8Array.from([0, 255, 1, 0]).buffer },
  ]) {
    const h = solana(signature);
    const expected = {
      publicKey: "address",
      signature: "AP8BAA==",
      intentId: "intent",
    };
    assert.deepEqual(await h.api.connectToSolana(), expected);
    assert.deepEqual(h.calls, [
      ["connect", true],
      ["intent", true, "sol"],
      ["sign", true, "Sign in mons.link with Solana nonce nonce"],
    ]);
    h.window.solana = {};
    assert.deepEqual(await h.api.connectToSolana(), expected);
  }
});

test("Solana envelope coercion retains the native constructor breadth and failures", async () => {
  for (const signature of [
    new Int16Array([-1, 256, 127]),
    new Float32Array([1.9, NaN, 257]),
    { 0: "255", 1: -1, length: 2 },
    [1, "2", null],
    "3",
    null,
    undefined,
  ]) {
    const expected = btoa(String.fromCharCode(...new Uint8Array(signature)));
    assert.equal(
      (await solana({ signature }).api.connectToSolana()).signature,
      expected,
    );
  }
  for (const value of [
    undefined,
    null,
    { signature: Symbol("invalid") },
    { signature: [1n] },
  ]) {
    await assert.rejects(solana(value).api.connectToSolana(), TypeError);
  }
  const reads = [];
  const bytes = [1, 2];
  Object.defineProperty(bytes, 0, {
    get() {
      reads.push("byte");
      return 1;
    },
  });
  const value = {
    get signature() {
      reads.push("signature");
      return bytes;
    },
  };
  assert.equal((await solana(value).api.connectToSolana()).signature, "AQI=");
  assert.deepEqual(reads, ["signature", "byte"]);
});

test("Solana resolves the native constructor before observing the envelope signature", () => {
  const api = loadModule(
    "solanaConnection",
    { require: () => ({ connection: {} }) },
    "export const coerce = coerceLegacySolanaSignature;",
  );
  const original = globalThis.Uint8Array;
  let bytes;
  try {
    bytes = api.coerce({
      get signature() {
        globalThis.Uint8Array = class {
          constructor() {
            throw new Error("changed constructor");
          }
        };
        return [1, 2];
      },
    });
  } finally {
    globalThis.Uint8Array = original;
  }
  assert.deepEqual(bytes, new Uint8Array([1, 2]));
});

const pump = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};

function apple(result) {
  const listeners = new Map();
  const timers = new Map();
  const calls = [];
  let nextTimer = 0;
  let now = 0;
  const auth = {
    init(options) {
      calls.push(["init", this === auth, options]);
    },
    signIn() {
      calls.push(["signIn", this === auth]);
      return result;
    },
  };
  const window = {
    location: new URL("https://mons.link/"),
    AppleID: { auth },
  };
  const api = loadModule(
    "appleConnection",
    {
      window,
      document: {
        addEventListener(name, listener) {
          listeners.set(name, listener);
        },
        removeEventListener(name, listener) {
          assert.equal(listeners.get(name), listener);
          listeners.delete(name);
        },
      },
      console: { log() {} },
      setTimeout(fn, delay) {
        const id = ++nextTimer;
        timers.set(id, { fn, at: now + delay });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    "export const wait = waitForApplePopupResult; export const signals = extractApplePopupSignals;",
  );
  return {
    api,
    calls,
    timers,
    listeners,
    emit: (name, detail) => listeners.get(name)?.({ detail }),
    async tick(target) {
      for (;;) {
        const next = [...timers]
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
          .find(([, value]) => value.at <= target);
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await pump();
      }
      now = target;
    },
  };
}

test("Apple popup decoding selects valid root and authorization signals without trusting malformed fields", () => {
  const h = apple(null);
  for (const value of [
    undefined,
    null,
    false,
    5,
    "token",
    [],
    {},
    { authorization: { id_token: 7, state: [] }, id_token: false, state: {} },
  ]) {
    assert.deepEqual(h.api.signals(value), {
      idToken: "",
      stateCandidates: [],
    });
  }
  assert.deepEqual(
    h.api.signals({
      authorization: { id_token: "auth", state: "a" },
      id_token: "root",
      state: "b",
    }),
    { idToken: "auth", stateCandidates: ["a", "b"] },
  );
  assert.deepEqual(
    h.api.signals({ authorization: { state: "a" }, id_token: "root" }),
    { idToken: "root", stateCandidates: ["a"] },
  );
});

test("Apple popup preserves event priority, grace timing, raw identity, and listener cleanup", async () => {
  const promised = { id_token: "promise" };
  const event = { id_token: "event" };
  const h = apple(Promise.resolve(promised));
  let settled = false;
  const pending = h.api.wait(["state"]).then((value) => {
    settled = true;
    return value;
  });
  await pump();
  h.emit("AppleIDSignInOnSuccess", { data: event });
  await h.tick(1499);
  assert.equal(settled, false);
  await h.tick(1500);
  assert.equal(await pending, event);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.calls, [["signIn", true]]);
});

test("Apple public sign-in validates state/token and preserves SDK options and receiver", async () => {
  const request = {
    nonce: "nonce",
    state: "state",
    intentId: "intent",
    expiresAtMs: Date.now() + 60_000,
    consentSource: "signin",
  };
  for (const [result, error] of [
    [{ authorization: { id_token: "token", state: "state" } }, null],
    [{ id_token: "token", state: "wrong" }, /state mismatch/],
    [{ id_token: 7, state: "state" }, /did not return id_token/],
  ]) {
    const h = apple(result);
    const pending = h.api.signInWithApplePopup(request);
    const outcome = error ? assert.rejects(pending, error) : pending;
    await pump();
    await h.tick(1500);
    if (error) await outcome;
    else assert.deepEqual(await outcome, { idToken: "token" });
    assert.deepEqual(h.calls, [
      [
        "init",
        true,
        {
          clientId: "link.mons",
          redirectURI: "https://mons.link",
          state: "state",
          nonce: "nonce",
          usePopup: true,
          responseType: "id_token",
          responseMode: "fragment",
        },
      ],
      ["signIn", true],
    ]);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.timers.size, 0);
  }
});

test("Apple failure details retain string/object fallback handling", async () => {
  const circular = {};
  circular.self = circular;
  for (const [detail, message] of [
    ["denied", "denied"],
    [{ error: "cancelled" }, "cancelled"],
    [{ error: { code: "failed" } }, '{"code":"failed"}'],
    [{ error: circular }, "Apple sign in failed"],
  ]) {
    const h = apple(new Promise(() => {}));
    const rejected = assert.rejects(h.api.wait(["state"]), { message });
    h.emit("AppleIDSignInOnFailure", detail);
    await rejected;
    assert.equal(h.listeners.size, 0);
    assert.equal(h.timers.size, 0);
  }
});
