"use strict";

const assert = require("node:assert/strict");
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
  assert.ok(true);
});
