"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");
const { runTransaction } = require("firebase/database");
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

function surrenderClient(database, myMatch, matchId = "invite1") {
  const source = ts.createSourceFile(
    "connection.ts",
    readFileSync("src/connection/connection.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === "Connection",
  );
  const method = declaration.members.find(
    (node) => node.name?.getText(source) === "sendMatchUpdate",
  );
  const transactions = [];
  const events = [];
  const reconnects = [];
  const output = ts.transpileModule(
    `class Connection { ${method.getText(source)} }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const Constructor = new Function(
    "ref",
    "runTransaction",
    `${output}\nreturn Connection;`,
  )(
    (_db, path) => database.ref(path),
    (reference, update, options) => {
      const transaction = runTransaction(reference, update, options);
      transactions.push(transaction);
      return transaction;
    },
  );
  const connection = Object.assign(new Constructor(), {
    db: {},
    myMatch,
    requireWritableContext: () => ({
      inviteId: "invite1",
      matchId,
      actorUid: "host",
    }),
    createMatchContextGuard: () => () => true,
    createSessionGuard: () => () => true,
    logContextEvent: (event) => events.push(event),
    reconnectAfterMatchUpdateFailure: (inviteId) => reconnects.push(inviteId),
  });
  return { connection, transactions, events, reconnects };
}

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

test("retired reactions remain readable but reject every browser write", async () => {
  const reaction = {
    uuid: "retained-reaction",
    kind: "voice",
    variation: 1,
    matchId: "invite1",
  };
  await rules.withSecurityRulesDisabled(async (context) => {
    await context
      .database()
      .ref("invites/invite1/reactions/host")
      .set(reaction);
  });
  for (const context of [
    rules.unauthenticatedContext(),
    rules.authenticatedContext("host", { profileId: "profile-host" }),
    rules.authenticatedContext("guest", { profileId: "profile-guest" }),
    rules.authenticatedContext("alternate", { profileId: "profile-host" }),
    rules.authenticatedContext("alternate"),
    rules.authenticatedContext("admin", { admin: true }),
  ]) {
    const database = context.database();
    await assertSucceeds(
      database.ref("invites/invite1/reactions/host").once("value"),
    );
    await assertFails(
      database.ref("invites/invite1/reactions").set({ host: reaction }),
    );
    await assertFails(
      database.ref("invites/invite1/reactions/host").set(reaction),
    );
    await assertFails(
      database.ref("invites/invite1/reactions/host/variation").set(2),
    );
    await assertFails(database.ref("invites/invite1/reactions").remove());
    await assertFails(
      database.ref().update({
        "players/host/matches/invite1/emojiId": 2,
        "invites/invite1/reactions/host": reaction,
      }),
    );
  }
  const retained = await rules
    .unauthenticatedContext()
    .database()
    .ref("invites/invite1/reactions/host")
    .once("value");
  assert.deepEqual(retained.val(), reaction);
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

test("retired wager state and resolution markers retain invite reads and reject every browser write", async () => {
  const wager = {
    proposals: { host: { material: "dust", count: 2 } },
    proposedBy: { host: true },
    agreed: {
      proposerId: "host",
      accepterId: "guest",
      material: "dust",
      count: 2,
    },
    settlement: { operationId: "retained-settlement", state: "completed" },
    resolved: {
      winnerId: "host",
      loserId: "guest",
      material: "dust",
      count: 2,
    },
  };
  const wagerPath = "invites/invite1/wagers";
  const markersPath = "invites/invite1/matchesWagerResolutions";
  await rules.withSecurityRulesDisabled(async (context) => {
    await context
      .database()
      .ref()
      .update({
        [wagerPath]: { invite1: wager },
        [markersPath]: { invite1: true },
      });
  });
  for (const context of [
    rules.unauthenticatedContext(),
    rules.authenticatedContext("host", { profileId: "profile-host" }),
    rules.authenticatedContext("guest", { profileId: "profile-guest" }),
    rules.authenticatedContext("alternate", { profileId: "profile-host" }),
    rules.authenticatedContext("alternate"),
    rules.authenticatedContext("admin", { admin: true }),
  ]) {
    const database = context.database();
    for (const [path, expected] of [
      [wagerPath, { invite1: wager }],
      [`${wagerPath}/invite1`, wager],
      [markersPath, { invite1: true }],
      [`${markersPath}/invite1`, true],
    ]) {
      assert.deepEqual(
        (await assertSucceeds(database.ref(path).once("value"))).val(),
        expected,
      );
      await assertFails(database.ref(path).set(expected));
      await assertFails(database.ref(path).remove());
    }
    await assertFails(database.ref(`${wagerPath}/invite2`).set(wager));
    await assertFails(database.ref(`${markersPath}/invite2`).set(true));
    await assertFails(
      database.ref(`${wagerPath}/invite1/proposals/host/count`).set(3),
    );
    await assertFails(
      database.ref(`${wagerPath}/invite1/proposals/host`).remove(),
    );
    await assertFails(
      database.ref().update({
        "players/host/matches/invite1/status": "surrendered",
        [`${wagerPath}/invite1/settlement/state`]: "pending",
        [`${markersPath}/invite2`]: true,
      }),
    );
    const invite = (await database.ref("invites/invite1").once("value")).val();
    await assertFails(
      database.ref("invites/invite1").set({ ...invite, wagers: null }),
    );
    await assertFails(database.ref("invites/invite1").remove());
  }
  const database = rules.unauthenticatedContext().database();
  assert.deepEqual((await database.ref(wagerPath).once("value")).val(), {
    invite1: wager,
  });
  assert.deepEqual((await database.ref(markersPath).once("value")).val(), {
    invite1: true,
  });
  assert.equal(
    (
      await database.ref("players/host/matches/invite1/status").once("value")
    ).val(),
    "",
  );
});

test("match presentation seeds reject child, full-record, deletion and multi-path browser changes", async () => {
  for (const context of [
    rules.authenticatedContext("host", { profileId: "profile-host" }),
    rules.authenticatedContext("alternate", { profileId: "profile-host" }),
    rules.authenticatedContext("alternate"),
    rules.authenticatedContext("admin", { admin: true }),
  ]) {
    const database = context.database();
    const matchPath = "players/host/matches/invite1";
    for (const [field, value] of [
      ["emojiId", 2],
      ["aura", "rainbow"],
    ]) {
      await assertFails(database.ref(`${matchPath}/${field}`).set(value));
      await assertFails(database.ref(`${matchPath}/${field}`).remove());
      await assertFails(
        database.ref(matchPath).set({ ...match(), [field]: value }),
      );
      const withoutField = match();
      delete withoutField[field];
      await assertFails(database.ref(matchPath).set(withoutField));
      await assertFails(
        database.ref().update({
          [`${matchPath}/${field}`]: value,
          [`${matchPath}/status`]: "surrendered",
        }),
      );
      await assertFails(
        database.ref().update({
          [`${matchPath}/${field}`]: null,
          [`${matchPath}/status`]: "surrendered",
        }),
      );
    }
    assert.deepEqual(
      (await database.ref(matchPath).once("value")).val(),
      match(),
    );
  }
});

test("unchanged presentation seeds permit moves and status writes for every authorized browser identity", async () => {
  let moveHistory = "";
  for (const context of [
    rules.authenticatedContext("host", { profileId: "profile-host" }),
    rules.authenticatedContext("alternate", { profileId: "profile-host" }),
    rules.authenticatedContext("alternate"),
    rules.authenticatedContext("admin", { admin: true }),
  ]) {
    moveHistory += "-move";
    const reference = context.database().ref("players/host/matches/invite1");
    await assertSucceeds(
      reference.set(match(`fen${moveHistory}`, moveHistory)),
    );
    await assertSucceeds(reference.update({ status: "surrendered" }));
    const stored = (await reference.once("value")).val();
    assert.equal(stored.emojiId, 1);
    assert.equal(stored.aura, "");
    assert.equal(stored.status, "surrendered");
  }
});

test("surrender loads a cold match through transaction retries and rejects missing records", async () => {
  const database = rules
    .authenticatedContext("host", {
      profileId: "profile-host",
    })
    .database();
  const reference = database.ref("players/host/matches/invite1");
  const original = (await reference.get()).val();
  const client = surrenderClient(database, {
    ...original,
    status: "surrendered",
    emojiId: 1001,
    aura: "rainbow",
  });
  assert.equal(client.connection.sendMatchUpdate("invite1"), true);
  const result = await assertSucceeds(client.transactions[0]);
  assert.equal(result.committed, true);
  assert.deepEqual(result.snapshot.val(), {
    ...original,
    status: "surrendered",
  });
  await new Promise(setImmediate);
  assert.deepEqual(client.events, ["ctx.write.success"]);

  const missing = surrenderClient(
    database,
    { ...match(), status: "surrendered" },
    "missing",
  );
  assert.equal(missing.connection.sendMatchUpdate("missing"), true);
  await assertFails(missing.transactions[0]);
  await new Promise(setImmediate);
  assert.deepEqual(missing.events, ["ctx.write.fail"]);
  assert.deepEqual(missing.reconnects, ["invite1"]);
  assert.equal(
    (await database.ref("players/host/matches/missing").get()).exists(),
    false,
  );
});

test("surrender queues behind a stale pending move and preserves its state and presentation seeds", async () => {
  const database = rules
    .authenticatedContext("host", {
      profileId: "profile-host",
    })
    .database();
  const reference = database.ref("players/host/matches/invite1");
  const terminalSnapshots = [];
  reference.on("value", (snapshot) => {
    const value = snapshot.val();
    if (value?.status === "surrendered") terminalSnapshots.push(value);
  });
  try {
    await reference.once("value");
    database.goOffline();
    const move = runTransaction(
      reference,
      (current) =>
        current
          ? { ...current, fen: "fen-after-move", flatMovesString: "move" }
          : null,
      { applyLocally: false },
    );
    await rules.withSecurityRulesDisabled(async (context) => {
      await context
        .database()
        .ref("players/host/matches/invite1/timer")
        .set("concurrent-server-timer");
    });
    const client = surrenderClient(database, {
      ...match("fen-after-move", "move"),
      status: "surrendered",
      emojiId: 1001,
      aura: "rainbow",
    });
    assert.equal(client.connection.sendMatchUpdate("invite1"), true);
    database.goOnline();
    const [moved, surrendered] = await Promise.all([
      assertSucceeds(move),
      assertSucceeds(client.transactions[0]),
    ]);
    assert.equal(moved.committed, true);
    assert.equal(surrendered.committed, true);
    const expected = {
      ...match("fen-after-move", "move"),
      status: "surrendered",
      timer: "concurrent-server-timer",
    };
    await rules.withSecurityRulesDisabled(async (context) => {
      assert.deepEqual(
        (
          await context.database().ref("players/host/matches/invite1").get()
        ).val(),
        expected,
      );
    });
    assert.ok(terminalSnapshots.length > 0);
    for (const snapshot of terminalSnapshots)
      assert.deepEqual(snapshot, expected);
    assert.deepEqual(client.reconnects, []);
  } finally {
    reference.off();
    database.goOnline();
  }
});

test("legacy missing presentation fields must remain absent through browser writes", async () => {
  const matchPath = "players/host/matches/invite1";
  for (const missingFields of [["emojiId"], ["aura"], ["emojiId", "aura"]]) {
    const legacyMatch = match();
    for (const field of missingFields) delete legacyMatch[field];
    await rules.withSecurityRulesDisabled(async (context) => {
      await context.database().ref(matchPath).set(legacyMatch);
    });
    for (const context of [
      rules.authenticatedContext("host", { profileId: "profile-host" }),
      rules.authenticatedContext("admin", { admin: true }),
    ]) {
      const reference = context.database().ref(matchPath);
      for (const field of missingFields) {
        await assertFails(reference.child(field).set(match()[field]));
        await assertFails(
          reference.set({ ...legacyMatch, [field]: match()[field] }),
        );
      }
      await assertSucceeds(
        reference.update({
          fen: "legacy-moved",
          flatMovesString: "legacy-move",
        }),
      );
      await assertSucceeds(reference.update({ status: "surrendered" }));
      const stored = (await reference.once("value")).val();
      for (const field of missingFields)
        assert.equal(Object.hasOwn(stored, field), false);
    }
  }
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
