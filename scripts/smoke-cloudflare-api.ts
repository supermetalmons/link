const { randomBytes } = require("node:crypto");
const {
  isExactNftApiResponse,
}: typeof import("@mons/shared/nfts") = require("@mons/shared/nfts");

const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const ORIGIN = "https://mons.link";
const PREVIEW_HOST_PATTERN =
  /^[0-9a-f]{8}-mons-link-api\.lil-org\.workers\.dev$/;

type Options = {
  baseUrl: string;
  smokeSol: string;
};
type Dependencies = {
  fetch: typeof fetch;
  randomState: () => string;
  log: (message: string) => void;
};

function usage(): string {
  return "Usage: npm run smoke:api -- --base-url <https-url> --smoke-sol <wallet>";
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(usage());
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.hostname !== "api.mons.link" &&
      !PREVIEW_HOST_PATTERN.test(url.hostname))
  ) {
    throw new TypeError(usage());
  }
  return url.origin;
}

function parseArgs(argv: string[]): Options {
  let baseUrl = "";
  let smokeSol = "";
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      (name !== "--base-url" && name !== "--smoke-sol") ||
      !value ||
      value.startsWith("--")
    ) {
      throw new TypeError(usage());
    }
    index += 1;
    if (name === "--base-url") {
      if (baseUrl) throw new TypeError(usage());
      baseUrl = normalizeBaseUrl(value);
    } else {
      if (smokeSol) throw new TypeError(usage());
      smokeSol = value.trim();
    }
  }
  if (!baseUrl || !smokeSol) {
    throw new TypeError(usage());
  }
  return { baseUrl, smokeSol };
}

async function readBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Smoke response was too large.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        throw new Error("Smoke response was too large.");
      }
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

function assertNoStore(response: Response): void {
  const values = (response.headers.get("Cache-Control") || "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim());
  if (!values.includes("no-store")) {
    throw new Error("Smoke response was cacheable.");
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Smoke response was not JSON.");
  }
}

async function request(
  url: string,
  init: RequestInit,
  expectedStatus: number,
  dependencies: Dependencies,
): Promise<{ response: Response; body: string }> {
  const response = await dependencies.fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await readBody(response);
  if (response.status !== expectedStatus) {
    throw new Error(`Smoke request returned ${response.status}.`);
  }
  assertNoStore(response);
  return { response, body };
}

async function smokeApi(
  options: Options,
  dependencies: Dependencies = {
    fetch,
    randomState: () => randomBytes(18).toString("base64url"),
    log: console.log,
  },
): Promise<void> {
  const nftUrl = `${options.baseUrl}/nfts`;
  const preflight = await request(
    nftUrl,
    {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    },
    204,
    dependencies,
  );
  if (preflight.response.headers.get("Access-Control-Allow-Origin") !== "*") {
    throw new Error("NFT CORS smoke failed.");
  }
  for (const [sol, requireEmpty] of [
    ["", true],
    [options.smokeSol, false],
  ] as const) {
    const result = await request(
      nftUrl,
      {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ sol, eth: "" }),
      },
      200,
      dependencies,
    );
    const payload = parseJson(result.body);
    if (!isExactNftApiResponse(payload)) {
      throw new Error("NFT smoke response was invalid.");
    }
    if (
      requireEmpty &&
      (payload.specials.length > 0 ||
        payload.swagpack_avatars.length > 0 ||
        payload.swagpack_reactions.length > 0)
    ) {
      throw new Error("Empty-wallet smoke returned NFTs.");
    }
  }

  const authUrl = `${options.baseUrl}/auth/intents`;
  const authPreflight = await request(
    authUrl,
    {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization, Content-Type",
      },
    },
    204,
    dependencies,
  );
  if (
    authPreflight.response.headers.get("Access-Control-Allow-Origin") !== ORIGIN
  ) {
    throw new Error("Auth CORS smoke failed.");
  }
  const auth = await request(
    authUrl,
    {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: "{}",
    },
    401,
    dependencies,
  );
  const authPayload = parseJson(auth.body);
  if (
    !authPayload ||
    typeof authPayload !== "object" ||
    Array.isArray(authPayload) ||
    (authPayload as { error?: unknown }).error !== "unauthenticated"
  ) {
    throw new Error("Auth smoke response was invalid.");
  }

  for (const path of [
    "/invites/create",
    "/invites/join",
    "/matches/ensure",
    "/navigation/games/read",
    "/rematches/propose",
    "/rematches/end",
    "/events/create",
    "/events/start/postpone",
    "/events/matches/winners/disqualify",
    "/events/prize-selections/toggle",
    "/events/state/sync",
    "/profiles/custom",
  ]) {
    const eventRoute = await request(
      `${options.baseUrl}${path}`,
      {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: "{}",
      },
      401,
      dependencies,
    );
    const eventPayload = parseJson(eventRoute.body);
    if (
      !eventPayload ||
      typeof eventPayload !== "object" ||
      Array.isArray(eventPayload) ||
      (eventPayload as { error?: unknown }).error !== "unauthenticated"
    ) {
      throw new Error("Authenticated route smoke response was invalid.");
    }
  }

  const callbackUrl = `${options.baseUrl}/auth/x/callback`;
  await request(callbackUrl, { method: "GET" }, 400, dependencies);
  const state = dependencies.randomState();
  if (!/^[A-Za-z0-9_-]{24}$/.test(state)) {
    throw new Error("Smoke state was invalid.");
  }
  await request(
    `${callbackUrl}?state=${encodeURIComponent(state)}`,
    { method: "GET" },
    400,
    dependencies,
  );

  const internal = await request(
    `${options.baseUrl}/internal/telegram/delivery`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
    401,
    dependencies,
  );
  const internalPayload = parseJson(internal.body);
  if (
    !internalPayload ||
    typeof internalPayload !== "object" ||
    Array.isArray(internalPayload) ||
    (internalPayload as { error?: unknown }).error !== "unauthenticated"
  ) {
    throw new Error("Internal route smoke response was invalid.");
  }
  dependencies.log(`[api-smoke] Passed ${options.baseUrl}`);
}

if (require.main === module) {
  smokeApi(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "API smoke failed.");
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, smokeApi };
