import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmptyWager,
  decodeWager,
  isWagerRecord,
  lineageFingerprint,
  parseWagerRecord,
  wagerReferencesReservationOperation,
  type WagerRecord,
} from "../src/wagerModel.ts";
import {
  acceptProposalDecision,
  claimSettlementDecision,
  completeSettlementDecision,
  markLineageReadyDecision,
  removeProposalDecision,
  sendProposalDecision,
  type AcceptWagerProposalCommand,
  type SendWagerProposalCommand,
} from "../src/wagerStateCommands.ts";
import {
  classifyWagerSettlementRetry,
  resumeWagerSettlement,
} from "../src/wagerOutcome.ts";
const operationId = "a".repeat(64),
  reservationOperationId = "b".repeat(64),
  opponentOperationId = "c".repeat(64),
  opponentReservationOperationId = "d".repeat(64);
const send: SendWagerProposalCommand = {
  playerUid: "host",
  opponentUid: "guest",
  material: "dust",
  now: 100,
  operationId,
  reservationOperationId,
  selfAdjustmentOperationId: "e".repeat(64),
  opponentAdjustmentOperationId: "f".repeat(64),
  opponentProposal: {
    material: "dust",
    count: 2,
    operationId: opponentOperationId,
    reservationOperationId: opponentReservationOperationId,
  },
  reservedCount: 2,
};
const accept: AcceptWagerProposalCommand = {
  playerUid: "host",
  opponentUid: "guest",
  operationId,
  material: "dust",
  proposedCount: 2,
  opponentProposalOperationId: opponentOperationId,
  opponentReservationOperationId,
  hasOwnProposal: false,
  ownMaterial: "",
  ownCount: 0,
  ownProposalOperationId: "",
  ownReservationOperationId: "",
  acceptedCount: 2,
  now: 100,
  proposerAdjustmentOperationId: "e".repeat(64),
  reservationOperationId,
};
const claim = {
  resolution: {
    winnerUid: "host",
    loserUid: "guest",
    winnerProfileId: "profile-host",
    loserProfileId: "profile-guest",
  },
  operationId,
  now: 200,
  acceptReservationOperationIdByUid: {
    host: reservationOperationId,
    guest: opponentReservationOperationId,
  },
};
function proposed(): WagerRecord {
  return {
    ...createEmptyWager(),
    proposals: {
      guest: {
        material: "dust",
        count: 2,
        createdAt: 50,
        operationId: opponentOperationId,
        reservationOperationId: opponentReservationOperationId,
      },
    },
    proposedBy: { guest: true },
  };
}
function agreed(): WagerRecord {
  const decision = acceptProposalDecision(proposed(), accept);
  if ("commit" in decision || !decision.value)
    throw new Error("agreement-required");
  return decision.value;
}
function blocked(): WagerRecord {
  return parseWagerRecord({
    ...createEmptyWager(),
    agreed: agreed().agreed,
    state: "blocked",
    blocked: {
      reason: "legacy-agreement-unsettled",
      requiresManualReview: true,
      detectedAtMs: 300,
      sourceDigest: "e".repeat(64),
      knownResolution: null,
      operationIds: [],
    },
  });
}
test("runtime accepts only exact canonical records and explicit null absence", () => {
  assert.equal(decodeWager(null), null);
  for (const invalid of [
    undefined,
    {},
    false,
    [],
    { proposals: {} },
    { ...createEmptyWager(), future: true },
    { ...createEmptyWager(), schemaVersion: 0 },
    { ...createEmptyWager(), agreed: {} },
  ]) {
    assert.throws(() => decodeWager(invalid), /invalid-canonical-wager/);
  }
  assert.strictEqual(parseWagerRecord(proposed()).state, "proposed");
});
test("malformed money, identities, duplicate references, and state combinations reject", () => {
  const record = agreed();
  for (const invalid of [
    { ...record, agreed: { ...record.agreed, count: 2.3 } },
    { ...record, agreed: { ...record.agreed, total: 3 } },
    { ...record, agreed: { ...record.agreed, proposerId: " guest " } },
    {
      ...record,
      agreementOperation: {
        ...record.agreementOperation,
        proposerReservationOperationIds: [operationId, operationId],
      },
    },
    { ...record, state: "proposed" },
    { ...record, blocked: { reason: "unknown" } },
  ])
    assert.equal(isWagerRecord(invalid), false);
});
test("new send and accept lifecycle constructs canonical records and preserves replay identities", () => {
  const sent = sendProposalDecision(null, send);
  assert.ok("value" in sent && sent.value);
  assert.ok(isWagerRecord(sent.value));
  assert.equal(
    sent.value.proposals.host?.reservationOperationId,
    reservationOperationId,
  );
  assert.deepEqual(sendProposalDecision(sent.value, send), {
    commit: false,
    decision: "replayed",
  });
  const accepted = agreed();
  assert.equal(accepted.state, "agreed");
  assert.deepEqual(accepted.proposals, {});
  assert.deepEqual(accepted.agreementOperation?.reservationAdjustments, []);
  assert.deepEqual(acceptProposalDecision(accepted, accept), {
    commit: false,
    decision: "replayed",
  });
});
test("settlement completion preserves its idempotency fingerprint and cannot be paid twice", () => {
  const claimed = claimSettlementDecision(agreed(), claim);
  assert.ok("value" in claimed && claimed.value?.settlement);
  assert.equal(claimed.value.state, "settling");
  const settlement = claimed.value.settlement;
  const completed = completeSettlementDecision(claimed.value, {
    settlement,
    completedAtMs: 220,
    insufficientMaterials: false,
  });
  assert.ok("value" in completed && completed.value?.settlement);
  assert.equal(completed.value.state, "settled");
  assert.equal(completed.value.settlement.fingerprint, settlement.fingerprint);
  assert.equal(completed.value.resolved?.winnerId, "host");
  assert.deepEqual(claimSettlementDecision(completed.value, claim), {
    commit: false,
    decision: "already-resolved",
  });
  assert.deepEqual(
    completeSettlementDecision(completed.value, {
      settlement,
      completedAtMs: 230,
      insufficientMaterials: false,
    }),
    { commit: false, decision: "completed" },
  );
});
test("failed transfer settles without a winner and clears the agreement", () => {
  const claimed = claimSettlementDecision(agreed(), claim);
  assert.ok("value" in claimed && claimed.value?.settlement);
  const result = completeSettlementDecision(claimed.value, {
    settlement: claimed.value.settlement,
    completedAtMs: 220,
    insufficientMaterials: true,
  });
  assert.ok("value" in result && result.value);
  assert.equal(result.value.state, "settled");
  assert.equal(result.value.resolved, null);
  assert.equal(result.value.agreed, null);
  assert.equal(
    result.value.settlement?.failureReason,
    "insufficient-materials",
  );
});
test("blocked records reject every mutation and retain all reservations", async () => {
  const wager = blocked();
  const before = structuredClone(wager);
  assert.deepEqual(sendProposalDecision(wager, send), {
    commit: false,
    decision: "unavailable",
  });
  assert.deepEqual(acceptProposalDecision(wager, accept), {
    commit: false,
    decision: "proposal-unavailable",
  });
  assert.deepEqual(
    removeProposalDecision(wager, {
      proposalUid: "guest",
      operationId,
      expectedReservationOperationId: opponentReservationOperationId,
    }),
    { commit: false, decision: "proposal-missing" },
  );
  assert.deepEqual(
    markLineageReadyDecision(wager, {
      operationId,
      fingerprint: lineageFingerprint(wager),
    }),
    { commit: false, decision: "agreement-missing" },
  );
  assert.deepEqual(claimSettlementDecision(wager, claim), {
    commit: false,
    decision: "manual-required",
  });
  assert.equal(
    wagerReferencesReservationOperation(
      wager,
      "guest",
      opponentReservationOperationId,
    ),
    true,
  );
  assert.equal(
    wagerReferencesReservationOperation(wager, "host", "f".repeat(64)),
    true,
  );
  assert.deepEqual(wager, before);
  const repository = {
    wagers: { readWager: async () => wager },
  };
  const task = {
    kind: "wager-settlement" as const,
    inviteId: "invite",
    matchId: "invite",
    operationId,
    resolution: claim.resolution,
  };
  assert.equal(
    await Reflect.apply(classifyWagerSettlementRetry, undefined, [
      task,
      repository,
    ]),
    "stale",
  );
  assert.equal(
    await Reflect.apply(resumeWagerSettlement, undefined, [task, repository]),
    "stale",
  );
});
