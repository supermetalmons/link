import { randomInt, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Game, type Input } from "mons-rules";
import { WebSocket } from "ws";
import {
  GAME_SESSION_OPERATION_ID_PATTERN,
  MANUAL_INVITE_ID_PATTERN,
  isCreateInviteResponse,
  isEndRematchResponse,
  isGameSessionMatch,
  isJoinInviteResponse,
  isProposeRematchResponse,
  isSurrenderMatchResponse,
} from "@mons/shared/game-sessions";
import { INVITE_ID_RANDOM_LENGTH, isSafeFirebaseKey } from "@mons/shared/ids";
import {
  INVITE_METADATA_MAX_MESSAGE_BYTES,
  INVITE_METADATA_SOCKET_PROTOCOL,
  isInviteMetadataMessage,
  isReadInviteMetadataResponse,
} from "@mons/shared/invite-metadata";
import type { InviteMetadataSnapshot } from "@mons/shared/invite-metadata";
import { formatMatchTimer, MATCH_TIMER_DURATION_MS } from "@mons/shared/timers";

const ORIGIN = "https://mons.link";
const FIREBASE_API_KEY = "AIzaSyC8Ihr4kDd34z-RXe8XTBCFtFbXebifo5Y";
const FIREBASE_IDENTITY_ROOT = "https://identitytoolkit.googleapis.com/v1";
const FIREBASE_DATABASE_ROOT = "https://mons-link-default-rtdb.firebaseio.com";
const PREVIEW_HOST_PATTERN =
  /^[0-9a-f]{8}-mons-link-api\.lil-org\.workers\.dev$/;
const REQUEST_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 15_000;
const MAX_REQUEST_ATTEMPTS = 3;
const OPERATION_NAMES = [
  "create",
  "join",
  "hostRematch",
  "guestRematch",
  "end",
] as const;

type Options = {
  baseUrl: string;
  output?: string;
  surrenderRulesPending?: boolean;
};
type Session = { uid: string; idToken: string };
type OperationName = (typeof OPERATION_NAMES)[number];
type Operations = Record<OperationName, string>;
type SmokeSocket = {
  protocol: string;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeAllListeners(): unknown;
  terminate(): void;
};
type Dependencies = {
  fetch: typeof fetch;
  connect: (
    url: string,
    options: import("ws").ClientOptions,
    protocol: string,
  ) => SmokeSocket;
  createInviteId: () => string;
  createOperationId: () => string;
  now: () => number;
  log: (message: string) => void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};
type Report = {
  inviteId: string;
  matchIds: string[];
  hostUid: string;
  guestUid: string;
  operationIds: Operations;
  checks: string[];
};
type HttpResult = { status: number; headers: Headers; payload: unknown };
type MatchRecord = Record<string, unknown> & {
  sessionCreation: string;
  timer: string;
};

class SmokeFailure extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

function usage(): string {
  return "Usage: npm run smoke:invite-lifecycle -- --base-url <https-api-url> [--output <report-json-file>] [--surrender-rules-pending]";
}

function validateOptions(options: Options): Options {
  let url: URL;
  try {
    url = new URL(options.baseUrl);
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
      !PREVIEW_HOST_PATTERN.test(url.hostname)) ||
    (options.output !== undefined &&
      (!options.output.trim() || options.output.includes("\0"))) ||
    (options.surrenderRulesPending !== undefined &&
      typeof options.surrenderRulesPending !== "boolean")
  )
    throw new TypeError(usage());
  return {
    baseUrl: url.origin,
    ...(options.output ? { output: options.output } : {}),
    ...(options.surrenderRulesPending ? { surrenderRulesPending: true } : {}),
  };
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  let surrenderRulesPending = false;
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--surrender-rules-pending") {
      if (surrenderRulesPending) throw new TypeError(usage());
      surrenderRulesPending = true;
      continue;
    }
    const value = argv[++index];
    if (
      (key !== "--base-url" && key !== "--output") ||
      !value ||
      values.has(key)
    )
      throw new TypeError(usage());
    values.set(key, value);
  }
  return validateOptions({
    baseUrl: values.get("--base-url") || "",
    output: values.get("--output"),
    surrenderRulesPending,
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    !response.body ||
    Number(response.headers.get("Content-Length")) >
      INVITE_METADATA_MAX_MESSAGE_BYTES
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new SmokeFailure(
      "Lifecycle smoke received an invalid or oversized response.",
    );
  }
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > INVITE_METADATA_MAX_MESSAGE_BYTES) throw new Error();
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new SmokeFailure(
      "Lifecycle smoke received an invalid or oversized response.",
    );
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

async function requestJson(
  url: string,
  init: RequestInit,
  dependencies: Dependencies,
): Promise<HttpResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = dependencies.setTimeout(() => {
      reject(new SmokeFailure("Lifecycle smoke request timed out.", true));
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
  });
  const work = async () => {
    let response: Response;
    try {
      response = await dependencies.fetch(url, {
        ...init,
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      throw new SmokeFailure("Lifecycle smoke request failed.", true);
    }
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      throw new SmokeFailure("Lifecycle smoke request timed out.", true);
    }
    return {
      status: response.status,
      headers: response.headers,
      payload: await readJson(response, controller.signal),
    };
  };
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer) dependencies.clearTimeout(timer);
    controller.abort();
  }
}

async function retry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (
        !(error instanceof SmokeFailure) ||
        !error.retryable ||
        attempt + 1 === MAX_REQUEST_ATTEMPTS
      )
        throw error;
    }
  }
  throw new SmokeFailure("Lifecycle smoke request failed.");
}

function expectOk(result: HttpResult, label: string): void {
  if (result.status !== 200)
    throw new SmokeFailure(
      `${label} returned ${result.status}.`,
      result.status >= 500,
    );
}

async function identityRequest(
  operation: "accounts:signUp" | "accounts:delete",
  body: Record<string, unknown>,
  dependencies: Dependencies,
): Promise<unknown> {
  const result = await requestJson(
    `${FIREBASE_IDENTITY_ROOT}/${operation}?key=${FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Referer: `${ORIGIN}/`,
      },
      body: JSON.stringify(body),
    },
    dependencies,
  );
  expectOk(result, "Lifecycle anonymous session request");
  return result.payload;
}

async function createSession(dependencies: Dependencies): Promise<Session> {
  const payload = await identityRequest(
    "accounts:signUp",
    { returnSecureToken: true },
    dependencies,
  );
  const idToken =
    record(payload) && typeof payload.idToken === "string"
      ? payload.idToken
      : "";
  const uid =
    record(payload) && typeof payload.localId === "string"
      ? payload.localId
      : "";
  let subject: unknown;
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(idToken.split(".")[1] || "", "base64url").toString("utf8"),
    );
    subject = record(claims) ? claims.sub : null;
  } catch {
    subject = null;
  }
  if (
    !idToken ||
    idToken.length > 16_000 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken) ||
    !isSafeFirebaseKey(uid) ||
    subject !== uid
  ) {
    if (idToken)
      await identityRequest("accounts:delete", { idToken }, dependencies);
    throw new SmokeFailure(
      "Lifecycle anonymous session response was incomplete.",
    );
  }
  return { uid, idToken };
}

async function apiRequest(
  options: Options,
  path: string,
  session: Session,
  body: Record<string, unknown> | null,
  dependencies: Dependencies,
): Promise<unknown> {
  return retry(async () => {
    const result = await requestJson(
      `${options.baseUrl}${path}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${session.idToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          Origin: ORIGIN,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      dependencies,
    );
    expectOk(result, "Lifecycle API request");
    if (
      !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(
        result.headers.get("Cache-Control") || "",
      ) ||
      result.headers.get("Access-Control-Allow-Origin") !== ORIGIN
    )
      throw new SmokeFailure(
        "Lifecycle API response lacked the expected cache or origin protection.",
      );
    return result.payload;
  });
}

async function mutation<T>(
  options: Options,
  path: string,
  session: Session,
  body: Record<string, unknown>,
  validate: (value: unknown) => value is T,
  expected: (value: T) => boolean,
  dependencies: Dependencies,
): Promise<T> {
  const first = await apiRequest(options, path, session, body, dependencies);
  if (!validate(first) || !expected(first))
    throw new SmokeFailure(
      "Lifecycle mutation returned an unexpected receipt.",
    );
  const replay = await apiRequest(options, path, session, body, dependencies);
  if (!isDeepStrictEqual(first, replay))
    throw new SmokeFailure("Lifecycle operation replay changed its receipt.");
  return first;
}

function metadataChannel(
  options: Options,
  inviteId: string,
  session: Session,
  dependencies: Dependencies,
) {
  let socket: SmokeSocket;
  try {
    socket = dependencies.connect(
      `${options.baseUrl.replace(/^https:/, "wss:")}/invites/${inviteId}/metadata/socket`,
      {
        origin: ORIGIN,
        headers: { Authorization: `Bearer ${session.idToken}` },
        followRedirects: false,
        handshakeTimeout: SOCKET_TIMEOUT_MS,
        maxPayload: INVITE_METADATA_MAX_MESSAGE_BYTES,
        perMessageDeflate: false,
      },
      INVITE_METADATA_SOCKET_PROTOCOL,
    );
  } catch {
    throw new SmokeFailure("Lifecycle metadata socket could not connect.");
  }
  let current: InviteMetadataSnapshot | null = null;
  let failure: SmokeFailure | null = null;
  let closed = false;
  const waiting = new Set<() => void>();
  const fail = (message: string) => {
    failure ||= new SmokeFailure(message);
    for (const notify of waiting) notify();
  };
  socket.on("error", () => fail("Lifecycle metadata socket failed."));
  socket.on("close", () => {
    if (!closed) fail("Lifecycle metadata socket closed early.");
  });
  socket.on("unexpected-response", (_request, response) => {
    if (record(response) && typeof response.destroy === "function")
      response.destroy();
    fail("Lifecycle metadata socket upgrade failed.");
  });
  socket.on("message", (data, isBinary) => {
    try {
      const bytes = Buffer.isBuffer(data)
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Array.isArray(data) && data.every(Buffer.isBuffer)
            ? Buffer.concat(data)
            : null;
      if (
        isBinary ||
        !bytes ||
        bytes.byteLength > INVITE_METADATA_MAX_MESSAGE_BYTES ||
        socket.protocol !== INVITE_METADATA_SOCKET_PROTOCOL
      )
        throw new Error();
      const payload: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (
        !isInviteMetadataMessage(payload) ||
        payload.snapshot.inviteId !== inviteId ||
        (current &&
          (payload.snapshot.revision < current.revision ||
            (payload.snapshot.revision === current.revision &&
              !isDeepStrictEqual(payload.snapshot, current))))
      )
        throw new Error();
      current = payload.snapshot;
      for (const notify of waiting) notify();
    } catch {
      fail("Lifecycle metadata socket received an invalid snapshot.");
    }
  });
  return {
    waitFor(expected: InviteMetadataSnapshot): Promise<void> {
      return new Promise((resolveWait, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = (error?: SmokeFailure) => {
          if (settled) return;
          settled = true;
          if (timer) dependencies.clearTimeout(timer);
          waiting.delete(check);
          if (error) reject(error);
          else resolveWait();
        };
        const check = () => {
          if (failure) finish(failure);
          else if (closed)
            finish(new SmokeFailure("Lifecycle metadata socket was closed."));
          else if (current && isDeepStrictEqual(current, expected)) finish();
          else if (current && current.revision >= expected.revision)
            finish(
              new SmokeFailure(
                "Lifecycle metadata socket disagreed with the HTTP snapshot.",
              ),
            );
        };
        waiting.add(check);
        timer = dependencies.setTimeout(
          () =>
            finish(new SmokeFailure("Lifecycle metadata update timed out.")),
          SOCKET_TIMEOUT_MS,
        );
        check();
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const notify of waiting) notify();
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      try {
        socket.terminate();
      } catch {}
    },
  };
}

async function readMetadata(
  options: Options,
  inviteId: string,
  session: Session,
  role: "host" | "guest",
  expected: {
    hostId: string;
    guestId: string | null;
    hostRematches: string;
    guestRematches: string;
  },
  minimumRevision: number,
  dependencies: Dependencies,
): Promise<InviteMetadataSnapshot> {
  const payload = await apiRequest(
    options,
    `/invites/${inviteId}/metadata`,
    session,
    null,
    dependencies,
  );
  if (
    !isReadInviteMetadataResponse(payload) ||
    payload.snapshot.inviteId !== inviteId ||
    payload.snapshot.revision < minimumRevision ||
    payload.snapshot.hostId !== expected.hostId ||
    payload.snapshot.guestId !== expected.guestId ||
    payload.snapshot.hostRematches !== expected.hostRematches ||
    payload.snapshot.guestRematches !== expected.guestRematches ||
    payload.snapshot.automatchStateHint !== null ||
    payload.snapshot.eventId !== null ||
    payload.snapshot.eventOwned ||
    payload.viewer.role !== role ||
    payload.viewer.actorUid !== session.uid ||
    payload.viewer.automatchOperationId !== null
  )
    throw new SmokeFailure(
      "Lifecycle HTTP metadata or participant identity was incorrect.",
    );
  return payload.snapshot;
}

function matchUrl(uid: string, matchId: string, session: Session): string {
  return `${FIREBASE_DATABASE_ROOT}/players/${encodeURIComponent(uid)}/matches/${encodeURIComponent(matchId)}.json?auth=${encodeURIComponent(session.idToken)}`;
}

function parseMatch(value: unknown): MatchRecord {
  if (
    !record(value) ||
    typeof value.sessionCreation !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sessionCreation)
  )
    throw new SmokeFailure("Lifecycle live match lacked its creation marker.");
  const { sessionCreation, ...match } = value;
  if (!isGameSessionMatch(match))
    throw new SmokeFailure("Lifecycle live match was invalid.");
  return { ...match, sessionCreation };
}

async function readMatch(
  uid: string,
  matchId: string,
  session: Session,
  dependencies: Dependencies,
) {
  const result = await requestJson(
    matchUrl(uid, matchId, session),
    { headers: { "X-Firebase-ETag": "true" } },
    dependencies,
  );
  expectOk(result, "Lifecycle live match read");
  const etag = result.headers.get("ETag");
  if (!etag || etag.length > 512)
    throw new SmokeFailure(
      "Lifecycle live match read lacked its transaction ETag.",
    );
  return { value: parseMatch(result.payload), etag };
}

async function updateOwnedMatch(
  session: Session,
  matchId: string,
  update: (value: MatchRecord) => MatchRecord,
  dependencies: Dependencies,
): Promise<MatchRecord> {
  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt++) {
    const current = await readMatch(
      session.uid,
      matchId,
      session,
      dependencies,
    );
    const next = update(current.value);
    const result = await requestJson(
      matchUrl(session.uid, matchId, session),
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": current.etag,
        },
        body: JSON.stringify(next),
      },
      dependencies,
    );
    if (result.status === 412) continue;
    expectOk(result, "Lifecycle owned match transaction");
    if (!isDeepStrictEqual(result.payload, next))
      throw new SmokeFailure(
        "Lifecycle owned match transaction changed its payload.",
      );
    return next;
  }
  throw new SmokeFailure("Lifecycle owned match transaction kept conflicting.");
}

function permissionDenied(result: HttpResult): boolean {
  return (
    (result.status === 401 || result.status === 403) &&
    record(result.payload) &&
    typeof result.payload.error === "string" &&
    /permission denied/i.test(result.payload.error)
  );
}

async function verifyTimerRules(
  session: Session,
  matchId: string,
  dependencies: Dependencies,
): Promise<void> {
  const current = await readMatch(session.uid, matchId, session, dependencies);
  const result = await requestJson(
    matchUrl(session.uid, matchId, session),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-Match": current.etag },
      body: JSON.stringify({
        ...current.value,
        timer: formatMatchTimer(
          1,
          dependencies.now() + MATCH_TIMER_DURATION_MS,
        ),
      }),
    },
    dependencies,
  );
  if (result.status === 200) {
    await updateOwnedMatch(
      session,
      matchId,
      (value) => ({ ...value, timer: current.value.timer }),
      dependencies,
    );
    throw new SmokeFailure(
      "Lifecycle rules allowed a client to forge a timer.",
    );
  }
  if (!permissionDenied(result))
    throw new SmokeFailure(
      "Lifecycle timer rule did not return permission denial.",
    );
  if (
    !isDeepStrictEqual(
      (await readMatch(session.uid, matchId, session, dependencies)).value,
      current.value,
    )
  )
    throw new SmokeFailure("Lifecycle rejected timer write changed the match.");
  const claim = await requestJson(
    `${FIREBASE_DATABASE_ROOT}/matchTimerClaims/${matchId}.json?auth=${encodeURIComponent(session.idToken)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "null",
    },
    dependencies,
  );
  if (!permissionDenied(claim))
    throw new SmokeFailure(
      "Lifecycle timer claim fence was writable by a client.",
    );
}

async function verifyLiveMatch(
  options: Options,
  inviteId: string,
  host: Session,
  guest: Session,
  matchId: string,
  dependencies: Dependencies,
): Promise<void> {
  const hostMatch = await readMatch(host.uid, matchId, host, dependencies);
  const game = Game.fromFen(String(hostMatch.value.fen));
  if (!game)
    throw new SmokeFailure("Lifecycle live match could not load its game.");
  const mover = game.activeColor === hostMatch.value.color ? host : guest;
  const opponent = mover === host ? guest : host;
  const moved = await updateOwnedMatch(
    mover,
    matchId,
    (value) => {
      const active = Game.fromFen(String(value.fen));
      if (!active || active.activeColor !== value.color)
        throw new SmokeFailure("Lifecycle mover did not own the active turn.");
      const inputs: Input[] = [];
      for (let step = 0; step < 8; step++) {
        const next = active.preview(inputs);
        if (next.kind === "complete") {
          const played = active.play(inputs);
          if (played.kind !== "complete") break;
          return {
            ...value,
            fen: active.toFen(),
            flatMovesString: value.flatMovesString
              ? `${value.flatMovesString}-${played.inputFen}`
              : played.inputFen,
          };
        }
        const input =
          next.kind === "awaiting-start" && next.positions[0]
            ? ({ kind: "position", position: next.positions[0] } as const)
            : next.kind === "awaiting-input"
              ? next.options[0]?.input
              : undefined;
        if (!input) break;
        inputs.push(input);
      }
      throw new SmokeFailure("Lifecycle could not produce a legal move.");
    },
    dependencies,
  );
  if (
    !isDeepStrictEqual(
      (await readMatch(mover.uid, matchId, opponent, dependencies)).value,
      moved,
    )
  )
    throw new SmokeFailure("Lifecycle opponent read missed the legal move.");
  const before = await readMatch(host.uid, matchId, host, dependencies);
  await mutation(
    options,
    "/matches/surrender",
    host,
    { inviteId, matchId, playerId: host.uid },
    isSurrenderMatchResponse,
    (value) =>
      value.inviteId === inviteId &&
      value.matchId === matchId &&
      value.actorUid === host.uid,
    dependencies,
  );
  const observed = await readMatch(host.uid, matchId, guest, dependencies);
  if (
    !isDeepStrictEqual(observed.value, {
      ...before.value,
      status: "surrendered",
    })
  )
    throw new SmokeFailure(
      "Lifecycle API surrender changed other state or was not observed by the opponent.",
    );
}

async function verifySurrenderRules(
  session: Session,
  matchId: string,
  dependencies: Dependencies,
): Promise<void> {
  const current = await readMatch(session.uid, matchId, session, dependencies);
  const wholeUrl = matchUrl(session.uid, matchId, session);
  const statusUrl = new URL(wholeUrl);
  statusUrl.pathname = statusUrl.pathname.replace(/\.json$/, "/status.json");
  const { status: _status, ...withoutStatus } = current.value;
  for (const [url, body] of [
    [statusUrl.href, "surrendered"],
    [wholeUrl, { ...current.value, status: "surrendered" }],
    [statusUrl.href, null],
    [wholeUrl, withoutStatus],
  ] as const) {
    const result = await requestJson(
      url,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      dependencies,
    );
    if (!permissionDenied(result))
      throw new SmokeFailure(
        "Lifecycle surrender rule did not deny a direct client status write.",
      );
    if (
      !isDeepStrictEqual(
        (await readMatch(session.uid, matchId, session, dependencies)).value,
        current.value,
      )
    )
      throw new SmokeFailure(
        "Lifecycle rejected client status write changed the match.",
      );
  }
}

async function verifyNoRtdbInvite(
  inviteId: string,
  session: Session,
  dependencies: Dependencies,
): Promise<void> {
  const result = await requestJson(
    `${FIREBASE_DATABASE_ROOT}/invites/${inviteId}.json?auth=${encodeURIComponent(session.idToken)}`,
    {},
    dependencies,
  );
  expectOk(result, "Lifecycle retired RTDB invite read");
  if (result.payload !== null)
    throw new SmokeFailure(
      "Lifecycle invite source was still present in Firebase.",
    );
}

async function runSmoke(
  options: Options,
  dependencies: Dependencies = {
    fetch,
    connect: (url, options, protocol) => new WebSocket(url, protocol, options),
    createInviteId: () =>
      Array.from(
        { length: INVITE_ID_RANDOM_LENGTH },
        () =>
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[
            randomInt(62)
          ],
      ).join(""),
    createOperationId: randomUUID,
    now: Date.now,
    log: console.log,
    setTimeout,
    clearTimeout,
  },
): Promise<Report> {
  const validated = validateOptions(options);
  const inviteId = dependencies.createInviteId();
  const operationIds = Object.fromEntries(
    OPERATION_NAMES.map((name) => [name, dependencies.createOperationId()]),
  ) as Operations;
  if (
    !MANUAL_INVITE_ID_PATTERN.test(inviteId) ||
    !Object.values(operationIds).every((id) =>
      GAME_SESSION_OPERATION_ID_PATTERN.test(id),
    ) ||
    new Set(Object.values(operationIds)).size !== OPERATION_NAMES.length
  )
    throw new SmokeFailure("Lifecycle smoke identifiers were invalid.");
  const report: Report = {
    inviteId,
    matchIds: [inviteId, `${inviteId}1`],
    hostUid: "",
    guestUid: "",
    operationIds,
    checks: [],
  };
  dependencies.log(JSON.stringify({ inviteId, operationIds }));
  const sessions: Session[] = [];
  let channel: ReturnType<typeof metadataChannel> | null = null;
  let createAttempted = false;
  let paired = false;
  let terminal = false;
  let failure: unknown;
  const operationBody = (name: OperationName, presentation = true) => ({
    inviteId,
    operationId: operationIds[name],
    ...(presentation
      ? {
          emojiId: name === "join" || name === "guestRematch" ? 2 : 1,
          aura: "",
        }
      : {}),
  });
  try {
    sessions.push(await createSession(dependencies));
    report.hostUid = sessions[0].uid;
    sessions.push(await createSession(dependencies));
    report.guestUid = sessions[1].uid;
    const [host, guest] = sessions;
    if (host.uid === guest.uid)
      throw new SmokeFailure("Lifecycle smoke sessions were not distinct.");
    createAttempted = true;
    await mutation(
      validated,
      "/invites/create",
      host,
      operationBody("create"),
      isCreateInviteResponse,
      (value) =>
        value.inviteId === inviteId &&
        value.hostId === host.uid &&
        value.matchId === inviteId,
      dependencies,
    );
    report.checks.push("create-receipt-replay");
    let expected = {
      hostId: host.uid,
      guestId: null as string | null,
      hostRematches: "",
      guestRematches: "",
    };
    let snapshot = await readMetadata(
      validated,
      inviteId,
      host,
      "host",
      expected,
      1,
      dependencies,
    );
    await verifyNoRtdbInvite(inviteId, host, dependencies);
    channel = metadataChannel(validated, inviteId, host, dependencies);
    await channel.waitFor(snapshot);
    report.checks.push("pending-http-and-authenticated-socket");
    await mutation(
      validated,
      "/invites/join",
      guest,
      operationBody("join"),
      isJoinInviteResponse,
      (value) =>
        value.inviteId === inviteId &&
        value.guestId === guest.uid &&
        value.joined &&
        value.matchId === inviteId,
      dependencies,
    );
    paired = true;
    expected = { ...expected, guestId: guest.uid };
    snapshot = await readMetadata(
      validated,
      inviteId,
      host,
      "host",
      expected,
      snapshot.revision + 1,
      dependencies,
    );
    await channel.waitFor(snapshot);
    const guestSnapshot = await readMetadata(
      validated,
      inviteId,
      guest,
      "guest",
      expected,
      snapshot.revision,
      dependencies,
    );
    if (!isDeepStrictEqual(snapshot, guestSnapshot))
      throw new SmokeFailure(
        "Lifecycle participants saw different invite metadata.",
      );
    report.checks.push("join-receipt-replay-and-live-metadata");
    await verifyTimerRules(host, inviteId, dependencies);
    report.checks.push("firebase-timer-and-claim-write-rules");
    if (!validated.surrenderRulesPending) {
      await verifySurrenderRules(host, inviteId, dependencies);
      report.checks.push("firebase-surrender-write-rules");
    }
    await verifyLiveMatch(
      validated,
      inviteId,
      host,
      guest,
      inviteId,
      dependencies,
    );
    report.checks.push("firebase-move-api-surrender-replay-and-opponent-read");
    const hostRematch = await mutation(
      validated,
      "/rematches/propose",
      host,
      operationBody("hostRematch"),
      isProposeRematchResponse,
      (value) =>
        value.inviteId === inviteId &&
        value.actorUid === host.uid &&
        value.matchId === `${inviteId}1` &&
        value.rematches === "1" &&
        value.match.emojiId === 1 &&
        value.match.aura === "",
      dependencies,
    );
    expected = { ...expected, hostRematches: "1" };
    snapshot = await readMetadata(
      validated,
      inviteId,
      host,
      "host",
      expected,
      snapshot.revision + 1,
      dependencies,
    );
    await channel.waitFor(snapshot);
    const guestRematch = await mutation(
      validated,
      "/rematches/propose",
      guest,
      operationBody("guestRematch"),
      isProposeRematchResponse,
      (value) =>
        value.inviteId === inviteId &&
        value.actorUid === guest.uid &&
        value.matchId === `${inviteId}1` &&
        value.rematches === "1" &&
        value.match.emojiId === 2 &&
        value.match.aura === "",
      dependencies,
    );
    if (
      hostRematch.match.fen !== guestRematch.match.fen ||
      hostRematch.match.gameVariant !== guestRematch.match.gameVariant ||
      hostRematch.match.color === guestRematch.match.color
    )
      throw new SmokeFailure("Lifecycle rematch seeds or colors disagreed.");
    expected = { ...expected, guestRematches: "1" };
    snapshot = await readMetadata(
      validated,
      inviteId,
      host,
      "host",
      expected,
      snapshot.revision + 1,
      dependencies,
    );
    await channel.waitFor(snapshot);
    report.checks.push("both-rematch-receipts-and-live-metadata");
    await verifyLiveMatch(
      validated,
      inviteId,
      host,
      guest,
      `${inviteId}1`,
      dependencies,
    );
    report.checks.push(
      "firebase-rematch-move-api-surrender-replay-and-opponent-read",
    );
    await mutation(
      validated,
      "/rematches/end",
      host,
      operationBody("end", false),
      isEndRematchResponse,
      (value) =>
        value.inviteId === inviteId &&
        value.actorUid === host.uid &&
        value.rematches === "1x",
      dependencies,
    );
    terminal = true;
    expected = { ...expected, hostRematches: "1x" };
    snapshot = await readMetadata(
      validated,
      inviteId,
      host,
      "host",
      expected,
      snapshot.revision + 1,
      dependencies,
    );
    await channel.waitFor(snapshot);
    report.checks.push("terminal-series-receipt-and-live-metadata");
    const replay = await apiRequest(
      validated,
      "/rematches/propose",
      host,
      operationBody("hostRematch"),
      dependencies,
    );
    if (!isDeepStrictEqual(replay, hostRematch))
      throw new SmokeFailure(
        "Lifecycle terminal replay changed the original rematch receipt.",
      );
    const final = await readMetadata(
      validated,
      inviteId,
      host,
      "host",
      expected,
      snapshot.revision,
      dependencies,
    );
    if (!isDeepStrictEqual(final, snapshot))
      throw new SmokeFailure(
        "Lifecycle receipt replay reopened or changed the terminal series.",
      );
    report.checks.push("terminal-replay-preserved-source");
    await verifyNoRtdbInvite(inviteId, host, dependencies);
    report.checks.push("api-source-without-rtdb-invite-shadow");
  } catch (error) {
    failure =
      error instanceof SmokeFailure
        ? error
        : new SmokeFailure("Lifecycle smoke failed.");
  } finally {
    channel?.close();
    if (!terminal && createAttempted && sessions.length === 2) {
      const [host, guest] = sessions;
      try {
        if (!paired) {
          await apiRequest(
            validated,
            "/invites/create",
            host,
            operationBody("create"),
            dependencies,
          );
          await apiRequest(
            validated,
            "/invites/join",
            guest,
            operationBody("join"),
            dependencies,
          );
        }
        const ended = await apiRequest(
          validated,
          "/rematches/end",
          host,
          operationBody("end", false),
          dependencies,
        );
        if (
          !isEndRematchResponse(ended) ||
          ended.inviteId !== inviteId ||
          ended.actorUid !== host.uid ||
          !ended.rematches.endsWith("x")
        ) {
          failure = new SmokeFailure(
            "Lifecycle smoke failed and could not confirm terminal series cleanup.",
          );
        } else terminal = true;
      } catch {
        failure = new SmokeFailure(
          "Lifecycle smoke failed and could not confirm terminal series cleanup.",
        );
      }
    }
    const deleted = await Promise.allSettled(
      sessions.map((session) =>
        retry(() =>
          identityRequest(
            "accounts:delete",
            { idToken: session.idToken },
            dependencies,
          ),
        ),
      ),
    );
    if (deleted.some((result) => result.status === "rejected"))
      failure = new SmokeFailure(
        "Lifecycle smoke could not delete every temporary anonymous session.",
      );
    else if (sessions.length === 2)
      report.checks.push("temporary-anonymous-sessions-deleted");
    dependencies.log(JSON.stringify(report));
  }
  if (failure) throw failure;
  if (validated.output) {
    try {
      writeFileSync(validated.output, `${JSON.stringify(report, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    } catch {
      throw new SmokeFailure(
        "Lifecycle smoke passed but could not create its report file.",
      );
    }
  }
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    runSmoke(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
      console.error(
        error instanceof SmokeFailure
          ? error.message
          : "Lifecycle smoke failed.",
      );
      process.exitCode = 1;
    });
  } catch {
    console.error(usage());
    process.exitCode = 1;
  }
}

export { parseArgs, runSmoke };
export type { Dependencies, Options, Report, SmokeSocket };
