"use strict";

const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  ANNOUNCEMENT_URL,
  formatEventPrizeAnnouncementPreview,
  main,
  parseAnnouncementArguments,
  postEventPrizeAnnouncement,
  sendEventPrizeAnnouncement,
} = require("../admin/announceEventPrizes");

const EVENT_ID = "FRkdorMWaYW";
const COLLECTION_NAME = "Rare Weitsmans";
const EVENT_URL = `https://mons.link/event/${EVENT_ID}`;
const TEXT = `sunday mons treats — <tg-spoiler>${COLLECTION_NAME}</tg-spoiler>\n\n${EVENT_URL}`;
const NOW_MS = Date.UTC(2026, 7, 20, 12);
const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const DATA = Object.freeze({
  eventId: EVENT_ID,
  collectionName: COLLECTION_NAME,
});

test("root package exposes the requested announcement command", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts.announceEventPrizes,
    "node cloud/admin/announceEventPrizes.js",
  );
});

test("requires an event ID, collection name, and explicit bridge secret file", () => {
  assert.deepEqual(
    parseAnnouncementArguments([
      EVENT_ID,
      COLLECTION_NAME,
      "--bridge-secret-file",
      "/secure/announcement",
    ]),
    {
      eventId: EVENT_ID,
      collectionName: COLLECTION_NAME,
      bridgeSecretFile: "/secure/announcement",
    },
  );
  for (const args of [
    [],
    [EVENT_ID],
    [EVENT_ID, COLLECTION_NAME],
    [
      EVENT_ID,
      COLLECTION_NAME,
      "--bridge-secret-file",
      "/secure/a",
      "--bridge-secret-file",
      "/secure/b",
    ],
    [EVENT_ID, COLLECTION_NAME, "extra"],
    ["--smoke", COLLECTION_NAME],
    [EVENT_ID, "--bridge-secret-file"],
  ]) {
    assert.throws(() => parseAnnouncementArguments(args), TypeError);
  }
});

test("formats the operator preview without exposing Telegram markup", () => {
  assert.equal(
    formatEventPrizeAnnouncementPreview({
      collectionName: COLLECTION_NAME,
      eventUrl: EVENT_URL,
    }),
    `sunday mons treats — [spoiler: ${COLLECTION_NAME}]\n\n${EVENT_URL}`,
  );
});

test("posts the exact collection payload with a timestamped HMAC signature", async () => {
  let request;
  const input = { ...DATA, requestId: REQUEST_ID };
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

test("returns the formatted album result through the Worker", async () => {
  let secretArguments;
  const result = await sendEventPrizeAnnouncement(DATA, {
    bridgeSecretFile: "/secure/announcement",
    requestId: REQUEST_ID,
    readSecret: async (...args) => {
      secretArguments = args;
      return "bridge-secret";
    },
    fetchImpl: async () =>
      Response.json({
        ok: true,
        eventId: EVENT_ID,
        eventUrl: EVENT_URL,
        messageIds: [41, 42, 43],
      }),
  });

  assert.deepEqual(secretArguments, ["/secure/announcement"]);
  assert.deepEqual(result, {
    collectionName: COLLECTION_NAME,
    eventId: EVENT_ID,
    eventUrl: EVENT_URL,
    imageUrls: [
      "https://cdn.lil.org/nft/card_nft/1866.webp",
      "https://cdn.lil.org/nft/card_nft/1682.webp",
      "https://cdn.lil.org/nft/card_nft/6793.webp",
    ],
    parseMode: "HTML",
    text: TEXT,
    messageIds: [41, 42, 43],
  });
});

test("warns against retrying uncertain Worker and network outcomes", async () => {
  const call = (fetchImpl) =>
    sendEventPrizeAnnouncement(DATA, {
      requestId: REQUEST_ID,
      readSecret: async () => "bridge-secret",
      fetchImpl,
    });
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
      sendEventPrizeAnnouncement(DATA, {
        requestId: REQUEST_ID,
        readSecret: async () => "bridge-secret",
        fetchImpl: async () => Response.json({ ok: true, messageIds: [41] }),
      }),
    /Check the group before retrying/,
  );
});

test("confirmation precedes credential access and signing", async () => {
  for (const confirmation of ["no", "yes"]) {
    const actions = [];
    await main(
      [
        EVENT_ID,
        COLLECTION_NAME,
        "--bridge-secret-file",
        "/secure/announcement",
      ],
      {
        createPrompts: () => ({
          question: async () => {
            actions.push("confirm");
            return confirmation;
          },
          close: () => actions.push("close"),
        }),
        output: { write: () => undefined },
        readSecret: (filePath) => {
          assert.equal(filePath, "/secure/announcement");
          actions.push("secret");
          return "bridge-secret";
        },
        fetchImpl: async (_url, init) => {
          actions.push("send");
          assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(), [
            "collectionName",
            "eventId",
            "requestId",
          ]);
          return Response.json({ ok: true, messageIds: [41, 42, 43] });
        },
      },
    );
    assert.deepEqual(
      actions,
      confirmation === "yes"
        ? ["confirm", "secret", "send", "close"]
        : ["confirm", "close"],
    );
  }
});
