import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    )
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const { createInitialIdentityBootstrap } =
  await import("../src/services/initialIdentityBootstrap.ts");
const { AuthApiError } = await import("../src/services/authApi.ts");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const make = ({
  bootstrap = { ok: true, profile: null },
  support = "supported",
  fetch = async () => ({ ok: true, profile: null }),
} = {}) => {
  const user = {
    uid: "u",
    sessionId: "s",
    generation: "g",
    getIdToken: async () => "token",
  };
  let preparations = 0;
  let reads = 0;
  const auth = {
    currentUser: user,
    prepareInitialIdentity: async () => {
      preparations++;
      return { user: auth.currentUser, bootstrap, support };
    },
  };
  const helper = createInitialIdentityBootstrap({
    auth,
    read: async (provider) => {
      reads++;
      await provider(false);
      return fetch();
    },
  });
  return { helper, auth, user, counts: () => ({ preparations, reads }) };
};

test("startup and simultaneous consumers share a verified seed until successful consumption", async () => {
  const h = make();
  h.helper.start();
  const first = h.helper.read();
  assert.equal(first, h.helper.read());
  const result = await first;
  assert.deepEqual(result.read(), { ok: true, profile: null });
  assert.deepEqual(h.counts(), { preparations: 1, reads: 0 });
  h.helper.consume(result);
  assert.deepEqual(result.read(), { ok: true, profile: null });
  await h.helper.read();
  assert.equal(h.counts().preparations, 2);
});

test("unsupported marker avoids GET while missing, unavailable and malformed seeds use read-only fallback", async () => {
  const legacy = make({ bootstrap: undefined, support: "legacy" });
  assert.deepEqual((await legacy.helper.read()).read(), {
    ok: false,
    status: "legacy",
  });
  assert.equal(legacy.counts().reads, 0);
  for (const bootstrap of [null, { ok: false, status: 503 }]) {
    const h = make({ bootstrap });
    assert.deepEqual((await h.helper.read()).read(), {
      ok: true,
      profile: null,
    });
    assert.equal(h.counts().reads, 1);
  }
});

test("409 remains explicit and a failed fallback is evicted for retry", async () => {
  const repair = make({ bootstrap: { ok: false, status: 409 } });
  assert.deepEqual((await repair.helper.read()).read(), {
    ok: false,
    status: 409,
  });
  assert.equal(repair.counts().reads, 0);
  const getRepair = make({
    bootstrap: null,
    fetch: async () => {
      throw new AuthApiError("failed-precondition", "profile-repair-required");
    },
  });
  assert.equal((await getRepair.helper.read()).read().status, 409);
  let fail = true;
  const h = make({
    bootstrap: null,
    fetch: async () => {
      if (fail) throw new AuthApiError("unavailable", "offline");
      return { ok: true, profile: null };
    },
  });
  await assert.rejects(h.helper.read(), { code: "unavailable" });
  fail = false;
  assert.equal((await h.helper.read()).read().ok, true);
  assert.equal(h.counts().reads, 2);
});

test("mutation invalidation and same-uid replacement fence retained and in-flight results", async () => {
  const pending = deferred();
  const h = make({ bootstrap: null, fetch: () => pending.promise });
  const stale = h.helper.read();
  await new Promise(setImmediate);
  h.helper.invalidate();
  pending.resolve({ ok: true, profile: null });
  await assert.rejects(stale, /authentication-changed/);
  const result = await h.helper.read();
  h.auth.currentUser = { ...h.user, generation: "new-generation" };
  assert.throws(() => result.read(), /authentication-changed/);
  const replacement = await h.helper.read();
  assert.equal(replacement.user, h.auth.currentUser);
  h.auth.currentUser = null;
  assert.throws(() => replacement.read(), /authentication-changed/);
});

test("repair is shared and refreshes authoritative identity even after the original consumer disappears", async () => {
  const h = make({ bootstrap: { ok: false, status: 409 } });
  const source = await h.helper.read();
  const gate = deferred();
  let repairs = 0;
  const repair = () => {
    repairs++;
    return gate.promise;
  };
  const first = h.helper.repair(source, repair);
  assert.equal(first, h.helper.repair(source, repair));
  h.auth.prepareInitialIdentity = async () => ({
    user: h.user,
    bootstrap: undefined,
    support: "supported",
  });
  gate.resolve();
  const repaired = await first;
  assert.equal(repairs, 1);
  assert.deepEqual(repaired.read(), { ok: true, profile: null });
  assert.equal(await h.helper.read(), repaired);
  assert.equal(await h.helper.repair(source, repair), repaired);
  assert.equal(repairs, 1);
  assert.throws(() => source.read(), /authentication-changed/);
});

test("failed repairs can retry while logout or mutation fences a late successful repair", async () => {
  const h = make({ bootstrap: { ok: false, status: 409 } });
  const source = await h.helper.read();
  await assert.rejects(
    h.helper.repair(source, async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  const gate = deferred();
  const pending = h.helper.repair(source, () => gate.promise);
  h.helper.invalidate();
  gate.resolve();
  await assert.rejects(pending, /authentication-changed/);
});

test("peeking never starts a read and only exposes a matching existing startup owner", async () => {
  const h = make();
  assert.equal(h.helper.peek(h.user), null);
  assert.equal(h.counts().preparations, 0);
  const pending = h.helper.read();
  assert.equal(h.helper.peek(h.user), pending);
  assert.equal(h.helper.peek({ ...h.user }), null);
  const result = await pending;
  h.helper.consume(result);
  assert.equal(h.helper.peek(h.user), null);
});

test("standalone identity GET keeps the four-megabyte profile response bound", async () => {
  const { getIdentityViaApi } = await import("../src/services/authApi.ts");
  const originalFetch = globalThis.fetch;
  let canceled = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.mons.link/auth/identity");
    assert.equal(options.method, "GET");
    assert.equal(
      new Headers(options.headers).get("Authorization"),
      "Bearer token",
    );
    return new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
      { headers: { "Content-Length": String(4 * 1024 * 1024 + 1) } },
    );
  };
  try {
    await assert.rejects(
      getIdentityViaApi(async () => "token"),
      { code: "unavailable" },
    );
    assert.equal(canceled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applied-startup eligibility is exact-user scoped and cleared by mutation invalidation", async () => {
  const h = make({ bootstrap: { ok: true, profile: { id: "profile" } } });
  assert.equal(h.helper.wasConsumed(h.user), false);
  h.helper.consume(await h.helper.read());
  assert.equal(h.helper.wasConsumed(h.user), true);
  assert.equal(h.helper.wasConsumed({ ...h.user }), false);
  h.helper.invalidate();
  assert.equal(h.helper.wasConsumed(h.user), false);
});
