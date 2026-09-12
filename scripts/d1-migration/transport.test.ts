import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import test, { type TestContext } from "node:test";
import { createMigrationTransport } from "./transport.ts";

async function server(t: TestContext, listener: RequestListener) {
  const http = createServer(listener);
  const sockets = new Set<Socket>();
  http.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  const transport = createMigrationTransport();
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await transport.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return {
    transport,
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    sockets,
  };
}

test(
  "independent JSON POSTs overlap on sixteen connections without changing their signed bodies",
  { timeout: 10_000 },
  async (t) => {
    let received = 0;
    let released = false;
    const replies: Array<() => void> = [];
    let firstSixteen!: () => void;
    const reachedCap = new Promise<void>((resolve) => {
      firstSixteen = resolve;
    });
    const f = await server(t, (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        assert.equal(request.httpVersion, "1.1");
        assert.equal(
          request.headers["x-mons-telegram-signature"],
          "unchanged-signature",
        );
        assert.equal(
          request.headers["x-mons-telegram-timestamp"],
          "1800000000",
        );
        assert.match(body, /^\{"operation":"barrier","objectId":\d+\}$/);
        received++;
        const reply = () => {
          response.setHeader("Content-Type", "application/json");
          response.end(body);
        };
        if (released) reply();
        else replies.push(reply);
        if (received === 16) firstSixteen();
      });
    });
    const requests = Array.from({ length: 20 }, (_, objectId) =>
      f.transport
        .fetch(f.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Mons-Telegram-Signature": "unchanged-signature",
            "X-Mons-Telegram-Timestamp": "1800000000",
          },
          body: JSON.stringify({ operation: "barrier", objectId }),
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
        })
        .then((response) => response.json()),
    );
    const completed = Promise.all(requests);
    await reachedCap;
    assert.equal(received, 16);
    assert.equal(f.sockets.size, 16);
    released = true;
    for (const reply of replies) reply();
    const results = await completed;
    assert.deepEqual(
      results,
      Array.from({ length: 20 }, (_, objectId) => ({
        operation: "barrier",
        objectId,
      })),
    );
    assert.equal(received, 20);
    assert.equal(f.sockets.size, 16);
  },
);

test("redirect refusal prevents forwarding signed requests", async (t) => {
  let forwarded = 0;
  const f = await server(t, (request, response) => {
    request.resume();
    if (request.url === "/elsewhere") forwarded++;
    response.statusCode = 307;
    response.setHeader("Location", "/elsewhere");
    response.end();
  });
  await assert.rejects(
    f.transport.fetch(f.url, {
      method: "POST",
      body: "signed-payload",
      redirect: "error",
    }),
    TypeError,
  );
  assert.equal(forwarded, 0);
});

test("abort signals cancel in-flight requests and release the connection", async (t) => {
  let observed!: () => void;
  const arrived = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const f = await server(t, (request) => {
    request.resume();
    observed();
  });
  const controller = new AbortController();
  const reason = new Error("bounded read cancelled");
  const pending = f.transport.fetch(f.url, {
    method: "POST",
    body: "{}",
    redirect: "error",
    signal: controller.signal,
  });
  await arrived;
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
});

test("HTTP failure status, headers, streaming JSON and empty204 responses are preserved", async (t) => {
  const f = await server(t, (request, response) => {
    request.resume();
    if (request.url === "/empty") {
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 503;
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Retry-After", "60");
    response.write('{"ok":');
    response.end("false}");
  });
  const failure = await f.transport.fetch(f.url, { redirect: "error" });
  assert(failure instanceof Response);
  assert.equal(failure.status, 503);
  assert.equal(failure.ok, false);
  assert.equal(failure.headers.get("Retry-After"), "60");
  assert.deepEqual(await failure.json(), { ok: false });
  const empty = await f.transport.fetch(`${f.url}/empty`, {
    redirect: "error",
  });
  assert.equal(empty.status, 204);
  assert.equal(empty.body, null);
});

test("the dedicated transport leaves the public global dispatcher unchanged", async (t) => {
  const { getGlobalDispatcher } = await import("undici");
  const before = getGlobalDispatcher();
  const f = await server(t, (request, response) => {
    request.resume();
    response.end("ok");
  });
  assert.equal(await (await f.transport.fetch(f.url)).text(), "ok");
  assert.equal(getGlobalDispatcher(), before);
});
