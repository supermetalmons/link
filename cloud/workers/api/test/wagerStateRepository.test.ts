import assert from "node:assert/strict";
import test from "node:test";
import {
  createWagerStateReader,
  createWagerStateRepository,
  requireWagerWriter,
} from "../src/wagerStateRepository.ts";
import type { SendWagerProposalCommand } from "../src/wagerStateCommands.ts";

function fixture() {
  let accesses = 0;
  const db = new Proxy({} as D1Database, {
    get() {
      accesses++;
      throw new Error("unexpected-database-access");
    },
  });
  return { db, accesses: () => accesses };
}
const proposal: SendWagerProposalCommand = {
  playerUid: "host",
  opponentUid: "guest",
  material: "dust",
  now: 1,
  operationId: "operation",
  reservationOperationId: "reservation",
  selfAdjustmentOperationId: "self",
  opponentAdjustmentOperationId: "opponent",
  opponentProposal: null,
  reservedCount: 1,
};

test("read-only wager capability exposes no writer or generic state operations", () => {
  const f = fixture();
  const reader = createWagerStateReader(f.db);
  assert.deepEqual(Object.keys(reader).sort(), [
    "readInviteWagerPresence",
    "readInviteWagerState",
    "readResolutionMarker",
    "readWager",
  ]);
  assert.throws(() => requireWagerWriter({}), /wager-state-read-only/);
  assert.equal(f.accesses(), 0);
});

test("wager writers expose only concrete domain commands and reject missing admissions before any read", async () => {
  const f = fixture();
  const writer = createWagerStateRepository(f.db, {});
  assert.equal("getPath" in writer, false);
  assert.equal("patchRoot" in writer, false);
  assert.equal("transactPath" in writer, false);
  const key = { inviteId: "invite", matchId: "match" };
  for (const mutation of [
    () => writer.sendProposal(key, proposal),
    () =>
      writer.acceptProposal(
        key,
        {} as Parameters<typeof writer.acceptProposal>[1],
      ),
    () =>
      writer.removeProposal(key, {
        proposalUid: "host",
        operationId: "remove",
        expectedReservationOperationId: "reservation",
      }),
    () =>
      writer.markLineageReady(key, {
        operationId: "operation",
        fingerprint: "fingerprint",
      }),
    () =>
      writer.claimSettlement(
        key,
        {} as Parameters<typeof writer.claimSettlement>[1],
      ),
    () =>
      writer.completeSettlement(
        key,
        {} as Parameters<typeof writer.completeSettlement>[1],
      ),
  ])
    await assert.rejects(mutation, /wager-state-read-only/);
  assert.equal(f.accesses(), 0);
});

test("typed keys reject unsafe IDs before touching D1", async () => {
  const f = fixture();
  const reader = createWagerStateReader(f.db);
  for (const key of [
    { inviteId: "invite/child", matchId: "match" },
    { inviteId: "invite", matchId: "match/child" },
    { inviteId: "", matchId: "match" },
  ]) {
    await assert.rejects(reader.readWager(key), /invalid-wager-state-key/);
    await assert.rejects(
      reader.readResolutionMarker(key),
      /invalid-wager-state-key/,
    );
  }
  await assert.rejects(
    reader.readInviteWagerState("invite/child"),
    /invalid-wager-state-key/,
  );
  await assert.rejects(
    reader.readInviteWagerPresence("invite/child"),
    /invalid-wager-state-key/,
  );
  assert.equal(f.accesses(), 0);
});

test("a cancelled command cannot read or dispatch a notification", async () => {
  const f = fixture();
  let notices = 0;
  const writer = createWagerStateRepository(f.db, {
    writeGuards: () => [],
    notify: async () => {
      notices++;
    },
  });
  const reason = new Error("cancelled");
  await assert.rejects(
    writer.sendProposal(
      { inviteId: "invite", matchId: "match" },
      proposal,
      AbortSignal.abort(reason),
    ),
    (error) => error === reason,
  );
  assert.equal(f.accesses(), 0);
  assert.equal(notices, 0);
});

test("cancellation during a read prevents the decision, write, and notification", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled-during-read");
  let reads = 0;
  let notices = 0;
  const db = new Proxy({} as D1Database, {
    get(_target, property) {
      if (property === "withSession")
        return () => ({
          prepare: () => ({
            bind: () => ({
              async first() {
                reads++;
                controller.abort(reason);
                return null;
              },
            }),
          }),
        });
      throw new Error("unexpected-database-access");
    },
  });
  const writer = createWagerStateRepository(db, {
    writeGuards: () => [],
    notify: async () => {
      notices++;
    },
  });
  await assert.rejects(
    writer.sendProposal(
      { inviteId: "invite", matchId: "match" },
      proposal,
      controller.signal,
    ),
    (error) => error === reason,
  );
  assert.equal(reads, 1);
  assert.equal(notices, 0);
});
