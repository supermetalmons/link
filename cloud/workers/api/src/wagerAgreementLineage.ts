import type { WagerKey } from "./wagerStateRepository.ts";
import { lineageFingerprint } from "./wagerStateCommands.ts";
import type { WagerAgreement } from "@mons/shared/wagers";
import type {
  DecodedWager,
  WagerAgreementOperation,
  ReservationAdjustment,
} from "./wagerModel.ts";
import { isSafeRecordKey } from "./recordKeys.ts";
import type { WagerWriteRepository } from "./gameplayRepository.ts";
import type { WagerFrozenReadRepository } from "./wagerFrozenStore.ts";
import {
  createOperationId,
  createWagerReservationOperationId,
  readFrozenOperationForUid,
  updateFrozenMaterialsOnce,
} from "./wagerReservationOperations.ts";

type LineageContext = {
  agreement: WagerAgreement;
  agreementOperation: WagerAgreementOperation;
  inviteId: string;
  matchId: string;
  operationId: string;
  proposerAdjustmentOperationId: string;
  proposerCount: number;
  proposerReservationOperationId: string;
  selfAdjustmentOperationId: string;
};

function validOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sameLineageReady(
  value: DecodedWager | null,
  operationId: string,
  fingerprint: string,
): boolean {
  const operation = value?.agreementOperation;
  return Boolean(
    operation?.id === operationId &&
    operation.reservationLineageVersion === 1 &&
    operation.reservationLineageReady === true &&
    lineageFingerprint(value) === fingerprint,
  );
}

async function createLineageContext(
  wagerKey: WagerKey,
  agreement: WagerAgreement | null,
  agreementOperation: WagerAgreementOperation,
): Promise<LineageContext | null> {
  const operationId = agreementOperation.id;
  const proposerReservedCount = agreementOperation.proposerReservedCount;
  const { inviteId, matchId } = wagerKey;
  if (
    !agreement ||
    !isSafeRecordKey(inviteId) ||
    !isSafeRecordKey(matchId) ||
    !validOperationId(operationId) ||
    typeof proposerReservedCount !== "number" ||
    !Number.isSafeInteger(proposerReservedCount) ||
    proposerReservedCount <= 0 ||
    agreement.count > proposerReservedCount ||
    !isSafeRecordKey(agreement.proposerId) ||
    !isSafeRecordKey(agreement.accepterId) ||
    agreement.proposerId === agreement.accepterId
  ) {
    return null;
  }
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
  repository: WagerFrozenReadRepository,
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
    operationIds[1] !== proposerReservationOperationId
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
  repository: WagerFrozenReadRepository,
  context: LineageContext,
  operationIds: string[],
): Promise<ReservationAdjustment[] | null> {
  const { agreement, inviteId, matchId, proposerCount } = context;
  const reservationOperationId = operationIds[1];
  if (
    operationIds.length !== 2 ||
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
  repository: WagerFrozenReadRepository,
  context: LineageContext,
  operationIds: string[],
): Promise<ReservationAdjustment[] | null> {
  const { agreement, inviteId, matchId, proposerCount } = context;
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
    reservation?.kind === "accept-reserve" && reservation.ownMaterial !== null;
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
  repository: WagerFrozenReadRepository,
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
  value: ReservationAdjustment[],
  expected: ReservationAdjustment[],
): boolean {
  if (value.length !== expected.length) return false;
  const byOperationId = new Map(
    value.map((adjustment) => [adjustment.operationId, adjustment]),
  );
  return (
    byOperationId.size === value.length &&
    expected.every((adjustment) => {
      const actual = byOperationId.get(adjustment.operationId);
      return (
        actual !== undefined &&
        actual.uid === adjustment.uid &&
        actual.kind === adjustment.kind &&
        actual.material === adjustment.material &&
        actual.delta === adjustment.delta
      );
    })
  );
}

async function expectedReservationAdjustments(
  repository: WagerFrozenReadRepository,
  wagerKey: WagerKey,
  agreement: WagerAgreement | null,
  agreementOperation: WagerAgreementOperation,
): Promise<ReservationAdjustment[] | null> {
  const context = await createLineageContext(
    wagerKey,
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
  repository: Pick<WagerWriteRepository, "wagers" | "wagerWriter">,
  wagerKey: WagerKey,
  operationId: string,
  fingerprint: string,
): Promise<void> {
  let value: DecodedWager | null;
  try {
    const result = await repository.wagerWriter.markLineageReady(wagerKey, {
      operationId,
      fingerprint,
    });
    value = result.value;
  } catch {
    value = await repository.wagers.readWager(wagerKey);
  }
  if (!sameLineageReady(value, operationId, fingerprint)) {
    throw new Error("wager-agreement-lineage-unavailable");
  }
}

export async function ensureWagerAgreementLineageReady(
  repository: Pick<
    WagerWriteRepository,
    "wagers" | "wagerWriter" | "wagerFrozen"
  >,
  wagerKey: WagerKey,
  now: () => number,
  assertMutationAllowed?: () => Promise<void>,
): Promise<void> {
  const wager = await repository.wagers.readWager(wagerKey);
  if (wager?.state === "blocked")
    throw new Error("wager-manual-review-required");
  const agreementOperation = wager?.agreementOperation;
  if (
    !agreementOperation ||
    agreementOperation.reservationLineageVersion !== 1 ||
    agreementOperation.reservationLineageReady === true
  ) {
    return;
  }
  const operationId = agreementOperation.id;
  const fingerprint = lineageFingerprint(wager);
  const adjustments = await expectedReservationAdjustments(
    repository,
    wagerKey,
    wager?.agreed ?? null,
    agreementOperation,
  );
  if (!adjustments) {
    const current = await repository.wagers.readWager(wagerKey);
    if (sameLineageReady(current, operationId, fingerprint)) {
      return;
    }
    throw new Error("wager-agreement-lineage-unavailable");
  }
  for (const adjustment of adjustments) {
    await assertMutationAllowed?.();
    await updateFrozenMaterialsOnce(
      repository,
      adjustment.uid,
      adjustment.operationId,
      adjustment.kind,
      { [adjustment.material]: adjustment.delta },
      now,
    );
  }
  await assertMutationAllowed?.();
  await markWagerAgreementLineageReady(
    repository,
    wagerKey,
    operationId,
    fingerprint,
  );
}
