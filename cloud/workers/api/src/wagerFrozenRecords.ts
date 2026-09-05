import {
  isMaterialName,
  MATERIAL_KEYS,
  type MiningMaterialName,
  type MiningMaterials,
} from "@mons/shared/mining";

export type FrozenOperationRecord = {
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

export type WagerFrozenOperationKind = ReservationOperationKind;

export type FrozenDeltaOperationKind =
  | "accept-proposer-adjustment"
  | "send-proposer-adjustment"
  | "send-self-adjustment";

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

export type ParsedFrozenOperation =
  ParsedAcceptReservation | ParsedAdjustmentOperation | ParsedSendReservation;

export type FrozenOperationState =
  | { status: "absent" }
  | { status: "consumed" }
  | { operation: ParsedFrozenOperation; status: "active" }
  | { status: "malformed" };

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
  return {
    ...base(deltas),
    kind: kind as ParsedAdjustmentOperation["kind"],
  };
}

export function frozenOperationState(value: unknown): FrozenOperationState {
  if (value === undefined) return { status: "absent" };
  const record = toPlainRecord(value);
  if (record && Object.keys(record).length === 1 && record.consumed === true) {
    return { status: "consumed" };
  }
  const operation = parseFrozenOperation(value);
  return operation ? { operation, status: "active" } : { status: "malformed" };
}
