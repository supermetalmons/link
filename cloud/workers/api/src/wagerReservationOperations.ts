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
import type { GameplayRepository } from "./gameplayRepository.ts";

export type WagerMutationContext = {
  createCriticalPhaseSignal: () => AbortSignal;
  refreshLease: () => Promise<void>;
};

type FrozenOperationRecord = {
  appliedAtMs: number;
  count?: number;
  deltas: Partial<MiningMaterials>;
  fingerprint: string;
};

export type ReservationOperationKind =
  | "accept-proposer-adjustment"
  | "accept-reserve"
  | "send-proposer-adjustment"
  | "send-reserve"
  | "send-self-adjustment";

export type WagerFrozenOperationKind =
  ReservationOperationKind | "proposal-release" | "settlement-release";

export type FrozenDeltaOperationKind =
  | "accept-proposer-adjustment"
  | "proposal-release"
  | "send-proposer-adjustment"
  | "send-self-adjustment"
  | "settlement-release";

type ParsedOperationBase = FrozenOperationRecord & {
  expectedDeltas: Partial<MiningMaterials>;
};

type ParsedSendReservation = ParsedOperationBase & {
  count: number;
  kind: "send-reserve";
  material: MiningMaterialName;
  requestedCount: number;
};

type ParsedAcceptReservation = ParsedOperationBase & {
  count: number;
  kind: "accept-reserve";
  material: MiningMaterialName;
  ownCount?: number;
  ownMaterial?: MiningMaterialName;
  requestedCount: number;
};

type ParsedAdjustmentOperation = ParsedOperationBase & {
  kind:
    | "accept-proposer-adjustment"
    | "send-proposer-adjustment"
    | "send-self-adjustment";
};

type ParsedReleaseOperation = ParsedOperationBase & {
  kind: "proposal-release" | "settlement-release";
};

export type ParsedFrozenOperation =
  | ParsedAcceptReservation
  | ParsedAdjustmentOperation
  | ParsedReleaseOperation
  | ParsedSendReservation;

export type FrozenOperationState =
  | { status: "absent" }
  | { status: "consumed" }
  | { operation: ParsedFrozenOperation; status: "active" }
  | { status: "malformed" };

const FROZEN_OPERATION_ROOT = "_wagerOps";

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

export async function createOperationId(...parts: string[]): Promise<string> {
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

export function operationFingerprint(
  kind: WagerFrozenOperationKind,
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

function exactMaterialDeltas(
  value: unknown,
  expected: Partial<MiningMaterials>,
): value is Partial<MiningMaterials> {
  const actual = toPlainRecord(value);
  if (!actual) return false;
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((material) => {
      const delta = actual[material];
      return (
        isMaterialName(material) &&
        Number.isSafeInteger(delta) &&
        delta !== 0 &&
        delta === expected[material]
      );
    })
  );
}

export function parseFrozenOperation(
  value: unknown,
): ParsedFrozenOperation | null {
  const operation = toPlainRecord(value);
  if (!operation || typeof operation.fingerprint !== "string") return null;
  const appliedAtMs = operation.appliedAtMs;
  const storedFingerprint = operation.fingerprint;
  if (
    typeof appliedAtMs !== "number" ||
    !Number.isSafeInteger(appliedAtMs) ||
    appliedAtMs < 0
  ) {
    return null;
  }
  let fingerprint: unknown;
  try {
    fingerprint = JSON.parse(storedFingerprint);
  } catch {
    return null;
  }
  if (
    !Array.isArray(fingerprint) ||
    fingerprint.length !== MATERIAL_KEYS.length + 3 ||
    typeof fingerprint[0] !== "string" ||
    typeof fingerprint[1] !== "string" ||
    !Number.isSafeInteger(fingerprint[2]) ||
    fingerprint.slice(3).some((delta) => !Number.isSafeInteger(delta))
  ) {
    return null;
  }
  if (storedFingerprint !== JSON.stringify(fingerprint)) return null;
  const kind = fingerprint[0];
  const material = fingerprint[1];
  const requestedCount = fingerprint[2];
  const fingerprintDeltas = fingerprint.slice(3) as number[];
  const hasCount = Object.hasOwn(operation, "count");
  const count = operation.count;
  const hasDeltas = Object.hasOwn(operation, "deltas");
  const operationKeys = Object.keys(operation);
  const activeKeys =
    kind === "accept-reserve" && !hasDeltas
      ? ["appliedAtMs", "count", "fingerprint"]
      : hasCount
        ? ["appliedAtMs", "count", "deltas", "fingerprint"]
        : ["appliedAtMs", "deltas", "fingerprint"];
  if (
    operationKeys.length !== activeKeys.length ||
    !operationKeys.every((key) => activeKeys.includes(key))
  ) {
    return null;
  }
  const base = (deltas: Partial<MiningMaterials>): ParsedOperationBase => ({
    appliedAtMs,
    ...(hasCount ? { count: count as number } : {}),
    deltas,
    expectedDeltas: deltas,
    fingerprint: storedFingerprint,
  });
  if (kind === "send-reserve") {
    if (
      !hasCount ||
      !hasDeltas ||
      !isMaterialName(material) ||
      requestedCount <= 0 ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      count > requestedCount ||
      fingerprintDeltas.some((delta) => delta !== 0)
    ) {
      return null;
    }
    const deltas = { [material]: count as number };
    return exactMaterialDeltas(operation.deltas, deltas)
      ? {
          ...base(deltas),
          count,
          kind,
          material,
          requestedCount,
        }
      : null;
  }
  if (kind === "accept-reserve") {
    const [acceptedMaterial, ownMaterial, ...extra] = material.split(":");
    if (
      !hasCount ||
      extra.length > 0 ||
      !isMaterialName(acceptedMaterial) ||
      (ownMaterial !== "" && !isMaterialName(ownMaterial)) ||
      requestedCount <= 0 ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      count > requestedCount
    ) {
      return null;
    }
    const ownIndex = ownMaterial ? MATERIAL_KEYS.indexOf(ownMaterial) : -1;
    const ownCount = ownIndex < 0 ? 0 : fingerprintDeltas[ownIndex];
    if (
      fingerprintDeltas.some(
        (delta, index) => index !== ownIndex && delta !== 0,
      ) ||
      ownCount < 0 ||
      (ownMaterial === "" ? ownCount !== 0 : ownCount <= 0)
    ) {
      return null;
    }
    const deltas: Partial<MiningMaterials> = {};
    if (ownMaterial && ownCount > 0) deltas[ownMaterial] = -ownCount;
    deltas[acceptedMaterial] = (deltas[acceptedMaterial] || 0) + count;
    if (deltas[acceptedMaterial] === 0) delete deltas[acceptedMaterial];
    if (
      hasDeltas
        ? !exactMaterialDeltas(operation.deltas, deltas)
        : Object.keys(deltas).length !== 0
    ) {
      return null;
    }
    return {
      ...base(deltas),
      count,
      kind,
      material: acceptedMaterial,
      ...(ownMaterial ? { ownCount, ownMaterial } : {}),
      requestedCount,
    };
  }
  if (
    ![
      "accept-proposer-adjustment",
      "send-proposer-adjustment",
      "send-self-adjustment",
      "proposal-release",
      "settlement-release",
    ].includes(kind) ||
    hasCount ||
    !hasDeltas ||
    material !== "" ||
    requestedCount !== 0
  ) {
    return null;
  }
  const deltas: Partial<MiningMaterials> = {};
  for (let index = 0; index < MATERIAL_KEYS.length; index += 1) {
    const delta = fingerprintDeltas[index];
    if (delta !== 0) deltas[MATERIAL_KEYS[index]] = delta;
  }
  if (
    Object.keys(deltas).length !== 1 ||
    Object.values(deltas)[0] >= 0 ||
    !exactMaterialDeltas(operation.deltas, deltas)
  ) {
    return null;
  }
  const parsedBase = base(deltas);
  return kind === "proposal-release" || kind === "settlement-release"
    ? { ...parsedBase, kind }
    : {
        ...parsedBase,
        kind: kind as ParsedAdjustmentOperation["kind"],
      };
}

function storedFrozenOperation(
  operation: ParsedFrozenOperation,
): FrozenOperationRecord {
  return {
    appliedAtMs: operation.appliedAtMs,
    ...(operation.count === undefined ? {} : { count: operation.count }),
    deltas: operation.deltas,
    fingerprint: operation.fingerprint,
  };
}

export function frozenOperationState(
  value: unknown,
  operationId: string,
): FrozenOperationState {
  if (value === null || value === undefined) return { status: "absent" };
  const mining = toRecord(value);
  if (!mining) return { status: "malformed" };
  if (!Object.hasOwn(mining, FROZEN_OPERATION_ROOT)) {
    return { status: "absent" };
  }
  const operations = toPlainRecord(mining[FROZEN_OPERATION_ROOT]);
  if (!operations) return { status: "malformed" };
  if (!Object.hasOwn(operations, operationId)) return { status: "absent" };
  const raw = operations[operationId];
  const record = toPlainRecord(raw);
  if (record && Object.keys(record).length === 1 && record.consumed === true) {
    return { status: "consumed" };
  }
  const operation = parseFrozenOperation(raw);
  return operation ? { operation, status: "active" } : { status: "malformed" };
}

function appendFrozenOperation(
  current: unknown,
  operationId: string,
  operation: ParsedFrozenOperation,
  materials: MiningMaterials,
): Record<string, unknown> {
  const mining = toRecord(current) || {};
  const operations = toRecord(mining[FROZEN_OPERATION_ROOT]) || {};
  return {
    ...mining,
    frozen: materials,
    [FROZEN_OPERATION_ROOT]: {
      ...operations,
      [operationId]: storedFrozenOperation(operation),
    },
  };
}

function replaceFrozenOperation(
  current: unknown,
  operationId: string,
  operation: ParsedFrozenOperation,
): Record<string, unknown> {
  const mining = toRecord(current) || {};
  const operations = toPlainRecord(mining[FROZEN_OPERATION_ROOT]) || {};
  return {
    ...mining,
    [FROZEN_OPERATION_ROOT]: {
      ...operations,
      [operationId]: storedFrozenOperation(operation),
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
    deltas: Partial<MiningMaterials>;
  } | null,
  now: () => number,
  signal?: AbortSignal,
): Promise<ParsedFrozenOperation | null> {
  const miningPath = `players/${uid}/mining`;
  let expectedAppliedAtMs: number | null = null;
  let result;
  try {
    result = await repository.transactRtdbPath(
      miningPath,
      (current) => {
        const state = frozenOperationState(current, operationId);
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
            value: replaceFrozenOperation(current, operationId, {
              ...state.operation,
              appliedAtMs,
            }),
          };
        }
        const created = create(normalizeMaterials(toRecord(current)?.frozen));
        if (!created) {
          return { commit: false, decision: "operation-rejected" };
        }
        const parsedOperation = parseFrozenOperation({
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
          value: appendFrozenOperation(
            current,
            operationId,
            parsedOperation,
            created.materials,
          ),
        };
      },
      signal,
    );
  } catch {
    const current = await repository.getRtdbPath(miningPath);
    const state = frozenOperationState(current, operationId);
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
  const state = frozenOperationState(result.value, operationId);
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
    Object.entries(operation.expectedDeltas).map(([material, delta]) => [
      material,
      -delta,
    ]),
  );
}

export async function consumeWagerReservationOperation(
  repository: GameplayRepository,
  uid: string,
  operationId: string,
  retainTombstone = false,
  signal?: AbortSignal,
): Promise<"missing" | "released"> {
  const miningPath = `players/${uid}/mining`;
  try {
    const result = await repository.transactRtdbPath(
      miningPath,
      (current) => {
        const state = frozenOperationState(current, operationId);
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
        if (!isReversibleReservationKind(state.operation.kind)) {
          return { commit: false, decision: "reservation-invalid" };
        }
        const materials = applyMaterialDeltas(
          normalizeMaterials(toRecord(current)?.frozen),
          invertFrozenDeltas(state.operation),
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
    const current = await repository
      .getRtdbPath(miningPath)
      .catch(() => undefined);
    if (
      current !== undefined &&
      frozenOperationState(current, operationId).status === "consumed"
    ) {
      return "released";
    }
    if (
      !retainTombstone &&
      current !== undefined &&
      frozenOperationState(current, operationId).status === "absent"
    ) {
      return "released";
    }
    throw error;
  }
}

export async function updateFrozenMaterialsOnce(
  repository: GameplayRepository,
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
        : applyMaterialDeltas(current, deltas),
      deltas,
    }),
    now,
    signal,
  );
}

export async function readFrozenOperationForUid(
  repository: GameplayRepository,
  uid: string,
  operationId: string,
): Promise<ParsedFrozenOperation | null> {
  const state = frozenOperationState(
    await repository.getRtdbPath(`players/${uid}/mining`),
    operationId,
  );
  if (state.status === "malformed") {
    throw new Error("wager-operation-unavailable");
  }
  return state.status === "active" ? state.operation : null;
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

export function wagerReferencesReservationOperation(
  value: unknown,
  playerUid: string,
  reservationOperationId: string,
): boolean {
  const wager = toRecord(value);
  const proposal = toRecord(toRecord(wager?.proposals)?.[playerUid]);
  const agreementOperation = toRecord(wager?.agreementOperation);
  const settlement = toRecord(wager?.settlement);
  const settlementReferences = Array.isArray(settlement?.releases)
    ? settlement.releases.some((value) => {
        const release = toRecord(value);
        return (
          normalizeString(release?.uid) === playerUid &&
          reservationOperationIds(release?.reservationOperationIds).includes(
            reservationOperationId,
          )
        );
      })
    : false;
  return Boolean(
    normalizeString(proposal?.reservationOperationId) ===
      reservationOperationId ||
    reservationOperationIds(
      agreementOperation?.accepterReservationOperationIds,
    ).includes(reservationOperationId) ||
    reservationOperationIds(
      agreementOperation?.proposerReservationOperationIds,
    ).includes(reservationOperationId) ||
    settlementReferences,
  );
}

export async function releaseUnreferencedWagerReservation(
  repository: GameplayRepository,
  input: {
    mutation: WagerMutationContext;
    playerUid: string;
    reservationOperationId: string;
    wagerPath: string;
  },
): Promise<"missing" | "referenced" | "released"> {
  if (
    wagerReferencesReservationOperation(
      await repository.getRtdbPath(input.wagerPath),
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
  repository: GameplayRepository,
  input: {
    mutation: WagerMutationContext;
    playerUid: string;
    reservationOperationId: string;
    wagerPath: string;
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

export async function reserveFrozenMaterialsOnce(
  repository: GameplayRepository,
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
        count: reservedCount,
        deltas: { [material]: reservedCount },
      };
    },
    now,
    signal,
  );
  return operation?.count || 0;
}

export async function reserveAcceptedMaterialsOnce(
  repository: GameplayRepository,
  uid: string,
  operationId: string,
  material: MiningMaterialName,
  proposedCount: number,
  ownProposal: Record<string, unknown> | null,
  totalMaterials: MiningMaterials,
  now: () => number,
  signal: AbortSignal,
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
      if (!reservation.materials) return null;
      return {
        materials: reservation.materials,
        count: reservation.acceptedCount,
        deltas: reservation.appliedDelta || {},
      };
    },
    now,
    signal,
  );
  return operation
    ? {
        acceptedCount: operation.count || 0,
        appliedDelta: operation.deltas,
      }
    : { acceptedCount: 0, appliedDelta: null };
}
