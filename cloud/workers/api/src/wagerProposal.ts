import {
  applyMaterialDeltas,
  applyMaterialDeltasWithCap,
  computeAcceptedReservation,
  computeAvailableCount,
  isMaterialName,
  MATERIAL_KEYS,
  normalizeCount,
  normalizeMaterials,
  type MiningMaterialName,
  type MiningMaterials,
} from "@mons/shared/mining";
import {
  isWagerAgreement,
  type WagerAgreement,
  type WagerProposalAcceptRequest,
  type WagerProposalAcceptResponse,
  type WagerProposalRemovalRequest,
  type WagerProposalRemovalResponse,
  type WagerProposalSendRequest,
  type WagerProposalSendResponse,
} from "@mons/shared/wagers";
import { AuthApiFailure } from "./authErrors.ts";
import type { FirebaseIdentity } from "./firebaseAuth.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";

export type WagerProposalAction = "cancel" | "decline";

export type WagerProposalDependencies = {
  logMaterialReleaseFailure?: (record: Record<string, unknown>) => void;
  now?: () => number;
};

type WagerParticipants = {
  opponentUid: string;
  playerProfileId: string;
  playerUid: string;
};

type WagerParticipantFailure = {
  ok: false;
  reason: "invite-not-found" | "missing-opponent" | "profile-not-found";
};

type WagerProposalTransition = {
  decision: "replayed" | "unavailable" | "write";
  value?: Record<string, unknown>;
};

type FrozenOperationRecord = {
  appliedAtMs: number;
  count?: number;
  deltas?: Partial<MiningMaterials>;
  fingerprint: string;
};

const FROZEN_OPERATION_ROOT = "_wagerOps";

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function createOperationId(...parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("\u0000")),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function operationFingerprint(
  kind: string,
  material: string,
  count: number,
  deltas: Partial<MiningMaterials> = {},
): string {
  return JSON.stringify([
    kind,
    material,
    count,
    ...MATERIAL_KEYS.map((key) => deltas[key] || 0),
  ]);
}

function readFrozenOperation(
  value: unknown,
  operationId: string,
): FrozenOperationRecord | null {
  const frozen = toRecord(value);
  const operations = toRecord(frozen?.[FROZEN_OPERATION_ROOT]);
  const operation = toRecord(operations?.[operationId]);
  if (
    !operation ||
    typeof operation.fingerprint !== "string" ||
    !Number.isFinite(operation.appliedAtMs)
  ) {
    return null;
  }
  return {
    fingerprint: operation.fingerprint,
    appliedAtMs: Number(operation.appliedAtMs),
    count:
      typeof operation.count === "number" && Number.isFinite(operation.count)
        ? operation.count
        : undefined,
    deltas:
      (toRecord(operation.deltas) as Partial<MiningMaterials> | null) ||
      undefined,
  };
}

function appendFrozenOperation(
  current: unknown,
  operationId: string,
  operation: FrozenOperationRecord,
  materials: MiningMaterials,
): Record<string, unknown> {
  const mining = toRecord(current) || {};
  const operations = toRecord(mining[FROZEN_OPERATION_ROOT]) || {};
  return {
    ...mining,
    frozen: materials,
    [FROZEN_OPERATION_ROOT]: {
      ...operations,
      [operationId]: operation,
    },
  };
}

async function applyFrozenOperation(
  repository: GameplayRepository,
  uid: string,
  operationId: string,
  fingerprint: string,
  create: (current: MiningMaterials) => {
    materials: MiningMaterials;
    count?: number;
    deltas?: Partial<MiningMaterials>;
  } | null,
  now: () => number,
): Promise<FrozenOperationRecord | null> {
  const miningPath = `players/${uid}/mining`;
  let result;
  try {
    result = await repository.transactRtdbPath(miningPath, (current) => {
      const existing = readFrozenOperation(current, operationId);
      if (existing) {
        return {
          commit: false,
          decision:
            existing.fingerprint === fingerprint
              ? "operation-replayed"
              : "operation-conflict",
        };
      }
      const created = create(normalizeMaterials(toRecord(current)?.frozen));
      if (!created) {
        return { commit: false, decision: "operation-rejected" };
      }
      const operation: FrozenOperationRecord = {
        fingerprint,
        appliedAtMs: now(),
        ...(created.count === undefined ? {} : { count: created.count }),
        ...(created.deltas === undefined ? {} : { deltas: created.deltas }),
      };
      return {
        value: appendFrozenOperation(
          current,
          operationId,
          operation,
          created.materials,
        ),
      };
    });
  } catch {
    const current = await repository.getRtdbPath(miningPath);
    const operation = readFrozenOperation(current, operationId);
    if (operation?.fingerprint === fingerprint) {
      return operation;
    }
    throw new Error("wager-operation-unavailable");
  }
  if (result.decision === "operation-conflict") {
    throw new Error("wager-operation-conflict");
  }
  if (result.decision === "operation-rejected") {
    return null;
  }
  const operation = readFrozenOperation(result.value, operationId);
  if (!operation || operation.fingerprint !== fingerprint) {
    throw new Error("wager-operation-unavailable");
  }
  return operation;
}

async function resolveWagerParticipants(
  identity: FirebaseIdentity,
  inviteId: string,
  repository: GameplayRepository,
): Promise<WagerParticipants | WagerParticipantFailure> {
  const invite = toRecord(await repository.getRtdbPath(`invites/${inviteId}`));
  if (!invite) {
    return { ok: false, reason: "invite-not-found" };
  }
  const hostId = normalizeString(invite.hostId);
  const guestId = normalizeString(invite.guestId);
  if (!hostId || !guestId) {
    return { ok: false, reason: "missing-opponent" };
  }
  if (!isSafeFirebaseKey(hostId) || !isSafeFirebaseKey(guestId)) {
    throw new Error("invalid-wager-participant");
  }
  const [hostProfileId, guestProfileId] = await Promise.all([
    repository.findProfileId(hostId, identity.idToken),
    repository.findProfileId(guestId, identity.idToken),
  ]);
  if (!hostProfileId || !guestProfileId) {
    return { ok: false, reason: "profile-not-found" };
  }
  const isHost =
    identity.uid === hostId || identity.profileId === hostProfileId;
  const isGuest =
    identity.uid === guestId || identity.profileId === guestProfileId;
  if (!isHost && !isGuest) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  return isHost
    ? {
        playerUid: hostId,
        playerProfileId: hostProfileId,
        opponentUid: guestId,
      }
    : {
        playerUid: guestId,
        playerProfileId: guestProfileId,
        opponentUid: hostId,
      };
}

function transitionWagerProposal(
  current: unknown,
  input: {
    material: MiningMaterialName;
    now: number;
    operationId: string;
    opponentUid: string;
    playerUid: string;
    reservedCount: number;
  },
): WagerProposalTransition {
  const wager = toRecord(current) || {};
  const agreement = toRecord(wager.agreed);
  const agreementOperation = toRecord(wager.agreementOperation);
  if (
    agreementOperation?.id === input.operationId &&
    agreement?.accepterId === input.playerUid
  ) {
    return { decision: "replayed" };
  }
  const proposals = { ...(toRecord(wager.proposals) || {}) };
  const ownProposal = toRecord(proposals[input.playerUid]);
  if (ownProposal?.operationId === input.operationId) {
    return { decision: "replayed" };
  }
  if (wager.resolved || wager.agreed) {
    return { decision: "unavailable" };
  }
  const proposedBy = { ...(toRecord(wager.proposedBy) || {}) };
  if (proposals[input.playerUid] || proposedBy[input.playerUid]) {
    return { decision: "unavailable" };
  }
  const opponentProposal = toRecord(proposals[input.opponentUid]);
  const opponentCount = normalizeCount(opponentProposal?.count);
  if (
    opponentProposal &&
    opponentProposal.material === input.material &&
    opponentCount > 0
  ) {
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
    return {
      decision: "write",
      value: {
        ...wager,
        proposals: null,
        proposedBy,
        agreed: agreement,
        agreementOperation: {
          id: input.operationId,
          proposerOperationId:
            normalizeString(opponentProposal.operationId) || null,
          proposerReservedCount: opponentCount,
        },
      },
    };
  }
  proposals[input.playerUid] = {
    material: input.material,
    count: input.reservedCount,
    createdAt: input.now,
    operationId: input.operationId,
  };
  proposedBy[input.playerUid] = true;
  return {
    decision: "write",
    value: { ...wager, proposals, proposedBy },
  };
}

async function updateFrozenMaterialsOnce(
  repository: GameplayRepository,
  uid: string,
  operationId: string,
  kind: string,
  deltas: Partial<MiningMaterials>,
  now: () => number,
  totalMaterials?: MiningMaterials,
): Promise<void> {
  const fingerprint = operationFingerprint(kind, "", 0, deltas);
  await applyFrozenOperation(
    repository,
    uid,
    operationId,
    fingerprint,
    (current) => ({
      materials: totalMaterials
        ? applyMaterialDeltasWithCap(current, deltas, totalMaterials)
        : applyMaterialDeltas(current, deltas),
      deltas,
    }),
    now,
  );
}

async function reserveFrozenMaterialsOnce(
  repository: GameplayRepository,
  uid: string,
  operationId: string,
  material: MiningMaterialName,
  count: number,
  totalMaterials: MiningMaterials,
  now: () => number,
): Promise<number> {
  const fingerprint = operationFingerprint("send-reserve", material, count);
  const operation = await applyFrozenOperation(
    repository,
    uid,
    operationId,
    fingerprint,
    (current) => {
      const reservedCount = Math.min(
        count,
        computeAvailableCount(totalMaterials, current, material),
      );
      if (reservedCount <= 0) {
        return null;
      }
      const materials = { ...current };
      materials[material] += reservedCount;
      return { materials, count: reservedCount };
    },
    now,
  );
  return operation?.count || 0;
}

async function reserveAcceptedMaterialsOnce(
  repository: GameplayRepository,
  uid: string,
  operationId: string,
  material: MiningMaterialName,
  proposedCount: number,
  ownProposal: Record<string, unknown> | null,
  totalMaterials: MiningMaterials,
  now: () => number,
): Promise<{
  acceptedCount: number;
  appliedDelta: Partial<MiningMaterials> | null;
}> {
  const ownMaterial = normalizeString(ownProposal?.material);
  const ownCount = normalizeCount(ownProposal?.count);
  const fingerprint = operationFingerprint(
    "accept-reserve",
    `${material}:${ownMaterial}`,
    proposedCount,
    isMaterialName(ownMaterial) && ownCount > 0
      ? { [ownMaterial]: ownCount }
      : {},
  );
  const operation = await applyFrozenOperation(
    repository,
    uid,
    operationId,
    fingerprint,
    (current) => {
      const reservation = computeAcceptedReservation(
        current,
        material,
        proposedCount,
        ownProposal,
        totalMaterials,
      );
      if (!reservation.materials) {
        return null;
      }
      return {
        materials: reservation.materials,
        count: reservation.acceptedCount,
        deltas: reservation.appliedDelta || {},
      };
    },
    now,
  );
  return operation
    ? {
        acceptedCount: operation.count || 0,
        appliedDelta: operation.deltas || {},
      }
    : { acceptedCount: 0, appliedDelta: null };
}

export async function sendWagerProposal(
  identity: FirebaseIdentity,
  request: WagerProposalSendRequest,
  repository: GameplayRepository,
  dependencies: WagerProposalDependencies = {},
): Promise<WagerProposalSendResponse> {
  const participants = await resolveWagerParticipants(
    identity,
    request.inviteId,
    repository,
  );
  if ("ok" in participants) {
    return participants;
  }
  const now = dependencies.now || Date.now;
  const requestedCount = normalizeCount(request.count);
  const operationId = await createOperationId(
    "send",
    request.inviteId,
    request.matchId,
    participants.playerUid,
    request.material,
    String(requestedCount),
  );
  const reservationOperationId = await createOperationId(
    operationId,
    "reservation",
  );
  const totalMaterials = await repository.getMiningMaterials(
    participants.playerProfileId,
    identity.idToken,
  );
  const reservedCount = await reserveFrozenMaterialsOnce(
    repository,
    participants.playerUid,
    reservationOperationId,
    request.material,
    requestedCount,
    totalMaterials,
    now,
  );
  if (reservedCount <= 0) {
    return { ok: false, reason: "insufficient-materials" };
  }

  const wagerPath = `invites/${request.inviteId}/wagers/${request.matchId}`;
  let wagerAfter: Record<string, unknown> | null = null;
  try {
    const result = await repository.transactRtdbPath(wagerPath, (current) => {
      const transition = transitionWagerProposal(current, {
        playerUid: participants.playerUid,
        opponentUid: participants.opponentUid,
        material: request.material,
        reservedCount,
        operationId,
        now: now(),
      });
      return transition.decision === "write"
        ? { value: transition.value }
        : { commit: false, decision: transition.decision };
    });
    wagerAfter = toRecord(result.value);
  } catch {
    wagerAfter = toRecord(await repository.getRtdbPath(wagerPath));
  }
  const agreementOperation = toRecord(wagerAfter?.agreementOperation);
  const removalOperations = toRecord(wagerAfter?.proposalRemovalOperations);
  const ownProposal = toRecord(
    toRecord(wagerAfter?.proposals)?.[participants.playerUid],
  );
  const agreementMatchesAsAccepter = agreementOperation?.id === operationId;
  const agreementMatchesAsProposer =
    agreementOperation?.proposerOperationId === operationId;
  const proposalMatches = ownProposal?.operationId === operationId;
  const removalMatches = Object.values(removalOperations || {}).some(
    (value) => toRecord(value)?.proposalOperationId === operationId,
  );
  if (
    !agreementMatchesAsAccepter &&
    !agreementMatchesAsProposer &&
    !proposalMatches &&
    !removalMatches
  ) {
    await updateFrozenMaterialsOnce(
      repository,
      participants.playerUid,
      await createOperationId(operationId, "rollback"),
      "send-rollback",
      {
        [request.material]: -reservedCount,
      },
      now,
      totalMaterials,
    );
    return { ok: false, reason: "proposal-unavailable" };
  }
  if (proposalMatches) {
    return { ok: true, count: normalizeCount(ownProposal?.count) };
  }
  if (removalMatches) {
    return { ok: false, reason: "proposal-unavailable" };
  }
  const storedAgreement = wagerAfter?.agreed;
  const agreement = isWagerAgreement(storedAgreement) ? storedAgreement : null;
  if (!agreement) {
    throw new Error("wager-agreement-unavailable");
  }
  if (agreementMatchesAsProposer) {
    return { ok: true, count: agreement.count, agreed: agreement };
  }

  const agreedCount = agreement.count;
  const selfDelta = agreedCount - reservedCount;
  if (selfDelta !== 0) {
    await updateFrozenMaterialsOnce(
      repository,
      participants.playerUid,
      await createOperationId(operationId, "self-adjustment"),
      "send-self-adjustment",
      { [request.material]: selfDelta },
      now,
    );
  }
  const opponentCount = normalizeCount(
    agreementOperation?.proposerReservedCount,
  );
  const opponentDelta = agreedCount - opponentCount;
  if (opponentDelta !== 0) {
    await updateFrozenMaterialsOnce(
      repository,
      participants.opponentUid,
      await createOperationId(operationId, "proposer-adjustment"),
      "send-proposer-adjustment",
      { [request.material]: opponentDelta },
      now,
    );
  }
  return { ok: true, count: agreedCount, agreed: agreement };
}

export async function acceptWagerProposal(
  identity: FirebaseIdentity,
  request: WagerProposalAcceptRequest,
  repository: GameplayRepository,
  dependencies: WagerProposalDependencies = {},
): Promise<WagerProposalAcceptResponse> {
  const participants = await resolveWagerParticipants(
    identity,
    request.inviteId,
    repository,
  );
  if ("ok" in participants) {
    return participants;
  }
  const now = dependencies.now || Date.now;
  const operationId = await createOperationId(
    "accept",
    request.inviteId,
    request.matchId,
    participants.playerUid,
  );
  const wagerPath = `invites/${request.inviteId}/wagers/${request.matchId}`;
  const wager = toRecord(await repository.getRtdbPath(wagerPath));
  const replayOperation = toRecord(wager?.agreementOperation);
  const replayAgreement = wager?.agreed;
  if (
    replayOperation?.id === operationId &&
    isWagerAgreement(replayAgreement)
  ) {
    const proposerReservedCount = normalizeCount(
      replayOperation.proposerReservedCount,
    );
    const proposerDelta = replayAgreement.count - proposerReservedCount;
    if (proposerDelta !== 0) {
      await updateFrozenMaterialsOnce(
        repository,
        participants.opponentUid,
        await createOperationId(operationId, "proposer-adjustment"),
        "accept-proposer-adjustment",
        { [replayAgreement.material]: proposerDelta },
        now,
      );
    }
    return { ok: true, count: replayAgreement.count };
  }
  if (!wager || wager.resolved || wager.agreed) {
    return { ok: false, reason: "proposal-missing" };
  }
  const proposals = toRecord(wager.proposals) || {};
  const opponentProposal = toRecord(proposals[participants.opponentUid]);
  if (!opponentProposal) {
    return { ok: false, reason: "proposal-missing" };
  }
  const material = normalizeString(opponentProposal.material);
  const proposedCount = normalizeCount(opponentProposal.count);
  if (!isMaterialName(material) || proposedCount <= 0) {
    return { ok: false, reason: "insufficient-materials" };
  }
  const ownProposal = toRecord(proposals[participants.playerUid]);
  const totalMaterials = await repository.getMiningMaterials(
    participants.playerProfileId,
    identity.idToken,
  );
  const reservation = await reserveAcceptedMaterialsOnce(
    repository,
    participants.playerUid,
    await createOperationId(operationId, "reservation"),
    material,
    proposedCount,
    ownProposal,
    totalMaterials,
    now,
  );
  if (reservation.acceptedCount <= 0 || !reservation.appliedDelta) {
    return { ok: false, reason: "insufficient-materials" };
  }

  const ownMaterial = normalizeString(ownProposal?.material);
  const ownCount = normalizeCount(ownProposal?.count);
  let wagerAfter: Record<string, unknown> | null = null;
  try {
    const result = await repository.transactRtdbPath(wagerPath, (current) => {
      const currentWager = toRecord(current);
      const existingOperation = toRecord(currentWager?.agreementOperation);
      const existingAgreement = toRecord(currentWager?.agreed);
      if (
        existingOperation?.id === operationId &&
        existingAgreement?.accepterId === participants.playerUid
      ) {
        return { commit: false, decision: "replayed" };
      }
      if (!currentWager || currentWager.resolved || currentWager.agreed) {
        return { commit: false, decision: "proposal-unavailable" };
      }
      const currentProposals = toRecord(currentWager.proposals) || {};
      const currentOpponentProposal = toRecord(
        currentProposals[participants.opponentUid],
      );
      const currentOwnProposal = toRecord(
        currentProposals[participants.playerUid],
      );
      const opponentMatches =
        currentOpponentProposal?.material === material &&
        normalizeCount(currentOpponentProposal.count) === proposedCount;
      const ownMatches = ownProposal
        ? currentOwnProposal?.material === ownMaterial &&
          normalizeCount(currentOwnProposal.count) === ownCount
        : !currentOwnProposal;
      if (!opponentMatches || !ownMatches) {
        return { commit: false, decision: "proposal-unavailable" };
      }
      const agreement: WagerAgreement = {
        material,
        count: reservation.acceptedCount,
        total: reservation.acceptedCount * 2,
        proposerId: participants.opponentUid,
        accepterId: participants.playerUid,
        acceptedAt: now(),
      };
      return {
        value: {
          ...currentWager,
          agreed: agreement,
          proposals: null,
          agreementOperation: {
            id: operationId,
            proposerOperationId:
              normalizeString(currentOpponentProposal.operationId) || null,
            proposerReservedCount: proposedCount,
          },
        },
      };
    });
    wagerAfter = toRecord(result.value);
  } catch {
    wagerAfter = toRecord(await repository.getRtdbPath(wagerPath));
  }
  const agreementOperation = toRecord(wagerAfter?.agreementOperation);
  const storedAgreement = wagerAfter?.agreed;
  const agreement = isWagerAgreement(storedAgreement) ? storedAgreement : null;
  if (agreementOperation?.id !== operationId || !agreement) {
    const rollback = Object.fromEntries(
      Object.entries(reservation.appliedDelta).map(([key, value]) => [
        key,
        -value,
      ]),
    ) as Partial<MiningMaterials>;
    await updateFrozenMaterialsOnce(
      repository,
      participants.playerUid,
      await createOperationId(operationId, "rollback"),
      "accept-rollback",
      rollback,
      now,
      totalMaterials,
    );
    return { ok: false, reason: "proposal-unavailable" };
  }

  const proposerReservedCount = normalizeCount(
    agreementOperation.proposerReservedCount,
  );
  const proposerDelta = agreement.count - proposerReservedCount;
  if (proposerDelta !== 0) {
    await updateFrozenMaterialsOnce(
      repository,
      participants.opponentUid,
      await createOperationId(operationId, "proposer-adjustment"),
      "accept-proposer-adjustment",
      { [material]: proposerDelta },
      now,
    );
  }
  return { ok: true, count: agreement.count };
}

async function removeProposal(
  repository: GameplayRepository,
  inviteId: string,
  matchId: string,
  proposalUid: string,
  operationId: string,
): Promise<Record<string, unknown> | null> {
  const wagerPath = `invites/${inviteId}/wagers/${matchId}`;
  let wagerAfter: unknown;
  try {
    const result = await repository.transactRtdbPath(wagerPath, (current) => {
      const wager = toRecord(current);
      const removalOperations =
        toRecord(wager?.proposalRemovalOperations) || {};
      if (toRecord(removalOperations[operationId])) {
        return { commit: false, decision: "replayed" };
      }
      const proposals = toRecord(wager?.proposals);
      const proposal = toRecord(proposals?.[proposalUid]);
      if (!wager || wager.agreed || wager.resolved || !proposals || !proposal) {
        return { commit: false, decision: "proposal-missing" };
      }
      const nextProposals = { ...proposals };
      delete nextProposals[proposalUid];
      const nextWager = { ...wager };
      if (Object.keys(nextProposals).length > 0) {
        nextWager.proposals = nextProposals;
      } else {
        delete nextWager.proposals;
      }
      nextWager.proposalRemovalOperations = {
        ...removalOperations,
        [operationId]: {
          material: proposal.material,
          count: normalizeCount(proposal.count),
          proposalOperationId: normalizeString(proposal.operationId) || null,
        },
      };
      return { value: nextWager };
    });
    wagerAfter = result.value;
  } catch {
    wagerAfter = await repository.getRtdbPath(wagerPath);
    const recoveredWager = toRecord(wagerAfter);
    const recoveredOperations = toRecord(
      recoveredWager?.proposalRemovalOperations,
    );
    if (!toRecord(recoveredOperations?.[operationId])) {
      throw new Error("wager-removal-unavailable");
    }
  }
  const wager = toRecord(wagerAfter);
  const removalOperations = toRecord(wager?.proposalRemovalOperations);
  return toRecord(removalOperations?.[operationId]);
}

export async function removeWagerProposal(
  identity: FirebaseIdentity,
  request: WagerProposalRemovalRequest,
  action: WagerProposalAction,
  repository: GameplayRepository,
  dependencies: WagerProposalDependencies = {},
): Promise<WagerProposalRemovalResponse> {
  const participants = await resolveWagerParticipants(
    identity,
    request.inviteId,
    repository,
  );
  if ("ok" in participants) {
    return participants;
  }
  const now = dependencies.now || Date.now;
  const proposalUid =
    action === "cancel" ? participants.playerUid : participants.opponentUid;
  const operationId = await createOperationId(
    action,
    request.inviteId,
    request.matchId,
    proposalUid,
  );
  const proposal = await removeProposal(
    repository,
    request.inviteId,
    request.matchId,
    proposalUid,
    operationId,
  );
  if (!proposal) {
    return { ok: false, reason: "proposal-missing" };
  }
  const material = normalizeString(proposal.material);
  const count = normalizeCount(proposal.count);
  if (!isMaterialName(material) || count <= 0) {
    throw new Error("wager-removal-operation-invalid");
  }
  try {
    await updateFrozenMaterialsOnce(
      repository,
      proposalUid,
      await createOperationId(operationId, "release"),
      "proposal-release",
      { [material]: -count },
      now,
    );
  } catch {
    (
      dependencies.logMaterialReleaseFailure ||
      ((record) => console.error(JSON.stringify(record)))
    )({
      event: "wager_proposal_material_release_failed",
      action,
      inviteId: request.inviteId,
      matchId: request.matchId,
      proposalUid,
    });
    throw new Error("wager-material-release-failed");
  }
  return { ok: true };
}

export { removeProposal, resolveWagerParticipants };
