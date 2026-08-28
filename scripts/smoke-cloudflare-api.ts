const { randomBytes } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const {
  isExactNftApiResponse,
}: typeof import("@mons/shared/nfts") = require("@mons/shared/nfts");
const {
  isLeaderboardReadResponse,
  isProfileLookupResponse,
}: typeof import("@mons/shared/profiles") = require("@mons/shared/profiles");

const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const ORIGIN = "https://mons.link";
const FIREBASE_API_KEY = "AIzaSyC8Ihr4kDd34z-RXe8XTBCFtFbXebifo5Y";
const FIREBASE_IDENTITY_ROOT = "https://identitytoolkit.googleapis.com/v1";
const PREVIEW_HOST_PATTERN =
  /^[0-9a-f]{8}-mons-link-api\.lil-org\.workers\.dev$/;

type Options = {
  baseUrl: string;
  smokeProfile: ProfileSmokeFixture;
  smokeSol: string;
};
type ProfileSmokeFixture = {
  loginId: string;
  profileId: string;
};
type Dependencies = {
  fetch: typeof fetch;
  randomState: () => string;
  log: (message: string) => void;
};

function usage(): string {
  return "Usage: npm run smoke:api -- --base-url <https-url> --smoke-sol <wallet> --smoke-profile-fixture <protected-json-file>";
}

function readProfileSmokeFixture(path: string): ProfileSmokeFixture {
  let value: unknown;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 4_096 || (stat.mode & 0o077) !== 0) {
      throw new Error("invalid-profile-smoke-fixture");
    }
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new TypeError(usage());
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(usage());
  }
  const fields = value as Record<string, unknown>;
  const loginId = typeof fields.loginId === "string" ? fields.loginId : "";
  const profileId =
    typeof fields.profileId === "string" ? fields.profileId : "";
  const loginCharacters = Array.from(loginId);
  const invalidControl = [...loginCharacters, ...Array.from(profileId)].some(
    (character) => {
      const code = character.codePointAt(0) || 0;
      return code <= 0x1f || code === 0x7f;
    },
  );
  if (
    Object.keys(fields).length !== 2 ||
    !loginId ||
    loginId !== loginId.trim() ||
    loginCharacters.length > 128 ||
    !profileId ||
    profileId !== profileId.trim() ||
    new TextEncoder().encode(profileId).byteLength > 1_500 ||
    profileId.includes("/") ||
    profileId === "." ||
    profileId === ".." ||
    invalidControl
  ) {
    throw new TypeError(usage());
  }
  return { loginId, profileId };
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
  let smokeProfile: ProfileSmokeFixture | null = null;
  let smokeSol = "";
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      (name !== "--base-url" &&
        name !== "--smoke-sol" &&
        name !== "--smoke-profile-fixture") ||
      !value ||
      value.startsWith("--")
    ) {
      throw new TypeError(usage());
    }
    index += 1;
    if (name === "--base-url") {
      if (baseUrl) throw new TypeError(usage());
      baseUrl = normalizeBaseUrl(value);
    } else if (name === "--smoke-sol") {
      if (smokeSol) throw new TypeError(usage());
      smokeSol = value.trim();
    } else {
      if (smokeProfile) throw new TypeError(usage());
      smokeProfile = readProfileSmokeFixture(value);
    }
  }
  if (!baseUrl || !smokeSol || !smokeProfile) {
    throw new TypeError(usage());
  }
  return { baseUrl, smokeProfile, smokeSol };
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

async function firebaseIdentityRequest(
  operation: "accounts:delete" | "accounts:signUp",
  body: Record<string, unknown>,
  dependencies: Dependencies,
): Promise<Record<string, unknown>> {
  const url = new URL(`${FIREBASE_IDENTITY_ROOT}/${operation}`);
  url.searchParams.set("key", FIREBASE_API_KEY);
  const response = await dependencies.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
    },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const responseBody = await readBody(response);
  if (response.status !== 200) {
    throw new Error(
      `Firebase anonymous smoke session returned ${response.status}.`,
    );
  }
  const payload = parseJson(responseBody);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Firebase anonymous smoke response was invalid.");
  }
  return payload as Record<string, unknown>;
}

async function smokeAuthenticatedAuthState(
  baseUrl: string,
  smokeProfile: ProfileSmokeFixture,
  dependencies: Dependencies,
): Promise<void> {
  const session = await firebaseIdentityRequest(
    "accounts:signUp",
    { returnSecureToken: true },
    dependencies,
  );
  const idToken =
    typeof session.idToken === "string" ? session.idToken.trim() : "";
  const localId =
    typeof session.localId === "string" ? session.localId.trim() : "";
  if (!idToken) {
    throw new Error("Firebase anonymous smoke response was incomplete.");
  }
  try {
    if (!localId) {
      throw new Error("Firebase anonymous smoke response was incomplete.");
    }
    const headers = {
      Authorization: `Bearer ${idToken}`,
      Origin: ORIGIN,
      "Content-Type": "application/json",
    };
    const intent = await request(
      `${baseUrl}/auth/intents`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ method: "x" }),
      },
      200,
      dependencies,
    );
    const intentPayload = parseJson(intent.body) as Record<string, unknown>;
    const intentId =
      typeof intentPayload?.intentId === "string" ? intentPayload.intentId : "";
    if (
      intentPayload?.ok !== true ||
      !/^[A-Za-z0-9_-]{24}$/.test(intentId) ||
      !Number.isSafeInteger(intentPayload.expiresAtMs)
    ) {
      throw new Error("Authenticated auth-intent smoke response was invalid.");
    }
    const flow = await request(
      `${baseUrl}/auth/x/flows`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          consentSource: "signin",
          intentId,
          returnUrl: "https://mons.link/",
        }),
      },
      200,
      dependencies,
    );
    const flowPayload = parseJson(flow.body) as Record<string, unknown>;
    const flowId =
      typeof flowPayload?.flowId === "string" ? flowPayload.flowId : "";
    let authUrl: URL;
    try {
      authUrl = new URL(String(flowPayload?.authUrl || ""));
    } catch {
      throw new Error("Authenticated X-flow smoke response was invalid.");
    }
    if (
      flowPayload?.ok !== true ||
      !/^[A-Za-z0-9_-]{24}$/.test(flowId) ||
      authUrl.origin !== "https://x.com" ||
      authUrl.searchParams.get("state") !== flowId
    ) {
      throw new Error("Authenticated X-flow smoke response was invalid.");
    }
    let lookupProfileId = "";
    for (const type of [
      "rating",
      "mp",
      "dust",
      "slime",
      "gum",
      "metal",
      "ice",
    ] as const) {
      const leaderboard = await request(
        `${baseUrl}/leaderboards/read`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ type }),
        },
        200,
        dependencies,
      );
      const leaderboardPayload = parseJson(leaderboard.body);
      if (!isLeaderboardReadResponse(leaderboardPayload)) {
        throw new Error("Profile leaderboard smoke response was invalid.");
      }
      if (type === "rating") {
        lookupProfileId = leaderboardPayload.profiles[0]?.id || "";
      }
    }
    if (!lookupProfileId) {
      throw new Error("Profile leaderboard smoke returned no profiles.");
    }
    const profileLookup = await request(
      `${baseUrl}/profiles/lookup`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "profile", id: lookupProfileId }),
      },
      200,
      dependencies,
    );
    const profileLookupPayload = parseJson(profileLookup.body);
    if (
      !isProfileLookupResponse(profileLookupPayload) ||
      profileLookupPayload.profile?.id !== lookupProfileId
    ) {
      throw new Error("Profile ID lookup smoke response was invalid.");
    }
    const loginLookup = await request(
      `${baseUrl}/profiles/lookup`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ kind: "login", id: smokeProfile.loginId }),
      },
      200,
      dependencies,
    );
    const loginLookupPayload = parseJson(loginLookup.body);
    if (
      !isProfileLookupResponse(loginLookupPayload) ||
      loginLookupPayload.profile?.id !== smokeProfile.profileId
    ) {
      throw new Error("Profile login lookup smoke response was invalid.");
    }
  } finally {
    await firebaseIdentityRequest("accounts:delete", { idToken }, dependencies);
  }
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
  await smokeAuthenticatedAuthState(
    options.baseUrl,
    options.smokeProfile,
    dependencies,
  );

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
    "/events/prizes/withdrawals",
    "/events/prizes/withdrawals/status",
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

module.exports = {
  parseArgs,
  readProfileSmokeFixture,
  smokeApi,
  smokeAuthenticatedAuthState,
};
