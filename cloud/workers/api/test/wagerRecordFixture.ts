import { createEmptyWager } from "../src/wagerModel.ts";

export function wagerRecordFixture(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return value;
  const fields = value as Record<string, unknown>;
  if (fields.schemaVersion !== undefined) return value;
  const settlement = fields.settlement as
    Record<string, unknown> | null | undefined;
  return {
    ...createEmptyWager(),
    ...fields,
    state: fields.blocked
      ? "blocked"
      : fields.resolved || settlement?.state === "completed"
        ? "settled"
        : settlement
          ? "settling"
          : fields.agreed
            ? "agreed"
            : "proposed",
    proposals: fields.proposals ?? {},
    proposedBy: fields.proposedBy ?? {},
    agreementOperation: fields.agreementOperation
      ? { reservationAdjustments: [], ...(fields.agreementOperation as object) }
      : null,
    settlement: settlement
      ? { completedAtMs: null, failureReason: null, ...settlement }
      : null,
  };
}

export function agreedWagerFixture() {
  return {
    ...createEmptyWager(),
    state: "agreed" as const,
    agreed: {
      material: "dust" as const,
      count: 1,
      total: 2,
      proposerId: "guest",
      accepterId: "host",
      acceptedAt: 1,
    },
    agreementOperation: {
      id: "a".repeat(64),
      proposerOperationId: "b".repeat(64),
      proposerReservedCount: 1,
      reservationLineageVersion: 1 as const,
      reservationLineageReady: true,
      reservationAdjustments: [],
      proposerReservationOperationIds: ["c".repeat(64)],
      accepterReservationOperationIds: ["d".repeat(64)],
    },
  };
}
export function settledWagerFixture() {
  return {
    ...createEmptyWager(),
    state: "settled" as const,
    resolved: {
      winnerId: "host",
      loserId: "guest",
      material: "dust" as const,
      count: 1,
      total: 2,
      resolvedAt: 1,
    },
  };
}
export function pendingProposalSettlementFixture() {
  return {
    version: 2 as const,
    state: "pending" as const,
    kind: "proposals" as const,
    operationId: "a".repeat(64),
    claimedAtMs: 1,
    completedAtMs: null,
    failureReason: null,
    fingerprint: "fixture-proposal-settlement",
    releases: [
      { uid: "host", reservationOperationIds: ["b".repeat(64)] },
      { uid: "guest", reservationOperationIds: ["c".repeat(64)] },
    ],
  };
}
