import {
  wagerReferencesReservationOperation,
  type WagerProposal,
} from "./wagerModel.ts";
import type { WagerKey } from "./wagerStateRepository.ts";
import {
  MATERIAL_KEYS,
  applyMaterialDeltasWithCap,
  computeAcceptedReservation,
  computeAvailableCount,
  type MiningMaterialName,
  type MiningMaterials,
} from "@mons/shared/mining";
import type { WagerWriteRepository } from "./gameplayRepository.ts";
import type { WagerFrozenReadRepository } from "./wagerFrozenStore.ts";
import {
  operationFingerprint,
  parseFrozenOperation,
  type FrozenDeltaOperationKind,
  type ParsedFrozenOperation,
  type ReservationOperationKind,
} from "./wagerFrozenRecords.ts";

export {
  createOperationId,
  createWagerReservationOperationId,
  operationFingerprint,
  type ParsedFrozenOperation,
  type FrozenDeltaOperationKind,
} from "./wagerFrozenRecords.ts";

export type WagerMutationContext = {
  createCriticalPhaseSignal: () => AbortSignal;
  refreshLease: () => Promise<void>;
};

function applyExactFrozenDeltas(
  current: MiningMaterials,
  deltas: Partial<MiningMaterials>,
): MiningMaterials {
  const materials = { ...current };
  for (const material of MATERIAL_KEYS) {
    const next = materials[material] + (deltas[material] ?? 0);
    if (!Number.isSafeInteger(next) || next < 0)
      throw new Error("wager-operation-unavailable");
    materials[material] = next;
  }
  return materials;
}

async function applyFrozenOperation(
  repository: Pick<WagerWriteRepository, "wagerFrozen">,
  uid: string,
  operationId: string,
  fingerprint: string,
  create: (current: MiningMaterials) => {
    materials: MiningMaterials;
    count?: number;
    deltas: Partial<MiningMaterials>;
    identity:
      | { kind: FrozenDeltaOperationKind }
      | {
          kind: "send-reserve";
          material: MiningMaterialName;
          requestedCount: number;
        }
      | {
          kind: "accept-reserve";
          material: MiningMaterialName;
          requestedCount: number;
          ownMaterial: MiningMaterialName | null;
          ownCount: number;
        };
  } | null,
  now: () => number,
  signal?: AbortSignal,
): Promise<ParsedFrozenOperation | null> {
  const store = repository.wagerFrozen;
  let expectedAppliedAtMs: number | null = null;
  let result;
  try {
    result = await store.transact(
      uid,
      operationId,
      (current) => {
        const state = current.operation;
        if (state.status === "consumed") {
          return { commit: false, decision: "operation-consumed" };
        }
        if (state.status === "malformed") {
          return { commit: false, decision: "operation-malformed" };
        }
        if (state.status === "active") {
          if (state.operation.fingerprint !== fingerprint) {
            return { commit: false, decision: "operation-conflict" };
          }
          const appliedAtMs = Math.max(state.operation.appliedAtMs + 1, now());
          if (!Number.isSafeInteger(appliedAtMs) || appliedAtMs < 0) {
            return { commit: false, decision: "operation-fence-unavailable" };
          }
          expectedAppliedAtMs = appliedAtMs;
          return {
            decision: "operation-replayed",
            value: {
              frozen: current.frozen,
              operation: {
                status: "active",
                operation: { ...state.operation, appliedAtMs },
              },
            },
          };
        }
        const created = create(current.frozen);
        if (!created) {
          return { commit: false, decision: "operation-rejected" };
        }
        const expected = applyExactFrozenDeltas(current.frozen, created.deltas);
        if (
          MATERIAL_KEYS.some(
            (material) => expected[material] !== created.materials[material],
          )
        ) {
          throw new Error("wager-operation-unavailable");
        }
        const parsedOperation = parseFrozenOperation({
          ...created.identity,
          fingerprint,
          appliedAtMs: now(),
          ...(created.count === undefined ? {} : { count: created.count }),
          deltas: created.deltas,
        });
        if (!parsedOperation) {
          return { commit: false, decision: "operation-rejected" };
        }
        expectedAppliedAtMs = parsedOperation.appliedAtMs;
        return {
          value: {
            frozen: created.materials,
            operation: { status: "active", operation: parsedOperation },
          },
        };
      },
      signal,
    );
  } catch {
    const current = await store.read(uid, operationId);
    const state = current.operation;
    if (state.status === "consumed") return null;
    if (
      state.status === "active" &&
      state.operation.fingerprint === fingerprint &&
      expectedAppliedAtMs !== null &&
      state.operation.appliedAtMs >= expectedAppliedAtMs
    ) {
      return state.operation;
    }
    throw new Error("wager-operation-unavailable");
  }
  if (result.decision === "operation-conflict") {
    throw new Error("wager-operation-conflict");
  }
  if (result.decision === "operation-rejected") return null;
  if (result.decision === "operation-consumed") return null;
  const state = result.value.operation;
  if (
    state.status !== "active" ||
    state.operation.fingerprint !== fingerprint ||
    state.operation.appliedAtMs !== expectedAppliedAtMs
  ) {
    throw new Error("wager-operation-unavailable");
  }
  return state.operation;
}

function isReversibleReservationKind(
  kind: ParsedFrozenOperation["kind"],
): kind is ReservationOperationKind {
  return (
    kind === "accept-proposer-adjustment" ||
    kind === "accept-reserve" ||
    kind === "send-proposer-adjustment" ||
    kind === "send-reserve" ||
    kind === "send-self-adjustment"
  );
}

function invertFrozenDeltas(
  operation: ParsedFrozenOperation,
): Partial<MiningMaterials> {
  if (!isReversibleReservationKind(operation.kind)) {
    throw new Error("wager-operation-unavailable");
  }
  return Object.fromEntries(
    Object.entries(operation.deltas).map(([material, delta]) => [
      material,
      -delta,
    ]),
  );
}

export async function consumeWagerReservationOperation(
  repository: Pick<WagerWriteRepository, "wagerFrozen">,
  uid: string,
  operationId: string,
  retainTombstone = false,
  signal?: AbortSignal,
): Promise<"missing" | "released"> {
  const store = repository.wagerFrozen;
  try {
    const result = await store.transact(
      uid,
      operationId,
      (current) => {
        const state = current.operation;
        if (state.status === "consumed") {
          return { commit: false, decision: "reservation-consumed" };
        }
        if (state.status === "malformed") {
          return { commit: false, decision: "reservation-malformed" };
        }
        if (state.status === "absent") {
          if (retainTombstone) {
            return {
              decision: "reservation-tombstoned",
              value: {
                frozen: current.frozen,
                operation: { status: "consumed" },
              },
            };
          }
          return { commit: false, decision: "reservation-missing" };
        }
        if (!isReversibleReservationKind(state.operation.kind)) {
          return { commit: false, decision: "reservation-invalid" };
        }
        const materials = applyExactFrozenDeltas(
          current.frozen,
          invertFrozenDeltas(state.operation),
        );
        return {
          decision: "reservation-released",
          value: {
            frozen: materials,
            operation: { status: retainTombstone ? "consumed" : "absent" },
          },
        };
      },
      signal,
    );
    if (result.decision === "reservation-missing") return "missing";
    if (
      result.decision === "reservation-released" ||
      result.decision === "reservation-consumed" ||
      result.decision === "reservation-tombstoned"
    ) {
      return "released";
    }
    throw new Error("wager-operation-unavailable");
  } catch (error) {
    const current = await store.read(uid, operationId).catch(() => undefined);
    if (current !== undefined && current.operation.status === "consumed") {
      return "released";
    }
    if (
      !retainTombstone &&
      current !== undefined &&
      current.operation.status === "absent"
    ) {
      return "released";
    }
    throw error;
  }
}

export async function updateFrozenMaterialsOnce(
  repository: Pick<WagerWriteRepository, "wagerFrozen">,
  uid: string,
  operationId: string,
  kind: FrozenDeltaOperationKind,
  deltas: Partial<MiningMaterials>,
  now: () => number,
  totalMaterials?: MiningMaterials,
  signal?: AbortSignal,
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
        : applyExactFrozenDeltas(current, deltas),
      deltas,
      identity: { kind },
    }),
    now,
    signal,
  );
}

export async function readFrozenOperationForUid(
  repository: WagerFrozenReadRepository,
  uid: string,
  operationId: string,
): Promise<ParsedFrozenOperation | null> {
  const state = (await repository.wagerFrozen.read(uid, operationId)).operation;
  if (state.status === "malformed") {
    throw new Error("wager-operation-unavailable");
  }
  return state.status === "active" ? state.operation : null;
}

export async function releaseUnreferencedWagerReservation(
  repository: Pick<WagerWriteRepository, "wagers" | "wagerFrozen">,
  input: {
    mutation: WagerMutationContext;
    playerUid: string;
    reservationOperationId: string;
    wagerKey: WagerKey;
  },
): Promise<"missing" | "referenced" | "released"> {
  if (
    wagerReferencesReservationOperation(
      await repository.wagers.readWager(input.wagerKey),
      input.playerUid,
      input.reservationOperationId,
    )
  ) {
    return "referenced";
  }
  await input.mutation.refreshLease();
  return consumeWagerReservationOperation(
    repository,
    input.playerUid,
    input.reservationOperationId,
    false,
    input.mutation.createCriticalPhaseSignal(),
  );
}

export async function recoverUnreferencedWagerReservation(
  repository: Pick<WagerWriteRepository, "wagers" | "wagerFrozen">,
  input: {
    mutation: WagerMutationContext;
    playerUid: string;
    reservationOperationId: string;
    wagerKey: WagerKey;
  },
  expectedKind: "accept-reserve" | "send-reserve",
): Promise<void> {
  const operation = await readFrozenOperationForUid(
    repository,
    input.playerUid,
    input.reservationOperationId,
  );
  if (!operation) return;
  if (operation.kind !== expectedKind) {
    throw new Error("wager-operation-unavailable");
  }
  await releaseUnreferencedWagerReservation(repository, input);
}

export async function reserveFrozenMaterialsOnce(
  repository: Pick<WagerWriteRepository, "wagerFrozen">,
  uid: string,
  operationId: string,
  material: MiningMaterialName,
  count: number,
  totalMaterials: MiningMaterials,
  now: () => number,
  signal: AbortSignal,
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
      if (reservedCount <= 0) return null;
      const materials = { ...current };
      materials[material] += reservedCount;
      return {
        materials,
        identity: { kind: "send-reserve", material, requestedCount: count },
        count: reservedCount,
        deltas: { [material]: reservedCount },
      };
    },
    now,
    signal,
  );
  return operation && "count" in operation ? operation.count : 0;
}

export async function reserveAcceptedMaterialsOnce(
  repository: Pick<WagerWriteRepository, "wagerFrozen">,
  uid: string,
  operationId: string,
  material: MiningMaterialName,
  proposedCount: number,
  ownProposal: Pick<WagerProposal, "material" | "count"> | null,
  totalMaterials: MiningMaterials,
  now: () => number,
  signal: AbortSignal,
): Promise<{
  acceptedCount: number;
  appliedDelta: Partial<MiningMaterials> | null;
}> {
  const ownMaterial = ownProposal?.material ?? null;
  const ownCount = ownProposal?.count ?? 0;
  const fingerprint = operationFingerprint(
    "accept-reserve",
    `${material}:${ownMaterial ?? ""}`,
    proposedCount,
    ownMaterial !== null && ownCount > 0 ? { [ownMaterial]: ownCount } : {},
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
      if (!reservation.materials) return null;
      return {
        materials: reservation.materials,
        identity: {
          kind: "accept-reserve",
          material,
          requestedCount: proposedCount,
          ownMaterial,
          ownCount,
        },
        count: reservation.acceptedCount,
        deltas: reservation.appliedDelta || {},
      };
    },
    now,
    signal,
  );
  return operation
    ? {
        acceptedCount: "count" in operation ? operation.count : 0,
        appliedDelta: operation.deltas,
      }
    : { acceptedCount: 0, appliedDelta: null };
}
