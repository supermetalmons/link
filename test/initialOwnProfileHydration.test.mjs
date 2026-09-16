import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { isPlayerProfile } from "@mons/shared/profiles";

const source = ts.createSourceFile(
  "connection.ts",
  readFileSync(
    new URL("../src/connection/connection.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const connectionClass = source.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name?.text === "Connection",
);
const method = connectionClass.members.find(
  (node) => node.name?.getText(source) === "hydrateSameProfilePlayer",
);
const { outputText } = ts.transpileModule(
  `class Connection { ${method.getText(source)} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
const profile = {
  id: "profile",
  username: "Verified",
  eth: null,
  sol: null,
  emoji: 1,
  rating: 1500,
  nonce: 1,
  totalManaPoints: 0,
  win: false,
  mining: {
    lastRockDate: null,
    materials: { dust: 0, slime: 0, gum: 0, metal: 0, ice: 0 },
  },
};
const flush = () => new Promise(setImmediate);
function harness({
  pending = null,
  stashed,
  consumed = true,
  freshProfile = profile,
} = {}) {
  const reads = [];
  const applied = [];
  const state = { consumed, profileId: "profile" };
  const profiles = { login: stashed };
  const user = { uid: "login", sessionId: "session", generation: "generation" };
  const dependencies = {
    setupPlayerId: () => {},
    peekInitialIdentity: (owner) => {
      assert.equal(owner, user);
      return pending;
    },
    wasInitialIdentityConsumed: () => state.consumed,
    profilesForUids: profiles,
    isPlayerProfile,
    didGetPlayerProfile: (value, uid) => applied.push({ value, uid }),
  };
  const Constructor = new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn Connection;`,
  )(...Object.values(dependencies));
  const instance = new Constructor();
  Object.assign(instance, {
    auth: { currentUser: user },
    sessionEpoch: 1,
    sameProfilePlayerUid: "login",
    sameProfileHydrationRequest: null,
    activeContext: { inviteId: "invite" },
    isSessionEpochActive: (epoch) => epoch === instance.sessionEpoch,
    getLocalProfileId: () => state.profileId,
    getPlayerProfileWithRetry: async (uid) => {
      reads.push(uid);
      return freshProfile;
    },
  });
  return { instance, user, reads, applied, state, profiles };
}

test("first initial own invite hydration joins identity; subsequent hydration reads fresh data", async () => {
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const h = harness({ pending });
  h.instance.hydrateSameProfilePlayer("login", true);
  await flush();
  assert.deepEqual(h.reads, []);
  resolve({ user: h.user, read: () => ({ ok: true, profile }) });
  await flush();
  assert.deepEqual(h.applied, [{ value: profile, uid: "login" }]);
  assert.deepEqual(h.reads, []);
  h.instance.hydrateSameProfilePlayer("login");
  await flush();
  assert.deepEqual(h.reads, ["login"]);
});

test("already-applied complete own startup profile avoids only the initial invite lookup", async () => {
  const h = harness({ stashed: profile });
  h.instance.hydrateSameProfilePlayer("login", true);
  await flush();
  assert.deepEqual(h.reads, []);
  assert.equal(h.applied[0].value, profile);
  h.instance.hydrateSameProfilePlayer("login");
  await flush();
  assert.deepEqual(h.reads, ["login"]);
});

test("later first hydration reads fresh inventory instead of the consumed startup stash", async () => {
  const freshProfile = {
    ...profile,
    mining: {
      lastRockDate: "2026-09-16",
      materials: { ...profile.mining.materials, dust: 8 },
    },
  };
  const h = harness({ stashed: profile, freshProfile });
  h.instance.sessionEpoch++;
  h.instance.hydrateSameProfilePlayer("login");
  await flush();
  assert.deepEqual(h.reads, ["login"]);
  assert.deepEqual(h.applied, [{ value: freshProfile, uid: "login" }]);
});

test("alias actors, invalidated identities and foreign stashes keep normal profile reads", async () => {
  for (const options of [
    { stashed: { ...profile, id: "other-profile" } },
    { stashed: { id: "profile", username: "Partial" } },
    { stashed: profile, consumed: false },
  ]) {
    const h = harness(options);
    h.instance.hydrateSameProfilePlayer("login", true);
    await flush();
    assert.deepEqual(h.reads, ["login"]);
  }
  const alias = harness({ stashed: profile });
  alias.instance.sameProfilePlayerUid = "alias-login";
  alias.instance.hydrateSameProfilePlayer("alias-login", true);
  await flush();
  assert.deepEqual(alias.reads, ["alias-login"]);
});

test("a delayed startup hydration cannot apply after same-UID session replacement", async () => {
  let resolve;
  const h = harness({
    pending: new Promise((done) => {
      resolve = done;
    }),
  });
  h.instance.hydrateSameProfilePlayer("login", true);
  h.instance.auth.currentUser = { ...h.user, generation: "replacement" };
  resolve({ user: h.user, read: () => ({ ok: true, profile }) });
  await flush();
  assert.deepEqual(h.applied, []);
  assert.deepEqual(h.reads, []);
});

const newerProfile = {
  ...profile,
  username: "NewerVerifiedName",
  mining: {
    ...profile.mining,
    materials: { ...profile.mining.materials, dust: 99 },
  },
};

test("a mutation after reading the pending identity preserves newer name and mining data at commit", async () => {
  const gate = Promise.withResolvers();
  const h = harness({ pending: gate.promise });
  let valid = true;
  const result = {
    user: h.user,
    read: () => {
      if (!valid) throw new Error("authentication-changed");
      return { ok: true, profile };
    },
  };
  h.instance.hydrateSameProfilePlayer("login", true);
  gate.resolve(result);
  queueMicrotask(() => {
    valid = false;
    h.applied.push({ value: newerProfile, uid: "login" });
  });
  await flush();
  assert.throws(() => result.read(), /authentication-changed/);
  assert.equal(h.instance.auth.currentUser, h.user);
  assert.equal(h.instance.sessionEpoch, 1);
  assert.deepEqual(h.applied, [{ value: newerProfile, uid: "login" }]);
  assert.deepEqual(h.reads, []);
});

for (const change of [
  "invalidation",
  "cache replacement",
  "profile replacement",
]) {
  test(`newer name and mining data survive ${change} after the startup cache is read`, async () => {
    const h = harness({ stashed: profile });
    queueMicrotask(() => {
      if (change === "invalidation") h.state.consumed = false;
      if (change === "cache replacement") h.profiles.login = newerProfile;
      if (change === "profile replacement") h.state.profileId = "new-profile";
      h.applied.push({ value: newerProfile, uid: "login" });
    });
    h.instance.hydrateSameProfilePlayer("login", true);
    await flush();
    assert.equal(h.instance.auth.currentUser, h.user);
    assert.equal(h.instance.sessionEpoch, 1);
    assert.deepEqual(h.applied, [{ value: newerProfile, uid: "login" }]);
    assert.deepEqual(h.reads, []);
  });
}
