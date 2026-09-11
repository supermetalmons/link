import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { setImmediate } from "node:timers/promises";
import { Game } from "mons-rules";
import { MoveDelivery } from "../src/connection/moveDelivery.ts";
import { submitMove } from "../cloud/workers/api/src/matchMove.ts";
import { decideMatchStateMove } from "../cloud/workers/api/src/matchStateLogic.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.endsWith(".ts") &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[^/]+$/.test(specifier)
    )
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});

const scope = {
  loginUid: "actor",
  playerId: "actor",
  inviteId: "abcdefghijk",
  matchId: "abcdefghijk",
};

function moveSequence() {
  const game = new Game();
  const initial = { fen: game.toFen(), flatMovesString: "" };
  const outputs = [];
  for (let step = 0; step < 4; step++) {
    let output;
    if (step === 2) output = game.takeback();
    else {
      const inputs = [];
      for (let selection = 0; selection < 8; selection++) {
        const preview = game.preview(inputs);
        if (preview.kind === "complete") {
          output = game.play(inputs);
          break;
        }
        const input =
          preview.kind === "awaiting-start"
            ? { kind: "position", position: preview.positions[0] }
            : preview.kind === "awaiting-input"
              ? preview.options[0]?.input
              : undefined;
        assert.ok(input);
        inputs.push(input);
      }
    }
    assert.equal(output?.kind, "complete");
    outputs.push({ moveFen: output.inputFen, fen: game.toFen() });
  }
  assert.equal(outputs[1].fen, outputs[3].fen);
  assert.equal(outputs[2].moveFen, "z");
  return { initial, outputs, finalFen: game.toFen() };
}

function harness() {
  const sequence = moveSequence();
  let stored = {
    ...sequence.initial,
    gameVariant: "Classic",
    status: "",
    timer: "preserved",
    custom: { marker: 1 },
  };
  let revision = 0;
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key),
  };
  const repository = {
    readInviteMetadata: async (inviteId, signal) => {
      assert.equal(inviteId, scope.inviteId);
      signal.throwIfAborted();
      return {
        hostId: scope.playerId,
        guestId: "opponent",
        hostRematches: "",
        guestRematches: "",
      };
    },
    readProfileOwnershipSnapshot: () => {
      throw new Error("Unexpected linked identity lookup");
    },
  };
  const service = (request) =>
    submitMove({ uid: scope.loginUid }, request, repository, {
      submitCanonical: async (input) => {
        const decision = decideMatchStateMove(structuredClone(stored), input);
        if (decision.outcome === "applied") {
          stored = structuredClone(decision.value);
          revision++;
        }
        return {
          ok: true,
          inviteId: input.inviteId,
          matchId: input.matchId,
          actorUid: input.playerId,
          outcome: decision.outcome,
          ...(decision.outcome === "superseded"
            ? { fen: stored.fen, flatMovesString: stored.flatMovesString }
            : {}),
        };
      },
    });
  function delivery() {
    const requests = [];
    const failures = [];
    const advances = [];
    const outbox = new MoveDelivery(
      scope,
      { ...stored },
      {
        storage,
        isAuthorized: () => true,
        isOnline: () => true,
        submit: (request, { signal }) =>
          new Promise((resolve, reject) => {
            const cancel = () => reject(new Error("request-aborted"));
            signal.addEventListener("abort", cancel, { once: true });
            requests.push({
              request,
              resolve: (value) => {
                signal.removeEventListener("abort", cancel);
                resolve(value);
              },
              reject,
            });
          }),
        read: async () => ({
          fen: stored.fen,
          flatMovesString: stored.flatMovesString,
        }),
        onError: (error, kind) => failures.push({ error, kind }),
        onRemoteAdvance: () => advances.push(true),
      },
    );
    return { outbox, requests, failures, advances };
  }
  return {
    ...sequence,
    records,
    delivery,
    service,
    stored: () => stored,
    writes: () => revision,
  };
}

const settled = async () => {
  await setImmediate();
  await setImmediate();
};

function enqueueSequence(outbox, outputs) {
  for (const output of outputs) outbox.enqueue(output.moveFen, output.fen);
}

function assertFinalGame(h) {
  const replay = new Game();
  const history = h.stored().flatMovesString;
  for (const action of history.split("-"))
    assert.equal(replay.playFen(action).kind, "complete");
  assert.equal(replay.toFen(), h.finalFen);
  assert.equal(h.stored().fen, h.finalFen);
  assert.equal(h.stored().timer, "preserved");
  assert.deepEqual(h.stored().custom, { marker: 1 });
  assert.deepEqual(
    history.split("-"),
    h.outputs.map((output) => output.moveFen),
  );
}

test("actual outbox and API recover missing predecessors and ignore a stale superseded response", async () => {
  const h = harness();
  const client = h.delivery();
  try {
    enqueueSequence(client.outbox, h.outputs);
    const completed = client.outbox.flush();
    await settled();
    assert.equal(client.requests.length, 2);
    const [first, second] = client.requests;
    second.resolve(await h.service(second.request));
    await settled();
    assert.equal(client.requests.length, 3);
    assert.equal(client.outbox.hasPendingMoves, true);
    const staleSuperseded = await h.service(first.request);
    assert.equal(staleSuperseded.outcome, "superseded");
    const latest = client.requests[2];
    latest.resolve(await h.service(latest.request));
    await completed;
    first.resolve(staleSuperseded);
    await settled();
    assert.equal(client.failures.length, 0);
    assert.equal(client.outbox.hasPendingMoves, false);
    assert.equal(client.outbox.isConflicted, false);
    assert.equal(h.records.size, 0);
    assert.equal(h.writes(), 2);
    assertFinalGame(h);
  } finally {
    client.outbox.pause();
  }
});

test("reload after a committed response is lost resumes the remaining move and takeback suffix", async () => {
  const h = harness();
  const firstClient = h.delivery();
  let secondClient;
  try {
    enqueueSequence(firstClient.outbox, h.outputs);
    await settled();
    await h.service(firstClient.requests[1].request);
    assert.equal(h.records.size, 1);
    firstClient.outbox.pause();
    await settled();
    secondClient = h.delivery();
    const optimistic = secondClient.outbox.reconcile(h.stored());
    assert.equal(optimistic.fen, h.finalFen);
    assert.equal(optimistic.flatMovesString.split("-").length, 4);
    const completed = secondClient.outbox.flush();
    await settled();
    assert.equal(secondClient.requests.length, 1);
    const resumed = secondClient.requests[0];
    assert.equal(resumed.request.previousStates[0].moveCount, 2);
    resumed.resolve(await h.service(resumed.request));
    await completed;
    assert.equal(secondClient.failures.length, 0);
    assert.equal(h.records.size, 0);
    assert.equal(h.writes(), 2);
    assertFinalGame(h);
  } finally {
    firstClient.outbox.pause();
    secondClient?.outbox.pause();
  }
});
