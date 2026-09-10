import {
  createSessionRequest,
  createToolSession,
  refreshToolSession,
} from "./cloudflare/sessions.ts";
import type { SessionCreateRequest } from "@mons/shared/session-auth";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { WebSocket } from "ws";
import {
  isAuthIntentResponse,
  isAuthProfileResponse,
  isLinkedAuthMethodsResponse,
} from "@mons/shared/auth";
import { INVITE_ID_RANDOM_LENGTH, isSafeFirebaseKey } from "@mons/shared/ids";
import {
  isCreateInviteResponse,
  isJoinInviteResponse,
  isGameSessionMatch,
  isSurrenderMatchResponse,
  type GameSessionMatch,
} from "@mons/shared/game-sessions";
import {
  INVITE_WAGERS_MAX_MESSAGE_BYTES,
  INVITE_WAGERS_SOCKET_PROTOCOL,
  isInviteWagersMessage,
  isInviteWagersSnapshot,
  isReadInviteWagersResponse,
  type InviteWagersSnapshot,
} from "@mons/shared/invite-wagers";
import { isReadInviteMetadataResponse } from "@mons/shared/invite-metadata";
import {
  createEmptyMaterials,
  createFirstRockDrops,
  formatMiningDateUtc,
  isMineRockResponse,
  type MiningSnapshot,
} from "@mons/shared/mining";
import { isProfileLookupResponse } from "@mons/shared/profiles";
import {
  REACTION_AUTH_PROTOCOL_PREFIX,
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
  isReactionSocketToken,
} from "@mons/shared/reactions";
import {
  WAGER_STORAGE_VERSION,
  WAGER_STORAGE_VERSION_HEADER,
  isWagerFrozenReadResponse,
  isWagerOutcomeResolveResponse,
  isWagerProposalAcceptResponse,
  isWagerProposalRemovalResponse,
  isWagerProposalSendResponse,
} from "@mons/shared/wagers";

const ORIGIN = "https://mons.link";
const API_ROOT = "https://api.mons.link";
const FIREBASE_DATABASE_ROOT = "https://mons-link-default-rtdb.firebaseio.com";
const REQUEST_TIMEOUT_MS = 30_000;
const SOCKET_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_MARGIN_MS = 30_000;
const MAX_HTTP_BYTES = 1024 * 1024;
const MAX_FIXTURE_BYTES = 256 * 1024;
const SCENARIOS = ["cancel", "decline", "settle"] as const;
type Scenario = (typeof SCENARIOS)[number];
type Role = "host" | "guest";
type Mode =
  "prepare-fixtures" | "frozen-read" | "active-lifecycle" | "read-only";
type Options = {
  baseUrl: string;
  mode: Mode;
  fixture?: string;
  inviteId?: string;
  authTokenFixture?: string;
};
type Actor = {
  seed: string;
  uid?: string;
  accessToken?: string;
  accessExpiresAtMs?: number;
  refreshToken?: string;
  sessionId?: string;
  sessionCreation?: SessionCreateRequest;
  revokeToken?: string;
  profileId?: string;
  miningDate?: string;
};
type Invite = {
  id: string;
  createOperationId: string;
  joinOperationId: string;
};
type Fixture = {
  version: 2;
  purpose: "mons-wager-smoke";
  baseUrl: string;
  runId: string;
  miningDate: string;
  stage: "preparing" | "prepared" | "active" | "complete";
  actors: Record<Role, Actor>;
  invites: Record<Scenario, Invite>;
  steps: string[];
  preparedSnapshots: Partial<Record<Scenario, InviteWagersSnapshot>>;
};
type Dependencies = {
  fetch: typeof fetch;
  connect: (
    url: string,
    protocols: string[],
    options: import("ws").ClientOptions,
  ) => WebSocket;
  now: () => number;
  log: (message: string) => void;
  saveFixture?: () => void;
};

function fail(message: string): never {
  throw new Error(`[wager-smoke] ${message}`);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = record(value);
  return object
    ? `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
        .join(",")}}`
    : JSON.stringify(value);
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (canonical(actual) !== canonical(expected))
    fail(`${label} did not match.`);
}

function isStoredMatch(
  value: unknown,
): value is GameSessionMatch & { sessionCreation?: string } {
  const stored = record(value);
  if (!stored) return false;
  const { sessionCreation, ...match } = stored;
  return (
    isGameSessionMatch(match) &&
    (sessionCreation === undefined ||
      (typeof sessionCreation === "string" &&
        /^[a-f0-9]{64}$/.test(sessionCreation)))
  );
}

function usage(): never {
  fail(
    "Usage: node --experimental-strip-types scripts/smoke-cloudflare-wagers.ts --base-url https://api.mons.link (--prepare-fixtures | --frozen-read | --active-lifecycle) --fixture /secure/wager-smoke.json; or --read-only --invite-id ID [--auth-token-fixture /secure/auth.json].",
  );
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  let mode: Mode | undefined;
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (
      [
        "--prepare-fixtures",
        "--frozen-read",
        "--active-lifecycle",
        "--read-only",
      ].includes(key)
    ) {
      if (mode) usage();
      mode = key.slice(2) as Mode;
    } else {
      const value = argv[++index];
      if (
        ![
          "--base-url",
          "--fixture",
          "--invite-id",
          "--auth-token-fixture",
        ].includes(key) ||
        !value ||
        value.startsWith("--") ||
        values.has(key)
      )
        usage();
      values.set(key, value);
    }
  }
  if (!mode || values.get("--base-url") !== API_ROOT) usage();
  const fixture = values.get("--fixture");
  const inviteId = values.get("--invite-id");
  const authTokenFixture = values.get("--auth-token-fixture");
  if (mode === "read-only") {
    if (
      fixture ||
      !isSafeFirebaseKey(inviteId) ||
      (authTokenFixture && !isAbsolute(authTokenFixture))
    )
      usage();
  } else if (!fixture || !isAbsolute(fixture) || inviteId || authTokenFixture)
    usage();
  return { baseUrl: API_ROOT, mode, fixture, inviteId, authTokenFixture };
}

function readProtectedJson(path: string): unknown {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > MAX_FIXTURE_BYTES
  )
    fail("Fixture must be a protected regular file with mode 0600.");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    fail("Fixture JSON is invalid.");
  }
}

function readFixture(path: string): Fixture {
  const value = readProtectedJson(path);
  const input = record(value);
  const actors = record(input?.actors);
  const invites = record(input?.invites);
  if (
    input?.version !== 2 ||
    input.purpose !== "mons-wager-smoke" ||
    input.baseUrl !== API_ROOT ||
    typeof input.runId !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(String(input.miningDate)) ||
    !["preparing", "prepared", "active", "complete"].includes(
      String(input.stage),
    ) ||
    !Array.isArray(input.steps) ||
    !input.steps.every((step) => typeof step === "string") ||
    !record(input.preparedSnapshots)
  )
    fail("Fixture schema is invalid.");
  for (const role of ["host", "guest"] as const) {
    const actor = record(actors?.[role]);
    if (
      !actor ||
      typeof actor.seed !== "string" ||
      Buffer.from(actor.seed, "base64").length !== 32
    )
      fail("Fixture actor is invalid.");
    for (const key of ["uid", "profileId"])
      if (actor[key] !== undefined && !isSafeFirebaseKey(actor[key]))
        fail("Fixture identity is invalid.");
    if (
      actor.accessToken !== undefined &&
      !isReactionSocketToken(actor.accessToken)
    )
      fail("Fixture token is invalid.");
    if (
      actor.accessExpiresAtMs !== undefined &&
      (!Number.isSafeInteger(actor.accessExpiresAtMs) ||
        Number(actor.accessExpiresAtMs) <= 0)
    )
      fail("Fixture token expiry is invalid.");
    if (
      actor.miningDate !== undefined &&
      (typeof actor.miningDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(actor.miningDate))
    )
      fail("Fixture funding date is invalid.");
    if (
      actor.refreshToken !== undefined &&
      (typeof actor.refreshToken !== "string" ||
        !actor.refreshToken ||
        actor.refreshToken.length > 16_000)
    )
      fail("Fixture refresh token is invalid.");
  }
  for (const scenario of SCENARIOS) {
    const invite = record(invites?.[scenario]);
    if (
      !invite ||
      !new RegExp(`^[A-Za-z0-9]{${INVITE_ID_RANDOM_LENGTH}}$`).test(
        String(invite.id),
      ) ||
      ![invite.createOperationId, invite.joinOperationId].every(
        (id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id),
      )
    )
      fail("Fixture invite is invalid.");
  }
  const fixture = value as Fixture;
  if (
    new Set(SCENARIOS.map((scenario) => fixture.invites[scenario].id)).size !==
    3
  )
    fail("Fixture invites must be distinct.");
  if (
    fixture.actors.host.uid &&
    fixture.actors.host.uid === fixture.actors.guest.uid
  )
    fail("Fixture actors must be distinct.");
  if (
    fixture.actors.host.profileId &&
    fixture.actors.host.profileId === fixture.actors.guest.profileId
  )
    fail("Fixture profiles must be distinct.");
  return fixture;
}

function saveFixture(path: string, fixture: Fixture): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(fixture, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function createFixture(now: number): Fixture {
  const invite = (): Invite => ({
    id: `Sm${randomBytes(INVITE_ID_RANDOM_LENGTH)
      .toString("hex")
      .slice(0, INVITE_ID_RANDOM_LENGTH - 2)}`,
    createOperationId: randomUUID(),
    joinOperationId: randomUUID(),
  });
  return {
    version: 2,
    purpose: "mons-wager-smoke",
    baseUrl: API_ROOT,
    runId: randomUUID(),
    miningDate: formatMiningDateUtc(new Date(now)),
    stage: "preparing",
    actors: {
      host: { seed: randomBytes(32).toString("base64") },
      guest: { seed: randomBytes(32).toString("base64") },
    },
    invites: { cancel: invite(), decline: invite(), settle: invite() },
    steps: [],
    preparedSnapshots: {},
  };
}

async function requestJson(
  dependencies: Dependencies,
  label: string,
  url: string,
  init: RequestInit = {},
  maxBytes = MAX_HTTP_BYTES,
  allowMissing = false,
): Promise<unknown> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await dependencies.fetch(url, {
      ...init,
      redirect: "error",
      cache: "no-store",
      signal,
    });
  } catch {
    fail(
      `${label} request failed; inspect state before rerunning the same fixture.`,
    );
  }
  if (allowMissing && response.status === 404) {
    void response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get("Content-Length")) > maxBytes
  ) {
    void response.body?.cancel().catch(() => undefined);
    fail(`${label} returned HTTP ${response.status}.`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const result = await reader.read();
      if (signal.aborted) throw new Error();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) throw new Error();
      chunks.push(result.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } catch {
    cancel();
    fail(`${label} returned invalid or oversized JSON.`);
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function refreshActor(
  actor: Actor,
  save: () => void,
  dependencies: Dependencies,
): Promise<void> {
  if (!actor.uid || !actor.refreshToken || !actor.sessionId)
    fail("Fixture preparation is incomplete.");
  const result = await refreshToolSession(
    API_ROOT,
    {
      uid: actor.uid,
      sessionId: actor.sessionId,
      refreshToken: actor.refreshToken,
    },
    dependencies.fetch,
  );
  actor.accessToken = result.accessToken;
  actor.accessExpiresAtMs = result.accessExpiresAtMs;
  save();
}

async function accessToken(
  authentication: Actor | string | undefined,
  dependencies: Dependencies,
): Promise<string | undefined> {
  if (typeof authentication !== "object") return authentication;
  if (
    !authentication.accessToken ||
    authentication.accessExpiresAtMs === undefined ||
    authentication.accessExpiresAtMs <=
      dependencies.now() + TOKEN_REFRESH_MARGIN_MS
  )
    await refreshActor(
      authentication,
      dependencies.saveFixture || (() => undefined),
      dependencies,
    );
  return authentication.accessToken;
}

async function api(
  dependencies: Dependencies,
  path: string,
  authentication?: Actor | string,
  body?: unknown,
  allowMissing = false,
): Promise<unknown> {
  const token = await accessToken(authentication, dependencies);
  return requestJson(
    dependencies,
    `API ${path}`,
    `${API_ROOT}${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: ORIGIN,
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(path.startsWith("/wagers/")
          ? { [WAGER_STORAGE_VERSION_HEADER]: WAGER_STORAGE_VERSION }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    path.includes("/wagers") ? INVITE_WAGERS_MAX_MESSAGE_BYTES : MAX_HTTP_BYTES,
    allowMissing,
  );
}

async function readMining(
  actor: Actor,
  dependencies: Dependencies,
): Promise<MiningSnapshot> {
  if (!actor.uid || !actor.profileId || !actor.accessToken)
    fail("Fixture actor is not prepared.");
  const result = await api(dependencies, "/profiles/lookup", actor, {
    kind: "login",
    id: actor.uid,
  });
  const key = nacl.sign.keyPair.fromSeed(Buffer.from(actor.seed, "base64"));
  if (
    !isProfileLookupResponse(result) ||
    result.profile?.id !== actor.profileId ||
    result.profile.sol !== bs58.encode(key.publicKey)
  )
    fail("Fixture profile ownership did not match its generated wallet.");
  return result.profile.mining;
}

async function prepareActor(
  actor: Actor,
  fixture: Fixture,
  save: () => void,
  dependencies: Dependencies,
): Promise<void> {
  if (!actor.uid) {
    actor.sessionCreation ||= createSessionRequest();
    save();
    const session = await createToolSession(
      API_ROOT,
      dependencies.fetch,
      actor.sessionCreation,
    );
    actor.uid = session.uid;
    actor.sessionId = session.sessionId;
    actor.accessToken = session.accessToken;
    actor.accessExpiresAtMs = session.accessExpiresAtMs;
    actor.refreshToken = session.refreshToken;
    actor.revokeToken = session.revokeToken;
    delete actor.sessionCreation;
    save();
  } else await refreshActor(actor, save, dependencies);
  if (!actor.profileId) {
    const methods = await api(dependencies, "/auth/methods", actor);
    if (!isLinkedAuthMethodsResponse(methods))
      fail("Auth-method response was invalid.");
    if (methods.profileId) actor.profileId = methods.profileId;
    else {
      const intent = await api(dependencies, "/auth/intents", actor, {
        method: "sol",
      });
      if (!isAuthIntentResponse(intent)) fail("Solana intent was invalid.");
      const key = nacl.sign.keyPair.fromSeed(Buffer.from(actor.seed, "base64"));
      const signature = nacl.sign.detached(
        new TextEncoder().encode(
          `Sign in mons.link with Solana nonce ${intent.nonce}`,
        ),
        key.secretKey,
      );
      const linked = await api(
        dependencies,
        "/auth/methods/sol/verify",
        actor,
        {
          intentId: intent.intentId,
          address: bs58.encode(key.publicKey),
          signature: Buffer.from(signature).toString("base64"),
          emoji: 1,
          aura: "",
        },
      );
      if (
        !isAuthProfileResponse(linked) ||
        linked.uid !== actor.uid ||
        linked.sol !== bs58.encode(key.publicKey)
      )
        fail("Solana test-profile creation was invalid.");
      actor.profileId = linked.profileId;
    }
    save();
    await refreshActor(actor, save, dependencies);
  }
  const mining = await readMining(actor, dependencies);
  if (mining.lastRockDate === null) {
    equal(mining.materials, createEmptyMaterials(), "New profile balance");
    actor.miningDate = formatMiningDateUtc(new Date(dependencies.now()));
    save();
    const mined = await api(dependencies, "/mining/rock", actor, {
      date: actor.miningDate,
      materials: createFirstRockDrops().delta,
    });
    if (!isMineRockResponse(mined) || !mined.ok)
      fail("First-rock funding failed.");
  }
  const funded = await readMining(actor, dependencies);
  equal(
    funded,
    {
      lastRockDate: actor.miningDate ?? fixture.miningDate,
      materials: { ...createEmptyMaterials(), dust: 1 },
    },
    "First-rock funding",
  );
  if (!actor.miningDate) {
    actor.miningDate = funded.lastRockDate!;
    save();
  }
}

async function readSnapshot(
  inviteId: string,
  token: Actor | string | undefined,
  dependencies: Dependencies,
): Promise<InviteWagersSnapshot> {
  const result = await api(
    dependencies,
    `/invites/${encodeURIComponent(inviteId)}/wagers`,
    token,
  );
  if (
    !isReadInviteWagersResponse(result) ||
    result.snapshot.inviteId !== inviteId
  )
    fail("Wager HTTP snapshot was invalid.");
  return result.snapshot;
}

function openSocket(
  inviteId: string,
  token: string | undefined,
  dependencies: Dependencies,
  expiresAtMs?: number,
  previous?: InviteWagersSnapshot,
) {
  const socket = dependencies.connect(
    `${API_ROOT.replace("https:", "wss:")}/invites/${encodeURIComponent(inviteId)}/wagers/socket`,
    [
      INVITE_WAGERS_SOCKET_PROTOCOL,
      ...(token ? [`${REACTION_AUTH_PROTOCOL_PREFIX}${token}`] : []),
    ],
    {
      origin: ORIGIN,
      followRedirects: false,
      handshakeTimeout: SOCKET_TIMEOUT_MS,
      maxPayload: INVITE_WAGERS_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    },
  );
  let latest: InviteWagersSnapshot | undefined;
  let heartbeat = false;
  let error: Error | undefined;
  const changed = new Set<() => void>();
  const notify = () => {
    for (const listener of [...changed]) listener();
  };
  const stop = () => {
    socket.removeAllListeners();
    socket.on("error", () => undefined);
    socket.terminate();
  };
  const invalid = (message: string) => {
    error = new Error(`[wager-smoke] ${message}`);
    notify();
    stop();
  };
  socket.on("error", () => invalid("Wager WebSocket failed."));
  socket.on("close", (code) => {
    if (
      code === 4001 &&
      expiresAtMs !== undefined &&
      expiresAtMs <= dependencies.now()
    )
      return;
    invalid("Wager WebSocket closed before completion.");
  });
  socket.on("unexpected-response", (_request, response) => {
    response.destroy();
    invalid(`Wager WebSocket returned HTTP ${response.statusCode}.`);
  });
  socket.on("message", (data, binary) => {
    try {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
      if (
        binary ||
        bytes.length > INVITE_WAGERS_MAX_MESSAGE_BYTES ||
        socket.protocol !== INVITE_WAGERS_SOCKET_PROTOCOL
      )
        throw new Error();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text === REACTION_HEARTBEAT_RESPONSE && latest) {
        heartbeat = true;
        notify();
        return;
      }
      const frame: unknown = JSON.parse(text);
      const baseline = latest ?? previous;
      if (
        !isInviteWagersMessage(frame) ||
        frame.snapshot.inviteId !== inviteId ||
        (baseline && frame.snapshot.revision < baseline.revision)
      )
        throw new Error();
      if (baseline && frame.snapshot.revision === baseline.revision)
        equal(frame.snapshot, baseline, "Same-revision WebSocket snapshot");
      const initial = !latest;
      latest = frame.snapshot;
      notify();
      if (initial)
        socket.send(REACTION_HEARTBEAT_REQUEST, (failure) => {
          if (failure) invalid("Wager WebSocket heartbeat failed.");
        });
    } catch {
      invalid("Wager WebSocket frame was invalid.");
    }
  });
  const wait = (
    predicate: (snapshot: InviteWagersSnapshot) => boolean,
    requireHeartbeat = false,
  ): Promise<InviteWagersSnapshot> =>
    new Promise((resolve, reject) => {
      const finish = () => {
        if (
          !error &&
          (!latest || !predicate(latest) || (requireHeartbeat && !heartbeat))
        )
          return;
        clearTimeout(timer);
        changed.delete(finish);
        if (error) reject(error);
        else resolve(latest!);
      };
      const timer = setTimeout(() => {
        changed.delete(finish);
        reject(new Error("[wager-smoke] Wager WebSocket snapshot timed out."));
      }, SOCKET_TIMEOUT_MS);
      changed.add(finish);
      finish();
    });
  return {
    wait,
    close: stop,
    assertHealthy() {
      if (error) throw error;
    },
    get snapshot() {
      return latest ?? previous;
    },
  };
}

async function authenticatedSocket(
  inviteId: string,
  authentication: Actor | string | undefined,
  dependencies: Dependencies,
) {
  const connect = async (previous?: InviteWagersSnapshot) => {
    const token = await accessToken(authentication, dependencies);
    const expiresAtMs =
      typeof authentication === "object"
        ? authentication.accessExpiresAtMs
        : undefined;
    return {
      socket: openSocket(inviteId, token, dependencies, expiresAtMs, previous),
      expiresAtMs,
    };
  };
  let current = await connect();
  return {
    async wait(
      predicate: (snapshot: InviteWagersSnapshot) => boolean,
      heartbeat = false,
    ) {
      current.socket.assertHealthy();
      if (
        current.expiresAtMs !== undefined &&
        current.expiresAtMs <= dependencies.now() + SOCKET_TIMEOUT_MS
      ) {
        const previous = current.socket.snapshot;
        current.socket.close();
        current = await connect(previous);
      }
      return current.socket.wait(predicate, heartbeat);
    },
    close: () => current.socket.close(),
  };
}

async function smokeSnapshots(
  inviteId: string,
  token: Actor | string | undefined,
  dependencies: Dependencies,
): Promise<InviteWagersSnapshot> {
  const metadata = await api(
    dependencies,
    `/invites/${encodeURIComponent(inviteId)}/metadata`,
    token,
  );
  if (
    !isReadInviteMetadataResponse(metadata) ||
    metadata.snapshot.inviteId !== inviteId ||
    !metadata.snapshot.guestId
  )
    fail("Snapshot smoke requires a paired invite.");
  let http = await readSnapshot(inviteId, token, dependencies);
  for (let attempt = 0; attempt < 2; attempt++) {
    const socket = await authenticatedSocket(inviteId, token, dependencies);
    try {
      let matched = false;
      for (let alignment = 0; alignment < 3; alignment++) {
        const snapshot = await socket.wait(
          (value) => value.revision >= http.revision,
          true,
        );
        http = await readSnapshot(inviteId, token, dependencies);
        if (http.revision !== snapshot.revision) continue;
        equal(http, snapshot, "HTTP/WebSocket snapshot parity");
        matched = true;
        break;
      }
      if (!matched)
        fail("Wager snapshots kept changing during parity verification.");
    } finally {
      socket.close();
    }
  }
  dependencies.log(
    `[wager-smoke] ${inviteId}: HTTP, WebSocket, heartbeat, and reconnect passed.`,
  );
  return http;
}

async function assertBalances(
  fixture: Fixture,
  dependencies: Dependencies,
  total: [number, number],
  reserved: [number, number],
): Promise<void> {
  for (const [index, role] of (["host", "guest"] as const).entries()) {
    const actor = fixture.actors[role];
    equal(
      (await readMining(actor, dependencies)).materials,
      { ...createEmptyMaterials(), dust: total[index] },
      `${role} total materials`,
    );
    const frozen = await api(dependencies, "/wagers/frozen/read", actor, {
      playerUid: actor.uid,
    });
    if (!isWagerFrozenReadResponse(frozen) || frozen.playerUid !== actor.uid)
      fail("Frozen-balance response was invalid.");
    equal(
      frozen.frozen,
      { ...createEmptyMaterials(), dust: reserved[index] },
      `${role} frozen materials`,
    );
  }
}

function proposalPresent(
  snapshot: InviteWagersSnapshot,
  inviteId: string,
  uid: string,
): boolean {
  const proposal = snapshot.wagers[inviteId]?.proposals?.[uid];
  return proposal?.material === "dust" && proposal.count === 1;
}

async function sendProposal(
  fixture: Fixture,
  scenario: Scenario,
  dependencies: Dependencies,
): Promise<void> {
  const inviteId = fixture.invites[scenario].id;
  const input = { inviteId, matchId: inviteId, material: "dust", count: 1 };
  for (let replay = 0; replay < 2; replay++) {
    const result = await api(
      dependencies,
      "/wagers/proposals/send",
      fixture.actors.host,
      input,
    );
    if (
      !isWagerProposalSendResponse(result) ||
      !result.ok ||
      result.count !== 1 ||
      result.agreed
    )
      fail("Proposal send/replay failed.");
    await assertBalances(fixture, dependencies, [1, 1], [1, 0]);
  }
}

async function prepare(
  fixture: Fixture,
  save: () => void,
  dependencies: Dependencies,
): Promise<void> {
  dependencies = { ...dependencies, saveFixture: save };
  if (fixture.stage !== "preparing")
    fail("Fixture is already prepared; use frozen-read or active-lifecycle.");
  for (const role of ["host", "guest"] as const) {
    await prepareActor(fixture.actors[role], fixture, save, dependencies);
    dependencies.log(
      `[wager-smoke] ${role}: dedicated profile ${fixture.actors[role].profileId} funded by its first rock.`,
    );
  }
  for (const scenario of SCENARIOS) {
    const invite = fixture.invites[scenario];
    const metadataPath = `/invites/${encodeURIComponent(invite.id)}/metadata`;
    let metadata = await api(
      dependencies,
      metadataPath,
      fixture.actors.host,
      undefined,
      true,
    );
    if (metadata === undefined) {
      const created = await api(
        dependencies,
        "/invites/create",
        fixture.actors.host,
        {
          operationId: invite.createOperationId,
          inviteId: invite.id,
          emojiId: 1,
          aura: "",
        },
      );
      if (
        !isCreateInviteResponse(created) ||
        created.inviteId !== invite.id ||
        created.hostId !== fixture.actors.host.uid ||
        created.matchId !== invite.id
      )
        fail("Manual test-invite creation failed.");
      metadata = await api(dependencies, metadataPath, fixture.actors.host);
    }
    if (
      !isReadInviteMetadataResponse(metadata) ||
      metadata.snapshot.inviteId !== invite.id ||
      metadata.snapshot.hostId !== fixture.actors.host.uid ||
      (metadata.snapshot.guestId !== null &&
        metadata.snapshot.guestId !== fixture.actors.guest.uid) ||
      metadata.snapshot.eventId !== null ||
      metadata.snapshot.eventOwned ||
      metadata.snapshot.automatchStateHint !== null ||
      metadata.snapshot.hostRematches !== "" ||
      metadata.snapshot.guestRematches !== "" ||
      metadata.viewer.role !== "host" ||
      metadata.viewer.actorUid !== fixture.actors.host.uid
    )
      fail("Existing fixture invite is not an unchanged manual test invite.");
    const snapshot = await readSnapshot(
      invite.id,
      fixture.actors.host,
      dependencies,
    );
    if (
      scenario === "cancel" &&
      metadata.snapshot.guestId === fixture.actors.guest.uid &&
      proposalPresent(snapshot, invite.id, fixture.actors.host.uid!)
    ) {
      equal(
        snapshot.wagers,
        {
          [invite.id]: {
            proposals: {
              [fixture.actors.host.uid!]:
                snapshot.wagers[invite.id].proposals![fixture.actors.host.uid!],
            },
            proposedBy: { [fixture.actors.host.uid!]: true },
          },
        },
        "Existing fixture proposal",
      );
    } else equal(snapshot.wagers, {}, "Unused test invite");
    for (const role of ["host", "guest"] as const) {
      if (role === "guest" && metadata.snapshot.guestId === null) continue;
      const actor = fixture.actors[role];
      const url = new URL(
        `${FIREBASE_DATABASE_ROOT}/players/${encodeURIComponent(actor.uid!)}/matches/${encodeURIComponent(invite.id)}.json`,
      );
      const match = await requestJson(
        dependencies,
        "Existing fixture match read",
        url.href,
        { headers: { Origin: ORIGIN, Referer: `${ORIGIN}/` } },
      );
      if (
        !isStoredMatch(match) ||
        match.status !== "" ||
        match.flatMovesString !== "" ||
        match.timer !== ""
      )
        fail("Existing fixture match has unexpected gameplay state.");
    }
    if (metadata.snapshot.guestId === null) {
      const joined = await api(
        dependencies,
        "/invites/join",
        fixture.actors.guest,
        {
          operationId: invite.joinOperationId,
          inviteId: invite.id,
          emojiId: 1,
          aura: "",
        },
      );
      if (
        !isJoinInviteResponse(joined) ||
        joined.inviteId !== invite.id ||
        joined.guestId !== fixture.actors.guest.uid ||
        joined.matchId !== invite.id
      )
        fail("Manual test-invite join failed.");
    }
    dependencies.log(
      `[wager-smoke] ${scenario}: paired manual invite ${invite.id} prepared.`,
    );
  }
  await sendProposal(fixture, "cancel", dependencies);
  for (const scenario of SCENARIOS) {
    const id = fixture.invites[scenario].id;
    const snapshot = await smokeSnapshots(
      id,
      fixture.actors.host,
      dependencies,
    );
    if (scenario === "cancel") {
      if (!proposalPresent(snapshot, id, fixture.actors.host.uid!))
        fail("Prepared proposal is missing.");
    } else equal(snapshot.wagers, {}, "Unused test invite");
    fixture.preparedSnapshots[scenario] = snapshot;
  }
  fixture.stage = "prepared";
  save();
  dependencies.log(
    "[wager-smoke] Preparation passed; one pending 1-dust proposal is retained for migration verification.",
  );
}

async function frozenRead(
  fixture: Fixture,
  dependencies: Dependencies,
): Promise<void> {
  if (fixture.stage !== "prepared")
    fail("Frozen read requires a prepared, unconsumed fixture.");
  for (const scenario of SCENARIOS) {
    const expected = fixture.preparedSnapshots[scenario];
    if (!isInviteWagersSnapshot(expected))
      fail("Prepared snapshot evidence is missing.");
    const actual = await smokeSnapshots(
      fixture.invites[scenario].id,
      fixture.actors.host,
      dependencies,
    );
    equal(actual.wagers, expected.wagers, "Imported wager snapshot");
  }
  await assertBalances(fixture, dependencies, [1, 1], [1, 0]);
  dependencies.log(
    "[wager-smoke] Frozen import snapshots and reservation balances passed; no gameplay mutation was sent.",
  );
}

async function activeLifecycle(
  fixture: Fixture,
  save: () => void,
  dependencies: Dependencies,
): Promise<void> {
  dependencies = { ...dependencies, saveFixture: save };
  if (fixture.stage === "preparing")
    fail("Prepare this fixture before the release.");
  const host = fixture.actors.host;
  const guest = fixture.actors.guest;
  if (!host.uid || !guest.uid || !host.accessToken || !guest.accessToken)
    fail("Fixture identities are incomplete.");
  if (fixture.stage === "prepared") {
    await frozenRead(fixture, dependencies);
    fixture.stage = "active";
    save();
  }
  const step = async (name: string, work: () => Promise<void>) => {
    if (fixture.steps.includes(name)) return;
    await work();
    fixture.steps.push(name);
    save();
    dependencies.log(`[wager-smoke] ${name} passed.`);
  };
  for (const scenario of SCENARIOS) {
    const inviteId = fixture.invites[scenario].id;
    const input = { inviteId, matchId: inviteId };
    const metadata = await api(
      dependencies,
      `/invites/${encodeURIComponent(inviteId)}/metadata`,
      host,
    );
    if (
      !isReadInviteMetadataResponse(metadata) ||
      metadata.snapshot.hostId !== host.uid ||
      metadata.snapshot.guestId !== guest.uid ||
      metadata.snapshot.eventId !== null ||
      metadata.snapshot.eventOwned ||
      metadata.snapshot.automatchStateHint !== null
    )
      fail("Lifecycle invite must belong only to the generated test profiles.");
    const socket = await authenticatedSocket(inviteId, host, dependencies);
    try {
      await socket.wait(() => true, true);
      if (scenario !== "cancel")
        await step(`${scenario}:send`, async () => {
          const before = await readSnapshot(inviteId, host, dependencies);
          await sendProposal(fixture, scenario, dependencies);
          await socket.wait(
            (snapshot) =>
              snapshot.revision >= before.revision &&
              proposalPresent(snapshot, inviteId, host.uid!),
          );
        });
      if (scenario !== "settle") {
        await step(`${scenario}:remove`, async () => {
          const token = scenario === "cancel" ? host : guest;
          for (let replay = 0; replay < 2; replay++) {
            const result = await api(
              dependencies,
              `/wagers/proposals/${scenario}`,
              token,
              input,
            );
            if (!isWagerProposalRemovalResponse(result) || !result.ok)
              fail(`${scenario} replay failed.`);
            await assertBalances(fixture, dependencies, [1, 1], [0, 0]);
          }
          await socket.wait(
            (snapshot) => !snapshot.wagers[inviteId]?.proposals?.[host.uid!],
          );
        });
      } else {
        await step("settle:accept", async () => {
          for (let replay = 0; replay < 2; replay++) {
            const accepted = await api(
              dependencies,
              "/wagers/proposals/accept",
              guest,
              input,
            );
            if (
              !isWagerProposalAcceptResponse(accepted) ||
              !accepted.ok ||
              accepted.count !== 1
            )
              fail("Proposal acceptance/replay failed.");
            await assertBalances(fixture, dependencies, [1, 1], [1, 1]);
          }
          await socket.wait(
            (snapshot) =>
              snapshot.wagers[inviteId]?.agreed?.count === 1 &&
              snapshot.wagers[inviteId]?.agreed?.proposerId === host.uid &&
              snapshot.wagers[inviteId]?.agreed?.accepterId === guest.uid,
          );
        });
        await step("settle:surrender", async () => {
          const url = new URL(
            `${FIREBASE_DATABASE_ROOT}/players/${encodeURIComponent(guest.uid!)}/matches/${encodeURIComponent(inviteId)}.json`,
          );
          const match = await requestJson(
            dependencies,
            "Dedicated guest match read",
            url.href,
            { headers: { Origin: ORIGIN, Referer: `${ORIGIN}/` } },
          );
          if (
            !isStoredMatch(match) ||
            !["", "surrendered"].includes(match.status)
          )
            fail("Dedicated guest match cannot surrender.");
          for (let replay = 0; replay < 2; replay++) {
            const result = await api(
              dependencies,
              "/matches/surrender",
              guest,
              { ...input, playerId: guest.uid },
            );
            if (
              !isSurrenderMatchResponse(result) ||
              result.inviteId !== inviteId ||
              result.matchId !== inviteId ||
              result.actorUid !== guest.uid
            )
              fail("Dedicated guest surrender/replay failed.");
            equal(
              await requestJson(
                dependencies,
                "Dedicated guest surrendered match read",
                url.href,
                { headers: { Origin: ORIGIN, Referer: `${ORIGIN}/` } },
              ),
              { ...match, status: "surrendered" },
              "Guest surrender preserved match state",
            );
          }
        });
        await step("settle:resolve", async () => {
          for (let replay = 0; replay < 2; replay++) {
            const result = await api(
              dependencies,
              "/wagers/outcomes/resolve",
              host,
              input,
            );
            if (
              !isWagerOutcomeResolveResponse(result) ||
              !result.ok ||
              ("reason" in result && result.reason !== "already-resolved")
            )
              fail("Wager settlement/replay failed.");
            await assertBalances(fixture, dependencies, [2, 0], [0, 0]);
          }
          await socket.wait(
            (snapshot) =>
              snapshot.wagers[inviteId]?.resolved?.winnerId === host.uid &&
              snapshot.wagers[inviteId]?.resolved?.loserId === guest.uid &&
              snapshot.wagers[inviteId]?.resolved?.count === 1,
          );
        });
      }
    } finally {
      socket.close();
    }
    const snapshot = await smokeSnapshots(inviteId, host, dependencies);
    const wager = snapshot.wagers[inviteId];
    equal(wager?.proposals ?? {}, {}, `${scenario} final proposals`);
    if (scenario === "settle") {
      const { agreed, resolved } = wager || {};
      if (
        !agreed ||
        !resolved ||
        agreed.proposerId !== host.uid ||
        agreed.accepterId !== guest.uid ||
        agreed.material !== "dust" ||
        agreed.count !== 1 ||
        agreed.total !== 2 ||
        resolved.winnerId !== host.uid ||
        resolved.loserId !== guest.uid ||
        resolved.material !== "dust" ||
        resolved.count !== 1 ||
        resolved.total !== 2
      )
        fail("Final settlement wager did not match.");
    } else if (
      wager?.proposedBy?.[host.uid] !== true ||
      wager.agreed ||
      wager.resolved
    )
      fail(`${scenario} final wager did not match.`);
  }
  await assertBalances(fixture, dependencies, [2, 0], [0, 0]);
  fixture.stage = "complete";
  save();
  dependencies.log(
    "[wager-smoke] Active lifecycle passed; only the two generated profiles' first-rock dust moved. No rating or announcement request was sent.",
  );
}

async function runSmoke(
  options: Options,
  dependencies: Dependencies = {
    fetch,
    connect: (url, protocols, settings) =>
      new WebSocket(url, protocols, settings),
    now: Date.now,
    log: console.log,
  },
): Promise<void> {
  const validated = parseArgs([
    "--base-url",
    options.baseUrl,
    `--${options.mode}`,
    ...(options.fixture ? ["--fixture", options.fixture] : []),
    ...(options.inviteId ? ["--invite-id", options.inviteId] : []),
    ...(options.authTokenFixture
      ? ["--auth-token-fixture", options.authTokenFixture]
      : []),
  ]);
  if (validated.mode === "read-only") {
    const auth = validated.authTokenFixture
      ? record(readProtectedJson(validated.authTokenFixture))
      : null;
    if (
      validated.authTokenFixture &&
      (!auth ||
        Object.keys(auth).length !== 1 ||
        !isReactionSocketToken(auth.accessToken))
    )
      fail("Auth fixture must contain only an accessToken.");
    await smokeSnapshots(
      validated.inviteId!,
      auth?.accessToken as string | undefined,
      dependencies,
    );
    return;
  }
  const path = validated.fixture!;
  const lockPath = `${path}.lock`;
  let lock: number;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch {
    fail(
      "Fixture is locked or its directory is unavailable; reconcile the previous process before retrying.",
    );
  }
  try {
    let fixture: Fixture;
    if (existsSync(path)) fixture = readFixture(path);
    else {
      if (validated.mode !== "prepare-fixtures")
        fail("Fixture does not exist.");
      fixture = createFixture(dependencies.now());
      writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    }
    const save = () => saveFixture(path, fixture);
    dependencies = { ...dependencies, saveFixture: save };
    if (validated.mode === "prepare-fixtures")
      await prepare(fixture, save, dependencies);
    else {
      for (const role of ["host", "guest"] as const)
        await refreshActor(fixture.actors[role], save, dependencies);
      if (validated.mode === "frozen-read")
        await frozenRead(fixture, dependencies);
      else await activeLifecycle(fixture, save, dependencies);
    }
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

function reportFailure(error: unknown): void {
  console.error(
    error instanceof Error && error.message.startsWith("[wager-smoke]")
      ? error.message
      : "[wager-smoke] Check failed without logging credentials or response bodies.",
  );
  console.error(
    "[wager-smoke] Preserve the fixture and inspect the last completed step before rerunning.",
  );
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    runSmoke(parseArgs(process.argv.slice(2))).catch(reportFailure);
  } catch (error) {
    reportFailure(error);
  }
}

export {
  activeLifecycle,
  createFixture,
  frozenRead,
  openSocket,
  parseArgs,
  prepare,
  readFixture,
  requestJson,
  runSmoke,
  saveFixture,
  smokeSnapshots,
};
export type { Actor, Dependencies, Fixture, Options };
