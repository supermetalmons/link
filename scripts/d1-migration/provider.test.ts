import assert from "node:assert/strict";
import test from "node:test";
import {
  CloudflareRequestFailure,
  createCloudflareProvider,
  type QueryParameter,
} from "./provider.ts";

const ACCOUNT = "a".repeat(32);
const DATABASE = "00000000-0000-4000-8000-000000000001";
const TOKEN = "private-test-provider-token";
const PRIVATE_BODY = "private-row-and-provider-error-content";

function fixture() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const state = {
    respond: (_url: string, _init: RequestInit): Response =>
      Response.json({ success: true, result: { ok: true } }),
  };
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return state.respond(url, init);
  };
  const provider = createCloudflareProvider(ACCOUNT, { token: TOKEN, fetcher });
  return { provider, calls, state, fetcher };
}

test("provider binds requests to the selected account and disables redirect following", async () => {
  const f = fixture();
  const result = await f.provider.request("workflows/mons-link-event-progress");
  assert.deepEqual(result, { ok: true });
  assert.equal(f.calls.length, 1);
  assert.equal(
    f.calls[0].url,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workflows/mons-link-event-progress`,
  );
  assert.equal(f.calls[0].init.redirect, "error");
  assert(f.calls[0].init.signal instanceof AbortSignal);
  assert.equal(
    new Headers(f.calls[0].init.headers).get("Authorization"),
    `Bearer ${TOKEN}`,
  );
});

test("provider rejects invalid account identities without making requests", () => {
  const f = fixture();
  for (const account of [
    "",
    "short",
    "A".repeat(32),
    `${ACCOUNT}/elsewhere`,
    "https://foreign.invalid",
  ]) {
    assert.throws(
      () =>
        createCloudflareProvider(account, { token: TOKEN, fetcher: f.fetcher }),
      /invalid account/i,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("provider rejects absolute, encoded and backslash paths that escape its account", async () => {
  const f = fixture();
  for (const path of [
    "/workflows/name",
    "//foreign.invalid/path",
    "https://foreign.invalid/path",
    "../another-account/workflows/name",
    "%2e%2e/another-account/workflows/name",
    "%2E%2E/another-account/workflows/name",
    "d1/%2e%2e/%2e%2e/another-account/workflows/name",
    "\\%2e%2e\\another-account\\workflows\\name",
  ]) {
    await assert.rejects(
      f.provider.request(path),
      /invalid.*path|outside.*account/i,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("D1 requests preserve UUID, SQL and parameters while respecting byte and binding limits", async () => {
  const f = fixture();
  f.state.respond = () =>
    Response.json({
      success: true,
      result: [{ success: true, results: [{ rows: 1 }] }],
    });
  assert.deepEqual(
    await f.provider.query(DATABASE, "SELECT ? AS label", ["unchanged-label"]),
    [{ rows: 1 }],
  );
  assert.equal(
    f.calls[0].url,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`,
  );
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), {
    sql: "SELECT ? AS label",
    params: ["unchanged-label"],
  });
  await f.provider.query(
    DATABASE,
    "é".repeat(45 * 1024),
    Array.from({ length: 100 }, () => null),
  );
  const count = f.calls.length;
  await assert.rejects(
    f.provider.query("wrong-database", "SELECT 1"),
    /database UUID/,
  );
  await assert.rejects(
    f.provider.query(DATABASE, "é".repeat(45 * 1024) + "x"),
    /bounded statement limits/,
  );
  await assert.rejects(
    f.provider.query(
      DATABASE,
      "SELECT 1",
      Array.from({ length: 101 }, () => null),
    ),
    /bounded statement limits/,
  );
  assert.equal(f.calls.length, count);
});

test("D1 rejects nonfinite and unsupported parameters before JSON can coerce stored data", async () => {
  const f = fixture();
  f.state.respond = () =>
    Response.json({ success: true, result: [{ success: true, results: [] }] });
  for (const value of [NaN, Infinity, -Infinity, { unsafe: true }, undefined]) {
    await assert.rejects(
      f.provider.query(DATABASE, "SELECT ?", [value] as QueryParameter[]),
      /parameter|binding|finite|JSON/i,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("provider failures retain status and codes without leaking tokens, response text or SQL values", async () => {
  const f = fixture();
  f.state.respond = () =>
    Response.json(
      {
        success: false,
        errors: [{ code: 6003, message: `${TOKEN} ${PRIVATE_BODY}` }],
      },
      { status: 403 },
    );
  await assert.rejects(
    f.provider.query(DATABASE, "SELECT ?", [PRIVATE_BODY]),
    (error: unknown) => {
      assert(error instanceof CloudflareRequestFailure);
      assert.equal(error.status, 403);
      assert.deepEqual(error.codes, [6003]);
      assert.equal(String(error).includes(TOKEN), false);
      assert.equal(String(error).includes(PRIVATE_BODY), false);
      return true;
    },
  );
});

test("provider preserves non-JSON 404 status for safe ambiguous-operation recovery", async () => {
  const f = fixture();
  f.state.respond = () =>
    new Response(`${TOKEN} ${PRIVATE_BODY}`, { status: 404 });
  await assert.rejects(
    f.provider.request("workflows/mons-link-event-progress/instances/missing"),
    (error: unknown) => {
      assert(error instanceof CloudflareRequestFailure);
      assert.equal(error.status, 404);
      assert.equal(String(error).includes(TOKEN), false);
      assert.equal(String(error).includes(PRIVATE_BODY), false);
      return true;
    },
  );
});

test("provider accepts an empty successful 204 response", async () => {
  const f = fixture();
  f.state.respond = () => new Response(null, { status: 204 });
  assert.equal(
    await f.provider.request("queues/selected-queue/consumer", "DELETE"),
    null,
  );
});

test("D1 rejects unconfirmed statement results and malformed result rows", async () => {
  const f = fixture();
  for (const result of [
    [],
    [{ success: false, results: [], error: PRIVATE_BODY }],
    [{ success: true, results: [1] }],
    [{ success: true }],
  ]) {
    f.state.respond = () => Response.json({ success: true, result });
    await assert.rejects(
      f.provider.query(DATABASE, "SELECT 1"),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(String(error).includes(PRIVATE_BODY), false);
        return true;
      },
    );
  }
});

test("provider list traverses complete pages without dropping the final partial page", async () => {
  const f = fixture();
  f.state.respond = (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    const length = page === 1 ? 100 : 3;
    return Response.json({
      success: true,
      result: Array.from({ length }, (_, index) => ({
        id: (page - 1) * 100 + index,
      })),
    });
  };
  const rows = await f.provider.list("d1/database?name=selected");
  assert.equal(rows.length, 103);
  assert.deepEqual(rows.at(-1), { id: 102 });
  assert.equal(f.calls.length, 2);
});
