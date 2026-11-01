import {
  isMaterialName,
  MATERIAL_KEYS,
  type MiningMaterialName,
  type MiningMaterials,
} from "@mons/shared/mining";

export type FrozenDeltaOperationKind =
  | "accept-proposer-adjustment"
  | "send-proposer-adjustment"
  | "send-self-adjustment";
export type ReservationOperationKind =
  FrozenDeltaOperationKind | "send-reserve" | "accept-reserve";
export type WagerFrozenOperationKind = ReservationOperationKind;
type OperationBase = {
  appliedAtMs: number;
  deltas: Partial<MiningMaterials>;
  fingerprint: string;
};
export type ParsedFrozenOperation = OperationBase &
  (
    | {
        kind: "send-reserve";
        material: MiningMaterialName;
        count: number;
        requestedCount: number;
      }
    | {
        kind: "accept-reserve";
        material: MiningMaterialName;
        count: number;
        requestedCount: number;
        ownMaterial: MiningMaterialName | null;
        ownCount: number;
      }
    | { kind: FrozenDeltaOperationKind }
  );
export type FrozenOperationRecord = ParsedFrozenOperation;
export type StoredFrozenOperation =
  | { schemaVersion: 1; status: "consumed" }
  | { schemaVersion: 1; status: "active"; operation: ParsedFrozenOperation };
export type FrozenOperationState =
  | { status: "absent" }
  | { status: "consumed" }
  | { status: "active"; operation: ParsedFrozenOperation }
  | { status: "malformed" };

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function amount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    Number.isSafeInteger(value * 2)
  );
}
function exactDeltas(
  value: unknown,
  expected: Partial<MiningMaterials>,
): boolean {
  return (
    record(value) &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(value).every(
      ([key, delta]) =>
        isMaterialName(key) &&
        Number.isSafeInteger(delta) &&
        delta !== 0 &&
        delta === expected[key],
    )
  );
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

export function parseFrozenOperation(
  value: unknown,
): ParsedFrozenOperation | null {
  if (
    !record(value) ||
    typeof value.fingerprint !== "string" ||
    typeof value.appliedAtMs !== "number" ||
    !Number.isSafeInteger(value.appliedAtMs) ||
    value.appliedAtMs < 0
  )
    return null;
  const base = ["kind", "appliedAtMs", "deltas", "fingerprint"];
  if (value.kind === "send-reserve") {
    if (
      !exact(value, [...base, "material", "count", "requestedCount"]) ||
      !isMaterialName(value.material) ||
      !amount(value.count) ||
      !amount(value.requestedCount) ||
      value.count > value.requestedCount ||
      !exactDeltas(value.deltas, { [value.material]: value.count }) ||
      value.fingerprint !==
        operationFingerprint(value.kind, value.material, value.requestedCount)
    )
      return null;
  } else if (value.kind === "accept-reserve") {
    if (
      !exact(value, [
        ...base,
        "material",
        "count",
        "requestedCount",
        "ownMaterial",
        "ownCount",
      ]) ||
      !isMaterialName(value.material) ||
      !amount(value.count) ||
      !amount(value.requestedCount) ||
      value.count > value.requestedCount ||
      !(value.ownMaterial === null
        ? value.ownCount === 0
        : isMaterialName(value.ownMaterial) && amount(value.ownCount))
    )
      return null;
    const ownMaterial = value.ownMaterial as MiningMaterialName | null;
    const ownCount = value.ownCount as number;
    const expected: Partial<MiningMaterials> = {};
    if (ownMaterial !== null) expected[ownMaterial] = -ownCount;
    expected[value.material] = (expected[value.material] ?? 0) + value.count;
    if (expected[value.material] === 0) delete expected[value.material];
    if (
      !exactDeltas(value.deltas, expected) ||
      value.fingerprint !==
        operationFingerprint(
          value.kind,
          `${value.material}:${ownMaterial ?? ""}`,
          value.requestedCount,
          ownMaterial === null ? {} : { [ownMaterial]: ownCount },
        )
    )
      return null;
  } else {
    if (
      !exact(value, base) ||
      ![
        "accept-proposer-adjustment",
        "send-proposer-adjustment",
        "send-self-adjustment",
      ].includes(String(value.kind)) ||
      !record(value.deltas) ||
      Object.keys(value.deltas).length !== 1 ||
      !Object.entries(value.deltas).every(
        ([key, delta]) =>
          isMaterialName(key) &&
          typeof delta === "number" &&
          Number.isSafeInteger(delta) &&
          delta < 0,
      ) ||
      value.fingerprint !==
        operationFingerprint(
          value.kind as FrozenDeltaOperationKind,
          "",
          0,
          value.deltas,
        )
    )
      return null;
  }
  return value as ParsedFrozenOperation;
}
export function isStoredFrozenOperation(
  value: unknown,
): value is StoredFrozenOperation {
  if (!record(value) || value.schemaVersion !== 1) return false;
  if (value.status === "consumed")
    return exact(value, ["schemaVersion", "status"]);
  return (
    value.status === "active" &&
    exact(value, ["schemaVersion", "status", "operation"]) &&
    parseFrozenOperation(value.operation) !== null
  );
}
export function frozenOperationState(value: unknown): FrozenOperationState {
  if (value === undefined) return { status: "absent" };
  if (!isStoredFrozenOperation(value)) return { status: "malformed" };
  return value.status === "consumed"
    ? { status: "consumed" }
    : { status: "active", operation: value.operation };
}
