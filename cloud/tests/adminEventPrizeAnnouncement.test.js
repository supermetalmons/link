"use strict";

const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  ANNOUNCEMENT_URL,
  parseAnnouncementArguments,
  parseArgs,
  postEventPrizeAnnouncement,
  readBridgeSecret,
  sendEventPrizeAnnouncement,
  smokeEventPrizeAnnouncement,
} = require("../admin/announceEventPrizes");

const EVENT_ID = "FRkdorMWaYW";
const ANNOUNCEMENT = "Win compressed NFTs";
const NOW_MS = Date.UTC(2026, 7, 20, 12);
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

test("root package exposes the requested announcement command", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts.announceEventPrizes,
    "node cloud/admin/announceEventPrizes.js",
  );
});

test("requires a bridge secret and accepts interactive, positional, or smoke input", () => {
  assert.equal(parseAnnouncementArguments([]), null);
  assert.deepEqual(parseAnnouncementArguments([EVENT_ID, ANNOUNCEMENT]), {
    eventId: EVENT_ID,
    announcement: ANNOUNCEMENT,
  });
  assert.deepEqual(parseArgs(["--bridge-secret-file", "/secure/bridge"]), {
    bridgeSecretFile: "/secure/bridge",
    input: null,
    smoke: false,
  });
  assert.deepEqual(
    parseArgs([
      "--bridge-secret-file",
      "/secure/bridge",
      EVENT_ID,
      ANNOUNCEMENT,
    ]),
    {
      bridgeSecretFile: "/secure/bridge",
      input: { eventId: EVENT_ID, announcement: ANNOUNCEMENT },
      smoke: false,
    },
  );
  assert.deepEqual(
    parseArgs(["--smoke", "--bridge-secret-file", "/secure/bridge"]),
    {
      bridgeSecretFile: "/secure/bridge",
      input: null,
      smoke: true,
    },
  );
  for (const args of [
    [],
    ["--bridge-secret-file"],
    ["--bridge-secret-file", "/secure/bridge", EVENT_ID],
    ["--bridge-secret-file", "/secure/bridge", "--smoke", EVENT_ID],
  ]) {
    assert.throws(() => parseArgs(args), TypeError);
  }
});

test("reads a protected bridge secret without exposing its value", async () => {
  let read;
  assert.equal(
    await readBridgeSecret("/secure/bridge", {
      readFile: (...args) => {
        read = args;
        return " secret-value\n";
      },
    }),
    "secret-value",
  );
  assert.deepEqual(read, [path.resolve("/secure/bridge"), "utf8"]);
  await assert.rejects(
    () =>
      readBridgeSecret("/secure/empty", {
        readFile: () => "",
      }),
    /empty/,
  );
  assert.equal(
    await readBridgeSecret("-", {
      readStream: async () => "piped-secret",
    }),
    "piped-secret",
  );
});

test("posts the exact body with a timestamped HMAC signature", async () => {
  let request;
  const input = {
    eventId: EVENT_ID,
    announcement: ANNOUNCEMENT,
    requestId: REQUEST_ID,
  };
  const result = await postEventPrizeAnnouncement(input, {
    secret: "bridge-secret",
    now: () => NOW_MS,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return Response.json({ ok: true, messageIds: [1, 2, 3] });
    },
  });
  const body = JSON.stringify(input);
  const timestamp = String(Math.floor(NOW_MS / 1_000));
  const expectedSignature = createHmac("sha256", "bridge-secret")
    .update(`${timestamp}.${body}`)
    .digest("base64url");

  assert.equal(request.url, ANNOUNCEMENT_URL);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.body, body);
  assert.deepEqual(request.init.headers, {
    "Content-Type": "application/json",
    "X-Mons-Telegram-Signature": expectedSignature,
    "X-Mons-Telegram-Timestamp": timestamp,
  });
  assert.equal(request.init.signal instanceof AbortSignal, true);
  assert.equal(result.status, 200);
});

test("returns the configured album result through the Worker", async () => {
  let secretPath;
  const result = await sendEventPrizeAnnouncement(
    { eventId: EVENT_ID, announcement: ANNOUNCEMENT },
    {
      bridgeSecretFile: "/secure/bridge",
      requestId: REQUEST_ID,
      readSecret: async (filePath) => {
        secretPath = filePath;
        return "bridge-secret";
      },
      fetchImpl: async () =>
        Response.json({
          ok: true,
          eventId: EVENT_ID,
          eventUrl: `https://mons.link/event/${EVENT_ID}`,
          messageIds: [41, 42, 43],
        }),
    },
  );

  assert.equal(secretPath, "/secure/bridge");
  assert.deepEqual(result, {
    eventId: EVENT_ID,
    eventUrl: `https://mons.link/event/${EVENT_ID}`,
    imageUrls: [
      "https://cdn.lil.org/nft/card_nft/1866.webp",
      "https://cdn.lil.org/nft/card_nft/1682.webp",
      "https://cdn.lil.org/nft/card_nft/6793.webp",
    ],
    text: `${ANNOUNCEMENT}\n\nhttps://mons.link/event/${EVENT_ID}`,
    messageIds: [41, 42, 43],
  });
});

test("warns against retrying uncertain Worker and network outcomes", async () => {
  const call = (fetchImpl) =>
    sendEventPrizeAnnouncement(
      { eventId: EVENT_ID, announcement: ANNOUNCEMENT },
      {
        bridgeSecretFile: "/secure/bridge",
        requestId: REQUEST_ID,
        readSecret: async () => "bridge-secret",
        fetchImpl,
      },
    );
  await assert.rejects(
    () =>
      call(async () =>
        Response.json(
          { ok: false, error: "telegram-delivery-uncertain" },
          { status: 409 },
        ),
      ),
    /Check the group before retrying/,
  );
  await assert.rejects(
    () =>
      call(async () => {
        throw new Error("network failure");
      }),
    /check the group before retrying/i,
  );
  await assert.rejects(
    () => call(async () => new Response("not-json", { status: 200 })),
    /Check the group before retrying/,
  );
});

test("requires one message ID for every configured prize image", async () => {
  await assert.rejects(
    () =>
      sendEventPrizeAnnouncement(
        { eventId: EVENT_ID, announcement: ANNOUNCEMENT },
        {
          bridgeSecretFile: "/secure/bridge",
          requestId: REQUEST_ID,
          readSecret: async () => "bridge-secret",
          fetchImpl: async () => Response.json({ ok: true, messageIds: [41] }),
        },
      ),
    /Check the group before retrying/,
  );
});

test("runs an authenticated smoke without sending a configured event", async () => {
  let posted;
  const result = await smokeEventPrizeAnnouncement("/secure/bridge", {
    readSecret: async () => "bridge-secret",
    fetchImpl: async (_url, init) => {
      posted = JSON.parse(init.body);
      return Response.json(
        { ok: false, error: "invalid-request" },
        { status: 400 },
      );
    },
  });
  assert.deepEqual(posted, {
    eventId: "__cloudflare_smoke__",
    announcement: "smoke",
    requestId: "00000000-0000-4000-8000-000000000000",
  });
  assert.deepEqual(result, { ok: true });
});

test("contains no Firebase secret access path", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../admin/announceEventPrizes.js"),
    "utf8",
  );
  assert.equal(source.includes("functions:secrets:access"), false);
  assert.equal(source.includes("firebase"), false);
});
