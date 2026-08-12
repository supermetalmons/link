"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { batchReadWithRetry } = require("../functions/batchRead");
const firebaseAdmin = require("../functions/firebaseAdmin");
const {
  resolveMatchResult,
  resolveMatchWinner,
} = require("../functions/matchOutcome");
const { readProfileByLoginUid } = require("../functions/profileLookup");
const {
  emptyProfileSummary,
  getProfileByLoginId,
  profileSummaryFromDocument,
} = require("../functions/profileSummaryLookup");
const {
  getDisplayNameFromAddress,
  getTelegramEmojiTag,
  resolveTelegramEmojiId,
} = require("../functions/telegramDisplay");
const { customTelegramEmojis } = require("../functions/telegramEmojiData");
const utils = require("../functions/utils");

const withFirestore = async (firestore, callback) => {
  const originalFirestore = firebaseAdmin.firestore;
  firebaseAdmin.firestore = firestore;
  try {
    return await callback();
  } finally {
    firebaseAdmin.firestore = originalFirestore;
  }
};

const createFirestoreQuery = (snapshot, calls) => {
  const query = {
    get: async () => {
      calls.push(["get"]);
      return snapshot;
    },
    limit: (count) => {
      calls.push(["limit", count]);
      return query;
    },
    select: (...fields) => {
      calls.push(["select", ...fields]);
      return query;
    },
    where: (...args) => {
      calls.push(["where", ...args]);
      return query;
    },
  };
  return () => ({
    collection: (name) => {
      calls.push(["collection", name]);
      return query;
    },
  });
};

test("utils preserves its compatibility export surface", () => {
  assert.deepEqual(Object.keys(utils), [
    "batchReadWithRetry",
    "getProfileByLoginId",
    "getDisplayNameFromAddress",
    "getTelegramEmojiTag",
    "customTelegramEmojis",
  ]);
  assert.strictEqual(utils.batchReadWithRetry, batchReadWithRetry);
  assert.strictEqual(utils.getProfileByLoginId, getProfileByLoginId);
  assert.strictEqual(
    utils.getDisplayNameFromAddress,
    getDisplayNameFromAddress,
  );
  assert.strictEqual(utils.getTelegramEmojiTag, getTelegramEmojiTag);
  assert.strictEqual(utils.customTelegramEmojis, customTelegramEmojis);
});

test("production modules import foundation leaves instead of the utils facade", () => {
  const functionsDirectory = path.resolve(__dirname, "../functions");
  const pendingDirectories = [functionsDirectory];
  const facadeConsumers = [];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") {
          pendingDirectories.push(path.join(directory, entry.name));
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".js")) {
        continue;
      }
      const filename = path.join(directory, entry.name);
      if (filename === path.join(functionsDirectory, "utils.js")) {
        continue;
      }
      const source = fs.readFileSync(filename, "utf8");
      for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
        const specifier = match[1];
        if (!specifier.startsWith(".")) {
          continue;
        }
        const requiredFilename = path.resolve(
          path.dirname(filename),
          specifier,
        );
        if (
          requiredFilename === path.join(functionsDirectory, "utils") ||
          requiredFilename === path.join(functionsDirectory, "utils.js")
        ) {
          facadeConsumers.push(path.relative(functionsDirectory, filename));
          break;
        }
      }
    }
  }

  assert.deepEqual(facadeConsumers.sort(), []);
});

test("Telegram emoji data preserves the complete configured catalog", () => {
  assert.equal(Object.keys(customTelegramEmojis).length, 622);
  assert.equal(customTelegramEmojis[1], "5273900723417929741");
  assert.equal(customTelegramEmojis[155], "5274191711747201553");
  assert.equal(customTelegramEmojis[1000], "5280755224934382724");
  assert.equal(customTelegramEmojis[1466], "5278711026659915839");
});

test("Telegram display formatting preserves name, rating, and emoji rules", () => {
  const emojiTag =
    '<tg-emoji emoji-id="5273900723417929741">&#11088;</tg-emoji>';

  assert.equal(resolveTelegramEmojiId(1), "5273900723417929741");
  assert.equal(resolveTelegramEmojiId("1"), "5273900723417929741");
  assert.equal(resolveTelegramEmojiId(0), "");
  assert.equal(resolveTelegramEmojiId("unknown"), "");
  assert.equal(getTelegramEmojiTag(""), "");
  assert.equal(
    getTelegramEmojiTag("123"),
    '<tg-emoji emoji-id="123">&#11088;</tg-emoji>',
  );
  assert.equal(
    getDisplayNameFromAddress(
      "ivan",
      "0x1234567890",
      "solana12345678",
      "1500",
      "1",
    ),
    `${emojiTag} ivan (1500)`,
  );
  assert.equal(
    getDisplayNameFromAddress("", "0x1234567890", "", 0, 1, false),
    "0x12...7890",
  );
  assert.equal(
    getDisplayNameFromAddress("", "", "solana12345678", null, null),
    "sola...5678",
  );
  assert.equal(
    getDisplayNameFromAddress("", "", "", "not-a-rating", 999),
    "anon",
  );
});

test("batch reads retry only failed initial reads", async () => {
  const recoveredSnapshot = { value: "recovered" };
  const stableSnapshot = { value: "stable" };
  const calls = [0, 0];
  const references = [
    {
      once: async () => {
        calls[0] += 1;
        if (calls[0] === 1) {
          throw new Error("initial failure");
        }
        return recoveredSnapshot;
      },
    },
    {
      once: async () => {
        calls[1] += 1;
        return stableSnapshot;
      },
    },
  ];
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    assert.deepEqual(await batchReadWithRetry(references), [
      recoveredSnapshot,
      stableSnapshot,
    ]);
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(calls, [2, 1]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], "Error in initial batch read:");
});

test("profile summary mapping preserves defaults and custom precedence", () => {
  const document = {
    id: "profile-id",
    data: () => ({
      custom: { aura: "rainbow", emoji: 0 },
      emoji: 10,
      nonce: undefined,
      rating: undefined,
    }),
  };

  assert.deepEqual(profileSummaryFromDocument(document), {
    nonce: -1,
    rating: 1500,
    eth: "",
    sol: "",
    username: "",
    totalManaPoints: 0,
    profileId: "profile-id",
    emoji: 0,
    aura: "rainbow",
  });
  assert.deepEqual(emptyProfileSummary(), {
    eth: "",
    sol: "",
    profileId: "",
    nonce: 0,
    rating: 0,
    username: "",
    totalManaPoints: 0,
    emoji: "",
    aura: "",
  });
  assert.notStrictEqual(emptyProfileSummary(), emptyProfileSummary());
});

test("legacy summary lookup retains its single-result fallback behavior", async () => {
  const calls = [];
  const document = {
    id: "profile-id",
    data: () => ({ username: "player" }),
  };
  const firestore = createFirestoreQuery(
    { docs: [document], empty: false, size: 1 },
    calls,
  );

  const profile = await withFirestore(firestore, () =>
    getProfileByLoginId("login-id"),
  );

  assert.equal(profile.profileId, "profile-id");
  assert.equal(profile.username, "player");
  assert.deepEqual(calls, [
    ["collection", "users"],
    ["where", "logins", "array-contains", "login-id"],
    ["limit", 1],
    ["get"],
  ]);
});

test("strict and legacy profile lookups retain distinct failure policies", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const fallback = await withFirestore(
      () => {
        throw new Error("unavailable");
      },
      () => getProfileByLoginId("login-id"),
    );
    assert.deepEqual(fallback, emptyProfileSummary());

    await assert.rejects(
      withFirestore(
        () => {
          throw new Error("unavailable");
        },
        () => readProfileByLoginUid("login-id"),
      ),
      /unavailable/,
    );
  } finally {
    console.error = originalConsoleError;
  }

  const calls = [];
  const firestore = createFirestoreQuery(
    { docs: [{ id: "a" }, { id: "b" }], empty: false, size: 2 },
    calls,
  );
  await assert.rejects(
    withFirestore(firestore, () =>
      readProfileByLoginUid("login-id", ["username", "rating"]),
    ),
    (error) =>
      error.code === "failed-precondition" &&
      error.message.includes("login-profile-conflict"),
  );
  assert.deepEqual(calls, [
    ["collection", "users"],
    ["where", "logins", "array-contains", "login-id"],
    ["limit", 2],
    ["select", "username", "rating"],
    ["get"],
  ]);
});

test("match outcome exposes the folded result mapping asynchronously", async () => {
  assert.deepEqual(await resolveMatchWinner(null, {}), {
    winner: null,
    reason: "missing-match",
  });
  assert.deepEqual(
    await resolveMatchWinner({ color: "white" }, { color: "white" }),
    { winner: null, reason: "invalid-colors" },
  );
  assert.deepEqual(
    await resolveMatchWinner(
      { color: "white", fen: "fen" },
      { color: "black" },
    ),
    { winner: null, reason: "missing-fen" },
  );

  const resultPromise = resolveMatchResult({ status: "surrendered" }, {});
  assert.equal(typeof resultPromise.then, "function");
  assert.deepEqual(await resultPromise, { result: "gg" });
  assert.deepEqual(await resolveMatchResult({}, { status: "surrendered" }), {
    result: "win",
  });
  assert.deepEqual(await resolveMatchResult(null, null), { result: "none" });
  assert.equal(
    fs.existsSync(path.resolve(__dirname, "../functions/matchResult.js")),
    false,
  );
});
