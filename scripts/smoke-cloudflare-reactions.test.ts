const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { EventEmitter }: typeof import("node:events") = require("node:events");
const test: typeof import("node:test") = require("node:test");
const { parseArgs, smokeReactions } =
  require("./smoke-cloudflare-reactions.ts") as {
    parseArgs: (argv: string[]) => { baseUrl: string; inviteId: string };
    smokeReactions: (
      options: { baseUrl: string; inviteId: string },
      dependencies: {
        connect: (
          url: string,
          options: import("ws").ClientOptions,
        ) => import("ws").WebSocket;
        log: (message: string) => void;
        setTimeout: typeof setTimeout;
        clearTimeout: typeof clearTimeout;
      },
    ) => Promise<void>;
  };

const OPTIONS = { baseUrl: "https://api.mons.link", inviteId: "invite1" };
const REACTION = {
  uuid: "12345678-1234-4000-8000-123456789012",
  kind: "yo",
  variation: 1,
  matchId: "invite1",
};
const SNAPSHOT = {
  schemaVersion: 1,
  type: "snapshot",
  reactions: { host: REACTION },
};

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  terminated = 0;
  respond = true;
  sendError: Error | undefined;

  send(message: string, callback: (error?: Error) => void): void {
    this.sent.push(message);
    callback(this.sendError);
    if (this.respond && !this.sendError) {
      queueMicrotask(() => this.emit("message", Buffer.from("pong"), false));
    }
  }

  terminate(): void {
    this.terminated += 1;
    this.emit("error", new Error("ignored after termination"));
  }
}

function harness(
  opened: (socket: FakeSocket) => void = (socket) => {
    socket.emit("message", Buffer.from(JSON.stringify(SNAPSHOT)), false);
  },
) {
  const sockets: FakeSocket[] = [];
  const requests: { url: string; options: import("ws").ClientOptions }[] = [];
  const logs: string[] = [];
  const timers = new Map<NodeJS.Timeout, () => void>();
  const dependencies = {
    connect: (url: string, options: import("ws").ClientOptions) => {
      requests.push({ url, options });
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => opened(socket));
      return socket as unknown as import("ws").WebSocket;
    },
    log: (message: string) => logs.push(message),
    setTimeout: ((callback: () => void, milliseconds: number) => {
      assert.equal(milliseconds, 10_000);
      const timer = {} as NodeJS.Timeout;
      timers.set(timer, callback);
      return timer;
    }) as typeof setTimeout,
    clearTimeout: ((timer: NodeJS.Timeout) => {
      timers.delete(timer);
    }) as typeof clearTimeout,
  };
  return { dependencies, sockets, requests, logs, timers };
}

test("requires an explicit paired invite and limits smoke targets", () => {
  assert.deepEqual(
    parseArgs([
      "--base-url",
      "https://api.mons.link/",
      "--invite-id",
      "invite1",
    ]),
    OPTIONS,
  );
  assert.equal(
    parseArgs([
      "--invite-id",
      "invite1",
      "--base-url",
      "https://abcd1234-mons-link-api.lil-org.workers.dev",
    ]).baseUrl,
    "https://abcd1234-mons-link-api.lil-org.workers.dev",
  );
  for (const args of [
    [],
    ["--base-url", OPTIONS.baseUrl],
    ["--invite-id", "invite1"],
    ["--base-url", OPTIONS.baseUrl, "--invite-id"],
    [
      "--base-url",
      OPTIONS.baseUrl,
      "--invite-id",
      "invite1",
      "--invite-id",
      "invite2",
    ],
    ["--base-url", OPTIONS.baseUrl, "--invite-id", "invite/1"],
    ["--base-url", OPTIONS.baseUrl, "--invite-id", " invite1"],
    ["--base-url", OPTIONS.baseUrl, "--publish", "true"],
    ["--base-url", "https://untrusted.example", "--invite-id", "invite1"],
    ["--base-url", "http://api.mons.link", "--invite-id", "invite1"],
    [
      "--base-url",
      "https://user:secret@api.mons.link",
      "--invite-id",
      "invite1",
    ],
    [
      "--base-url",
      "https://api.mons.link?token=secret",
      "--invite-id",
      "invite1",
    ],
    ["--base-url", "https://api.mons.link:443/path", "--invite-id", "invite1"],
  ]) {
    assert.throws(() => parseArgs(args), /Usage:/);
  }
});

test("verifies a public snapshot, heartbeat and reconnect without publishing", async () => {
  const state = harness((socket) => {
    socket.emit("message", Buffer.from(JSON.stringify(SNAPSHOT)), false);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          type: "reaction",
          senderUid: "guest",
          reaction: REACTION,
        }),
      ),
      false,
    );
  });
  await smokeReactions(OPTIONS, state.dependencies);
  assert.equal(state.requests.length, 2);
  for (const request of state.requests) {
    assert.equal(
      request.url,
      "wss://api.mons.link/invites/invite1/reactions/socket",
    );
    assert.deepEqual(request.options, {
      origin: "https://mons.link",
      followRedirects: false,
      handshakeTimeout: 10_000,
      maxPayload: 4096,
      perMessageDeflate: false,
    });
  }
  for (const socket of state.sockets) {
    assert.deepEqual(socket.sent, ["ping"]);
    assert.equal(socket.terminated, 1);
    assert.equal(socket.listenerCount("message"), 0);
  }
  assert.equal(state.timers.size, 0);
  assert.equal(state.logs.length, 1);
  assert.match(state.logs[0], /read-only snapshot, heartbeat and reconnect/);
  assert.equal(state.logs[0].includes(REACTION.uuid), false);
});

test("accepts empty snapshots and invite rematches", async () => {
  for (const reactions of [
    {},
    { host: { ...REACTION, matchId: "invite11" } },
  ]) {
    const state = harness((socket) => {
      socket.emit(
        "message",
        Buffer.from(JSON.stringify({ ...SNAPSHOT, reactions })),
        false,
      );
    });
    await smokeReactions(OPTIONS, state.dependencies);
    assert.equal(state.requests.length, 2);
  }
});

test("rejects malformed, binary, oversized and out-of-order messages", async () => {
  for (const fixture of [
    { value: "not-json" },
    { value: "pong" },
    { value: JSON.stringify({ ...SNAPSHOT, schemaVersion: 2 }) },
    { value: JSON.stringify(SNAPSHOT), binary: true },
    { value: "x".repeat(4097) },
    {
      value: JSON.stringify({
        schemaVersion: 1,
        type: "reaction",
        senderUid: "host",
        reaction: REACTION,
      }),
    },
    {
      value: JSON.stringify({
        ...SNAPSHOT,
        reactions: { host: { ...REACTION, matchId: "another-invite" } },
      }),
    },
  ]) {
    const state = harness((socket) => {
      socket.emit("message", Buffer.from(fixture.value), fixture.binary);
    });
    await assert.rejects(
      smokeReactions(OPTIONS, state.dependencies),
      /invalid message|another invite/,
    );
    assert.equal(state.requests.length, 1);
    assert.equal(state.sockets[0].terminated, 1);
    assert.equal(state.timers.size, 0);
  }
});

test("stops on upgrade failures, early closure, send failures and duplicate snapshots", async () => {
  for (const fixture of [
    {
      open: (socket: FakeSocket) => socket.emit("error", new Error("secret")),
      expected: /WebSocket failed/,
    },
    {
      open: (socket: FakeSocket) => socket.emit("close"),
      expected: /closed before completion/,
    },
    {
      open: (socket: FakeSocket) => {
        let destroyed = false;
        socket.emit(
          "unexpected-response",
          {},
          {
            statusCode: 403,
            destroy: () => {
              destroyed = true;
            },
          },
        );
        assert.equal(destroyed, true);
      },
      expected: /upgrade returned 403/,
    },
    {
      open: (socket: FakeSocket) => {
        socket.sendError = new Error("secret");
        socket.emit("message", Buffer.from(JSON.stringify(SNAPSHOT)), false);
      },
      expected: /heartbeat failed/,
    },
    {
      open: (socket: FakeSocket) => {
        socket.respond = false;
        socket.emit("message", Buffer.from(JSON.stringify(SNAPSHOT)), false);
        socket.emit("message", Buffer.from(JSON.stringify(SNAPSHOT)), false);
      },
      expected: /invalid message/,
    },
  ]) {
    const state = harness(fixture.open);
    await assert.rejects(
      smokeReactions(OPTIONS, state.dependencies),
      fixture.expected,
    );
    assert.equal(state.requests.length, 1);
    assert.equal(state.sockets[0].terminated, 1);
    assert.equal(state.timers.size, 0);
  }
});

test("times out stalled handshakes and missing heartbeats and clears resources", async () => {
  for (const snapshot of [false, true]) {
    const state = harness((socket) => {
      socket.respond = false;
      if (snapshot) {
        socket.emit("message", Buffer.from(JSON.stringify(SNAPSHOT)), false);
      }
    });
    const pending = smokeReactions(OPTIONS, state.dependencies);
    await Promise.resolve();
    assert.equal(state.timers.size, 1);
    for (const timeout of state.timers.values()) {
      timeout();
    }
    await assert.rejects(pending, /timed out/);
    assert.equal(state.sockets[0].terminated, 1);
    assert.equal(state.timers.size, 0);
  }
});

test("rejects invalid direct options before connecting and sanitizes constructor errors", async () => {
  const state = harness();
  await assert.rejects(
    smokeReactions({ ...OPTIONS, inviteId: "" }, state.dependencies),
    /Usage:/,
  );
  assert.equal(state.requests.length, 0);
  await assert.rejects(
    smokeReactions(OPTIONS, {
      ...state.dependencies,
      connect: () => {
        throw new Error("secret");
      },
    }),
    /could not open its WebSocket/,
  );
});
