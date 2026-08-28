const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
}: typeof import("node:fs") = require("node:fs");
const { tmpdir }: typeof import("node:os") = require("node:os");
const { join }: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const {
  DEFAULT_SMOKE_PROFILE,
  DEFAULT_SMOKE_SOL,
  parseArgs,
  smokeApi,
  smokeAuthenticatedAuthState,
} = require("./smoke-cloudflare-api.ts") as {
  DEFAULT_SMOKE_PROFILE: { loginId: string; profileId: string };
  DEFAULT_SMOKE_SOL: string;
  parseArgs: (argv: string[]) => {
    baseUrl: string;
    smokeProfile: { loginId: string; profileId: string };
    smokeSol: string;
  };
  smokeApi: (
    options: {
      baseUrl: string;
      smokeProfile: { loginId: string; profileId: string };
      smokeSol: string;
    },
    dependencies: {
      fetch: typeof fetch;
      randomState: () => string;
      log: (message: string) => void;
    },
  ) => Promise<void>;
  smokeAuthenticatedAuthState: (
    baseUrl: string,
    smokeProfile: { loginId: string; profileId: string },
    dependencies: {
      fetch: typeof fetch;
      randomState: () => string;
      log: (message: string) => void;
    },
  ) => Promise<void>;
};

const WALLET = "11111111111111111111111111111111";
const LOGIN = "known-login";
const SMOKE_PROFILE = { loginId: LOGIN, profileId: "profile-1" };
const EMPTY_NFTS = {
  ok: true,
  specials: [],
  swagpack_avatars: [],
  swagpack_reactions: [],
};
const PROFILE = {
  id: "profile-1",
  nonce: 1,
  rating: 1500,
  totalManaPoints: 0,
  win: true,
  emoji: 1,
  username: null,
  eth: null,
  sol: null,
  mining: {
    lastRockDate: null,
    materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  },
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

function profileFixture(): { cleanup(): void; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "mons-link-smoke-"));
  const path = join(directory, "profile.json");
  writeFileSync(path, JSON.stringify(SMOKE_PROFILE), { mode: 0o600 });
  return {
    path,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("parses only production and canonical preview smoke targets", () => {
  const fixture = profileFixture();
  try {
    assert.deepEqual(parseArgs(["--base-url", "https://api.mons.link/"]), {
      baseUrl: "https://api.mons.link",
      smokeProfile: DEFAULT_SMOKE_PROFILE,
      smokeSol: DEFAULT_SMOKE_SOL,
    });
    assert.deepEqual(
      parseArgs([
        "--base-url",
        "https://api.mons.link/",
        "--smoke-sol",
        WALLET,
        "--smoke-profile-fixture",
        fixture.path,
      ]),
      {
        baseUrl: "https://api.mons.link",
        smokeProfile: SMOKE_PROFILE,
        smokeSol: WALLET,
      },
    );
    assert.deepEqual(
      parseArgs([
        "--base-url",
        "https://12ab34cd-mons-link-api.lil-org.workers.dev",
      ]),
      {
        baseUrl: "https://12ab34cd-mons-link-api.lil-org.workers.dev",
        smokeProfile: DEFAULT_SMOKE_PROFILE,
        smokeSol: DEFAULT_SMOKE_SOL,
      },
    );
    for (const target of [
      "http://api.mons.link",
      "https://evil.example",
      "https://api.mons.link/path",
      "https://user@api.mons.link",
    ]) {
      assert.throws(() => parseArgs(["--base-url", target]), /Usage:/);
    }
    chmodSync(fixture.path, 0o644);
    assert.throws(
      () =>
        parseArgs([
          "--base-url",
          "https://api.mons.link",
          "--smoke-profile-fixture",
          fixture.path,
        ]),
      /Usage:/,
    );
  } finally {
    fixture.cleanup();
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
      if (new Headers(init?.headers).has("Authorization")) {
        return json(
          {
            ok: true,
            intentId: "abcdefghijklmnopqrstuvwx",
            nonce: "nonce",
            state: "state",
            expiresAtMs: 2_000_000,
          },
          200,
        );
      }
      return json({ error: "unauthenticated" }, 401);
    }
    if (url.endsWith("/auth/x/flows")) {
      return json(
        {
          ok: true,
          flowId: "zyxwvutsrqponmlkjihgfedc",
          authUrl:
            "https://x.com/i/oauth2/authorize?state=zyxwvutsrqponmlkjihgfedc",
          expiresAtMs: 2_000_000,
        },
        200,
      );
    }
    if (url.endsWith("/leaderboards/read")) {
      return json({ ok: true, profiles: [PROFILE] }, 200);
    }
    if (url.endsWith("/profiles/lookup")) {
      return json(
        {
          ok: true,
          profile: PROFILE,
        },
        200,
      );
    }
    if (
      url.endsWith("/invites/role/read") &&
      new Headers(init?.headers).has("Authorization")
    ) {
      return json(
        { ok: false, error: "not-found", message: "invite-not-found" },
        404,
      );
    }
    if (url.includes("identitytoolkit.googleapis.com/v1/accounts:signUp")) {
      return json({ idToken: "firebase-id-token", localId: "smoke-uid" }, 200);
    }
    if (url.includes("identitytoolkit.googleapis.com/v1/accounts:delete")) {
      return json({}, 200);
    }
    if (
      [
        "/invites/create",
        "/invites/join",
        "/invites/role/read",
        "/matches/ensure",
        "/navigation/games/read",
        "/rematches/propose",
        "/rematches/end",
        "/events/create",
        "/events/start/postpone",
        "/events/matches/winners/disqualify",
        "/events/prize-selections/toggle",
        "/events/prizes/withdrawals",
        "/events/prizes/withdrawals/status",
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
    {
      baseUrl: "https://api.mons.link",
      smokeProfile: SMOKE_PROFILE,
      smokeSol: WALLET,
    },
    {
      fetch: fetchStub,
      randomState: () => "abcdefghijklmnopqrstuvwx",
      log: (message) => logs.push(message),
    },
  );

  assert.equal(requests.length, 37);
  assert.deepEqual(logs, ["[api-smoke] Passed https://api.mons.link"]);
});

test("fails on a malformed or cacheable response", async () => {
  const base = {
    baseUrl: "https://api.mons.link",
    smokeProfile: SMOKE_PROFILE,
    smokeSol: WALLET,
  };
  await assert.rejects(
    smokeApi(base, {
      fetch: async () => new Response(null, { status: 204 }),
      randomState: () => "abcdefghijklmnopqrstuvwx",
      log: () => undefined,
    }),
    /cacheable/,
  );
});

test("deletes an anonymous smoke user after an incomplete signup response", async () => {
  let deleted = false;
  await assert.rejects(
    smokeAuthenticatedAuthState("https://api.mons.link", SMOKE_PROFILE, {
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("accounts:signUp")) {
          return json({ idToken: "firebase-id-token" }, 200);
        }
        if (url.includes("accounts:delete")) {
          deleted = true;
          return json({}, 200);
        }
        throw new Error(`Unexpected request: ${url}`);
      },
      randomState: () => "abcdefghijklmnopqrstuvwx",
      log: () => undefined,
    }),
    /incomplete/,
  );
  assert.equal(deleted, true);
});
