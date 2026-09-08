import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = ts.createSourceFile(
  "connection.ts",
  readFileSync(
    new URL("../src/connection/connection.ts", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
);
const declaration = source.statements.find(
  (node) => ts.isClassDeclaration(node) && node.name?.text === "Connection",
);
const methods = [
  "createSessionGuard",
  "isSessionEpochActive",
  "isContextActive",
  "isCurrentAuthUser",
  "shouldContinueCriticalMoveSend",
  "verifyMovePersistedAfterRetryWindow",
].map((name) => {
  const method = declaration.members.find(
    (node) => node.name?.getText(source) === name,
  );
  assert.ok(method, `missing Connection.${name}`);
  return method.getText(source);
});
const { outputText } = ts.transpileModule(
  `class Connection { ${methods.join("\n")} }`.replaceAll(
    "import.meta.env.DEV",
    "false",
  ),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
);
const persistedMatch = {
  version: 1,
  color: "white",
  emojiId: 1,
  fen: "expected-fen",
  gameVariant: "classic",
  status: "",
  flatMovesString: "move-one-move-two",
  timer: "",
};
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

function harness({ read = () => persistedMatch, windowMs = 3500 } = {}) {
  let now = 10_000;
  const reads = [];
  const delays = [];
  const dependencies = {
    Date: { now: () => now },
    readMatchSnapshotViaApi: async (input, options) => {
      reads.push({ ...input, ...options, startedAt: now });
      return {
        ok: true,
        ...input,
        match: await read(reads.length, options),
      };
    },
  };
  const Constructor = new Function(
    ...Object.keys(dependencies),
    `${outputText}\nreturn Connection;`,
  )(...Object.values(dependencies));
  const instance = Object.assign(new Constructor(), {
    auth: { currentUser: { uid: "login" } },
    sessionEpoch: 2,
    moveSendRequestId: 3,
    moveSendPostRetryVerificationWindowMs: windowMs,
    moveSendPostRetryPollIntervalMs: 350,
    activeContext: {
      contextId: 4,
      sessionEpoch: 2,
      inviteId: "invite",
      matchId: "invite1",
      actorUid: "actor",
      loginUid: "login",
      canWrite: true,
      role: "host",
    },
    delay: async (milliseconds) => {
      delays.push(milliseconds);
      now += milliseconds;
    },
  });
  return {
    instance,
    reads,
    delays,
    advance: (milliseconds) => {
      now += milliseconds;
    },
    verify: () =>
      instance.verifyMovePersistedAfterRetryWindow(
        3,
        "actor",
        "invite1",
        4,
        2,
        persistedMatch.fen,
        persistedMatch.flatMovesString,
        instance.createSessionGuard(),
      ),
  };
}

test("uncertain move verification accepts a matching Worker match snapshot", async () => {
  const h = harness();
  assert.equal(await h.verify(), true);
  assert.deepEqual(h.reads, [
    {
      playerId: "actor",
      matchId: "invite1",
      timeoutMs: 1200,
      startedAt: 10_000,
    },
  ]);
  assert.deepEqual(h.delays, []);
});

for (const [label, match] of [
  ["different FEN", { ...persistedMatch, fen: "older-fen" }],
  ["different move chain", { ...persistedMatch, flatMovesString: "move-one" }],
  ["missing match", null],
]) {
  test(`uncertain move verification does not confirm a ${label}`, async () => {
    const h = harness({ read: () => match });
    assert.equal(await h.verify(), false);
    assert.ok(h.reads.length > 1);
    assert.ok(h.reads.every(({ timeoutMs }) => timeoutMs <= 1200));
    assert.equal(
      h.delays.reduce((sum, delay) => sum + delay, 0),
      3500,
    );
  });
}

test("uncertain move verification tolerates an unavailable snapshot and confirms later persistence", async () => {
  const h = harness({
    read: (attempt) => {
      if (attempt === 1) throw new Error("snapshot-unavailable");
      return persistedMatch;
    },
  });
  assert.equal(await h.verify(), true);
  assert.equal(h.reads.length, 2);
  assert.deepEqual(h.delays, [350]);
});

test("uncertain move verification exhausts unavailable reads without confirming persistence", async () => {
  const h = harness({
    read: () => {
      throw new Error("snapshot-unavailable");
    },
  });
  assert.equal(await h.verify(), false);
  assert.ok(h.reads.length > 1);
  assert.ok(h.reads.every(({ startedAt }) => startedAt < 13_500));
});

for (const [label, invalidate] of [
  ["context replacement", (h) => h.instance.activeContext.contextId++],
  [
    "account replacement",
    (h) => (h.instance.auth.currentUser = { uid: "new" }),
  ],
  ["navigation", (h) => h.instance.sessionEpoch++],
  ["a newer move", (h) => h.instance.moveSendRequestId++],
]) {
  test(`a matching snapshot received after ${label} cannot confirm an old move`, async () => {
    const pending = deferred();
    const h = harness({ read: () => pending.promise });
    const verification = h.verify();
    assert.equal(h.reads.length, 1);
    invalidate(h);
    pending.resolve(persistedMatch);
    assert.equal(await verification, false);
    assert.equal(h.reads.length, 1);
    assert.deepEqual(h.delays, []);
  });
}

test("uncertain move verification caps each HTTP read at the remaining budget", async () => {
  const h = harness({
    read: (_attempt, { timeoutMs }) => {
      h.advance(timeoutMs);
      return null;
    },
  });
  assert.equal(await h.verify(), false);
  assert.deepEqual(
    h.reads.map(({ timeoutMs }) => timeoutMs),
    [1200, 1200, 400],
  );
  assert.deepEqual(h.delays, [350, 350]);
});

test("uncertain move verification uses a sub-1200ms remaining window", async () => {
  const h = harness({ windowMs: 900 });
  assert.equal(await h.verify(), true);
  assert.equal(h.reads[0].timeoutMs, 900);
});

test("a matching snapshot arriving at the verification deadline cannot confirm persistence", async () => {
  const h = harness({
    windowMs: 900,
    read: () => {
      h.advance(900);
      return persistedMatch;
    },
  });
  assert.equal(await h.verify(), false);
  assert.equal(h.reads.length, 1);
  assert.deepEqual(h.delays, []);
});
