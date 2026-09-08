"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { createMockUserToken } = require("@firebase/util");
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");

let rules;
let createFirebaseRtdbClient;
let FirebaseRtdbPermissionDenied;

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

function emulatorRestUrl(input) {
  const url = new URL(input);
  const emulator = rules.emulators.database;
  url.protocol = "http:";
  url.hostname = emulator.host;
  url.port = String(emulator.port);
  url.searchParams.set("ns", "demo-mons-link-rules");
  return url;
}

function scopedSurrenderClient({
  playerId = "host",
  matchId = "invite1",
  fetcher = fetch,
} = {}) {
  return createFirebaseRtdbClient(
    { FIREBASE_RTDB_URL: "https://mons-link-default-rtdb.firebaseio.com" },
    {
      scopedMatchSurrender: { playerId, matchId },
      getAccessToken: async () => "owner",
      fetcher: (input, init) => fetcher(emulatorRestUrl(input), init),
    },
  );
}

function surrender(current) {
  return { value: { ...current, status: "surrendered" } };
}

test.before(async () => {
  ({ createFirebaseRtdbClient, FirebaseRtdbPermissionDenied } =
    await import("../workers/api/src/firebaseRtdb.ts"));
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

test("automatch source rejects browser root, child and multipath writes including admin", async () => {
  const queued = { uid: "host", timestamp: 1234, password: "retained" };
  await rules.withSecurityRulesDisabled(async (context) => {
    await context.database().ref("automatch/auto1").set(queued);
  });
  for (const context of [
    rules.unauthenticatedContext(),
    rules.authenticatedContext("host", { profileId: "profile-host" }),
    rules.authenticatedContext("admin", { admin: true }),
  ]) {
    const database = context.database();
    await assertFails(database.ref("automatch").set({ auto2: queued }));
    await assertFails(database.ref("automatch/auto1").remove());
    await assertFails(database.ref("automatch/auto1/uid").set("guest"));
    await assertFails(database.ref().update({ "automatch/auto1": null }));
  }
  const admin = rules.authenticatedContext("admin-reader", { admin: true });
  assert.deepEqual(
    (await admin.database().ref("automatch/auto1").get()).val(),
    queued,
  );
});

test("session creation evidence is immutable for every browser while moves preserve it", async () => {
  const matchPath = "players/host/matches/invite1";
  const marker = "creation-operation:host";
  for (const storedMarker of [undefined, marker]) {
    const initial = {
      ...match(),
      ...(storedMarker ? { sessionCreation: storedMarker } : {}),
    };
    await rules.withSecurityRulesDisabled(async (context) => {
      await context.database().ref(matchPath).set(initial);
    });
    for (const context of [
      rules.authenticatedContext("host", { profileId: "profile-host" }),
      rules.authenticatedContext("alternate", { profileId: "profile-host" }),
      rules.authenticatedContext("admin", { admin: true }),
    ]) {
      const database = context.database();
      await assertFails(
        database.ref(`${matchPath}/sessionCreation`).set("different"),
      );
      await assertFails(
        database
          .ref(matchPath)
          .set({ ...initial, sessionCreation: "different" }),
      );
      await assertFails(
        database.ref().update({
          [`${matchPath}/sessionCreation`]: "different",
          [`${matchPath}/status`]: "surrendered",
        }),
      );
      if (storedMarker) {
        await assertFails(
          database.ref(`${matchPath}/sessionCreation`).remove(),
        );
        await assertFails(database.ref(matchPath).set(match()));
      }
      await assertSucceeds(
        database
          .ref(matchPath)
          .set({ ...initial, fen: "fen-next", flatMovesString: "move" }),
      );
      await assertFails(database.ref(`${matchPath}/status`).set("surrendered"));
    }
  }
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

test("unchanged presentation seeds permit moves while browser surrender is rejected", async () => {
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
    await assertFails(reference.update({ status: "surrendered" }));
    const stored = (await reference.once("value")).val();
    assert.equal(stored.emojiId, 1);
    assert.equal(stored.aura, "");
    assert.equal(stored.status, "");
  }
});

test("status changes, removal, and replacement require the Worker capability for every browser identity", async () => {
  const path = "players/host/matches/invite1";
  for (const storedStatus of [undefined, "", "surrendered"]) {
    const initial = match();
    if (storedStatus === undefined) delete initial.status;
    else initial.status = storedStatus;
    await rules.withSecurityRulesDisabled(async (context) => {
      await context.database().ref(path).set(initial);
    });
    const changed = storedStatus === "surrendered" ? "" : "surrendered";
    const withoutStatus = { ...initial };
    delete withoutStatus.status;
    for (const context of [
      rules.unauthenticatedContext(),
      rules.authenticatedContext("guest", { profileId: "profile-guest" }),
      rules.authenticatedContext("host", { profileId: "profile-host" }),
      rules.authenticatedContext("alternate", { profileId: "profile-host" }),
      rules.authenticatedContext("alternate"),
      rules.authenticatedContext("admin", { admin: true }),
    ]) {
      const database = context.database();
      await assertFails(database.ref(`${path}/status`).set(changed));
      await assertFails(
        database.ref(path).set({ ...initial, status: changed }),
      );
      await assertFails(database.ref().update({ [`${path}/status`]: changed }));
      if (storedStatus !== undefined) {
        await assertFails(database.ref(`${path}/status`).remove());
        await assertFails(database.ref(path).set(withoutStatus));
        await assertFails(database.ref().update({ [`${path}/status`]: null }));
      }
    }
    for (const context of [
      rules.authenticatedContext("host", { profileId: "profile-host" }),
      rules.authenticatedContext("alternate", { profileId: "profile-host" }),
      rules.authenticatedContext("alternate"),
      rules.authenticatedContext("admin", { admin: true }),
    ]) {
      const reference = context.database().ref(path);
      await assertSucceeds(
        reference.set({ ...initial, fen: "next-fen", flatMovesString: "move" }),
      );
      const stored = (await reference.get()).val();
      assert.equal(Object.hasOwn(stored, "status"), storedStatus !== undefined);
      assert.equal(stored.status, storedStatus);
    }
  }
});

test("scoped OAuth REST surrender retries an ETag conflict without losing a concurrent move or timer", async () => {
  const path = "players/host/matches/invite1";
  const browser = rules.authenticatedContext("host").database();
  let conflictInjected = false;
  const writeStatuses = [];
  const client = scopedSurrenderClient({
    fetcher: async (url, init) => {
      assert.deepEqual(
        JSON.parse(url.searchParams.get("auth_variable_override")),
        {
          uid: "host",
          token: { workerSurrenderMatchId: "invite1" },
        },
      );
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        "Bearer owner",
      );
      if (init.method === "PUT" && !conflictInjected) {
        conflictInjected = true;
        await browser
          .ref(path)
          .update({ fen: "fen-moved", flatMovesString: "move" });
        await rules.withSecurityRulesDisabled(async (context) => {
          await context
            .database()
            .ref(`${path}/timer`)
            .set("concurrent-server-timer");
        });
      }
      const response = await fetch(url, init);
      if (init.method === "PUT") writeStatuses.push(response.status);
      return response;
    },
  });
  const result = await client.transactPath(path, surrender);
  assert.equal(result.committed, true);
  assert.deepEqual(writeStatuses, [412, 200]);
  assert.deepEqual(result.value, {
    ...match("fen-moved", "move"),
    status: "surrendered",
    timer: "concurrent-server-timer",
  });
  assert.deepEqual((await browser.ref(path).get()).val(), result.value);
});

test("scoped REST surrender enforces timer claims atomically at its conditional write", async () => {
  const path = "players/host/matches/invite1";
  const claimPath = "matchTimerClaims/invite1";
  const now = Date.now();
  for (const [claim, allowed] of [
    [null, true],
    [{ status: "pending", expiresAtMs: now + 60_000 }, false],
    [{ status: "claimed", expiresAtMs: null }, false],
    [{ status: "pending", expiresAtMs: now - 1_000 }, true],
    [{ status: "pending" }, false],
    [{ status: "pending", expiresAtMs: "expired" }, false],
    [{ status: "other", expiresAtMs: now - 1_000 }, false],
    ["malformed", false],
  ]) {
    await rules.withSecurityRulesDisabled(async (context) => {
      await context
        .database()
        .ref()
        .update({ [path]: match(), [claimPath]: null });
    });
    let injected = false;
    const client = scopedSurrenderClient({
      fetcher: async (url, init) => {
        if (init.method === "PUT" && !injected) {
          injected = true;
          await rules.withSecurityRulesDisabled(async (context) => {
            await context.database().ref(claimPath).set(claim);
          });
        }
        return fetch(url, init);
      },
    });
    if (allowed) {
      const result = await client.transactPath(path, surrender);
      assert.equal(result.committed, true);
    } else {
      await assert.rejects(
        client.transactPath(path, surrender),
        FirebaseRtdbPermissionDenied,
      );
    }
    assert.equal(injected, true);
    const stored = (
      await rules.unauthenticatedContext().database().ref(path).get()
    ).val();
    assert.equal(stored.status, allowed ? "surrendered" : "");
  }
});

test("REST overrides require the matching actor and match capability", async () => {
  const path = "players/host/matches/invite1";
  const url = emulatorRestUrl(
    `https://mons-link-default-rtdb.firebaseio.com/${path}.json`,
  );
  for (const auth of [
    { uid: "host" },
    { uid: "host", token: { admin: true } },
    { uid: "host", token: { workerSurrenderMatchId: "different" } },
    { uid: "guest", token: { workerSurrenderMatchId: "invite1" } },
    {
      uid: "alternate",
      token: { profileId: "profile-host", workerSurrenderMatchId: "invite1" },
    },
  ]) {
    url.searchParams.set("auth_variable_override", JSON.stringify(auth));
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: "Bearer owner",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...match(), status: "surrendered" }),
    });
    assert.ok([401, 403].includes(response.status));
    assert.match((await response.json()).error, /permission denied/i);
  }
  url.searchParams.set(
    "auth_variable_override",
    JSON.stringify({
      uid: "host",
      token: { workerSurrenderMatchId: "invite1" },
    }),
  );
  url.searchParams.set(
    "auth",
    createMockUserToken(
      { sub: "host", iat: Math.floor(Date.now() / 1_000) },
      "demo-mons-link-rules",
    ),
  );
  const forged = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...match(), status: "surrendered" }),
  });
  assert.ok([400, 401, 403].includes(forged.status));
  await forged.arrayBuffer();
  const client = scopedSurrenderClient();
  assert.equal((await client.transactPath(path, surrender)).committed, true);
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
      await assertFails(reference.update({ status: "surrendered" }));
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
