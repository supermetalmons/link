import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { resolveD1Coordinates } from "./operator/configuration.ts";
import { createWranglerRunner } from "./operator/runtime.ts";

const accountId = "a".repeat(32);
const databaseId = "11111111-1111-4111-8111-111111111111";
function fixture(t: test.TestContext, bindings: unknown[]) {
  const directory = mkdtempSync(resolve(tmpdir(), "d1-coordinates-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = resolve(directory, "config.json");
  writeFileSync(
    path,
    JSON.stringify({ account_id: accountId, d1_databases: bindings }),
    { mode: 0o600 },
  );
  return path;
}

test("logical names and stable bindings resolve the suffixed replacement through explicit configuration", async (t) => {
  const path = fixture(t, [
    {
      binding: "PROFILE_DB",
      database_id: databaseId,
      database_name: "mons-link-profiles-enam",
    },
  ]);
  assert.equal(
    resolveD1Coordinates("mons-link-profiles", path).databaseId,
    databaseId,
  );
  assert.equal(
    resolveD1Coordinates("PROFILE_DB", path).databaseName,
    "mons-link-profiles-enam",
  );
  let requested = "";
  const run = createWranglerRunner({
    apiToken: "fixture-token",
    configPath: path,
    fetcher: async (input) => {
      requested = String(input);
      return Response.json({
        success: true,
        result: [{ success: true, results: [{ ok: 1 }] }],
      });
    },
  });
  assert.deepEqual(await run("SELECT 1 AS ok", "mons-link-profiles"), [
    { ok: 1 },
  ]);
  assert.match(requested, new RegExp(`/d1/database/${databaseId}/query$`));
});

test("operator and admin configuration reject duplicate or missing stable bindings", (t) => {
  const require = createRequire(import.meta.url);
  const { parseConfig } = require("../cloud/admin/_d1.js") as {
    parseConfig: (path: string) => unknown;
  };
  const entry = {
    binding: "PROFILE_DB",
    database_id: databaseId,
    database_name: "mons-link-profiles-enam",
  };
  for (const entries of [[], [entry, entry]]) {
    const path = fixture(t, entries);
    assert.throws(() => resolveD1Coordinates("PROFILE_DB", path), /ambiguous/);
    assert.throws(() => parseConfig(path), /coordinates/);
  }
  const path = fixture(t, [entry]);
  assert.deepEqual(parseConfig(path), { accountId, databaseId });
  assert.throws(() => resolveD1Coordinates("unowned-db", path), /unknown/);
});
