import type { RuntimeDependencies } from "./deploy-cloudflare-api.ts";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const {
  createChildEnvironment,
  execute,
  parseArgs,
  parseNftResponse,
  parseUploadMetadata,
  smokeApi,
} = require("./deploy-cloudflare-api.ts");

const VERSION_ID = "4da38b82-96db-472c-8856-a2e72d34079d";
const PREVIEW_URL = "https://4da38b82-mons-link-api.lil-org.workers.dev";
const SMOKE_SOL = "11111111111111111111111111111111";
const NODE_EXECUTABLE = "/runtime/node";
const NPM_CLI_PATH = "/runtime/npm-cli.js";
const WRANGLER_CLI_PATH = "/workspace/node_modules/wrangler/bin/wrangler.js";
const WRANGLER_RELEASE_ENV_FILE = "cloud/workers/api/release.env";

function createRuntimeDependencies(
  overrides: Partial<RuntimeDependencies> = {},
): RuntimeDependencies {
  return {
    repoRoot: "/workspace",
    nodeExecutable: NODE_EXECUTABLE,
    nodeVersion: "24.5.0",
    processEnv: {
      npm_execpath: NPM_CLI_PATH,
      CLOUDFLARE_API_TOKEN: "token",
    },
    pid: 42,
    now: () => 1234,
    spawn: () => ({ status: 0 }),
    exists: (path) => path === NPM_CLI_PATH || path === WRANGLER_CLI_PATH,
    mkdir: () => undefined,
    readFile: () => {
      throw new Error("Unexpected file read.");
    },
    unlink: () => undefined,
    fetch: async () => {
      throw new Error("Unexpected fetch.");
    },
    sleep: async () => undefined,
    log: () => undefined,
    ...overrides,
  };
}

function responseHeaders(extra: Record<string, string> = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    ...extra,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders({ "Content-Type": "application/json" }),
  });
}

function bodyFailureResponse(detail: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":'));
      controller.error(new Error(detail));
    },
  });
  return new Response(body, {
    status: 200,
    headers: responseHeaders({ "Content-Type": "application/json" }),
  });
}

function emptyPayload() {
  return {
    ok: true,
    specials: [],
    swagpack_avatars: [],
    swagpack_reactions: [],
  };
}

function smokeResponses(providerAttempts = 1): Response[] {
  const responses = [
    new Response(null, { status: 204, headers: responseHeaders() }),
    jsonResponse(emptyPayload()),
  ];
  for (let index = 1; index < providerAttempts; index++) {
    responses.push(jsonResponse({ ok: false }, 502));
  }
  responses.push(
    jsonResponse({
      ok: true,
      specials: [{ id: 7, count: 2 }],
      swagpack_avatars: [],
      swagpack_reactions: [{ id: 3, count: 1 }],
    }),
  );
  return responses;
}

function nextResponse(responses: Response[]): Response {
  const response = responses.shift();
  if (!response) {
    throw new Error("Missing smoke response.");
  }
  return response;
}

test("parses preview and production arguments", () => {
  assert.deepEqual(
    parseArgs([
      "preview",
      "--smoke-sol",
      SMOKE_SOL,
      "--token-file",
      "/tmp/token",
    ]),
    {
      mode: "preview",
      smokeSol: SMOKE_SOL,
      tokenFile: "/tmp/token",
      versionId: undefined,
    },
  );
  assert.deepEqual(
    parseArgs([
      "production",
      "--version-id",
      VERSION_ID,
      "--smoke-sol",
      SMOKE_SOL,
    ]),
    {
      mode: "production",
      smokeSol: SMOKE_SOL,
      tokenFile: undefined,
      versionId: VERSION_ID,
    },
  );
});

test("parses trigger updates without a smoke wallet or version", () => {
  assert.deepEqual(parseArgs(["triggers"]), {
    mode: "triggers",
    tokenFile: undefined,
  });
  assert.deepEqual(parseArgs(["triggers", "--token-file", "/tmp/token"]), {
    mode: "triggers",
    tokenFile: "/tmp/token",
  });
  assert.throws(
    () => parseArgs(["triggers", "--smoke-sol", SMOKE_SOL]),
    /not valid in triggers mode/,
  );
  assert.throws(
    () => parseArgs(["triggers", "--version-id", VERSION_ID]),
    /not valid in triggers mode/,
  );
});

test("requires an explicit smoke wallet and production version", () => {
  assert.throws(() => parseArgs(["preview"]), /--smoke-sol is required/);
  assert.throws(
    () => parseArgs(["preview", "--smoke-sol", "not-a-solana-address"]),
    /valid 32-byte Solana address/,
  );
  assert.throws(
    () =>
      parseArgs(["preview", "--smoke-sol", "1111111111111111111111111111111"]),
    /valid 32-byte Solana address/,
  );
  assert.throws(
    () => parseArgs(["production", "--smoke-sol", SMOKE_SOL]),
    /exact smoke-tested --version-id/,
  );
  assert.throws(
    () =>
      parseArgs([
        "production",
        "--version-id",
        "not-a-version",
        "--smoke-sol",
        SMOKE_SOL,
      ]),
    /must be a UUID/,
  );
});

test("API token-file failures do not expose filesystem details", async () => {
  const dependencies = createRuntimeDependencies({
    readFile: () => {
      throw new Error("private filesystem detail");
    },
  });

  await assert.rejects(
    execute(["triggers", "--token-file", "/secure/token"], dependencies),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Unable to read --token-file." &&
      !error.message.includes("private filesystem detail"),
  );
});

test("removes Cloudflare, Wrangler, Helius, and dotenv values from child environments", () => {
  assert.deepEqual(
    createChildEnvironment({
      PATH: "/bin",
      CLOUDFLARE_API_TOKEN: "cloudflare",
      cloudflare_account_id: "account",
      CF_API_TOKEN: "legacy-token",
      cf_api_base_url: "https://legacy.invalid",
      WRANGLER_LOG_PATH: "/tmp/log",
      wrangler_send_metrics: "true",
      HELIUS_RPC_API_KEY: "helius",
      DOTENV_KEY: "dotenv-vault-key",
    }),
    { PATH: "/bin" },
  );
});

test("keeps the Wrangler release environment file value-free", () => {
  const contents = readFileSync(
    resolve(__dirname, "..", WRANGLER_RELEASE_ENV_FILE),
    "utf8",
  );
  const hasActiveEntry = contents.split(/\r?\n/).some((line: string) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#");
  });

  assert.equal(
    hasActiveEntry,
    false,
    "Wrangler release environment file must contain only comments or blank lines.",
  );
});

test("requires the npm lifecycle JavaScript entrypoint", async () => {
  await assert.rejects(
    execute(
      ["production", "--version-id", VERSION_ID, "--smoke-sol", SMOKE_SOL],
      {
        repoRoot: "/workspace",
        nodeExecutable: NODE_EXECUTABLE,
        nodeVersion: "24.5.0",
        processEnv: { CLOUDFLARE_API_TOKEN: "token" },
      },
    ),
    /Run this command through npm run deploy:api/,
  );
});

test("validates Wrangler upload metadata", () => {
  const metadata = parseUploadMetadata(
    [
      JSON.stringify({ type: "wrangler-session" }),
      JSON.stringify({
        type: "version-upload",
        worker_name: "mons-link-api",
        version_id: VERSION_ID,
        preview_url: PREVIEW_URL,
      }),
    ].join("\n"),
  );
  assert.deepEqual(metadata, {
    versionId: VERSION_ID,
    previewUrl: PREVIEW_URL,
  });

  assert.throws(
    () =>
      parseUploadMetadata(
        JSON.stringify({
          type: "version-upload",
          worker_name: "mons-link",
          version_id: VERSION_ID,
          preview_url: PREVIEW_URL,
        }),
      ),
    /unexpected Worker name/,
  );
  assert.throws(
    () =>
      parseUploadMetadata(
        JSON.stringify({
          type: "version-upload",
          worker_name: "mons-link-api",
          version_id: VERSION_ID,
          preview_url: "https://example.com",
        }),
      ),
    /unexpected version preview URL/,
  );
});

test("validates the exact NFT API response shape", () => {
  assert.doesNotThrow(() =>
    parseNftResponse(JSON.stringify(emptyPayload()), true),
  );
  assert.doesNotThrow(() =>
    parseNftResponse(
      JSON.stringify({
        ok: true,
        specials: [{ id: -1, count: 2 }],
        swagpack_avatars: [],
        swagpack_reactions: [],
      }),
      false,
    ),
  );
  assert.throws(
    () =>
      parseNftResponse(
        JSON.stringify({ ...emptyPayload(), unexpected: true }),
        true,
      ),
    /unexpected shape/,
  );
  assert.throws(
    () =>
      parseNftResponse(
        JSON.stringify({
          ...emptyPayload(),
          specials: [{ id: 1, count: 0 }],
        }),
        false,
      ),
    /unexpected shape/,
  );
  assert.throws(
    () =>
      parseNftResponse(
        JSON.stringify({
          ...emptyPayload(),
          specials: [{ id: 1, count: 1, unexpected: true }],
        }),
        false,
      ),
    /unexpected shape/,
  );
});

test("smokes CORS, empty-wallet, and provider-backed requests with bounded retries", async () => {
  const responses = smokeResponses(2);
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const delays: number[] = [];
  const dependencies = {
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return nextResponse(responses);
    },
    sleep: async (milliseconds: number) => {
      delays.push(milliseconds);
    },
  };

  await smokeApi(PREVIEW_URL, SMOKE_SOL, dependencies);

  assert.equal(requests.length, 4);
  assert.equal(requests[0].url, `${PREVIEW_URL}/nfts`);
  assert.equal(requests[0].init.method, "OPTIONS");
  for (const request of requests) {
    assert.equal(request.init.redirect, "manual");
    assert.ok(request.init.signal instanceof AbortSignal);
    assert.equal(request.url.includes(SMOKE_SOL), false);
  }
  for (const request of requests.slice(1)) {
    assert.equal(
      new Headers(request.init.headers).get("origin"),
      "https://mons.link",
    );
  }
  assert.deepEqual(JSON.parse(String(requests[1].init.body)), {
    sol: "",
    eth: "",
  });
  assert.deepEqual(JSON.parse(String(requests[2].init.body)), {
    sol: SMOKE_SOL,
    eth: "",
  });
  assert.deepEqual(JSON.parse(String(requests[3].init.body)), {
    sol: SMOKE_SOL,
    eth: "",
  });
  assert.deepEqual(delays, [500]);
});

test("rejects redirects without retrying or following them", async () => {
  let redirectBodyCanceled = false;
  const redirectBody = new ReadableStream<Uint8Array>({
    cancel() {
      redirectBodyCanceled = true;
    },
  });
  const responses = [
    new Response(null, { status: 204, headers: responseHeaders() }),
    new Response(redirectBody, {
      status: 307,
      headers: { Location: "https://api.mons.link/nfts" },
    }),
  ];
  const requests: RequestInit[] = [];
  const delays: number[] = [];
  const dependencies = {
    fetch: async (_url: string, init: RequestInit) => {
      requests.push(init);
      return nextResponse(responses);
    },
    sleep: async (milliseconds: number) => {
      delays.push(milliseconds);
    },
  };

  await assert.rejects(
    smokeApi(PREVIEW_URL, SMOKE_SOL, dependencies),
    /Empty-wallet smoke request returned 307/,
  );

  assert.equal(requests.length, 2);
  assert.equal(
    requests.every((request) => request.redirect === "manual"),
    true,
  );
  assert.equal(redirectBodyCanceled, true);
  assert.deepEqual(delays, []);
});

test("retries an expected-success response body transport failure", async () => {
  const responses = [
    new Response(null, { status: 204, headers: responseHeaders() }),
    jsonResponse(emptyPayload()),
    bodyFailureResponse("transient-body-failure"),
    jsonResponse({
      ok: true,
      specials: [{ id: 7, count: 1 }],
      swagpack_avatars: [],
      swagpack_reactions: [],
    }),
  ];
  const requests: RequestInit[] = [];
  const delays: number[] = [];
  const dependencies = {
    fetch: async (_url: string, init: RequestInit) => {
      requests.push(init);
      return nextResponse(responses);
    },
    sleep: async (milliseconds: number) => {
      delays.push(milliseconds);
    },
  };

  await smokeApi(PREVIEW_URL, SMOKE_SOL, dependencies);

  assert.equal(requests.length, 4);
  assert.deepEqual(delays, [500]);
});

test("bounds repeated response body transport failures without leaking details", async () => {
  const bodyDetail = "sensitive-body-transport-detail";
  const responses = [
    new Response(null, { status: 204, headers: responseHeaders() }),
    jsonResponse(emptyPayload()),
    bodyFailureResponse(bodyDetail),
    bodyFailureResponse(bodyDetail),
    bodyFailureResponse(bodyDetail),
  ];
  const delays: number[] = [];
  const dependencies = {
    fetch: async () => {
      return nextResponse(responses);
    },
    sleep: async (milliseconds: number) => {
      delays.push(milliseconds);
    },
  };

  await assert.rejects(
    smokeApi(PREVIEW_URL, SMOKE_SOL, dependencies),
    (error: unknown) =>
      error instanceof Error &&
      /Provider-backed smoke request failed after bounded retries/.test(
        error.message,
      ) &&
      !error.message.includes(bodyDetail),
  );

  assert.deepEqual(delays, [500, 1_500]);
});

test("does not retry semantic response failures", async () => {
  const bodyDetail = "sensitive-invalid-json";
  const responses = [
    new Response(null, { status: 204, headers: responseHeaders() }),
    new Response(bodyDetail, {
      status: 200,
      headers: responseHeaders({ "Content-Type": "application/json" }),
    }),
  ];
  const delays: number[] = [];
  let requests = 0;
  const dependencies = {
    fetch: async () => {
      requests++;
      return nextResponse(responses);
    },
    sleep: async (milliseconds: number) => {
      delays.push(milliseconds);
    },
  };

  await assert.rejects(
    smokeApi(PREVIEW_URL, SMOKE_SOL, dependencies),
    (error: unknown) =>
      error instanceof Error &&
      /response was not valid JSON/.test(error.message) &&
      !error.message.includes(bodyDetail),
  );

  assert.equal(requests, 2);
  assert.deepEqual(delays, []);
});

test("requires wildcard CORS on POST smoke responses", async () => {
  const responses = [
    new Response(null, { status: 204, headers: responseHeaders() }),
    new Response(JSON.stringify(emptyPayload()), {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
    }),
  ];
  const dependencies = {
    fetch: async () => {
      return nextResponse(responses);
    },
    sleep: async () => undefined,
  };

  await assert.rejects(
    smokeApi(PREVIEW_URL, SMOKE_SOL, dependencies),
    /unexpected CORS origin policy/,
  );
});

test("preview validates, uploads with strict mode, sanitizes secrets, and smokes", async () => {
  const files = new Map<string, string>();
  const calls: Array<{
    command: string;
    args: string[];
    environment: RuntimeDependencies["processEnv"];
  }> = [];
  const logs: string[] = [];
  const responses = smokeResponses();
  const dependencies = createRuntimeDependencies({
    processEnv: {
      PATH: "/bin",
      npm_execpath: NPM_CLI_PATH,
      CLOUDFLARE_API_TOKEN: "ambient-token",
      HELIUS_RPC_API_KEY: "helius-secret",
      WRANGLER_LOG_PATH: "/unsafe",
    },
    spawn: (command, args, options) => {
      calls.push({ command, args, environment: { ...options.env } });
      if (
        args[0] === WRANGLER_CLI_PATH &&
        args[1] === "versions" &&
        args[2] === "upload"
      ) {
        files.set(
          String(options.env.WRANGLER_OUTPUT_FILE_PATH),
          JSON.stringify({
            type: "version-upload",
            worker_name: "mons-link-api",
            version_id: VERSION_ID,
            preview_url: PREVIEW_URL,
          }),
        );
      }
      return { status: 0 };
    },
    readFile: (path) => {
      if (path === "/tmp/cloudflare-token") {
        return "file-token\n";
      }
      const contents = files.get(path);
      assert.notEqual(contents, undefined);
      return String(contents);
    },
    unlink: (path: string) => {
      files.delete(path);
    },
    fetch: async () => {
      return nextResponse(responses);
    },
    log: (message: string) => logs.push(message),
  });

  await execute(
    [
      "preview",
      "--smoke-sol",
      SMOKE_SOL,
      "--token-file",
      "/tmp/cloudflare-token",
    ],
    dependencies,
  );

  assert.equal(calls.length, 3);
  assert.equal(calls[0].command, NODE_EXECUTABLE);
  assert.deepEqual(calls[0].args, [NPM_CLI_PATH, "run", "check:api"]);
  assert.equal(calls[0].environment.HELIUS_RPC_API_KEY, undefined);
  assert.equal(calls[0].environment.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(calls[1].command, NODE_EXECUTABLE);
  assert.deepEqual(calls[1].args, [NPM_CLI_PATH, "run", "check:tooling"]);
  assert.equal(calls[1].environment.HELIUS_RPC_API_KEY, undefined);
  assert.equal(calls[1].environment.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(calls[2].command, NODE_EXECUTABLE);
  assert.deepEqual(calls[2].args, [
    WRANGLER_CLI_PATH,
    "versions",
    "upload",
    "--strict",
    "--config",
    "cloud/workers/api/wrangler.jsonc",
    "--env-file",
    WRANGLER_RELEASE_ENV_FILE,
  ]);
  assert.equal(calls[2].environment.CLOUDFLARE_API_TOKEN, "file-token");
  assert.equal(calls[2].environment.HELIUS_RPC_API_KEY, undefined);
  assert.equal(calls[2].environment.CI, "true");
  assert.equal(files.size, 0);
  assert.equal(
    logs.some((message) => message.includes(SMOKE_SOL)),
    false,
  );
  assert.equal(
    logs.some((message) => message.includes("helius-secret")),
    false,
  );
  assert.equal(
    logs.some((message) => message.includes("file-token")),
    false,
  );
});

test("trigger updates use only the selected token in a sanitized environment", async () => {
  const calls: Array<{
    command: string;
    args: string[];
    environment: RuntimeDependencies["processEnv"];
  }> = [];
  const logs: string[] = [];
  let fetchCalled = false;
  const dependencies = createRuntimeDependencies({
    processEnv: {
      PATH: "/bin",
      npm_execpath: NPM_CLI_PATH,
      CLOUDFLARE_API_TOKEN: "ambient-token",
      CLOUDFLARE_API_BASE_URL: "https://modern.invalid",
      CF_API_BASE_URL: "https://legacy.invalid",
      WRANGLER_LOG_PATH: "/unsafe",
      WRANGLER_UNSAFE_VALUE: "unsafe",
      HELIUS_RPC_API_KEY: "helius-secret",
      DOTENV_KEY: "dotenv-vault-key",
    },
    spawn: (command, args, options) => {
      calls.push({ command, args, environment: { ...options.env } });
      return { status: 0 };
    },
    readFile: (path) => {
      assert.equal(path, "/tmp/cloudflare-token");
      return "file-token\n";
    },
    fetch: async () => {
      fetchCalled = true;
      throw new Error("trigger mode must not smoke");
    },
    log: (message: string) => logs.push(message),
  });

  await execute(
    ["triggers", "--token-file", "/tmp/cloudflare-token"],
    dependencies,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, NODE_EXECUTABLE);
  assert.deepEqual(calls[0].args, [
    WRANGLER_CLI_PATH,
    "triggers",
    "deploy",
    "--config",
    "cloud/workers/api/wrangler.jsonc",
    "--env-file",
    WRANGLER_RELEASE_ENV_FILE,
  ]);
  assert.equal(calls[0].environment.CLOUDFLARE_API_TOKEN, "file-token");
  assert.deepEqual(
    Object.keys(calls[0].environment).filter((name) => {
      const normalized = name.toUpperCase();
      return (
        normalized.startsWith("CF_") || normalized.startsWith("CLOUDFLARE_")
      );
    }),
    ["CLOUDFLARE_API_TOKEN"],
  );
  assert.equal(calls[0].environment.CLOUDFLARE_API_BASE_URL, undefined);
  assert.equal(calls[0].environment.CF_API_BASE_URL, undefined);
  assert.equal(calls[0].environment.WRANGLER_UNSAFE_VALUE, undefined);
  assert.equal(
    calls[0].environment.WRANGLER_LOG_PATH,
    "/workspace/.cache/wrangler-logs",
  );
  assert.equal(calls[0].environment.HELIUS_RPC_API_KEY, undefined);
  assert.equal(calls[0].environment.DOTENV_KEY, undefined);
  assert.equal(fetchCalled, false);
  for (const sensitiveValue of [
    "ambient-token",
    "https://modern.invalid",
    "https://legacy.invalid",
    "unsafe",
    "helius-secret",
    "dotenv-vault-key",
    "file-token",
  ]) {
    assert.equal(
      logs.some((message) => message.includes(sensitiveValue)),
      false,
    );
  }
});

test("production promotes only the explicit version and then smokes the custom domain", async () => {
  const calls: Array<{
    command: string;
    args: string[];
    environment: RuntimeDependencies["processEnv"];
  }> = [];
  const logs: string[] = [];
  const responses = smokeResponses();
  const dependencies = createRuntimeDependencies({
    processEnv: {
      PATH: "/bin",
      npm_execpath: NPM_CLI_PATH,
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      HELIUS_RPC_API_KEY: "helius-secret",
    },
    spawn: (command, args, options) => {
      calls.push({ command, args, environment: { ...options.env } });
      return { status: 0 };
    },
    fetch: async (url) => {
      assert.equal(url, "https://api.mons.link/nfts");
      return nextResponse(responses);
    },
    log: (message: string) => logs.push(message),
  });

  await execute(
    ["production", "--version-id", VERSION_ID, "--smoke-sol", SMOKE_SOL],
    dependencies,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, NODE_EXECUTABLE);
  assert.deepEqual(calls[0].args, [
    WRANGLER_CLI_PATH,
    "versions",
    "deploy",
    "--version-id",
    VERSION_ID,
    "--percentage",
    "100",
    "--yes",
    "--config",
    "cloud/workers/api/wrangler.jsonc",
    "--env-file",
    WRANGLER_RELEASE_ENV_FILE,
  ]);
  assert.equal(calls[0].environment.CLOUDFLARE_API_TOKEN, "cloudflare-token");
  assert.equal(calls[0].environment.HELIUS_RPC_API_KEY, undefined);
  assert.equal(
    logs.some((message) => message.includes(SMOKE_SOL)),
    false,
  );
  assert.equal(
    logs.some((message) => message.includes("helius-secret")),
    false,
  );
  assert.equal(
    logs.some((message) => message.includes("cloudflare-token")),
    false,
  );
});

test("reports when production promotion succeeded but live smoke failed", async () => {
  const dependencies = createRuntimeDependencies({
    fetch: async () => jsonResponse({ ok: false }, 400),
  });

  await assert.rejects(
    execute(
      ["production", "--version-id", VERSION_ID, "--smoke-sol", SMOKE_SOL],
      dependencies,
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "DeployError" &&
      /Production deployment completed, but production smoke checks failed/.test(
        error.message,
      ),
  );
});
