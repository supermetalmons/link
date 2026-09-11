const { WebSocket }: typeof import("ws") = require("ws");
const {
  normalizeRecordKey,
}: typeof import("@mons/shared/ids") = require("@mons/shared/ids");
const {
  INVITE_METADATA_MAX_MESSAGE_BYTES,
  INVITE_METADATA_SOCKET_PROTOCOL,
  isInviteMetadataMessage,
  isReadInviteMetadataResponse,
}: typeof import("@mons/shared/invite-metadata") = require("@mons/shared/invite-metadata");
const {
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
}: typeof import("@mons/shared/reactions") = require("@mons/shared/reactions");

const SMOKE_TIMEOUT_MS = 30_000;
const SOCKET_TIMEOUT_MS = 10_000;
const ORIGIN = "https://mons.link";
const PREVIEW_HOST_PATTERN =
  /^[0-9a-f]{8}-mons-link-api\.lil-org\.workers\.dev$/;

type Options = { baseUrl: string; inviteId: string };
type Dependencies = {
  fetch: typeof fetch;
  connect: (
    url: string,
    options: import("ws").ClientOptions,
    protocol: string,
  ) => import("ws").WebSocket;
  log: (message: string) => void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  now?: () => number;
};

function usage(): string {
  return "Usage: npm run smoke:invite-metadata -- --base-url <https-api-url> --invite-id <existing-paired-invite-id>";
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
    normalizeRecordKey(options.inviteId) !== options.inviteId
  ) {
    throw new TypeError(usage());
  }
  return { baseUrl: url.origin, inviteId: options.inviteId };
}

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      (key !== "--base-url" && key !== "--invite-id") ||
      !value ||
      values.has(key)
    ) {
      throw new TypeError(usage());
    }
    values.set(key, value);
  }
  return validateOptions({
    baseUrl: values.get("--base-url") || "",
    inviteId: values.get("--invite-id") || "",
  });
}

function timeoutError(): Error {
  return new Error("Invite metadata smoke timed out.");
}

async function readSnapshot(
  options: Options,
  dependencies: Dependencies,
  signal: AbortSignal,
  assertCurrent: () => void,
): Promise<number> {
  let response: Response;
  try {
    response = await dependencies.fetch(
      `${options.baseUrl}/invites/${encodeURIComponent(options.inviteId)}/metadata`,
      {
        method: "GET",
        headers: { Accept: "application/json", Origin: ORIGIN },
        redirect: "error",
        cache: "no-store",
        signal,
      },
    );
  } catch {
    assertCurrent();
    throw new Error("Invite metadata smoke HTTP request failed.");
  }
  try {
    assertCurrent();
  } catch (error) {
    void response.body?.cancel().catch(() => undefined);
    throw error;
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`Invite metadata smoke HTTP returned ${response.status}.`);
  }
  if (
    Number(response.headers.get("Content-Length")) >
      INVITE_METADATA_MAX_MESSAGE_BYTES ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Invite metadata smoke received an invalid HTTP response.");
  }
  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let length = 0;
  let body = "";
  let payload: unknown;
  try {
    while (true) {
      const { done, value } = await reader.read();
      assertCurrent();
      if (done) break;
      length += value.byteLength;
      if (length > INVITE_METADATA_MAX_MESSAGE_BYTES) throw new Error();
      body += decoder.decode(value, { stream: true });
    }
    payload = JSON.parse(body + decoder.decode()) as unknown;
  } catch {
    void reader.cancel().catch(() => undefined);
    assertCurrent();
    throw new Error("Invite metadata smoke received an invalid HTTP response.");
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  if (
    !isReadInviteMetadataResponse(payload) ||
    payload.snapshot.inviteId !== options.inviteId ||
    !payload.snapshot.guestId ||
    payload.viewer.role !== "watch" ||
    payload.viewer.actorUid !== null ||
    payload.viewer.automatchOperationId !== null
  ) {
    throw new Error(
      "Invite metadata smoke expected a public paired snapshot with an anonymous viewer.",
    );
  }
  return payload.snapshot.revision;
}

async function smokeConnection(
  options: Options,
  dependencies: Dependencies,
  signal: AbortSignal,
  remainingMs: () => number,
  minimumRevision: number,
): Promise<number> {
  const url = new URL(
    `/invites/${encodeURIComponent(options.inviteId)}/metadata/socket`,
    options.baseUrl,
  );
  url.protocol = "wss:";
  const timeoutMs = Math.min(SOCKET_TIMEOUT_MS, remainingMs());
  return new Promise<number>((resolve, reject) => {
    let socket: import("ws").WebSocket;
    try {
      socket = dependencies.connect(
        url.href,
        {
          origin: ORIGIN,
          followRedirects: false,
          handshakeTimeout: timeoutMs,
          maxPayload: INVITE_METADATA_MAX_MESSAGE_BYTES,
          perMessageDeflate: false,
        },
        INVITE_METADATA_SOCKET_PROTOCOL,
      );
    } catch {
      reject(new Error("Invite metadata smoke could not open its WebSocket."));
      return;
    }
    let settled = false;
    let receivedSnapshot = false;
    let revision = minimumRevision;
    const onAbort = () => finish(timeoutError());
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      dependencies.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      try {
        socket.terminate();
      } catch {}
      if (error) reject(error);
      else resolve(revision);
    };
    const timer = dependencies.setTimeout(
      () => finish(timeoutError()),
      timeoutMs,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    socket.on("error", () =>
      finish(new Error("Invite metadata smoke WebSocket failed.")),
    );
    socket.on("close", () =>
      finish(
        new Error("Invite metadata smoke WebSocket closed before completion."),
      ),
    );
    socket.on("unexpected-response", (_request, response) => {
      response.destroy();
      finish(
        new Error(
          `Invite metadata smoke upgrade returned ${response.statusCode}.`,
        ),
      );
    });
    socket.on("message", (data, isBinary) => {
      if (settled) return;
      try {
        remainingMs();
      } catch {
        finish(timeoutError());
        return;
      }
      try {
        const size = Array.isArray(data)
          ? data.reduce((sum, part) => sum + part.byteLength, 0)
          : data.byteLength;
        if (
          isBinary ||
          size > INVITE_METADATA_MAX_MESSAGE_BYTES ||
          socket.protocol !== INVITE_METADATA_SOCKET_PROTOCOL
        ) {
          throw new Error(
            "Invite metadata smoke received an invalid message or protocol.",
          );
        }
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as ArrayBuffer);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (text === REACTION_HEARTBEAT_RESPONSE && receivedSnapshot) {
          finish();
          return;
        }
        const message: unknown = JSON.parse(text);
        if (
          !isInviteMetadataMessage(message) ||
          message.snapshot.inviteId !== options.inviteId ||
          !message.snapshot.guestId ||
          message.snapshot.revision < revision
        ) {
          throw new Error();
        }
        revision = message.snapshot.revision;
        if (!receivedSnapshot) {
          receivedSnapshot = true;
          socket.send(REACTION_HEARTBEAT_REQUEST, (error) => {
            if (error)
              finish(new Error("Invite metadata smoke heartbeat failed."));
          });
        }
      } catch {
        finish(
          new Error(
            "Invite metadata smoke received an invalid message or protocol.",
          ),
        );
      }
    });
    if (signal.aborted) onAbort();
  });
}

async function runSmoke(
  options: Options,
  dependencies: Dependencies = {
    fetch,
    connect: (url, options, protocol) => new WebSocket(url, protocol, options),
    log: (message) => console.log(message),
    setTimeout,
    clearTimeout,
  },
): Promise<void> {
  const validated = validateOptions(options);
  const now = dependencies.now ?? Date.now;
  const deadline = now() + SMOKE_TIMEOUT_MS;
  const controller = new AbortController();
  const remainingMs = () => {
    const remaining = deadline - now();
    if (controller.signal.aborted || remaining <= 0) throw timeoutError();
    return remaining;
  };
  let timer: ReturnType<typeof setTimeout>;
  const cancellation = new Promise<never>((_resolve, reject) => {
    timer = dependencies.setTimeout(() => {
      reject(timeoutError());
      controller.abort();
    }, SMOKE_TIMEOUT_MS);
  });
  const run = async () => {
    const revision = await readSnapshot(
      validated,
      dependencies,
      controller.signal,
      remainingMs,
    );
    remainingMs();
    dependencies.log("[invite-metadata-smoke] HTTP snapshot passed.");
    const latestRevision = await smokeConnection(
      validated,
      dependencies,
      controller.signal,
      remainingMs,
      revision,
    );
    remainingMs();
    dependencies.log(
      "[invite-metadata-smoke] Socket snapshot and heartbeat passed.",
    );
    await smokeConnection(
      validated,
      dependencies,
      controller.signal,
      remainingMs,
      latestRevision,
    );
    remainingMs();
    dependencies.log(
      "[invite-metadata-smoke] Reconnect snapshot and heartbeat passed.",
    );
  };
  try {
    await Promise.race([run(), cancellation]);
  } finally {
    dependencies.clearTimeout(timer!);
    controller.abort();
  }
}

if (require.main === module) {
  try {
    runSmoke(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
      console.error(
        error instanceof Error
          ? error.message
          : "Invite metadata smoke failed.",
      );
      process.exitCode = 1;
    });
  } catch {
    console.error(usage());
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, runSmoke };
