import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  APPROVED_ORPHAN_TIMER_CONTEXTS,
  RETIRED_ORPHAN_TIMER_SIGNATURES,
  isRetiredOrphanTimer,
  retiredOrphanTimerSignature,
  type OrphanTimerIdentity,
} from "../src/retiredOrphanTimers.ts";

const target: OrphanTimerIdentity = {
  inviteId: "synthetic-invite",
  matchId: "synthetic-invite",
  playerId: "synthetic-host",
  opponentId: "synthetic-guest",
  turnNumber: 7,
  deadlineAtMs: 1_900_000_000_000,
};

test("retired timer signatures bind the exact normalized identity and deadline", () => {
  const expected = createHash("sha256")
    .update(
      JSON.stringify([
        "mons-orphan-timer-cancellation-v1",
        target.inviteId,
        target.matchId,
        target.playerId,
        target.opponentId,
        target.turnNumber,
        target.deadlineAtMs,
      ]),
    )
    .digest("hex");
  assert.equal(retiredOrphanTimerSignature(target), expected);
  assert.equal(isRetiredOrphanTimer(target), false);
  for (const changed of [
    { ...target, inviteId: "another-invite" },
    { ...target, matchId: "another-match" },
    { ...target, playerId: "another-player" },
    { ...target, opponentId: "another-opponent" },
    { ...target, turnNumber: target.turnNumber + 1 },
    { ...target, deadlineAtMs: target.deadlineAtMs + 1 },
  ])
    assert.notEqual(retiredOrphanTimerSignature(changed), expected);
});

test("retired timer policy contains only 21 unique bounded approvals", () => {
  assert.equal(RETIRED_ORPHAN_TIMER_SIGNATURES.length, 21);
  assert.equal(new Set(RETIRED_ORPHAN_TIMER_SIGNATURES).size, 21);
  assert.equal(APPROVED_ORPHAN_TIMER_CONTEXTS.length, 21);
  assert.deepEqual(
    APPROVED_ORPHAN_TIMER_CONTEXTS.map((item) => item.signature).sort(),
    [...RETIRED_ORPHAN_TIMER_SIGNATURES].sort(),
  );
  for (const item of APPROVED_ORPHAN_TIMER_CONTEXTS) {
    assert.match(item.signature, /^[a-f0-9]{64}$/);
    assert.match(item.beforeDigest, /^[a-f0-9]{64}$/);
    assert.match(item.afterDigest, /^[a-f0-9]{64}$/);
    assert.notEqual(item.beforeDigest, item.afterDigest);
  }
});
