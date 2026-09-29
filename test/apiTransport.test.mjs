import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { authenticatedJsonRequest, readSnapshotJson } =
  await import("../src/services/apiTransport.ts");

class EndpointError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "EndpointError";
    this.code = code;
    this.details = details;
  }
}

const errors = {
  createError: (code, message, details) =>
    new EndpointError(code, message, details),
  normalizeError: (error) =>
    error instanceof EndpointError ? error : undefined,
  unavailableMessage: "Endpoint unavailable.",
  timeoutMessage: "Endpoint timed out.",
};
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });
const request = (overrides = {}) =>
  authenticatedJsonRequest({
    url: "https://api.mons.link/test",
    createRequestInit: () => ({ method: "POST", body: "{}" }),
    tokenProvider: async () => "token",
    validate: (value) => value?.ok === true,
    timeoutMs: 100,
    maxResponseBytes: 128,
    fetcher: async () => jsonResponse({ ok: true }),
    errors,
    ...overrides,
  });
const unavailable = {
  name: "EndpointError",
  code: "unavailable",
  message: "Endpoint unavailable.",
};
const timeout = {
  name: "EndpointError",
  code: "unavailable",
  message: "Endpoint timed out.",
};
const snapshotRequest = (overrides = {}) =>
  readSnapshotJson({
    url: "https://api.mons.link/snapshot",
    timeoutMs: 10_000,
    maxResponseBytes: 128,
    validate: (value) => value?.ok === true,
    createError: (code) => new EndpointError(code, code),
    ...overrides,
  });

test("retries one 401 with a fresh token without waiting for cancellation", async () => {
  const refreshes = [];
  const calls = [];
  const sequence = [];
  let cancellations = 0;
  const result = await request({
    tokenProvider: async (refresh) => {
      refreshes.push(refresh);
      sequence.push("token");
      return refresh ? "fresh" : "stale";
    },
    createRequestInit: () => {
      sequence.push("body");
      return {
        method: "POST",
        body: JSON.stringify({ attempt: calls.length }),
      };
    },
    fetcher: async (url, init) => {
      sequence.push("fetch");
      calls.push({ url, init });
      return calls.length === 1
        ? new Response(
            new ReadableStream({
              cancel() {
                cancellations++;
                return new Promise(() => {});
              },
            }),
            { status: 401 },
          )
        : jsonResponse({ ok: true });
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(refreshes, [false, true]);
  assert.deepEqual(sequence, [
    "token",
    "body",
    "fetch",
    "token",
    "body",
    "fetch",
  ]);
  assert.equal(cancellations, 1);
  assert.deepEqual(
    calls.map(({ init }) => new Headers(init.headers).get("Authorization")),
    ["Bearer stale", "Bearer fresh"],
  );
  assert.deepEqual(
    calls.map(({ init }) => JSON.parse(init.body)),
    [{ attempt: 0 }, { attempt: 1 }],
  );
  for (const { url, init } of calls) {
    assert.equal(url, "https://api.mons.link/test");
    assert.equal(init.cache, "no-store");
    assert.equal(new Headers(init.headers).get("Accept"), "application/json");
    assert.equal(
      new Headers(init.headers).get("Content-Type"),
      "application/json",
    );
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls[0].init.signal, calls[1].init.signal);
});

test("preserves request options and omits Content-Type on GET", async () => {
  await request({
    createRequestInit: () => ({ method: "GET", keepalive: true }),
    fetcher: async (_url, init) => {
      assert.equal(init.method, "GET");
      assert.equal(init.keepalive, true);
      assert.equal(init.body, undefined);
      assert.equal(new Headers(init.headers).get("Content-Type"), null);
      return jsonResponse({ ok: true });
    },
  });
});

test("retains custom headers and runs guards around each token and validated result", async () => {
  const sequence = [];
  let calls = 0;
  let requestSignal;
  assert.deepEqual(
    await request({
      tokenProvider: async (refresh) => {
        sequence.push(refresh ? "refresh" : "token");
        return refresh ? "fresh-token" : "token";
      },
      assertCurrentUser: () => sequence.push("guard"),
      createRequestInit: () => {
        sequence.push("body");
        return {
          method: "POST",
          body: "{}",
          headers: { "X-Storage-Version": "v2" },
          keepalive: true,
        };
      },
      fetcher: async (_url, init) => {
        sequence.push("fetch");
        requestSignal = init.signal;
        const headers = new Headers(init.headers);
        assert.equal(headers.get("X-Storage-Version"), "v2");
        assert.equal(headers.get("Accept"), "application/json");
        assert.equal(headers.get("Content-Type"), "application/json");
        assert.equal(
          headers.get("Authorization"),
          calls === 0 ? "Bearer token" : "Bearer fresh-token",
        );
        assert.equal(init.keepalive, true);
        return jsonResponse({ ok: true }, calls++ === 0 ? 401 : 200);
      },
      readJson: async (response, maxBytes, signal) => {
        sequence.push("read");
        assert.equal(maxBytes, 128);
        assert.equal(signal, requestSignal);
        return response.json();
      },
      validate: (value) => {
        sequence.push("validate");
        return value.ok === true;
      },
    }),
    { ok: true },
  );
  assert.deepEqual(sequence, [
    "token",
    "guard",
    "body",
    "fetch",
    "refresh",
    "guard",
    "body",
    "fetch",
    "read",
    "validate",
    "guard",
  ]);
});

test("an already canceled request never acquires a token", async () => {
  const controller = new AbortController();
  controller.abort();
  let tokenCalls = 0;
  await assert.rejects(
    request({
      signal: controller.signal,
      tokenProvider: async () => {
        tokenCalls++;
        return "token";
      },
    }),
    { name: "EndpointError", code: "aborted", message: "request-aborted" },
  );
  assert.equal(tokenCalls, 0);
});

test("caller cancellation covers authentication, fetch, and the default response reader", async (t) => {
  for (const stage of ["token", "fetch", "body"]) {
    await t.test(stage, async () => {
      const controller = new AbortController();
      const started = Promise.withResolvers();
      const token = Promise.withResolvers();
      let fetches = 0;
      let signal;
      let body;
      let cancellations = 0;
      const pending = request({
        signal: controller.signal,
        tokenProvider: () => {
          if (stage === "token") {
            started.resolve();
            return token.promise;
          }
          return Promise.resolve("token");
        },
        fetcher: async (_url, init) => {
          fetches++;
          signal = init.signal;
          if (stage === "fetch") {
            started.resolve();
            return new Promise(() => {});
          }
          body = new ReadableStream({
            pull() {
              started.resolve();
              return new Promise(() => {});
            },
            cancel() {
              cancellations++;
              return new Promise(() => {});
            },
          });
          return new Response(body);
        },
      });
      const rejected = assert.rejects(pending, {
        name: "EndpointError",
        code: "aborted",
        message: "request-aborted",
      });
      await started.promise;
      controller.abort();
      await rejected;
      token.resolve("late-token");
      await setImmediate();
      assert.equal(fetches, stage === "token" ? 0 : 1);
      if (signal) assert.equal(signal.aborted, true);
      if (body) {
        assert.equal(cancellations, 1);
        assert.equal(body.locked, false);
      }
    });
  }
});

test("never retries server, network, parsing, or validation failures", async (t) => {
  for (const [name, respond, expected] of [
    [
      "server",
      () =>
        jsonResponse(
          { error: " busy ", message: " Try later. ", details: { retry: 5 } },
          503,
        ),
      { code: "busy", message: "Try later.", details: { retry: 5 } },
    ],
    [
      "network",
      () => {
        throw new TypeError("offline");
      },
      unavailable,
    ],
    ["JSON", () => new Response("{"), unavailable],
    ["validation", () => jsonResponse({ ok: false }), unavailable],
  ]) {
    await t.test(name, async () => {
      const refreshes = [];
      let calls = 0;
      await assert.rejects(
        request({
          tokenProvider: async (refresh) => {
            refreshes.push(refresh);
            return "token";
          },
          fetcher: async () => {
            calls++;
            return respond();
          },
        }),
        expected,
      );
      assert.equal(calls, 1);
      assert.deepEqual(refreshes, [false]);
    });
  }
});

test("stops after a second 401 and uses the endpoint error fallback", async () => {
  const refreshes = [];
  await assert.rejects(
    request({
      tokenProvider: async (refresh) => {
        refreshes.push(refresh);
        return "token";
      },
      fetcher: async () => jsonResponse({ error: "  ", message: null }, 401),
    }),
    { ...unavailable, code: "unauthenticated" },
  );
  assert.deepEqual(refreshes, [false, true]);
  await assert.rejects(
    request({ fetcher: async () => jsonResponse([], 500) }),
    unavailable,
  );
});

test("normalizes token errors without starting requests", async () => {
  const normalized = new EndpointError("unauthenticated", "Session changed.");
  for (const [thrown, expected] of [
    [normalized, normalized],
    [new Error("unknown"), unavailable],
  ]) {
    let calls = 0;
    await assert.rejects(
      request({
        tokenProvider: async () => {
          throw thrown;
        },
        fetcher: async () => {
          calls++;
          return jsonResponse({ ok: true });
        },
      }),
      expected instanceof Error ? (error) => error === expected : expected,
    );
    assert.equal(calls, 0);
  }
});

test("bounds stalled token, fetch, and body work with the same deadline", async (t) => {
  for (const stage of ["token", "fetch", "body"]) {
    await t.test(stage, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const started = Promise.withResolvers();
      let signal;
      let body;
      let cancellations = 0;
      const pending = request({
        tokenProvider: () => {
          if (stage === "token") {
            started.resolve();
            return new Promise(() => {});
          }
          return Promise.resolve("token");
        },
        fetcher: async (_url, init) => {
          signal = init.signal;
          if (stage === "fetch") {
            started.resolve();
            return new Promise(() => {});
          }
          body = new ReadableStream({
            pull() {
              started.resolve();
              return new Promise(() => {});
            },
            cancel() {
              cancellations++;
              return new Promise(() => {});
            },
          });
          return new Response(body);
        },
      });
      const rejected = assert.rejects(pending, timeout);
      await started.promise;
      t.mock.timers.tick(100);
      await rejected;
      if (signal) assert.equal(signal.aborted, true);
      if (body) {
        await setImmediate();
        assert.equal(cancellations, 1);
        assert.equal(body.locked, false);
      }
    });
  }
});

test("a late token never starts a request after the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const token = Promise.withResolvers();
  let calls = 0;
  const pending = request({
    tokenProvider: () => token.promise,
    fetcher: async () => {
      calls++;
      return jsonResponse({ ok: true });
    },
  });
  const rejected = assert.rejects(pending, timeout);
  t.mock.timers.tick(100);
  await rejected;
  token.resolve("late-token");
  await setImmediate();
  assert.equal(calls, 0);
});

test("401 refresh and body reading share the original request deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tokens = [Promise.withResolvers(), Promise.withResolvers()];
  const refreshStarted = Promise.withResolvers();
  const readStarted = Promise.withResolvers();
  let calls = 0;
  let settled = false;
  const pending = request({
    tokenProvider: (refresh) => {
      if (refresh) refreshStarted.resolve();
      return tokens[Number(refresh)].promise;
    },
    fetcher: async () => {
      calls++;
      return calls === 1
        ? jsonResponse({}, 401)
        : new Response(
            new ReadableStream({
              pull() {
                readStarted.resolve();
                return new Promise(() => {});
              },
            }),
          );
    },
  });
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const rejected = assert.rejects(pending, timeout);
  t.mock.timers.tick(30);
  tokens[0].resolve("stale");
  await refreshStarted.promise;
  t.mock.timers.tick(40);
  tokens[1].resolve("fresh");
  await readStarted.promise;
  t.mock.timers.tick(29);
  await setImmediate();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(calls, 2);
});

test("accepts valid multibyte UTF-8 split across chunks at the exact byte limit", async () => {
  const payload = { ok: true, text: "☃" };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const result = await request({
    maxResponseBytes: bytes.byteLength,
    fetcher: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        }),
      ),
  });
  assert.deepEqual(result, payload);
});

test("rejects missing, malformed, invalid UTF-8, and failed response bodies", async (t) => {
  for (const [name, response] of [
    ["missing", () => new Response(null)],
    ["empty", () => new Response("")],
    ["JSON", () => new Response("{bad}")],
    ["UTF-8", () => new Response(Uint8Array.of(0xff))],
    ["truncated UTF-8", () => new Response(Uint8Array.of(0xe2, 0x98))],
    [
      "stream failure",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("read failed"));
            },
          }),
        ),
    ],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        request({ fetcher: async () => response() }),
        unavailable,
      );
    });
  }
});

test("cancels oversized declared and streamed bodies without waiting", async (t) => {
  for (const declared of [true, false]) {
    await t.test(declared ? "declared" : "streamed", async () => {
      let cancellations = 0;
      await assert.rejects(
        request({
          maxResponseBytes: 4,
          fetcher: async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"ok":true}'));
                },
                cancel() {
                  cancellations++;
                  return new Promise(() => {});
                },
              }),
              declared ? { headers: { "Content-Length": "5" } } : undefined,
            ),
        }),
        unavailable,
      );
      assert.equal(cancellations, 1);
    });
  }
});

test("clears the request timer after success and failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const success of [true, false]) {
    let signal;
    const pending = request({
      fetcher: async (_url, init) => {
        signal = init.signal;
        return jsonResponse({ ok: success });
      },
    });
    if (success) await pending;
    else await assert.rejects(pending, unavailable);
    t.mock.timers.runAll();
    assert.equal(signal.aborted, false);
  }
});

test("uses a caller-supplied timeout code", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = request({
    tokenProvider: () => new Promise(() => {}),
    errors: { ...errors, timeoutCode: "deadline-exceeded" },
  });
  const rejected = assert.rejects(pending, {
    ...timeout,
    code: "deadline-exceeded",
  });
  t.mock.timers.tick(100);
  await rejected;
});

test("rejects positive infinite declared lengths in snapshot and authenticated responses", async (t) => {
  for (const contentLength of ["Infinity", "+Infinity", "1e999"]) {
    for (const snapshot of [true, false]) {
      await t.test(
        `${snapshot ? "snapshot" : "authenticated"}: ${contentLength}`,
        async (t) => {
          let cancellations = 0;
          const fetcher = async () =>
            new Response(
              new ReadableStream({
                cancel() {
                  cancellations++;
                  return new Promise(() => {});
                },
              }),
              { headers: { "Content-Length": contentLength } },
            );
          t.mock.method(globalThis, "fetch", fetcher);
          await assert.rejects(
            snapshot ? snapshotRequest() : request({ fetcher }),
            snapshot ? { code: "invalid-response" } : unavailable,
          );
          assert.equal(cancellations, 1);
        },
      );
    }
  }
});

test("snapshot byte limits remain authoritative for missing or unusable declared lengths", async (t) => {
  const payload = { ok: true, label: "☀️" };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  for (const contentLength of [
    undefined,
    "NaN",
    "bogus",
    "-Infinity",
    "-1",
    "0",
  ]) {
    await t.test(contentLength ?? "missing", async (t) => {
      t.mock.method(
        globalThis,
        "fetch",
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const byte of bytes)
                  controller.enqueue(Uint8Array.of(byte));
                controller.close();
              },
            }),
            contentLength === undefined
              ? undefined
              : { headers: { "Content-Length": contentLength } },
          ),
      );
      assert.deepEqual(
        await snapshotRequest({ maxResponseBytes: bytes.length }),
        payload,
      );
      await assert.rejects(
        snapshotRequest({ maxResponseBytes: bytes.length - 1 }),
        { code: "invalid-response" },
      );
    });
  }
});

test("snapshot reads reject missing, malformed, invalid UTF-8, and failed response bodies", async (t) => {
  for (const [name, response] of [
    ["missing", () => new Response(null)],
    ["empty", () => new Response("")],
    ["JSON", () => new Response("{bad}")],
    ["UTF-8", () => new Response(Uint8Array.of(0xff))],
    ["truncated UTF-8", () => new Response(Uint8Array.of(0xe2, 0x98))],
    [
      "stream failure",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("read failed"));
            },
          }),
        ),
    ],
  ]) {
    await t.test(name, async (t) => {
      t.mock.method(globalThis, "fetch", async () => response());
      await assert.rejects(snapshotRequest(), { code: "invalid-response" });
    });
  }
});
