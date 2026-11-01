"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  decodeAutomatchEntry,
  decodeAutomatchEntries,
} = require("../runtime/automatchRecords");
const { getDisplayNameFromAddress } = require("../runtime/telegramDisplay");
const {
  createProfileGamesProjectionCore,
} = require("../runtime/profileGamesProjectionCore");
const { invite, profile } = require("./fixtures/canonicalProfileGames");

/** @param {Record<string, unknown>} [patch] @returns {Record<string, unknown>} */
const entry = (patch = {}) => ({
  schemaVersion: 1,
  uid: "host-login",
  profileId: "host-profile",
  timestamp: 123,
  rating: 1450,
  hostColor: "white",
  password: " secret ",
  gameVariant: "Classic",
  telegramDeliveryVersion: 2,
  username: " name ",
  ethAddress: "0x1234",
  solAddress: "",
  emojiId: 1,
  ...patch,
});

/** @param {unknown} value */
function presentEntry(value) {
  const decoded = decodeAutomatchEntry(value);
  assert.ok(decoded);
  return decoded;
}

test("entry reads retain exact canonical values without mutating their source", () => {
  const raw = entry();
  const before = structuredClone(raw);
  assert.strictEqual(decodeAutomatchEntry(raw), raw);
  assert.deepEqual(raw, before);
  assert.equal(presentEntry(entry({ profileId: null })).profileId, null);
});

test("entry reads accept absence and reject malformed records and missing fields", () => {
  assert.equal(decodeAutomatchEntry(null), null);
  for (const raw of [undefined, false, 0, "", true, 1, "malformed", [], {}])
    assert.throws(
      () => decodeAutomatchEntry(raw),
      /invalid-canonical-automatch/,
    );
  for (const field of Object.keys(entry())) {
    const raw = entry();
    delete raw[field];
    assert.throws(
      () => decodeAutomatchEntry(raw),
      /invalid-canonical-automatch/,
    );
  }
  assert.throws(
    () => decodeAutomatchEntry(entry({ extra: true })),
    /invalid-canonical-automatch/,
  );
});

test("entry reads reject numeric coercions and unsupported Telegram versions", () => {
  for (const field of /** @type {const} */ (["timestamp", "rating"])) {
    for (const value of [
      null,
      undefined,
      false,
      true,
      {},
      [],
      "123",
      "0x10",
      NaN,
      Infinity,
      -Infinity,
      -1,
    ])
      assert.throws(
        () => decodeAutomatchEntry(entry({ [field]: value })),
        /invalid-canonical-automatch/,
      );
    assert.equal(presentEntry(entry({ [field]: 0 }))[field], 0);
  }
  assert.throws(
    () => decodeAutomatchEntry(entry({ timestamp: 1.5 })),
    /invalid-canonical-automatch/,
  );
  for (const rating of [1.5, 1512.5, Number.MIN_VALUE, Number.MAX_VALUE])
    assert.equal(presentEntry(entry({ rating })).rating, rating);
  for (const value of ["2", 1, false, {}])
    assert.throws(
      () => decodeAutomatchEntry(entry({ telegramDeliveryVersion: value })),
      /invalid-canonical-automatch/,
    );
  assert.equal(
    presentEntry(entry({ telegramDeliveryVersion: null }))
      .telegramDeliveryVersion,
    null,
  );
});

test("entry display fields require canonical text and emoji before formatting", () => {
  for (const [field, value] of /** @type {[string, unknown][]} */ ([
    ["username", { legacy: ["name"] }],
    ["ethAddress", ["address"]],
    ["solAddress", false],
    ["emojiId", { legacy: 1 }],
    ["emojiId", "1"],
    ["emojiId", 156],
  ]))
    assert.throws(
      () => decodeAutomatchEntry(entry({ [field]: value })),
      /invalid-canonical-automatch/,
    );
  const decoded = presentEntry(entry({ username: "Alice" }));
  assert.equal(
    getDisplayNameFromAddress(
      decoded.username,
      decoded.ethAddress,
      decoded.solAddress,
      decoded.rating,
      null,
    ),
    "Alice (1450)",
  );
});

test("entry collections retain canonical ordering and exact null entries", () => {
  const raw = { 10: entry({ uid: "ten" }), 2: null, valid: entry() };
  const decoded = decodeAutomatchEntries(raw);
  assert.ok(decoded);
  assert.deepEqual(Object.keys(decoded), Object.keys(raw));
  assert.equal(decoded["2"], null);
  assert.deepEqual(decoded.valid, raw.valid);
  assert.equal(decodeAutomatchEntries(null), null);
  assert.deepEqual(decodeAutomatchEntries({}), {});
  for (const malformed of [
    undefined,
    false,
    0,
    "",
    true,
    1,
    "entry",
    [],
    { "bad/key": entry() },
  ])
    assert.throws(
      () => decodeAutomatchEntries(malformed),
      /invalid-canonical-automatch-entries/,
    );
});

test("a malformed collection head rejects the collection without an empty fallback", () => {
  for (const malformed of [false, "entry", {}, { uid: "host" }])
    assert.throws(
      () => decodeAutomatchEntries({ malformed, valid: entry() }),
      /invalid-canonical-automatch/,
    );
});

test("profile projections use canonical queue timestamps and reject malformed entries without writes", async () => {
  const inviteId = "auto_abcdefghijk";
  for (const raw of [
    null,
    entry({ timestamp: 123 }),
    false,
    {},
    entry({ timestamp: "123" }),
  ]) {
    /** @type {import("../runtime/profileGamesProjectionCore").ProjectionWrite[]} */
    const writes = [];
    const core = createProfileGamesProjectionCore({
      logger: { error() {} },
      wait: async () => undefined,
      repository: {
        commitProjectionWrites: async (next) => {
          writes.push(...next);
        },
        getProjections: async () => new Map(),
        readInviteMetadata: async () =>
          invite({
            kind: "automatch",
            password: "secret",
            automatchStateHint: "canceled",
            automatchCanceledAt: 1,
          }),
        readAutomatchEntry: async () => decodeAutomatchEntry(raw),
        hasCompletedRatingUpdate: async () => false,
        readProfileOwnershipSnapshot: async () => ({
          profileDataById: new Map([
            ["host-profile", profile({ username: "host", emoji: 1 })],
          ]),
          profileIdByLoginUid: new Map([["host-login", "host-profile"]]),
        }),
      },
    });
    const recompute = () =>
      core.recomputeInviteProjection(inviteId, "test", {
        eventTimestampMs: 100,
      });
    if (raw !== null && (typeof raw === "boolean" || raw.timestamp !== 123)) {
      await assert.rejects(recompute(), /invalid-canonical-automatch/);
      assert.deepEqual(writes, []);
      continue;
    }
    const result = await recompute();
    assert.equal(result.shouldProject, raw !== null);
    if (raw === null) assert.deepEqual(writes, []);
    else {
      assert.equal(writes.length, 1);
      assert.ok(writes[0] && writes[0].type !== "delete");
      assert.equal(writes[0].data.status, "pending");
      assert.equal(writes[0].data.listSortAt, 123);
    }
  }
});
