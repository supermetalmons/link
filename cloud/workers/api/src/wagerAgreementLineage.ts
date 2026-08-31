import type { MiningMaterialName } from "@mons/shared/mining";
import { isWagerAgreement, type WagerAgreement } from "@mons/shared/wagers";
import { isSafeFirebaseKey } from "./firebaseKeys.ts";
import type { GameplayRepository } from "./gameplayRepository.ts";
import {
  createOperationId,
  createWagerReservationOperationId,
  readFrozenOperationForUid,
  updateFrozenMaterialsOnce,
} from "./wagerReservationOperations.ts";

type ReservationAdjustment = {
  delta: number;
  kind:
    | "accept-proposer-adjustment"
    | "send-proposer-adjustment"
    | "send-self-adjustment";
  material: MiningMaterialName;
  operationId: string;
  uid: string;
};

type LineageContext = {
  agreement: WagerAgreement;
  agreementOperation: Record<string, unknown>;
  inviteId: string;
  matchId: string;
  operationId: string;
  proposerAdjustmentOperationId: string;
  proposerCount: number;
  proposerReservationOperationId: string;
  selfAdjustmentOperationId: string;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toPlainRecord(value: unknown): Record<string, unknown> | null {
  const record = toRecord(value);
  if (!record) return null;
  const prototype = Object.getPrototypeOf(record);
  return prototype === Object.prototype || prototype === null ? record : null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function validOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function withoutReady(value: unknown): Record<string, unknown> {
  const operation = toRecord(value);
  const { reservationLineageReady: _ready, ...rest } = operation || {};
  return rest;
}

function lineageFingerprint(value: unknown): string {
  const wager = toRecord(value);
  return JSON.stringify([
    wager?.agreed,
    withoutReady(wager?.agreementOperation),
  ]);
}

function sameLineageReady(
  value: unknown,
  operationId: string,
  fingerprint: string,
): boolean {
  const operation = toRecord(toRecord(value)?.agreementOperation);
  return Boolean(
    operation?.id === operationId &&
    operation.reservationLineageVersion === 1 &&
    operation.reservationLineageReady === true &&
    lineageFingerprint(value) === fingerprint,
  );
}

async function createLineageContext(
  wagerPath: string,
  agreement: WagerAgreement | null,
  agreementOperation: Record<string, unknown>,
): Promise<LineageContext | null> {
  const operationId = agreementOperation.id;
  const proposerReservedCount = agreementOperation.proposerReservedCount;
  const path = /^invites\/([^/]+)\/wagers\/([^/]+)$/.exec(wagerPath);
  if (
    !agreement ||
    !path ||
    !validOperationId(operationId) ||
    typeof proposerReservedCount !== "number" ||
    !Number.isSafeInteger(proposerReservedCount) ||
    proposerReservedCount <= 0 ||
    agreement.count > proposerReservedCount ||
    !isSafeFirebaseKey(agreement.proposerId) ||
    !isSafeFirebaseKey(agreement.accepterId) ||
    agreement.proposerId === agreement.accepterId
  ) {
    return null;
  }
  const [, inviteId, matchId] = path;
  return {
    agreement,
    agreementOperation,
    inviteId,
    matchId,
    operationId,
    proposerAdjustmentOperationId: await createOperationId(
      operationId,
      "proposer-adjustment",
    ),
    proposerCount: proposerReservedCount,
    proposerReservationOperationId: await createWagerReservationOperationId(
      "send",
      inviteId,
      matchId,
      agreement.proposerId,
    ),
    selfAdjustmentOperationId: await createOperationId(
      operationId,
      "self-adjustment",
    ),
  };
}

async function validateProposerLineage(
  repository: GameplayRepository,
  context: LineageContext,
): Promise<boolean> {
  const {
    agreement,
    agreementOperation,
    inviteId,
    matchId,
    proposerCount,
    proposerReservationOperationId,
  } = context;
  const operationIds = agreementOperation.proposerReservationOperationIds;
  if (
    !Array.isArray(operationIds) ||
    operationIds.length !== 2 ||
    operationIds[0] !== context.proposerAdjustmentOperationId ||
    operationIds[1] !== proposerReservationOperationId ||
    Object.hasOwn(agreementOperation, "proposerLegacyReservation")
  ) {
    return false;
  }
  const reservation = await readFrozenOperationForUid(
    repository,
    agreement.proposerId,
    proposerReservationOperationId,
  );
  return Boolean(
    reservation?.kind === "send-reserve" &&
    reservation.material === agreement.material &&
    reservation.count === proposerCount &&
    agreementOperation.proposerOperationId ===
      (await createOperationId(
        "send",
        inviteId,
        matchId,
        agreement.proposerId,
        agreement.material,
        String(reservation.requestedCount),
      )),
  );
}

async function validateAutoSendAccepter(
  repository: GameplayRepository,
  context: LineageContext,
  operationIds: unknown[],
): Promise<ReservationAdjustment[] | null> {
  const { agreement, agreementOperation, inviteId, matchId, proposerCount } =
    context;
  const reservationOperationId = operationIds[1];
  if (
    operationIds.length !== 2 ||
    Object.hasOwn(agreementOperation, "accepterLegacyReservation") ||
    reservationOperationId !==
      (await createWagerReservationOperationId(
        "send",
        inviteId,
        matchId,
        agreement.accepterId,
      ))
  ) {
    return null;
  }
  const reservation = await readFrozenOperationForUid(
    repository,
    agreement.accepterId,
    reservationOperationId,
  );
  if (
    reservation?.kind !== "send-reserve" ||
    reservation.material !== agreement.material ||
    reservation.deltas[agreement.material] !== reservation.count ||
    Object.keys(reservation.deltas).length !== 1 ||
    agreement.count !== Math.min(reservation.count, proposerCount) ||
    context.operationId !==
      (await createOperationId(
        "send",
        inviteId,
        matchId,
        agreement.accepterId,
        agreement.material,
        String(reservation.requestedCount),
      ))
  ) {
    return null;
  }
  return agreement.count === reservation.count
    ? []
    : [
        {
          uid: agreement.accepterId,
          operationId: context.selfAdjustmentOperationId,
          kind: "send-self-adjustment",
          material: agreement.material,
          delta: agreement.count - reservation.count,
        },
      ];
}

async function validateAcceptedAccepter(
  repository: GameplayRepository,
  context: LineageContext,
  operationIds: unknown[],
): Promise<ReservationAdjustment[] | null> {
  const { agreement, agreementOperation, inviteId, matchId, proposerCount } =
    context;
  const acceptReservationOperationId = await createWagerReservationOperationId(
    "accept",
    inviteId,
    matchId,
    agreement.accepterId,
  );
  const reservation = await readFrozenOperationForUid(
    repository,
    agreement.accepterId,
    acceptReservationOperationId,
  );
  const ownReservationOperationId = await createWagerReservationOperationId(
    "send",
    inviteId,
    matchId,
    agreement.accepterId,
  );
  const hasOwnReservation =
    reservation?.kind === "accept-reserve" &&
    reservation.ownMaterial !== undefined;
  const ownReservation = hasOwnReservation
    ? await readFrozenOperationForUid(
        repository,
        agreement.accepterId,
        ownReservationOperationId,
      )
    : null;
  if (
    context.operationId !==
      (await createOperationId(
        "accept",
        inviteId,
        matchId,
        agreement.accepterId,
      )) ||
    operationIds[0] !== acceptReservationOperationId ||
    reservation?.kind !== "accept-reserve" ||
    reservation.material !== agreement.material ||
    reservation.requestedCount !== proposerCount ||
    reservation.count !== agreement.count ||
    Object.hasOwn(agreementOperation, "accepterLegacyReservation") ||
    (!hasOwnReservation
      ? operationIds.length !== 1
      : operationIds.length !== 2 ||
        operationIds[1] !== ownReservationOperationId ||
        ownReservation?.kind !== "send-reserve" ||
        ownReservation.material !== reservation.ownMaterial ||
        ownReservation.count !== reservation.ownCount)
  ) {
    return null;
  }
  return [];
}

async function validateAccepterLineage(
  repository: GameplayRepository,
  context: LineageContext,
): Promise<{
  adjustments: ReservationAdjustment[];
  isAutoSend: boolean;
} | null> {
  const operationIds =
    context.agreementOperation.accepterReservationOperationIds;
  if (!Array.isArray(operationIds)) return null;
  const isAutoSend = operationIds[0] === context.selfAdjustmentOperationId;
  const adjustments = isAutoSend
    ? await validateAutoSendAccepter(repository, context, operationIds)
    : await validateAcceptedAccepter(repository, context, operationIds);
  return adjustments ? { adjustments, isAutoSend } : null;
}

function validateStoredAdjustments(
  value: unknown,
  expected: ReservationAdjustment[],
): boolean {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    expected.length === 0
  ) {
    return false;
  }
  const byOperationId = new Map<string, Record<string, unknown>>();
  for (const entry of value) {
    const adjustment = toPlainRecord(entry);
    const operationId = adjustment?.operationId;
    if (
      !adjustment ||
      !validOperationId(operationId) ||
      byOperationId.has(operationId)
    ) {
      return false;
    }
    byOperationId.set(operationId, adjustment);
  }
  return expected.every((adjustment) => {
    const actual = byOperationId.get(adjustment.operationId);
    return Boolean(
      actual &&
      hasExactKeys(actual, [
        "uid",
        "operationId",
        "kind",
        "material",
        "delta",
      ]) &&
      actual.uid === adjustment.uid &&
      actual.operationId === adjustment.operationId &&
      actual.kind === adjustment.kind &&
      actual.material === adjustment.material &&
      actual.delta === adjustment.delta,
    );
  });
}

async function expectedReservationAdjustments(
  repository: GameplayRepository,
  wagerPath: string,
  agreement: WagerAgreement | null,
  agreementOperation: Record<string, unknown>,
): Promise<ReservationAdjustment[] | null> {
  const context = await createLineageContext(
    wagerPath,
    agreement,
    agreementOperation,
  );
  if (!context) return null;
  if (!(await validateProposerLineage(repository, context))) {
    return null;
  }
  const accepter = await validateAccepterLineage(repository, context);
  if (!accepter) return null;
  const expected = [...accepter.adjustments];
  if (context.agreement.count !== context.proposerCount) {
    expected.push({
      uid: context.agreement.proposerId,
      operationId: context.proposerAdjustmentOperationId,
      kind: accepter.isAutoSend
        ? "send-proposer-adjustment"
        : "accept-proposer-adjustment",
      material: context.agreement.material,
      delta: context.agreement.count - context.proposerCount,
    });
  }
  return validateStoredAdjustments(
    agreementOperation.reservationAdjustments,
    expected,
  )
    ? expected
    : null;
}

async function markWagerAgreementLineageReady(
  repository: GameplayRepository,
  wagerPath: string,
  operationId: string,
  fingerprint: string,
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
        agreementOperation.reservationLineageVersion !== 1 ||
        lineageFingerprint(wager) !== fingerprint
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
  if (!sameLineageReady(value, operationId, fingerprint)) {
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
    !agreementOperation ||
    agreementOperation.reservationLineageVersion !== 1 ||
    agreementOperation.reservationLineageReady === true
  ) {
    return;
  }
  const operationId = normalizeString(agreementOperation.id);
  const fingerprint = lineageFingerprint(wager);
  const adjustments = await expectedReservationAdjustments(
    repository,
    wagerPath,
    isWagerAgreement(wager?.agreed) ? wager.agreed : null,
    agreementOperation,
  );
  if (!adjustments) {
    const current = await repository.getRtdbPath(wagerPath);
    if (sameLineageReady(current, operationId, fingerprint)) {
      return;
    }
    throw new Error("wager-agreement-lineage-unavailable");
  }
  for (const adjustment of adjustments) {
    await updateFrozenMaterialsOnce(
      repository,
      adjustment.uid,
      adjustment.operationId,
      adjustment.kind,
      { [adjustment.material]: adjustment.delta },
      now,
    );
  }
  await markWagerAgreementLineageReady(
    repository,
    wagerPath,
    operationId,
    fingerprint,
  );
}
