const { WebSocket }: typeof import("ws") = require("ws");
const {
  normalizeFirebaseKey,
}: typeof import("@mons/shared/ids") = require("@mons/shared/ids");
const {
  isInviteReactionForInvite,
  isInviteReactionMessage,
  REACTION_HEARTBEAT_REQUEST,
  REACTION_HEARTBEAT_RESPONSE,
  REACTION_MAX_MESSAGE_BYTES,
}: typeof import("@mons/shared/reactions") = require("@mons/shared/reactions");

const TIMEOUT_MS = 10_000;
const ORIGIN = "https://mons.link";
const PREVIEW_HOST_PATTERN =
  /^[0-9a-f]{8}-mons-link-api\.lil-org\.workers\.dev$/;

type Options = { baseUrl: string; inviteId: string };
type Dependencies = {
  connect: (
    url: string,
    options: import("ws").ClientOptions,
  ) => import("ws").WebSocket;
  log: (message: string) => void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

function usage(): string {
  return "Usage: npm run smoke:reactions -- --base-url <https-api-url> --invite-id <existing-paired-invite-id>";
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
    normalizeFirebaseKey(options.inviteId) !== options.inviteId
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

async function smokeConnection(
  options: Options,
  dependencies: Dependencies,
): Promise<void> {
  const url = new URL(
    `/invites/${encodeURIComponent(options.inviteId)}/reactions/socket`,
    options.baseUrl,
  );
  url.protocol = "wss:";
  await new Promise<void>((resolve, reject) => {
    let socket: import("ws").WebSocket;
    try {
      socket = dependencies.connect(url.href, {
        origin: ORIGIN,
        followRedirects: false,
        handshakeTimeout: TIMEOUT_MS,
        maxPayload: REACTION_MAX_MESSAGE_BYTES,
        perMessageDeflate: false,
      });
    } catch {
      reject(new Error("Reaction smoke could not open its WebSocket."));
      return;
    }
    let settled = false;
    let snapshotReceived = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      dependencies.clearTimeout(timeout);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.terminate();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const timeout = dependencies.setTimeout(
      () => finish(new Error("Reaction smoke timed out.")),
      TIMEOUT_MS,
    );
    socket.on("error", () =>
      finish(new Error("Reaction smoke WebSocket failed.")),
    );
    socket.on("close", () =>
      finish(new Error("Reaction smoke WebSocket closed before completion.")),
    );
    socket.on("unexpected-response", (_request, response) => {
      response.destroy();
      finish(
        new Error(`Reaction smoke upgrade returned ${response.statusCode}.`),
      );
    });
    socket.on("message", (data, isBinary) => {
      if (settled) {
        return;
      }
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
      if (isBinary || bytes.byteLength > REACTION_MAX_MESSAGE_BYTES) {
        finish(new Error("Reaction smoke received an invalid message."));
        return;
      }
      const text = bytes.toString("utf8");
      if (text === REACTION_HEARTBEAT_RESPONSE && snapshotReceived) {
        finish();
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(text) as unknown;
      } catch {
        finish(new Error("Reaction smoke received an invalid message."));
        return;
      }
      if (
        !isInviteReactionMessage(message) ||
        (!snapshotReceived && message.type !== "snapshot") ||
        (snapshotReceived && message.type === "snapshot")
      ) {
        finish(new Error("Reaction smoke received an invalid message."));
        return;
      }
      const reactions =
        message.type === "snapshot"
          ? Object.values(message.reactions)
          : [message.reaction];
      if (
        reactions.some(
          (reaction) => !isInviteReactionForInvite(options.inviteId, reaction),
        )
      ) {
        finish(new Error("Reaction smoke received another invite's reaction."));
        return;
      }
      if (message.type === "snapshot") {
        snapshotReceived = true;
        socket.send(REACTION_HEARTBEAT_REQUEST, (error) => {
          if (error) {
            finish(new Error("Reaction smoke heartbeat failed."));
          }
        });
      }
    });
  });
}

async function smokeReactions(
  options: Options,
  dependencies: Dependencies = {
    connect: (url, options) => new WebSocket(url, options),
    log: (message) => console.log(message),
    setTimeout,
    clearTimeout,
  },
): Promise<void> {
  const validated = validateOptions(options);
  await smokeConnection(validated, dependencies);
  await smokeConnection(validated, dependencies);
  dependencies.log(
    `[reactions-smoke] Passed read-only snapshot, heartbeat and reconnect on ${validated.baseUrl}`,
  );
}

if (require.main === module) {
  try {
    smokeReactions(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
      console.error(
        error instanceof Error ? error.message : "Reaction smoke failed.",
      );
      process.exitCode = 1;
    });
  } catch {
    console.error(usage());
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, smokeReactions };
