"use strict";

const { readFileSync } = require("node:fs");
const test = require("node:test");
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");

let rules;

const match = (fen = "fen-1", flatMovesString = "") => ({
  version: 2,
  color: "white",
  emojiId: 1,
  aura: "",
  gameVariant: "Classic",
  fen,
  status: "",
  flatMovesString,
  timer: "",
});

test.before(async () => {
  rules = await initializeTestEnvironment({
    projectId: "demo-mons-link-rules",
    database: {
      rules: readFileSync("cloud/database.rules.json", "utf8"),
    },
  });
});

test.after(async () => {
  await rules.cleanup();
});

test.beforeEach(async () => {
  await rules.clearDatabase();
  await rules.withSecurityRulesDisabled(async (context) => {
    await context
      .database()
      .ref()
      .set({
        invites: {
          invite1: {
            version: 2,
            hostId: "host",
            hostColor: "white",
            guestId: "guest",
          },
        },
        players: {
          alternate: {
            profile: "profile-host",
          },
          host: {
            profile: "profile-host",
            matches: { invite1: match() },
          },
          guest: {
            profile: "profile-guest",
            matches: { invite1: match() },
          },
        },
      });
  });
});

test("rules deny structural writes and preserve live participant writes", async () => {
  const host = rules.authenticatedContext("host", {
    profileId: "profile-host",
  });
  const hostDb = host.database();
  await assertFails(
    hostDb.ref("invites/newinvite").set({
      version: 2,
      hostId: "host",
      hostColor: "white",
      guestId: null,
    }),
  );
  await assertFails(hostDb.ref("invites/invite1/hostRematches").set("1"));
  await assertFails(hostDb.ref("players/host/matches/invite2").set(match()));
  await assertFails(hostDb.ref("players/host/matches/invite1").remove());
  await assertSucceeds(
    hostDb.ref("players/host/matches/invite1").set(match("fen-2", "move")),
  );
  await assertSucceeds(
    hostDb.ref("invites/invite1/reactions/host").set({
      uuid: "reaction-1",
      kind: "voice",
      variation: 1,
      matchId: "invite1",
    }),
  );
  const alternate = rules.authenticatedContext("alternate", {
    profileId: "profile-host",
  });
  await assertSucceeds(
    alternate
      .database()
      .ref("players/host/matches/invite1")
      .set(match("fen-3", "move-more")),
  );
});

test("rules retain same-profile writes through an RTDB link without a custom claim", async () => {
  const alternate = rules.authenticatedContext("alternate");
  await assertSucceeds(
    alternate
      .database()
      .ref("players/host/matches/invite1")
      .set(match("fen-linked", "move-linked")),
  );
});

test("retired storage rejects root and child writes from participants and admin claims", async () => {
  const writes = [
    ["matchTimerStarts", { invite1: { startedAtMs: 1 } }],
    ["matchTimerStarts/invite1", { startedAtMs: 1 }],
    ["profileGameProjectionOutbox/profile", { host: { lastQueuedAtMs: 1 } }],
    ["profileGameProjectionOutbox/profile/host", { lastQueuedAtMs: 1 }],
    ["invites/invite1/matchesRatingUpdates", { invite1: true }],
    ["invites/invite1/matchesRatingUpdates/invite1", true],
    ["players/host/mining", { frozen: { dust: 1 } }],
    [
      "players/host/mining/frozen",
      { dust: 1, slime: 0, gum: 0, metal: 0, ice: 0 },
    ],
    ["players/host/mining/frozen/dust", 1],
    ["players/host/mining/_wagerOps", { operation1: { consumed: true } }],
    ["players/host/mining/_wagerOps/operation1", { consumed: true }],
  ];
  for (const context of [
    rules.authenticatedContext("host", { profileId: "profile-host" }),
    rules.authenticatedContext("alternate", { profileId: "profile-host" }),
    rules.authenticatedContext("admin", { admin: true }),
  ]) {
    for (const [path, value] of writes) {
      await assertFails(context.database().ref(path).set(value));
    }
    await assertFails(
      context.database().ref().update({
        "players/host/matches/invite1/emojiId": 2,
        "players/host/mining/frozen/dust": 1,
      }),
    );
  }
});

test("retired frozen reservations and operation records cannot be read directly", async () => {
  await rules.withSecurityRulesDisabled(async (context) => {
    await context
      .database()
      .ref("players/host/mining")
      .set({
        frozen: { dust: 3, slime: 0, gum: 0, metal: 0, ice: 0 },
        _wagerOps: { retired: { consumed: true } },
      });
  });
  for (const context of [
    rules.unauthenticatedContext(),
    rules.authenticatedContext("host", { profileId: "profile-host" }),
    rules.authenticatedContext("alternate", { profileId: "profile-host" }),
    rules.authenticatedContext("guest", { profileId: "profile-guest" }),
    rules.authenticatedContext("admin", { admin: true }),
  ]) {
    for (const path of [
      "players/host/mining",
      "players/host/mining/frozen",
      "players/host/mining/frozen/dust",
      "players/host/mining/_wagerOps",
    ]) {
      await assertFails(context.database().ref(path).once("value"));
    }
  }
});
