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
import type { RequestIdentity } from "./requestIdentity.ts";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";
import {
  getLoginProfileId,
  requireProfileOwnershipSnapshot,
  type ProfileOwnershipSnapshot,
} from "./profileOwnership.ts";

export type WagerProposalAction = "cancel" | "decline";

export type WagerProposalDependencies = {
  logMaterialReleaseFailure?: (record: Record<string, unknown>) => void;
  now?: () => number;
};

type WagerParticipants = {
  opponentProfileId: string;
  opponentUid: string;
  ownership: ProfileOwnershipSnapshot;
  playerProfileId: string;
  playerUid: string;
};

type WagerParticipantUids = Pick<
  WagerParticipants,
  "opponentUid" | "playerUid"
> & {
  ownership: ProfileOwnershipSnapshot | null;
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

export async function createWagerReservationOperationId(
  kind: "accept" | "send",
  inviteId: string,
  matchId: string,
  playerUid: string,
): Promise<string> {
  return createOperationId("reservation", kind, inviteId, matchId, playerUid);
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

function isConsumedFrozenOperation(
  value: unknown,
  operationId: string,
): boolean {
  const operations = toRecord(toRecord(value)?.[FROZEN_OPERATION_ROOT]);
  return toRecord(operations?.[operationId])?.consumed === true;
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

function removeFrozenOperation(
  current: unknown,
  operationId: string,
  materials: MiningMaterials,
  retainTombstone: boolean,
): Record<string, unknown> {
  const mining = toRecord(current) || {};
  const operations = { ...(toRecord(mining[FROZEN_OPERATION_ROOT]) || {}) };
  if (retainTombstone) operations[operationId] = { consumed: true };
  else delete operations[operationId];
  const result: Record<string, unknown> = { ...mining, frozen: materials };
  if (Object.keys(operations).length > 0) {
    result[FROZEN_OPERATION_ROOT] = operations;
  } else {
    delete result[FROZEN_OPERATION_ROOT];
  }
  return result;
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
      if (isConsumedFrozenOperation(current, operationId)) {
        return { commit: false, decision: "operation-consumed" };
      }
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
    if (isConsumedFrozenOperation(current, operationId)) return null;
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
  if (result.decision === "operation-consumed") return null;
  const operation = readFrozenOperation(result.value, operationId);
  if (!operation || operation.fingerprint !== fingerprint) {
    throw new Error("wager-operation-unavailable");
  }
  return operation;
}

export async function consumeWagerReservationOperation(
  repository: GameplayRepository,
  uid: string,
  operationId: string,
  retainTombstone = false,
): Promise<"missing" | "released"> {
  const miningPath = `players/${uid}/mining`;
  try {
    const result = await repository.transactRtdbPath(miningPath, (current) => {
      if (isConsumedFrozenOperation(current, operationId)) {
        return { commit: false, decision: "reservation-consumed" };
      }
      const operation = readFrozenOperation(current, operationId);
      if (!operation) {
        if (retainTombstone) {
          return {
            decision: "reservation-tombstoned",
            value: removeFrozenOperation(
              current,
              operationId,
              normalizeMaterials(toRecord(current)?.frozen),
              true,
            ),
          };
        }
        return { commit: false, decision: "reservation-missing" };
      }
      const materials = applyMaterialDeltas(
        normalizeMaterials(toRecord(current)?.frozen),
        invertFrozenDeltas(operation),
      );
      return {
        decision: "reservation-released",
        value: removeFrozenOperation(
          current,
          operationId,
          materials,
          retainTombstone,
        ),
      };
    });
    return result.decision === "reservation-missing" ? "missing" : "released";
  } catch (error) {
    const current = await repository
      .getRtdbPath(miningPath)
      .catch(() => undefined);
    if (
      current !== undefined &&
      isConsumedFrozenOperation(current, operationId)
    ) {
      return "released";
    }
    if (
      !retainTombstone &&
      current !== undefined &&
      !readFrozenOperation(current, operationId)
    ) {
      return "released";
    }
    throw error;
  }
}

async function consumeWagerReservationOperations(
  repository: GameplayRepository,
  uid: string,
  operationIds: readonly string[],
): Promise<void> {
  for (const operationId of operationIds) {
    await consumeWagerReservationOperation(repository, uid, operationId);
  }
}

async function resolveWagerParticipantUids(
  identity: RequestIdentity,
  inviteId: string,
  repository: GameplayRepository,
): Promise<WagerParticipantUids | WagerParticipants | WagerParticipantFailure> {
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
  if (identity.uid === hostId) {
    return { opponentUid: guestId, ownership: null, playerUid: hostId };
  }
  if (identity.uid === guestId) {
    return { opponentUid: hostId, ownership: null, playerUid: guestId };
  }
  const ownership = await requireProfileOwnershipSnapshot(repository, {
    loginUids: [identity.uid, hostId, guestId],
    profileIds: [],
  });
  const identityProfileId = getLoginProfileId(ownership, identity.uid);
  const hostProfileId = getLoginProfileId(ownership, hostId);
  const guestProfileId = getLoginProfileId(ownership, guestId);
  if (!hostProfileId || !guestProfileId) {
    return { ok: false, reason: "profile-not-found" };
  }
  const isHost = identityProfileId === hostProfileId;
  const isGuest = identityProfileId === guestProfileId;
  if (!isHost && !isGuest) {
    throw new AuthApiFailure(403, "permission-denied", "permission-denied");
  }
  return isHost
    ? {
        opponentProfileId: guestProfileId,
        opponentUid: guestId,
        ownership,
        playerProfileId: hostProfileId,
        playerUid: hostId,
      }
    : {
        opponentProfileId: hostProfileId,
        opponentUid: hostId,
        ownership,
        playerProfileId: guestProfileId,
        playerUid: guestId,
      };
}

async function resolveWagerParticipants(
  identity: RequestIdentity,
  inviteId: string,
  repository: GameplayRepository,
): Promise<WagerParticipants | WagerParticipantFailure> {
  const participants = await resolveWagerParticipantUids(
    identity,
    inviteId,
    repository,
  );
  if ("ok" in participants || "playerProfileId" in participants) {
    return participants;
  }
  const ownership =
    participants.ownership ||
    (await requireProfileOwnershipSnapshot(repository, {
      loginUids: [participants.playerUid, participants.opponentUid],
      profileIds: [],
    }));
  const playerProfileId = getLoginProfileId(ownership, participants.playerUid);
  const opponentProfileId = getLoginProfileId(
    ownership,
    participants.opponentUid,
  );
  if (!playerProfileId || !opponentProfileId) {
    return { ok: false, reason: "profile-not-found" };
  }
  return { ...participants, ownership, playerProfileId, opponentProfileId };
}

function transitionWagerProposal(
  current: unknown,
  input: {
    material: MiningMaterialName;
    now: number;
    opponentAdjustmentOperationId: string;
    operationId: string;
    opponentUid: string;
    playerUid: string;
    reservationOperationId: string;
    reservedCount: number;
    selfAdjustmentOperationId: string;
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
  if (wager.resolved || wager.agreed || wager.settlement) {
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
    const opponentReservationOperationId = normalizeString(
      opponentProposal.reservationOperationId,
    );
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
          reservationLineageVersion: 1,
          reservationLineageReady: false,
          reservationAdjustments: [
            ...(acceptedCount !== input.reservedCount
              ? [
                  {
                    uid: input.playerUid,
                    operationId: input.selfAdjustmentOperationId,
                    kind: "send-self-adjustment",
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
                    kind: "send-proposer-adjustment",
                    material: input.material,
                    delta: acceptedCount - opponentCount,
                  },
                ]
              : []),
          ],
          accepterReservationOperationIds: [
            input.selfAdjustmentOperationId,
            input.reservationOperationId,
          ],
          proposerReservationOperationIds: [
            input.opponentAdjustmentOperationId,
            ...(opponentReservationOperationId
              ? [opponentReservationOperationId]
              : []),
          ],
          ...(opponentReservationOperationId
            ? {}
            : {
                proposerLegacyReservation: {
                  material: input.material,
                  count: opponentCount,
                },
              }),
        },
      },
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

async function markWagerAgreementLineageReady(
  repository: GameplayRepository,
  wagerPath: string,
  operationId: string,
): Promise<void> {
  let value: unknown;
  try {
    const result = await repository.transactRtdbPath(wagerPath, (current) => {
      const wager = toRecord(current);
      const agreementOperation = toRecord(wager?.agreementOperation);
      if (
        !wager ||
        !wager.agreed ||
        agreementOperation?.id !== operationId ||
        agreementOperation.reservationLineageVersion !== 1
      ) {
        return { commit: false, decision: "agreement-missing" };
      }
      if (agreementOperation.reservationLineageReady === true) {
        return { commit: false, decision: "agreement-ready" };
      }
      return {
        value: {
          ...wager,
          agreementOperation: {
            ...agreementOperation,
            reservationLineageReady: true,
          },
        },
      };
    });
    value = result.value;
  } catch {
    value = await repository.getRtdbPath(wagerPath);
  }
  const agreementOperation = toRecord(toRecord(value)?.agreementOperation);
  if (
    agreementOperation?.id !== operationId ||
    agreementOperation.reservationLineageVersion !== 1 ||
    agreementOperation.reservationLineageReady !== true
  ) {
    throw new Error("wager-agreement-lineage-unavailable");
  }
}

export async function ensureWagerAgreementLineageReady(
  repository: GameplayRepository,
  wagerPath: string,
  now: () => number,
): Promise<void> {
  const wager = toRecord(await repository.getRtdbPath(wagerPath));
  const agreementOperation = toRecord(wager?.agreementOperation);
  if (
    agreementOperation?.reservationLineageVersion !== 1 ||
    agreementOperation.reservationLineageReady === true
  ) {
    return;
  }
  if (!Array.isArray(agreementOperation.reservationAdjustments)) {
    throw new Error("wager-agreement-lineage-unavailable");
  }
  for (const value of agreementOperation.reservationAdjustments) {
    const adjustment = toRecord(value);
    const uid = normalizeString(adjustment?.uid);
    const operationId = normalizeString(adjustment?.operationId);
    const kind = normalizeString(adjustment?.kind);
    const material = normalizeString(adjustment?.material);
    const delta = Number(adjustment?.delta);
    if (
      !uid ||
      !isSafeFirebaseKey(uid) ||
      !/^[a-f0-9]{64}$/.test(operationId) ||
      ![
        "accept-proposer-adjustment",
        "send-proposer-adjustment",
        "send-self-adjustment",
      ].includes(kind) ||
      !isMaterialName(material) ||
      !Number.isSafeInteger(delta) ||
      delta === 0
    ) {
      throw new Error("wager-agreement-lineage-unavailable");
    }
    await updateFrozenMaterialsOnce(
      repository,
      uid,
      operationId,
      kind,
      { [material]: delta },
      now,
    );
  }
  await markWagerAgreementLineageReady(
    repository,
    wagerPath,
    normalizeString(agreementOperation.id),
  );
}

async function readFrozenOperationForUid(
  repository: GameplayRepository,
  uid: string,
  operationId: string,
): Promise<FrozenOperationRecord | null> {
  return readFrozenOperation(
    await repository.getRtdbPath(`players/${uid}/mining`),
    operationId,
  );
}

function reservationOperationIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map(normalizeString)
        .filter((operationId, index, values) =>
          Boolean(operationId && values.indexOf(operationId) === index),
        )
    : [];
}

function wagerReferencesReservationOperation(
  value: unknown,
  playerUid: string,
  reservationOperationId: string,
): boolean {
  const wager = toRecord(value);
  const proposal = toRecord(toRecord(wager?.proposals)?.[playerUid]);
  const agreementOperation = toRecord(wager?.agreementOperation);
  return Boolean(
    normalizeString(proposal?.reservationOperationId) ===
      reservationOperationId ||
    reservationOperationIds(
      agreementOperation?.accepterReservationOperationIds,
    ).includes(reservationOperationId) ||
    reservationOperationIds(
      agreementOperation?.proposerReservationOperationIds,
    ).includes(reservationOperationId) ||
    wager?.settlement,
  );
}

function invertFrozenDeltas(
  operation: FrozenOperationRecord,
): Partial<MiningMaterials> {
  const rollback: Partial<MiningMaterials> = {};
  let changed = false;
  for (const material of MATERIAL_KEYS) {
    const delta = operation.deltas?.[material];
    if (delta === undefined || delta === 0) continue;
    if (typeof delta !== "number" || !Number.isFinite(delta)) {
      throw new Error("wager-operation-unavailable");
    }
    rollback[material] = -delta;
    changed = true;
  }
  if (!changed) {
    throw new Error("wager-operation-unavailable");
  }
  return rollback;
}

async function recoverSameCanonicalSendReservation(
  repository: GameplayRepository,
  input: {
    playerUid: string;
    reservationOperationId: string;
    wagerPath: string;
  },
): Promise<void> {
  const reservation = await readFrozenOperationForUid(
    repository,
    input.playerUid,
    input.reservationOperationId,
  );
  if (!reservation) return;
  const wager = await repository.getRtdbPath(input.wagerPath);
  if (
    wagerReferencesReservationOperation(
      wager,
      input.playerUid,
      input.reservationOperationId,
    )
  ) {
    return;
  }
  await consumeWagerReservationOperation(
    repository,
    input.playerUid,
    input.reservationOperationId,
  );
}

async function recoverUnavailableAcceptReservation(
  repository: GameplayRepository,
  input: {
    playerUid: string;
    reservationOperationId: string;
    wager: Record<string, unknown> | null;
  },
): Promise<void> {
  const reservation = await readFrozenOperationForUid(
    repository,
    input.playerUid,
    input.reservationOperationId,
  );
  if (!reservation) return;
  if (
    wagerReferencesReservationOperation(
      input.wager,
      input.playerUid,
      input.reservationOperationId,
    )
  ) {
    return;
  }
  await consumeWagerReservationOperation(
    repository,
    input.playerUid,
    input.reservationOperationId,
  );
}

export async function releaseWagerSettlementReservation(
  repository: GameplayRepository,
  input: {
    count: number;
    material: MiningMaterialName;
    operationId: string;
    uid: string;
  },
  now: () => number,
): Promise<void> {
  const operationId = await createOperationId(
    "settlement-release",
    input.operationId,
    input.uid,
    input.material,
    String(input.count),
  );
  await updateFrozenMaterialsOnce(
    repository,
    input.uid,
    operationId,
    "settlement-release",
    { [input.material]: -input.count },
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
      return {
        materials,
        count: reservedCount,
        deltas: { [material]: reservedCount },
      };
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
  identity: RequestIdentity,
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
  const reservationOperationId = await createWagerReservationOperationId(
    "send",
    request.inviteId,
    request.matchId,
    participants.playerUid,
  );
  const selfAdjustmentOperationId = await createOperationId(
    operationId,
    "self-adjustment",
  );
  const opponentAdjustmentOperationId = await createOperationId(
    operationId,
    "proposer-adjustment",
  );
  const wagerPath = `invites/${request.inviteId}/wagers/${request.matchId}`;
  if (participants.playerProfileId === participants.opponentProfileId) {
    await recoverSameCanonicalSendReservation(repository, {
      playerUid: participants.playerUid,
      reservationOperationId,
      wagerPath,
    });
    return { ok: false, reason: "proposal-unavailable" };
  }
  const existingMining = await repository.getRtdbPath(
    `players/${participants.playerUid}/mining`,
  );
  const existingReservation = readFrozenOperation(
    existingMining,
    reservationOperationId,
  );
  if (isConsumedFrozenOperation(existingMining, reservationOperationId)) {
    const wager = toRecord(await repository.getRtdbPath(wagerPath));
    const agreementOperation = toRecord(wager?.agreementOperation);
    const agreement = isWagerAgreement(wager?.agreed) ? wager.agreed : null;
    if (
      agreement &&
      (agreementOperation?.id === operationId ||
        agreementOperation?.proposerOperationId === operationId)
    ) {
      return { ok: true, count: agreement.count, agreed: agreement };
    }
    const proposal = toRecord(
      toRecord(wager?.proposals)?.[participants.playerUid],
    );
    if (proposal?.operationId === operationId) {
      return { ok: true, count: normalizeCount(proposal.count) };
    }
    return { ok: false, reason: "proposal-unavailable" };
  }
  const expectedReservationFingerprint = operationFingerprint(
    "send-reserve",
    request.material,
    requestedCount,
  );
  if (
    existingReservation &&
    existingReservation.fingerprint !== expectedReservationFingerprint
  ) {
    const wager = await repository.getRtdbPath(wagerPath);
    if (
      wagerReferencesReservationOperation(
        wager,
        participants.playerUid,
        reservationOperationId,
      )
    ) {
      return { ok: false, reason: "proposal-unavailable" };
    }
    await consumeWagerReservationOperation(
      repository,
      participants.playerUid,
      reservationOperationId,
    );
  }
  const totalMaterials = await repository.getMiningMaterials(
    participants.playerProfileId,
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

  let wagerAfter: Record<string, unknown> | null = null;
  try {
    const result = await repository.transactRtdbPath(wagerPath, (current) => {
      const transition = transitionWagerProposal(current, {
        playerUid: participants.playerUid,
        opponentUid: participants.opponentUid,
        material: request.material,
        opponentAdjustmentOperationId,
        reservedCount,
        operationId,
        now: now(),
        reservationOperationId,
        selfAdjustmentOperationId,
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
    await consumeWagerReservationOperation(
      repository,
      participants.playerUid,
      reservationOperationId,
    );
    return { ok: false, reason: "proposal-unavailable" };
  }
  if (proposalMatches) {
    return { ok: true, count: normalizeCount(ownProposal?.count) };
  }
  if (removalMatches) {
    await consumeWagerReservationOperation(
      repository,
      participants.playerUid,
      reservationOperationId,
    );
    return { ok: false, reason: "proposal-unavailable" };
  }
  const storedAgreement = wagerAfter?.agreed;
  const agreement = isWagerAgreement(storedAgreement) ? storedAgreement : null;
  if (!agreement) {
    throw new Error("wager-agreement-unavailable");
  }
  if (agreementMatchesAsProposer) {
    await ensureWagerAgreementLineageReady(repository, wagerPath, now);
    return { ok: true, count: agreement.count, agreed: agreement };
  }
  await ensureWagerAgreementLineageReady(repository, wagerPath, now);
  return { ok: true, count: agreement.count, agreed: agreement };
}

export async function acceptWagerProposal(
  identity: RequestIdentity,
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
  const reservationOperationId = await createWagerReservationOperationId(
    "accept",
    request.inviteId,
    request.matchId,
    participants.playerUid,
  );
  const proposerAdjustmentOperationId = await createOperationId(
    operationId,
    "proposer-adjustment",
  );
  const wagerPath = `invites/${request.inviteId}/wagers/${request.matchId}`;
  const wager = toRecord(await repository.getRtdbPath(wagerPath));
  const replayOperation = toRecord(wager?.agreementOperation);
  const replayAgreement = wager?.agreed;
  if (
    replayOperation?.id === operationId &&
    isWagerAgreement(replayAgreement)
  ) {
    await ensureWagerAgreementLineageReady(repository, wagerPath, now);
    return { ok: true, count: replayAgreement.count };
  }
  if (participants.playerProfileId === participants.opponentProfileId) {
    await recoverUnavailableAcceptReservation(repository, {
      playerUid: participants.playerUid,
      reservationOperationId,
      wager,
    });
    return { ok: false, reason: "proposal-unavailable" };
  }
  if (!wager || wager.resolved || wager.agreed || wager.settlement) {
    await recoverUnavailableAcceptReservation(repository, {
      playerUid: participants.playerUid,
      reservationOperationId,
      wager,
    });
    return { ok: false, reason: "proposal-missing" };
  }
  const proposals = toRecord(wager.proposals) || {};
  const opponentProposal = toRecord(proposals[participants.opponentUid]);
  if (!opponentProposal) {
    await recoverUnavailableAcceptReservation(repository, {
      playerUid: participants.playerUid,
      reservationOperationId,
      wager,
    });
    return { ok: false, reason: "proposal-missing" };
  }
  const material = normalizeString(opponentProposal.material);
  const proposedCount = normalizeCount(opponentProposal.count);
  if (!isMaterialName(material) || proposedCount <= 0) {
    await recoverUnavailableAcceptReservation(repository, {
      playerUid: participants.playerUid,
      reservationOperationId,
      wager,
    });
    return { ok: false, reason: "insufficient-materials" };
  }
  const ownProposal = toRecord(proposals[participants.playerUid]);
  await recoverUnavailableAcceptReservation(repository, {
    playerUid: participants.playerUid,
    reservationOperationId,
    wager,
  });
  const ownReservationOperationId = normalizeString(
    ownProposal?.reservationOperationId,
  );
  const opponentReservationOperationId = normalizeString(
    opponentProposal.reservationOperationId,
  );
  const totalMaterials = await repository.getMiningMaterials(
    participants.playerProfileId,
  );
  const reservation = await reserveAcceptedMaterialsOnce(
    repository,
    participants.playerUid,
    reservationOperationId,
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
      if (
        !currentWager ||
        currentWager.resolved ||
        currentWager.agreed ||
        currentWager.settlement
      ) {
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
        normalizeCount(currentOpponentProposal.count) === proposedCount &&
        normalizeString(currentOpponentProposal.reservationOperationId) ===
          opponentReservationOperationId;
      const ownMatches = ownProposal
        ? currentOwnProposal?.material === ownMaterial &&
          normalizeCount(currentOwnProposal.count) === ownCount &&
          normalizeString(currentOwnProposal.reservationOperationId) ===
            ownReservationOperationId
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
            reservationLineageVersion: 1,
            reservationLineageReady: false,
            reservationAdjustments:
              reservation.acceptedCount !== proposedCount
                ? [
                    {
                      uid: participants.opponentUid,
                      operationId: proposerAdjustmentOperationId,
                      kind: "accept-proposer-adjustment",
                      material,
                      delta: reservation.acceptedCount - proposedCount,
                    },
                  ]
                : [],
            accepterReservationOperationIds: [
              reservationOperationId,
              ...(ownReservationOperationId ? [ownReservationOperationId] : []),
            ],
            proposerReservationOperationIds: [
              proposerAdjustmentOperationId,
              ...(opponentReservationOperationId
                ? [opponentReservationOperationId]
                : []),
            ],
            ...(!ownProposal || ownReservationOperationId
              ? {}
              : {
                  accepterLegacyReservation: {
                    material: ownMaterial,
                    count: ownCount,
                  },
                }),
            ...(opponentReservationOperationId
              ? {}
              : {
                  proposerLegacyReservation: {
                    material,
                    count: proposedCount,
                  },
                }),
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
    await consumeWagerReservationOperation(
      repository,
      participants.playerUid,
      reservationOperationId,
    );
    return { ok: false, reason: "proposal-unavailable" };
  }

  await ensureWagerAgreementLineageReady(repository, wagerPath, now);
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
          reservationOperationId:
            normalizeString(proposal.reservationOperationId) || null,
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
  identity: RequestIdentity,
  request: WagerProposalRemovalRequest,
  action: WagerProposalAction,
  repository: GameplayRepository,
  dependencies: WagerProposalDependencies = {},
): Promise<WagerProposalRemovalResponse> {
  const participants = await resolveWagerParticipantUids(
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
    const acceptReservationOperationId =
      await createWagerReservationOperationId(
        "accept",
        request.inviteId,
        request.matchId,
        proposalUid,
      );
    const proposalReservationOperationId = normalizeString(
      proposal.reservationOperationId,
    );
    if (proposalReservationOperationId) {
      await consumeWagerReservationOperations(repository, proposalUid, [
        acceptReservationOperationId,
        proposalReservationOperationId,
      ]);
    } else {
      await updateFrozenMaterialsOnce(
        repository,
        proposalUid,
        await createOperationId(operationId, "release"),
        "proposal-release",
        { [material]: -count },
        now,
      );
    }
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
