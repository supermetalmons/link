"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const { createMockUserToken } = require("@firebase/util");
const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");

const PROJECT = "demo-mons-link-rules";
const MATCH_PATH = "players/host/matches/invite1";
const match = {
  version: 2,
  color: "white",
  emojiId: 1,
  aura: "",
  gameVariant: "Classic",
  fen: "retained-fen",
  status: "",
  flatMovesString: "retained-move",
  timer: "1;1800000000000",
  sessionCreation: "retained-operation:host",
  legacy: { retained: true },
};
const source = {
  players: {
    host: {
      profile: "profile-host",
      matches: { invite1: match },
      mining: { frozen: { dust: 3 }, _wagerOps: { old: { consumed: true } } },
    },
    guest: { matches: { invite1: { ...match, color: "black" } } },
    orphan: { matches: { missing: "retained-scalar" } },
  },
  invites: {
    invite1: {
      hostId: "host",
      guestId: "guest",
      password: "retained-password",
      reactions: { host: "retained-reaction" },
      wagers: { invite1: { retained: true } },
    },
  },
  matchTimerClaims: {
    invite1: { status: "pending", expiresAtMs: 1800000000000 },
  },
  automatch: { auto1: { uid: "host", profileId: "profile-host" } },
  telegramProjectionOutbox: { automatch: { auto1: { updatedAtMs: 1 } } },
  profileGameProjectionOutbox: { automatch: { auto1: { lastQueuedAtMs: 1 } } },
  gameplayMutationReceipts: { old: { completedAtMs: 1 } },
  gameplayMutationReceiptExpirations: { old: { completedAtMs: 1 } },
  eventTransitionReceipts: { old: { retained: true } },
  events: { old: { retained: true } },
};
const principals = [
  ["anonymous", null],
  ["owner", { sub: "host" }],
  ["owner profile claim", { sub: "host", profileId: "profile-host" }],
  ["linked login", { sub: "alternate", profileId: "profile-host" }],
  ["opponent", { sub: "guest", profileId: "profile-guest" }],
  ["admin claim", { sub: "admin", admin: true }],
  ["old move claim", { sub: "host", workerMoveMatchId: "invite1" }],
  ["old surrender claim", { sub: "host", workerSurrenderMatchId: "invite1" }],
];
let rules;

function urlFor(path = "") {
  const { host, port } = rules.emulators.database;
  const url = new URL(`http://${host}:${port}/${path}.json`);
  url.searchParams.set("ns", PROJECT);
  return url;
}

async function clientRequest(claims, path, method = "GET", value) {
  const url = urlFor(path);
  if (claims)
    url.searchParams.set("auth", createMockUserToken(claims, PROJECT));
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}

async function assertDenied(response, label) {
  assert.ok(
    [401, 403].includes(response.status),
    `${label}: HTTP ${response.status}`,
  );
  assert.match((await response.json()).error, /permission denied/i, label);
}

async function assertSourcePreserved() {
  await rules.withSecurityRulesDisabled(async (context) => {
    assert.deepEqual((await context.database().ref().get()).val(), source);
  });
}

test.before(async () => {
  rules = await initializeTestEnvironment({
    projectId: PROJECT,
    database: {
      rules: readFileSync(resolve(__dirname, "../database.rules.json"), "utf8"),
    },
  });
});

test.beforeEach(async () => {
  await rules.clearDatabase();
  await rules.withSecurityRulesDisabled(async (context) => {
    await context.database().ref().set(source);
  });
});

test.after(async () => {
  await rules?.cleanup();
});

test("all clients lose root, match, claim, invite and retired-source reads", async () => {
  const paths = [
    "",
    "players",
    "players/host",
    "players/host/matches",
    MATCH_PATH,
    `${MATCH_PATH}/fen`,
    `${MATCH_PATH}/timer`,
    `${MATCH_PATH}/legacy/retained`,
    "players/host/profile",
    "players/host/mining/frozen/dust",
    "players/host/mining/_wagerOps/old",
    "players/orphan/matches/missing",
    "invites",
    "invites/invite1",
    "invites/invite1/reactions/host",
    "invites/invite1/wagers/invite1",
    "matchTimerClaims",
    "matchTimerClaims/invite1/status",
    "automatch",
    "automatch/auto1",
    "telegramProjectionOutbox",
    "profileGameProjectionOutbox",
    "gameplayMutationReceipts",
    "gameplayMutationReceiptExpirations",
    "eventTransitionReceipts",
    "events",
    "players/missing/matches/missing",
    "unknown/nested/path",
  ];
  for (const [name, claims] of principals)
    for (const path of paths)
      await assertDenied(
        await clientRequest(claims, path),
        `${name} reads ${path}`,
      );
  await assertSourcePreserved();
});

test("root, parent and descendant replacements and deletion stay denied", async () => {
  const paths = [
    "",
    "players",
    "players/host",
    "players/host/matches",
    MATCH_PATH,
    `${MATCH_PATH}/fen`,
    `${MATCH_PATH}/flatMovesString`,
    `${MATCH_PATH}/status`,
    `${MATCH_PATH}/timer`,
    "matchTimerClaims/invite1",
    "automatch/auto1",
    "invites/invite1",
    "players/host/profile",
    "events/old",
    "unknown/new",
  ];
  for (const [name, claims] of principals)
    for (const path of paths)
      for (const [method, value] of [
        ["PUT", { replacement: true }],
        ["DELETE", undefined],
      ])
        await assertDenied(
          await clientRequest(claims, path, method, value),
          `${name} ${method} ${path}`,
        );
  await assertSourcePreserved();
});

test("move, surrender and multipath updates cannot mutate retained source evidence", async () => {
  for (const [name, claims] of principals) {
    for (const value of [
      { fen: "moved-fen", flatMovesString: "retained-move-next" },
      { status: "surrendered" },
      { timer: "" },
    ])
      await assertDenied(
        await clientRequest(claims, MATCH_PATH, "PATCH", value),
        name,
      );
    await assertDenied(
      await clientRequest(claims, "", "PATCH", {
        [`${MATCH_PATH}/status`]: "surrendered",
        "players/guest/matches/invite1/timer": "",
        "matchTimerClaims/invite1": null,
        "invites/invite1/guestId": "alternate",
        "automatch/auto1": null,
      }),
      `${name} multipath update`,
    );
  }
  await assertSourcePreserved();
});

test("retired privileged move and surrender overrides cannot bypass deny-all rules", async () => {
  for (const token of [
    { workerMoveMatchId: "invite1" },
    { workerSurrenderMatchId: "invite1" },
    { workerMoveMatchId: "invite1", workerSurrenderMatchId: "invite1" },
    { admin: true },
  ]) {
    const url = urlFor(MATCH_PATH);
    url.searchParams.set(
      "auth_variable_override",
      JSON.stringify({ uid: "host", token }),
    );
    for (const method of ["GET", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: "Bearer owner",
          "Content-Type": "application/json",
        },
        ...(["PUT", "PATCH"].includes(method)
          ? {
              body: JSON.stringify({
                ...match,
                fen: "changed",
                status: "surrendered",
              }),
            }
          : {}),
      });
      await assertDenied(response, `retired override ${method}`);
    }
  }
  await assertSourcePreserved();
});

test(
  "legacy Firebase match subscriptions fail without delivering a snapshot",
  { timeout: 10000 },
  async () => {
    for (const [name, claims] of principals) {
      const context = claims
        ? rules.authenticatedContext(claims.sub, claims)
        : rules.unauthenticatedContext();
      const ref = context.database().ref(MATCH_PATH);
      await new Promise((resolve, reject) => {
        const received = () =>
          reject(new Error(`${name} received retired match data`));
        ref.on("value", received, (error) => {
          ref.off("value", received);
          try {
            assert.match(error.code, /permission_denied/i);
            resolve();
          } catch (failure) {
            reject(failure);
          }
        });
      });
    }
  },
);

test("deny-all rules preserve privileged source reads and every retained record", async () => {
  const response = await fetch(urlFor(), {
    headers: { Authorization: "Bearer owner" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), source);
  await assertSourcePreserved();
});
