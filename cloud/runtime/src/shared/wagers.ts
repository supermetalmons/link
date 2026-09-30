import type {
  MiningMaterialName,
  MiningMaterials,
  MiningSnapshot,
} from "./mining.js";
import {
  MATERIAL_KEYS,
  isMaterialName,
  isMiningSnapshot,
  normalizeCount,
} from "./mining.js";
import { isSafeRecordKey } from "./ids.js";

export interface WagerFrozenReadRequest {
  playerUid: string;
}

export interface WagerFrozenReadResponse {
  ok: true;
  playerUid: string;
  revision: number;
  frozen: MiningMaterials;
}

export type WagerOutcomeResolveFailureReason =
  (typeof WAGER_OUTCOME_RESOLVE_FAILURE_REASONS)[number];

export type WagerOutcomeResolveSuccessReason =
  (typeof WAGER_OUTCOME_RESOLVE_SUCCESS_REASONS)[number];

export interface WagerOutcomeResolveRequest {
  inviteId: string;
  matchId: string;
}

export type WagerOutcomeResolveResponse =
  | { ok: true; mining: MiningSnapshot | null }
  | {
      ok: true;
      reason: WagerOutcomeResolveSuccessReason;
      mining: MiningSnapshot | null;
    }
  | { ok: false; reason: WagerOutcomeResolveFailureReason };

export type WagerProposalRemovalFailureReason =
  (typeof WAGER_PROPOSAL_REMOVAL_FAILURE_REASONS)[number];

export interface WagerProposalRemovalRequest {
  inviteId: string;
  matchId: string;
}

export type WagerProposalRemovalResponse =
  { ok: true } | { ok: false; reason: WagerProposalRemovalFailureReason };

export type WagerProposalSendFailureReason =
  (typeof WAGER_PROPOSAL_SEND_FAILURE_REASONS)[number];

export type WagerProposalAcceptFailureReason =
  (typeof WAGER_PROPOSAL_ACCEPT_FAILURE_REASONS)[number];

export interface WagerProposalSendRequest {
  inviteId: string;
  matchId: string;
  material: MiningMaterialName;
  count: number;
}

export type WagerProposalAcceptRequest = WagerProposalRemovalRequest;

export interface WagerAgreement {
  material: MiningMaterialName;
  count: number;
  total: number;
  proposerId: string;
  accepterId: string;
  acceptedAt: number;
}

export type WagerProposalSendResponse =
  | { ok: true; count: number; agreed?: WagerAgreement }
  | { ok: false; reason: WagerProposalSendFailureReason };

export type WagerProposalAcceptResponse =
  | { ok: true; count: number }
  | { ok: false; reason: WagerProposalAcceptFailureReason };

const WAGER_STORAGE_VERSION_HEADER = "X-Mons-Wager-Storage-Version";
const WAGER_STORAGE_VERSION = "1";
const WAGER_FROZEN_READ_PATH = "/wagers/frozen/read";

const WAGER_PROPOSAL_REMOVAL_FAILURE_REASONS = Object.freeze([
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "proposal-missing",
] as const);

const WAGER_PROPOSAL_SEND_FAILURE_REASONS = Object.freeze([
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "insufficient-materials",
  "proposal-unavailable",
] as const);

const WAGER_PROPOSAL_ACCEPT_FAILURE_REASONS = Object.freeze([
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "proposal-missing",
  "insufficient-materials",
  "proposal-unavailable",
] as const);

const WAGER_OUTCOME_RESOLVE_FAILURE_REASONS = Object.freeze([
  "invite-not-found",
  "missing-opponent",
  "profile-not-found",
  "match-not-found",
] as const);

const WAGER_OUTCOME_RESOLVE_SUCCESS_REASONS = Object.freeze([
  "no-wager",
  "already-resolved",
] as const);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: object,
  expectedKeys: readonly string[],
): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => expectedKeys.includes(key))
  );
};

const isWagerFrozenReadRequest = (
  value: unknown,
): value is WagerFrozenReadRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["playerUid"]) &&
  isSafeRecordKey(value.playerUid) &&
  value.playerUid === value.playerUid.trim();

const isWagerFrozenReadResponse = (
  value: unknown,
): value is WagerFrozenReadResponse =>
  isRecord(value) &&
  hasExactKeys(value, ["ok", "playerUid", "revision", "frozen"]) &&
  value.ok === true &&
  isSafeRecordKey(value.playerUid) &&
  value.playerUid === value.playerUid.trim() &&
  Number.isSafeInteger(value.revision) &&
  (value.revision as number) >= 0 &&
  isRecord(value.frozen) &&
  hasExactKeys(value.frozen, MATERIAL_KEYS) &&
  MATERIAL_KEYS.every(
    (key) =>
      Number.isSafeInteger((value.frozen as Record<string, unknown>)[key]) &&
      ((value.frozen as Record<string, unknown>)[key] as number) >= 0,
  );

const isWagerProposalRemovalRequest = (
  value: unknown,
): value is WagerProposalRemovalRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["inviteId", "matchId"]) &&
  typeof value.inviteId === "string" &&
  value.inviteId.trim() !== "" &&
  typeof value.matchId === "string" &&
  value.matchId.trim() !== "";

const isWagerProposalSendRequest = (
  value: unknown,
): value is WagerProposalSendRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["inviteId", "matchId", "material", "count"]) &&
  typeof value.inviteId === "string" &&
  value.inviteId.trim() !== "" &&
  typeof value.matchId === "string" &&
  value.matchId.trim() !== "" &&
  isMaterialName(value.material) &&
  typeof value.count === "number" &&
  Number.isFinite(value.count) &&
  Number.isSafeInteger(normalizeCount(value.count)) &&
  normalizeCount(value.count) > 0;

const isWagerOutcomeResolveRequest = (
  value: unknown,
): value is WagerOutcomeResolveRequest =>
  isRecord(value) &&
  hasExactKeys(value, ["inviteId", "matchId"]) &&
  typeof value.inviteId === "string" &&
  value.inviteId.trim() !== "" &&
  typeof value.matchId === "string" &&
  value.matchId.trim() !== "";

const isWagerAgreement = (value: unknown): value is WagerAgreement =>
  isRecord(value) &&
  hasExactKeys(value, [
    "material",
    "count",
    "total",
    "proposerId",
    "accepterId",
    "acceptedAt",
  ]) &&
  isMaterialName(value.material) &&
  Number.isInteger(value.count) &&
  (value.count as number) > 0 &&
  Number.isInteger(value.total) &&
  value.total === (value.count as number) * 2 &&
  typeof value.proposerId === "string" &&
  value.proposerId.trim() !== "" &&
  typeof value.accepterId === "string" &&
  value.accepterId.trim() !== "" &&
  Number.isFinite(value.acceptedAt) &&
  (value.acceptedAt as number) >= 0;

const isWagerProposalRemovalResponse = (
  value: unknown,
): value is WagerProposalRemovalResponse => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    return hasExactKeys(value, ["ok"]);
  }
  return (
    value.ok === false &&
    hasExactKeys(value, ["ok", "reason"]) &&
    (WAGER_PROPOSAL_REMOVAL_FAILURE_REASONS as readonly unknown[]).includes(
      value.reason,
    )
  );
};

const isWagerProposalSendResponse = (
  value: unknown,
): value is WagerProposalSendResponse => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    if (!Number.isInteger(value.count) || (value.count as number) <= 0) {
      return false;
    }
    if (hasExactKeys(value, ["ok", "count"])) {
      return true;
    }
    return (
      hasExactKeys(value, ["ok", "count", "agreed"]) &&
      isWagerAgreement(value.agreed) &&
      value.agreed.count === value.count
    );
  }
  return (
    value.ok === false &&
    hasExactKeys(value, ["ok", "reason"]) &&
    (WAGER_PROPOSAL_SEND_FAILURE_REASONS as readonly unknown[]).includes(
      value.reason,
    )
  );
};

const isWagerProposalAcceptResponse = (
  value: unknown,
): value is WagerProposalAcceptResponse => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    return (
      hasExactKeys(value, ["ok", "count"]) &&
      Number.isInteger(value.count) &&
      (value.count as number) > 0
    );
  }
  return (
    value.ok === false &&
    hasExactKeys(value, ["ok", "reason"]) &&
    (WAGER_PROPOSAL_ACCEPT_FAILURE_REASONS as readonly unknown[]).includes(
      value.reason,
    )
  );
};

const isWagerOutcomeResolveResponse = (
  value: unknown,
): value is WagerOutcomeResolveResponse => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.ok === true) {
    if (value.mining !== null && !isMiningSnapshot(value.mining)) {
      return false;
    }
    if (hasExactKeys(value, ["ok", "mining"])) {
      return true;
    }
    return (
      hasExactKeys(value, ["ok", "reason", "mining"]) &&
      (WAGER_OUTCOME_RESOLVE_SUCCESS_REASONS as readonly unknown[]).includes(
        value.reason,
      )
    );
  }
  return (
    value.ok === false &&
    hasExactKeys(value, ["ok", "reason"]) &&
    (WAGER_OUTCOME_RESOLVE_FAILURE_REASONS as readonly unknown[]).includes(
      value.reason,
    )
  );
};

export {
  WAGER_STORAGE_VERSION_HEADER,
  WAGER_STORAGE_VERSION,
  WAGER_FROZEN_READ_PATH,
  WAGER_OUTCOME_RESOLVE_FAILURE_REASONS,
  WAGER_OUTCOME_RESOLVE_SUCCESS_REASONS,
  WAGER_PROPOSAL_ACCEPT_FAILURE_REASONS,
  WAGER_PROPOSAL_REMOVAL_FAILURE_REASONS,
  WAGER_PROPOSAL_SEND_FAILURE_REASONS,
  isWagerAgreement,
  isWagerFrozenReadRequest,
  isWagerFrozenReadResponse,
  isWagerOutcomeResolveRequest,
  isWagerOutcomeResolveResponse,
  isWagerProposalRemovalRequest as isWagerProposalAcceptRequest,
  isWagerProposalAcceptResponse,
  isWagerProposalRemovalRequest,
  isWagerProposalRemovalResponse,
  isWagerProposalSendRequest,
  isWagerProposalSendResponse,
};
