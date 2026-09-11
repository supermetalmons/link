import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createMatchStateProvider } from "./match-state-provider.ts";
import { mapMatchStateBounded } from "./match-state-concurrency.ts";

function fixture(failedActors: string[] = []) {
  const actors = Array.from(
    { length: 40 },
    (_, index) => `actor-${String(index).padStart(2, "0")}`,
  );
  let active = 0;
  let maximum = 0;
  const requested = new Set<string>();
  const provider = createMatchStateProvider({
    run: async () => [],
    firebaseToken: async () => "test-source-token",
    fetcher: async (url, options) => {
      assert.equal(
        new URL(String(url)).origin,
        "https://mons-link-default-rtdb.firebaseio.com",
      );
      assert.equal(options?.method ?? "GET", "GET");
      assert.equal(
        new Headers(options?.headers).get("Authorization"),
        "Bearer test-source-token",
      );
      const path = new URL(String(url)).pathname;
      if (path === "/players.json")
        return Response.json(
          Object.fromEntries(actors.map((id) => [id, true])),
        );
      if (path === "/matchTimerClaims.json")
        return Response.json({ legacy: { status: "claimed" } });
      const actor = path.split("/")[2];
      assert.equal(path, `/players/${actor}/matches.json`);
      requested.add(actor);
      active++;
      maximum = Math.max(active, maximum);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      if (failedActors.includes(actor))
        return Response.json({ error: "failed" }, { status: 503 });
      return Response.json({
        one: { fen: `${actor}-fen`, timer: "1;1000" },
        two: "legacy",
      });
    },
  });
  return { provider, requested, maximum: () => maximum };
}

test("source inventory reads player subtrees with bounded parallelism and stable ordering", async () => {
  const f = fixture();
  const result = await f.provider.inventory();
  assert.equal(result.records.length, 80);
  assert.equal(result.claims.length, 1);
  assert.equal(f.requested.size, 40);
  assert.equal(f.maximum(), 16);
  assert.deepEqual(result.records[0], {
    actorUid: "actor-00",
    matchId: "one",
    value: { fen: "actor-00-fen", timer: "1;1000" },
  });
  assert.deepEqual(result.records[1], {
    actorUid: "actor-00",
    matchId: "two",
    value: "legacy",
  });
});

test("all independent source failures are observed before inventory fails", async () => {
  const f = fixture(["actor-01", "actor-31"]);
  await assert.rejects(
    f.provider.inventory(),
    (error: unknown) =>
      error instanceof AggregateError && error.errors.length === 2,
  );
  assert.equal(f.requested.size, 40);
  assert.equal(f.maximum(), 16);
});

test("provider construction needs no Firebase runtime variable or credential access", () => {
  assert.doesNotThrow(() =>
    createMatchStateProvider({
      run: async () => [],
      firebaseCredentials: resolve(
        import.meta.dirname,
        "missing-source-credentials.json",
      ),
      fetcher: async () => {
        throw new Error("must remain lazy");
      },
    }),
  );
});

test("deployment inspection never loads historical Firebase credentials", async () => {
  const previousToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = "test-cloudflare-token";
  const versionId = "00000000-0000-4000-8000-000000000001";
  let requests = 0;
  try {
    const provider = createMatchStateProvider({
      run: async () => {
        throw new Error("deployment inspection must not read source inventory");
      },
      firebaseCredentials: resolve(
        import.meta.dirname,
        "missing-source-credentials.json",
      ),
      fetcher: async (url, options) => {
        requests++;
        const requestUrl = new URL(String(url));
        assert.equal(requestUrl.origin, "https://api.cloudflare.com");
        assert.match(
          requestUrl.pathname,
          /\/workers\/scripts\/mons-link-api\/deployments$/,
        );
        assert.equal(
          new Headers(options?.headers).get("Authorization"),
          "Bearer test-cloudflare-token",
        );
        return Response.json({
          success: true,
          result: {
            deployments: [
              { versions: [{ version_id: versionId, percentage: 100 }] },
            ],
          },
        });
      },
    });
    assert.equal(await provider.deployment(), versionId);
    assert.equal(requests, 1);
  } finally {
    if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previousToken;
  }
});

test("bounded mapper preserves input order across completions and visits every failure", async () => {
  let visited = 0;
  await assert.rejects(
    mapMatchStateBounded([1, 2, 3, 4, 5], 2, async (value) => {
      visited++;
      if (value === 2 || value === 4) throw new Error(`failed-${value}`);
      return value;
    }),
    (error: unknown) =>
      error instanceof AggregateError && error.errors.length === 2,
  );
  assert.equal(visited, 5);
  assert.deepEqual(
    await mapMatchStateBounded([4, 2, 3], 2, async (value) => value * 2),
    [8, 4, 6],
  );
});
