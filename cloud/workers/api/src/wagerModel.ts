import { isMaterialName, type MiningMaterialName } from "@mons/shared/mining";
import type { WagerAgreement } from "@mons/shared/wagers";
import { normalizeRecordKey } from "@mons/shared/ids";

export type WagerProposal = {
  material: MiningMaterialName;
  count: number;
  createdAt: number;
  operationId: string;
  reservationOperationId: string;
};
export type ReservationAdjustment = {
  uid: string;
  operationId: string;
  kind:
    | "accept-proposer-adjustment"
    | "send-proposer-adjustment"
    | "send-self-adjustment";
  material: MiningMaterialName;
  delta: number;
};
export type WagerAgreementOperation = {
  id: string;
  proposerOperationId: string;
  proposerReservedCount: number;
  reservationLineageVersion: 1;
  reservationLineageReady: boolean;
  reservationAdjustments: ReservationAdjustment[];
  proposerReservationOperationIds: string[];
  accepterReservationOperationIds: string[];
};
export type WagerRemovalReceipt = {
  proposalOperationId: string;
  reservationOperationId: string;
};
type WagerResolution = {
  winnerId: string;
  loserId: string;
  material: MiningMaterialName;
  count: number;
  total: number;
  resolvedAt: number;
};
export const WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON =
  "insufficient-materials";
export type SettlementRelease = {
  reservationOperationIds: string[];
  uid: string;
};
type SettlementLifecycle =
  | { state: "pending"; completedAtMs: null; failureReason: null }
  | {
      state: "completed";
      completedAtMs: number;
      failureReason: "insufficient-materials" | null;
    };
type SettlementIdentity = {
  version: 2;
  claimedAtMs: number;
  fingerprint: string;
  operationId: string;
  releases: SettlementRelease[];
};
export type WagerSettlement = SettlementIdentity &
  SettlementLifecycle &
  (
    | {
        kind: "agreed";
        count: number;
        loserProfileId: string;
        loserUid: string;
        material: MiningMaterialName;
        winnerProfileId: string;
        winnerUid: string;
      }
    | { kind: "proposals"; failureReason: null }
  );
type PendingWagerSettlement = Extract<WagerSettlement, { state: "pending" }>;
type CompletedWagerSettlement = Extract<
  WagerSettlement,
  { state: "completed" }
>;
const WAGER_BLOCK_REASONS = [
  "legacy-agreement-unsettled",
  "legacy-partial",
  "legacy-settlement-incomplete",
  "legacy-resolution-marker",
] as const;
type WagerBlockReason = (typeof WAGER_BLOCK_REASONS)[number];
type WagerBlock = {
  reason: WagerBlockReason;
  requiresManualReview: true;
  detectedAtMs: number;
  sourceDigest: string;
  knownResolution: WagerResolution | null;
  operationIds: string[];
};
type WagerFields = {
  schemaVersion: 1;
  proposals: Record<string, WagerProposal>;
  proposedBy: Record<string, boolean>;
  agreed: WagerAgreement | null;
  agreementOperation: WagerAgreementOperation | null;
  proposalRemovalOperations: Record<string, WagerRemovalReceipt>;
  settlement: WagerSettlement | null;
  resolved: WagerResolution | null;
  blocked: WagerBlock | null;
};
export type WagerRecord = WagerFields &
  (
    | {
        state: "proposed";
        agreed: null;
        agreementOperation: null;
        settlement: null;
        resolved: null;
        blocked: null;
      }
    | {
        state: "agreed";
        agreed: WagerAgreement;
        agreementOperation: WagerAgreementOperation;
        settlement: null;
        resolved: null;
        blocked: null;
      }
    | {
        state: "settling";
        settlement: PendingWagerSettlement;
        resolved: null;
        blocked: null;
      }
    | {
        state: "settled";
        settlement: CompletedWagerSettlement | null;
        blocked: null;
      }
    | { state: "blocked"; blocked: WagerBlock }
  );
export type DecodedWager = WagerRecord;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
const exact = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  record(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const isWagerUid = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 128 &&
  normalizeRecordKey(value) === value;
const isWagerOperationId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isWagerAmount = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  Number.isSafeInteger(value * 2);
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const operationIds = (value: unknown, allowEmpty = false): value is string[] =>
  Array.isArray(value) &&
  (allowEmpty || value.length > 0) &&
  value.every(isWagerOperationId) &&
  new Set(value).size === value.length;

function isStoredWagerProposal(value: unknown): value is WagerProposal {
  return (
    exact(value, [
      "material",
      "count",
      "createdAt",
      "operationId",
      "reservationOperationId",
    ]) &&
    isMaterialName(value.material) &&
    isWagerAmount(value.count) &&
    timestamp(value.createdAt) &&
    isWagerOperationId(value.operationId) &&
    isWagerOperationId(value.reservationOperationId)
  );
}
function isStoredWagerAgreement(value: unknown): value is WagerAgreement {
  return (
    exact(value, [
      "material",
      "count",
      "total",
      "proposerId",
      "accepterId",
      "acceptedAt",
    ]) &&
    isMaterialName(value.material) &&
    isWagerAmount(value.count) &&
    value.total === value.count * 2 &&
    isWagerUid(value.proposerId) &&
    isWagerUid(value.accepterId) &&
    value.proposerId !== value.accepterId &&
    timestamp(value.acceptedAt)
  );
}
function isWagerReservationAdjustment(
  value: unknown,
): value is ReservationAdjustment {
  return (
    exact(value, ["uid", "operationId", "kind", "material", "delta"]) &&
    isWagerUid(value.uid) &&
    isWagerOperationId(value.operationId) &&
    [
      "accept-proposer-adjustment",
      "send-proposer-adjustment",
      "send-self-adjustment",
    ].some((kind) => kind === value.kind) &&
    isMaterialName(value.material) &&
    typeof value.delta === "number" &&
    Number.isSafeInteger(value.delta) &&
    value.delta < 0
  );
}
function isWagerAgreementOperation(
  value: unknown,
): value is WagerAgreementOperation {
  return (
    exact(value, [
      "id",
      "proposerOperationId",
      "proposerReservedCount",
      "reservationLineageVersion",
      "reservationLineageReady",
      "reservationAdjustments",
      "proposerReservationOperationIds",
      "accepterReservationOperationIds",
    ]) &&
    isWagerOperationId(value.id) &&
    isWagerOperationId(value.proposerOperationId) &&
    isWagerAmount(value.proposerReservedCount) &&
    value.reservationLineageVersion === 1 &&
    typeof value.reservationLineageReady === "boolean" &&
    Array.isArray(value.reservationAdjustments) &&
    value.reservationAdjustments.length <= 2 &&
    value.reservationAdjustments.every(isWagerReservationAdjustment) &&
    operationIds(value.proposerReservationOperationIds) &&
    operationIds(value.accepterReservationOperationIds)
  );
}
function isWagerResolution(value: unknown): value is WagerResolution {
  return (
    exact(value, [
      "winnerId",
      "loserId",
      "material",
      "count",
      "total",
      "resolvedAt",
    ]) &&
    isWagerUid(value.winnerId) &&
    isWagerUid(value.loserId) &&
    value.winnerId !== value.loserId &&
    isMaterialName(value.material) &&
    isWagerAmount(value.count) &&
    value.total === value.count * 2 &&
    timestamp(value.resolvedAt)
  );
}
function isWagerRemovalReceipt(value: unknown): value is WagerRemovalReceipt {
  return (
    exact(value, ["proposalOperationId", "reservationOperationId"]) &&
    isWagerOperationId(value.proposalOperationId) &&
    isWagerOperationId(value.reservationOperationId)
  );
}
const release = (value: unknown): value is SettlementRelease =>
  exact(value, ["reservationOperationIds", "uid"]) &&
  isWagerUid(value.uid) &&
  operationIds(value.reservationOperationIds);
function isWagerSettlement(value: unknown): value is WagerSettlement {
  if (!record(value)) return false;
  const keys = [
    "version",
    "state",
    "operationId",
    "claimedAtMs",
    "completedAtMs",
    "failureReason",
    "fingerprint",
    "kind",
    "releases",
  ];
  if (value.kind === "agreed")
    keys.push(
      "winnerUid",
      "loserUid",
      "winnerProfileId",
      "loserProfileId",
      "material",
      "count",
    );
  else if (value.kind !== "proposals") return false;
  if (
    !exact(value, keys) ||
    value.version !== 2 ||
    !isWagerOperationId(value.operationId) ||
    !timestamp(value.claimedAtMs) ||
    typeof value.fingerprint !== "string" ||
    value.fingerprint.length === 0 ||
    !Array.isArray(value.releases) ||
    value.releases.length !== 2 ||
    !value.releases.every(release) ||
    new Set(value.releases.map((entry) => entry.uid)).size !== 2
  )
    return false;
  if (value.state === "pending") {
    if (value.completedAtMs !== null || value.failureReason !== null)
      return false;
  } else if (value.state === "completed") {
    if (
      !timestamp(value.completedAtMs) ||
      value.completedAtMs < value.claimedAtMs ||
      (value.failureReason !== null &&
        value.failureReason !== WAGER_SETTLEMENT_INSUFFICIENT_MATERIALS_REASON)
    )
      return false;
  } else return false;
  if (value.kind === "proposals") return value.failureReason === null;
  return (
    isWagerUid(value.winnerUid) &&
    isWagerUid(value.loserUid) &&
    value.winnerUid !== value.loserUid &&
    isWagerUid(value.winnerProfileId) &&
    isWagerUid(value.loserProfileId) &&
    isMaterialName(value.material) &&
    isWagerAmount(value.count) &&
    value.releases[0]?.uid === value.winnerUid &&
    value.releases[1]?.uid === value.loserUid
  );
}
function isWagerBlock(value: unknown): value is WagerBlock {
  return (
    exact(value, [
      "reason",
      "requiresManualReview",
      "detectedAtMs",
      "sourceDigest",
      "knownResolution",
      "operationIds",
    ]) &&
    WAGER_BLOCK_REASONS.some((reason) => value.reason === reason) &&
    value.requiresManualReview === true &&
    timestamp(value.detectedAtMs) &&
    isWagerOperationId(value.sourceDigest) &&
    (value.knownResolution === null ||
      isWagerResolution(value.knownResolution)) &&
    operationIds(value.operationIds, true)
  );
}
export function isWagerRecord(value: unknown): value is WagerRecord {
  if (
    !exact(value, [
      "schemaVersion",
      "state",
      "proposals",
      "proposedBy",
      "agreed",
      "agreementOperation",
      "proposalRemovalOperations",
      "settlement",
      "resolved",
      "blocked",
    ]) ||
    value.schemaVersion !== 1 ||
    !record(value.proposals) ||
    Object.keys(value.proposals).length > 2 ||
    !Object.entries(value.proposals).every(
      ([uid, proposal]) => isWagerUid(uid) && isStoredWagerProposal(proposal),
    ) ||
    !record(value.proposedBy) ||
    Object.keys(value.proposedBy).length > 2 ||
    !Object.entries(value.proposedBy).every(
      ([uid, flag]) => isWagerUid(uid) && typeof flag === "boolean",
    ) ||
    !record(value.proposalRemovalOperations) ||
    !Object.entries(value.proposalRemovalOperations).every(
      ([id, receipt]) =>
        isWagerOperationId(id) && isWagerRemovalReceipt(receipt),
    ) ||
    !(value.agreed === null || isStoredWagerAgreement(value.agreed)) ||
    !(
      value.agreementOperation === null ||
      isWagerAgreementOperation(value.agreementOperation)
    ) ||
    !(value.settlement === null || isWagerSettlement(value.settlement)) ||
    !(value.resolved === null || isWagerResolution(value.resolved)) ||
    !(value.blocked === null || isWagerBlock(value.blocked))
  )
    return false;
  if (value.state === "blocked") return value.blocked !== null;
  if (value.blocked !== null) return false;
  if (value.state === "proposed")
    return (
      value.agreed === null &&
      value.agreementOperation === null &&
      value.settlement === null &&
      value.resolved === null
    );
  if (value.state === "agreed")
    return (
      value.agreed !== null &&
      value.agreementOperation !== null &&
      value.settlement === null &&
      value.resolved === null &&
      Object.keys(value.proposals).length === 0
    );
  if (value.state === "settling")
    return (
      value.settlement?.state === "pending" &&
      value.resolved === null &&
      (value.settlement.kind === "proposals" ||
        (value.agreed !== null && value.agreementOperation !== null))
    );
  return (
    value.state === "settled" &&
    Object.keys(value.proposals).length === 0 &&
    (value.settlement?.state === "completed" ||
      (value.settlement === null && value.resolved !== null))
  );
}
export function parseWagerRecord(value: unknown): WagerRecord {
  if (!isWagerRecord(value)) throw new TypeError("invalid-canonical-wager");
  return value;
}
export function decodeWager(value: unknown): WagerRecord | null {
  return value === null ? null : parseWagerRecord(value);
}
export function createEmptyWager(): Extract<
  WagerRecord,
  { state: "proposed" }
> {
  return {
    schemaVersion: 1,
    state: "proposed",
    proposals: {},
    proposedBy: {},
    agreed: null,
    agreementOperation: null,
    proposalRemovalOperations: {},
    settlement: null,
    resolved: null,
    blocked: null,
  };
}
export function readWagerCount(
  value: { count: number } | null | undefined,
): number {
  return value?.count ?? 0;
}
export function readWagerProposal(
  wager: WagerRecord | null,
  uid: string,
): WagerProposal | null {
  return wager?.proposals[uid] ?? null;
}
export function readWagerRemovalReceipt(
  wager: WagerRecord | null,
  id: string,
): WagerRemovalReceipt | null {
  return wager?.proposalRemovalOperations[id] ?? null;
}
export function readStoredSettlement(
  wager: WagerRecord | null,
): WagerSettlement | null {
  return wager?.settlement ?? null;
}
export function lineageFingerprint(wager: WagerRecord | null): string {
  const { reservationLineageReady: _ready, ...operation } =
    wager?.agreementOperation ?? {};
  return JSON.stringify([wager?.agreed, operation]);
}
export function wagerReferencesReservationOperation(
  wager: WagerRecord | null,
  playerUid: string,
  id: string,
): boolean {
  if (wager?.state === "blocked") return true;
  return Boolean(
    wager?.proposals[playerUid]?.reservationOperationId === id ||
    wager?.agreementOperation?.accepterReservationOperationIds.includes(id) ||
    wager?.agreementOperation?.proposerReservationOperationIds.includes(id) ||
    wager?.settlement?.releases.some(
      (entry) =>
        entry.uid === playerUid && entry.reservationOperationIds.includes(id),
    ),
  );
}
