import {
  createToolSession,
  refreshToolSession,
  revokeToolSession,
  SessionRequestError,
  type ToolSession,
} from "./cloudflare/sessions.ts";
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
  isJoinInviteResponse,
  isProposeRematchResponse,
  isSurrenderMatchResponse,
  isSubmitMoveResponse,
  isReadMatchSnapshotResponse,
  MATCH_MOVE_PATH,
  countMoveHistory,
  normalizeMatchSnapshot,
  type SubmitMoveRequest,
  type GameSessionMatch,
} from "@mons/shared/game-sessions";
import { INVITE_ID_RANDOM_LENGTH } from "@mons/shared/ids";
import {
  INVITE_METADATA_MAX_MESSAGE_BYTES,
  INVITE_METADATA_SOCKET_PROTOCOL,
  isInviteMetadataMessage,
  isReadInviteMetadataResponse,
} from "@mons/shared/invite-metadata";
import type { InviteMetadataSnapshot } from "@mons/shared/invite-metadata";
import {
  MATCH_SYNC_MAX_MESSAGE_BYTES,
  MATCH_SYNC_SOCKET_PROTOCOL,
  isMatchSyncMessage,
  isReadMatchSyncResponse,
  type MatchSyncSnapshot,
} from "@mons/shared/match-sync";
import {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
} from "@mons/shared/reactions";
import {
  isStartMatchTimerResponse,
  parseStrictMatchTimer,
} from "@mons/shared/timers";

const ORIGIN = "https://mons.link";
const PREVIEW_HOST_PATTERN =
  /^[0-9a-f]{8}-mons-link-api\.lil-org\.workers\.dev$/;
const REQUEST_TIMEOUT_MS = 15_000;
const SOCKET_TIMEOUT_MS = 15_000;
const MATCH_UPDATE_TIMEOUT_MS = 30_000;
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
};
type Session = ToolSession;
type OperationName = (typeof OPERATION_NAMES)[number];
type Operations = Record<OperationName, string>;
type SmokeSocket = {
  protocol: string;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeAllListeners(): unknown;
  send(data: string): unknown;
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
  matchStorage: "durable";
};
type HttpResult = { status: number; headers: Headers; payload: unknown };
type MatchRecord = GameSessionMatch;

class SmokeFailure extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

function usage(): string {
  return "Usage: npm run smoke:invite-lifecycle -- --base-url <https-api-url> [--output <report-json-file>]";
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
    Object.keys(options).some((key) => key !== "baseUrl" && key !== "output")
  )
    throw new TypeError(usage());
  return {
    baseUrl: url.origin,
    ...(options.output ? { output: options.output } : {}),
  };
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
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
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(
  response: Response,
  signal: AbortSignal,
  maxBytes = INVITE_METADATA_MAX_MESSAGE_BYTES,
): Promise<unknown> {
  if (
    !response.body ||
    Number(response.headers.get("Content-Length")) > maxBytes
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
      if (bytes > maxBytes) throw new Error();
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
  maxBytes = INVITE_METADATA_MAX_MESSAGE_BYTES,
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
      payload: await readJson(response, controller.signal, maxBytes),
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
        !(
          error instanceof SmokeFailure || error instanceof SessionRequestError
        ) ||
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

async function apiRequest(
  options: Options,
  path: string,
  session: Session,
  body: Record<string, unknown> | null,
  dependencies: Dependencies,
  maxBytes = INVITE_METADATA_MAX_MESSAGE_BYTES,
): Promise<unknown> {
  return retry(async () => {
    await refreshSession(options, session, dependencies);
    const result = await requestJson(
      `${options.baseUrl}${path}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          Origin: ORIGIN,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      dependencies,
      maxBytes,
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

async function refreshSession(
  options: Options,
  session: Session,
  dependencies: Dependencies,
): Promise<void> {
  if (session.accessExpiresAtMs <= dependencies.now() + 30_000)
    Object.assign(
      session,
      await refreshToolSession(options.baseUrl, session, dependencies.fetch),
    );
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

type MatchSyncState = Omit<MatchSyncSnapshot, "revision">;

function matchSyncState(snapshot: MatchSyncSnapshot): MatchSyncState {
  const { revision: _revision, ...state } = snapshot;
  return state;
}

function socketCloseDetail(code: unknown, reason: unknown): string {
  const value = Buffer.isBuffer(reason) ? reason.toString("utf8") : reason;
  const known = [
    "Session expired",
    "Invite access changed",
    "Invite unavailable",
    "Match unavailable",
    "Match source unavailable",
    "Match admission failed",
    "Invite metadata unavailable",
    "Reaction sockets are receive-only",
    "Reaction connection failed",
    "Socket delivery failed",
  ];
  return `${typeof code === "number" ? code : "unknown"}; ${typeof value === "string" && known.includes(value) ? value : "unrecognized reason"}`;
}

function openMatchChannel(
  options: Options,
  inviteId: string,
  matchId: string,
  session: Session | null,
  dependencies: Dependencies,
  minimumRevision = 0,
  previous: MatchSyncSnapshot | null = null,
) {
  const expiresAtMs = session?.accessExpiresAtMs;
  let socket: SmokeSocket;
  try {
    socket = dependencies.connect(
      `${options.baseUrl.replace(/^https:/, "wss:")}/invites/${inviteId}/matches/${matchId}/socket`,
      {
        origin: ORIGIN,
        ...(session
          ? { headers: { Authorization: `Bearer ${session.accessToken}` } }
          : {}),
        followRedirects: false,
        handshakeTimeout: SOCKET_TIMEOUT_MS,
        maxPayload: MATCH_SYNC_MAX_MESSAGE_BYTES,
        perMessageDeflate: false,
      },
      MATCH_SYNC_SOCKET_PROTOCOL,
    );
  } catch {
    throw new SmokeFailure("Lifecycle match socket could not connect.");
  }
  let current: MatchSyncSnapshot | null = null;
  let failure: SmokeFailure | null = null;
  let closed = false;
  let heartbeatReceived = false;
  const waiting = new Set<() => void>();
  const notify = () => {
    for (const check of waiting) check();
  };
  const fail = (message: string) => {
    failure ||= new SmokeFailure(message);
    notify();
  };
  socket.on("error", () => fail("Lifecycle match socket failed."));
  socket.on("close", (code, reason) => {
    if (
      !closed &&
      !(
        code === 4001 &&
        expiresAtMs !== undefined &&
        expiresAtMs <= dependencies.now()
      )
    )
      fail(
        `Lifecycle match socket closed early (${socketCloseDetail(code, reason)}).`,
      );
  });
  socket.on("unexpected-response", (_request, response) => {
    if (record(response) && typeof response.destroy === "function")
      response.destroy();
    fail("Lifecycle match socket upgrade failed.");
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
        bytes.byteLength > MATCH_SYNC_MAX_MESSAGE_BYTES ||
        socket.protocol !== MATCH_SYNC_SOCKET_PROTOCOL
      )
        throw new Error();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text === REACTION_HEARTBEAT_RESPONSE) {
        heartbeatReceived = true;
        notify();
        return;
      }
      const payload: unknown = JSON.parse(text);
      if (
        !isMatchSyncMessage(payload) ||
        payload.snapshot.inviteId !== inviteId ||
        payload.snapshot.matchId !== matchId ||
        payload.snapshot.revision < minimumRevision ||
        (previous &&
          (payload.snapshot.revision < previous.revision ||
            (payload.snapshot.revision === previous.revision &&
              !isDeepStrictEqual(payload.snapshot, previous)))) ||
        (current &&
          (payload.snapshot.revision < current.revision ||
            (payload.snapshot.revision === current.revision &&
              !isDeepStrictEqual(payload.snapshot, current))))
      )
        throw new Error();
      current = payload.snapshot;
      notify();
    } catch {
      fail("Lifecycle match socket received an invalid snapshot.");
    }
  });
  const timeoutDetail = (expected: MatchSyncState): string => {
    const observed = current ?? previous;
    const describe = (name: string, value: MatchSyncSnapshot["hostMatch"]) => {
      const status =
        value === null
          ? "missing"
          : value.status === ""
            ? "empty"
            : value.status === "surrendered"
              ? "surrendered"
              : "other";
      return `${name}Moves=${value === null ? "missing" : countMoveHistory(value.flatMovesString)}; ${name}Status=${status}`;
    };
    return `matchId=${matchId}; currentRevision=${observed?.revision ?? "missing"}; ${describe("expectedHost", expected.hostMatch)}; ${describe("expectedGuest", expected.guestMatch)}; ${describe("currentHost", observed?.hostMatch ?? null)}; ${describe("currentGuest", observed?.guestMatch ?? null)}`;
  };
  const waitFor = (
    ready: () => boolean,
    label: string,
    timeoutMs = SOCKET_TIMEOUT_MS,
    diagnostics?: () => string,
  ): Promise<void> =>
    new Promise((resolveWait, reject) => {
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
          finish(new SmokeFailure("Lifecycle match socket was closed."));
        else if (ready()) finish();
      };
      waiting.add(check);
      timer = dependencies.setTimeout(
        () =>
          finish(
            new SmokeFailure(
              `Lifecycle match ${label} timed out.${diagnostics ? ` ${diagnostics()}` : ""}`,
            ),
          ),
        timeoutMs,
      );
      check();
    });
  return {
    get snapshot() {
      return current ?? previous;
    },
    assertHealthy() {
      if (failure) throw failure;
    },
    async waitFor(expected: MatchSyncState): Promise<MatchSyncSnapshot> {
      await waitFor(
        () =>
          current !== null &&
          isDeepStrictEqual(matchSyncState(current), expected),
        "update",
        MATCH_UPDATE_TIMEOUT_MS,
        () => timeoutDetail(expected),
      );
      return current!;
    },
    async heartbeat(): Promise<void> {
      await waitFor(() => current !== null, "initial snapshot");
      heartbeatReceived = false;
      const pending = waitFor(() => heartbeatReceived, "heartbeat");
      try {
        socket.send(REACTION_HEARTBEAT_REQUEST);
      } catch {
        fail("Lifecycle match heartbeat could not be sent.");
      }
      await pending;
    },
    close() {
      if (closed) return;
      closed = true;
      notify();
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      try {
        socket.terminate();
      } catch {}
    },
  };
}

function renewingChannel<
  TSnapshot,
  TChannel extends {
    readonly snapshot: TSnapshot | null;
    assertHealthy(): void;
    close(): void;
  },
>(
  options: Options,
  session: Session | null,
  dependencies: Dependencies,
  open: (previous: TSnapshot | null) => TChannel,
  renewalHorizonMs = SOCKET_TIMEOUT_MS,
) {
  let current: TChannel | null = null;
  let expiresAtMs: number | undefined;
  let pending: Promise<TChannel> | null = null;
  let closed = false;
  return {
    ready(): Promise<TChannel> {
      if (closed)
        return Promise.reject(new SmokeFailure("Lifecycle socket was closed."));
      if (!pending) {
        pending = (async () => {
          current?.assertHealthy();
          if (
            !current ||
            (expiresAtMs !== undefined &&
              expiresAtMs <= dependencies.now() + renewalHorizonMs)
          ) {
            const previous = current?.snapshot ?? null;
            current?.close();
            if (session) await refreshSession(options, session, dependencies);
            if (closed) throw new SmokeFailure("Lifecycle socket was closed.");
            expiresAtMs = session?.accessExpiresAtMs;
            current = open(previous);
          }
          return current;
        })().finally(() => {
          pending = null;
        });
      }
      return pending;
    },
    close() {
      closed = true;
      current?.close();
    },
  };
}

function matchChannel(
  options: Options,
  inviteId: string,
  matchId: string,
  session: Session | null,
  dependencies: Dependencies,
  minimumRevision = 0,
) {
  const channel = renewingChannel(
    options,
    session,
    dependencies,
    (previous: MatchSyncSnapshot | null) =>
      openMatchChannel(
        options,
        inviteId,
        matchId,
        session,
        dependencies,
        minimumRevision,
        previous,
      ),
    MATCH_UPDATE_TIMEOUT_MS,
  );
  return {
    waitFor: async (expected: MatchSyncState) =>
      (await channel.ready()).waitFor(expected),
    heartbeat: async () => (await channel.ready()).heartbeat(),
    close: () => channel.close(),
  };
}

type MatchChannel = ReturnType<typeof matchChannel>;

async function verifyMatchChannels(
  options: Options,
  inviteId: string,
  matchId: string,
  host: Session,
  guest: Session | null,
  guestCreated: boolean,
  channels: MatchChannel[],
  dependencies: Dependencies,
): Promise<MatchSyncSnapshot> {
  const hostValue = (await readMatch(host.uid, matchId, dependencies, options))
    .value;
  const guestValue =
    guestCreated && guest
      ? (await readMatch(guest.uid, matchId, dependencies, options)).value
      : null;
  const expected: MatchSyncState = {
    inviteId,
    matchId,
    hostPlayerId: host.uid,
    guestPlayerId: guest?.uid ?? null,
    hostMatch: normalizeMatchSnapshot(hostValue),
    guestMatch: guestValue ? normalizeMatchSnapshot(guestValue) : null,
  };
  if (!expected.hostMatch || (guestCreated && !expected.guestMatch))
    throw new SmokeFailure("Lifecycle match source was invalid.");
  const observed = await Promise.all(
    channels.map((channel) => channel.waitFor(expected)),
  );
  const response = await apiRequest(
    options,
    `/invites/${inviteId}/matches/${matchId}/snapshot`,
    host,
    null,
    dependencies,
    MATCH_SYNC_MAX_MESSAGE_BYTES,
  );
  if (
    !isReadMatchSyncResponse(response) ||
    !isDeepStrictEqual(matchSyncState(response.snapshot), expected) ||
    observed.some((snapshot) => snapshot.revision > response.snapshot.revision)
  )
    throw new SmokeFailure(
      "Lifecycle match HTTP and socket snapshots disagreed.",
    );
  return response.snapshot;
}

function openMetadataChannel(
  options: Options,
  inviteId: string,
  session: Session,
  dependencies: Dependencies,
  previous: InviteMetadataSnapshot | null = null,
) {
  const expiresAtMs = session.accessExpiresAtMs;
  let socket: SmokeSocket;
  try {
    socket = dependencies.connect(
      `${options.baseUrl.replace(/^https:/, "wss:")}/invites/${inviteId}/metadata/socket`,
      {
        origin: ORIGIN,
        headers: { Authorization: `Bearer ${session.accessToken}` },
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
  socket.on("close", (code, reason) => {
    if (!closed && !(code === 4001 && expiresAtMs <= dependencies.now()))
      fail(
        `Lifecycle metadata socket closed early (${socketCloseDetail(code, reason)}).`,
      );
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
        (previous &&
          (payload.snapshot.revision < previous.revision ||
            (payload.snapshot.revision === previous.revision &&
              !isDeepStrictEqual(payload.snapshot, previous)))) ||
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
    get snapshot() {
      return current ?? previous;
    },
    assertHealthy() {
      if (failure) throw failure;
    },
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

function metadataChannel(
  options: Options,
  inviteId: string,
  session: Session,
  dependencies: Dependencies,
) {
  const channel = renewingChannel(
    options,
    session,
    dependencies,
    (previous: InviteMetadataSnapshot | null) =>
      openMetadataChannel(options, inviteId, session, dependencies, previous),
  );
  return {
    waitFor: async (expected: InviteMetadataSnapshot) =>
      (await channel.ready()).waitFor(expected),
    close: () => channel.close(),
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

async function readMatch(
  uid: string,
  matchId: string,
  dependencies: Dependencies,
  options: Options,
) {
  const query = new URLSearchParams({ playerId: uid, matchId });
  return retry(async () => {
    const result = await requestJson(
      `${options.baseUrl}/matches/snapshot?${query}`,
      { headers: { Accept: "application/json", Origin: ORIGIN } },
      dependencies,
      MATCH_SYNC_MAX_MESSAGE_BYTES,
    );
    expectOk(result, "Lifecycle canonical match read");
    if (
      !isReadMatchSnapshotResponse(result.payload) ||
      result.payload.playerId !== uid ||
      result.payload.matchId !== matchId ||
      !result.payload.match ||
      result.headers.get("Access-Control-Allow-Origin") !== "*" ||
      !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(
        result.headers.get("Cache-Control") || "",
      )
    )
      throw new SmokeFailure("Lifecycle canonical match snapshot was invalid.");
    return { value: result.payload.match };
  });
}

function playLegalMove(active: Game): string {
  const inputs: Input[] = [];
  for (let step = 0; step < 8; step++) {
    const next = active.preview(inputs);
    if (next.kind === "complete") {
      const played = active.play(inputs);
      if (played.kind === "complete") return played.inputFen;
      break;
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
}

function nextLegalMatch(value: MatchRecord): MatchRecord {
  const active = Game.fromFen(String(value.fen));
  if (!active || active.activeColor !== value.color)
    throw new SmokeFailure("Lifecycle mover did not own the active turn.");
  const move = playLegalMove(active);
  return {
    ...value,
    fen: active.toFen(),
    flatMovesString: value.flatMovesString
      ? `${value.flatMovesString}-${move}`
      : move,
  };
}

function cumulativeMoveRequests(
  inviteId: string,
  matchId: string,
  playerId: string,
  current: MatchRecord,
): SubmitMoveRequest[] {
  const active = Game.fromFen(String(current.fen));
  if (!active || active.activeColor !== current.color)
    throw new SmokeFailure(
      "Lifecycle cumulative mover did not own the active turn.",
    );
  let history = String(current.flatMovesString);
  const previousStates: { moveCount: number; fen: string }[] = [];
  const requests: SubmitMoveRequest[] = [];
  for (let index = 0; index < 4; index++) {
    previousStates.push({
      moveCount: countMoveHistory(history),
      fen: active.toFen(),
    });
    let move: string;
    if (index === 2) {
      const output = active.takeback();
      if (output.kind !== "complete")
        throw new SmokeFailure("Lifecycle takeback could not be generated.");
      move = output.inputFen;
    } else move = playLegalMove(active);
    history = history ? `${history}-${move}` : move;
    requests.push({
      inviteId,
      matchId,
      playerId,
      previousFlatMovesString: String(current.flatMovesString),
      flatMovesString: history,
      fen: active.toFen(),
      gameVariant: String(current.gameVariant),
      previousStates: previousStates.map((state) => ({ ...state })),
    });
  }
  if (
    requests[1].fen !== requests[3].fen ||
    requests[1].flatMovesString === requests[3].flatMovesString
  )
    throw new SmokeFailure(
      "Lifecycle takeback sequence did not retain distinct history at the same FEN.",
    );
  return requests;
}

async function verifyLiveMatch(
  options: Options,
  inviteId: string,
  host: Session,
  guest: Session,
  matchId: string,
  channels: MatchChannel[],
  dependencies: Dependencies,
): Promise<void> {
  const hostMatch = await readMatch(host.uid, matchId, dependencies, options);
  const game = Game.fromFen(String(hostMatch.value.fen));
  if (!game)
    throw new SmokeFailure("Lifecycle live match could not load its game.");
  const mover = game.activeColor === hostMatch.value.color ? host : guest;
  const opponent = mover === host ? guest : host;
  const current =
    mover === host
      ? hostMatch
      : await readMatch(mover.uid, matchId, dependencies, options);
  await verifyCanonicalTimer(
    options,
    inviteId,
    matchId,
    opponent,
    mover,
    dependencies,
  );
  await verifyMatchChannels(
    options,
    inviteId,
    matchId,
    host,
    guest,
    true,
    channels,
    dependencies,
  );
  const burst = cumulativeMoveRequests(
    inviteId,
    matchId,
    mover.uid,
    current.value,
  );
  const latest = burst[burst.length - 1];
  const cumulativeMatch = {
    ...current.value,
    fen: latest.fen,
    flatMovesString: latest.flatMovesString,
  };
  for (const [request, expectedOutcome] of [
    [latest, null],
    [burst[0], "superseded"],
    [latest, "already-applied"],
  ] as const) {
    const result = await apiRequest(
      options,
      MATCH_MOVE_PATH,
      mover,
      request,
      dependencies,
    );
    if (
      !isSubmitMoveResponse(result) ||
      result.inviteId !== inviteId ||
      result.matchId !== matchId ||
      result.actorUid !== mover.uid ||
      (expectedOutcome !== null && result.outcome !== expectedOutcome) ||
      (expectedOutcome === null && result.outcome === "superseded") ||
      (result.outcome === "superseded" &&
        (result.fen !== latest.fen ||
          result.flatMovesString !== latest.flatMovesString))
    )
      throw new SmokeFailure(
        "Lifecycle cumulative API move returned an unexpected acknowledgement.",
      );
    if (
      !isDeepStrictEqual(
        (await readMatch(mover.uid, matchId, dependencies, options)).value,
        cumulativeMatch,
      )
    )
      throw new SmokeFailure(
        "Lifecycle API move changed other state or was not observed by the opponent.",
      );
    await verifyMatchChannels(
      options,
      inviteId,
      matchId,
      host,
      guest,
      true,
      channels,
      dependencies,
    );
  }
  const legacyMatch = nextLegalMatch(cumulativeMatch);
  const legacy = {
    inviteId,
    matchId,
    playerId: mover.uid,
    previousFlatMovesString: latest.flatMovesString,
    flatMovesString: legacyMatch.flatMovesString,
    fen: legacyMatch.fen,
    gameVariant: legacyMatch.gameVariant,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await apiRequest(
      options,
      MATCH_MOVE_PATH,
      mover,
      legacy,
      dependencies,
    );
    if (
      !isSubmitMoveResponse(result) ||
      result.inviteId !== inviteId ||
      result.matchId !== matchId ||
      result.actorUid !== mover.uid ||
      result.outcome === "superseded" ||
      (attempt === 1 && result.outcome !== "already-applied")
    )
      throw new SmokeFailure(
        "Lifecycle legacy API move returned an unexpected acknowledgement.",
      );
    if (
      !isDeepStrictEqual(
        (await readMatch(mover.uid, matchId, dependencies, options)).value,
        legacyMatch,
      )
    )
      throw new SmokeFailure(
        "Lifecycle legacy API move changed unexpected match state.",
      );
    await verifyMatchChannels(
      options,
      inviteId,
      matchId,
      host,
      guest,
      true,
      channels,
      dependencies,
    );
  }
  const before = await readMatch(host.uid, matchId, dependencies, options);
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
  const observed = await readMatch(host.uid, matchId, dependencies, options);
  if (
    !isDeepStrictEqual(observed.value, {
      ...before.value,
      status: "surrendered",
    })
  )
    throw new SmokeFailure(
      "Lifecycle API surrender changed other state or was not observed by the opponent.",
    );
  const final = await verifyMatchChannels(
    options,
    inviteId,
    matchId,
    host,
    guest,
    true,
    channels,
    dependencies,
  );
  const reconnect = matchChannel(
    options,
    inviteId,
    matchId,
    guest,
    dependencies,
    final.revision,
  );
  try {
    await reconnect.waitFor(matchSyncState(final));
    await reconnect.heartbeat();
  } finally {
    reconnect.close();
  }
}

async function verifyCanonicalTimer(
  options: Options,
  inviteId: string,
  matchId: string,
  player: Session,
  opponent: Session,
  dependencies: Dependencies,
): Promise<void> {
  const before = await readMatch(player.uid, matchId, dependencies, options);
  const body = {
    inviteId,
    matchId,
    playerId: player.uid,
    opponentId: opponent.uid,
  };
  const started = await apiRequest(
    options,
    "/matches/timer/start",
    player,
    body,
    dependencies,
  );
  if (
    !isStartMatchTimerResponse(started) ||
    !parseStrictMatchTimer(started.timer)
  )
    throw new SmokeFailure("Lifecycle canonical timer start was invalid.");
  const observed = await readMatch(player.uid, matchId, dependencies, options);
  if (
    !isDeepStrictEqual(observed.value, {
      ...before.value,
      timer: started.timer,
    })
  )
    throw new SmokeFailure(
      "Lifecycle canonical timer changed unexpected match state.",
    );
  const repeated = await apiRequest(
    options,
    "/matches/timer/start",
    player,
    body,
    dependencies,
  );
  if (
    !isStartMatchTimerResponse(repeated) ||
    repeated.timer !== started.timer ||
    repeated.duration !== started.duration
  )
    throw new SmokeFailure(
      "Lifecycle canonical timer retry changed its original deadline.",
    );
  const final = await readMatch(player.uid, matchId, dependencies, options);
  if (!isDeepStrictEqual(final.value, observed.value))
    throw new SmokeFailure(
      "Lifecycle canonical timer retry changed match state.",
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
    matchStorage: "durable",
  };
  dependencies.log(JSON.stringify({ inviteId, operationIds }));
  const sessions: Session[] = [];
  const matchChannels: MatchChannel[] = [];
  let activeMatchChannels: MatchChannel[] = [];
  const observeMatch = (matchId: string, session: Session | null) => {
    const socket = matchChannel(
      validated,
      inviteId,
      matchId,
      session,
      dependencies,
    );
    matchChannels.push(socket);
    activeMatchChannels.push(socket);
    return socket;
  };
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
    sessions.push(
      await createToolSession(validated.baseUrl, dependencies.fetch),
    );
    report.hostUid = sessions[0].uid;
    sessions.push(
      await createToolSession(validated.baseUrl, dependencies.fetch),
    );
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
    channel = metadataChannel(validated, inviteId, host, dependencies);
    await channel.waitFor(snapshot);
    report.checks.push("pending-http-and-authenticated-socket");
    const hostMatchChannel = observeMatch(inviteId, host);
    await verifyMatchChannels(
      validated,
      inviteId,
      inviteId,
      host,
      null,
      false,
      activeMatchChannels,
      dependencies,
    );
    await hostMatchChannel.heartbeat();
    report.checks.push("pending-match-http-socket-and-heartbeat");
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
    await verifyMatchChannels(
      validated,
      inviteId,
      inviteId,
      host,
      guest,
      true,
      activeMatchChannels,
      dependencies,
    );
    observeMatch(inviteId, guest);
    observeMatch(inviteId, null);
    await verifyMatchChannels(
      validated,
      inviteId,
      inviteId,
      host,
      guest,
      true,
      activeMatchChannels,
      dependencies,
    );
    report.checks.push("join-live-match-and-public-spectator");
    await verifyLiveMatch(
      validated,
      inviteId,
      host,
      guest,
      inviteId,
      activeMatchChannels,
      dependencies,
    );
    report.checks.push("api-move-surrender-replay-and-opponent-read");
    report.checks.push("cumulative-moves-takebacks-and-reordered-replay");
    report.checks.push("live-match-moves-takebacks-surrender-and-reconnect");
    report.checks.push("canonical-timer-start-and-original-deadline-replay");
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
    for (const socket of activeMatchChannels) socket.close();
    activeMatchChannels = [];
    observeMatch(`${inviteId}1`, host);
    await verifyMatchChannels(
      validated,
      inviteId,
      `${inviteId}1`,
      host,
      guest,
      false,
      activeMatchChannels,
      dependencies,
    );
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
    await verifyMatchChannels(
      validated,
      inviteId,
      `${inviteId}1`,
      host,
      guest,
      true,
      activeMatchChannels,
      dependencies,
    );
    observeMatch(`${inviteId}1`, guest);
    observeMatch(`${inviteId}1`, null);
    await verifyMatchChannels(
      validated,
      inviteId,
      `${inviteId}1`,
      host,
      guest,
      true,
      activeMatchChannels,
      dependencies,
    );
    await verifyLiveMatch(
      validated,
      inviteId,
      host,
      guest,
      `${inviteId}1`,
      activeMatchChannels,
      dependencies,
    );
    report.checks.push("api-rematch-move-surrender-replay-and-opponent-read");
    report.checks.push("rematch-live-creation-moves-surrender-and-reconnect");
    report.checks.push("canonical-rematch-timer-deadline-replay");
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
  } catch (error) {
    failure =
      error instanceof SmokeFailure
        ? error
        : new SmokeFailure(
            error instanceof Error && /^Cloudflare session /.test(error.message)
              ? error.message
              : "Lifecycle smoke failed.",
          );
  } finally {
    channel?.close();
    for (const socket of matchChannels) socket.close();
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
          revokeToolSession(
            validated.baseUrl,
            session.revokeToken,
            dependencies.fetch,
          ),
        ),
      ),
    );
    if (deleted.some((result) => result.status === "rejected"))
      failure = new SmokeFailure(
        "Lifecycle smoke could not revoke every temporary anonymous session.",
      );
    else if (sessions.length === 2)
      report.checks.push("temporary-anonymous-sessions-revoked");
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
