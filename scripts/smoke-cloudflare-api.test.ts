const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test") = require("node:test");
const { parseArgs, smokeApi } = require("./smoke-cloudflare-api.ts") as {
  parseArgs: (argv: string[]) => {
    baseUrl: string;
    smokeSol: string;
  };
  smokeApi: (
    options: {
      baseUrl: string;
      smokeSol: string;
    },
    dependencies: {
      fetch: typeof fetch;
      randomState: () => string;
      log: (message: string) => void;
    },
  ) => Promise<void>;
};

const WALLET = "11111111111111111111111111111111";
const EMPTY_NFTS = {
  ok: true,
  specials: [],
  swagpack_avatars: [],
  swagpack_reactions: [],
};
function json(
  body: unknown,
  status: number,
  headers: HeadersInit = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

test("parses only production and canonical preview smoke targets", () => {
  assert.deepEqual(
    parseArgs(["--base-url", "https://api.mons.link/", "--smoke-sol", WALLET]),
    { baseUrl: "https://api.mons.link", smokeSol: WALLET },
  );
  assert.deepEqual(
    parseArgs([
      "--base-url",
      "https://12ab34cd-mons-link-api.lil-org.workers.dev",
      "--smoke-sol",
      WALLET,
    ]),
    {
      baseUrl: "https://12ab34cd-mons-link-api.lil-org.workers.dev",
      smokeSol: WALLET,
    },
  );
  for (const target of [
    "http://api.mons.link",
    "https://evil.example",
    "https://api.mons.link/path",
    "https://user@api.mons.link",
  ]) {
    assert.throws(
      () => parseArgs(["--base-url", target, "--smoke-sol", WALLET]),
      /Usage:/,
    );
  }
});

test("smokes public, unauthenticated, and internal routes", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  let nftPosts = 0;
  const fetchStub: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    requests.push({ method, url });
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.signal instanceof AbortSignal, true);

    if (url.endsWith("/nfts") && method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    }
    if (url.endsWith("/nfts") && method === "POST") {
      nftPosts += 1;
      return json(
        nftPosts === 1
          ? EMPTY_NFTS
          : {
              ...EMPTY_NFTS,
              specials: [{ id: 2, count: 1 }],
            },
        200,
      );
    }
    if (url.endsWith("/auth/intents") && method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "https://mons.link",
          "Cache-Control": "no-store",
        },
      });
    }
    if (url.endsWith("/auth/intents")) {
      return json({ error: "unauthenticated" }, 401);
    }
    if (
      [
        "/invites/create",
        "/invites/join",
        "/matches/ensure",
        "/rematches/propose",
        "/rematches/end",
        "/events/create",
        "/events/start/postpone",
        "/events/matches/winners/disqualify",
        "/events/prize-selections/toggle",
        "/events/state/sync",
        "/profiles/custom",
      ].some((path) => url.endsWith(path))
    ) {
      return json({ error: "unauthenticated" }, 401);
    }
    if (url.includes("/auth/x/callback")) {
      return json({ error: "invalid-state" }, 400);
    }
    if (url.endsWith("/internal/telegram/delivery")) {
      return json({ error: "unauthenticated" }, 401);
    }
    throw new Error(`Unexpected smoke request: ${method} ${url}`);
  };
  const logs: string[] = [];

  await smokeApi(
    { baseUrl: "https://api.mons.link", smokeSol: WALLET },
    {
      fetch: fetchStub,
      randomState: () => "abcdefghijklmnopqrstuvwx",
      log: (message) => logs.push(message),
    },
  );

  assert.equal(requests.length, 19);
  assert.deepEqual(logs, ["[api-smoke] Passed https://api.mons.link"]);
});

test("fails on a malformed or cacheable response", async () => {
  const base = { baseUrl: "https://api.mons.link", smokeSol: WALLET };
  await assert.rejects(
    smokeApi(base, {
      fetch: async () => new Response(null, { status: 204 }),
      randomState: () => "abcdefghijklmnopqrstuvwx",
      log: () => undefined,
    }),
    /cacheable/,
  );
});
