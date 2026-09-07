const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { EventEmitter }: typeof import("node:events") = require("node:events");
const test: typeof import("node:test") = require("node:test");
const {
  INVITE_METADATA_MAX_MESSAGE_BYTES,
}: typeof import("@mons/shared/invite-metadata") = require("@mons/shared/invite-metadata");
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
  now: () => number;
};
const { parseArgs, runSmoke } =
  require("./smoke-cloudflare-invite-metadata.ts") as {
    parseArgs: (argv: string[]) => Options;
    runSmoke: (options: Options, dependencies: Dependencies) => Promise<void>;
  };
const OPTIONS = { baseUrl: "https://api.mons.link", inviteId: "invite1" };
const SNAPSHOT = {
  inviteId: "invite1",
  revision: 2,
  hostId: "host-private-uid",
  guestId: "guest-private-uid",
  hostColor: "white",
  hostRematches: "",
  guestRematches: "",
  automatchStateHint: null,
  eventId: null,
  eventOwned: false,
};
const RESPONSE = {
  ok: true,
  snapshot: SNAPSHOT,
  viewer: { role: "watch", actorUid: null, automatchOperationId: null },
};
const FRAME = { schemaVersion: 1, type: "snapshot", snapshot: SNAPSHOT };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeSocket extends EventEmitter {
  protocol = "mons-invite-metadata-v1";
  sent: string[] = [];
  terminated = 0;
  respond = true;
  sendError: Error | undefined;
  send(value: string, callback: (error?: Error) => void): void {
    this.sent.push(value);
    callback(this.sendError);
    if (this.respond && !this.sendError)
      queueMicrotask(() => this.emit("message", Buffer.from("pong"), false));
  }
  terminate(): void {
    this.terminated++;
    this.emit("error", new Error("ignored"));
  }
}

function harness({
  fetchResponse = async () => new Response(JSON.stringify(RESPONSE)),
  opened = (socket: FakeSocket, _index: number) => {
    socket.emit("message", Buffer.from(JSON.stringify(FRAME)), false);
  },
}: {
  fetchResponse?: typeof fetch;
  opened?: (socket: FakeSocket, index: number) => void;
} = {}) {
  let now = 0;
  const logs: string[] = [];
  const sockets: FakeSocket[] = [];
  const requests: {
    url: string;
    options: import("ws").ClientOptions;
    protocol: string;
  }[] = [];
  const fetches: { url: string; options?: RequestInit }[] = [];
  const timers = new Map<
    NodeJS.Timeout,
    { callback: () => void; milliseconds: number }
  >();
  const dependencies: Dependencies = {
    fetch: (url, options) => {
      fetches.push({ url: String(url), options });
      return fetchResponse(url, options);
    },
    connect: (url, options, protocol) => {
      requests.push({ url, options, protocol });
      const socket = new FakeSocket();
      sockets.push(socket);
      const index = sockets.length - 1;
      queueMicrotask(() => opened(socket, index));
      return socket as unknown as import("ws").WebSocket;
    },
    log: (message) => {
      logs.push(message);
    },
    setTimeout: ((callback: () => void, milliseconds: number) => {
      const timer = {} as NodeJS.Timeout;
      timers.set(timer, { callback, milliseconds });
      return timer;
    }) as typeof setTimeout,
    clearTimeout: ((timer: NodeJS.Timeout) => {
      timers.delete(timer);
    }) as typeof clearTimeout,
    now: () => now,
  };
  return {
    dependencies,
    logs,
    sockets,
    requests,
    fetches,
    timers,
    setNow: (value: number) => {
      now = value;
    },
  };
}

test("requires an explicit paired invite and restricts the production and preview target", () => {
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
    ["--base-url", OPTIONS.baseUrl, "--invite-id", "x".repeat(769)],
    ["--base-url", OPTIONS.baseUrl, "--auth-token", "secret"],
    ["--base-url", OPTIONS.baseUrl, "--publish", "true"],
    ["--base-url", "http://api.mons.link", "--invite-id", "invite1"],
    ["--base-url", "https://unknown.example", "--invite-id", "invite1"],
    ["--base-url", "https://secret@api.mons.link", "--invite-id", "invite1"],
    [
      "--base-url",
      "https://api.mons.link?token=secret",
      "--invite-id",
      "invite1",
    ],
    ["--base-url", "https://api.mons.link/path", "--invite-id", "invite1"],
  ])
    assert.throws(() => parseArgs(args), /Usage:/);
});

test("verifies public HTTP metadata and two socket snapshots with immediate heartbeats and private logs", async () => {
  const state = harness({
    opened(socket, index) {
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            ...FRAME,
            snapshot: { ...SNAPSHOT, revision: 3 + index },
          }),
        ),
        false,
      );
    },
  });
  await runSmoke(OPTIONS, state.dependencies);
  assert.equal(state.fetches.length, 1);
  assert.equal(
    state.fetches[0].url,
    "https://api.mons.link/invites/invite1/metadata",
  );
  assert.equal(state.fetches[0].options?.method, "GET");
  assert.equal(state.fetches[0].options?.redirect, "error");
  assert.equal(state.fetches[0].options?.cache, "no-store");
  assert.deepEqual(state.fetches[0].options?.headers, {
    Accept: "application/json",
    Origin: "https://mons.link",
  });
  assert.equal(state.requests.length, 2);
  for (const request of state.requests) {
    assert.equal(
      request.url,
      "wss://api.mons.link/invites/invite1/metadata/socket",
    );
    assert.equal(request.protocol, "mons-invite-metadata-v1");
    assert.deepEqual(request.options, {
      origin: "https://mons.link",
      followRedirects: false,
      handshakeTimeout: 10_000,
      maxPayload: INVITE_METADATA_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
  }
  for (const socket of state.sockets) {
    assert.deepEqual(socket.sent, ["ping"]);
    assert.equal(socket.terminated, 1);
    assert.equal(socket.listenerCount("message"), 0);
  }
  assert.equal(state.timers.size, 0);
  assert.deepEqual(state.logs, [
    "[invite-metadata-smoke] HTTP snapshot passed.",
    "[invite-metadata-smoke] Socket snapshot and heartbeat passed.",
    "[invite-metadata-smoke] Reconnect snapshot and heartbeat passed.",
  ]);
  assert.equal(state.logs.join(" ").includes(SNAPSHOT.hostId), false);
  assert.equal(state.logs.join(" ").includes(OPTIONS.inviteId), false);
});

test("rejects HTTP errors without inspecting or logging their contents", async () => {
  for (const status of [301, 401, 403, 404, 429, 503]) {
    let canceled = false;
    const state = harness({
      fetchResponse: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
          { status },
        ),
    });
    await assert.rejects(
      runSmoke(OPTIONS, state.dependencies),
      new RegExp(`HTTP returned ${status}`),
    );
    assert.equal(canceled, true);
    assert.equal(state.requests.length, 0);
    assert.equal(state.logs.length, 0);
    assert.equal(state.timers.size, 0);
  }
});

test("rejects pending, foreign, malformed and caller-specific HTTP metadata", async () => {
  for (const payload of [
    {},
    { ...RESPONSE, snapshot: { ...SNAPSHOT, guestId: null } },
    { ...RESPONSE, snapshot: { ...SNAPSHOT, inviteId: "other" } },
    { ...RESPONSE, snapshot: { ...SNAPSHOT, password: "secret" } },
    {
      ...RESPONSE,
      viewer: {
        role: "host",
        actorUid: SNAPSHOT.hostId,
        automatchOperationId: null,
      },
    },
    {
      ...RESPONSE,
      viewer: {
        role: "watch",
        actorUid: null,
        automatchOperationId: "operation-secret",
      },
    },
  ]) {
    const state = harness({
      fetchResponse: async () => new Response(JSON.stringify(payload)),
    });
    await assert.rejects(
      runSmoke(OPTIONS, state.dependencies),
      /public paired snapshot/,
    );
    assert.equal(state.requests.length, 0);
    assert.equal(state.logs.length, 0);
  }
});

test("bounds declared and streamed HTTP bytes and rejects invalid UTF-8 and JSON", async () => {
  const headerCases: HeadersInit[] = [
    { "Content-Length": String(INVITE_METADATA_MAX_MESSAGE_BYTES + 1) },
    {},
  ];
  for (const headers of headerCases) {
    let canceled = false;
    const state = harness({
      fetchResponse: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new Uint8Array(INVITE_METADATA_MAX_MESSAGE_BYTES + 1),
              );
            },
            cancel() {
              canceled = true;
            },
          }),
          { headers },
        ),
    });
    await assert.rejects(
      runSmoke(OPTIONS, state.dependencies),
      /invalid HTTP response/,
    );
    assert.equal(canceled, true);
    assert.equal(state.requests.length, 0);
  }
  for (const body of ["not-json", new Uint8Array([0xc3, 0x28])]) {
    const state = harness({ fetchResponse: async () => new Response(body) });
    await assert.rejects(
      runSmoke(OPTIONS, state.dependencies),
      /invalid HTTP response/,
    );
  }
});

test("rejects invalid, binary, oversized, foreign, private and downgraded socket messages", async () => {
  for (const fixture of [
    { value: "not-json" },
    { value: "pong" },
    { value: JSON.stringify(FRAME), binary: true },
    { value: "x".repeat(INVITE_METADATA_MAX_MESSAGE_BYTES + 1) },
    { value: JSON.stringify(FRAME), protocol: "mons-reactions-v1" },
    { value: JSON.stringify({ ...FRAME, schemaVersion: 2 }) },
    { value: JSON.stringify({ ...FRAME, viewer: RESPONSE.viewer }) },
    {
      value: JSON.stringify({
        ...FRAME,
        snapshot: { ...SNAPSHOT, inviteId: "other" },
      }),
    },
    {
      value: JSON.stringify({
        ...FRAME,
        snapshot: { ...SNAPSHOT, guestId: null },
      }),
    },
    {
      value: JSON.stringify({
        ...FRAME,
        snapshot: { ...SNAPSHOT, revision: 1 },
      }),
    },
  ]) {
    const state = harness({
      opened(socket) {
        if (fixture.protocol) socket.protocol = fixture.protocol;
        socket.emit(
          "message",
          Buffer.from(fixture.value),
          fixture.binary ?? false,
        );
      },
    });
    await assert.rejects(
      runSmoke(OPTIONS, state.dependencies),
      /invalid message or protocol/,
    );
    assert.equal(state.requests.length, 1);
    assert.equal(state.sockets[0].terminated, 1);
    assert.equal(state.timers.size, 0);
  }
});

test("accepts further complete snapshots while awaiting pong and requires reconnect at the latest revision", async () => {
  for (const regression of [false, true]) {
    const state = harness({
      opened(socket, index) {
        const revision = index === 0 ? 3 : regression ? 3 : 4;
        socket.emit(
          "message",
          Buffer.from(
            JSON.stringify({ ...FRAME, snapshot: { ...SNAPSHOT, revision } }),
          ),
          false,
        );
        if (index === 0)
          socket.emit(
            "message",
            Buffer.from(
              JSON.stringify({
                ...FRAME,
                snapshot: { ...SNAPSHOT, revision: 4 },
              }),
            ),
            false,
          );
      },
    });
    if (regression)
      await assert.rejects(
        runSmoke(OPTIONS, state.dependencies),
        /invalid message/,
      );
    else await runSmoke(OPTIONS, state.dependencies);
    assert.equal(state.requests.length, 2);
    assert.equal(state.timers.size, 0);
  }
});

test("stops on upgrades, early closes and heartbeat failures and sanitizes native errors", async () => {
  for (const fixture of [
    {
      opened: (socket: FakeSocket) => socket.emit("error", new Error("secret")),
      expected: /WebSocket failed/,
    },
    {
      opened: (socket: FakeSocket) => socket.emit("close"),
      expected: /closed before completion/,
    },
    {
      opened: (socket: FakeSocket) => {
        let destroyed = false;
        socket.emit(
          "unexpected-response",
          {},
          {
            statusCode: 403,
            destroy() {
              destroyed = true;
            },
          },
        );
        assert.equal(destroyed, true);
      },
      expected: /upgrade returned 403/,
    },
    {
      opened: (socket: FakeSocket) => {
        socket.sendError = new Error("secret");
        socket.emit("message", Buffer.from(JSON.stringify(FRAME)), false);
      },
      expected: /heartbeat failed/,
    },
  ]) {
    const state = harness({ opened: fixture.opened });
    await assert.rejects(
      runSmoke(OPTIONS, state.dependencies),
      fixture.expected,
    );
    assert.equal(state.requests.length, 1);
    assert.equal(state.sockets[0].terminated, 1);
    assert.equal(state.timers.size, 0);
  }
  const state = harness({
    fetchResponse: async () => {
      throw new Error("secret");
    },
  });
  await assert.rejects(
    runSmoke(OPTIONS, state.dependencies),
    /HTTP request failed/,
  );
  const failed = harness();
  failed.dependencies.connect = () => {
    throw new Error("secret");
  };
  await assert.rejects(
    runSmoke(OPTIONS, failed.dependencies),
    /could not open its WebSocket/,
  );
});

test("bounds stalled HTTP and body reads by the shared thirty-second deadline", async () => {
  for (const stream of [false, true]) {
    let canceled = false;
    const state = harness({
      fetchResponse: async () =>
        stream
          ? new Response(
              new ReadableStream({
                cancel() {
                  canceled = true;
                },
              }),
            )
          : new Promise(() => {}),
    });
    const pending = runSmoke(OPTIONS, state.dependencies);
    const rejected = assert.rejects(pending, /timed out/);
    await flush();
    const timer = [...state.timers.values()].find(
      (value) => value.milliseconds === 30_000,
    );
    assert.ok(timer);
    timer.callback();
    await rejected;
    assert.equal(state.fetches[0].options?.signal?.aborted, true);
    assert.equal(state.requests.length, 0);
    assert.equal(state.timers.size, 0);
    assert.equal(canceled, stream);
  }
});

test("socket and heartbeat timeouts release connections and all timers", async () => {
  for (const sendSnapshot of [false, true]) {
    const state = harness({
      opened(socket) {
        socket.respond = false;
        if (sendSnapshot)
          socket.emit("message", Buffer.from(JSON.stringify(FRAME)), false);
      },
    });
    const pending = runSmoke(OPTIONS, state.dependencies);
    const rejected = assert.rejects(pending, /timed out/);
    await flush();
    const timer = [...state.timers.values()].find(
      (value) => value.milliseconds === 10_000,
    );
    assert.ok(timer);
    timer.callback();
    await rejected;
    assert.equal(state.sockets[0].terminated, 1);
    assert.equal(state.timers.size, 0);
    assert.equal(state.logs.length, 1);
  }
});

test("shares the remaining deadline across HTTP and reconnect without resetting the budget", async () => {
  let state: ReturnType<typeof harness>;
  state = harness({
    fetchResponse: async () => {
      state.setNow(15_000);
      return new Response(JSON.stringify(RESPONSE));
    },
    opened(socket, index) {
      if (index === 0) {
        state.setNow(23_000);
        socket.emit("message", Buffer.from(JSON.stringify(FRAME)), false);
      } else socket.respond = false;
    },
  });
  const pending = runSmoke(OPTIONS, state.dependencies);
  const rejected = assert.rejects(pending, /timed out/);
  await flush();
  assert.equal(state.requests[1].options.handshakeTimeout, 7_000);
  assert.ok(
    [...state.timers.values()].some((timer) => timer.milliseconds === 30_000),
  );
  const remaining = [...state.timers.values()].find(
    (timer) => timer.milliseconds === 7_000,
  );
  assert.ok(remaining);
  remaining.callback();
  await rejected;
  assert.equal(state.sockets[1].terminated, 1);
  assert.equal(state.timers.size, 0);
});

test("rejects invalid direct options before I/O and ignores late HTTP completion after timeout", async () => {
  const state = harness();
  await assert.rejects(
    runSmoke({ ...OPTIONS, inviteId: "" }, state.dependencies),
    /Usage:/,
  );
  assert.equal(state.fetches.length, 0);
  let resolve: (response: Response) => void = () => undefined;
  let canceled = false;
  const late = harness({
    fetchResponse: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const pending = runSmoke(OPTIONS, late.dependencies);
  const rejected = assert.rejects(pending, /timed out/);
  await flush();
  [...late.timers.values()][0].callback();
  await rejected;
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
    ),
  );
  await flush();
  assert.equal(canceled, true);
  assert.equal(late.requests.length, 0);
  assert.equal(late.logs.length, 0);
});

test("rejects socket frames past the shared deadline even when timeout callbacks are delayed", async () => {
  let state: ReturnType<typeof harness>;
  state = harness({
    opened(socket) {
      state.setNow(30_000);
      socket.emit("message", Buffer.from(JSON.stringify(FRAME)), false);
    },
  });
  await assert.rejects(runSmoke(OPTIONS, state.dependencies), /timed out/);
  assert.equal(state.requests.length, 1);
  assert.equal(state.sockets[0].terminated, 1);
  assert.equal(state.timers.size, 0);
});
