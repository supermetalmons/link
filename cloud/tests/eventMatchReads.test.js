"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createEventBracketRuntime } = require("../runtime/events/bracket");

const match = (id, overrides = {}) => ({
  status: "active",
  inviteId: id,
  hostLoginUid: `${id}-host-login`,
  guestLoginUid: `${id}-guest-login`,
  hostProfileId: `${id}-host`,
  guestProfileId: `${id}-guest`,
  ...overrides,
});

test("round resolution reads only valid unresolved pairs in one ordered batch", async () => {
  const reads = [];
  const winners = [];
  const runtime = createEventBracketRuntime({
    readMatchPair: () => assert.fail("unexpected single match read"),
    readMatchPairs: async (inputs) => {
      reads.push(inputs);
      return inputs.map(({ inviteId }) => [inviteId, `${inviteId}-opponent`]);
    },
    resolveMatchWinner: async (host, guest) => {
      winners.push([host, guest]);
      return { winner: host === "first" ? "player" : "opponent" };
    },
  });
  const matches = {
    first: match("first", {
      inviteId: " first ",
      hostLoginUid: " first-host-login ",
      guestLoginUid: " first-guest-login ",
    }),
    completed: match("completed", { status: "host" }),
    bye: match("bye", { status: "bye", winnerProfileId: "bye-host" }),
    invalid: match("invalid", { guestLoginUid: null }),
    absent: null,
    second: match("second"),
  };
  const results = await runtime.resolveRoundMatchesWithConcurrency(matches);

  assert.deepEqual(reads, [
    [
      {
        inviteId: "first",
        matchId: "first",
        playerId: "first-host-login",
        opponentId: "first-guest-login",
      },
      {
        inviteId: "second",
        matchId: "second",
        playerId: "second-host-login",
        opponentId: "second-guest-login",
      },
    ],
  ]);
  assert.deepEqual(winners, [
    ["first", "first-opponent"],
    ["second", "second-opponent"],
  ]);
  assert.deepEqual(
    results.map(({ matchKey }) => matchKey),
    Object.keys(matches),
  );
  assert.deepEqual(
    results.map(({ resolved }) => resolved?.status ?? null),
    ["host", "host", "bye", null, null, "guest"],
  );
  assert.equal(results[0].matchRecord, matches.first);
  assert.equal(results[5].resolved.winnerProfileId, "second-guest");
});

test("finalized, bye and invalid-only rounds do not read match state", async () => {
  const runtime = createEventBracketRuntime({
    readMatchPair: () => assert.fail("unexpected single match read"),
    readMatchPairs: () => assert.fail("unexpected match batch read"),
    resolveMatchWinner: () => assert.fail("unexpected winner resolution"),
  });
  assert.deepEqual(await runtime.resolveRoundMatchesWithConcurrency({}), []);
  const results = await runtime.resolveRoundMatchesWithConcurrency({
    host: match("host", { status: "host" }),
    guest: match("guest", { status: "guest" }),
    bye: match("bye", { status: "bye", winnerProfileId: "bye-host" }),
    invalidBye: match("bye", { status: "bye" }),
    invalid: match("invalid", { inviteId: null }),
    absent: null,
  });
  assert.deepEqual(
    results.map(({ resolved }) => resolved?.status ?? null),
    ["host", "guest", "bye", null, null, null],
  );
});

test("large rounds batch all reads while limiting winner work to four", async () => {
  let batches = 0;
  let running = 0;
  let peak = 0;
  const runtime = createEventBracketRuntime({
    readMatchPair: () => assert.fail("unexpected single match read"),
    readMatchPairs: async (inputs) => {
      batches += 1;
      assert.equal(inputs.length, 16);
      return inputs.map(({ inviteId }) => [inviteId, null]);
    },
    resolveMatchWinner: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
      return { winner: null };
    },
  });
  const results = await runtime.resolveRoundMatchesWithConcurrency(
    Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [index, match(String(index))]),
    ),
  );
  assert.equal(results.length, 16);
  assert.equal(batches, 1);
  assert.equal(peak, 4);
  assert.equal(running, 0);
});

test("single third-place resolution keeps the ordinary pair read", async () => {
  let reads = 0;
  const runtime = createEventBracketRuntime({
    readMatchPair: async (input) => {
      reads += 1;
      assert.equal(input.inviteId, "third-place");
      return ["host", "guest"];
    },
    readMatchPairs: () => assert.fail("unexpected match batch read"),
    resolveMatchWinner: async (host, guest) => {
      assert.deepEqual([host, guest], ["host", "guest"]);
      return { winner: "opponent" };
    },
  });
  assert.deepEqual(await runtime.resolveRoundMatchState(match("third-place")), {
    status: "guest",
    winnerProfileId: "third-place-guest",
    loserProfileId: "third-place-host",
  });
  assert.equal(reads, 1);
});

test("invalid batch results never fall back to singleton reads", async () => {
  for (const pairs of [[], [[null]], new Array(1)]) {
    const runtime = createEventBracketRuntime({
      readMatchPair: () => assert.fail("unexpected single match read"),
      readMatchPairs: async () => pairs,
      resolveMatchWinner: () => assert.fail("unexpected winner resolution"),
    });
    await assert.rejects(
      runtime.resolveRoundMatchesWithConcurrency({ first: match("first") }),
      /event-match-batch-invalid/,
    );
  }
});
