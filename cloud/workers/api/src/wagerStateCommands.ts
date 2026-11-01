import {
  lineageFingerprint,
  readStoredSettlement,
  readWagerProposal,
  readWagerCount,
  readWagerRemovalReceipt,
  WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON,
  type DecodedWager,
  createEmptyWager,
  parseWagerRecord,
  type WagerRecord,
  type ReservationAdjustment,
  type WagerSettlement,
  type SettlementRelease,
} from "./wagerModel.ts";
import { isMaterialName, type MiningMaterialName } from "@mons/shared/mining";
import type { WagerAgreement } from "@mons/shared/wagers";
import type { TransactionDecision } from "./repositoryContracts.ts";

export {
  lineageFingerprint,
  readStoredSettlement,
  WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON,
} from "./wagerModel.ts";
export type { WagerSettlement, SettlementRelease } from "./wagerModel.ts";

export type WagerKey = { inviteId: string; matchId: string };
export type { WagerRecord } from "./wagerModel.ts";
export type ModernProposalLineage = {
  count: number;
  material: MiningMaterialName;
  operationId: string;
  reservationOperationId: string;
};
type WagerProposalTransition = {
  decision: "replayed" | "unavailable" | "write";
  value?: WagerRecord;
};
export type SendWagerProposalCommand = {
  material: MiningMaterialName;
  now: number;
  opponentAdjustmentOperationId: string;
  opponentProposal: ModernProposalLineage | null;
  operationId: string;
  opponentUid: string;
  playerUid: string;
  reservationOperationId: string;
  reservedCount: number;
  selfAdjustmentOperationId: string;
};
export type AcceptWagerProposalCommand = {
  playerUid: string;
  opponentUid: string;
  operationId: string;
  material: MiningMaterialName;
  proposedCount: number;
  opponentProposalOperationId: string;
  opponentReservationOperationId: string;
  hasOwnProposal: boolean;
  ownMaterial: string;
  ownCount: number;
  ownProposalOperationId: string;
  ownReservationOperationId: string;
  acceptedCount: number;
  now: number;
  proposerAdjustmentOperationId: string;
  reservationOperationId: string;
};
export type RemoveWagerProposalCommand = {
  proposalUid: string;
  operationId: string;
  expectedReservationOperationId: string;
};
export type MarkWagerLineageReadyCommand = {
  operationId: string;
  fingerprint: string;
};
export type WagerSettlementResolution = {
  loserProfileId: string;
  loserUid: string;
  winnerProfileId: string;
  winnerUid: string;
};
export type ClaimWagerSettlementCommand = {
  resolution: WagerSettlementResolution;
  operationId: string;
  now: number;
  acceptReservationOperationIdByUid: Readonly<Record<string, string>>;
};
export type CompleteWagerSettlementCommand = {
  settlement: WagerSettlement;
  completedAtMs: number;
  insufficientMaterials: boolean;
};
function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function validOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function transitionWagerProposal(
  current: DecodedWager | null,
  input: {
    material: MiningMaterialName;
    now: number;
    opponentAdjustmentOperationId: string;
    opponentProposal: ModernProposalLineage | null;
    operationId: string;
    opponentUid: string;
    playerUid: string;
    reservationOperationId: string;
    reservedCount: number;
    selfAdjustmentOperationId: string;
  },
): WagerProposalTransition {
  if (current?.state === "blocked") return { decision: "unavailable" };
  const wager = current ?? createEmptyWager();
  const agreement = current?.agreed;
  const agreementOperation = current?.agreementOperation;
  if (
    agreementOperation?.id === input.operationId &&
    agreement?.accepterId === input.playerUid
  ) {
    return { decision: "replayed" };
  }
  const proposals = { ...current?.proposals };
  const ownProposal = readWagerProposal(current, input.playerUid);
  if (ownProposal?.operationId === input.operationId) {
    return { decision: "replayed" };
  }
  if (wager.resolved || wager.agreed || wager.settlement) {
    return { decision: "unavailable" };
  }
  const proposedBy = { ...current?.proposedBy };
  if (proposals[input.playerUid] || proposedBy[input.playerUid]) {
    return { decision: "unavailable" };
  }
  const opponentProposal = readWagerProposal(current, input.opponentUid);
  const opponentCount = readWagerCount(opponentProposal);
  if (
    opponentProposal &&
    opponentProposal.material === input.material &&
    opponentCount > 0
  ) {
    if (
      !input.opponentProposal ||
      input.opponentProposal.material !== input.material ||
      input.opponentProposal.count !== opponentCount ||
      opponentProposal.operationId !== input.opponentProposal.operationId ||
      opponentProposal.reservationOperationId !==
        input.opponentProposal.reservationOperationId
    ) {
      return { decision: "unavailable" };
    }
    const acceptedCount = Math.min(input.reservedCount, opponentCount);
    if (acceptedCount <= 0) {
      return { decision: "unavailable" };
    }
    const agreement: WagerAgreement = {
      material: input.material,
      count: acceptedCount,
      total: acceptedCount * 2,
      proposerId: input.opponentUid,
      accepterId: input.playerUid,
      acceptedAt: input.now,
    };
    proposedBy[input.playerUid] = true;
    const opponentReservationOperationId =
      input.opponentProposal.reservationOperationId;
    const opponentOperationId = input.opponentProposal.operationId;
    const reservationAdjustments: ReservationAdjustment[] = [
      ...(acceptedCount !== input.reservedCount
        ? [
            {
              uid: input.playerUid,
              operationId: input.selfAdjustmentOperationId,
              kind: "send-self-adjustment" as const,
              material: input.material,
              delta: acceptedCount - input.reservedCount,
            },
          ]
        : []),
      ...(acceptedCount !== opponentCount
        ? [
            {
              uid: input.opponentUid,
              operationId: input.opponentAdjustmentOperationId,
              kind: "send-proposer-adjustment" as const,
              material: input.material,
              delta: acceptedCount - opponentCount,
            },
          ]
        : []),
    ];
    return {
      decision: "write",
      value: parseWagerRecord({
        ...wager,
        state: "agreed",
        proposals: {},
        proposedBy,
        agreed: agreement,
        agreementOperation: {
          id: input.operationId,
          proposerOperationId: opponentOperationId,
          proposerReservedCount: opponentCount,
          reservationLineageVersion: 1,
          reservationLineageReady: reservationAdjustments.length === 0,
          reservationAdjustments,
          accepterReservationOperationIds: [
            input.selfAdjustmentOperationId,
            input.reservationOperationId,
          ],
          proposerReservationOperationIds: [
            input.opponentAdjustmentOperationId,
            opponentReservationOperationId,
          ],
        },
      }),
    };
  }
  proposals[input.playerUid] = {
    material: input.material,
    count: input.reservedCount,
    createdAt: input.now,
    operationId: input.operationId,
    reservationOperationId: input.reservationOperationId,
  };
  proposedBy[input.playerUid] = true;
  return {
    decision: "write",
    value: parseWagerRecord({ ...wager, proposals, proposedBy }),
  };
}

export function sendProposalDecision(
  current: DecodedWager | null,
  input: SendWagerProposalCommand,
): TransactionDecision<WagerRecord> {
  const transition = transitionWagerProposal(current, input);
  return transition.decision === "write"
    ? { value: transition.value! }
    : { commit: false, decision: transition.decision };
}
export function acceptProposalDecision(
  current: DecodedWager | null,
  input: AcceptWagerProposalCommand,
): TransactionDecision<WagerRecord> {
  const {
    playerUid,
    opponentUid,
    operationId,
    material,
    proposedCount,
    opponentProposalOperationId,
    opponentReservationOperationId,
    hasOwnProposal,
    ownMaterial,
    ownCount,
    ownProposalOperationId,
    ownReservationOperationId,
    acceptedCount,
    now,
    proposerAdjustmentOperationId,
    reservationOperationId,
  } = input;

  if (current?.state === "blocked")
    return { commit: false, decision: "proposal-unavailable" };
  const currentWager = current;
  const existingOperation = current?.agreementOperation;
  const existingAgreement = current?.agreed;
  if (
    existingOperation?.id === operationId &&
    existingAgreement?.accepterId === playerUid
  ) {
    return { commit: false, decision: "replayed" };
  }
  if (
    !currentWager ||
    currentWager.resolved ||
    currentWager.agreed ||
    currentWager.settlement
  ) {
    return { commit: false, decision: "proposal-unavailable" };
  }
  const currentOpponentProposal = readWagerProposal(current, opponentUid);
  const currentOwnProposal = readWagerProposal(current, playerUid);
  const opponentMatches =
    currentOpponentProposal?.material === material &&
    readWagerCount(currentOpponentProposal) === proposedCount &&
    normalizeString(currentOpponentProposal.operationId) ===
      opponentProposalOperationId &&
    normalizeString(currentOpponentProposal.reservationOperationId) ===
      opponentReservationOperationId;
  const ownMatches = hasOwnProposal
    ? currentOwnProposal?.material === ownMaterial &&
      readWagerCount(currentOwnProposal) === ownCount &&
      normalizeString(currentOwnProposal.operationId) ===
        ownProposalOperationId &&
      normalizeString(currentOwnProposal.reservationOperationId) ===
        ownReservationOperationId
    : !currentOwnProposal;
  if (!opponentMatches || !ownMatches) {
    return { commit: false, decision: "proposal-unavailable" };
  }
  const agreement: WagerAgreement = {
    material,
    count: acceptedCount,
    total: acceptedCount * 2,
    proposerId: opponentUid,
    accepterId: playerUid,
    acceptedAt: now,
  };
  const reservationAdjustments: ReservationAdjustment[] =
    acceptedCount !== proposedCount
      ? [
          {
            uid: opponentUid,
            operationId: proposerAdjustmentOperationId,
            kind: "accept-proposer-adjustment" as const,
            material,
            delta: acceptedCount - proposedCount,
          },
        ]
      : [];
  return {
    value: parseWagerRecord({
      ...currentWager,
      state: "agreed",
      agreed: agreement,
      proposals: {},
      agreementOperation: {
        id: operationId,
        proposerOperationId: opponentProposalOperationId,
        proposerReservedCount: proposedCount,
        reservationLineageVersion: 1,
        reservationLineageReady: reservationAdjustments.length === 0,
        reservationAdjustments,
        accepterReservationOperationIds: [
          reservationOperationId,
          ...(ownReservationOperationId ? [ownReservationOperationId] : []),
        ],
        proposerReservationOperationIds: [
          proposerAdjustmentOperationId,
          opponentReservationOperationId,
        ],
      },
    }),
  };
}
export function removeProposalDecision(
  current: DecodedWager | null,
  input: RemoveWagerProposalCommand,
): TransactionDecision<WagerRecord> {
  const { proposalUid, operationId, expectedReservationOperationId } = input;

  if (current?.state === "blocked")
    return { commit: false, decision: "proposal-missing" };
  const wager = current;
  const removalOperations = current?.proposalRemovalOperations || {};
  const replayOperation = readWagerRemovalReceipt(current, operationId);
  if (replayOperation) {
    return replayOperation.reservationOperationId ===
      expectedReservationOperationId &&
      validOperationId(replayOperation.proposalOperationId)
      ? { commit: false, decision: "replayed" }
      : { commit: false, decision: "proposal-invalid" };
  }
  const proposals = current?.proposals;
  const proposal = readWagerProposal(current, proposalUid);
  if (
    !wager ||
    wager.agreed ||
    wager.resolved ||
    wager.settlement ||
    !proposals ||
    !proposal
  ) {
    return { commit: false, decision: "proposal-missing" };
  }
  const proposalOperationId = normalizeString(proposal.operationId);
  const reservationOperationId = normalizeString(
    proposal.reservationOperationId,
  );
  if (
    !validOperationId(proposalOperationId) ||
    reservationOperationId !== expectedReservationOperationId
  ) {
    return { commit: false, decision: "proposal-invalid" };
  }
  const nextProposals = { ...proposals };
  delete nextProposals[proposalUid];
  const nextWager = { ...wager, proposals: nextProposals };
  nextWager.proposalRemovalOperations = {
    ...removalOperations,
    [operationId]: {
      proposalOperationId,
      reservationOperationId,
    },
  };
  return { value: parseWagerRecord(nextWager) };
}
export function markLineageReadyDecision(
  current: DecodedWager | null,
  input: MarkWagerLineageReadyCommand,
): TransactionDecision<WagerRecord> {
  const { operationId, fingerprint } = input;
  const wager = current;
  const agreementOperation = current?.agreementOperation;
  if (
    !wager ||
    wager.state === "blocked" ||
    !wager.agreed ||
    agreementOperation?.id !== operationId ||
    agreementOperation.reservationLineageVersion !== 1 ||
    lineageFingerprint(current) !== fingerprint
  ) {
    return { commit: false, decision: "agreement-missing" };
  }
  if (agreementOperation.reservationLineageReady === true) {
    return { commit: false, decision: "agreement-ready" };
  }
  return {
    value: parseWagerRecord({
      ...wager,
      agreementOperation: {
        ...agreementOperation,
        reservationLineageReady: true,
      },
    }),
  };
}
function settlementFingerprint(
  value: Omit<WagerSettlement, "failureReason" | "fingerprint">,
): string {
  return JSON.stringify(value);
}

function createLineageRelease(
  uid: string,
  operationIds: readonly string[],
): SettlementRelease {
  return {
    uid,
    reservationOperationIds: [...operationIds],
  };
}

function createSettlement(
  wager: DecodedWager,
  resolution: WagerSettlementResolution,
  operationId: string,
  nowMs: number,
  acceptReservationOperationIdByUid: Readonly<Record<string, string>>,
): WagerSettlement {
  const base = {
    version: 2 as const,
    state: "pending" as const,
    operationId,
    claimedAtMs: nowMs,
    completedAtMs: null,
  };
  const agreement = wager.agreed;
  const material = normalizeString(agreement?.material);
  const count = readWagerCount(agreement);
  const proposerUid = normalizeString(agreement?.proposerId);
  const accepterUid = normalizeString(agreement?.accepterId);
  if (isMaterialName(material) && count > 0) {
    const agreementOperation = wager.agreementOperation;
    if (agreementOperation?.reservationLineageVersion !== 1) {
      throw new Error("wager-reservation-lineage-invalid");
    }
    if (agreementOperation.reservationLineageReady !== true) {
      throw new Error("wager-reservation-lineage-pending");
    }
    const proposerOperationIds =
      agreementOperation.proposerReservationOperationIds;
    const accepterOperationIds =
      agreementOperation.accepterReservationOperationIds;
    if (!proposerOperationIds || !accepterOperationIds) {
      throw new Error("wager-reservation-lineage-invalid");
    }
    const proposerRelease = createLineageRelease(
      proposerUid,
      proposerOperationIds,
    );
    const accepterRelease = createLineageRelease(
      accepterUid,
      accepterOperationIds,
    );
    const releaseByUid = new Map([
      [proposerRelease.uid, proposerRelease],
      [accepterRelease.uid, accepterRelease],
    ]);
    const winnerRelease = releaseByUid.get(resolution.winnerUid);
    const loserRelease = releaseByUid.get(resolution.loserUid);
    if (!winnerRelease || !loserRelease) {
      throw new Error("wager-reservation-lineage-invalid");
    }
    const releases = [winnerRelease, loserRelease];
    const candidate = {
      ...base,
      kind: "agreed" as const,
      ...resolution,
      material,
      count,
      releases,
    };
    return {
      ...candidate,
      failureReason: null,
      fingerprint: settlementFingerprint(candidate),
    };
  }
  const releases = [resolution.winnerUid, resolution.loserUid].map((uid) => {
    const proposal = readWagerProposal(wager, uid);
    const proposalReservationOperationId = normalizeString(
      proposal?.reservationOperationId,
    );
    const proposalOperationId = normalizeString(proposal?.operationId);
    if (
      proposal &&
      (!/^[a-f0-9]{64}$/.test(proposalReservationOperationId) ||
        !/^[a-f0-9]{64}$/.test(proposalOperationId))
    ) {
      throw new Error("wager-reservation-lineage-invalid");
    }
    const acceptanceId = acceptReservationOperationIdByUid[uid];
    if (!acceptanceId) throw new Error("wager-reservation-lineage-invalid");
    return createLineageRelease(uid, [
      acceptanceId,
      ...(proposalReservationOperationId
        ? [proposalReservationOperationId]
        : []),
    ]);
  });
  const candidate = {
    ...base,
    kind: "proposals" as const,
    releases,
  };
  return {
    ...candidate,
    failureReason: null,
    fingerprint: settlementFingerprint(candidate),
  };
}

export function claimSettlementDecision(
  value: DecodedWager | null,
  input: ClaimWagerSettlementCommand,
): TransactionDecision<WagerRecord> {
  const { resolution, operationId, now, acceptReservationOperationIdByUid } =
    input;

  const wager = value;
  if (wager?.state === "blocked")
    return { commit: false, decision: "manual-required" };
  if (!value || !wager) {
    return { commit: false, decision: "no-wager" };
  }
  const existing = readStoredSettlement(value);
  if (wager.resolved) {
    return { commit: false, decision: "already-resolved" };
  }
  if (existing) {
    return {
      commit: false,
      decision:
        existing.state !== "completed"
          ? "resume"
          : existing.failureReason ===
              WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON
            ? WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON
            : "already-resolved",
    };
  }
  const settlement = createSettlement(
    value,
    resolution,
    operationId,
    now,
    acceptReservationOperationIdByUid,
  );
  return {
    value: parseWagerRecord({ ...wager, state: "settling", settlement }),
  };
}
export function completeSettlementDecision(
  value: DecodedWager | null,
  input: CompleteWagerSettlementCommand,
): TransactionDecision<WagerRecord> {
  const wager = value;
  const current = readStoredSettlement(value);
  const { settlement, completedAtMs, insufficientMaterials } = input;
  if (
    !wager ||
    !current ||
    current.operationId !== settlement.operationId ||
    current.fingerprint !== settlement.fingerprint
  )
    throw new Error("wager-settlement-unavailable");
  if (current.state === "completed")
    return { commit: false, decision: "completed" };
  if (wager.state === "blocked")
    throw new Error("wager-manual-review-required");
  const nextSettlement = {
    ...current,
    state: "completed" as const,
    completedAtMs,
    failureReason: insufficientMaterials
      ? WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON
      : null,
  };
  return {
    value: parseWagerRecord({
      ...wager,
      state: "settled",
      settlement: nextSettlement,
      proposals: {},
      agreed: insufficientMaterials ? null : wager.agreed,
      agreementOperation: insufficientMaterials
        ? null
        : wager.agreementOperation,
      resolved:
        !insufficientMaterials && settlement.kind === "agreed"
          ? {
              winnerId: settlement.winnerUid,
              loserId: settlement.loserUid,
              material: settlement.material,
              count: settlement.count,
              total: settlement.count * 2,
              resolvedAt: completedAtMs,
            }
          : null,
    }),
  };
}
